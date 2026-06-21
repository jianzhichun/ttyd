// Run: node --experimental-strip-types media.test.mjs
import assert from 'node:assert/strict';
import { classifyMedia, MediaStore } from './media.ts';
import { scanBufferUrls } from '../terminal/xterm/addons/wraplinks.ts';

let passed = 0;
function check(name, cond) {
    assert.ok(cond, name);
    passed++;
    console.log('  ok  ' + name);
}

// ---- classifyMedia ---------------------------------------------------------
{
    const img = classifyMedia('https://media.internal/workspace/assets/foo.png');
    check('media image -> image', img && img.kind === 'image' && img.name === 'foo.png');

    check('media video -> video', classifyMedia('https://media.internal/a/clip.mp4')?.kind === 'video');
    check('media audio -> audio', classifyMedia('https://media.internal/a/song.flac')?.kind === 'audio');
    check('media pdf   -> pdf', classifyMedia('https://media.internal/a/doc.pdf')?.kind === 'pdf');
    check('notes md    -> note', classifyMedia('https://notes.internal/infra/README.md')?.kind === 'note');
    check('notes any path -> note', classifyMedia('https://notes.internal/some/dir')?.kind === 'note');

    check('office rejected', classifyMedia('https://office.internal/files/x.docx') === null);
    check('code rejected', classifyMedia('https://code.internal/?folder=/home/dev') === null);
    check('external image rejected', classifyMedia('https://example.com/x.png') === null);
    check('media non-media ext rejected', classifyMedia('https://media.internal/x.txt') === null);
    check('garbage rejected', classifyMedia('not a url') === null);

    const enc = classifyMedia('https://media.internal/a/hello%20world.png');
    check('name is percent-decoded', enc && enc.name === 'hello world.png');

    const ts = classifyMedia('https://media.internal/a/pic.gif/');
    check('trailing slash tolerated', ts && ts.kind === 'image' && ts.name === 'pic.gif');
}

// ---- MediaStore.setUrls (live current-screen view) -------------------------
{
    const s = new MediaStore();
    s.setUrls(['https://media.internal/a/foo.png']);
    check('setUrls collects a media link', s.getItems().length === 1 && s.getItems()[0].kind === 'image');

    // replace: only media/notes kept, in screen order
    s.setUrls([
        'https://office.internal/x.docx',
        'https://media.internal/a/b.png',
        'https://notes.internal/c.md',
    ]);
    check(
        'setUrls filters + preserves order',
        s.getItems().length === 2 && s.getItems()[0].kind === 'image' && s.getItems()[1].kind === 'note'
    );

    // replace with all-non-media empties (it tracks the current screen, no history)
    s.setUrls(['https://office.internal/x.docx']);
    check('setUrls keeps only current media', s.getItems().length === 0);
}

{
    // emits only on change (per-render scans of unchanged content are free)
    const s = new MediaStore();
    let fires = 0;
    const off = s.subscribe(() => fires++);
    s.setUrls(['https://media.internal/1.png', 'https://media.internal/2.png']);
    check('preserves screen order', s.getItems()[0].name === '1.png' && s.getItems()[1].name === '2.png');
    check('fires on change', fires === 1);
    s.setUrls(['https://media.internal/1.png', 'https://media.internal/2.png']); // unchanged
    check('no fire when unchanged', fires === 1);
    s.setUrls([]); // scrolled away
    check('empties when nothing on screen', s.getItems().length === 0);
    check('fires on empty', fires === 2);
    off();
}

// ---- scanBufferUrls: hard-wrapped URLs stitched whole ----------------------
function makeCell() {
    return { _chars: '', _width: 1, getChars() { return this._chars; }, getWidth() { return this._width; } };
}
function makeTerminal(rowSpecs, cols) {
    const lines = rowSpecs.map(spec => ({
        isWrapped: !!spec.wrapped,
        length: cols,
        getCell(i, cell) {
            if (i < spec.text.length) { cell._chars = spec.text[i]; cell._width = 1; }
            else { cell._chars = ''; cell._width = 1; }
            return cell;
        },
        translateToString(trimRight) {
            return trimRight ? spec.text : spec.text.padEnd(cols, ' ');
        },
    }));
    return {
        cols,
        rows: lines.length,
        buffer: {
            active: {
                baseY: 0,
                getLine(i) { return i >= 0 && i < lines.length ? lines[i] : undefined; },
                getNullCell() { return makeCell(); },
            },
        },
    };
}

{
    // A hard-wrapped media URL (continuation row NOT isWrapped, row0 full) — the
    // raw-stream killer that scanBufferUrls must stitch back from the grid.
    const t = makeTerminal(
        [
            { text: 'out https://media.intern', wrapped: false }, // hard wrap at col 24
            { text: 'al/a/foo.png done', wrapped: false },
            { text: 'https://media.internal/a/foo.png', wrapped: false }, // duplicate, whole
        ],
        24
    );
    const urls = scanBufferUrls(t);
    check('scan stitches hard-wrapped URL', urls.includes('https://media.internal/a/foo.png'));
    check('scan dedupes repeats', urls.filter(u => u === 'https://media.internal/a/foo.png').length === 1);

    // end-to-end: scanned URLs into the store yield one image
    const s = new MediaStore();
    s.setUrls(urls);
    check('scan -> store yields one image', s.getItems().length === 1 && s.getItems()[0].kind === 'image');
}

{
    // Regression (badge showed 1/5) + ADAPTIVITY across phones: in a Claude Code
    // message a long URL wraps with a left indent, each wrapped row fills to the
    // grid edge, and CONTINUATION rows carry the same indent (verified via capture-
    // pane). scanBufferUrls must treat a full row as wrapped and strip the
    // continuation indent before joining — using the LIVE grid width and stripping
    // ANY indent, so it keeps working at any terminal width / message indent.
    const longUrls = [
        'https://media.internal/workspace/assets/drawer-current.png',
        'https://media.internal/workspace/playwright-talk/videos/ops-04-feishu.mp4',
        'https://notes.internal/infra/README.md',
    ];
    const wrapInto = (urls, cols, indent) => {
        const W = cols - indent.length;
        const specs = [];
        for (const u of urls)
            for (let i = 0; i < u.length; i += W) specs.push({ text: indent + u.slice(i, i + W), wrapped: false });
        specs.push({ text: '─'.repeat(cols), wrapped: false }); // full-width chrome row
        return specs;
    };
    for (const [cols, indent] of [
        [30, ''],
        [41, '  '],
        [45, '  '],
        [60, '    '],
        [80, '   '],
    ]) {
        const got = scanBufferUrls(makeTerminal(wrapInto(longUrls, cols, indent), cols));
        check(`adapts @ cols=${cols} indent=${indent.length}`, got.length === 3 && longUrls.every(u => got.includes(u)));
    }

    // A 43-char URL fills a 45-col row exactly (indent 2) right before another URL —
    // must stay TWO links, not merge into one garbage string.
    const A = 'https://media.internal/aaaaaaaaaaaaaaaa.png'; // 43 chars
    const B = 'https://notes.internal/x.md';
    const got2 = scanBufferUrls(makeTerminal([{ text: '  ' + A }, { text: '  ' + B }], 45));
    check('exact-fill URL not merged with next', got2.includes(A) && got2.includes(B));
}

console.log(`\n${passed} checks passed`);
