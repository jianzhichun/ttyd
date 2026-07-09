import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { registerWrappedWebLinks } from './addons/wraplinks';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { OverlayAddon } from './addons/overlay';
import { TimestampAddon } from './addons/timestamps';
import { ZmodemAddon } from './addons/zmodem';

import '@xterm/xterm/css/xterm.css';

interface TtydTerminal extends Terminal {
    fit(): void;
}

declare global {
    interface Window {
        term: TtydTerminal;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}
type Preferences = ITerminalOptions & ClientOptions;

export type RendererType = 'dom' | 'canvas' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
    closeOnDisconnect: boolean;
}

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
}

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

function addEventListener(target: EventTarget, type: string, listener: EventListener): IDisposable {
    target.addEventListener(type, listener);
    return toDisposable(() => target.removeEventListener(type, listener));
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    private timestampAddon = new TimestampAddon();
    private clipboardAddon = new ClipboardAddon();
    private webglAddon?: WebglAddon;
    private canvasAddon?: CanvasAddon;
    private zmodemAddon?: ZmodemAddon;
    // Page-lifetime handle for the clickable-link provider. It only closes over
    // `terminal` (which outlives every socket), so it lives OUTSIDE the socket-scoped
    // `disposables` and is never torn down on reconnect — see open().
    private linkProvider?: IDisposable;

    private socket?: WebSocket;
    private token: string;
    private opened = false;
    private title?: string;
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    private closeOnDisconnect = false;
    private reconnecting = false; // a visibility/online-triggered reconnect is in flight
    private reconnectKey?: IDisposable; // pending "Press ⏎ to Reconnect" key listener
    private reconnectTimer = 0; // pending foreground auto-retry (gentle cadence)

    // pointer: coarse (touch) — computed once and reused; gates the mobile-only
    // paths (IME direct-input recovery, selection-clear) instead of re-running
    // matchMedia on every selection change / key event.
    private coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

    // optional transform for typed input (sticky-modifier handling lives in the
    // Preact layer); when set, all terminal.onData goes through it instead of
    // straight to sendData.
    public inputHandler?: (data: string) => void;

    // onSocketData passes a zero-copy Uint8Array view of the OUTPUT payload; forward it
    // straight to the terminal (no copy). The zmodem path (applyPreferences) rebuilds an
    // ArrayBuffer from the view because the sentry needs one.
    private writeFunc = (data: Uint8Array) => this.writeData(data);

    constructor(
        private options: XtermOptions,
        private sendCb: () => void
    ) {}

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        this.zmodemAddon?.sendFile(files);
    }

    @bind
    public async refreshToken() {
        try {
            const resp = await fetch(this.options.tokenUrl);
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
        }
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        event.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        return undefined;
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, clipboardAddon } = this;
        window.term = terminal as TtydTerminal;
        window.term.fit = () => {
            this.fitAddon.fit();
        };

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(clipboardAddon);
        terminal.loadAddon(this.timestampAddon);

        terminal.open(parent);
        this.guardIme(parent);
        this.allowNativePaste(terminal);
        // Page-lifetime: do NOT push into the socket-scoped `disposables`. dispose()
        // runs on every socket close (every auto-reconnect) and initListeners() never
        // re-registers the link provider — registering it here would make clickable
        // links die for good after the first reconnect. The provider only closes over
        // `terminal` (which outlives all sockets), so it needs no teardown.
        this.linkProvider = registerWrappedWebLinks(terminal);
        fitAddon.fit();

        // The first fit() above can run before the container width AND the char-cell
        // metrics have settled (xterm re-measures cell size once the font is actually
        // applied — cell.width starts a touch wider, then snaps to its real value), so
        // the grid lands a couple columns short and leaves a blank strip down the RIGHT
        // edge until something forces a re-fit ("sometimes there's a gap"). Re-fit on
        // every signal that geometry may have changed; fit() no-ops when cols/rows are
        // unchanged, so the extra calls are cheap.
        const firstRender = terminal.onRender(() => {
            firstRender.dispose();
            fitAddon.fit();
        });
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => fitAddon.fit()).observe(parent);
        }
        if (document.fonts?.ready) {
            void document.fonts.ready.then(() => fitAddon.fit());
        }
        // Backstops in case the container width / char-cell metrics finalize several
        // frames later — iOS Safari/standalone can be noticeably slower than desktop to
        // settle font metrics, so one 300ms shot wasn't enough. fit() no-ops when
        // cols/rows are unchanged, so the repeats are cheap.
        [120, 350, 800, 1500].forEach(d => window.setTimeout(() => fitAddon.fit(), d));

        // Auto-reconnect when the tab is foregrounded again or the network returns —
        // mobile suspends a backgrounded tab and drops the socket, and we don't want
        // the user to have to hit Enter. Page-lifetime listeners (survive the
        // per-socket dispose()), so they're added here, not via register().
        document.addEventListener('visibilitychange', this.reconnectNow);
        window.addEventListener('pageshow', this.reconnectNow);
        window.addEventListener('online', this.reconnectNow);
        window.addEventListener('focus', this.reconnectNow);
        // Watchdog: lifecycle events (visibilitychange/pageshow) are unreliable on
        // iOS, especially home-screen/standalone mode, so don't depend on them. Every
        // few seconds, if the tab is visible and the socket is dead, reconnect.
        // reconnectNow self-guards (no-op while hidden, in flight, or already live),
        // so this never hammers — it just guarantees recovery within a few seconds.
        window.setInterval(this.reconnectNow, 3000);
    }

    // Ctrl+V on Windows/Linux: hand the keydown to the browser instead of the pty.
    //
    // xterm maps Ctrl+<letter> to its C0 control char, so Ctrl+V sends 0x16 (^V) and
    // then calls cancel(ev) — preventDefault AND stopPropagation — on the keydown.
    // preventDefault on that keydown cancels the browser's paste default action, so
    // the document-level `paste` listener in <Terminal> (setupPaste, the screenshot /
    // file uploader) NEVER fires off the keyboard on Windows/Linux; the file silently
    // doesn't upload and a stray ^V lands in Claude Code's input. Verified 2026-07-09
    // against @xterm/xterm 5.5 with playwright: Ctrl+V → only onData("\x16"), no paste
    // event at all. Ctrl+Shift+V does reach `paste`, but Chrome treats it as "paste as
    // plain text" and strips the file items (clipboardData.items === []), so it is not
    // a workaround for uploads. macOS is fine as-is: Cmd+V is metaKey and never enters
    // xterm's ctrl branch, which is why this only ever bit Windows.
    //
    // Returning false makes xterm bail out of _keyDown before it either sends or
    // cancels anything, so the browser performs its normal paste. ^V itself stays
    // reachable through the keybar's sticky Ctrl, which transforms onData rather than
    // keydown — the cost is Ctrl+V no longer reaching vim as visual-block from a
    // physical keyboard, the same trade Windows Terminal and VS Code already make.
    //
    // Matched on keyCode 86 rather than `key`/`code` on purpose: that is the exact
    // test xterm's evaluateKeyboardEvent uses, so we intercept precisely the events it
    // would have swallowed, and nothing else.
    private allowNativePaste(terminal: Terminal) {
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        terminal.attachCustomKeyEventHandler(ev => {
            if (isMac || ev.type !== 'keydown') return true;
            if (ev.keyCode !== 86) return true;
            return !(ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey);
        });
    }

    // iOS IME direct-input fix. On the iOS Chinese keyboard a literal space, digit
    // or punctuation arrives as keydown(keyCode 229) → input(inputType:"insertText").
    // The 229 keydown trips xterm's `_keyDownSeen`, and because iOS fires NO
    // keypress, xterm's `_inputEvent` then refuses to emit the char (its
    // `!_keyDownSeen` guard) — so spaces/digits/punctuation silently never reach
    // the terminal while a CJK keyboard is up. (Latin keyboards are unaffected:
    // real keyCodes, sent on keydown.) We can't patch xterm in node_modules, so
    // recover exactly that dropped case here: a 229 keydown with NO keypress,
    // followed by a non-composing insertText → send the char ourselves. The
    // 229-and-no-keypress test means we never fire for Latin input (real keyCode,
    // or a keypress did the send) nor for composition (pinyin → 汉字 is left to
    // xterm's compositionend). Mobile only.
    @bind
    private guardIme(parent: HTMLElement) {
        if (!this.coarse) return;
        const ta = parent.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (!ta) return;
        // Discourage the mobile predictive/autocorrect layer that drives much of the
        // duplicate-input grief (xterm.js #2403). Doesn't stop dictation's cumulative
        // re-send (handled below), but cuts the autocorrect noise on top of it.
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('spellcheck', 'false');
        let imeKey = false; // last keydown was an IME keydown (keyCode 229)
        let keyPressed = false; // a keypress fired this key → xterm already sent it
        let composing = false;
        // Dictation de-dup state. iOS Dictation streams the WHOLE recognized text on
        // each insertText ("A"→"ABC"→"ABC"), no composition / no 229 keydown, and xterm
        // re-sends each in full. `acc` = cumulative text committed this dictation
        // session; we emit only the suffix delta. On STOP, iOS re-submits the whole
        // text word-by-word (first chunk is a prefix of `acc`) → `replaying`/`replayBuf`
        // swallow that whole re-submission. This logic runs ONLY for dictation (guarded
        // by !imeKey && !keyPressed below) so it never touches keyboard/Latin input.
        let acc = '';
        let replaying = false;
        let replayBuf = '';
        // Clear dictation de-dup state whenever a dictation "session" can't still be
        // running: a real keystroke, the start of CJK composition, or the textarea
        // losing focus (mic dismissed / keyboard closed / window switch). Without this a
        // stale `acc` makes the next dictation's opening word look like a prefix of the
        // old text and get swallowed as a STOP-replay. NO idle timer on purpose — the
        // final confirmation chunk arrives >1s late and equals `acc`, so clearing `acc`
        // on a timer would let that chunk duplicate (the bug we removed earlier).
        const resetDictation = () => {
            acc = '';
            replaying = false;
            replayBuf = '';
        };

        // TEMP on-screen event log (?vvdebug / ?imelog) to characterize how iOS really
        // delivers Dictation vs CJK-keyboard input on a real device — they can't be
        // told apart from char type alone, so we capture the raw event sequence.
        let logEl: HTMLElement | null = null;
        const logLines: string[] = [];
        if (location.search.indexOf('vvdebug') >= 0 || location.search.indexOf('imelog') >= 0) {
            logEl = document.createElement('div');
            logEl.style.cssText =
                'position:fixed;left:0;bottom:0;width:100%;max-height:42vh;overflow:hidden;' +
                'z-index:99999;background:rgba(0,0,0,.85);color:#0f0;' +
                'font:10px/1.25 monospace;padding:3px;white-space:pre;pointer-events:none';
            document.body.appendChild(logEl);
        }
        const ev = (s: string) => {
            if (!logEl) return;
            logLines.unshift(s);
            if (logLines.length > 16) logLines.pop();
            logEl.textContent = logLines.join('\n');
        };

        // Page-lifetime listeners on the single, never-rebuilt helper textarea —
        // deliberately NOT this.register(). dispose() runs on every socket close
        // (i.e. every auto-reconnect), but guardIme is only called once from open(),
        // so registering these would let the first reconnect tear them down for good
        // and silently kill CJK space/digit input again. The textarea outlives every
        // socket, so these never need teardown.
        const reg = (type: string, fn: EventListener) => {
            ta.addEventListener(type, fn, true);
        };
        reg('keydown', (e: Event) => {
            imeKey = (e as KeyboardEvent).keyCode === 229;
            keyPressed = false;
            resetDictation(); // a real keydown means we're no longer mid-dictation
            ev(`kd kc=${(e as KeyboardEvent).keyCode} ${JSON.stringify((e as KeyboardEvent).key)}`);
        });
        reg('keypress', () => {
            keyPressed = true;
            ev('kp');
        });
        reg('compositionstart', () => {
            composing = true;
            imeKey = false;
            resetDictation();
            ev('cs');
        });
        reg('compositionupdate', (e: Event) => ev(`cu ${JSON.stringify((e as CompositionEvent).data)}`));
        reg('compositionend', (e: Event) => {
            composing = false;
            imeKey = false;
            ev(`ce ${JSON.stringify((e as CompositionEvent).data)}`);
        });
        reg('blur', () => {
            resetDictation(); // mic dismissed / keyboard closed / window switch
            ev('blur reset');
        });
        // beforeinput logged too — its inputType often disambiguates dictation from a
        // keystroke before the value mutates. Pure diagnostics, no side effects.
        reg('beforeinput', (e: Event) =>
            ev(`bi ${(e as InputEvent).inputType} d=${JSON.stringify((e as InputEvent).data)}`)
        );
        const send = (s: string) => {
            if (this.inputHandler) this.inputHandler(s);
            else this.sendData(s);
        };
        // input is handled on DOCUMENT in the CAPTURE phase, so we run BEFORE xterm's
        // own textarea 'input' listener (which is on the textarea, later in the capture
        // path). That lets us stopImmediatePropagation() to suppress xterm's full-data
        // send once we've emitted the delta ourselves.
        document.addEventListener(
            'input',
            (e: Event) => {
                if (e.target !== ta) return;
                const ie = e as InputEvent;
                // Each keydown/keypress maps to exactly one input event, so consume
                // (snapshot + clear) the per-key flags HERE. Otherwise keyPressed stays
                // true after typing and silently disables dictation de-dup when the user
                // switches to dictation without an intervening keydown.
                const wasImeKey = imeKey;
                const wasKeyPressed = keyPressed;
                imeKey = false;
                keyPressed = false;
                ev(
                    `in ${ie.inputType} d=${JSON.stringify(ie.data)} ic=${ie.isComposing} ` +
                        `cm=${composing} drop=${wasImeKey && !wasKeyPressed}`
                );

                // ---- iOS Dictation de-dup — ONLY for dictation ----
                // Dictation has no 229 keydown and no keypress; the !wasImeKey &&
                // !wasKeyPressed guard keeps this off keyboard/Latin input (otherwise it
                // would swallow e.g. a second space or a repeated letter as a "dup").
                if (ie.inputType === 'insertText' && !composing && !ie.isComposing && !wasImeKey && !wasKeyPressed) {
                    const d = ie.data ?? '';
                    if (replaying) {
                        const next = replayBuf + d;
                        if (acc.startsWith(next)) {
                            replayBuf = next;
                            if (next.length >= acc.length) {
                                replaying = false;
                                replayBuf = '';
                                acc = '';
                            }
                            ev('  -> REPLAY (suppressed)');
                            e.stopImmediatePropagation();
                            return;
                        }
                        // diverged → not a replay after all; treat as new input
                        replaying = false;
                        replayBuf = '';
                        acc = d;
                    } else if (acc !== '' && d.startsWith(acc)) {
                        const delta = d.slice(acc.length); // partial extends cumulative
                        acc = d;
                        if (delta) {
                            send(delta);
                            ev(`  -> DELTA ${JSON.stringify(delta)}`);
                        } else {
                            ev('  -> DUP (suppressed)');
                        }
                        e.stopImmediatePropagation();
                        return;
                    } else if (acc.length > 1 && d.length < acc.length && acc.startsWith(d)) {
                        // STOP: iOS re-submits the whole text word-by-word; the first
                        // chunk is a prefix of acc. Swallow the entire re-submission.
                        replaying = true;
                        replayBuf = d;
                        if (replayBuf.length >= acc.length) {
                            replaying = false;
                            replayBuf = '';
                            acc = '';
                        }
                        ev('  -> REPLAY start (suppressed)');
                        e.stopImmediatePropagation();
                        return;
                    } else {
                        acc = d; // first segment / new text → let xterm send it
                    }
                }

                // ---- CJK soft keyboard: recover the single char xterm drops ----
                // A literal space/digit/punct arrives as 229 keydown + insertText with
                // no keypress; xterm's _keyDownSeen guard then refuses it, so we resend.
                const dropped = wasImeKey && !wasKeyPressed;
                if (composing || ie.isComposing || !dropped) return;
                const d = ie.data;
                if (ie.inputType === 'insertText' && d && d.length === 1) {
                    ta.value = '';
                    send(d);
                    ev(`  -> SENT ${JSON.stringify(d)}`);
                }
            },
            true
        );
    }

    @bind
    private initListeners() {
        const { terminal, fitAddon, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                if (data && data !== '' && !this.titleFixed) {
                    document.title = data + ' | ' + this.title;
                }
            })
        );
        register(terminal.onData(data => (this.inputHandler ? this.inputHandler(data) : sendData(data))));
        register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            })
        );
        register(
            terminal.onSelectionChange(() => {
                if (this.terminal.getSelection() === '') return;
                // On touch a drag is a scroll/swipe gesture (tap forwards a click,
                // long-press opens our menu) \u2014 there's no drag-to-select UX. The
                // synthesized mouse events of a touch-drag still make xterm start a
                // selection, so on coarse pointers wipe it instead of letting it
                // linger over the screen / copy-on-select.
                if (this.coarse) {
                    this.terminal.clearSelection();
                    return;
                }
                try {
                    document.execCommand('copy');
                } catch (e) {
                    return;
                }
                this.overlayAddon?.showOverlay('\u2702', 200);
            })
        );
        register(addEventListener(window, 'resize', () => fitAddon.fit()));
        register(addEventListener(window, 'beforeunload', this.onWindowUnload));
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                if (this.pending < lowWater) {
                    this.socket?.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater) {
                this.socket?.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public fit() {
        this.fitAddon.fit();
    }

    @bind
    public sendData(data: string | Uint8Array) {
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    // Mobile browsers suspend a backgrounded tab and drop its WebSocket; on return
    // ttyd would otherwise sit on "Press ⏎ to Reconnect" until you hit Enter. Wire
    // this to visibilitychange / pageshow / online so coming back (or the network
    // returning) silently reconnects. No-ops while hidden, while a reconnect is
    // already in flight, or when the socket is still live.
    @bind
    private reconnectNow() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (this.reconnecting) return;
        const s = this.socket;
        if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) return;
        this.reconnecting = true;
        this.reconnectKey?.dispose();
        this.reconnectKey = undefined;
        this.overlayAddon.showOverlay('Reconnecting…');
        this.refreshToken().then(this.connect);
    }

    @bind
    public connect() {
        // Single teardown point for socket-scoped disposables. reconnectNow() can win
        // the race against the previous socket's close event — whose onSocketClose then
        // early-returns WITHOUT disposing (its target is no longer this.socket), leaving
        // the old cycle's terminal.onData / socket listeners attached. Re-running
        // initListeners() on the new socket would then double them up → every keystroke
        // sends twice (and RESIZE duplicates) until the next clean close. Disposing here
        // makes connect() idempotent regardless of entry path (no-op on the first
        // connect and right after onSocketClose already disposed).
        this.dispose();
        this.socket = new WebSocket(this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        register(addEventListener(socket, 'open', this.onSocketOpen));
        register(addEventListener(socket, 'message', this.onSocketData as EventListener));
        register(addEventListener(socket, 'close', this.onSocketClose as EventListener));
        register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        const { textEncoder, terminal, overlayAddon } = this;
        const msg = JSON.stringify({ AuthToken: this.token, columns: terminal.cols, rows: terminal.rows });
        this.socket?.send(textEncoder.encode(msg));

        if (this.opened) {
            terminal.reset();
            terminal.options.disableStdin = false;
            overlayAddon.showOverlay('Reconnected', 300);
        } else {
            this.opened = true;
        }

        this.doReconnect = this.reconnect;
        this.reconnecting = false;
        this.reconnectKey?.dispose();
        this.reconnectKey = undefined;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;
        }
        this.initListeners();
        // On touch devices don't auto-summon the soft keyboard on connect — let
        // the user tap the terminal (or the ⌨ toggle) when they want to type.
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!coarse) terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        // Ignore a late close from a socket we've already replaced (e.g. reconnectNow
        // fired from visibilitychange before this old socket's queued close ran) —
        // otherwise dispose() would tear down the fresh connection's listeners.
        if (event.target && event.target !== this.socket) return;
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const { refreshToken, connect, doReconnect, overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.dispose();
        this.reconnecting = false;

        // 1000: CLOSE_NORMAL
        if (event.code !== 1000 && doReconnect) {
            // Hold `reconnecting` across the async refreshToken() so a watchdog /
            // focus / visibilitychange reconnectNow() firing in that window can't
            // start a SECOND socket (double WebSocket → double tmux attach / double
            // PTY). onSocketOpen clears it once the new socket is up.
            this.reconnecting = true;
            overlayAddon.showOverlay('Reconnecting...');
            refreshToken().then(connect);
        } else if (this.closeOnDisconnect) {
            window.close();
        } else {
            // Manual fallback (Enter), plus auto-recovery: while the tab is
            // foreground, retry on a gentle ~1.5s cadence — not a tight loop — so a
            // dropped socket (server restart, brief blip, or a close that lands just
            // after we foreground and the visibilitychange race missed) comes back
            // on its own. A backgrounded tab schedules nothing and instead recovers
            // on return via reconnectNow.
            const { terminal } = this;
            this.reconnectKey?.dispose();
            this.reconnectKey = terminal.onKey(e => {
                if (e.domEvent.key === 'Enter') this.reconnectNow();
            });
            overlayAddon.showOverlay('Press ⏎ to Reconnect');
            if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !this.reconnectTimer) {
                this.reconnectTimer = window.setTimeout(() => {
                    this.reconnectTimer = 0;
                    this.reconnectNow();
                }, 1500);
            }
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const { terminal } = this;
        const { clientOptions } = this.options;
        const prefs = {} as Preferences;
        const queryObj = Array.from(new URLSearchParams(query) as unknown as Iterable<[string, string]>);

        for (const [k, queryVal] of queryObj) {
            let v = clientOptions[k];
            if (v === undefined) v = terminal.options[k];
            switch (typeof v) {
                case 'boolean':
                    prefs[k] = queryVal === 'true' || queryVal === '1';
                    break;
                case 'number':
                case 'bigint':
                    prefs[k] = Number.parseInt(queryVal, 10);
                    break;
                case 'string':
                    prefs[k] = queryVal;
                    break;
                case 'object':
                    prefs[k] = JSON.parse(queryVal);
                    break;
                default:
                    console.warn(`[ttyd] maybe unknown option: ${k}=${queryVal}, treating as string`);
                    prefs[k] = queryVal;
                    break;
            }
        }

        return prefs;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        // Zero-copy view over the payload (everything after the 1-byte command). The hot
        // OUTPUT path forwards this straight to the terminal, dropping the per-message
        // rawData.slice(1) copy; textDecoder.decode() accepts the view just as well.
        const data = new Uint8Array(rawData, 1);

        switch (cmd) {
            case Command.OUTPUT:
                this.writeFunc(data);
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                document.title = this.title;
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, fitAddon, register } = this;
        if (prefs.enableZmodem || prefs.enableTrzsz) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data =>
                this.zmodemAddon?.consume(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of Object.entries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        window.removeEventListener('beforeunload', this.onWindowUnload);
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        terminal.loadAddon(register(new ImageAddon()));
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'closeOnDisconnect':
                    if (value) {
                        console.log('[ttyd] close on disconnect enabled (Reconnect disabled)');
                        this.closeOnDisconnect = true;
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'titleFixed':
                    if (!value || value === '') return;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    document.title = value;
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) fitAddon.fit();
                    break;
            }
        }
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeCanvasRenderer = () => {
            try {
                this.canvasAddon?.dispose();
            } catch {
                // ignore
            }
            this.canvasAddon = undefined;
        };
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableCanvasRenderer = () => {
            if (this.canvasAddon) return;
            this.canvasAddon = new CanvasAddon();
            disposeWebglRenderer();
            try {
                this.terminal.loadAddon(this.canvasAddon);
                console.log('[ttyd] canvas renderer loaded');
            } catch (e) {
                console.log('[ttyd] canvas renderer could not be loaded, falling back to dom renderer', e);
                disposeCanvasRenderer();
            }
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            disposeCanvasRenderer();
            try {
                this.webglAddon.onContextLoss(() => {
                    // The GPU context can be dropped out from under us — iOS Safari
                    // does it when the tab is backgrounded (e.g. switching apps to
                    // grab a screenshot/file before a Ctrl+V upload) or under memory
                    // pressure. Disposing WebGL with no replacement leaves NO
                    // renderer and blanks the whole terminal. Fall back to the
                    // canvas renderer so it keeps drawing.
                    enableCanvasRenderer();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to canvas renderer', e);
                disposeWebglRenderer();
                enableCanvasRenderer();
            }
        };

        switch (value) {
            case 'canvas':
                enableCanvasRenderer();
                break;
            case 'webgl':
                // iOS Safari's WebGL is janky and drops its GPU context whenever the
                // tab is backgrounded, forcing a canvas fallback each time (churn +
                // flicker + jank — xterm.js #3357/#5816). On touch devices just use the
                // canvas renderer from the start; it's smooth and stable there.
                if (this.coarse) enableCanvasRenderer();
                else enableWebglRenderer();
                break;
            case 'dom':
                disposeWebglRenderer();
                disposeCanvasRenderer();
                console.log('[ttyd] dom renderer loaded');
                break;
            default:
                break;
        }
    }
}
