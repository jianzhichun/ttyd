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

// Uniform 7-per-row grid, equal-width cells, long labels truncated (ellipsis).
// 11 function keys fill row 1 + the start of row 2; the row ends with ← [↑/↓] →
// where ↑ is stacked above ↓ in a single cell, so it all fits in 2 rows.
// (No Spc/⌨: the native keyboard has space, and tapping the terminal summons it.
// Scrollback scrolling is done by swiping — see Terminal.setupTouch.)
const FUNC: Key[] = [
    { label: 'Esc', seq: '\x1b' },
    { label: 'Tab', seq: '\t' },
    { label: '⇧⇥', seq: '\x1b[Z' },
    { label: '^C', seq: '\x03' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: '^B', mod: 'prefix' },
    { label: '^Bp', seq: '\x02p' },
    { label: '^Bn', seq: '\x02n' },
    { label: '/', seq: '/' },
    { label: '@', seq: '@' },
    { label: '📎', act: 'upload' },
];

const UP: Key = { label: '↑', seq: '\x1b[A' };
const DOWN: Key = { label: '↓', seq: '\x1b[B' };
const LEFT: Key = { label: '←', seq: '\x1b[D' };
const RIGHT: Key = { label: '→', seq: '\x1b[C' };

export class KeyBar extends Component<Props> {
    // Prevent the button from stealing focus from the terminal's hidden textarea.
    private hold = (e: Event) => e.preventDefault();

    private press(k: Key) {
        if (k.mod) this.props.onMod(k.mod);
        else if (k.act === 'upload') this.props.onUpload();
        else this.props.onKey(k.seq as string, k.blur, k.focus);
    }

    private renderKey(k: Key) {
        const cls = 'keybar-key' + (k.mod && this.props.armed === k.mod ? ' keybar-armed' : '');
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
                {this.renderKey(LEFT)}
                <div class="keybar-updown">
                    <button type="button" tabIndex={-1} onMouseDown={this.hold} onClick={() => this.press(UP)}>
                        ↑
                    </button>
                    <button type="button" tabIndex={-1} onMouseDown={this.hold} onClick={() => this.press(DOWN)}>
                        ↓
                    </button>
                </div>
                {this.renderKey(RIGHT)}
            </div>
        );
    }
}
