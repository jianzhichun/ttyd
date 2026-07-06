// Media-tray data layer: classify previewable internal links, and accumulate
// them across the session. Kept as one self-contained leaf module (no relative
// runtime imports) so it unit-tests under `node --experimental-strip-types` the
// same way the wraplinks addon does. URLs are gathered by MediaTray scanning the
// rendered buffer (wraplinks.scanBufferUrls, which stitches hard-wrapped URLs)
// and handed to addUrls(); the view layer subscribes.
//
// EVERY http(s) URL on screen enters the tray — because on touch devices the
// inline xterm link is dead (setupTouch forwards a tap to tmux as a mouse click,
// so the link provider's activate never fires), leaving the tray the only
// reliable way to open a link on mobile. Two behaviours:
//   - media.internal (images/video/audio/pdf, Range-streamed) and notes.internal
//     (.md rendered with KaTeX/Mermaid) are PREVIEWABLE → tapped in-place.
//   - everything else (office.internal, code.internal, external e.g. claude.ai)
//     becomes a kind:'link' item the tray opens in a new tab via a real <a>
//     (a trusted user gesture, so mobile does not popup-block it).

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'note' | 'link';

export interface MediaItem {
    url: string;
    kind: MediaKind;
    name: string; // last path segment, percent-decoded, for the tray label
    host?: string; // hostname — labels non-previewable 'link' items
}

const HOSTS = new Set(['media.internal', 'notes.internal']);

const EXT_KIND: Record<string, MediaKind> = {
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    avif: 'image',
    svg: 'image',
    ico: 'image',
    bmp: 'image',
    mp4: 'video',
    mov: 'video',
    webm: 'video',
    mkv: 'video',
    m4v: 'video',
    mp3: 'audio',
    m4a: 'audio',
    wav: 'audio',
    aac: 'audio',
    flac: 'audio',
    ogg: 'audio',
    pdf: 'pdf',
    md: 'note',
};

// Returns the classified item, or null if the URL is not a previewable
// media/notes resource. Pure (uses the standard URL parser) — unit-testable.
export function classifyMedia(rawUrl: string): MediaItem | null {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        return null;
    }
    if (!HOSTS.has(u.hostname)) return null;

    const path = u.pathname.replace(/\/+$/, '');
    const seg = path.split('/').pop() || '';
    const dot = seg.lastIndexOf('.');
    const ext = dot >= 0 ? seg.slice(dot + 1).toLowerCase() : '';

    let kind: MediaKind | undefined = EXT_KIND[ext];
    // notes.internal serves rendered markdown; any path under it is a note even
    // if the extension is unusual (or absent, e.g. a directory index).
    if (!kind && u.hostname === 'notes.internal') kind = 'note';
    if (!kind) return null;

    let name = seg;
    try {
        name = decodeURIComponent(seg);
    } catch {
        /* keep raw seg on malformed escapes */
    }
    return { url: rawUrl, kind, name: name || u.hostname };
}

// Classify ANY http(s) URL into a tray item: previewable media/notes keep their
// preview kind; every other http(s) URL becomes an openable kind:'link'. Returns
// null only for non-http(s) or unparseable strings. Pure — unit-testable.
export function classifyUrl(rawUrl: string): MediaItem | null {
    const media = classifyMedia(rawUrl);
    if (media) return media;
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const seg = (u.pathname.replace(/\/+$/, '').split('/').pop() || '') + (u.search || '');
    let name = seg;
    try {
        name = decodeURIComponent(seg);
    } catch {
        /* keep raw seg on malformed escapes */
    }
    return { url: rawUrl, kind: 'link', name: name || u.hostname, host: u.hostname };
}

// ── collection store ────────────────────────────────────────────────────────
// Holds the media/notes links CURRENTLY on screen. Fed by MediaTray, which scans
// the rendered buffer every render and replaces the list, so the tray tracks the
// viewport live: links appear as you scroll to them and leave as they scroll off.
// Pure of DOM/preact.

type Listener = () => void;

export class MediaStore {
    private items: MediaItem[] = [];
    private listeners = new Set<Listener>();

    // Replace the list with the links currently on screen (screen order,
    // top→bottom): previewable media/notes plus openable external links. Called on
    // every render with the latest scan; emits only when the set actually changed,
    // so it tracks the viewport live without churn.
    setUrls(urls: string[]): void {
        const items = urls.map(classifyUrl).filter((x): x is MediaItem => x !== null);
        if (items.length === this.items.length && items.every((it, i) => it.url === this.items[i].url)) {
            return;
        }
        this.items = items;
        this.emit();
    }

    getItems(): MediaItem[] {
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

// Session-wide singleton: MediaTray feeds it (buffer scan) and subscribes to it.
export const mediaStore = new MediaStore();
