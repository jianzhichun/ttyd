// Media-tray data layer: classify previewable internal links, and accumulate
// them across the session. Kept as one self-contained leaf module (no relative
// runtime imports) so it unit-tests under `node --experimental-strip-types` the
// same way the wraplinks addon does. URLs are gathered by MediaTray scanning the
// rendered buffer (wraplinks.scanBufferUrls, which stitches hard-wrapped URLs)
// and handed to addUrls(); the view layer subscribes.
//
// Only the two read-only renderer hosts qualify (see the homevm CLAUDE.md
// file-link rules): media.internal (images/video/audio/pdf, Range-streamed) and
// notes.internal (.md rendered to HTML with KaTeX/Mermaid). office.internal
// (editor), code.internal (VS Code) and external hosts are left to the normal
// "open in a new tab" link behaviour and never enter the tray.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'note';

export interface MediaItem {
    url: string;
    kind: MediaKind;
    name: string; // last path segment, percent-decoded, for the tray label
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

// ── collection store ────────────────────────────────────────────────────────
// Holds the media/notes links CURRENTLY on screen. Fed by MediaTray, which scans
// the rendered buffer every render and replaces the list, so the tray tracks the
// viewport live: links appear as you scroll to them and leave as they scroll off.
// Pure of DOM/preact.

type Listener = () => void;

export class MediaStore {
    private items: MediaItem[] = [];
    private listeners = new Set<Listener>();

    // Replace the list with the media/notes links currently on screen (screen
    // order, top→bottom). Called on every render with the latest scan; emits only
    // when the set actually changed, so it tracks the viewport live without churn.
    setUrls(urls: string[]): void {
        const items = urls.map(classifyMedia).filter((x): x is MediaItem => x !== null);
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
