import { bind } from 'decko';
import { Component, createRef, Fragment, h, RefObject } from 'preact';
import { createPortal } from 'preact/compat';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';
import { KeyBar, Mod } from '../keybar';
import { NotifyTray } from '../media/notify-tray';
import { computeLinks, openLink } from './xterm/addons/wraplinks';
import type { ILink, ILinkProvider } from '@xterm/xterm';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    armed: '' | Mod;
    upload: string; // toast text while uploading ('' = hidden)
    uploadPct: number; // 0-100 for the progress bar
}

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // keep in sync with server MAX_BYTES (2 GB)

// Isolated, frozen host for xterm's DOM. xterm.open() appends its canvas/screen
// directly into this div, OUTSIDE Preact's vdom — so the node must keep a stable
// identity across re-renders, or the appended DOM is lost and the terminal blanks.
// Two things guarantee that:
//   1. render() gives this host a stable `key`, so a sibling toggling on/off (e.g.
//      the upload-toast portal, which lives at the front of #terminal-root) can't
//      shift its index and make Preact unmount+recreate it (keyless children are
//      matched by position → a one-slot shift cascades into type mismatches).
//   2. shouldComponentUpdate=false freezes the node so Preact never re-diffs it
//      after mount (the host must therefore contain no Preact-managed children).
class XtermHost extends Component<{ id: string; hostRef: RefObject<HTMLDivElement> }> {
    shouldComponentUpdate() {
        return false;
    }
    render() {
        return <div id={this.props.id} ref={this.props.hostRef} />;
    }
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private hostRef = createRef<HTMLDivElement>();
    private root: HTMLElement;
    private xterm: Xterm;
    private disposeViewport?: () => void;
    private disposeTap?: () => void;
    private disposePaste?: () => void;
    private disposeWheel?: () => void;
    private disposeKeyRepeat?: () => void;
    private swipeHint?: HTMLElement;
    private swipeFill?: HTMLElement;
    private swipeHandle?: HTMLElement;
    private fileInput?: HTMLInputElement;
    private disarmTimer?: number;
    // Whether the soft keyboard is currently shown (tracked from visualViewport in
    // setupViewport). Lets a plain keybar tap tell "keyboard up, I'm typing" apart
    // from "keyboard dismissed but the helper textarea is still focused" — the iOS
    // state that makes an Esc/arrow tap re-summon the keyboard.
    private kbShown = false;

