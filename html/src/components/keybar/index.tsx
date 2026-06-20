import { h, Component } from 'preact';

export type Mod = 'ctrl' | 'prefix';

interface Props {
    onKey: (data: string, blur?: boolean, focus?: boolean) => void;
    onMod: (mod: Mod) => void;
    onUpload: () => void;
    armed: '' | Mod;
}

interface Key {
    label: string;
    seq?: string;
    act?: 'upload';
    mod?: Mod;
    blur?: boolean;
    focus?: boolean;
}

// Uniform 7-per-row grid, equal-width full-size cells, long labels truncated.
// 10 function keys + a proper arrow cross (↑ above ↓, ← ↓ → on the bottom row)
// = exactly 2 rows of 7. Each arrow is a full cell (easy to tap). Arrows are
// placed explicitly (CSS grid-area); the function keys auto-flow into the rest.
// Prev-window dropped as a dedicated key — still reachable via the sticky ^B
// then p. (No Spc/⌨: native kbd has space, tapping the terminal summons it.
// Scrollback scrolling is done by swiping — see Terminal.setupTouch.)
// Source order = auto-flow fill order. Row 1: Esc Tab ⇧⇥ / @ (then ↑ 📎 placed
// explicitly); row 2: ^C Ctrl ^B ^Bn (then ← ↓ → placed explicitly).
const FUNC: Key[] = [
    { label: 'Esc', seq: '\x1b' },
    { label: 'Tab', seq: '\t' },
    { label: '⇧⇥', seq: '\x1b[Z' },
    // / and @ start a slash-command / @-mention you keep typing → summon keyboard
    { label: '/', seq: '/', focus: true },
    { label: '@', seq: '@', focus: true },
    { label: '^C', seq: '\x03' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: '^B', mod: 'prefix' },
    { label: '^Bn', seq: '\x02n' },
];

const CLIP: Key = { label: '📎', act: 'upload' }; // top-right corner
const UP: Key = { label: '↑', seq: '\x1b[A' };
const LEFT: Key = { label: '←', seq: '\x1b[D' };
const DOWN: Key = { label: '↓', seq: '\x1b[B' };
const RIGHT: Key = { label: '→', seq: '\x1b[C' };

export class KeyBar extends Component<Props> {
    // Prevent the button from stealing focus from the terminal's hidden textarea.
    private hold = (e: Event) => e.preventDefault();

    private press(k: Key) {
        if (k.mod) this.props.onMod(k.mod);
        else if (k.act === 'upload') this.props.onUpload();
        else this.props.onKey(k.seq as string, k.blur, k.focus);
    }

    private renderKey(k: Key, area = '') {
        const cls =
            'keybar-key' + (area ? ' ' + area : '') + (k.mod && this.props.armed === k.mod ? ' keybar-armed' : '');
        return (
            <button type="button" tabIndex={-1} class={cls} onMouseDown={this.hold} onClick={() => this.press(k)}>
                {k.label}
            </button>
        );
    }

    render() {
        return (
            <div id="keybar">
                {FUNC.map(k => this.renderKey(k))}
                {this.renderKey(CLIP, 'ka-clip')}
                {this.renderKey(LEFT, 'ka-left')}
                {this.renderKey(UP, 'ka-up')}
                {this.renderKey(DOWN, 'ka-down')}
                {this.renderKey(RIGHT, 'ka-right')}
            </div>
        );
    }
}
