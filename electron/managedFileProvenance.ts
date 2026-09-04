import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPortableArchiveRelativePath, portableArchiveRelativePath } from "./archive";

type ManagedReferenceKind = "document" | "bank-statement" | "ledger-import";

type ManagedReference = {
  id: string;
  kind: ManagedReferenceKind;
  storedPath: string;
  expectedSha256: unknown;
  expectedByteSize: unknown;
};

type VerifiedReference = {
  id: string;
  kind: ManagedReferenceKind;
};

export type VerifiedManagedFile = {
  relativePath: string;
  sha256: string;
  byteSize: number;
  references: VerifiedReference[];
};

export type ManagedFileProvenanceResult = {
  files: VerifiedManagedFile[];
  relativePaths: string[];
  referencesChecked: number;
};

export type VerifyManagedFileProvenanceOptions = {
  databasePath: string;
  /** Root against which paths stored in SQLite are interpreted. */
  storedPathsRoot: string;
  /**
   * Root containing the bytes to verify. This differs from storedPathsRoot
   * while a restore is staged: SQLite already contains its final paths, while
   * attachment bytes still live in the private extraction directory.
   */
  physicalFilesRoot?: string;
};

type FileGroup = {
  relativePath: string;
  physicalPath: string;
  references: ManagedReference[];
};

function isStrictlyInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/").normalize("NFC");
}

function collisionKey(relativePath: string) {
  return relativePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function tableExists(database: import("node:sqlite").DatabaseSync, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(database: import("node:sqlite").DatabaseSync, table: string) {
  return new Set(
    (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

function readManagedReferences(databasePath: string) {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const references: ManagedReference[] = [];

    if (tableExists(database, "Document")) {
      const columns = tableColumns(database, "Document");
      const shaExpression = columns.has("contentSha256") ? '"contentSha256"' : "NULL";
      const sizeExpression = columns.has("byteSize") ? '"byteSize"' : "NULL";
      references.push(
        ...(database.prepare(`
          SELECT "id", "storedPath", ${shaExpression} AS "expectedSha256", ${sizeExpression} AS "expectedByteSize"
          FROM "Document"
          WHERE "storedPath" IS NOT NULL
        `).all() as Array<Omit<ManagedReference, "kind">>).map((row) => ({ ...row, kind: "document" as const })),
      );
    }

    if (tableExists(database, "BankStatementImport")) {
      references.push(
        ...(database.prepare(`
          SELECT "id", "sourceStoredPath" AS "storedPath", "sourceSha256" AS "expectedSha256", NULL AS "expectedByteSize"
          FROM "BankStatementImport"
          WHERE "sourceStoredPath" IS NOT NULL
        `).all() as Array<Omit<ManagedReference, "kind">>).map((row) => ({ ...row, kind: "bank-statement" as const })),
      );
    }

    if (tableExists(database, "LedgerImportBatch")) {
      references.push(
        ...(database.prepare(`
          SELECT "id", "sourceStoredPath" AS "storedPath", "sourceSha256" AS "expectedSha256", NULL AS "expectedByteSize"
          FROM "LedgerImportBatch"
          WHERE "sourceStoredPath" IS NOT NULL
        `).all() as Array<Omit<ManagedReference, "kind">>).map((row) => ({ ...row, kind: "ledger-import" as const })),
      );
    }

    return references;
  } finally {
    database.close();
  }
}

function normalizedExpectedSha256(value: unknown, reference: ManagedReference) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value.trim())) {
    throw new Error(`L'empreinte de provenance ${reference.kind} ${reference.id} est invalide.`);
  }
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizedExpectedByteSize(value: unknown, reference: ManagedReference) {
  if (value === null || value === undefined) return null;
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new Error(`La taille de provenance du document ${reference.id} est invalide.`);
  if (parsed < 0n) throw new Error(`La taille de provenance du document ${reference.id} est invalide.`);
  return parsed;
}

function hashStableRegularFile(filePath: string) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Le fichier géré n'est pas un fichier ordinaire : ${filePath}`);
  }
  const digest = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.lstatSync(filePath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ino !== after.ino
    || before.dev !== after.dev
  ) {
    throw new Error(`Le fichier géré a changé pendant la vérification : ${filePath}`);
  }
  return { sha256: digest.digest("hex"), byteSize: after.size };
}

export type ManagedPathRepairResult = {
  /** Files renamed on disk, with their row updated, so a backup can carry them. */
  repaired: Array<{ from: string; to: string }>;
  /** Files that could not be made portable. Named, never quietly dropped. */
  unrepairable: Array<{ relativePath: string; reason: string }>;
};

