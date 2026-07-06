import { Component, h } from 'preact';
import { createPortal } from 'preact/compat';

import { scanBufferUrls } from '../terminal/xterm/addons/wraplinks';
import { mediaStore, MediaItem } from './media';
import { PdfView } from './pdf';

// A floating tray that previews previewable internal links (media.internal /
// notes.internal) printed in the terminal — in-place, no new tab.
//
// Collection: scan the rendered buffer (scanBufferUrls, which stitches the hard-
// wrapped URLs CC prints on a narrow grid) once per frame on xterm's render
// event, feeding mediaStore. Per-frame scanning + accumulation means a link is
// caught while it's on screen and kept after it scrolls off — far more reliable
// than tapping the raw output stream, where CC's mid-URL wrap newlines split a
// long link into uncapturable halves. All UI is portaled to <body> so the
// terminal's keyboard-aware transforms never reparent or clip it.

interface State {
    items: MediaItem[];
    open: boolean;
    preview: MediaItem | null;
}

export class MediaTray extends Component<unknown, State> {
    state: State = { items: mediaStore.getItems(), open: false, preview: null };
    private unsub?: () => void;
    private disposeRender?: () => void;
    private waitRaf = 0; // rAF handle for the window.term wait loop

    componentDidMount() {
        this.unsub = mediaStore.subscribe(() => this.setState({ items: mediaStore.getItems() }));
        this.waitForTerm();
    }

    componentWillUnmount() {
        this.unsub?.();
        this.disposeRender?.();
        if (this.waitRaf) cancelAnimationFrame(this.waitRaf);
    }

    // window.term is created in Terminal.componentDidMount, which runs AFTER this
    // child mounts — wait a few frames until it exists, then scan on every render.
    private waitForTerm(tries = 0) {
        const term = window.term;
        if (!term) {
            if (tries < 120) this.waitRaf = requestAnimationFrame(() => this.waitForTerm(tries + 1));
            return;
        }
        const d = term.onRender(this.scan);
        this.disposeRender = () => d.dispose();
        this.scan();
    }

    // Scan synchronously on EVERY render — NOT coalesced to a trailing rAF. With
    // scrollback=0 a link is only in the buffer while it is on screen; as Claude
    // Code streams a reply each line sits at the bottom for a render or two before
    // scrolling up, so we must scan that exact render or the link is gone. The
    // scan is a few dozen rows of regex — cheap enough to run per render. addUrls
    // dedupes, so re-scanning the same rows is free.
    private scan = () => {
        const term = window.term;
        if (!term) return;
        try {
            mediaStore.setUrls(scanBufferUrls(term));
        } catch {
            /* ignore a transient scan failure */
        }
    };

    private toggle = () => this.setState(s => ({ open: !s.open }));
    private show = (it: MediaItem) => this.setState({ preview: it, open: false });
    private hide = () => this.setState({ preview: null });

    render(_props: unknown, { items, open, preview }: State) {
        if (!items.length && !preview) return null;
        return createPortal(
            <div id="media-tray">
                {items.length > 0 && (
                    <button class="mt-btn" type="button" onClick={this.toggle} aria-label="media tray">
                        {items.length}
                    </button>
                )}

                {open && (
                    <div class="mt-panel">
                        <div class="mt-head">links — {items.length}</div>
                        <div class="mt-list">
                            {items.map(it =>
                                it.kind === 'link' ? (
                                    // Non-previewable link → open in a new tab via a real
                                    // anchor. A tap on <a> is a trusted user gesture, so
                                    // mobile does not popup-block it (unlike window.open).
                                    <a
                                        key={it.url}
                                        class="mt-item mt-link"
                                        href={it.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <span class="mt-thumb mt-type">↗</span>
                                        <span class="mt-name">
                                            {it.host} · {it.name}
                                        </span>
                                    </a>
                                ) : (
                                    <button key={it.url} class="mt-item" type="button" onClick={() => this.show(it)}>
                                        {it.kind === 'image' ? (
                                            <img class="mt-thumb" src={it.url} loading="lazy" alt="" />
                                        ) : (
                                            <span class="mt-thumb mt-type">{typeLabel(it)}</span>
                                        )}
                                        <span class="mt-name">{it.name}</span>
                                    </button>
                                )
                            )}
                        </div>
                    </div>
                )}

                {preview && (
                    <div class="mt-preview" onClick={this.hide}>
                        <a
                            class="mt-open"
                            href={preview.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            aria-label="open in browser"
                        >
                            ↗
                        </a>
                        <button class="mt-x" type="button" onClick={this.hide} aria-label="close">
                            ×
                        </button>
                        <div class="mt-stage" onClick={e => e.stopPropagation()}>
                            {renderPreview(preview)}
                        </div>
                    </div>
                )}
            </div>,
            document.body
        );
    }
}

// Short uppercase type tag (file extension, else kind) for non-image list rows —
// a terminal-native text chip in place of an emoji icon.
function typeLabel(it: MediaItem): string {
    const dot = it.name.lastIndexOf('.');
    const ext = dot >= 0 ? it.name.slice(dot + 1) : it.kind;
    return ext.toUpperCase().slice(0, 4);
}

function renderPreview(it: MediaItem) {
    switch (it.kind) {
        case 'image':
            return <img class="mt-media" src={it.url} alt={it.name} />;
        case 'video':
            return <video class="mt-media" src={it.url} controls playsInline />;
        case 'audio':
            return <audio class="mt-media-audio" src={it.url} controls />;
        case 'pdf':
            return <PdfView url={it.url} />;
        case 'note':
            return <iframe class="mt-frame" src={it.url} title={it.name} />;
        default:
            return null; // 'link' items open in a new tab, never preview
    }
}
