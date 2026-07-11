/**
 * EmbedOverlay — cell-anchored inline rich content via native HTML elements.
 *
 * A Kitty Unicode-placeholder block is a pure position ANCHOR. ImageStorage.scanEmbedBlocks()
 * re-derives, from the live buffer every render, each block's kind (img|video|iframe), src, and
 * FULL on-screen origin (top-left, possibly off-screen when the block is partially scrolled).
 * This class materialises a real DOM element over each block inside a clipping layer in
 * .xterm-screen, repositioning it each render — the same redraw-safe contract as the text.
 *
 *   img    → <img>            (native display; long-press to save; tap to zoom)
 *   video  → <video controls preload=metadata>  (native first frame + controls + sound)
 *   iframe → <iframe> scaled  (live miniature of the page/pdf; tap to expand full-size)
 *
 * Elements load when their block is visible and unload (grace-delayed) when it scrolls away, so
 * only what's on screen is live. Interaction: the overlay owns its touches with bubble-phase
 * stopPropagation so the terminal's tap/scroll/long-press (ancestor listeners) don't fire, while
 * native <video>/<img> gestures still work (they act at the target before the event bubbles).
 */
import { IDisposable } from '@xterm/xterm';
import { ITerminalExt } from './Types';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage, IEmbedBlock } from './ImageStorage';

interface IEntry {
  wrap: HTMLDivElement;
  kind: string;
  el: HTMLElement | null;
  lastSeen: number;
}

const GRACE_MS = 600;   // keep an entry this long after its block stops being scanned (transient redraws)
const IFRAME_DESIGN_W = 1280;   // iframes render at this width then scale down (must match the hook)

export class EmbedOverlay implements IDisposable {
  private _entries: Map<number, IEntry> = new Map();
  private _layer: HTMLDivElement | undefined;   // clipping container inside .xterm-screen
  private _modal: HTMLDivElement | undefined;   // page-level expand overlay
  private _raf = 0;
  private _graceTimer = 0;
  private _disposed = false;

  constructor(
    private _terminal: ITerminalExt,
    private _renderer: ImageRenderer,
    private _storage: ImageStorage
  ) {}

  public dispose(): void {
    this._disposed = true;
    const win = this._win();
    if (this._raf) { win.cancelAnimationFrame(this._raf); this._raf = 0; }
    if (this._graceTimer) { win.clearTimeout(this._graceTimer); this._graceTimer = 0; }
    for (const e of this._entries.values()) { this._teardown(e); }
    this._entries.clear();
    this._layer?.remove(); this._layer = undefined;
    this._closeModal();
  }

  private _win(): Window {
    return this._renderer.document?.defaultView || window;
  }

  /** Called after each terminal render; coalesced to one reposition pass per frame. */
  public schedule(): void {
    if (this._disposed || this._raf) {
      return;
    }
    this._raf = this._win().requestAnimationFrame(() => { this._raf = 0; this._sync(); });
  }

  private _ensureLayer(screen: HTMLElement): HTMLDivElement {
    if (this._layer && this._layer.parentElement === screen) {
      return this._layer;
    }
    this._layer?.remove();
    const layer = screen.ownerDocument.createElement('div');
    layer.className = 'cc-embed-layer';               // absolute inset:0, overflow:hidden, pointer-events:none
    screen.appendChild(layer);
    this._layer = layer;
    return layer;
  }

  private _sync(): void {
    if (this._disposed) {
      return;
    }
    const screen = this._renderer.screenElement;
    const cell = this._renderer.cssCellSize;
    if (!screen || !cell) {
      return;
    }
    if (this._graceTimer) { this._win().clearTimeout(this._graceTimer); this._graceTimer = 0; }
    const layer = this._ensureLayer(screen);
    const blocks = this._storage.scanEmbedBlocks();
    const now = this._win().performance.now();
    const seen: Set<number> = new Set();
    for (const b of blocks) {
      seen.add(b.id);
      let e = this._entries.get(b.id);
      if (!e) {
        e = this._create(b, layer);
        this._entries.set(b.id, e);
      }
      e.lastSeen = now;
      const w = b.gridCols * cell.width;
      const h = b.gridRows * cell.height;
      const s = e.wrap.style;
      s.transform = `translate(${b.originCol * cell.width}px, ${b.originRow * cell.height}px)`;
      s.width = `${w}px`;
      s.height = `${h}px`;
      s.visibility = '';
      if (e.kind === 'iframe' && e.el) { this._fitIframe(e.el as HTMLIFrameElement, w, h); }
    }
    for (const [id, e] of this._entries) {
      if (seen.has(id)) {
        continue;
      }
      if (now - e.lastSeen > GRACE_MS) {
        this._teardown(e);
        this._entries.delete(id);
      } else {
        e.wrap.style.visibility = 'hidden';
        // _sync only runs on render; if renders stop while a block is off-screen, guarantee one
        // more pass after the grace window so the element unloads (and a video stops playing).
        if (!this._graceTimer) {
          this._graceTimer = this._win().setTimeout(() => { this._graceTimer = 0; this._sync(); }, GRACE_MS + 32);
        }
      }
    }
  }