const REPAIR_UPDATES: Record<ManagedReferenceKind, { table: string; column: string }> = {
  document: { table: "Document", column: "storedPath" },
  "bank-statement": { table: "BankStatementImport", column: "sourceStoredPath" },
  "ledger-import": { table: "LedgerImportBatch", column: "sourceStoredPath" },
};

/**
 * Makes every managed attachment carryable by a backup.
 *
 * A managed file used to be named from whatever the source document was called,
 * and one name a backup's path contract refuses — a trailing space left by
 * truncation, a Windows device name, a decomposed accent — made the whole
 * dossier impossible to back up. Not the document: the dossier. Backup is the
 * one feature whose failure a person discovers at the worst possible moment,
 * so a name is repaired rather than allowed to stand.
 *
 * Repair is a rename and a row update, never a deletion and never a change of
 * content: the same bytes, under a name every filesystem accepts. A file that
 * cannot be repaired is returned by name so the caller can say which one, and
 * is never silently omitted from a backup that claims to be complete.
 */
export function repairNonPortableManagedPaths(options: {
  databasePath: string;
  storedPathsRoot: string;
}): ManagedPathRepairResult {
  const databasePath = path.resolve(options.databasePath);
  const storedPathsRoot = path.resolve(options.storedPathsRoot);
  const result: ManagedPathRepairResult = { repaired: [], unrepairable: [] };
  if (!fs.existsSync(databasePath)) return result;

  const references = readManagedReferences(databasePath).filter((reference) => typeof reference.storedPath === "string" && reference.storedPath.trim());
  const pending: Array<{ reference: ManagedReference; fromRelative: string; toRelative: string }> = [];
  const claimed = new Set<string>();

  for (const reference of references) {
    const storedAbsolutePath = path.isAbsolute(reference.storedPath)
      ? path.resolve(reference.storedPath)
      : path.resolve(storedPathsRoot, reference.storedPath);
    if (!isStrictlyInside(storedPathsRoot, storedAbsolutePath)) continue;
    const relativePath = canonicalRelativePath(path.relative(storedPathsRoot, storedAbsolutePath));
    if (isPortableArchiveRelativePath(relativePath)) {
      claimed.add(collisionKey(relativePath));
      continue;
    }
    const portable = portableArchiveRelativePath(relativePath);
    if (!portable) {
      result.unrepairable.push({ relativePath, reason: "Aucun nom de fichier portable ne peut être dérivé de ce chemin." });
      continue;
    }
    // A repaired name must not land on another attachment's name.
    let candidate = portable;
    let suffix = 1;
    while (claimed.has(collisionKey(candidate)) || (candidate !== relativePath && fs.existsSync(path.resolve(storedPathsRoot, ...candidate.split("/"))))) {
      const extension = path.posix.extname(portable);
      candidate = `${portable.slice(0, portable.length - extension.length)}-${suffix}${extension}`;
      suffix += 1;
      if (suffix > 50) break;
    }
    if (claimed.has(collisionKey(candidate))) {
      result.unrepairable.push({ relativePath, reason: "Un autre fichier géré porte déjà le nom portable correspondant." });
      continue;
    }
    claimed.add(collisionKey(candidate));
    pending.push({ reference, fromRelative: relativePath, toRelative: candidate });
  }

  if (!pending.length) return result;

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    for (const item of pending) {
      const from = path.resolve(storedPathsRoot, ...item.fromRelative.split("/"));
      const to = path.resolve(storedPathsRoot, ...item.toRelative.split("/"));
      if (!fs.existsSync(from)) {
        // The row points at a file that is not there. That is a provenance
        // problem, reported by the verification pass with its own message.
        continue;
      }
      const update = REPAIR_UPDATES[item.reference.kind];
      if (!tableExists(database, update.table)) continue;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
      } catch (error) {
        result.unrepairable.push({
          relativePath: item.fromRelative,
          reason: `Le fichier n'a pas pu être renommé : ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      try {
        database.prepare(`UPDATE "${update.table}" SET "${update.column}" = ? WHERE "id" = ?`).run(to, item.reference.id);
        result.repaired.push({ from: item.fromRelative, to: item.toRelative });
      } catch (error) {
        // The row could not be moved with the file, so the file goes back:
        // a renamed file with a stale row would lose the attachment entirely.
        try { fs.renameSync(to, from); } catch { /* reported just below */ }
        result.unrepairable.push({
          relativePath: item.fromRelative,
          reason: `La référence en base n'a pas pu être mise à jour : ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    database.close();
  }
  return result;
}

/**
 * Verifies the managed-file evidence recorded by SQLite and returns the exact,
 * de-duplicated set that a complete Wheat backup is allowed to contain.
 */
export function verifyManagedFileProvenance(options: VerifyManagedFileProvenanceOptions): ManagedFileProvenanceResult {
  const databasePath = path.resolve(options.databasePath);
  const storedPathsRoot = path.resolve(options.storedPathsRoot);
  const physicalFilesRoot = path.resolve(options.physicalFilesRoot ?? storedPathsRoot);
  if (!fs.existsSync(databasePath)) return { files: [], relativePaths: [], referencesChecked: 0 };

  const references = readManagedReferences(databasePath);
  const groups = new Map<string, FileGroup>();
  for (const reference of references) {
    if (typeof reference.storedPath !== "string" || !reference.storedPath.trim()) {
      throw new Error(`Le chemin de provenance ${reference.kind} ${reference.id} est vide.`);
    }
    const storedAbsolutePath = path.isAbsolute(reference.storedPath)
      ? path.resolve(reference.storedPath)
      : path.resolve(storedPathsRoot, reference.storedPath);
    if (!isStrictlyInside(storedPathsRoot, storedAbsolutePath)) {
      throw new Error(`Le fichier référencé par ${reference.kind} ${reference.id} se trouve hors de l'espace géré par Wheat.`);
    }
    const relativePath = canonicalRelativePath(path.relative(storedPathsRoot, storedAbsolutePath));
    const key = collisionKey(relativePath);
    const physicalPath = path.resolve(physicalFilesRoot, ...relativePath.split("/"));
    if (!isStrictlyInside(physicalFilesRoot, physicalPath)) {
      throw new Error(`Le chemin de fichier géré est invalide : ${relativePath}`);
    }
    const prior = groups.get(key);
    if (prior && prior.relativePath !== relativePath) {
      throw new Error(`Deux fichiers gérés utilisent des chemins incompatibles : ${prior.relativePath} et ${relativePath}.`);
    }
    if (prior) prior.references.push(reference);
    else groups.set(key, { relativePath, physicalPath, references: [reference] });
  }

  const files: VerifiedManagedFile[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (!fs.existsSync(group.physicalPath)) {
      throw new Error(`Le fichier géré est introuvable : ${group.relativePath}`);
    }
    const realRoot = fs.realpathSync(physicalFilesRoot);
    const realFile = fs.realpathSync(group.physicalPath);
    if (!isStrictlyInside(realRoot, realFile)) {
      throw new Error(`Le fichier géré sort de l'espace géré par Wheat via un lien symbolique : ${group.relativePath}`);
    }
    const actual = hashStableRegularFile(group.physicalPath);
    for (const reference of group.references) {
      const expectedSha256 = normalizedExpectedSha256(reference.expectedSha256, reference);
      if (expectedSha256 && expectedSha256 !== actual.sha256) {
        throw new Error(`Échec de provenance SHA-256 pour ${reference.kind} ${reference.id} : ${group.relativePath}.`);
      }
      const expectedByteSize = normalizedExpectedByteSize(reference.expectedByteSize, reference);
      if (expectedByteSize !== null && expectedByteSize !== BigInt(actual.byteSize)) {
        throw new Error(`Échec de provenance de taille pour le document ${reference.id} : ${group.relativePath}.`);
      }
    }
    files.push({
      relativePath: group.relativePath,
      sha256: actual.sha256,
      byteSize: actual.byteSize,
      references: group.references.map(({ id, kind }) => ({ id, kind })),
    });
  }

  return { files, relativePaths: files.map((file) => file.relativePath), referencesChecked: references.length };
}

/** Ensures a staged archive contains every and only the files referenced by SQLite. */
export function assertManagedFileSetMatchesArchive(databaseFiles: readonly string[], archiveFiles: readonly string[]) {
  const normalizeSet = (values: readonly string[], label: string) => {
    const normalized = values.map((value) => canonicalRelativePath(value));
    const keys = new Set<string>();
    for (const value of normalized) {
      const key = collisionKey(value);
      if (keys.has(key)) throw new Error(`${label} contient un chemin géré dupliqué : ${value}.`);
      keys.add(key);
    }
    return normalized.sort((left, right) => left.localeCompare(right));
  };
  const expected = normalizeSet(databaseFiles, "La base Wheat");
  const actual = normalizeSet(archiveFiles, "La sauvegarde Wheat");
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error("La sauvegarde complète ne contient pas exactement les fichiers gérés référencés par la base Wheat.");
  }
}
