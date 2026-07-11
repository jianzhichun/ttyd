/**
 * VideoOverlay — cell-anchored inline video playback for Kitty-placeholder posters.
 *
 * The MessageDisplay hook turns a local video path into a placeholder block whose "image"
 * is a first-frame still tagged (via the __ccimg X-CC-Video-Url header) with the video's
 * media.internal URL. ImageStorage draws that still like any inline image; this class lays a
 * transparent <div> over the same cells with a ▶ badge, and on tap swaps in a <video> that
 * plays the URL IN PLACE. Because it re-derives block positions from the live buffer every
 * render (ImageStorage.scanVideoBlocks), the player follows the text as it scrolls/redraws —
 * the same redraw-safe contract as the placeholder image itself.
 *
 * Playback starts from a real tap/click (a user gesture), so the browser lets it play WITH
 * sound (only silent autoplay is throttled). iOS plays inline via playsinline, not fullscreen.
 *
 * Interaction: the overlay owns its touches with bubble-phase stopPropagation. setupTouch's
 * tap/scroll/long-press listeners live on an ANCESTOR (the terminal container), so stopping
 * propagation at the overlay keeps a tmux click / context menu from firing under the video,
 * while native <video controls> still work (they act at the target before the event bubbles).
 */
import { IDisposable } from '@xterm/xterm';
import { ITerminalExt } from './Types';
import { ImageRenderer } from './ImageRenderer';
import { ImageStorage } from './ImageStorage';

interface IEntry {
  wrap: HTMLDivElement;
  video: HTMLVideoElement | null;
  lastSeen: number;
  url: string;
}

// Keep an overlay this long after its block stops being scanned, so a transient partial
// redraw (which may not repaint every row in one frame) doesn't tear down a playing video.
const GRACE_MS = 600;

export class VideoOverlay implements IDisposable {
  private _entries: Map<number, IEntry> = new Map();
  private _raf = 0;
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
    for (const e of this._entries.values()) {
      this._teardown(e);
    }
    this._entries.clear();
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

  private _sync(): void {
    if (this._disposed) {
      return;
    }
    const screen = this._renderer.screenElement;
    const cell = this._renderer.cssCellSize;
    if (!screen || !cell) {
      return;
    }
    const blocks = this._storage.scanVideoBlocks();
    const now = this._win().performance.now();
    const seen: Set<number> = new Set();
    for (const b of blocks) {
      seen.add(b.id);
      let e = this._entries.get(b.id);
      if (!e) {
        e = this._create(b.videoUrl, screen);
        this._entries.set(b.id, e);
      }
      e.lastSeen = now;
      e.url = b.videoUrl;
      if (e.video && e.video.src !== b.videoUrl) {
        e.video.src = b.videoUrl;                  // id got recycled to a different video
      }
      const s = e.wrap.style;
      s.left = `${b.minCol * cell.width}px`;
      s.top = `${b.minRow * cell.height}px`;
      s.width = `${(b.maxCol - b.minCol + 1) * cell.width}px`;
      s.height = `${(b.maxRow - b.minRow + 1) * cell.height}px`;
      s.visibility = '';
    }
    for (const [id, e] of this._entries) {
      if (seen.has(id)) {
        continue;
      }
      if (now - e.lastSeen > GRACE_MS) {
        this._teardown(e);
        this._entries.delete(id);
      } else {
        e.wrap.style.visibility = 'hidden';        // gone this frame but within grace — keep it
      }
    }
  }

  private _create(url: string, screen: HTMLElement): IEntry {
    const doc = screen.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'cc-vid';
    wrap.style.position = 'absolute';
    wrap.innerHTML = '<div class="cc-vid-badge"><span class="cc-vid-tri"></span></div>';
    const entry: IEntry = { wrap, video: null, lastSeen: 0, url };
    // Own every touch that starts on the poster so the terminal's tap/scroll/long-press
    // logic (ancestor listeners) doesn't also act. A tap/click starts playback.
    const stop = (ev: Event) => ev.stopPropagation();
    wrap.addEventListener('touchstart', stop);
    wrap.addEventListener('touchmove', stop);
    wrap.addEventListener('touchend', (ev) => { ev.stopPropagation(); if (!entry.video) { this._play(entry); } });
    wrap.addEventListener('click', (ev) => { ev.stopPropagation(); if (!entry.video) { this._play(entry); } });
    screen.appendChild(wrap);
    return entry;
  }

  private _play(e: IEntry): void {
    const doc = e.wrap.ownerDocument;
    const v = doc.createElement('video');
    v.className = 'cc-vid-el';
    v.src = e.url;
    v.controls = true;
    v.playsInline = true;
    v.setAttribute('webkit-playsinline', 'true');    // older iOS
    v.preload = 'metadata';
    e.wrap.innerHTML = '';                            // drop the ▶ badge
    e.wrap.appendChild(v);
    e.video = v;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});                             // if the play promise rejects, controls still work
    }
  }

  private _teardown(e: IEntry): void {
    if (e.video) {
      try { e.video.pause(); } catch { /* ignore */ }
      e.video.removeAttribute('src');
      e.video.load();
    }
    e.wrap.remove();
  }
}
