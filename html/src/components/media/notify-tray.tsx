import { Component, h } from 'preact';
import { createPortal } from 'preact/compat';

import { notifyStore, Notif } from './notify';

// Floating notification overlay (top-left). Polls the same-origin __ccnotify
// endpoint for messages pushed from the host (`cc-notify`, e.g. a WeChat
// monitor) and shows them as a tappable feed. Tapping a card jumps to the tmux
// window the notification came from. Portaled to <body> like the media tray.

const POLL_MS = 4000;

interface State {
    items: Notif[];
    open: boolean;
}

function ago(ts: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

export class NotifyTray extends Component<unknown, State> {
    state: State = { items: notifyStore.getItems(), open: false };
    private unsub?: () => void;
    private timer?: number;

    componentDidMount() {
        this.unsub = notifyStore.subscribe(() => this.setState({ items: notifyStore.getItems() }));
        this.poll();
        this.timer = window.setInterval(this.poll, POLL_MS);
    }

    componentWillUnmount() {
        this.unsub?.();
        if (this.timer) clearInterval(this.timer);
    }

    private poll = () => {
        if (typeof document !== 'undefined' && document.hidden) return; // pause when backgrounded
        const url = new URL(`__ccnotify?since=${notifyStore.lastId}`, window.location.href).href;
        fetch(url, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(j => {
                if (j && Array.isArray(j.notifs)) notifyStore.add(j.notifs as Notif[]);
            })
            .catch(() => {
                /* transient network error — try again next tick */
            });
    };

    private toggle = () => this.setState(s => ({ open: !s.open }));

    private tap = (n: Notif) => {
        // server-side jump: POST the id; the server runs `tmux select-window` to the
        // stored session:window (no keystroke injection — that leaks into the pane).
        fetch(new URL('__ccswitch', window.location.href).href, {
            method: 'POST',
            body: JSON.stringify({ id: n.id }),
        }).catch(() => {
            /* ignore */
        });
        notifyStore.remove(n.id);
    };

    private clear = () => {
        fetch(new URL('__ccswitch', window.location.href).href, {
            method: 'POST',
            body: JSON.stringify({ clear: true }),
        }).catch(() => {
            /* ignore */
        });
        notifyStore.clear();
        this.setState({ open: false });
    };

    render(_props: unknown, { items, open }: State) {
        if (!items.length) return null;
        return createPortal(
            <div id="notify-tray">
                <button class="nt-btn" type="button" onClick={this.toggle} aria-label="notifications">
                    {items.length}
                </button>

                {open && (
                    <div class="nt-panel">
                        <div class="nt-head">
                            <span>notifications — {items.length}</span>
                            <button class="nt-clear" type="button" onClick={this.clear}>
                                clear
                            </button>
                        </div>
                        <div class="nt-list">
                            {items.map(n => (
                                <button key={n.id} class="nt-item" type="button" onClick={() => this.tap(n)}>
                                    <div class="nt-row">
                                        <span class="nt-title">{n.title || n.kind || 'notify'}</span>
                                        <span class="nt-time">{ago(n.ts)}</span>
                                    </div>
                                    {n.body && <div class="nt-body">{n.body}</div>}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>,
            document.body
        );
    }
}
