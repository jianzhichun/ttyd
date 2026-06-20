import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';
import { KeyBar } from '../keybar';
import { OrientationHint } from '../orient';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private root: HTMLElement;
    private xterm: Xterm;
    private disposeViewport?: () => void;
    private disposeTap?: () => void;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
    }

    async componentDidMount() {
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
        this.hardenInput();
        this.setupViewport();
        this.setupTapDismiss();
    }

    componentWillUnmount() {
        this.disposeViewport?.();
        this.disposeTap?.();
        this.xterm.dispose();
    }

    render({ id }: Props, { modal }: State) {
        return (
            <div id="terminal-root" ref={c => (this.root = c as HTMLElement)}>
                <div id={id} ref={c => (this.container = c as HTMLElement)}>
                    <Modal show={modal}>
                        <label class="file-label">
                            <input onChange={this.sendFile} class="file-input" type="file" multiple />
                            <span class="file-cta">Choose files…</span>
                        </label>
                    </Modal>
                </div>
                <KeyBar onKey={this.sendKey} onToggleKeyboard={this.toggleKeyboard} />
                <OrientationHint />
            </div>
        );
    }

    @bind
    private sendKey(data: string, blur?: boolean, focus?: boolean) {
        // sendData goes straight to the socket and needs no focus, so a special
        // key must NOT focus the textarea — otherwise every Esc/arrow/Ctrl tap
        // re-summons the soft keyboard. blur=true (scroll keys) hides it; focus=
        // true (keys that open a prompt, e.g. rename) summons it — the tap is a
        // user gesture, so focus() is honored even on iOS.
        this.xterm.sendData(data);
        if (blur) window.term?.blur();
        else if (focus) window.term?.focus();
    }

    @bind
    private toggleKeyboard() {
        const active = document.activeElement as HTMLElement | null;
        if (active?.classList.contains('xterm-helper-textarea')) {
            active.blur();
        } else {
            window.term?.focus();
        }
    }

    // Tame the iOS soft keyboard for terminal use: kill autocorrect /
    // autocapitalize / predictive text that would corrupt typed commands.
    private hardenInput() {
        const ta = this.container.querySelector('.xterm-helper-textarea');
        if (!ta) return;
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'none');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('spellcheck', 'false');
    }

    // On touch devices the soft keyboard shrinks the visual viewport without
    // changing the layout viewport, so the prompt ends up hidden behind it.
    // Pin the terminal root to visualViewport.height and refit on every change.
    @bind
    private setupViewport() {
        const vv = window.visualViewport;
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!vv || !coarse) return;

        const onChange = () => {
            this.root.style.height = `${vv.height}px`;
            this.xterm.fit();
        };
        vv.addEventListener('resize', onChange);
        vv.addEventListener('scroll', onChange);
        onChange();
        this.disposeViewport = () => {
            vv.removeEventListener('resize', onChange);
            vv.removeEventListener('scroll', onChange);
        };
    }

    // Mobile keyboard dismiss: a tap in the upper (transcript) area hides the
    // soft keyboard so you can read output; tapping near the bottom prompt
    // re-focuses to type. Only a real tap (no drag/selection) counts.
    @bind
    private setupTapDismiss() {
        const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
        if (!coarse) return;
        const el = this.container;
        let sx = 0;
        let sy = 0;
        let single = false;

        const onStart = (e: TouchEvent) => {
            single = e.touches.length === 1;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
        };
        const onEnd = (e: TouchEvent) => {
            if (!single || e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];
            const moved = Math.abs(t.clientX - sx) + Math.abs(t.clientY - sy);
            if (moved > 12) return; // a drag/selection, not a tap
            const focused = document.activeElement?.classList.contains('xterm-helper-textarea');
            if (!focused) return;
            const rect = el.getBoundingClientRect();
            if (t.clientY - rect.top < rect.height * 0.7) window.term?.blur();
        };

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchend', onEnd, { passive: true });
        this.disposeTap = () => {
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchend', onEnd);
        };
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
