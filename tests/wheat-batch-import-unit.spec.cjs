/**
 * What an import is allowed to carry, now that it is allowed to carry a batch.
 *
 * Import used to answer a folder of thirty invoices with the *first* acceptable
 * file and no word about the other twenty-nine, because the only selector Wheat
 * had returned a single path. These cases pin the replacement: everything
 * usable is kept, everything refused is named, a folder is walked, and neither
 * a locked file nor a stray thumbnail cancels the batch.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const {
  selectImportFile,
  selectImportFiles,
  MAX_IMPORT_BATCH_FILES,
  MAX_IMPORT_FOLDER_DEPTH,
} = tsxRequire(path.join(root, "electron", "importValidation.ts"), __filename);

let temporaryRoot;

const write = (relative, bytes = 64) => {
  const target = path.join(temporaryRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes, 1));
  return target;
};
const names = (paths) => paths.map((item) => path.basename(item));

test.describe("batch import selection", () => {
  test.beforeEach(() => { temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-batch-")); });
  test.afterEach(() => { fs.rmSync(temporaryRoot, { recursive: true, force: true }); });

  test("every acceptable file in a selection is kept, not merely the first", () => {
    const files = [write("a.pdf"), write("b.jpg"), write("c.png")];
    const selection = selectImportFiles(files);
    expect(selection.accepted).toHaveLength(3);
    expect(names(selection.accepted)).toEqual(["a.pdf", "b.jpg", "c.png"]);
    expect(selection.rejections).toEqual([]);
    // The single-file selector still exists for the screens that want one.
    expect(selectImportFile(files).ok).toBe(true);
  });

  test("a dropped folder is walked, and its files come back in a stable order", () => {
    write("lot/2026/07/facture-2.pdf");
    write("lot/2026/07/facture-1.pdf");
    write("lot/2026/08/facture-3.pdf");
    const selection = selectImportFiles([path.join(temporaryRoot, "lot")]);
    expect(names(selection.accepted)).toEqual(["facture-1.pdf", "facture-2.pdf", "facture-3.pdf"]);
  });

  test("an unusable file is named and the rest of the batch survives it", () => {
    const good = write("facture.pdf");
    const empty = write("vide.pdf", 0);
    const huge = write("enorme.pdf", 1);
    // Larger than the per-document limit, without writing 50 MB to disk.
    const fileSystem = {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      statSync: (target) => {
        const stat = fs.statSync(target);
        return {
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
          size: target === huge ? 60 * 1024 * 1024 : stat.size,
        };
      },
    };
    const selection = selectImportFiles([good, empty, huge], fileSystem);
    expect(names(selection.accepted)).toEqual(["facture.pdf"]);
    expect(selection.rejections).toHaveLength(2);
    expect(selection.rejections.map((item) => item.reason).join(" ")).toMatch(/vide \(0 octet\)/);
    expect(selection.rejections.map((item) => item.reason).join(" ")).toMatch(/dépasse la limite/);
  });

  test("an unreadable entry is reported rather than thrown", () => {
    const good = write("facture.pdf");
    const locked = write("verrouille.pdf");
    const fileSystem = {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      statSync: (target) => {
        if (target === locked) throw new Error("EBUSY: resource busy or locked");
        const stat = fs.statSync(target);
        return { isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), size: stat.size };
      },
    };
    const selection = selectImportFiles([good, locked], fileSystem);
    expect(names(selection.accepted)).toEqual(["facture.pdf"]);
    expect(selection.rejections[0].reason).toMatch(/EBUSY/);
  });

  test("a stray file inside a folder is skipped quietly; one named directly is explained", () => {
    write("lot/facture.pdf");
    write("lot/Thumbs.db");
    const fromFolder = selectImportFiles([path.join(temporaryRoot, "lot")]);
    expect(names(fromFolder.accepted)).toEqual(["facture.pdf"]);
    // Noise found while walking is not worth a line of error text…
    expect(fromFolder.rejections).toEqual([]);

    // …but a file the user pointed at deserves an answer.
    const named = selectImportFiles([path.join(temporaryRoot, "lot", "Thumbs.db")]);
    expect(named.accepted).toEqual([]);
    expect(named.rejections[0].reason).toMatch(/n'est pas pris en charge/);
  });

  test("the same file offered twice is imported once", () => {
    const file = write("facture.pdf");
    const selection = selectImportFiles([file, file]);
    expect(selection.accepted).toHaveLength(1);
  });

  test("a folder nested deeper than the walk allows says so instead of being ignored", () => {
    const deep = ["lot"];
    for (let level = 0; level <= MAX_IMPORT_FOLDER_DEPTH; level += 1) deep.push(`n${level}`);
    write(path.join(...deep, "facture.pdf"));
    const selection = selectImportFiles([path.join(temporaryRoot, "lot")]);
    expect(selection.accepted).toEqual([]);
    expect(selection.rejections.map((item) => item.reason).join(" ")).toMatch(/imbriqué au-delà/);
  });

  test("a very large batch is capped and says it was capped", () => {
    for (let index = 0; index < MAX_IMPORT_BATCH_FILES + 5; index += 1) {
      write(`lot/facture-${String(index).padStart(4, "0")}.pdf`);
    }
    const selection = selectImportFiles([path.join(temporaryRoot, "lot")]);
    expect(selection.accepted).toHaveLength(MAX_IMPORT_BATCH_FILES);
    expect(selection.truncated).toBe(true);
  });

  test("an empty selection is an empty selection, not an error", () => {
    const selection = selectImportFiles([]);
    expect(selection.accepted).toEqual([]);
    expect(selection.rejections).toEqual([]);
    expect(selection.truncated).toBe(false);
  });
});