    state: State = {
        modal: false,
        armed: '',
        upload: '',
        uploadPct: 0,
    };
    private uploadQueue: Blob[] = [];
    private uploading = false;
    private toastTimer?: number;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
    }

    async componentDidMount() {
        this.container = this.hostRef.current as HTMLElement;
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.inputHandler = this.handleInput; // route typed input through modifier logic
        this.xterm.connect();
        this.hardenInput();
        this.setupKeyRepeat();
        this.setupViewport();
        this.setupTouch();
        this.setupWheelSwipe();
        this.setupPaste();
    }

    componentWillUnmount() {
        this.disposeViewport?.();
        this.disposeTap?.();
        this.disposeWheel?.();
        this.disposePaste?.();
        this.disposeKeyRepeat?.();
        if (this.disarmTimer) clearTimeout(this.disarmTimer);
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.xterm.dispose();
    }

    render({ id }: Props, { modal, armed, upload, uploadPct }: State) {
        return (
            <div id="terminal-root" ref={c => (this.root = c as HTMLElement)}>
                {/* Transient overlays (all portals to <body>) are wrapped in one
                    always-present Fragment so #terminal-root's direct children keep
                    a fixed shape. Inlined here, each toggling conditional would
                    change the children array and shift the xterm host's slot, making
                    Preact unmount+recreate the host and blank the terminal. */}
                <Fragment key="overlays">
                    {upload &&
                        createPortal(
                            <div id="upload-toast">
                                <div class="upload-msg">{upload}</div>
                                <div class="upload-track">
                                    <div class="upload-fill" style={`width:${uploadPct}%`} />
                                </div>
                            </div>,
                            document.body
                        )}
                </Fragment>
                {/* Stable keys on every direct child as belt-and-suspenders, on top
                    of the fixed-shape children list above. */}
                <XtermHost key="xterm-host" id={id} hostRef={this.hostRef} />
                {/* Modal lives OUTSIDE the frozen xterm host (a frozen host can't
                    re-render its children, so the modal would never open). */}
                <Modal key="modal" show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
                <KeyBar
                    key="keybar"
                    armed={armed}
                    onKey={this.sendKey}
                    onMod={this.toggleMod}
                    onUpload={this.triggerUpload}
                />
                <div key="swipe-hint" id="swipe-hint" ref={c => (this.swipeHint = c as HTMLElement)}>
                    <span id="swipe-ghost">◂ 切窗 ▸</span>
                    <span id="swipe-rail">
                        <i id="swipe-fill" ref={c => (this.swipeFill = c as HTMLElement)} />
                        <span id="swipe-handle" ref={c => (this.swipeHandle = c as HTMLElement)}>
                            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
                                <path
                                    class="ar"
                                    d="M3 3 L7 7 L3 11 M8 3 L12 7 L8 11"
                                    fill="none"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                />
                            </svg>
                        </span>
                    </span>
                </div>
                <input
                    key="file-input"
                    ref={c => (this.fileInput = c as HTMLInputElement)}
                    type="file"
                    multiple
                    style="display:none"
                    onChange={this.onFilePicked}
                />
                <NotifyTray key="notify-tray" />
            </div>
        );
    }

    // ---- image upload (📎 button / Ctrl+V paste) ------------------------------
    // Upload the blob to the same-origin __ccupload endpoint (homevm writes it to
    // /tmp/cc-paste and returns the path), then drop the path into CC's input so
    // CC can Read the image. Replaces the manual cc-upload (trzsz) flow.
    @bind
    private triggerUpload() {
        this.fileInput?.click();
    }

    @bind
    private onFilePicked(e: Event) {
        const input = e.target as HTMLInputElement;
        if (input.files) this.enqueue(Array.from(input.files));
        input.value = ''; // allow re-picking the same file
    }

    // Queue files and upload them one at a time, surfacing progress in a toast.
    private enqueue(blobs: Blob[]) {
        this.uploadQueue.push(...blobs);
        if (!this.uploading) this.drainQueue();
    }

    private async drainQueue() {
        this.uploading = true;
        let done = 0;
        while (this.uploadQueue.length) {
            const blob = this.uploadQueue.shift() as Blob;
            const idx = ++done;
            const total = done + this.uploadQueue.length; // remaining + already-done
            const prefix = total > 1 ? `Upload ${idx}/${total} · ` : 'Upload · ';
            if (blob.size > MAX_UPLOAD) {
                this.flashToast(`File too large (${this.fmtSize(blob.size)} > 2GB), skipped`);
                continue;
            }
            // show immediately (small uploads may finish before onprogress fires)
            this.setState({ upload: `${prefix}0%`, uploadPct: 0 });
            try {
                const path = await this.uploadOne(blob, pct =>
                    this.setState({ upload: `${prefix}${pct}%`, uploadPct: pct })
                );
                if (path) {
                    this.xterm.sendData(path + ' ');
                    this.flashToast(`Added ${path.split('/').pop()}`);
                } else {
                    this.flashToast('Upload failed');
                }
            } catch {
                this.flashToast('Upload failed (endpoint unreachable)');
            }
        }
        this.uploading = false;
    }

    // XHR (not fetch) so we get real upload progress events.
    private uploadOne(blob: Blob, onProgress: (pct: number) => void): Promise<string | null> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', new URL('__ccupload', window.location.href).href);
            xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
            const name = (blob as File).name;
            if (name) xhr.setRequestHeader('X-CC-Filename', encodeURIComponent(name));
            xhr.upload.onprogress = e => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(JSON.parse(xhr.responseText).path || null);
                    } catch {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
            xhr.onerror = () => reject(new Error('network'));
            xhr.send(blob);
        });
    }

    private flashToast(msg: string) {
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.setState({ upload: msg, uploadPct: 100 });
        this.toastTimer = window.setTimeout(() => this.setState({ upload: '', uploadPct: 0 }), 2200);
    }

    private fmtSize(n: number): string {
        return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)}MB` : `${(n / 1024).toFixed(0)}KB`;
    }

    // Ctrl+V of one or more attachments: a screenshot, or files copied in the OS
    // file manager (Finder/Explorer). Any file kind is accepted (not just images);
    // CC can Read PDFs/text/etc. by the injected path.
    @bind
    private setupPaste() {
        const onPaste = (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const blobs: File[] = [];
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                if (it.kind === 'file') {
                    const f = it.getAsFile();
                    if (f) blobs.push(f);
                }
            }
            if (blobs.length) {
                // Fully swallow the image paste: preventDefault stops the browser
                // inserting it into xterm's helper textarea (which would flash a
                // white box at the cursor), stopImmediatePropagation stops xterm's
                // own paste listener from running on it at all.
                e.preventDefault();
                e.stopImmediatePropagation();
                this.enqueue(blobs);
            }
        };
        document.addEventListener('paste', onPaste, true); // capture: run before xterm's handler
        this.disposePaste = () => document.removeEventListener('paste', onPaste, true);
    }

    // ---- sticky modifiers (Ctrl / tmux prefix) --------------------------------
    // Arming a modifier highlights it and summons the keyboard so the combining
    // key can be typed; the next typed key (soft keyboard OR keybar) is then
    // transformed and the modifier disarms. Auto-disarms after 6s if unused.
    @bind
    private toggleMod(mod: Mod) {
        const next = this.state.armed === mod ? '' : mod;
        this.setState({ armed: next });
        if (this.disarmTimer) clearTimeout(this.disarmTimer);
        if (next) {
            window.term?.focus();
            this.disarmTimer = window.setTimeout(() => this.setState({ armed: '' }), 6000);
        }
    }

    private applyMod(data: string): string | null {
        if (data.length !== 1) return null; // leave arrows/IME/paste untouched
        if (this.state.armed === 'ctrl') return String.fromCharCode(data.charCodeAt(0) & 0x1f);
        if (this.state.armed === 'prefix') return '\x02' + data; // tmux prefix + key
        return null;
    }

    private consumeMod(data: string): string {
        const t = this.applyMod(data);
        if (this.disarmTimer) clearTimeout(this.disarmTimer);
        this.setState({ armed: '' });
        return t ?? data;
    }

    // soft-keyboard input path (wired into Xterm.onData)
    @bind
    private handleInput(data: string) {
        this.xterm.sendData(this.state.armed ? this.consumeMod(data) : data);
    }

    @bind
    private sendKey(data: string, blur?: boolean, focus?: boolean) {
        if (this.state.armed) {
            this.xterm.sendData(this.consumeMod(data));
            return;
        }
        // sendData goes straight to the socket and needs no focus, so a special
        // key must NOT focus the textarea — otherwise every Esc/arrow tap re-
        // summons the keyboard. blur=true (scroll) hides it; focus=true summons.
        this.xterm.sendData(data);
        if (blur) window.term?.blur();
        else if (focus) window.term?.focus();
        // Plain key (no explicit blur/focus): keep the keyboard exactly as it is.
        // iOS leaves the helper textarea focused after the user swipes the keyboard
        // away, so a tap while it's still focused re-summons it. When the keyboard
        // is NOT shown, drop that lingering focus so the tap is a pure key-send;
        // when it IS shown (mid-typing), leave focus so it doesn't flicker away.
        else if (!this.kbShown) window.term?.blur();
    }

    // Tame the iOS soft keyboard for terminal use: kill autocorrect /
    // autocapitalize / predictive text that would corrupt typed commands.
    private hardenInput() {
        const ta = this.container.querySelector('.xterm-helper-textarea');
        if (!ta) return;
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'none');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('spellcheck', 'false');
    }

    // Soft-keyboard backspace auto-repeat. A mobile keyboard fires ONE Backspace
    // keydown and then nothing while the key is held: xterm keeps its helper
    // textarea empty, so the OS has no character to repeat-delete and stops after
    // one. We synthesize the repeat — xterm still sends the first DEL on keydown,
    // then after a short hold we emit DEL on an interval until the key is released
    // (keyup), focus is lost, or a safety cap is hit. If the platform DOES deliver
    // native key-repeat (e.repeat), we stand down and let it drive (e.g. Android).
    private setupKeyRepeat() {
        const ta = this.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (!ta) return;
        const DEL = '\x7f';
        const INITIAL = 400; // ms held before the repeat kicks in
        const INTERVAL = 70; // ms between repeats while held
        const CAP = 400; // safety: stop after this many repeats if a keyup is ever missed
        let delay = 0;
        let timer = 0;
        let count = 0;
        const stop = () => {
            if (delay) {
                clearTimeout(delay);
                delay = 0;
            }
            if (timer) {
                clearInterval(timer);
                timer = 0;
            }
            count = 0;
        };
        const isBack = (e: KeyboardEvent) => e.key === 'Backspace' || e.keyCode === 8;
        const onDown = (e: KeyboardEvent) => {
            if (!isBack(e)) return;
            if (e.repeat) {
                stop(); // native auto-repeat is firing — don't double it
                return;
            }
            stop();
            delay = window.setTimeout(() => {
                timer = window.setInterval(() => {
                    if (++count > CAP) {
                        stop(); // safety net if a keyup was ever missed
                        return;
                    }
                    this.xterm.sendData(DEL);
                }, INTERVAL);
            }, INITIAL);
        };
        const onUp = (e: KeyboardEvent) => {
            if (isBack(e)) stop();
        };
        // Capture phase is required: xterm stops immediate propagation of keydown
        // on this textarea in the bubble phase, so a bubble-phase listener here
        // would never fire. We don't preventDefault, so xterm still sends the
        // first DEL on its own bubble-phase handler.
        ta.addEventListener('keydown', onDown, true);
        ta.addEventListener('keyup', onUp, true);
        ta.addEventListener('blur', stop, true);
        this.disposeKeyRepeat = () => {
            stop();
            ta.removeEventListener('keydown', onDown, true);
            ta.removeEventListener('keyup', onUp, true);
            ta.removeEventListener('blur', stop, true);
        };
    }

    // Keyboard-aware layout. The soft keyboard floats over the page (the grid is
    // measured via visualViewport, which shrinks when the keyboard opens — hence
    // interactive-widget=resizes-visual in template.html, NOT overlays-content,
    // which would suppress that shrink and leave kb stuck at 0).
    //
    // We do NOT slide the whole terminal up by the keyboard height: Claude Code
    // anchors its UI to the TOP, so when the conversation is short the input box
    // sits high with blank rows below it — a blind full-height slide would shove
    // the input off the top of the screen. Instead the two concerns are decoupled
    // (pure CSS transforms, so no grid refit / reflow):
    //   • the key bar is pinned just above the keyboard — it should always hug the
    //     keyboard regardless of where the cursor is;
    //   • the terminal is lifted only as much as needed to bring the *cursor* (the
    //     input line) just above the key bar. Short content => ~no lift (input is
    //     already visible); full screen => lift ≈ keyboard height, as before.
    @bind
    private setupViewport() {
        const vv = window.visualViewport;
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!vv || !coarse) return;
        const keybar = this.root.querySelector('#keybar') as HTMLElement | null;
        // ?vvdebug=1 → tiny overlay of the raw viewport numbers (to diagnose
        // device-specific keyboard geometry). Inert for everyone else.
        // ?vvdebug=1 → tiny overlay of the raw viewport numbers (keyboard-geometry diagnosis).
        const dbgOn = location.search.indexOf('vvdebug') >= 0;
        let dbgEl: HTMLElement | null = null;
        if (dbgOn) {
            dbgEl = document.createElement('div');
            dbgEl.style.cssText =
                'position:fixed;top:0;left:0;z-index:99999;background:rgba(0,0,0,.85);color:#3f6;font:10px monospace;padding:3px 5px;white-space:pre;pointer-events:none';
            document.body.appendChild(dbgEl);
        }

        let curKbT = 0; // current keybar translateY (px) — incremental measure + no-op skip
        let lastLift = -1;
        let barUp = false; // whether .keybar-up is currently applied (toggle only on change)
        let screenEl: HTMLElement | null = null; // cached .xterm-screen (page-lifetime)
        const apply = () => {
            const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            this.kbShown = kb > 1; // soft keyboard is up iff the visual viewport shrank
            // Keybar is visible ONLY while the soft keyboard is up. Toggle the class
            // solely on a state change so we don't touch the DOM on every rAF /
            // cursor-move frame while typing.
            if (keybar && this.kbShown !== barUp) {
                keybar.classList.toggle('keybar-up', this.kbShown);
                barUp = this.kbShown;
            }
            // Pin the keybar's BOTTOM to the keyboard's top edge (= the visual
            // viewport's bottom edge in screen coords), measured from the bar's REAL
            // on-screen box. translateY(-kb) assumes the bar sits exactly at the
            // layout-viewport bottom, but iOS scrolls/offsets that frame when the
            // keyboard opens → the bar floats too high with a gap below it. Measuring
            // the actual box and translating the delta is immune to that.
            if (keybar) {
                if (kb <= 1) {
                    if (curKbT !== 0) {
                        keybar.style.transform = '';
                        curKbT = 0;
                    }
                } else {
                    const target = vv.offsetTop + vv.height; // screen-y of keyboard's top
                    const naturalBottom = keybar.getBoundingClientRect().bottom - curKbT;
                    const t = Math.round(target - naturalBottom);
                    if (t !== curKbT) {
                        keybar.style.transform = `translateY(${t}px)`;
                        curKbT = t;
                    }
                }
            }
            if (dbgEl) {
                const r = keybar?.getBoundingClientRect();
                const sc = document.querySelector('.xterm-screen') as HTMLElement | null;
                const scR = sc?.getBoundingClientRect();
                dbgEl.textContent =
                    `ih=${window.innerHeight} vvh=${Math.round(vv.height)} ` +
                    `iw=${window.innerWidth} vvw=${Math.round(vv.width)}\n` +
                    `scW=${scR ? Math.round(scR.width) : '-'} ` +
                    `rGap=${scR ? Math.round(window.innerWidth - scR.right) : '-'}\n` +
                    `vvoT=${Math.round(vv.offsetTop)} sY=${Math.round(window.scrollY)} ` +
                    `kb=${Math.round(kb)} kbT=${curKbT}\n` +
                    `kbBot=${r ? Math.round(r.bottom) : '-'} kbH=${keybar?.offsetHeight ?? '-'} ` +
                    `tgt=${Math.round(vv.offsetTop + vv.height)}`;
            }
            const term = window.term;
            // Keyboard down (the common case) needs none of the screen geometry below,
            // so bail BEFORE touching the DOM — avoids a querySelector on every
            // cursor-move frame while you're just typing with no keyboard lift in play.
            if (kb <= 1 || !term || !keybar) {
                if (lastLift !== 0) {
                    this.container.style.transform = '';
                    lastLift = 0;
                }
                return;
            }
            // screen element is page-lifetime → query once, reuse across calls.
            if (!screenEl) screenEl = this.container.querySelector('.xterm-screen') as HTMLElement | null;
            const screen = screenEl;
            if (!screen) {
                if (lastLift !== 0) {
                    this.container.style.transform = '';
                    lastLift = 0;
                }
                return;
            }
            // cursor's bottom edge in the untranslated layout (offsetHeight is
            // transform-independent, so this never feeds back on our own transform).
            const cellH = screen.offsetHeight / (term.rows || 1);
            // Mid-reflow, offsetHeight can momentarily read 0/tiny; a bad cellH would
            // compute lift≈0 and drop the input behind the keyboard ("keybar floats
            // but input stays covered"). Skip such a frame, keep the last good lift —
            // the settle re-apply below corrects it once measurements are stable.
            if (!(cellH > 6)) return;
            const cursorBottom = 5 /* .terminal padding */ + (term.buffer.active.cursorY + 1) * cellH;
            const keybarTop = vv.offsetTop + vv.height - keybar.offsetHeight; // = keybar's pinned top
            // lift just enough to leave one row of breathing room above the key bar
            const lift = Math.max(0, cursorBottom - (keybarTop - Math.round(cellH)));
            if (lift !== lastLift) {
                this.container.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
                lastLift = lift;
            }
        };

        // coalesce bursts (keyboard slide animation, rapid cursor moves) to 1/frame
        let raf = 0;
        let settle = 0;
        const sync = () => {
            if (!raf)
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    apply();
                });
        };
        // Keyboard geometry changed: sync now, AND re-apply once the slide settles —
        // iOS frequently omits the final resize event, leaving an intermediate value
        // latched (keybar up, input not lifted). The trailing apply fixes that.
        const onViewport = () => {
            sync();
            if (settle) clearTimeout(settle);
            settle = window.setTimeout(apply, 320);
        };
        vv.addEventListener('resize', onViewport);
        vv.addEventListener('scroll', onViewport);
        const cursorMove = window.term?.onCursorMove(sync); // follow the input line as you type
        apply();
        this.disposeViewport = () => {
            if (raf) cancelAnimationFrame(raf);
            if (settle) clearTimeout(settle);
            vv.removeEventListener('resize', onViewport);
            vv.removeEventListener('scroll', onViewport);
            cursorMove?.dispose();
            this.container.style.transform = '';
            if (keybar) {
                keybar.style.transform = '';
                keybar.classList.remove('keybar-up');
            }
            dbgEl?.remove();
        };
    }

    // Horizontal-swipe window switch. Goes through the same-origin __ccswitch
    // sidecar (a real `tmux next/previous-window`) instead of injecting `C-b n`/
    // `C-b p` — the WebSocket can split that 2-byte sequence so tmux misses the
    // prefix and the bare n/p leaks into Claude Code's input box.
    @bind
    private switchWindow(dir: 'next' | 'prev') {
        fetch(new URL('__ccswitch', window.location.href).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir }),
        }).catch(() => {});
    }

    // Touch input forwarded to tmux (mouse on), since xterm doesn't forward touch:
    //  - a tap  -> SGR left-click at the cell: selects the pane, or switches
    //    window when you tap a window name in the bottom status bar.
    //  - a vertical drag -> SGR wheel notches: scrolls tmux scrollback like a
    //    desktop mouse wheel (finger down = into history, finger up = toward newest).
    //  - a horizontal swipe -> switch tmux window (left = next, right = prev).
    @bind
    private setupTouch() {
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!coarse) return;
        const el = this.container;
        const STEP = 16; // px of vertical drag per wheel notch
        const THRESH_T = 48; // px of horizontal travel for one window switch
        let sx = 0;
        let sy = 0;
        let lastY = 0;
        let single = false;
        let scrolled = false;
        let swiped = false; // fired a window switch this gesture (one per swipe)
        let lpTimer = 0; // long-press timer (0 = inactive)
        let selecting = false; // long press fired in output -> movement extends the selection
        let anchor: { col: number; row: number } | null = null; // where the selection started
        let pendingPaste = false; // long press fired in the input box -> paste on release

        const cancelLP = () => {
            if (lpTimer) {
                clearTimeout(lpTimer);
                lpTimer = 0;
            }
        };

        // Wheel notches are coalesced per animation frame and sent as ONE batched
        // sequence, so a fast swipe doesn't flood the app with dozens of separate
        // wheel events — each of which would otherwise force its own redraw → jank.
        let wheelAccum = 0; // signed notch count pending this frame (+ = into history)
        let wheelRaf = 0;
        const flushWheel = () => {
            wheelRaf = 0;
            const n = wheelAccum;
            wheelAccum = 0;
            if (!n) return;
            const btn = n > 0 ? 64 : 65; // 64 = wheel up/into history, 65 = toward newest
            this.xterm.sendData(`\x1b[<${btn};2;2M`.repeat(Math.abs(n)));
        };
        const queueWheel = (up: boolean) => {
            wheelAccum += up ? 1 : -1;
            if (!wheelRaf) wheelRaf = window.requestAnimationFrame(flushWheel);
        };

        // ---- flick momentum (iOS-style inertia) ---------------------------------
        // Sample the finger's vertical velocity while scrolling; on release, keep
        // emitting wheel notches with exponentially-decaying speed so a flick coasts
        // instead of stopping dead. A fresh touch cancels the coast.
        let vY = 0; // smoothed finger velocity, px/ms (+ = moving down = into history)
        let prevY = 0;
        let prevT = 0;
        let momRaf = 0;
        let momV = 0; // current coast velocity, px/ms
        let momAccum = 0; // px accumulated toward the next notch
        let momT = 0;
        const FRICTION = 0.97; // velocity retained per ~16ms frame (higher = longer coast)
        const V_FLICK = 0.25; // px/ms — minimum release speed to start coasting
        const V_STOP = 0.025; // px/ms — coast ends below this (low → tapers smoothly to a stop)
        const momStep = (now: number) => {
            const dt = now - momT || 16;
            momT = now;
            momV *= Math.pow(FRICTION, dt / 16);
            if (Math.abs(momV) < V_STOP) {
                momRaf = 0;
                return;
            }
            momAccum += momV * dt;
            let n = 0;
            while (momAccum >= STEP) {
                n++;
                momAccum -= STEP;
            }
            while (momAccum <= -STEP) {
                n--;
                momAccum += STEP;
            }
            if (n !== 0) this.xterm.sendData(`\x1b[<${n > 0 ? 64 : 65};2;2M`.repeat(Math.abs(n)));
            momRaf = window.requestAnimationFrame(momStep);
        };
        const stopMomentum = () => {
            if (momRaf) {
                cancelAnimationFrame(momRaf);
                momRaf = 0;
            }
            momV = 0;
        };

        const onStart = (e: TouchEvent) => {
            stopMomentum(); // a new touch halts any coasting
            single = e.touches.length === 1;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            lastY = sy;
            prevY = sy;
            prevT = performance.now();
            vY = 0;
            scrolled = false;
            swiped = false;
            selecting = false;
            pendingPaste = false;
            anchor = null;
            cancelLP();
            if (single) {
                // Hold still ~480ms. Long-press is the phone's native text gesture, and tap
                // is already taken (tmux click). What it does depends on WHERE:
                //   output box  -> start a selection (drag to extend, release to copy)
                //   input box   -> paste
                lpTimer = window.setTimeout(() => {
                    lpTimer = 0;
                    // Feedback FIRST, and it must be visual: navigator.vibrate does not
                    // exist on iOS, so a haptic-only cue means the long press appears to do
                    // nothing at all until you happen to drag. The ripple is the only cue an
                    // iPhone actually gets.
                    (navigator as Navigator & { vibrate?: (n: number) => void }).vibrate?.(8);
                    this.tapRipple(sx, sy);
                    if (this.inInputZone(sy)) {
                        // NOT pasting here: clipboard.readText() needs a transient user
                        // activation, and a setTimeout callback has none. Defer to touchend,
                        // which is still inside the gesture.
                        pendingPaste = true;
                        return;
                    }
                    selecting = true;
                    anchor = this.cellAt(sx, sy);
                    // Press only — deliberately NOT a zero-distance drag to force the
                    // highlight up early. That would put tmux into copy-mode, and on release
                    // tmux would then copy a selection of its own and blow away, via OSC 52,
                    // the text we put on the clipboard inside the gesture — with a different
                    // anchor, so the two disagree. Staying out of copy-mode until the finger
                    // actually moves keeps exactly one writer of the clipboard per outcome:
                    //   no drag -> tmux never copies; we copy the word.
                    //   drag    -> tmux copies the same range we do; agreeing overwrite.
                    this.sendMouse(0, sx, sy, true);
                }, 480);
            }
        };
        const onMove = (e: TouchEvent) => {
            if (!single || e.touches.length !== 1) return;
            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;
            if (selecting) {
                // Drag to extend. tmux sees a button-1 drag, enters copy-mode and paints
                // the highlight itself. No scrolling, no window switch while selecting.
                this.sendMouse(32, x, y, true);
                return;
            }
            const dx = x - sx;
            const dy = y - sy;
            // real movement before the timer fires -> it's a scroll/swipe, not a long press
            if (lpTimer && Math.abs(dx) + Math.abs(dy) > 10) cancelLP();
            // horizontal-dominant -> window switch, with the charge-up hint
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
                scrolled = true; // not a tap
                this.showSwipe(dx < 0, Math.min(1, Math.abs(dx) / THRESH_T));
                if (!swiped && Math.abs(dx) >= THRESH_T) {
                    this.switchWindow(dx < 0 ? 'next' : 'prev'); // left -> next, right -> prev
                    this.fireSwipe();
                    swiped = true;
                }
                return;
            }
            // sample vertical velocity (smoothed) for release momentum
            const now = performance.now();
            const mdt = now - prevT;
            if (mdt > 0) {
                vY = vY * 0.7 + ((y - prevY) / mdt) * 0.3;
                prevY = y;
                prevT = now;
            }
            while (y - lastY >= STEP) {
                queueWheel(true); // finger down -> wheel up -> into history
                lastY += STEP;
                scrolled = true;
            }
            while (lastY - y >= STEP) {
                queueWheel(false); // finger up -> wheel down -> toward newest
                lastY -= STEP;
                scrolled = true;
            }
        };
        const onEnd = (e: TouchEvent) => {
            cancelLP();
            this.hideSwipe();
            if (pendingPaste) {
                pendingPaste = false;
                // We are inside the touchend handler, so the gesture's user activation is
                // still live and Safari/Chrome will honour readText(). (Calling it from the
                // long-press timer instead would be rejected on iOS.)
                navigator.clipboard
                    .readText()
                    .then(t => {
                        if (t) this.xterm.sendData(t);
                    })
                    .catch(() => {
                        /* denied or empty — no-op */
                    });
                return;
            }
            if (selecting) {
                selecting = false;
                const t = e.changedTouches[0];
                const head = t ? this.cellAt(t.clientX, t.clientY) : null;
                // Copy from the BUFFER ourselves rather than relying on tmux's OSC 52.
                // tmux does emit it (copy-command -> OSC 52 ';c;' -> ClipboardAddon ->
                // navigator.clipboard), and that is exactly how the desktop mouse copies —
                // but it arrives asynchronously over the WebSocket, long after this gesture's
                // user activation has expired, and iOS Safari refuses writeText() without
                // one. Doing it here keeps us inside the gesture. tmux still gets the
                // release below, so it exits copy-mode and clears its highlight as usual.
                // Long press with no drag = "copy this word" (the phone-native meaning of
                // long-pressing text). Only an actual drag means "copy this range".
                const moved = !!anchor && !!head && (anchor.col !== head.col || anchor.row !== head.row);
                const text = moved ? this.textBetween(anchor!, head!) : anchor ? this.wordAt(anchor) : '';
                if (text) {
                    navigator.clipboard.writeText(text).catch(() => {
                        /* denied — the OSC 52 path may still land on desktop */
                    });
                }
                anchor = null;
                if (t) this.sendMouse(0, t.clientX, t.clientY, false);
                return;
            }
            if (swiped) {
                swiped = false;
                return; // horizontal swipe already handled during the move
            }
            if (scrolled) {
                // released after a vertical drag — coast if it was a flick
                if (Math.abs(vY) > V_FLICK) {
                    momV = vY;
                    momAccum = 0;
                    momT = performance.now();
                    if (!momRaf) momRaf = window.requestAnimationFrame(momStep);
                }
                return;
            }
            if (!single || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx;
            const dy = t.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) > 10) return; // a drag, not a tap
            // A tap that lands on a link opens it (mobile has no other way — the click that
            // would fire xterm's own link activation is swallowed), and does NOT also send a
            // tmux click, so tapping a link never moves the pane selection under it.
            // A tap on a link opens it — EXCEPT inside CC's input box, where a URL you typed
            // must still move the caret / summon the keyboard, not launch a browser tab.
            const link = !this.inInputZone(t.clientY) && this.linkAt(t.clientX, t.clientY);
            if (link) {
                openLink(e as unknown as MouseEvent, link.text);
                this.tapRipple(t.clientX, t.clientY);
                return;
            }
            // Confirmed tap → drive it ourselves (xterm's synthesized-mouse handling
            // is suppressed below, else it focuses on every touch-START and pops the
            // keyboard the moment you begin a scroll). Always send ONE click + ripple;
            // summon the keyboard ONLY when the tap lands in Claude Code's input box
            // (the rows around the cursor) — tapping output / clickable UI must not.
            this.sendClick(t.clientX, t.clientY);
            this.tapRipple(t.clientX, t.clientY);
            if (this.inInputZone(t.clientY)) window.term?.focus();
        };
        // iOS hands the touch back with touchcancel when a system gesture takes over. Without
        // this we'd never see the end of the gesture: the long-press timer would still fire,
        // `selecting` would stay latched, and tmux would sit in copy-mode with the button
        // "held" forever. Release it and reset.
        const onCancel = () => {
            cancelLP();
            this.hideSwipe();
            if (selecting) {
                selecting = false;
                this.sendMouse(0, sx, sy, false); // let tmux finish the drag it thinks is live
            }
            anchor = null;
            pendingPaste = false;
        };

        // Suppress the browser's own long-press callout/context menu on the canvas.
        const onCtx = (e: Event) => e.preventDefault();

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: true });
        el.addEventListener('touchend', onEnd, { passive: true });
        el.addEventListener('touchcancel', onCancel, { passive: true });
        el.addEventListener('contextmenu', onCtx);
        // Swallow the browser's synthesized mouse events from touches: xterm would
        // otherwise focus the textarea on the touch-START mousedown — popping the
        // keyboard the moment you begin a scroll — and double-report the click. We
        // drive taps ourselves in onEnd. preventDefault also stops the trailing
        // synthesized click from blurring a textarea we just focused (which iOS
        // would treat as dismissing the keyboard again).
        const swallowMouse = (ev: Event) => {
            ev.stopPropagation();
            if (ev.cancelable) ev.preventDefault();
        };
        const mouseTypes = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'];
        mouseTypes.forEach(type => el.addEventListener(type, swallowMouse, true));
        this.disposeTap = () => {
            cancelLP();
            stopMomentum();
            if (wheelRaf) cancelAnimationFrame(wheelRaf);
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchmove', onMove);
            el.removeEventListener('touchend', onEnd);
            el.removeEventListener('touchcancel', onCancel);
            el.removeEventListener('contextmenu', onCtx);
            mouseTypes.forEach(type => el.removeEventListener(type, swallowMouse, true));
        };
    }

    // Desktop (Mac trackpad) two-finger horizontal swipe -> switch tmux window,
    // mirroring the mobile horizontal touch swipe. A sideways swipe arrives as
    // horizontal wheel deltas (deltaX); vertical wheel still falls through to
    // xterm for scrollback. We preventDefault horizontal so it doesn't trigger
    // the browser's back/forward history gesture.
    @bind
    private setupWheelSwipe() {
        const el = this.container;
        const THRESH = 36; // px of horizontal travel for one window switch
        let accX = 0;
        let armed = true; // one switch per physical swipe (re-armed after an idle gap)
        let idle = 0;
        const onWheel = (e: WheelEvent) => {
            // treat as horizontal unless it's clearly vertical (so a swipe with a
            // little vertical jitter still counts, rather than getting dropped)
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.3) return; // vertical -> xterm scrollback
            e.preventDefault(); // block browser back/forward nav + xterm wheel
            e.stopPropagation();
            if (idle) clearTimeout(idle);
            idle = window.setTimeout(() => {
                armed = true; // gesture (incl. momentum) settled -> ready for the next
                accX = 0;
                this.hideSwipe();
            }, 90);
            if (!armed) return;
            accX += e.deltaX;
            this.showSwipe(accX > 0, Math.min(1, Math.abs(accX) / THRESH));
            if (Math.abs(accX) >= THRESH) {
                // Route through the sidecar (same as the touch path), NOT a bare 2-byte
                // C-b prefix: the WebSocket can split '\x02n' so the 'n' leaks into Claude
                // Code's input, and a hard-coded C-b breaks any non-default tmux prefix.
                this.switchWindow(accX > 0 ? 'next' : 'prev'); // left -> next, right -> prev
                this.fireSwipe();
                armed = false;
                accX = 0;
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false, capture: true });
        this.disposeWheel = () => el.removeEventListener('wheel', onWheel, true);
    }

    // The floating "charge-up" hint for the swipe gesture — driven imperatively
    // (no preact re-render per wheel event): it follows the swipe, fills toward
    // the threshold, then flashes teal on the switch.
    private showSwipe(next: boolean, p: number) {
        const h = this.swipeHint;
        if (!h) return;
        h.style.opacity = '1';
        h.classList.toggle('to-left', !next); // mirror the rail for a previous-window swipe
        h.classList.toggle('done', p >= 1); // reached threshold → teal, glowing, ready
        // The handle rides the track and the fill builds in behind it. Geometry is
        // always computed left-to-right; the .to-left class scaleX(-1)s the rail.
        // 42px = handle width (36) + 3px inset each side; 39px = handle left + width.
        if (this.swipeHandle) this.swipeHandle.style.left = `calc(${p} * (100% - 42px) + 3px)`;
        if (this.swipeFill) this.swipeFill.style.width = `calc(${p} * (100% - 42px) + 39px)`;
    }

    private hideSwipe() {
        const h = this.swipeHint;
        if (!h) return;
        h.style.opacity = '0';
        h.classList.remove('done');
    }

    private fireSwipe() {
        const h = this.swipeHint;
        if (!h) return;
        h.classList.add('fired'); // brief white-teal burst on the switch
        window.setTimeout(() => h.classList.remove('fired'), 220);
    }

    // Is this tap on Claude Code's input box? The cursor lives in that box, so the
    // box spans roughly the cursor row and the border just above it down to the
    // bottom. Only taps there should summon the keyboard; tapping output / clickable
    // UI must not. Returns false when the cursor is scrolled off-screen (history).
    private inInputZone(clientY: number): boolean {
        const term = window.term;
        const screen = this.container.querySelector('.xterm-screen') as HTMLElement | null;
        if (!term || !screen) return false;
        const rect = screen.getBoundingClientRect();
        if (rect.height <= 0) return false;
        const buf = term.buffer.active;
        const cursorVRow = buf.baseY + buf.cursorY - buf.viewportY; // 0-based viewport row
        if (cursorVRow < 0 || cursorVRow >= term.rows) return false; // cursor off-screen
        const tappedRow = Math.floor((clientY - rect.top) / (rect.height / term.rows));
        return tappedRow >= cursorVRow - 1; // box top border sits one row above the cursor
    }

    // Viewport point -> terminal cell (1-based). getBoundingClientRect is transform-aware,
    // so this stays correct even when the root is translated up over the floating keyboard.
    private cellAt(clientX: number, clientY: number): { col: number; row: number } | null {
        const term = window.term;
        const screen = this.container.querySelector('.xterm-screen') as HTMLElement | null;
        if (!term || !screen) return null;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
            col: Math.min(Math.max(Math.floor((clientX - rect.left) / (rect.width / term.cols)) + 1, 1), term.cols),
            row: Math.min(Math.max(Math.floor((clientY - rect.top) / (rect.height / term.rows)) + 1, 1), term.rows),
        };
    }

    // Emit one SGR mouse event at a viewport point. btn 0 = left button, 32 = motion with
    // the left button held (a drag). press=false emits the release form (lowercase 'm').
    // tmux has `mouse on`, so it is the one consuming these.
    private sendMouse(btn: number, clientX: number, clientY: number, press: boolean) {
        const cell = this.cellAt(clientX, clientY);
        if (!cell) return;
        this.xterm.sendData(`\x1b[<${btn};${cell.col};${cell.row}${press ? 'M' : 'm'}`);
    }

    private sendClick(clientX: number, clientY: number) {
        this.sendMouse(0, clientX, clientY, true);
        this.sendMouse(0, clientX, clientY, false);
    }

    // The word under a cell. A long press with no drag copies this — long-pressing a word to
    // grab it is what a phone user expects, and a 1-character selection would be useless.
    // Splits on whitespace, which is close enough to tmux's word-separators for a copy.
    private wordAt(cell: { col: number; row: number }): string {
        const term = window.term;
        if (!term) return '';
        const line = term.buffer.active.getLine(term.buffer.active.viewportY + cell.row - 1);
        if (!line) return '';
        const s = line.translateToString(true);
        const i = cell.col - 1;
        if (i < 0 || i >= s.length || /\s/.test(s[i])) return '';
        let a = i;
        let b = i;
        while (a > 0 && !/\s/.test(s[a - 1])) a--;
        while (b < s.length - 1 && !/\s/.test(s[b + 1])) b++;
        return s.slice(a, b + 1);
    }

    // Text between two cells (inclusive), read straight from xterm's buffer. Used to put a
    // touch selection on the clipboard from inside the gesture — see onEnd for why we can't
    // wait for tmux's OSC 52 on mobile. Cells are 1-based viewport coords, in either order.
    private textBetween(a: { col: number; row: number }, b: { col: number; row: number }): string {
        const term = window.term;
        if (!term) return '';
        const buf = term.buffer.active;
        const forward = a.row < b.row || (a.row === b.row && a.col <= b.col);
        const [s, e] = forward ? [a, b] : [b, a];
        const out: string[] = [];
        for (let r = s.row; r <= e.row; r++) {
            const line = buf.getLine(buf.viewportY + r - 1);
            if (!line) continue;
            const full = line.translateToString(true);
            const from = r === s.row ? s.col - 1 : 0;
            const to = r === e.row ? e.col : full.length;
            out.push(full.slice(from, to));
        }
        return out.join('\n').replace(/\s+$/, '');
    }

    // The clickable link (if any) under a tap. On coarse pointers every browser click on
    // the terminal is swallowed (see swallowMouse) so xterm's own link activation never
    // fires — the tap handler opens the link itself. Uses the SAME wrapped-link provider as
    // the desktop click path (computeLinks), so a URL hard-wrapped by Claude Code opens
    // whole, not truncated.
    private linkAt(clientX: number, clientY: number): ILink | null {
        const term = window.term;
        const cell = this.cellAt(clientX, clientY);
        if (!term || !cell) return null;
        const { col, row } = cell;

        // An OSC 8 hyperlink carries its URI OUT OF BAND (the target never appears in the
        // rendered text), so computeLinks — which scans text — is structurally blind to it.
        // Claude Code emits every markdown link that way, which is why tapping one did
        // nothing. xterm's own built-in OscLinkProvider CAN see them, so ask the providers
        // xterm has registered rather than only our own. Their `text` is already the URI, so
        // the caller's openLink(e, link.text) works unchanged for both kinds.
        const hit = this.providerLinkAt(term, row, col);
        if (hit) return hit;

        // Fall back to the text scan directly, so a future xterm that moves this internal
        // field degrades to "bare URLs still tappable" instead of "nothing is tappable".
        let links: ILink[];
        try {
            links = computeLinks(term, row, openLink);
        } catch {
            return null;
        }
        return this.pick(links, row, col);
    }

    // Ask every link provider xterm knows about (built-in OSC 8 + our wrapped-URL one).
    // `_linkProviderService` is internal, hence the guards: any surprise here just means we
    // fall back to the text scan above.
    private providerLinkAt(term: typeof window.term, row: number, col: number): ILink | null {
        const core = (term as unknown as { _core?: { _linkProviderService?: { linkProviders?: ILinkProvider[] } } })
            ._core;
        const providers = core?._linkProviderService?.linkProviders;
        if (!Array.isArray(providers)) return null;
        let hit: ILink | null = null;
        for (const p of providers) {
            try {
                // The built-in providers resolve synchronously, so the callback has already
                // run by the time provideLinks() returns.
                p.provideLinks(row, links => {
                    if (!hit && links) hit = this.pick(links, row, col);
                });
            } catch {
                /* a bad provider must not take the tap down with it */
            }
            if (hit) return hit;
        }
        return null;
    }

    private pick(links: ILink[], row: number, col: number): ILink | null {
        for (const l of links) {
            const { start, end } = l.range;
            const afterStart = row > start.y || (row === start.y && col >= start.x);
            const beforeEnd = row < end.y || (row === end.y && col <= end.x);
            if (afterStart && beforeEnd) return l;
        }
        return null;
    }

    // Brief teal ripple at the tap point — mobile feedback that a tap landed and
    // forwarded a click into the TUI (Claude Code's clickable affordances). Plain
    // DOM appended to <body> at viewport coords (transform-proof, like the toast);
    // self-removes when the animation ends.
    private tapRipple(clientX: number, clientY: number) {
        const r = document.createElement('div');
        r.className = 'tap-ripple';
        r.style.left = `${clientX}px`;
        r.style.top = `${clientY}px`;
        document.body.appendChild(r);
        const done = () => r.remove();
        r.addEventListener('animationend', done, { once: true });
        window.setTimeout(done, 600); // fallback if animationend is missed
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
