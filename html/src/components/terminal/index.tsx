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

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
    }

    async componentDidMount() {
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
        this.setupViewport();
    }

    componentWillUnmount() {
        this.disposeViewport?.();
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
    private sendKey(data: string) {
        this.xterm.sendData(data);
        window.term?.focus();
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
