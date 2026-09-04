/**
 * What Wheat accepts when a document is imported, and why it refuses the rest.
 *
 * Import used to answer a rejected file with an empty result: no document, no
 * message, and nothing to distinguish "that format is not supported" from "you
 * cancelled the dialog". Dropping a photo of an invoice therefore looked
 * identical to doing nothing at all.
 *
 * The rules live here, apart from the IPC layer, so the same list of accepted
 * formats governs the file dialog, the drop zone and the recogniser, and so
 * every refusal can be tested for the sentence it produces.
 */

import fs from "node:fs";
import path from "node:path";

/** Formats the recogniser can actually read, in the order a user thinks of them. */
export const SUPPORTED_IMPORT_EXTENSIONS = [
  ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".avif", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".gif",
  ".csv", ".txt", ".xlsx",
] as const;

/** A single file larger than this is refused before anything tries to decode it. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export type ImportRejection = { path: string; reason: string };

/** How deep a dropped folder is walked, and how many files one import may carry. */
export const MAX_IMPORT_FOLDER_DEPTH = 4;
export const MAX_IMPORT_BATCH_FILES = 200;

export type ImportBatchSelection = {
  /** Every file that may be recognised, in the order they were offered. */
  accepted: string[];
  /** Everything that may not, each with the sentence to show the person. */
  rejections: ImportRejection[];
  /** Set when the batch was truncated at `MAX_IMPORT_BATCH_FILES`. */
  truncated: boolean;
};

export type ImportSelection =
  | { ok: true; filePath: string }
  | { ok: false; rejections: ImportRejection[] };

type StatLike = { isFile(): boolean; isDirectory(): boolean; size: number };

export type ImportFileSystem = {
  existsSync: (target: string) => boolean;
  statSync: (target: string) => StatLike;
  /** Only needed to expand a dropped folder; absent means folders are refused. */
  readdirSync?: (target: string) => string[];
};

const defaultFileSystem: ImportFileSystem = { existsSync: fs.existsSync, statSync: fs.statSync, readdirSync: fs.readdirSync };

/**
 * Chooses the one file an import may proceed with.
 *
 * Returns the first candidate that passes; otherwise every candidate with the
 * reason it failed, phrased for the person who dropped it rather than for a log.
 * Accents, spaces and several dots in a name are all fine — only the extension
 * and what is on disk decide.
 */
