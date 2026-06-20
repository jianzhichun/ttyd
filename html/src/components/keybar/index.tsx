import { h, Component } from 'preact';

export type Mod = 'ctrl' | 'prefix';

interface Props {
    // send a raw byte sequence to the PTY; blur=true hides the soft keyboard
    // afterwards (scroll keys), focus=true summons it.
    onKey: (data: string, blur?: boolean, focus?: boolean) => void;
    // arm/disarm a sticky modifier (applied to the next typed key)
    onMod: (mod: Mod) => void;
    // summon / dismiss the soft keyboard
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
    wide?: boolean;
}

// One SGR mouse wheel notch (tmux `mouse on` turns this into a scrollback
// scroll). 64 = wheel-up, 65 = wheel-down; coords just need to land in a pane.
const WHEEL_UP = '\x1b[<64;2;2M'.repeat(3);
const WHEEL_DOWN = '\x1b[<65;2;2M'.repeat(3);

// Streamlined mobile bar for driving full-screen TUIs (e.g. Claude Code).
// Direct keys the soft keyboard lacks, plus two sticky modifiers (Ctrl / tmux
// prefix) that fold every Ctrl-combo and prefix-combo into one key each.
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
    { label: 'Ctrl', mod: 'ctrl', wide: true },
    { label: '^B', mod: 'prefix', wide: true },
    // one-tap window switch — the entries in the bottom status bar (prev/next)
    { label: '^Bp', seq: '\x02p', wide: true },
    { label: '^Bn', seq: '\x02n', wide: true },
    { label: '⌨', act: 'kbd', wide: true },
];

export class KeyBar extends Component<Props> {
    // Prevent the button from stealing focus from the terminal's hidden textarea.
    private hold = (e: Event) => e.preventDefault();

    private press(k: Key) {
        if (k.mod) this.props.onMod(k.mod);
        else if (k.act === 'kbd') this.props.onToggleKeyboard();
        else this.props.onKey(k.seq as string, k.blur, k.focus);
    }

    render({ armed }: Props) {
        return (
            <div id="keybar">
                {KEYS.map(k => {
                    const cls =
                        'keybar-key' +
                        (k.wide ? ' keybar-wide' : '') +
                        (k.mod && armed === k.mod ? ' keybar-armed' : '');
                    return (
                        <button
                            type="button"
                            tabIndex={-1}
                            class={cls}
                            onMouseDown={this.hold}
                            onClick={() => this.press(k)}
                        >
                            {k.label}
                        </button>
                    );
                })}
            </div>
        );
    }
}
