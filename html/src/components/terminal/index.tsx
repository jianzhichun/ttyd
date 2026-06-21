import { bind } from 'decko';
import { Component, h } from 'preact';
import { createPortal } from 'preact/compat';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';
import { KeyBar, Mod } from '../keybar';

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

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private root: HTMLElement;
    private xterm: Xterm;
    private disposeViewport?: () => void;
    private disposeTap?: () => void;
    private disposePaste?: () => void;
    private fileInput?: HTMLInputElement;
    private disarmTimer?: number;

    state: State = { modal: false, armed: '', upload: '', uploadPct: 0 };
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
        this.setupPaste();
    }

    componentWillUnmount() {
        this.disposeViewport?.();
        this.disposeTap?.();
        this.disposePaste?.();
        if (this.disarmTimer) clearTimeout(this.disarmTimer);
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.xterm.dispose();
    }

    render({ id }: Props, { modal, armed, upload, uploadPct }: State) {
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
                <div id={id} ref={c => (this.container = c as HTMLElement)}>
                    <Modal show={modal}>
                        <label class="file-label">
                            <input onChange={this.sendFile} class="file-input" type="file" multiple />
                            <span class="file-cta">Choose files…</span>
                        </label>
                    </Modal>
                </div>
                <KeyBar armed={armed} onKey={this.sendKey} onMod={this.toggleMod} onUpload={this.triggerUpload} />
                <input
                    ref={c => (this.fileInput = c as HTMLInputElement)}
                    type="file"
                    multiple
                    style="display:none"
                    onChange={this.onFilePicked}
                />
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
    @bind
    private setupTouch() {
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!coarse) return;
        const el = this.container;
        const STEP = 24; // px of vertical drag per wheel notch
        let sx = 0;
        let sy = 0;
        let lastY = 0;
        let single = false;
        let scrolled = false;

        const onStart = (e: TouchEvent) => {
            single = e.touches.length === 1;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            lastY = sy;
            scrolled = false;
        };
        const onMove = (e: TouchEvent) => {
            if (!single || e.touches.length !== 1) return;
            const y = e.touches[0].clientY;
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
            if (!single || scrolled || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            if (Math.abs(t.clientX - sx) + Math.abs(t.clientY - sy) > 10) return; // a drag, not a tap
            this.sendClick(t.clientX, t.clientY);
        };

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: true });
        el.addEventListener('touchend', onEnd, { passive: true });
        this.disposeTap = () => {
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchmove', onMove);
            el.removeEventListener('touchend', onEnd);
        };
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
