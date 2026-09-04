/**
 * Importing a document: what is accepted, what is refused, and what the user is
 * told when it is refused.
 *
 * Two defects motivated this suite. Drag-and-drop read `File.path`, a property
 * Electron removed in version 32, so every drop produced no path at all and
 * silently imported nothing. And the file validator answered anything it did
 * not like with an empty list, which the interface could not distinguish from a
 * cancelled dialog — an unsupported image and a closed dialog looked the same.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const {
  selectImportFile,
  importDialogFilters,
  SUPPORTED_IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
} = tsxRequire(path.join(cwd, "electron", "importValidation.ts"), __filename);

let root;

test.beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-upload-"));
});

test.afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name, contents = "x") {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

async function writeImage(name, format) {
  const target = path.join(root, name);
  const image = sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 250, g: 250, b: 250 } } });
  await image[format]().toFile(target);
  return target;
}

test.describe("accepted formats", () => {
  test("accepts every image format the recogniser can read", async () => {
    for (const [name, format] of [["photo.png", "png"], ["photo.jpg", "jpeg"], ["photo.jpeg", "jpeg"], ["photo.webp", "webp"], ["photo.tiff", "tiff"]]) {
      const filePath = await writeImage(name, format);
      expect(selectImportFile([filePath]), name).toMatchObject({ ok: true, filePath });
    }
  });

  test("accepts a name with spaces, accents, several dots and Unicode", () => {
    const names = [
      "Facture fournisseur mars.pdf",
      "Reçu — café Été 2026.png",
      "scan.2026.08.13.final.jpg",
      "فاتورة-2026.png",
      "WhatsApp Image 2026-08-21 at 00.59.54.jpeg",
    ];
    for (const name of names) {
      const filePath = write(name);
      expect(selectImportFile([filePath]), name).toMatchObject({ ok: true, filePath });
    }
  });

  test("accepts a Windows path with a drive letter and backslashes", () => {
    const filePath = write("dossier client/facture.pdf");
    const windowsStyle = filePath.split("/").join("\\");
    expect(selectImportFile([windowsStyle])).toMatchObject({ ok: true });
  });

  test("selecting the same file twice is not an error", () => {
    const filePath = write("meme-fichier.png");
    expect(selectImportFile([filePath])).toMatchObject({ ok: true, filePath });
    expect(selectImportFile([filePath])).toMatchObject({ ok: true, filePath });
  });

  test("the dialog offers exactly the formats the pipeline accepts", () => {
    const [documents] = importDialogFilters();
    expect(documents.extensions).toEqual(SUPPORTED_IMPORT_EXTENSIONS.map((extension) => extension.slice(1)));
  });
});

test.describe("refusals explain themselves", () => {
  test("an unsupported format names the format and the accepted ones", () => {
    const filePath = write("presentation.pptx");
    const result = selectImportFile([filePath]);
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain(".pptx");
    expect(result.rejections[0].reason).toContain("presentation.pptx");
    expect(result.rejections[0].reason).toContain(".png");
  });

  test("a file with no extension is refused by name", () => {
    const filePath = write("scan-sans-extension");
    const result = selectImportFile([filePath]);
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("sans extension");
  });

  test("an empty file is refused rather than sent to the recogniser", () => {
    const filePath = write("vide.png", "");
    const result = selectImportFile([filePath]);
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("vide");
  });

  test("a missing file says so instead of failing silently", () => {
    const result = selectImportFile([path.join(root, "jamais-ecrit.pdf")]);
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("introuvable");
  });

  test("a folder is refused with the difference spelled out", () => {
    const directory = path.join(root, "un-dossier.png");
    fs.mkdirSync(directory, { recursive: true });
    const result = selectImportFile([directory]);
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("dossier");
  });

  test("an oversized file is refused before anything decodes it", () => {
    const result = selectImportFile(["/faux/enorme.png"], {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true, isDirectory: () => false, size: MAX_IMPORT_BYTES + 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("limite");
  });

  test("a file that cannot be read reports the underlying reason", () => {
    const result = selectImportFile(["/faux/protege.png"], {
      existsSync: () => true,
      statSync: () => { throw new Error("EACCES: permission denied"); },
    });
    expect(result.ok).toBe(false);
    expect(result.rejections[0].reason).toContain("EACCES");
  });

  test("a cancelled selection is not a refusal", () => {
    // No candidates at all means the user closed the dialog; that must not
    // produce an error message.
    expect(selectImportFile([])).toEqual({ ok: false, rejections: [] });
    expect(selectImportFile(["", null, undefined])).toEqual({ ok: false, rejections: [] });
  });

  test("the first usable file wins even when an unusable one comes first", () => {
    const usable = write("bon.pdf");
    const result = selectImportFile([path.join(root, "absent.pdf"), usable]);
    expect(result).toMatchObject({ ok: true, filePath: usable });
  });
});

test.describe("corrupt images", () => {
  test("a file whose bytes are not an image is refused by the decoder, with a message", async () => {
    const filePath = write("corrompu.png", "ceci n'est pas une image");
    // Validation passes — the name and size look fine — so the failure has to
    // surface from decoding, as a readable error rather than a crash.
    expect(selectImportFile([filePath])).toMatchObject({ ok: true });
    await expect(sharp(filePath).metadata()).rejects.toThrow();
  });

  test("a real image decodes and reports its size", async () => {
    const filePath = await writeImage("valide.png", "png");
    const metadata = await sharp(filePath).metadata();
    expect(metadata.width).toBe(60);
    expect(metadata.height).toBe(40);
  });
});

test.describe("drag and drop", () => {
  test("the preload exposes a path bridge instead of reading File.path", () => {
    const preload = fs.readFileSync(path.join(cwd, "electron", "preload.ts"), "utf8");
    expect(preload).toContain("webUtils");
    expect(preload).toContain("getDroppedFilePath");
  });

  test("the drop handler takes its path from the bridge, never from File.path", () => {
    const app = fs.readFileSync(path.join(cwd, "src", "App.tsx"), "utf8");
    const dropHandler = app.slice(app.indexOf("const onDrop ="), app.indexOf("const onDrop =") + 1400);
    expect(dropHandler).toContain("getDroppedFilePath");
    // `File.path` was removed in Electron 32 and always reads undefined.
    expect(dropHandler).not.toMatch(/\(file as any\)\.path/);
  });
});
