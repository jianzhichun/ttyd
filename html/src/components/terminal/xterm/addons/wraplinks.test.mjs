// Run: node --experimental-strip-types wraplinks.test.mjs
import assert from 'node:assert/strict';
import { __test } from './wraplinks.ts';

const { computeLinks } = __test;
const noop = () => {};

function makeCell() {
    return { _chars: '', _width: 1, getChars() { return this._chars; }, getWidth() { return this._width; } };
}

// rowSpecs: [{ text, wrapped }]. Rows are `cols` wide; cells past text are blanks.
function makeTerminal(rowSpecs, cols) {
    const lines = rowSpecs.map(spec => ({
        isWrapped: spec.wrapped,
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
        buffer: {
            active: {
                getLine(i) { return i >= 0 && i < lines.length ? lines[i] : undefined; },
                getNullCell() { return makeCell(); },
            },
        },
    };
}

let passed = 0;
function check(name, cond) {
    assert.ok(cond, name);
    passed++;
    console.log('  ok  ' + name);
}

// Case 1: HARD-wrapped URL (continuation row NOT isWrapped). cols=20, row0 is full.
{
    const t = makeTerminal([{ text: 'https://example.com/', wrapped: false }, { text: 'foo/bar', wrapped: false }], 20);
    const full = 'https://example.com/foo/bar';
    const a = computeLinks(t, 1, noop); // query first row
    const b = computeLinks(t, 2, noop); // query continuation row
    check('hard-wrap: one link from row 1', a.length === 1 && a[0].text === full);
    check('hard-wrap: link spans rows 1..2', a[0].range.start.y === 1 && a[0].range.end.y === 2);
    check('hard-wrap: continuation row yields same full link', b.length === 1 && b[0].text === full);
}

// Case 2: SOFT-wrapped URL (regression — must still work).
{
    const t = makeTerminal([{ text: 'https://example.com/', wrapped: false }, { text: 'foo/bar', wrapped: true }], 20);
    const full = 'https://example.com/foo/bar';
    const a = computeLinks(t, 1, noop);
    check('soft-wrap: one full link spanning two rows', a.length === 1 && a[0].text === full && a[0].range.end.y === 2);
}

// Case 3: full row that is NOT a URL must not create a false link when merged.
{
    const t = makeTerminal([{ text: 'abcdefghijklmnopqrst', wrapped: false }, { text: 'uvwxyz', wrapped: false }], 20);
    check('no false link on non-URL full row', computeLinks(t, 1, noop).length === 0);
}

// Case 4: URL that ends mid-row must NOT merge into the next (hard) line.
{
    const t = makeTerminal([{ text: 'https://a.co/x', wrapped: false }, { text: 'next', wrapped: false }], 20);
    const a = computeLinks(t, 1, noop);
    check('mid-row URL not over-merged', a.length === 1 && a[0].text === 'https://a.co/x' && a[0].range.end.y === 1);
}

// Case 5: HARD wrap that wraps ONE COLUMN EARLY (row0 content = cols-1, last cell blank).
{
    const t = makeTerminal([{ text: 'https://example.com', wrapped: false }, { text: '/foo/bar', wrapped: false }], 20);
    const full = 'https://example.com/foo/bar';
    const a = computeLinks(t, 1, noop);
    const b = computeLinks(t, 2, noop);
    check('1-col-early: row 1 yields full link spanning 2 rows', a.length === 1 && a[0].text === full && a[0].range.end.y === 2);
    check('1-col-early: continuation row yields same full link', b.length === 1 && b[0].text === full);
}

console.log(`\n${passed} checks passed`);
