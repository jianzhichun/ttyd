import type { IBufferCell, IBufferLine, IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

// Wrapped-aware web links.
//
// The stock @xterm/addon-web-links only stitches SOFT-wrapped rows (isWrapped)
// when detecting a URL. But emitters that HARD-wrap (Ink / Claude Code and many
// TUIs insert a real '\n' at the wrap column) produce a continuation row with
// isWrapped === false, so a wrapped URL is seen as two unrelated rows and only
// the first row becomes clickable — clicking opens a truncated URL.
//
// This provider is identical to the stock one (same regex, same cell-accurate
// index→position mapping, so wide CJK/emoji glyphs still map correctly) EXCEPT
// it also treats a completely full row (a real glyph in the last column) as
// flowing into the next row. That captures hard-wrapped URLs in full while
// leaving soft-wrap behaviour unchanged.
//
// Known edge: if a URL ends EXACTLY at the last column and the next (hard) line
// begins with URL-legal characters and no leading space, the link can over-
// extend by that run. Rare in practice and judged acceptable.

// Default matcher — same as @xterm/addon-web-links (redundant escapes dropped).
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

const MAX_ROWS = 2048;

// Verbatim from @xterm/addon-web-links: reject matches whose protocol/host the
// URL parser would not round-trip (avoids false positives like "http://").
function isValidUrl(uri: string): boolean {
    try {
        const u = new URL(uri);
        let normalized = `${u.protocol}//`;
        if (u.username && u.password) normalized += `${u.username}:${u.password}@`;
        else if (u.username) normalized += `${u.username}@`;
        normalized += u.host;
        return uri.toLocaleLowerCase().startsWith(normalized.toLocaleLowerCase());
    } catch {
        return false;
    }
}

// Verbatim from @xterm/addon-web-links: map a string index within the joined
// logical line back to a buffer (line, col), counting cell widths so wide glyphs
// map correctly.
function mapStrIdx(terminal: Terminal, lineIndex: number, startCol: number, stringIndex: number): [number, number] {
    const buf = terminal.buffer.active;
    const cell = buf.getNullCell();
    let col = startCol;
    while (stringIndex) {
        const line = buf.getLine(lineIndex);
        if (!line) return [-1, -1];
        for (let i = col; i < line.length; ++i) {
            line.getCell(i, cell);
            const chars = cell.getChars();
            if (cell.getWidth()) {
                stringIndex -= chars.length || 1;
                if (i === line.length - 1 && chars === '') {
                    const next = buf.getLine(lineIndex + 1);
                    if (next && next.isWrapped) {
                        next.getCell(0, cell);
                        if (cell.getWidth() === 2) stringIndex += 1;
                    }
                }
            }
            if (stringIndex < 0) return [lineIndex, i];
        }
        lineIndex++;
        col = 0;
    }
    return [lineIndex, col];
}

// TUIs (Ink / Claude Code) often wrap one column EARLY — they avoid writing the
// last cell so the terminal's own autowrap never fires — so a hard-wrapped row's
// content can stop at cols-1 with the last cell blank. Tolerate that gap.
const EDGE_SLACK = 2;

// Visible content width of a row = column after its last non-blank cell.
function rowContentLen(line: IBufferLine, cols: number, cell: IBufferCell): number {
    for (let c = cols - 1; c >= 0; c--) {
        line.getCell(c, cell);
        if (cell.getWidth() !== 0 && cell.getChars() !== '') return c + 1;
    }
    return 0;
}

function startsNonSpace(line: IBufferLine, cell: IBufferCell): boolean {
    line.getCell(0, cell);
    const ch = cell.getChars();
    return ch !== '' && ch !== ' ';
}

// Does the row at `idx` flow into idx+1? True for soft wraps (next.isWrapped), and
// for hard-wrapped rows whose content runs to within EDGE_SLACK of the right edge
// and continue into a non-blank next row (covers emitters that wrap a column early).
function continuesDown(terminal: Terminal, idx: number, cell: IBufferCell): boolean {
    const buf = terminal.buffer.active;
    const next = buf.getLine(idx + 1);
    if (!next) return false;
    if (next.isWrapped) return true;
    const cur = buf.getLine(idx);
    if (!cur) return false;
    const len = rowContentLen(cur, terminal.cols, cell);
    return len > 0 && len >= terminal.cols - EDGE_SLACK && startsNonSpace(next, cell);
}

// Build the logical (possibly multi-row) line containing `lineIndex` and the index
// of its first row. Broadened vs the stock addon to also span hard-wrapped rows.
function getWindowedLineStrings(terminal: Terminal, lineIndex: number): [string[], number] {
    const buf = terminal.buffer.active;
    if (!buf.getLine(lineIndex)) return [[], lineIndex];
    const cell = buf.getNullCell();
    let top = lineIndex;
    let bottom = lineIndex;
    let guard = 0;
    while (top > 0 && guard++ < MAX_ROWS && continuesDown(terminal, top - 1, cell)) top--;
    guard = 0;
    while (guard++ < MAX_ROWS && continuesDown(terminal, bottom, cell)) bottom++;
    const strings: string[] = [];
    for (let i = top; i <= bottom; i++) {
        const line = buf.getLine(i);
        strings.push(line ? line.translateToString(true) : '');
    }
    return [strings, top];
}

function computeLinks(terminal: Terminal, lineNumber: number, handler: (e: MouseEvent, uri: string) => void): ILink[] {
    const rex = new RegExp(URL_REGEX.source, (URL_REGEX.flags || '') + 'g');
    const [strings, startLineIndex] = getWindowedLineStrings(terminal, lineNumber - 1);
    const line = strings.join('');
    const result: ILink[] = [];
    let match: RegExpExecArray | null;
    while ((match = rex.exec(line))) {
        const text = match[0];
        if (!isValidUrl(text)) continue;
        const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, match.index);
        const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length);
        if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;
        result.push({
            range: { start: { x: startX + 1, y: startY + 1 }, end: { x: endX, y: endY + 1 } },
            text,
            activate: handler,
        });
    }
    return result;
}

// Verbatim open behaviour from @xterm/addon-web-links (clears opener).
function openLink(_event: MouseEvent, uri: string): void {
    const win = window.open();
    if (win) {
        try {
            win.opener = null;
        } catch {
            /* noop */
        }
        win.location.href = uri;
    } else {
        console.warn('[ttyd] popup blocked, link not opened:', uri);
    }
}

export function registerWrappedWebLinks(
    terminal: Terminal,
    handler: (e: MouseEvent, uri: string) => void = openLink
): IDisposable {
    const provider: ILinkProvider = {
        provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
            const links = computeLinks(terminal, lineNumber, handler);
            callback(links.length ? links : undefined);
        },
    };
    return terminal.registerLinkProvider(provider);
}

// Exported for unit testing only (no runtime dependency on the DOM).
export const __test = { computeLinks, getWindowedLineStrings };
