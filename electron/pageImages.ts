import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";

/**
 * Turning a file into pages a recogniser can read.
 *
 * Three modules needed the same three things — where the PDF worker lives, how
 * to render a page, and how to prepare that page for a cloud recogniser — and
 * each had grown its own copy. They are one concern: *the picture of the page*,
 * before anybody reads it. Nothing here knows what a document means, what a
 * bank statement is, or which engine will be asked; it produces images.
 *
 * Keeping it in one place is what lets the bank importer send a scanned
 * statement to the cloud through exactly the same preparation the document
 * pipeline has been using — the same rotation, the same ceiling, the same
 * encoding — rather than a second, subtly different one nobody compared.
 */

/**
 * The bundled pdf.js worker, wherever this build keeps it.
 *
 * A packaged Wheat carries it under `resources/`; a development tree has it in
 * `node_modules`. Returns an empty string when it is genuinely absent, which
 * the callers report rather than crash on.
 */
export function resolvePdfWorkerUrl(app?: App): string {
  const candidates = app?.isPackaged
    ? [
      path.join(process.resourcesPath, "ocr", "pdf.worker.mjs"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(path.dirname(process.execPath), "resources", "ocr", "pdf.worker.mjs"),
    ]
    : [
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "pdf-parse", "esm", "pdf.worker.mjs"),
    ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ? pathToFileURL(found).toString() : "";
}

let sharpModule: any = null;

/** The image library, loaded once and shared. */
export async function getSharp() {
  if (!sharpModule) {
    const module = await import("sharp");
    sharpModule = module.default ?? module;
  }
  return sharpModule;
}

export type PreparedImage = { buffer: Buffer; steps: string[]; width: number; height: number };

/**
 * The page as the local recogniser receives it: rotated upright, bounded to
 * 1800 pixels wide, PNG.
 */
export async function buildPaddlePrimaryImage(input: string | Buffer): Promise<PreparedImage> {
  const sharp = await getSharp();
  const metadata = await sharp(input, { limitInputPixels: false }).rotate().metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width > 1800 ? 1800 : width > 0 && width < 1200 ? 1600 : undefined;
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .png({ compressionLevel: 3 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    // The recogniser reports coordinates in the space of the image it was
    // given, so the size recorded here is the resized one, not the original.
    width: info.width,
    height: info.height,
    steps: ["sharp-auto-rotate", resizeWidth ? `paddle-resize-width-${resizeWidth}` : "paddle-native-size", "paddle-png"],
  };
}

/**
 * The page as it is sent to a cloud recogniser.
 *
 * The same rotation and the same 1800-pixel ceiling as the local path, so the
 * two engines read the same page — but encoded as JPEG rather than PNG. The
 * person waiting on this is, by construction, on the machine and often the
 * connection least able to afford the upload: the same page is roughly an order
 * of magnitude smaller this way, and a document scan has no flat colour for
 * lossless encoding to exploit. Quality 82 is above the point where a printed
 * amount starts to degrade.
 */
export async function buildCloudImage(input: string | Buffer): Promise<PreparedImage> {
  const sharp = await getSharp();
  const metadata = await sharp(input, { limitInputPixels: false }).rotate().metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width > 1800 ? 1800 : width > 0 && width < 1200 ? 1600 : undefined;
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width,
    height: info.height,
    steps: ["sharp-auto-rotate", resizeWidth ? `cloud-resize-width-${resizeWidth}` : "cloud-native-size", "cloud-jpeg-q82"],
  };
}

export type RenderedPage = { page: number; buffer: Buffer };

/**
 * Renders the first `limit` pages of a PDF, one image each.
 *
 * The page count is bounded by the caller rather than by the file: a recogniser
 * that is charged per page, or a person watching a progress bar, both need the
 * work to be finite before it starts. Returns the pages it could render and
 * says nothing about the rest.
 */
export async function renderPdfPages(
  bytes: Buffer,
  options: { app?: App; limit: number; scale?: number },
): Promise<{ pages: RenderedPage[]; pageCount: number; truncated: boolean }> {
  const { PDFParse } = await import("pdf-parse");
  const workerUrl = resolvePdfWorkerUrl(options.app);
  if (workerUrl && typeof PDFParse.setWorker === "function") PDFParse.setWorker(workerUrl);
  const parser = new PDFParse({ data: bytes });
  try {
    const limit = Math.max(1, Math.trunc(options.limit));
    const shot = await parser.getScreenshot({
      scale: options.scale ?? 2.2,
      first: 1,
      last: limit,
      imageDataUrl: false,
      imageBuffer: true,
    });
    const pageCount = Number(shot.total ?? shot.pages?.length ?? 0) || 0;
    const pages = (shot.pages ?? [])
      .map((page: any, index: number) => ({ page: Number(page.pageNumber) || index + 1, data: page.data }))
      .filter((page: { page: number; data: unknown }) => Boolean(page.data))
      .map((page: { page: number; data: any }) => ({ page: page.page, buffer: Buffer.from(page.data) }));
    return { pages, pageCount: pageCount || pages.length, truncated: pageCount > limit };
  } finally {
    await parser.destroy();
  }
}
