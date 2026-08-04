// Minimal, SAFE markdown -> HTML for notification bodies. Display-only and
// short, so a focused subset beats pulling in marked+DOMPurify (no deps, no
// bundle growth). HTML is escaped FIRST; the only tags in the output are the
// ones these rules emit, so it is safe to bind via dangerouslySetInnerHTML.
//
// Supports: #/##/### headings, `- ` / `* ` / `• ` bullets, `1. ` numbered
// lists, fenced ``` blocks, GFM pipe tables, paragraphs, `inline code`,
// **bold**, *italic*, _italic_, and [text](https://...) links (http(s) only —
// no javascript:/data:).

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Inline rules applied to already-escaped text. Order: code first (so its
// contents aren't further mangled by bold/italic), then links, then emphasis.
function inline(s: string): string {
    return (
        s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(
                /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
            )
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            /******** italic: single * or _ not part of ** / word-internal _ ******/
            .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
            .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    );
}

// GFM table support. A table is a header row immediately followed by a
// `|---|` delimiter row, then zero or more `|`-separated body rows. The
// delimiter is the trigger: a stray `|` in prose never starts a table, because
// the line AFTER it must be the dash/pipe rule. Requiring a `|` (and a `-`)
// in the delimiter keeps a setext-heading underline (`---` under one line of
// text) from false-triggering.
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableDelim = (ln: string): boolean => TABLE_DELIM.test(ln) && ln.includes('|') && /-/.test(ln);

// Strip the optional outer pipes, split on `|`, trim each cell.
const splitRow = (ln: string): string[] =>
    ln
        .trim()
        .replace(/^\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(c => c.trim());

// `:---` left, `---:` right, `:---:` center, `---` default (no style).
const alignOf = (cell: string): '' | 'left' | 'right' | 'center' => {
    const t = cell.trim();
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
};

export function renderMd(input: string): string {
    if (!input) return '';
    const raw = input.replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const out: string[] = [];
    let i = 0;
    let para: string[] = [];

    const flushPara = () => {
        if (para.length) {
            out.push('<p>' + inline(esc(para.join('\n')).replace(/\n/g, '<br>')) + '</p>');
            para = [];
        }
    };

    while (i < lines.length) {
        const line = lines[i];
        const escLine = esc(line);

        // fenced code block ```lang ... ```
        const fence = line.match(/^```(.*)$/);
        if (fence) {
            flushPara();
            const code: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) {
                code.push(esc(lines[i]));
                i++;
            }
            i++; // skip closing fence
            out.push('<pre><code>' + code.join('\n') + '</code></pre>');
            continue;
        }

        // GFM table: current line is the header, next line the `|---|` rule.
        // Body rows run until a blank line or a line without a `|`.
        if (i + 1 < lines.length && line.includes('|') && isTableDelim(lines[i + 1])) {
            flushPara();
            const aligns = splitRow(lines[i + 1]).map(alignOf);
            const cell = (text: string, idx: number, tag: 'th' | 'td'): string => {
                const a = aligns[idx];
                return `<${tag}${a ? ` style="text-align:${a}"` : ''}>${inline(esc(text))}</${tag}>`;
            };
            const header = splitRow(line)
                .map((c, idx) => cell(c, idx, 'th'))
                .join('');
            i += 2;
            const rows: string[] = [];
            while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
                rows.push(
                    '<tr>' +
                        splitRow(lines[i])
                            .map((c, idx) => cell(c, idx, 'td'))
                            .join('') +
                        '</tr>'
                );
                i++;
            }
            out.push(`<table><thead><tr>${header}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
            continue;
        }

        const h = escLine.match(/^#{1,3}\s+(.*)$/);
        if (h) {
            flushPara();
            const n = line.match(/^#+/)![0].length;
            out.push(`<h${n}>${inline(h[1])}</h${n}>`);
            i++;
            continue;
        }

        const ul = escLine.match(/^\s*[-*•]\s+(.*)$/);
        if (ul) {
            flushPara();
            const items: string[] = [];
            while (i < lines.length) {
                const m = esc(lines[i]).match(/^\s*[-*•]\s+(.*)$/);
                if (!m) break;
                items.push('<li>' + inline(m[1]) + '</li>');
                i++;
            }
            out.push('<ul>' + items.join('') + '</ul>');
            continue;
        }

        const ol = escLine.match(/^\s*\d+\.\s+(.*)$/);
        if (ol) {
            flushPara();
            const items: string[] = [];
            while (i < lines.length) {
                const m = esc(lines[i]).match(/^\s*\d+\.\s+(.*)$/);
                if (!m) break;
                items.push('<li>' + inline(m[1]) + '</li>');
                i++;
            }
            out.push('<ol>' + items.join('') + '</ol>');
            continue;
        }

        if (line.trim() === '') {
            flushPara();
            i++;
            continue;
        }
        para.push(line);
        i++;
    }
    flushPara();
    return out.join('');
}
