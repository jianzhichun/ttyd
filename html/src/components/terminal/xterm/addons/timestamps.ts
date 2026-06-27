// Timestamp gutter — iTerm2-style "Show Timestamps".
//
// Records, per terminal row, the wall-clock time it was last written, and paints
// those times in a right-side margin. The byte stream is never touched (Claude
// Code and other TUIs repaint/scroll — injecting text into the stream would
// corrupt rendering); the gutter is a pure overlay.
//
// Time is formatted client-side via toLocaleTimeString → always the browser's
// local timezone. Toggle with the clock button (state persisted, default on).
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

const STORE = 'ttyd-ts-on';
const STYLE_ID = 'ts-gutter-style';

const CSS = `
.ts-gutter{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;pointer-events:none;z-index:9;font:11px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.xterm:not(.ts-on) .ts-gutter{display:none}
.ts-row{flex:1 1 0;display:flex;align-items:center;justify-content:flex-end}
.ts-row span:empty{display:none}
.ts-row span{padding:0 4px;border-radius:3px;white-space:nowrap;background:rgba(0,0,0,.55);color:rgba(255,255,255,.72)}
.ts-toggle{position:fixed;right:10px;bottom:10px;z-index:30;width:30px;height:30px;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(40,40,40,.8);color:#ddd;font-size:14px;line-height:1}
.ts-toggle.active{border-color:#d8a657;color:#d8a657}
`;

export class TimestampAddon implements ITerminalAddon {
    private terminal?: Terminal;
    private disposables: IDisposable[] = [];
    private times = new Map<number, number>(); // absolute buffer line -> epoch ms
    private gutter?: HTMLDivElement;
    private rowEls: HTMLDivElement[] = [];
    private toggleBtn?: HTMLButtonElement;

    public activate(terminal: Terminal): void {
        this.terminal = terminal;
        this.injectStyle();
        // Attach the stamp hooks immediately. activate() runs at loadAddon time,
        // before terminal.open() and before any data is written, so the very
        // first lines of a session are stamped too (no cold-start gap).
        const stamp = () => {
            const b = terminal.buffer.active;
            this.times.set(b.baseY + b.cursorY, Date.now());
        };
        this.disposables.push(terminal.onWriteParsed(stamp));
        this.disposables.push(terminal.onLineFeed(stamp));
        this.disposables.push(terminal.onRender(() => this.paint()));
        this.disposables.push(terminal.onScroll(() => this.paint()));
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.gutter?.remove();
        this.toggleBtn?.remove();
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

        this.toggleBtn = document.createElement('button');
        this.toggleBtn.className = 'ts-toggle';
        this.toggleBtn.title = 'Toggle timestamps';
        this.toggleBtn.textContent = '\u{1F552}';
        this.toggleBtn.addEventListener('click', () => {
            const turningOn = localStorage.getItem(STORE) === '0';
            localStorage.setItem(STORE, turningOn ? '1' : '0');
            this.applyVisibility();
        });
        document.body.appendChild(this.toggleBtn);
        this.applyVisibility();
    }

    private applyVisibility(): void {
        const on = localStorage.getItem(STORE) !== '0'; // default on
        this.terminal?.element?.classList.toggle('ts-on', on);
        this.toggleBtn?.classList.toggle('active', on);
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
        const top = term.buffer.active.viewportY;
        for (let i = 0; i < rows; i++) {
            const t = this.times.get(top + i);
            const span = this.rowEls[i].firstChild as HTMLElement;
            span.textContent = t ? this.fmt(t) : '';
        }
    }
}
