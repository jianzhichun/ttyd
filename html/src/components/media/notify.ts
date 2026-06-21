// Notification feed store for the floating overlay. Fed by polling the
// same-origin __ccnotify endpoint (cc-paste-upload), which `cc-notify` on the
// host pushes into — independent of the tmux active window, so a monitor in a
// background window can still surface a notification. The view layer subscribes.

export interface Notif {
    id: number;
    title: string;
    body: string;
    kind: string;
    window: string; // tmux window to select when the card is tapped
    ts: number; // server epoch seconds
}

type Listener = () => void;
const CAP = 100;

export class NotifyStore {
    private items: Notif[] = []; // newest first
    private listeners = new Set<Listener>();
    lastId = 0;

    // Append a batch from the server (ascending id). Newest ends up first.
    add(batch: Notif[]): void {
        if (!batch.length) return;
        for (const n of batch) {
            this.items.unshift(n);
            if (n.id > this.lastId) this.lastId = n.id;
        }
        if (this.items.length > CAP) this.items = this.items.slice(0, CAP);
        this.emit();
    }

    remove(id: number): void {
        const i = this.items.findIndex(n => n.id === id);
        if (i < 0) return;
        this.items.splice(i, 1);
        this.emit();
    }

    clear(): void {
        if (!this.items.length) return;
        this.items = [];
        this.emit();
    }

    getItems(): Notif[] {
        return this.items;
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private emit(): void {
        this.listeners.forEach(l => l());
    }
}

export const notifyStore = new NotifyStore();
