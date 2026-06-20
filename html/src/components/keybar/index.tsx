import { h, Component } from 'preact';

export type Mod = 'ctrl' | 'prefix';

interface Props {
    onKey: (data: string, blur?: boolean, focus?: boolean) => void;
    onMod: (mod: Mod) => void;
    onToggleKeyboard: () => void;
    armed: '' | Mod;
}

interface Key {
    label: string;
    seq?: string;
    act?: 'kbd';
    mod?: Mod;
    blur?: boolean;
    focus?: boolean;
}

// Non-arrow keys — they wrap into rows (no horizontal scroll). The arrows are a
// fixed inverted-T cluster pinned to the right, like a standard keyboard.
// (Scrollback scrolling is done by swiping the terminal — see Terminal.setupTouch.)
const MAIN: Key[] = [
    { label: 'Esc', seq: '\x1b' },
    { label: 'Tab', seq: '\t' },
    { label: '⇧⇥', seq: '\x1b[Z' },
    { label: '^C', seq: '\x03' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: '^B', mod: 'prefix' },
    { label: '^Bp', seq: '\x02p' },
    { label: '^Bn', seq: '\x02n' },
    { label: 'Spc', seq: ' ' },
    { label: '/', seq: '/' },
    { label: '@', seq: '@' },
    { label: '⌨', act: 'kbd' },
];

const UP: Key = { label: '↑', seq: '\x1b[A' };
const LEFT: Key = { label: '←', seq: '\x1b[D' };
const DOWN: Key = { label: '↓', seq: '\x1b[B' };
const RIGHT: Key = { label: '→', seq: '\x1b[C' };

export class KeyBar extends Component<Props> {
    // Prevent the button from stealing focus from the terminal's hidden textarea.
    private hold = (e: Event) => e.preventDefault();

    private press(k: Key) {
        if (k.mod) this.props.onMod(k.mod);
        else if (k.act === 'kbd') this.props.onToggleKeyboard();
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
                <div class="keybar-main">{MAIN.map(k => this.renderKey(k))}</div>
                <div class="keybar-arrows">
                    {this.renderKey(UP, 'ka-up')}
                    {this.renderKey(LEFT, 'ka-left')}
                    {this.renderKey(DOWN, 'ka-down')}
                    {this.renderKey(RIGHT, 'ka-right')}
                </div>
            </div>
        );
    }
}
