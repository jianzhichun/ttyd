// Run: node --experimental-strip-types texmath.test.mjs
import assert from 'node:assert/strict';
import katex from 'katex';
import { detectSpans, texCandidate } from './texmath-detect.ts';

// The same validator the addon uses: KaTeX throwOnError parse.
const validate = (tex, display) => {
    try {
        katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: false });
        return true;
    } catch {
        return false;
    }
};

let passed = 0;
function check(name, cond) {
    assert.ok(cond, name);
    passed++;
    console.log('  ok  ' + name);
}

const spansOf = rows => detectSpans(rows, validate);

// ---- real formulas must render -------------------------------------------
{
    const s = spansOf(['  The energy is $E = mc^2$ as shown.']);
    check('inline $E = mc^2$ detected', s.length === 1 && s[0].tex === 'E = mc^2');
    check('inline span indices cover delimiters', s[0].i0 === 16 && s[0].i1 === 26);

    check('\\(...\\) detected', spansOf(['  where \\(\\alpha + \\beta = 1\\) holds']).length === 1);
    check('$$...$$ single-line detected', spansOf(['$$\\frac{a}{b}$$']).length === 1);
    check('\\[...\\] single-line detected', spansOf(['\\[x^2 + y^2 = z^2\\]']).length === 1);
    check('complexity $O(n \\log n)$ detected', spansOf(['sort is $O(n \\log n)$ at best']).length === 1);
    check('subscript $x_i$ detected', spansOf(['sum over $x_i$ terms']).length === 1);

    const block = spansOf(['  $$', '  \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '  $$']);
    check('bare-$$ block detected', block.length === 1 && block[0].kind === 'block');
    check('block rows span delimiters', block[0].r0 === 0 && block[0].r1 === 2);

    const blk2 = spansOf(['\\[', '  \\int_0^\\infty e^{-x} dx = 1', '\\]']);
    check('bare-\\[ block detected', blk2.length === 1 && blk2[0].kind === 'block');

    const multi = spansOf(['both $a^2$ and $b_1$ here']);
    check('two inline spans on one row', multi.length === 2);

    const rescue = spansOf(['I paid $5. Then $x^2$ appeared']);
    check('rejected $ pairs with later $ (rescue scan)', rescue.length === 1 && rescue[0].tex === 'x^2');

    // markdown table cell: the span itself is clean math between borders
    const cell = spansOf(['│ $x^2$ │ note']);
    check('math inside table borders renders', cell.length === 1 && cell[0].tex === 'x^2');
}

// ---- shell/terminal corrosion corpus must NOT render ----------------------
{
    const corpus = [
        'export PATH=$PATH:$HOME/bin', // env vars
        "awk '$1 == $2 { print $3 }' file", // awk fields
        'echo $$ $PPID', // shell PID
        'costs $5 and $10 later', // prices
        "grep '\\(foo\\)' bar.txt", // BRE groups
        "sed 's/\\(a\\)/\\1/' f", // sed backrefs
        'kill -9 $PID; echo $?', // specials
        'if [ $# -gt 0 ]; then', // positional count
        'make CFLAGS="-O2 -g" $@', // make vars
        'A -> B => C', // code arrows
        'x == y && a || b', // code ops
        'curl https://a.b/$id', // URL
        'left $a^2 │ other pane b$', // span crossing a tmux pane border
        'progress ▓▓▓░░ 60%', // block elements
        'PS1="\\u@\\h $ "', // prompt def
        'price is $100', // unpaired $
        'var= $((x + 1))', // arithmetic expansion (no strong signal)
    ];
    for (const line of corpus) {
        const s = spansOf([line]);
        check(`no span in: ${line}`, s.length === 0);
    }
}

// ---- heuristic unit checks -------------------------------------------------
{
    check('single-$ needs a strong signal', !texCandidate('5 and ', true));
    check('single-$ accepts \\command', texCandidate('\\alpha', true));
    check('single-$ accepts scripts', texCandidate('x^2', true));
    check('explicit delim accepts weak signal', texCandidate('a + b', false));
    check('explicit delim rejects pure prose', !texCandidate('of shell', false));
    check('rejects tmux border char', !texCandidate('x │ y', false));
    check('rejects backtick', !texCandidate('`code`', false));
    check('rejects overlong', !texCandidate('x'.repeat(500), false));
    check('rejects ==', !texCandidate('a == b', false));
}

// ---- KaTeX gate ------------------------------------------------------------
{
    check('unparseable TeX rejected', spansOf(['see $x^{$ broken']).length === 0);
    const s = spansOf(['\\(\\frac{1}{2}\\)']);
    check('parseable TeX kept', s.length === 1);
}

// ---- block edge cases -------------------------------------------------------
{
    check('unclosed $$ block ignored', spansOf(['$$', 'x + y']).length === 0);
    check(
        'block taller than cap ignored',
        spansOf(['$$', ...Array(14).fill('x'), '$$']).length === 0
    );
    const empty = spansOf(['$$', '$$']);
    check('empty block ignored', empty.length === 0);
    // inline scan must not re-detect rows consumed by a block
    const noDouble = spansOf(['$$', 'a^2 + b^2 = c^2', '$$']);
    check('block rows not double-detected', noDouble.length === 1);
}

console.log(`\nAll ${passed} checks passed.`);
