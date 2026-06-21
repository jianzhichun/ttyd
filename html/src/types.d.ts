// `import x from '...?raw'` -> the file's contents as a string (webpack asset/source).
declare module '*?raw' {
    const content: string;
    export default content;
}

// Minimal surface of the pdf.js legacy build we use (full @types are heavy and
// the legacy path isn't typed out of the box).
declare module 'pdfjs-dist/legacy/build/pdf' {
    export const GlobalWorkerOptions: { workerSrc: string };
    export interface PdfViewport {
        width: number;
        height: number;
    }
    export interface PdfPage {
        getViewport(opts: { scale: number }): PdfViewport;
        render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
    }
    export interface PdfDoc {
        numPages: number;
        getPage(n: number): Promise<PdfPage>;
    }
    export interface PdfTask {
        promise: Promise<PdfDoc>;
        destroy(): void;
    }
    export function getDocument(src: { url: string } | string): PdfTask;
}
