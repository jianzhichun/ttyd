// Detection layer for TeX math in terminal output — pure functions over the
// viewport's row texts, no DOM/xterm dependency (unit-tested via
// `node --experimental-strip-types texmath.test.mjs`).
//
// A terminal is a hostile place for math delimiters: $VAR, awk '$1', shell's
// $$ (PID), regex \(...\) all look like TeX. Every candidate therefore passes
// three gates before it becomes a span:
//   1. character blacklist — tmux pane borders / CC box drawing, backticks,
//      URLs, code-y operators (==, &&, ||) never appear in real formulas;
//   2. a math-signal heuristic — single-$ spans (the riskiest delimiter) need
//      a STRONG signal (a \command or ^/_ script); explicit delimiters
//      ($$ \[ \() accept any math-ish character;
//   3. the injected `validate` callback (KaTeX throwOnError parse in the
//      addon) — what KaTeX can't parse is never rendered.
// A candidate failing any gate is left as-is on screen — false negatives are
// invisible, false positives would repaint prose as garbage math.

export interface InlineSpan {
    kind: 'inline';
    row: number; // viewport row index
    i0: number; // char index (in the row's trimmed text) of the span start, delimiters included
    i1: number; // char index one past the span end
    tex: string;
    display: boolean; // $$/\[ span → displayMode typesetting
}

export interface BlockSpan {
    kind: 'block';
    r0: number; // rows of the opening/closing bare delimiter lines
    r1: number;
    tex: string;
}

export type MathSpan = InlineSpan | BlockSpan;

// (tex, displayMode) → is this actually renderable math? The addon backs this
// with a caching KaTeX parse; tests can inject anything.
export type TexValidator = (tex: string, display: boolean) => boolean;

const MAX_TEX_LEN = 400;
const MAX_BLOCK_ROWS = 12; // a bare-$$ block taller than this is not a formula

// Never-in-math characters: box drawing (tmux borders, CC's input box), block
// elements (progress bars), backtick, tab, and URL separators.
const BAD_CHARS = /[`\t─-╿▀-▟]|:\/\//;
// Code, not math: ==, &&, ||, ->, => (TeX arrows are \to / \Rightarrow).
const CODE_OPS = /==|&&|\|\||->|=>/;
// A real TeX command (2+ letters, so \n-ish escapes don't count) or a script.
const STRONG = /\\[a-zA-Z]{2,}|[\^_]/;
// Any math-ish character at all — rejects pure prose like "$$ of shell $$".
const WEAK = /[\\{}=<>+\-*/]|\d/;

export function texCandidate(tex: string, single: boolean): boolean {
    const t = tex.trim();
    if (t.length < 1 || t.length > MAX_TEX_LEN) return false;
    if (BAD_CHARS.test(t) || CODE_OPS.test(t)) return false;
    return single ? STRONG.test(t) : STRONG.test(t) || WEAK.test(t);
}

// Inline spans within one row, in match order:
//   $$...$$   \[...\]   \(...\)   $...$
// Single-$ content may not start/end with whitespace ("costs $5 and $10 more"
// must not pair across words); explicit delimiters are more trusting.
const SPAN_RE = /\$\$(.+?)\$\$|\\\[(.+?)\\\]|\\\((.+?)\\\)|\$([^$\s](?:[^$]*[^$\s])?)\$/g;

function detectRowSpans(text: string, row: number, validate: TexValidator, out: MathSpan[]): void {
    SPAN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPAN_RE.exec(text))) {
        const tex = m[1] ?? m[2] ?? m[3] ?? m[4];
        const single = m[4] !== undefined;
        const display = m[1] !== undefined || m[2] !== undefined;
        if (texCandidate(tex, single) && validate(tex.trim(), false)) {
            out.push({ kind: 'inline', row, i0: m.index, i1: m.index + m[0].length, tex: tex.trim(), display });
        } else {
            // Rejected — the opening delimiter may still pair with a LATER one
            // ("I paid $5. Then $x^2$ appeared": the $5…$ candidate dies, but
            // $x^2$ must survive), so resume right after the opening char.
            SPAN_RE.lastIndex = m.index + 1;
        }
    }
}

// Multi-row display blocks: a row that is exactly "$$" (or "\[") opens a
// block, the matching bare closer ends it, body rows joined by newline.
// Claude Code prints display math this way; the bare-delimiter requirement is
// what keeps this pass high-confidence.
export function detectSpans(rows: string[], validate: TexValidator): MathSpan[] {
    const spans: MathSpan[] = [];
    const inBlock: boolean[] = new Array(rows.length).fill(false);

    for (let r = 0; r < rows.length; r++) {
        const t = rows[r].trim();
        if (t !== '$$' && t !== '\\[') continue;
        const close = t === '$$' ? '$$' : '\\]';
        const last = Math.min(r + MAX_BLOCK_ROWS, rows.length - 1);
        for (let e = r + 1; e <= last; e++) {
            if (rows[e].trim() !== close) continue;
            const body = rows
                .slice(r + 1, e)
                .map(s => s.trim())
                .join('\n')
                .trim();
            if (body && texCandidate(body, false) && validate(body, true)) {
                spans.push({ kind: 'block', r0: r, r1: e, tex: body });
                for (let i = r; i <= e; i++) inBlock[i] = true;
                r = e;
            }
            break; // matched closer (rendered or not) — don't scan further down
        }
    }

    for (let r = 0; r < rows.length; r++) {
        if (!inBlock[r] && rows[r].length > 3) detectRowSpans(rows[r], r, validate, spans);
    }
    return spans;
}

// Exported for unit testing only.
export const __test = { texCandidate, detectRowSpans };
