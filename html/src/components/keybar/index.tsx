import { h, Component } from 'preact';

interface Props {
    // send a raw byte sequence to the PTY; blur=true hides the soft keyboard
    // afterwards (for scroll keys — you're reading, not typing).
    onKey: (data: string, blur?: boolean) => void;
    // summon / dismiss the soft keyboard
    onToggleKeyboard: () => void;
}

interface Key {
    label: string;
    seq?: string;
    act?: 'kbd';
    blur?: boolean;
    wide?: boolean;
}

// One SGR mouse wheel notch (tmux `mouse on` turns this into a scrollback
// scroll). 64 = wheel-up, 65 = wheel-down; coords just need to land in a pane.
const WHEEL_UP = '\x1b[<64;2;2M'.repeat(3);
const WHEEL_DOWN = '\x1b[<65;2;2M'.repeat(3);

// Mobile virtual keys for driving full-screen TUIs (e.g. Claude Code) where the
// soft keyboard has no Esc / Tab / arrows / Ctrl combos. Each entry sends an
// exact byte sequence — no modifier state, so it is reliable across browsers.
const KEYS: Key[] = [
    { label: 'Esc', seq: '\x1b', wide: true },
    { label: 'Tab', seq: '\t' },
    { label: '⇧⇥', seq: '\x1b[Z' },
    { label: '←', seq: '\x1b[D' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '→', seq: '\x1b[C' },
    { label: '⇞', seq: WHEEL_UP, blur: true },
    { label: '⇟', seq: WHEEL_DOWN, blur: true },
    { label: '^C', seq: '\x03' },
    { label: '^R', seq: '\x12' },
    { label: '^L', seq: '\x0c' },
    { label: '^D', seq: '\x04' },
    { label: '^Z', seq: '\x1a' },
    { label: '^U', seq: '\x15' },
    { label: '/', seq: '/' },
    { label: '|', seq: '|' },
    { label: '~', seq: '~' },
    { label: '⌨', act: 'kbd', wide: true },
];

export class KeyBar extends Component<Props> {
    // Prevent the button from stealing focus from the terminal's hidden
    // textarea — otherwise tapping a key would dismiss the soft keyboard.
    private hold = (e: Event) => e.preventDefault();

    private press(k: Key) {
        if (k.act === 'kbd') this.props.onToggleKeyboard();
        else this.props.onKey(k.seq as string, k.blur);
    }

    render() {
        return (
            <div id="keybar">
                {KEYS.map(k => (
                    <button
                        type="button"
                        tabIndex={-1}
                        class={'keybar-key' + (k.wide ? ' keybar-wide' : '')}
                        onMouseDown={this.hold}
                        onClick={() => this.press(k)}
                    >
                        {k.label}
                    </button>
                ))}
            </div>
        );
    }
}
