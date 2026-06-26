import { bind } from 'decko';
import { Component, h } from 'preact';
import { createPortal } from 'preact/compat';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';
import { KeyBar, Mod } from '../keybar';
import { MediaTray } from '../media';
import { NotifyTray } from '../media/notify-tray';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    armed: '' | Mod;
    upload: string; // toast text while uploading ('' = hidden)
    uploadPct: number; // 0-100 for the progress bar
    menu: { x: number; y: number } | null; // long-press context menu (null = hidden)
    capture: string | null; // in-app capture overlay text (null = hidden)
    capCopied: boolean; // "copy all" feedback in the capture overlay
}

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // keep in sync with server MAX_BYTES (2 GB)

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private root: HTMLElement;
    private xterm: Xterm;
    private disposeViewport?: () => void;
    private disposeTap?: () => void;
    private disposePaste?: () => void;
    private disposeWheel?: () => void;
    private swipeHint?: HTMLElement;
    private swipeArrow?: HTMLElement;
    private swipeFill?: HTMLElement;
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
        menu: null,
        capture: null,
        capCopied: false,
    };
    private uploadQueue: Blob[] = [];
    private uploading = false;
    private toastTimer?: number;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
    }

    async componentDidMount() {
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.inputHandler = this.handleInput; // route typed input through modifier logic
        this.xterm.connect();
        this.hardenInput();
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
        if (this.disarmTimer) clearTimeout(this.disarmTimer);
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.xterm.dispose();
    }

    render({ id }: Props, { modal, armed, upload, uploadPct, menu, capture, capCopied }: State) {
        return (
            <div id="terminal-root" ref={c => (this.root = c as HTMLElement)}>
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
                {menu &&
                    createPortal(
                        <div class="ctxmenu-backdrop" onClick={this.closeMenu}>
                            <div
                                class="ctxmenu"
                                style={`left:${menu.x}px;top:${menu.y}px`}
                                onClick={e => e.stopPropagation()}
                            >
                                <button type="button" class="ctxmenu-item" onClick={this.menuCapture}>
                                    抓取并复制
                                </button>
                                <button type="button" class="ctxmenu-item" onClick={this.menuPaste}>
                                    粘贴
                                </button>
                                <button type="button" class="ctxmenu-item" onClick={this.menuCopyVisible}>
                                    复制可见屏
                                </button>
                            </div>
                        </div>,
                        document.body
                    )}
                {capture !== null &&
                    createPortal(
                        <div class="mt-preview" onClick={this.closeCapture}>
                            <button class="mt-x" type="button" onClick={this.closeCapture} aria-label="close">
                                ×
                            </button>
                            <div class="capview" onClick={e => e.stopPropagation()}>
                                <div class="capview-bar">
                                    <button type="button" class="capview-copy" onClick={this.copyCapture}>
                                        {capCopied ? '已复制' : '复制全部'}
                                    </button>
                                </div>
                                <pre class="capview-text">{capture}</pre>
                            </div>
                        </div>,
                        document.body
                    )}
                <div id={id} ref={c => (this.container = c as HTMLElement)}>
                    <Modal show={modal}>
                        <label class="file-label">
                            <input onChange={this.sendFile} class="file-input" type="file" multiple />
                            <span class="file-cta">Choose files…</span>
                        </label>
                    </Modal>
                </div>
                <KeyBar armed={armed} onKey={this.sendKey} onMod={this.toggleMod} onUpload={this.triggerUpload} />
                <div id="swipe-hint" ref={c => (this.swipeHint = c as HTMLElement)}>
                    <span id="swipe-arrow" ref={c => (this.swipeArrow = c as HTMLElement)} />
                    <span id="swipe-track">
                        <i id="swipe-fill" ref={c => (this.swipeFill = c as HTMLElement)} />
                    </span>
                </div>
                <input
                    ref={c => (this.fileInput = c as HTMLInputElement)}
                    type="file"
                    multiple
                    style="display:none"
                    onChange={this.onFilePicked}
                />
                <MediaTray />
                <NotifyTray />
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

        const apply = () => {
            const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            this.kbShown = kb > 1; // soft keyboard is up iff the visual viewport shrank
            // key bar hugs the top edge of the keyboard
            if (keybar) keybar.style.transform = kb > 1 ? `translateY(${-kb}px)` : '';
            const term = window.term;
            const screen = this.container.querySelector('.xterm-screen') as HTMLElement | null;
            if (kb <= 1 || !term || !screen || !keybar) {
                this.container.style.transform = '';
                return;
            }
            // cursor's bottom edge in the untranslated layout (offsetHeight is
            // transform-independent, so this never feeds back on our own transform).
            const cellH = screen.offsetHeight / (term.rows || 1);
            const cursorBottom = 5 /* .terminal padding */ + (term.buffer.active.cursorY + 1) * cellH;
            const keybarTop = window.innerHeight - kb - keybar.offsetHeight;
            // lift just enough to leave one row of breathing room above the key bar
            const lift = Math.max(0, cursorBottom - (keybarTop - Math.round(cellH)));
            this.container.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
        };

        // coalesce bursts (keyboard slide animation, rapid cursor moves) to 1/frame
        let raf = 0;
        const onChange = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                apply();
            });
        };
        vv.addEventListener('resize', onChange);
        vv.addEventListener('scroll', onChange);
        const cursorMove = window.term?.onCursorMove(onChange); // follow the input line as you type
        apply();
        this.disposeViewport = () => {
            if (raf) cancelAnimationFrame(raf);
            vv.removeEventListener('resize', onChange);
            vv.removeEventListener('scroll', onChange);
            cursorMove?.dispose();
            this.container.style.transform = '';
            if (keybar) keybar.style.transform = '';
        };
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
        const STEP = 24; // px of vertical drag per wheel notch
        const THRESH_T = 48; // px of horizontal travel for one window switch
        let sx = 0;
        let sy = 0;
        let lastY = 0;
        let single = false;
        let scrolled = false;
        let swiped = false; // fired a window switch this gesture (one per swipe)
        let lpTimer = 0; // long-press timer (0 = inactive)
        let longPressed = false; // set once the menu has popped, so onEnd skips the tap

        const cancelLP = () => {
            if (lpTimer) {
                clearTimeout(lpTimer);
                lpTimer = 0;
            }
        };

        const onStart = (e: TouchEvent) => {
            single = e.touches.length === 1;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            lastY = sy;
            scrolled = false;
            swiped = false;
            longPressed = false;
            cancelLP();
            if (single) {
                // Hold still ~480ms -> pop the long-press context menu at the finger.
                lpTimer = window.setTimeout(() => {
                    lpTimer = 0;
                    longPressed = true;
                    (navigator as Navigator & { vibrate?: (n: number) => void }).vibrate?.(8);
                    this.openMenu(sx, sy);
                }, 480);
            }
        };
        const onMove = (e: TouchEvent) => {
            if (!single || e.touches.length !== 1) return;
            if (longPressed) return; // menu is open — ignore further movement
            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;
            const dx = x - sx;
            const dy = y - sy;
            // any real movement cancels the pending long-press (it's a scroll/swipe)
            if (lpTimer && Math.abs(dx) + Math.abs(dy) > 10) cancelLP();
            // horizontal-dominant -> window switch, with the charge-up hint
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
                scrolled = true; // not a tap
                this.showSwipe(dx < 0, Math.min(1, Math.abs(dx) / THRESH_T));
                if (!swiped && Math.abs(dx) >= THRESH_T) {
                    this.xterm.sendData(dx < 0 ? '\x02n' : '\x02p'); // left -> next, right -> prev
                    this.fireSwipe();
                    swiped = true;
                }
                return;
            }
            while (y - lastY >= STEP) {
                this.sendWheel(64); // finger down -> wheel up -> into history
                lastY += STEP;
                scrolled = true;
            }
            while (lastY - y >= STEP) {
                this.sendWheel(65); // finger up -> wheel down -> toward newest
                lastY -= STEP;
                scrolled = true;
            }
        };
        const onEnd = (e: TouchEvent) => {
            cancelLP();
            this.hideSwipe();
            if (longPressed) {
                longPressed = false;
                return; // the menu already popped; don't also tap/click
            }
            if (swiped) {
                swiped = false;
                return; // horizontal swipe already handled during the move
            }
            if (!single || scrolled || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx;
            const dy = t.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) > 10) return; // a drag, not a tap
            this.sendClick(t.clientX, t.clientY);
        };
        // Suppress the browser's own long-press callout/context menu on the canvas.
        const onCtx = (e: Event) => e.preventDefault();

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: true });
        el.addEventListener('touchend', onEnd, { passive: true });
        el.addEventListener('contextmenu', onCtx);
        this.disposeTap = () => {
            cancelLP();
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchmove', onMove);
            el.removeEventListener('touchend', onEnd);
            el.removeEventListener('contextmenu', onCtx);
        };
    }

    // ---- long-press context menu (copy / paste / capture) ---------------------
    private openMenu(x: number, y: number) {
        const W = 192;
        const H = 156;
        const cx = Math.min(Math.max(8, x), window.innerWidth - W - 8);
        const cy = Math.min(Math.max(8, y), window.innerHeight - H - 8);
        this.setState({ menu: { x: cx, y: cy } });
    }

    @bind
    private closeMenu() {
        if (this.state.menu) this.setState({ menu: null });
    }

    // Fetch the active pane's text from the same-origin __cccapture endpoint and
    // show it in an in-app overlay (like the media tray preview) — selectable for
    // native long-press copy, plus a one-tap "copy all".
    @bind
    private async menuCapture() {
        this.closeMenu();
        this.setState({ capture: '抓取中…', capCopied: false });
        try {
            const url = new URL('__cccapture?format=text', window.location.href).href;
            const r = await fetch(url, { cache: 'no-store' });
            this.setState({ capture: r.ok ? await r.text() : '抓取失败' });
        } catch {
            this.setState({ capture: '抓取失败：端点不可达' });
        }
    }

    @bind
    private closeCapture() {
        this.setState({ capture: null, capCopied: false });
    }

    @bind
    private async copyCapture() {
        try {
            await navigator.clipboard.writeText(this.state.capture || '');
            this.setState({ capCopied: true });
        } catch {
            /* writeText blocked — leave the text selectable for manual copy */
        }
    }

    // Paste OS clipboard text into the terminal (readText needs a user gesture —
    // this button tap is one).
    @bind
    private async menuPaste() {
        this.closeMenu();
        try {
            const t = await navigator.clipboard.readText();
            if (t) this.xterm.sendData(t);
        } catch {
            /* clipboard read blocked/denied — no-op */
        }
    }

    // Copy the visible screen straight to the clipboard (no page hop).
    @bind
    private async menuCopyVisible() {
        this.closeMenu();
        try {
            await navigator.clipboard.writeText(this.visibleText());
        } catch {
            /* writeText blocked — no-op */
        }
    }

    private visibleText(): string {
        const term = window.term;
        if (!term) return '';
        const buf = term.buffer.active;
        const out: string[] = [];
        for (let i = 0; i < term.rows; i++) {
            const line = buf.getLine(buf.viewportY + i);
            out.push(line ? line.translateToString(true) : '');
        }
        return out.join('\n').replace(/\s+$/, '');
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
                this.xterm.sendData(accX > 0 ? '\x02n' : '\x02p'); // left -> next, right -> prev
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
        const tx = ((next ? 1 : -1) * p * 24).toFixed(1); // pill slides toward target side
        const sc = (0.85 + 0.3 * p).toFixed(3);
        h.style.opacity = '1';
        h.style.transform = `translate(-50%, -50%) translateX(${tx}px) scale(${sc})`;
        h.classList.toggle('charged', p >= 1);
        if (this.swipeArrow) this.swipeArrow.textContent = next ? '›' : '‹';
        if (this.swipeFill) this.swipeFill.style.width = `${Math.round(p * 100)}%`;
    }

    private hideSwipe() {
        const h = this.swipeHint;
        if (!h) return;
        h.style.opacity = '0';
        h.classList.remove('charged');
    }

    private fireSwipe() {
        const h = this.swipeHint;
        if (!h) return;
        h.classList.add('fired');
        window.setTimeout(() => h.classList.remove('fired'), 200);
    }

    private sendWheel(button: number) {
        this.xterm.sendData(`\x1b[<${button};2;2M`);
    }

    // Translate a viewport tap into a terminal cell and emit an SGR left-click
    // (press + release). getBoundingClientRect is transform-aware, so this stays
    // correct even when the root is translated up over the floating keyboard.
    private sendClick(clientX: number, clientY: number) {
        const term = window.term;
        const screen = this.container.querySelector('.xterm-screen') as HTMLElement | null;
        if (!term || !screen) return;
        const rect = screen.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const col = Math.min(Math.max(Math.floor((clientX - rect.left) / (rect.width / term.cols)) + 1, 1), term.cols);
        const row = Math.min(Math.max(Math.floor((clientY - rect.top) / (rect.height / term.rows)) + 1, 1), term.rows);
        this.xterm.sendData(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`);
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
