// Timestamp gutter — iTerm2-style "Show Timestamps", adapted for a repainting
// TUI (Claude Code) relayed through tmux.
//
// The naive "stamp every written row" model fails here: tmux repaints whole
// regions (and the entire screen on connect / resize / window-switch), so most
// rows get (re)written in the same instant — producing a solid column of
// identical (or, on a partial repaint, alternating) times on every line.
//
// Instead we diff the visible rows each render:
//   • a small change (≤ BULK rows) = genuine line-by-line output → stamp those rows
//   • a large change (> BULK rows) = a repaint/scroll/switch → stamp the whole
//     screen with one instant, so it collapses to a single timestamp
// Then on display we hide blank rows and collapse runs sharing the same second,
// so the gutter stays sparse: per-line times while output streams a line at a
// time, and a single time marker on a bulk repaint.
//
// Times are formatted client-side via toLocaleTimeString → browser-local
// timezone. Always on.
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

const STYLE_ID = 'ts-gutter-style';
const BULK = 3; // > this many rows changing in one render = a repaint, not output

const CSS = `
.ts-gutter{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;pointer-events:none;z-index:9;font:11px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.ts-row{flex:1 1 0;display:flex;align-items:center;justify-content:flex-end}
.ts-row span:empty{display:none}
.ts-row span{padding:0 4px;border-radius:3px;white-space:nowrap;background:rgba(0,0,0,.38);color:rgba(255,255,255,.5)}
`;

export class TimestampAddon implements ITerminalAddon {
    private terminal?: Terminal;
    private disposables: IDisposable[] = [];
    private times: (number | undefined)[] = []; // viewport row -> epoch ms
    private lastText: string[] = []; // last rendered text per viewport row
    private gutter?: HTMLDivElement;
    private rowEls: HTMLDivElement[] = [];

    public activate(terminal: Terminal): void {
        this.terminal = terminal;
        this.injectStyle();
        this.disposables.push(terminal.onRender(() => this.paint()));
        this.disposables.push(terminal.onScroll(() => this.paint()));
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.gutter?.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    private injectStyle(): void {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    private fmt(ms: number): string {
        return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
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

        // Snapshot current visible text.
        const buf = term.buffer.active;
        const cur: string[] = new Array(rows);
        for (let i = 0; i < rows; i++) {
            const line = buf.getLine(buf.viewportY + i);
            cur[i] = line ? line.translateToString(true) : '';
        }

        if (this.lastText.length !== rows) {
            // First paint or a resize — start from a clean slate, no stamps.
            this.times = new Array(rows);
        } else {
            const changed: number[] = [];
            for (let i = 0; i < rows; i++) {
                if (cur[i] !== this.lastText[i]) changed.push(i);
            }
            if (changed.length > 0) {
                const now = Date.now();
                if (changed.length <= BULK) {
                    for (const i of changed) this.times[i] = now; // line-by-line output
                } else {
                    this.times = new Array(rows).fill(now); // repaint/scroll/switch → one instant
                }
            }
        }
        this.lastText = cur;

        // Display: skip blank rows; within a run of equal seconds show it once.
        let prev = '';
        for (let i = 0; i < rows; i++) {
            const span = this.rowEls[i].firstChild as HTMLElement;
            const t = this.times[i];
            if (!t || cur[i].trim() === '') {
                span.textContent = '';
                continue;
            }
            const label = this.fmt(t);
            span.textContent = label === prev ? '' : label;
            prev = label;
        }
    }
}