export function selectImportFile(inputPaths: readonly string[], fileSystem: ImportFileSystem = defaultFileSystem): ImportSelection {
  const supported = new Set<string>(SUPPORTED_IMPORT_EXTENSIONS);
  const candidates = inputPaths.filter((target): target is string => typeof target === "string" && target.trim().length > 0);
  if (!candidates.length) return { ok: false, rejections: [] };

  const rejections: ImportRejection[] = [];
  for (const target of candidates) {
    const name = path.basename(target);
    if (!fileSystem.existsSync(target)) {
      rejections.push({ path: target, reason: `« ${name} » est introuvable ; il a peut-être été déplacé ou supprimé.` });
      continue;
    }
    let stat: StatLike;
    try {
      stat = fileSystem.statSync(target);
    } catch (error) {
      rejections.push({ path: target, reason: `« ${name} » n'a pas pu être lu : ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (stat.isDirectory()) {
      rejections.push({ path: target, reason: `« ${name} » est un dossier. Déposez un fichier.` });
      continue;
    }
    if (!stat.isFile()) {
      rejections.push({ path: target, reason: `« ${name} » n'est pas un fichier ordinaire.` });
      continue;
    }
    const extension = path.extname(target).toLowerCase();
    if (!supported.has(extension)) {
      rejections.push({
        path: target,
        reason: `Le format ${extension || "sans extension"} de « ${name} » n'est pas pris en charge. Formats acceptés : ${SUPPORTED_IMPORT_EXTENSIONS.join(", ")}.`,
      });
      continue;
    }
    if (stat.size === 0) {
      rejections.push({ path: target, reason: `« ${name} » est vide (0 octet).` });
      continue;
    }
    if (stat.size > MAX_IMPORT_BYTES) {
      rejections.push({ path: target, reason: `« ${name} » dépasse la limite de ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} Mo par document.` });
      continue;
    }
    return { ok: true, filePath: target };
  }

  return { ok: false, rejections };
}

/**
 * Every importable file behind one selection, folders included.
 *
 * A fiduciaire receives a month of purchase invoices as a folder, not as one
 * carefully chosen file. Wheat used to answer such a drop with the *first*
 * acceptable document and silently ignore the other twenty-nine, because the
 * only selector it had returned a single path. This one keeps every file it can
 * read and every reason it refused the rest, so the import screen can say
 * "28 documents retenus, 2 ignorés" and name the two.
 *
 * A folder is walked to `MAX_IMPORT_FOLDER_DEPTH` levels — deep enough for the
 * "2026/07/Achats" layout people actually keep, shallow enough that dropping a
 * home directory by accident does not enumerate a disk. Unreadable entries are
 * reported, never thrown: one locked file must not cancel the batch.
 */
export function selectImportFiles(
  inputPaths: readonly string[],
  fileSystem: ImportFileSystem = defaultFileSystem,
): ImportBatchSelection {
  const supported = new Set<string>(SUPPORTED_IMPORT_EXTENSIONS);
  const accepted: string[] = [];
  const rejections: ImportRejection[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const consider = (target: string, depth: number) => {
    if (accepted.length >= MAX_IMPORT_BATCH_FILES) {
      truncated = true;
      return;
    }
    const name = path.basename(target);
    if (seen.has(target)) return;
    seen.add(target);
    if (!fileSystem.existsSync(target)) {
      rejections.push({ path: target, reason: `« ${name} » est introuvable ; il a peut-être été déplacé ou supprimé.` });
      return;
    }
    let stat: StatLike;
    try {
      stat = fileSystem.statSync(target);
    } catch (error) {
      rejections.push({ path: target, reason: `« ${name} » n'a pas pu être lu : ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (stat.isDirectory()) {
      if (!fileSystem.readdirSync) {
        rejections.push({ path: target, reason: `« ${name} » est un dossier. Déposez un fichier.` });
        return;
      }
      if (depth >= MAX_IMPORT_FOLDER_DEPTH) {
        rejections.push({ path: target, reason: `« ${name} » est imbriqué au-delà de ${MAX_IMPORT_FOLDER_DEPTH} niveaux ; importez ce sous-dossier directement.` });
        return;
      }
      let entries: string[];
      try {
        entries = fileSystem.readdirSync(target);
      } catch (error) {
        rejections.push({ path: target, reason: `Le dossier « ${name} » n'a pas pu être ouvert : ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      // Sorted, so an import of the same folder always presents the same order.
      for (const entry of [...entries].sort((left, right) => left.localeCompare(right, "fr"))) {
        consider(path.join(target, entry), depth + 1);
      }
      return;
    }
    if (!stat.isFile()) {
      rejections.push({ path: target, reason: `« ${name} » n'est pas un fichier ordinaire.` });
      return;
    }
    const extension = path.extname(target).toLowerCase();
    if (!supported.has(extension)) {
      // A folder full of invoices routinely holds a thumbnail database or a
      // note; naming every one of them as an error would bury the real ones.
      if (depth > 0) return;
      rejections.push({
        path: target,
        reason: `Le format ${extension || "sans extension"} de « ${name} » n'est pas pris en charge. Formats acceptés : ${SUPPORTED_IMPORT_EXTENSIONS.join(", ")}.`,
      });
      return;
    }
    if (stat.size === 0) {
      rejections.push({ path: target, reason: `« ${name} » est vide (0 octet).` });
      return;
    }
    if (stat.size > MAX_IMPORT_BYTES) {
      rejections.push({ path: target, reason: `« ${name} » dépasse la limite de ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} Mo par document.` });
      return;
    }
    accepted.push(target);
  };

  for (const target of inputPaths) {
    if (typeof target !== "string" || !target.trim()) continue;
    consider(target, 0);
  }
  return { accepted, rejections, truncated };
}

/** File-dialog filters built from the one supported-format list. */
export function importDialogFilters() {
  return [
    { name: "Document", extensions: SUPPORTED_IMPORT_EXTENSIONS.map((extension) => extension.slice(1)) },
    { name: "Tous les fichiers", extensions: ["*"] },
  ];
}
