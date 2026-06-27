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
// Stamps are formatted client-side in UTC (homevm runs in UTC, so the gutter
// agrees with the server clock, logs, cron and chat), widened only as needed:
// HH:MM:SS today, MM-DD HH:MM:SS an earlier day, +year an earlier year. Always on.
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

const STYLE_ID = 'ts-gutter-style';
const POLL_MS = 800; // how often to refresh the per-row times from the server
// Stamp density: anchored at the newest stamp and walking up, show only one time
// per this window — blocks within MERGE_MS of the last shown stamp collapse into
// it. Keeps the gutter readable instead of one stamp per output block.
const MERGE_MS = 5 * 60 * 1000;

const CSS = `
.ts-gutter{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;pointer-events:none;z-index:9;font:11px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.ts-row{flex:1 1 0;display:flex;align-items:center;justify-content:flex-end}
.ts-row span:empty{display:none}
.ts-row span{padding:0 4px;border-radius:3px;white-space:nowrap;background:rgba(0,0,0,.38);color:rgba(255,255,255,.5)}
.ts-row .ts-z{margin-left:3px;font-size:9px;font-style:normal;opacity:.7}
`;

export class TimestampAddon implements ITerminalAddon {
    private terminal?: Terminal;
    private disposables: IDisposable[] = [];
    private times: (number | undefined)[] = []; // live-pane row -> epoch ms (used at bottom)
    private cmap = new Map<string, number>(); // line content -> settle ms (used while scrolled)
    private mapGen = ''; // generation of the cached cmap (server bumps on change)
    private mapWin = ''; // window the cmap belongs to (clear on window switch)
    private gutter?: HTMLDivElement;
    private rowEls: HTMLDivElement[] = [];
    private rowLabels: string[] = []; // last text painted per row → skip no-op DOM writes
    private msScratch: number[] = []; // reused per-row settle-ms buffer (0 = no stamp; paint pass 1)
    private pollId?: number;
    private rafId = 0; // coalesces render/scroll bursts to one paint per frame

    public activate(terminal: Terminal): void {
        this.terminal = terminal;
        this.injectStyle();
        this.disposables.push(terminal.onRender(() => this.schedule()));
        this.disposables.push(terminal.onScroll(() => this.schedule()));
        this.fetchTimes();
        this.pollId = window.setInterval(() => this.fetchTimes(), POLL_MS);
    }

    // Coalesce a burst of render/scroll events into a single paint on the next
    // animation frame — the gutter never needs to repaint more than once a frame.
    private schedule(): void {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            this.paint();
        });
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        if (this.pollId) window.clearInterval(this.pollId);
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.gutter?.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    // Pull the authoritative times from the same-origin sidecar. `ts` is the
    // live-pane per-row table (correct at the bottom). While scrolled into
    // history that table no longer matches the screen, so we also pull a
    // content->ms map and look rows up by their text — only fetched when scrolled,
    // and only re-sent when its generation changes (the gen round-trips here).
    // On any failure keep the last-known data rather than blanking the gutter.
    private async fetchTimes(): Promise<void> {
        try {
            const buf = this.terminal?.buffer.active;
            const scrolled = buf ? buf.viewportY < buf.baseY : false;
            const u = new URL('__cctimes', window.location.href);
            if (scrolled) {
                u.searchParams.set('map', '1');
                u.searchParams.set('gen', this.mapGen);
            }
            const r = await fetch(u.href, { cache: 'no-store' });
            if (!r.ok) return;
            const data = await r.json();
            if (Array.isArray(data?.ts)) this.times = data.ts as (number | undefined)[];
            const win = typeof data?.win === 'string' ? data.win : '';
            if (win !== this.mapWin) {
                this.mapWin = win; // active window switched → old map is stale
                this.cmap.clear();
                this.mapGen = '';
            }
            if (data?.map && typeof data.map === 'object') {
                const m = new Map<string, number>();
                for (const [k, v] of Object.entries(data.map)) m.set(k, v as number);
                this.cmap = m;
            }
            if (data?.gen != null) this.mapGen = String(data.gen);
            this.schedule();
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
        // UTC (the getUTC* getters) — homevm runs in UTC, so this keeps the gutter
        // consistent with the server clock, logs, cron and everything stated in
        // chat. Widened to show only the parts that differ from "now":
        //   today (UTC)  → HH:MM:SS
        //   earlier day  → MM-DD HH:MM:SS
        //   earlier year → YYYY-MM-DD HH:MM:SS
        const d = new Date(ms);
        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
        if (
            d.getUTCFullYear() === now.getUTCFullYear() &&
            d.getUTCMonth() === now.getUTCMonth() &&
            d.getUTCDate() === now.getUTCDate()
        ) {
            return time;
        }
        const md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${time}`;
        return d.getUTCFullYear() === now.getUTCFullYear() ? md : `${d.getUTCFullYear()}-${md}`;
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
            this.rowLabels.push('');
        }
        while (this.rowEls.length > rows) {
            this.rowEls.pop()?.remove();
            this.rowLabels.pop();
        }

        const buf = term.buffer.active;

        // No-stamp zone: Claude Code's input box + status line repaint constantly
        // and aren't "output" — the cursor lives in that box, so suppress the
        // cursor row, the box's top border one row above it, and everything below.
        // (Scrolled into history → cursor off-screen → liveTop = rows → show all.)
        const cursorVRow = buf.baseY + buf.cursorY - buf.viewportY;
        const liveTop = cursorVRow > 0 && cursorVRow <= rows ? cursorVRow - 1 : rows;

        // Pass 1: each row's settle-ms (0 = no stamp). At the live bottom the
        // position-indexed `times` lines up with the screen, so use it directly
        // (gated by a cheap blank/zone reject before the costly translateToString).
        // While scrolled into history the positions no longer match, so look each
        // row up by its rendered text in the content map instead.
        const scrolled = buf.viewportY < buf.baseY;
        const ms = this.msScratch;
        ms.length = rows;
        for (let i = 0; i < rows; i++) {
            let v = 0;
            if (i < liveTop && (scrolled || this.times[i])) {
                const line = buf.getLine(buf.viewportY + i);
                const text = line ? line.translateToString(true) : '';
                if (text.trim() !== '') v = scrolled ? this.cmap.get(text) || 0 : this.times[i] || 0;
            }
            ms[i] = v;
        }
        // Pass 2: from the newest stamp upward, keep only one stamp per MERGE_MS
        // window — older blocks within 5 min of the last shown stamp collapse into
        // it — and place it on that block's BOTTOM row → bottom-right of the group,
        // anchored at the newest. Unchanged rows skip the DOM.
        let lastShown = 0;
        for (let i = rows - 1; i >= 0; i--) {
            const v = ms[i];
            let want = '';
            if (v && (lastShown === 0 || lastShown - v >= MERGE_MS)) {
                want = this.fmt(v);
                lastShown = v;
            }
            if (this.rowLabels[i] === want) continue;
            this.rowLabels[i] = want;
            const span = this.rowEls[i].firstChild as HTMLElement;
            if (want === '') span.textContent = '';
            // time + a dim "UTC" tag so the gutter reads unambiguously as UTC
            else span.innerHTML = `${want}<i class="ts-z">UTC</i>`;
        }
    }
}
