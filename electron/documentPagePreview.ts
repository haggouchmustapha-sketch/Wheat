import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";

/**
 * The source document, shown beside the values Wheat read off it.
 *
 * Checking an extraction means comparing it with the page it came from. Until
 * now Wheat showed a stylised paper icon in place of the document and left the
 * person to open the real file in another application — which is the moment the
 * comparison stops happening, because the two things are no longer on the same
 * screen.
 *
 * Two constraints shape this module.
 *
 * *Looking is not recognising.* Rendering a page is a picture of the file and
 * nothing else: it reads no extraction, writes nothing, and cannot re-run OCR.
 * Paging and zooming must be free to do repeatedly, so rendered pages are held
 * in a small cache keyed by the file's identity and the scale.
 *
 * *Pictures cross the bridge as data.* The renderer's content policy allows
 * `data:` images and not `file:` ones, and that is the right way round — a
 * renderer that can load arbitrary local paths as images is a renderer that can
 * be talked into loading the wrong one. The main process reads the file it
 * already owns and hands back bytes.
 */

export type DocumentPagePreview = {
  page: number;
  pageCount: number;
  mimeType: string;
  /** The page itself, base64, ready for a `data:` URL. */
  base64: string;
  /** Whether Wheat could render this file at all. */
  rendered: boolean;
  /** Said plainly when it could not, rather than shown as a blank frame. */
  reason: string | null;
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Enough for a document being reviewed page by page, small enough to forget. */
const MAX_CACHED_PAGES = 24;
const MAX_SOURCE_BYTES = 60_000_000;

type CacheKey = string;
const cache = new Map<CacheKey, DocumentPagePreview>();

function remember(key: CacheKey, value: DocumentPagePreview) {
  cache.set(key, value);
  while (cache.size > MAX_CACHED_PAGES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return value;
}

/** Dropped when a document is re-recognised, so a stale page is never shown. */
export function forgetDocumentPagePreviews(storedPath?: string) {
  if (!storedPath) {
    cache.clear();
    return;
  }
  const prefix = `${path.resolve(storedPath)}|`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

function unavailable(reason: string): DocumentPagePreview {
  return { page: 1, pageCount: 0, mimeType: "", base64: "", rendered: false, reason };
}

function resolvePdfWorkerUrl(app?: App): string {
  const candidates = app?.isPackaged
    ? [
      path.join(process.resourcesPath, "ocr", "pdf.worker.mjs"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
    ]
    : [path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ? pathToFileURL(found).toString() : "";
}

/**
 * One page of one managed document, as an image.
 *
 * `page` is 1-based. `scale` is bounded: a request for an enormous rendering is
 * clamped rather than refused, because it comes from a zoom control and the
 * honest answer to "bigger" is "as big as is sensible".
 */
export async function renderDocumentPage(input: {
  storedPath: string;
  page?: number;
  scale?: number;
  app?: App;
}): Promise<DocumentPagePreview> {
  const storedPath = path.resolve(String(input.storedPath ?? ""));
  if (!storedPath || !fs.existsSync(storedPath)) return unavailable("Le fichier d'origine n'est plus à cet emplacement.");
  const stats = fs.statSync(storedPath);
  if (!stats.isFile()) return unavailable("Le chemin enregistré ne désigne pas un fichier.");
  if (stats.size > MAX_SOURCE_BYTES) return unavailable("Le fichier d'origine est trop volumineux pour être affiché ici.");

  const page = Math.max(1, Math.min(500, Math.trunc(Number(input.page ?? 1)) || 1));
  const scale = Math.max(0.5, Math.min(4, Number(input.scale ?? 1.5) || 1.5));
  const extension = path.extname(storedPath).toLowerCase();
  const key = `${storedPath}|${stats.mtimeMs}|${stats.size}|${page}|${scale}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (IMAGE_MIME[extension]) {
    // An image is its own page: no rendering, and scale is the viewer's affair.
    const base64 = fs.readFileSync(storedPath).toString("base64");
    return remember(key, { page: 1, pageCount: 1, mimeType: IMAGE_MIME[extension], base64, rendered: true, reason: null });
  }

  if (extension !== ".pdf") {
    return unavailable(`Wheat ne sait pas afficher un fichier ${extension || "sans extension"} ici. Les valeurs lues restent modifiables à droite.`);
  }

  try {
    const { PDFParse } = await import("pdf-parse");
    const workerUrl = resolvePdfWorkerUrl(input.app);
    if (workerUrl && typeof PDFParse.setWorker === "function") PDFParse.setWorker(workerUrl);
    const parser = new PDFParse({ data: fs.readFileSync(storedPath) });
    try {
      const shot = await parser.getScreenshot({ scale, first: page, last: page, imageDataUrl: false, imageBuffer: true });
      const pageCount = Number(shot.total ?? shot.pages?.length ?? 0) || 0;
      const rendered = (shot.pages ?? [])[0];
      if (!rendered?.data) {
        return unavailable(pageCount && page > pageCount ? `Ce document n'a que ${pageCount} page(s).` : "Cette page n'a pas pu être rendue.");
      }
      return remember(key, {
        page,
        pageCount: pageCount || page,
        mimeType: "image/png",
        base64: Buffer.from(rendered.data).toString("base64"),
        rendered: true,
        reason: null,
      });
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    return unavailable(`L'aperçu de cette page n'a pas pu être produit : ${error instanceof Error ? error.message : String(error)}`);
  }
}