  private _create(b: IEmbedBlock, layer: HTMLElement): IEntry {
    const doc = layer.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'cc-embed cc-embed-' + b.kind;
    const entry: IEntry = { wrap, kind: b.kind, el: null, lastSeen: 0 };

    if (b.kind === 'video') {
      const v = doc.createElement('video');
      v.className = 'cc-embed-el';
      v.src = b.src;
      v.controls = true;
      v.playsInline = true;
      v.setAttribute('webkit-playsinline', 'true');
      v.preload = 'metadata';                         // native first frame + metadata, not the whole file
      wrap.appendChild(v);
      entry.el = v;
      this._wire(wrap);                               // guard touches; native controls do the rest
    } else if (b.kind === 'iframe') {
      const f = doc.createElement('iframe');
      f.className = 'cc-embed-el cc-embed-frame';
      f.src = b.src;
      f.setAttribute('scrolling', 'no');
      // No sandbox: the sidecar only ever hands us same-origin *.internal URLs (our own served
      // files), and cross-origin policy already blocks a framed page from touching this parent.
      // A sandbox would also break Chrome's built-in PDF viewer (blocked in any sandboxed frame).
      wrap.appendChild(f);
      entry.el = f;
      this._wire(wrap, () => this._expand('iframe', b.src));   // inline is a preview; tap to expand
    } else {                                          // img
      const img = doc.createElement('img');
      img.className = 'cc-embed-el';
      img.decoding = 'async';
      img.src = b.src;
      wrap.appendChild(img);
      entry.el = img;
      wrap.addEventListener('contextmenu', (ev) => ev.stopPropagation());   // let native long-press save
      this._wire(wrap, () => this._expand('img', b.src));     // tap to zoom
    }

    layer.appendChild(wrap);
    return entry;
  }

  /** Own touches so the terminal's tap/scroll/long-press don't fire; run onTap on a plain tap. */
  private _wire(wrap: HTMLElement, onTap?: () => void): void {
    const stop = (ev: Event) => ev.stopPropagation();
    wrap.addEventListener('touchstart', stop);
    wrap.addEventListener('touchmove', stop);
    if (onTap) {
      wrap.addEventListener('touchend', (ev) => { ev.stopPropagation(); onTap(); });
      wrap.addEventListener('click', (ev) => { ev.stopPropagation(); onTap(); });
    } else {
      wrap.addEventListener('touchend', stop);        // video: native controls act; just block the terminal
    }
  }

  private _fitIframe(f: HTMLIFrameElement, w: number, h: number): void {
    // Render the page at a fixed design width, then scale the whole box down to the block — the
    // content stays crisp (scaled as one layer) and this is compositor-cheap to reposition.
    const scale = w / IFRAME_DESIGN_W || 1;
    f.style.width = `${IFRAME_DESIGN_W}px`;
    f.style.height = `${h / scale}px`;
    f.style.transform = `scale(${scale})`;
  }

  private _teardown(e: IEntry): void {
    const el = e.el as HTMLVideoElement | null;
    if (el && e.kind === 'video') {
      try { el.pause(); } catch { /* ignore */ }
    }
    if (el && 'src' in el) { (el as HTMLMediaElement).removeAttribute('src'); }   // stop the network load
    e.wrap.remove();
  }

  // ---- expand: a page-level lightbox for img / iframe -----------------------
  private _expand(kind: string, src: string): void {
    const screen = this._renderer.screenElement;
    if (!screen) {
      return;
    }
    this._closeModal();
    const doc = screen.ownerDocument;
    const modal = doc.createElement('div');
    modal.className = 'cc-embed-modal';
    const box = doc.createElement('div');
    box.className = 'cc-modal-box';
    let el: HTMLElement;
    if (kind === 'iframe') {
      const f = doc.createElement('iframe');
      f.src = src;                                    // trusted *.internal only (see _create); no sandbox → PDF viewer works
      el = f;
    } else {
      const img = doc.createElement('img');
      img.src = src;
      el = img;
    }
    el.className = 'cc-modal-el';
    const close = doc.createElement('button');
    close.className = 'cc-modal-x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'close');
    box.appendChild(el);
    box.appendChild(close);
    modal.appendChild(box);
    // Appended to <body>, OUTSIDE the terminal container, so the terminal's touch/mouse listeners
    // never see these events — no stopPropagation gymnastics needed here.
    doc.body.appendChild(modal);
    this._modal = modal;
    const onClose = () => this._closeModal();
    close.addEventListener('click', onClose);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) { onClose(); } });   // backdrop
  }

  private _closeModal(): void {
    this._modal?.remove();
    this._modal = undefined;
  }
}
