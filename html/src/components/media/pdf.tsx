import { Component, h } from 'preact';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
// The worker is inlined as a string and run from a Blob URL — ttyd serves a
// single html file, so we can't ship a separate worker asset. The v3 legacy
// worker is classic (UMD), so a plain (non-module) Blob worker runs it fine.
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.js?raw';

let workerReady = false;
function setupWorker() {
    if (workerReady) return;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    workerReady = true;
}

interface Props {
    url: string;
}

// Renders every page of a PDF to its own canvas, stacked in a scrollable column —
// true inline multi-page viewing (iOS Safari only shows page 1 of a PDF in an
// <iframe>/<embed>, which is why we render it ourselves).
export class PdfView extends Component<Props> {
    private host?: HTMLDivElement;
    private dead = false;
    private task?: { promise: Promise<unknown>; destroy(): void };

    async componentDidMount() {
        setupWorker();
        const host = this.host;
        if (!host) return;
        try {
            const task = pdfjsLib.getDocument({ url: this.props.url });
            this.task = task;
            const pdf = await task.promise;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cssWidth = Math.min(host.clientWidth || 320, 1100);
            for (let n = 1; n <= pdf.numPages; n++) {
                if (this.dead) return;
                const page = await pdf.getPage(n);
                const unit = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: (cssWidth / unit.width) * dpr });
                const canvas = document.createElement('canvas');
                canvas.className = 'mt-pdf-page';
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                canvas.style.width = '100%';
                const ctx = canvas.getContext('2d');
                if (!ctx) continue;
                host.appendChild(canvas);
                await page.render({ canvasContext: ctx, viewport }).promise;
            }
        } catch {
            if (this.host && !this.dead) this.host.textContent = 'PDF load failed';
        }
    }

    componentWillUnmount() {
        this.dead = true;
        try {
            this.task?.destroy();
        } catch {
            /* noop */
        }
    }

    render() {
        return <div class="mt-pdf" ref={c => (this.host = c as HTMLDivElement)} />;
    }
}
