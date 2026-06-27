// Timestamp gutter — when each visible row of output last changed, shown in a
// right-side margin. Adapted for a repainting TUI (Claude Code) relayed through
// tmux, where "stamp the row the browser just painted" is the wrong model: the
// browser only sees the screen while it's connected, and on every (re)connect
// tmux repaints the whole screen at once — so a client-side stamp reads "now" for
// everything exactly when you return to the phone after being away, which defeats
// the point (knowing when output actually happened).
//
// So the times come from the SERVER: the cc-paste-upload sidecar polls each tmux
// pane with `capture-pane`, diffs the lines, and records the real server time
// each row last changed — continuously, regardless of any browser. We just fetch
// that per-row table (same-origin __cctimes) and render it. The stamps therefore
// reflect when output ACTUALLY happened, survive reconnect/refresh, and capture
// activity that occurred while you weren't looking.
//
// Stamps are formatted client-side from the local Date getters → browser-local
// timezone, as a compact "MM-DD HH:MM:SS". Always on.
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

const STYLE_ID = 'ts-gutter-style';
const POLL_MS = 800; // how often to refresh the per-row times from the server

const CSS = `
.ts-gutter{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;pointer-events:none;z-index:9;font:11px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.ts-row{flex:1 1 0;display:flex;align-items:center;justify-content:flex-end}
.ts-row span:empty{display:none}
.ts-row span{padding:0 4px;border-radius:3px;white-space:nowrap;background:rgba(0,0,0,.38);color:rgba(255,255,255,.5)}
`;

export class TimestampAddon implements ITerminalAddon {
    private terminal?: Terminal;
    private disposables: IDisposable[] = [];
    private times: (number | undefined)[] = []; // pane row -> epoch ms (server time)
    private gutter?: HTMLDivElement;
    private rowEls: HTMLDivElement[] = [];
    private pollId?: number;

    public activate(terminal: Terminal): void {
        this.terminal = terminal;
        this.injectStyle();
        this.disposables.push(terminal.onRender(() => this.paint()));
        this.disposables.push(terminal.onScroll(() => this.paint()));
        this.fetchTimes();
        this.pollId = window.setInterval(() => this.fetchTimes(), POLL_MS);
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        if (this.pollId) window.clearInterval(this.pollId);
        this.gutter?.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    // Pull the authoritative per-row change-times from the same-origin sidecar.
    // On any failure keep the last-known times rather than blanking the gutter.
    private async fetchTimes(): Promise<void> {
        try {
            const url = new URL('__cctimes', window.location.href).href;
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return;
            const data = await r.json();
            if (Array.isArray(data?.ts)) {
                this.times = data.ts as (number | undefined)[];
                this.paint();
            }
        } catch {
            /* transient — keep the previous times */
        }
    }

    private injectStyle(): void {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    private fmt(ms: number): string {
        // Local date + time (browser timezone, via the local Date getters), as a
        // compact MM-DD HH:MM:SS. The year is shown ONLY when the stamp is not from
        // the current year, so same-year stamps stay narrow while an older one is
        // still unambiguous.
        const d = new Date(ms);
        const p = (n: number) => String(n).padStart(2, '0');
        const dt = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
            d.getSeconds()
        )}`;
        return d.getFullYear() === new Date().getFullYear() ? dt : `${d.getFullYear()}-${dt}`;
    }

    // The gutter DOM needs terminal.element, which only exists after open(); build
    // it lazily on the first render.
    private build(screen: HTMLElement): void {
        this.gutter = document.createElement('div');
        this.gutter.className = 'ts-gutter';
        screen.appendChild(this.gutter);
    }

    private paint(): void {
        const term = this.terminal;
        if (!term) return;
        if (!this.gutter) {
            const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
            if (!screen) return;
            this.build(screen);
        }
        const rows = term.rows;
        while (this.rowEls.length < rows) {
            const d = document.createElement('div');
            d.className = 'ts-row';
            d.appendChild(document.createElement('span'));
            this.gutter!.appendChild(d);
            this.rowEls.push(d);
        }
        while (this.rowEls.length > rows) {
            const extra = this.rowEls.pop();
            extra?.remove();
        }

        const buf = term.buffer.active;

        // No-stamp zone: Claude Code's input box + status line repaint constantly
        // and aren't "output" — the cursor lives in that box, so suppress the
        // cursor row, the box's top border one row above it, and everything below.
        // (Scrolled into history → cursor off-screen → liveTop = rows → show all.)
        const cursorVRow = buf.baseY + buf.cursorY - buf.viewportY;
        const liveTop = cursorVRow > 0 && cursorVRow <= rows ? cursorVRow - 1 : rows;

        // Display: server time per row (top-aligned); skip the no-stamp zone and
        // blank rows, and collapse a run of rows sharing the same label to one.
        let prev = '';
        for (let i = 0; i < rows; i++) {
            const span = this.rowEls[i].firstChild as HTMLElement;
            const t = this.times[i];
            const line = buf.getLine(buf.viewportY + i);
            const blank = !line || line.translateToString(true).trim() === '';
            if (i >= liveTop || !t || blank) {
                span.textContent = '';
                continue;
            }
            const label = this.fmt(t);
            span.textContent = label === prev ? '' : label;
            prev = label;
        }
    }
}
