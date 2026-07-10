// TeX math overlay — renders LaTeX formulas in Claude Code (and any) output as
// real typeset math, IN PLACE, without touching the character grid.
//
// Iron rule: the xterm buffer, tmux, and the PTY byte stream are never
// modified. This is a pure display layer: detected spans get (a) opaque
// background masks over exactly the cells the raw TeX source occupies (so a
// shorter rendered formula doesn't leave source text peeking out), and (b) a
// KaTeX-rendered element scaled to EXACTLY the span's row height — a span
// occupying N rows renders N rows tall, never more — so no other output ever
// moves or resizes. Selection/copy still yields the raw TeX source (the layer
// is pointer-events: none).
//
// Repaint model mirrors timestamps.ts: tmux repaints arbitrarily (scroll,
// window switch, reconnect), so no marker tracking — every (throttled)
// onRender rescans the viewport and rebuilds the overlay from scratch.
// ttyd runs scrollback=0, so the buffer IS the viewport (≤ ~60 rows).
//
// Deliberate v1 limits: a formula hard-wrapped MID-SPAN across rows is left as
// raw text (only whole-on-one-row inline spans and bare-$$ blocks render), and
// spans on the cursor row or under a selection are skipped (you must be able
// to see what you're editing/selecting).
import { IBufferCell, IBufferLine, IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import katex from 'katex';
import 'katex/dist/katex.min.css';

import { detectSpans } from './texmath-detect';

const STYLE_ID = 'texmath-style';
// onRender fires every frame while CC streams; the overlay only needs to feel
// live, so cap rebuilds (same cadence reasoning as the timestamp gutter).
const THROTTLE_MS = 150;
const CACHE_MAX = 300;
// Base font the formula is typeset at before being measured and scaled down to
// its box. Big enough that the scale is always < 1 (crisp), small enough that
// measuring stays cheap.
const BASE_PX = 64;

const CSS = `
.texmath-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:8}
.texmath-layer .texmath-mask{position:absolute}
.texmath-layer .texmath-box{position:absolute;transform-origin:0 0;font-size:${BASE_PX}px;line-height:normal;white-space:nowrap}
`;

export class TexMathAddon implements ITerminalAddon {
    private terminal?: Terminal;
    private disposables: IDisposable[] = [];
    private layer?: HTMLDivElement;
    private enabled = true;
    // tex+mode → KaTeX html, or null for "KaTeX can't parse this" — failures
    // are cached too, so a bad candidate isn't re-parsed on every repaint.
    private cache = new Map<string, string | null>();
    private rafId = 0;
    private throttleId = 0;
    private lastPaint = 0;

    public activate(terminal: Terminal): void {
        this.terminal = terminal;
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        this.disposables.push(terminal.onRender(() => this.schedule()));
        // Selection must reveal the raw TeX under it → repaint promptly.
        this.disposables.push(terminal.onSelectionChange(() => this.schedule(true)));
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        if (this.rafId) cancelAnimationFrame(this.rafId);
        if (this.throttleId) window.clearTimeout(this.throttleId);
        this.layer?.remove();
        document.getElementById(STYLE_ID)?.remove();
    }

    public setEnabled(on: boolean): void {
        this.enabled = on;
        if (!on) this.layer?.replaceChildren();
        else this.schedule(true);
    }

    private schedule(immediate = false): void {
        if (immediate) {
            if (this.throttleId) {
                window.clearTimeout(this.throttleId);
                this.throttleId = 0;
            }
            this.scheduleRaf();
            return;
        }
        if (this.rafId || this.throttleId) return;
        const since = performance.now() - this.lastPaint;
        if (since >= THROTTLE_MS) {
            this.scheduleRaf();
        } else {
            this.throttleId = window.setTimeout(() => {
                this.throttleId = 0;
                this.scheduleRaf();
            }, THROTTLE_MS - since);
        }
    }

    private scheduleRaf(): void {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            this.lastPaint = performance.now();
            this.paint();
        });
    }

    private htmlFor(tex: string, display: boolean): string | null {
        const key = (display ? 'D' : 'I') + tex;
        const hit = this.cache.get(key);
        if (hit !== undefined) return hit;
        let html: string | null = null;
        try {
            html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: false });
        } catch {
            html = null;
        }
        if (this.cache.size >= CACHE_MAX) this.cache.clear();
        this.cache.set(key, html);
        return html;
    }

    private paint(): void {
        const term = this.terminal;
        if (!term?.element) return;
        if (!this.layer) {
            const screen = term.element.querySelector('.xterm-screen') as HTMLElement | null;
            if (!screen) return;
            this.layer = document.createElement('div');
            this.layer.className = 'texmath-layer';
            screen.appendChild(this.layer);
        }
        this.layer.replaceChildren();
        if (!this.enabled) return;

        const screen = this.layer.parentElement as HTMLElement;
        const rows = term.rows;
        const cols = term.cols;
        const cw = screen.clientWidth / cols;
        const ch = screen.clientHeight / rows;
        if (!cw || !ch) return;

        const buf = term.buffer.active;
        const lines: (IBufferLine | undefined)[] = [];
        const texts: string[] = [];
        for (let r = 0; r < rows; r++) {
            const line = buf.getLine(buf.viewportY + r);
            lines.push(line);
            texts.push(line ? line.translateToString(true) : '');
        }

        const spans = detectSpans(texts, (tex, display) => this.htmlFor(tex, display) !== null);
        if (!spans.length) return;

        // Don't render over the row being edited (cursor would vanish under the
        // overlay) or under an active selection (raw TeX must be selectable
        // visibly). tmux has one cursor — the active pane's.
        const cursorRow = buf.baseY + buf.cursorY - buf.viewportY;
        const sel = term.getSelectionPosition();
        const selR0 = sel ? sel.start.y - buf.viewportY : -1;
        const selR1 = sel ? sel.end.y - buf.viewportY : -1;

        const theme = term.options.theme ?? {};
        const style = getComputedStyle(term.element);
        const bg = theme.background ?? style.backgroundColor;
        const fg = theme.foreground ?? style.color;
        this.layer.style.color = fg;

        const cell = buf.getNullCell();
        const frag = document.createDocumentFragment();
        for (const span of spans) {
            const r0 = span.kind === 'inline' ? span.row : span.r0;
            const r1 = span.kind === 'inline' ? span.row : span.r1;
            if (cursorRow >= r0 && cursorRow <= r1) continue;
            if (sel && selR0 <= r1 && selR1 >= r0) continue;

            const html = this.htmlFor(span.tex, span.kind === 'block');
            if (html === null) continue; // cache-cap eviction race; skip

            // Masks: cover exactly the cells the raw TeX occupies, row by row.
            let x0 = Infinity;
            let x1 = -Infinity;
            for (let r = r0; r <= r1; r++) {
                const line = lines[r];
                if (!line) continue;
                const map = colMap(line, cols, cell);
                const text = texts[r];
                let a: number;
                let b: number;
                if (span.kind === 'inline') {
                    a = map[Math.min(span.i0, map.length - 1)];
                    b = map[Math.min(span.i1, map.length - 1)];
                } else {
                    const indent = text.length - text.trimStart().length;
                    a = map[Math.min(indent, map.length - 1)];
                    b = map[Math.min(text.length, map.length - 1)];
                }
                if (b <= a) continue;
                x0 = Math.min(x0, a);
                x1 = Math.max(x1, b);
                const mask = document.createElement('div');
                mask.className = 'texmath-mask';
                mask.style.background = bg;
                // Pad 1.5px outward: glyphs are drawn with slight antialiased
                // overhang past their cell box, and an exact-fit mask leaves
                // those edges peeking out as stray dots.
                mask.style.left = `${a * cw - 1.5}px`;
                mask.style.top = `${r * ch}px`;
                mask.style.width = `${(b - a) * cw + 3}px`;
                mask.style.height = `${ch}px`;
                frag.appendChild(mask);
            }
            if (x1 <= x0) continue;

            const box = document.createElement('div');
            box.className = 'texmath-box';
            box.innerHTML = html;
            frag.appendChild(box);
            // Measure at BASE_PX, then scale so the formula's height is EXACTLY
            // the span's row height (and never wider than the raw source).
            this.layer.appendChild(frag);
            const w = box.offsetWidth;
            const h = box.offsetHeight;
            if (!w || !h) {
                box.remove();
                continue;
            }
            const boxW = (x1 - x0) * cw;
            const boxH = (r1 - r0 + 1) * ch;
            const s = Math.min(boxH / h, boxW / w);
            // block math centers in its box; inline left-aligns at the source
            const dx = span.kind === 'block' ? (boxW - w * s) / 2 : 0;
            const dy = (boxH - h * s) / 2;
            box.style.transform = `translate(${x0 * cw + dx}px, ${r0 * ch + dy}px) scale(${s})`;
        }
        this.layer.appendChild(frag);
    }
}

// string index (as produced by translateToString) → grid column. Wide CJK
// glyphs occupy 2 columns but 1 string char, so a formula after Chinese prose
// needs cell-accurate mapping. map[i] = column where string index i begins;
// length = text length + 1 (map[len] = column after the last char).
function colMap(line: IBufferLine, cols: number, cell: IBufferCell): number[] {
    const map: number[] = [0];
    let idx = 0;
    for (let c = 0; c < cols; c++) {
        line.getCell(c, cell);
        const w = cell.getWidth();
        if (w === 0) continue; // trailing half of a wide glyph
        idx += cell.getChars().length || 1; // blank cell = one ' '
        map[idx] = c + w;
    }
    // Multi-char grapheme cells leave holes — backfill with the previous boundary.
    let last = 0;
    for (let i = 0; i < map.length; i++) {
        if (map[i] === undefined) map[i] = last;
        else last = map[i];
    }
    return map;
}
