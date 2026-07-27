// Minimal, SAFE markdown -> HTML for notification bodies. Display-only and
// short, so a focused subset beats pulling in marked+DOMPurify (no deps, no
// bundle growth). HTML is escaped FIRST; the only tags in the output are the
// ones these rules emit, so it is safe to bind via dangerouslySetInnerHTML.
//
// Supports: #/##/### headings, `- ` / `* ` / `• ` bullets, `1. ` numbered
// lists, fenced ``` blocks, paragraphs, `inline code`, **bold**, *italic*,
// _italic_, and [text](https://...) links (http(s) only — no javascript:/data:).

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
