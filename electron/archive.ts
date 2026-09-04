import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WHEAT_BACKUP_DATABASE_PATH, WHEAT_BACKUP_FORMAT, isBackupDatabasePath, isSupportedBackupFormat } from "./legacyDomainValues";

const requireModule = createRequire(import.meta.url);

type ArchiveOutput = NodeJS.EventEmitter & {
  abort(): void;
  append(source: Buffer | string, options: { name: string; date?: Date; mode?: number }): void;
  file(sourcePath: string, options: { name: string; date?: Date; mode?: number }): void;
  finalize(): Promise<void> | void;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
};

type ArchiveFactory = (format: "zip", options: { zlib: { level: number } }) => ArchiveOutput;

type ZipEntry = {
  path: string;
  type: "File" | "Directory" | string;
  versionMadeBy: number;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  externalFileAttributes: number;
  stream(password?: string): NodeJS.ReadableStream & {
    destroy?(): void;
    [Symbol.asyncIterator](): AsyncIterator<Buffer | string | Uint8Array>;
  };
};

type ZipDirectory = {
  files: ZipEntry[];
};

type UnzipperModule = {
  Open: {
    file(archivePath: string): Promise<ZipDirectory>;
  };
};

const archiver = requireModule("archiver") as ArchiveFactory;
const unzipper = requireModule("unzipper") as UnzipperModule;

/**
 * Format marker written into every backup manifest.
 *
 * The literal value is frozen at its pre-2.0 spelling so a backup created by
 * an older installation still validates, and a backup created by Wheat 2.0
 * still opens in one. It is an archive-format identifier, never shown in the
 * interface.
 */
export { WHEAT_BACKUP_FORMAT, WHEAT_BACKUP_DATABASE_PATH } from "./legacyDomainValues";
export const WHEAT_BACKUP_VERSION = 1;
export const WHEAT_BACKUP_MANIFEST_PATH = "manifest.json";


export type WheatArchiveLimits = {
  maxArchiveBytes: number;
  maxEntries: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_WHEAT_ARCHIVE_LIMITS: Readonly<WheatArchiveLimits> = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

export type WheatBackupFileKind = "database" | "attachment";

export type WheatBackupFileManifest = {
  path: string;
  kind: WheatBackupFileKind;
  size: number;
  sha256: string;
};

export type WheatBackupManifest = {
  format: string;
  version: typeof WHEAT_BACKUP_VERSION;
  backupId: string;
  createdAt: string;
  appVersion: string;
  files: WheatBackupFileManifest[];
};

export type WheatBackupSummary = {
  archivePath: string;
  archiveSize: number;
  manifest: WheatBackupManifest;
  totalPayloadBytes: number;
};

export type CreateWheatBackupOptions = {
  destinationPath: string;
  databasePath: string;
  /** Root owned by the Wheat profile directory. Only the explicitly listed relative files are archived. */
  managedAttachmentsRoot?: string;
  /** POSIX-style or platform-style paths relative to managedAttachmentsRoot. */
  managedAttachmentPaths?: readonly string[];
  appVersion: string;
  createdAt?: Date;
  limits?: Partial<WheatArchiveLimits>;
  workingDirectory?: string;
};

export type ValidateWheatBackupOptions = {
  limits?: Partial<WheatArchiveLimits>;
  workingDirectory?: string;
};

export type ExtractWheatBackupOptions = ValidateWheatBackupOptions & {
  archivePath: string;
  stagingParentDirectory?: string;
};

export type StagedWheatBackup = WheatBackupSummary & {
  stagingDirectory: string;
  databasePath: string;
  attachmentsDirectory: string;
};

type ExtractedFile = {
  path: string;
  absolutePath: string;
  size: number;
  sha256: string;
};

const immutableZipDate = new Date("2000-01-01T00:00:00.000Z");
const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const zipEndSignature = 0x06054b50;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveLimits(overrides?: Partial<WheatArchiveLimits>): WheatArchiveLimits {
  const resolved = { ...DEFAULT_WHEAT_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid Wheat backup limit ${name}. Limits must be positive safe integers.`);
    }
  }
  if (resolved.maxManifestBytes > resolved.maxFileBytes) {
    throw new Error("Wheat backup maxManifestBytes cannot exceed maxFileBytes.");
  }
  return resolved;
}

/**
 * Accepted backup file extensions.
 *
 * `.wheatbackup` is what Wheat 2.0 writes. `.atlasbackup` is the historical
 * extension: it stays readable so a backup taken before the rename can still
 * be restored. It is a file-format compatibility alias, never a label shown
 * in the interface.
 */
const BACKUP_EXTENSIONS: readonly string[] = [".wheatbackup", ".atlasbackup"];

function assertBackupExtension(filePath: string) {
  if (!BACKUP_EXTENSIONS.includes(path.extname(filePath).toLocaleLowerCase("en-US"))) {
    throw new Error(`Une sauvegarde Wheat doit porter l'extension ${BACKUP_EXTENSIONS.join(" ou ")}.`);
  }
}

function normalizedCollisionKey(archivePath: string) {
  return archivePath.normalize("NFC").toLocaleLowerCase("en-US");
}

/**
 * Accepts only one canonical, portable archive-path representation. Rejecting
 * Windows aliases and Unicode aliases here makes the same archive safe on every
 * supported operating system, not just the one doing the validation.
 */
function assertSafeArchivePath(candidate: string, label = "Archive entry") {
  if (typeof candidate !== "string" || !candidate.length) {
    throw new Error(`${label} has an empty path.`);
  }
  if (candidate.length > 1024) {
    throw new Error(`${label} path is too long.`);
  }
  if (candidate !== candidate.normalize("NFC")) {
    throw new Error(`${label} path is not in canonical Unicode form.`);
  }
  if (candidate.includes("\\") || candidate.includes("\0")) {
    throw new Error(`${label} path contains a forbidden separator or NUL byte: ${candidate}`);
  }
  if (candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate) || candidate.startsWith("//")) {
    throw new Error(`${label} path must be relative: ${candidate}`);
  }
  if (candidate.endsWith("/")) {
    throw new Error(`${label} must identify a file, not a directory: ${candidate}`);
  }

  const segments = candidate.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`${label} contains an unsafe path segment: ${candidate}`);
    }
    const hasControlCharacter = [...segment].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
    if (hasControlCharacter || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || windowsReservedName.test(segment)) {
      throw new Error(`${label} is not portable or safe: ${candidate}`);
    }
  }

  if (path.posix.normalize(candidate) !== candidate) {
    throw new Error(`${label} is not canonical: ${candidate}`);
  }
  return candidate;
}

/**
 * One path segment that `assertSafeArchivePath` will always accept.
 *
 * The portability contract belongs to the archive, so the rule that satisfies
 * it lives here and is used at the other end too: a managed file is named
 * through this function when it is stored, which is why a backup can include
 * it later. The two used to be separate — the recogniser had its own idea of a
 * safe name — and a single attachment whose name survived that idea but not
 * this one made the whole dossier impossible to back up.
 *
 * What it removes is exactly what the contract forbids, and nothing else:
 * separators and NUL, the characters Windows refuses in a name, control
 * characters, a trailing space or dot (which Windows silently drops on
 * creation), the reserved device names, and any decomposed Unicode form. An
 * accent, a space, an apostrophe or a Moroccan company name in Arabic script
 * all survive intact — none of them is a portability problem.
 */
export function portableArchiveSegment(value: unknown, fallback = "fichier", maximumLength = 80): string {
  const forbidden = /[<>:"|?*\\/]/g;
  let segment = String(value ?? "")
    .normalize("NFC")
    .replace(forbidden, " ")
    .split("")
    .map((character) => ((character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f" ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  // Truncation happens before the trailing-character rule, not after: cutting a
  // long name at a fixed width is exactly how a trailing space or dot appears.
  if (segment.length > maximumLength) segment = segment.slice(0, maximumLength);
  segment = segment.replace(/[ .]+$/, "").trim();

  if (!segment || segment === "." || segment === "..") return fallback;
  if (windowsReservedName.test(segment)) return `_${segment}`;
  return segment;
}

/**
 * The same rule applied to a whole relative path, segment by segment.
 * Returns null when nothing usable is left — the caller decides what to say.
 */
export function portableArchiveRelativePath(candidate: string): string | null {
  const segments = String(candidate ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (!segments.length) return null;
  const portable = segments.map((segment, index) => portableArchiveSegment(segment, index === segments.length - 1 ? "fichier" : "dossier"));
  const joined = portable.join("/");
  if (joined.length > 1024) return null;
  try {
    assertSafeArchivePath(joined, "Managed attachment");
  } catch {
    return null;
  }
  return joined;
}

/** True when this path can be carried into a backup exactly as it stands. */
export function isPortableArchiveRelativePath(candidate: string): boolean {
  try {
    assertSafeArchivePath(String(candidate ?? "").replaceAll("\\", "/"), "Managed attachment");
    return true;
  } catch {
    return false;
  }
}

function relativeAttachmentPath(candidate: string) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("Managed attachment paths must be non-empty relative paths.");
  }
  if (path.isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate) || candidate.startsWith("\\")) {
    throw new Error(`Managed attachment path must be relative: ${candidate}`);
  }
  const portable = candidate.replaceAll("\\", "/");
  assertSafeArchivePath(portable, "Managed attachment");
  return portable;
}

function assertNoFileCollision(
  archivePath: string,
  fileKeys: Set<string>,
  ancestorKeys: Set<string>,
  label = "Archive",
) {
  const key = normalizedCollisionKey(archivePath);
  if (fileKeys.has(key)) {
    throw new Error(`${label} contains a duplicate or case-colliding path: ${archivePath}`);
  }
  if (ancestorKeys.has(key)) {
    throw new Error(`${label} contains a file/directory prefix collision: ${archivePath}`);
  }

  const segments = key.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (fileKeys.has(ancestor)) {
      throw new Error(`${label} contains a file/directory prefix collision: ${archivePath}`);
    }
    ancestorKeys.add(ancestor);
  }
  fileKeys.add(key);
}

function toAbsoluteStagedPath(stagingDirectory: string, archivePath: string) {
  const target = path.resolve(stagingDirectory, ...archivePath.split("/"));
  const relative = path.relative(stagingDirectory, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Archive entry escapes the staging directory: ${archivePath}`);
  }
  return target;
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertRegularNonSymlink(filePath: string, label: string) {
  const stat = await fsp.lstat(filePath).catch((error: unknown) => {
    throw new Error(`${label} is unavailable: ${filePath}. ${errorMessage(error)}`);
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file: ${filePath}`);
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string) {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Managed attachment path traverses a symbolic link: ${relativePath}`);
    }
  }
}

async function hashFile(filePath: string, maxBytes: number) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`File exceeds the Wheat backup per-file limit: ${filePath}`);
    }
    hash.update(buffer);
  }
  return { size, sha256: hash.digest("hex") };
}

async function copyStableFile(sourcePath: string, destinationPath: string, label: string) {
  const before = await fsp.stat(sourcePath, { bigint: true });
  await fsp.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  const after = await fsp.stat(sourcePath, { bigint: true });
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`${label} changed while Wheat was snapshotting it. Please retry.`);
  }
}

type SQLiteDatabase = {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
  close(): void;
};

type SQLiteConstructor = new (filePath: string, options?: { readOnly?: boolean }) => SQLiteDatabase;

/** SQLite semantic integrity is checked in addition to ZIP and SHA-256 integrity. */
export function validateWheatSqliteDatabase(databasePath: string) {
  const builtin = process.getBuiltinModule?.("node:sqlite") as { DatabaseSync?: SQLiteConstructor } | undefined;
  if (!builtin?.DatabaseSync) {
    throw new Error("This Wheat runtime does not provide the required SQLite integrity checker.");
  }

  let database: SQLiteDatabase | undefined;
  try {
    database = new builtin.DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only=ON");
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${integrity.map((row) => row.integrity_check).join(", ")}`);
    }
    const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length) {
      throw new Error(`SQLite foreign_key_check found ${foreignKeyErrors.length} violation(s).`);
    }
  } catch (error) {
    throw new Error(`Wheat backup database validation failed. ${errorMessage(error)}`, { cause: error });
  } finally {
    database?.close();
  }
}

async function makePrivateTemporaryDirectory(parentDirectory: string, prefix: string) {
  await fsp.mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const resolvedParent = await fsp.realpath(parentDirectory);
  const directory = await fsp.mkdtemp(path.join(resolvedParent, prefix));
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  return directory;
}

async function writeArchive(
  destinationPath: string,
  stagedFiles: ReadonlyArray<{ sourcePath: string; archivePath: string }>,
  manifestBytes: Buffer,
) {
  const destinationDirectory = path.dirname(destinationPath);
  await fsp.mkdir(destinationDirectory, { recursive: true });
  try {
    await fsp.lstat(destinationPath);
    throw new Error(`Wheat backup destination already exists: ${destinationPath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(destinationDirectory, `.${path.basename(destinationPath)}.${randomUUID()}.partial`);
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  const archive = archiver("zip", { zlib: { level: 9 } });

  const completed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.once("warning", (warning: unknown) => reject(warning));
  });

  try {
    archive.pipe(output);
    archive.append(manifestBytes, {
      name: WHEAT_BACKUP_MANIFEST_PATH,
      date: immutableZipDate,
      mode: 0o600,
    });
    for (const file of stagedFiles) {
      archive.file(file.sourcePath, { name: file.archivePath, date: immutableZipDate, mode: 0o600 });
    }
    await Promise.all([Promise.resolve(archive.finalize()), completed]);

    try {
      await fsp.link(temporaryPath, destinationPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(`Wheat backup destination already exists: ${destinationPath}`, { cause: error });
      }
      if (code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV" && code !== "EACCES") throw error;
      await fsp.copyFile(temporaryPath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function strictIsoDate(value: unknown) {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validateManifest(value: unknown, limits: WheatArchiveLimits): WheatBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wheat backup manifest must be a JSON object.");
  }
  const candidate = value as Record<string, unknown>;
  if (!isSupportedBackupFormat(candidate.format)) {
    throw new Error("Archive is not a Wheat backup.");
  }
  if (candidate.version !== WHEAT_BACKUP_VERSION) {
    throw new Error(`Unsupported Wheat backup format version: ${String(candidate.version)}.`);
  }
  if (typeof candidate.backupId !== "string" || !uuidPattern.test(candidate.backupId)) {
    throw new Error("Wheat backup manifest has an invalid backupId.");
  }
  if (!strictIsoDate(candidate.createdAt)) {
    throw new Error("Wheat backup manifest has an invalid createdAt timestamp.");
  }
  if (typeof candidate.appVersion !== "string" || !candidate.appVersion.trim() || candidate.appVersion.length > 100) {
    throw new Error("Wheat backup manifest has an invalid appVersion.");
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw new Error("Wheat backup manifest must contain files.");
  }
  if (candidate.files.length + 1 > limits.maxEntries) {
    throw new Error("Wheat backup manifest exceeds the entry-count limit.");
  }

  const fileKeys = new Set<string>();
  const ancestorKeys = new Set<string>();
  let databaseCount = 0;
  let totalBytes = 0;
  const files = candidate.files.map((item, index): WheatBackupFileManifest => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Wheat backup manifest file ${index + 1} is invalid.`);
    }
    const file = item as Record<string, unknown>;
    const archivePath = assertSafeArchivePath(String(file.path ?? ""), "Manifest file");
    assertNoFileCollision(archivePath, fileKeys, ancestorKeys, "Wheat backup manifest");
    if (file.kind !== "database" && file.kind !== "attachment") {
      throw new Error(`Wheat backup manifest file has an invalid kind: ${archivePath}`);
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > limits.maxFileBytes) {
      throw new Error(`Wheat backup manifest file has an invalid size: ${archivePath}`);
    }
    if (typeof file.sha256 !== "string" || !sha256Pattern.test(file.sha256)) {
      throw new Error(`Wheat backup manifest file has an invalid SHA-256: ${archivePath}`);
    }

    if (file.kind === "database") {
      databaseCount += 1;
      if (!isBackupDatabasePath(archivePath)) {
        throw new Error(`Wheat backup database must be stored at ${WHEAT_BACKUP_DATABASE_PATH}.`);
      }
    } else if (!archivePath.startsWith("attachments/")) {
      throw new Error(`Wheat backup attachment is outside the attachments directory: ${archivePath}`);
    }

    totalBytes += file.size as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new Error("Wheat backup manifest exceeds the total uncompressed-size limit.");
    }
    return {
      path: archivePath,
      kind: file.kind,
      size: file.size as number,
      sha256: file.sha256,
    };
  });

  if (databaseCount !== 1) {
    throw new Error("Wheat backup manifest must contain exactly one database.");
  }

  return {
    // Reported as declared: a backup written before the rename keeps its own
    // marker rather than being described as something it is not.
    format: candidate.format as string,
    version: WHEAT_BACKUP_VERSION,
    backupId: candidate.backupId as string,
    createdAt: candidate.createdAt as string,
    appVersion: candidate.appVersion as string,
    files,
  };
}

async function preflightZip(archivePath: string, limits: WheatArchiveLimits) {
  const stat = await fsp.lstat(archivePath).catch((error: unknown) => {
    throw new Error(`Wheat backup archive is unavailable: ${errorMessage(error)}`);
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Wheat backup archive must be a regular, non-symbolic-link file.");
  }
  if (stat.size <= 0 || stat.size > limits.maxArchiveBytes) {
    throw new Error("Wheat backup archive exceeds the compressed-size limit or is empty.");
  }

  const tailLength = Math.min(stat.size, 65_557);
  const handle = await fsp.open(archivePath, "r");
  let tail: Buffer;
  try {
    tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
  } finally {
    await handle.close();
  }

  let endOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === zipEndSignature) {
      const commentLength = tail.readUInt16LE(index + 20);
      if (index + 22 + commentLength === tail.length) {
        endOffset = index;
        break;
      }
    }
  }
  if (endOffset < 0) {
    throw new Error("Wheat backup ZIP end-of-directory record is missing or malformed.");
  }

  const diskNumber = tail.readUInt16LE(endOffset + 4);
  const centralDisk = tail.readUInt16LE(endOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const centralSize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP archives are not valid Wheat backups.");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported by this Wheat backup format version.");
  }
  if (entryCount === 0 || entryCount > limits.maxEntries) {
    throw new Error("Wheat backup archive exceeds the entry-count limit or is empty.");
  }
  if (centralOffset + centralSize > stat.size - (tail.length - endOffset)) {
    throw new Error("Wheat backup central directory points outside the archive.");
  }
  return { archiveSize: stat.size, entryCount };
}

function assertRegularZipEntry(entry: ZipEntry) {
  if (entry.type !== "File") {
    throw new Error(`Wheat backups cannot contain directory or special entries: ${entry.path}`);
  }
  if ((entry.flags & 0x01) !== 0) {
    throw new Error(`Encrypted entries are not supported in Wheat backups: ${entry.path}`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method for ${entry.path}.`);
  }

  const originatingSystem = entry.versionMadeBy >>> 8;
  if (originatingSystem === 3) {
    const mode = entry.externalFileAttributes >>> 16;
    const fileType = mode & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000) {
      throw new Error(`Wheat backups cannot contain symbolic links or special files: ${entry.path}`);
    }
  }
}

async function extractZipEntry(entry: ZipEntry, targetPath: string, limits: WheatArchiveLimits): Promise<ExtractedFile> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const target = await fsp.open(targetPath, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  const source = entry.stream();
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk);
      size += buffer.length;
      if (size > limits.maxFileBytes) {
        throw new Error(`Wheat backup entry exceeds the per-file extraction limit: ${entry.path}`);
      }
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await target.write(buffer, offset, buffer.length - offset);
        if (result.bytesWritten <= 0) throw new Error(`Wheat backup extraction stopped writing: ${entry.path}`);
        offset += result.bytesWritten;
      }
    }
    if (size !== entry.uncompressedSize) {
      throw new Error(`Wheat backup entry size disagrees with its ZIP metadata: ${entry.path}`);
    }
    await target.sync();
  } finally {
    source.destroy?.();
    await target.close();
  }
  return { path: entry.path, absolutePath: targetPath, size, sha256: hash.digest("hex") };
}

async function extractAndValidate(
  archivePath: string,
  stagingDirectory: string,
  limits: WheatArchiveLimits,
): Promise<StagedWheatBackup> {
  assertBackupExtension(archivePath);
  const preflight = await preflightZip(archivePath, limits);
  let directory: ZipDirectory;
  try {
    directory = await unzipper.Open.file(archivePath);
  } catch (error) {
    throw new Error(`Wheat backup ZIP directory could not be read. ${errorMessage(error)}`, { cause: error });
  }
  if (directory.files.length !== preflight.entryCount) {
    throw new Error("Wheat backup ZIP entry count is inconsistent.");
  }

  const fileKeys = new Set<string>();
  const ancestorKeys = new Set<string>();
  let declaredTotal = 0;
  for (const entry of directory.files) {
    assertSafeArchivePath(entry.path);
    assertNoFileCollision(entry.path, fileKeys, ancestorKeys);
    assertRegularZipEntry(entry);
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.maxFileBytes) {
      throw new Error(`Wheat backup entry has an invalid or excessive declared size: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
      throw new Error(`Wheat backup entry has an invalid compressed size: ${entry.path}`);
    }
    if (entry.path === WHEAT_BACKUP_MANIFEST_PATH && entry.uncompressedSize > limits.maxManifestBytes) {
      throw new Error("Wheat backup manifest exceeds its size limit.");
    }
    declaredTotal += entry.uncompressedSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes + limits.maxManifestBytes) {
      throw new Error("Wheat backup exceeds the total uncompressed-size limit.");
    }
  }

  const extracted = new Map<string, ExtractedFile>();
  let actualTotal = 0;
  for (const entry of directory.files) {
    const file = await extractZipEntry(entry, toAbsoluteStagedPath(stagingDirectory, entry.path), limits);
    actualTotal += file.size;
    if (!Number.isSafeInteger(actualTotal) || actualTotal > limits.maxTotalBytes + limits.maxManifestBytes) {
      throw new Error("Wheat backup exceeds the actual total extraction-size limit.");
    }
    extracted.set(entry.path, file);
  }

  const manifestFile = extracted.get(WHEAT_BACKUP_MANIFEST_PATH);
  if (!manifestFile) throw new Error("Wheat backup manifest.json is missing.");
  if (manifestFile.size > limits.maxManifestBytes) throw new Error("Wheat backup manifest exceeds its size limit.");

  let parsedManifest: unknown;
  try {
    const manifestText = await fsp.readFile(manifestFile.absolutePath, "utf8");
    parsedManifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Wheat backup manifest is not valid UTF-8 JSON. ${errorMessage(error)}`, { cause: error });
  }
  const manifest = validateManifest(parsedManifest, limits);

  if (extracted.size !== manifest.files.length + 1) {
    throw new Error("Wheat backup contains files that are absent from its manifest.");
  }
  let totalPayloadBytes = 0;
  for (const expected of manifest.files) {
    const actual = extracted.get(expected.path);
    if (!actual) throw new Error(`Wheat backup is missing a manifested file: ${expected.path}`);
    if (actual.size !== expected.size) throw new Error(`Wheat backup size verification failed: ${expected.path}`);
    if (actual.sha256 !== expected.sha256) throw new Error(`Wheat backup SHA-256 verification failed: ${expected.path}`);
    totalPayloadBytes += actual.size;
  }

  const manifestedDatabase = manifest.files.find((file) => file.kind === "database");
  if (!manifestedDatabase) throw new Error("Wheat backup manifest must contain exactly one database.");
  // Archives written before the rename store it under the old name.
  const databasePath = toAbsoluteStagedPath(stagingDirectory, manifestedDatabase.path);
  validateWheatSqliteDatabase(databasePath);
  const attachmentsDirectory = path.join(stagingDirectory, "attachments");
  await fsp.mkdir(attachmentsDirectory, { recursive: true, mode: 0o700 });
  return {
    archivePath: path.resolve(archivePath),
    archiveSize: preflight.archiveSize,
    manifest,
    databasePath,
    attachmentsDirectory,
    totalPayloadBytes,
    stagingDirectory,
  };
}

/**
 * Creates a self-contained Wheat backup. The database should already be
 * checkpointed/disconnected by the integration layer. Sources are snapshotted
 * into a private staging directory, validated, hashed, then archived. Existing
 * destinations are never replaced.
 */
export async function createWheatBackup(options: CreateWheatBackupOptions): Promise<WheatBackupSummary> {
  const limits = resolveLimits(options.limits);
  const destinationPath = path.resolve(options.destinationPath);
  const sourceDatabasePath = path.resolve(options.databasePath);
  assertBackupExtension(destinationPath);
  if (sourceDatabasePath === destinationPath) {
    throw new Error("Wheat backup destination cannot be the live database.");
  }
  if (typeof options.appVersion !== "string" || !options.appVersion.trim() || options.appVersion.length > 100) {
    throw new Error("A valid Wheat appVersion is required for the backup manifest.");
  }
  await assertRegularNonSymlink(sourceDatabasePath, "Wheat database");
  for (const suffix of ["-wal", "-journal"]) {
    const sidecarPath = `${sourceDatabasePath}${suffix}`;
    const sidecarStat = await fsp.lstat(sidecarPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (sidecarStat && (!sidecarStat.isFile() || sidecarStat.size > 0)) {
      throw new Error(
        `Wheat database has an active ${suffix.slice(1)} sidecar. Disconnect and checkpoint it before backup.`,
      );
    }
  }

  const attachmentPaths = [...(options.managedAttachmentPaths ?? [])];
  if (attachmentPaths.length + 2 > limits.maxEntries) {
    throw new Error("Wheat backup exceeds the entry-count limit.");
  }
  if (attachmentPaths.length && !options.managedAttachmentsRoot) {
    throw new Error("managedAttachmentsRoot is required when attachments are included.");
  }

  let attachmentsRoot: string | undefined;
  if (options.managedAttachmentsRoot) {
    const rootStat = await fsp.lstat(options.managedAttachmentsRoot).catch((error: unknown) => {
      throw new Error(`Managed attachments root is unavailable. ${errorMessage(error)}`);
    });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Managed attachments root must be a real directory, not a symbolic link.");
    }
    attachmentsRoot = await fsp.realpath(options.managedAttachmentsRoot);
  }

  const workingParent = options.workingDirectory ? path.resolve(options.workingDirectory) : os.tmpdir();
  const stagingDirectory = await makePrivateTemporaryDirectory(workingParent, "wheat-backup-create-");
  try {
    const stagedDatabasePath = toAbsoluteStagedPath(stagingDirectory, WHEAT_BACKUP_DATABASE_PATH);
    await fsp.mkdir(path.dirname(stagedDatabasePath), { recursive: true, mode: 0o700 });
    await copyStableFile(sourceDatabasePath, stagedDatabasePath, "Wheat database");
    validateWheatSqliteDatabase(stagedDatabasePath);

    const stagedFiles: Array<{ sourcePath: string; archivePath: string }> = [];
    const manifestFiles: WheatBackupFileManifest[] = [];
    const fileKeys = new Set<string>();
    const ancestorKeys = new Set<string>();

    assertNoFileCollision(WHEAT_BACKUP_DATABASE_PATH, fileKeys, ancestorKeys, "Wheat backup input");
    const databaseHash = await hashFile(stagedDatabasePath, limits.maxFileBytes);
    stagedFiles.push({ sourcePath: stagedDatabasePath, archivePath: WHEAT_BACKUP_DATABASE_PATH });
    manifestFiles.push({ path: WHEAT_BACKUP_DATABASE_PATH, kind: "database", ...databaseHash });

    for (const attachmentCandidate of attachmentPaths) {
      const relativePath = relativeAttachmentPath(attachmentCandidate);
      const archivePath = `attachments/${relativePath}`;
      assertSafeArchivePath(archivePath, "Managed attachment archive entry");
      assertNoFileCollision(archivePath, fileKeys, ancestorKeys, "Wheat backup input");
      if (!attachmentsRoot) throw new Error("Managed attachments root is required.");
      await assertNoSymlinkComponents(attachmentsRoot, relativePath);
      const sourcePath = await fsp.realpath(path.join(attachmentsRoot, ...relativePath.split("/")));
      if (!isPathInside(attachmentsRoot, sourcePath)) {
        throw new Error(`Managed attachment resolves outside the Wheat-owned root: ${relativePath}`);
      }
      await assertRegularNonSymlink(sourcePath, "Managed attachment");

      const stagedPath = toAbsoluteStagedPath(stagingDirectory, archivePath);
      await fsp.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
      await copyStableFile(sourcePath, stagedPath, "Managed attachment");
      const attachmentHash = await hashFile(stagedPath, limits.maxFileBytes);
      stagedFiles.push({ sourcePath: stagedPath, archivePath });
      manifestFiles.push({ path: archivePath, kind: "attachment", ...attachmentHash });
    }

    const totalPayloadBytes = manifestFiles.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalPayloadBytes) || totalPayloadBytes > limits.maxTotalBytes) {
      throw new Error("Wheat backup exceeds the total uncompressed-size limit.");
    }

    const createdAt = options.createdAt ?? new Date();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.valueOf())) {
      throw new Error("Wheat backup createdAt must be a valid Date.");
    }
    const manifest: WheatBackupManifest = {
      format: WHEAT_BACKUP_FORMAT,
      version: WHEAT_BACKUP_VERSION,
      backupId: randomUUID(),
      createdAt: createdAt.toISOString(),
      appVersion: options.appVersion.trim(),
      files: manifestFiles,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.length > limits.maxManifestBytes || manifestBytes.length > limits.maxFileBytes) {
      throw new Error("Wheat backup manifest exceeds its size limit.");
    }

    await writeArchive(destinationPath, stagedFiles, manifestBytes);
    const archiveStat = await fsp.stat(destinationPath);
    if (archiveStat.size > limits.maxArchiveBytes) {
      await fsp.rm(destinationPath, { force: true });
      throw new Error("Created Wheat backup exceeds the compressed-size limit.");
    }

    try {
      const verified = await validateWheatBackup(destinationPath, { limits, workingDirectory: workingParent });
      if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) {
        throw new Error("Created Wheat backup manifest changed during verification.");
      }
    } catch (error) {
      await fsp.rm(destinationPath, { force: true }).catch(() => undefined);
      throw new Error(`Wheat could not verify the newly created backup. ${errorMessage(error)}`, { cause: error });
    }

    return {
      archivePath: destinationPath,
      archiveSize: archiveStat.size,
      manifest,
      totalPayloadBytes,
    };
  } finally {
    await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Extracts only into a new, private, uniquely named directory and returns it to
 * the caller. This function never replaces the live database or attachment
 * directory; the integration layer can perform its own transactional swap only
 * after this function succeeds.
 */
export async function extractWheatBackupToStaging(options: ExtractWheatBackupOptions): Promise<StagedWheatBackup> {
  const limits = resolveLimits(options.limits);
  const archivePath = path.resolve(options.archivePath);
  const parent = options.stagingParentDirectory
    ? path.resolve(options.stagingParentDirectory)
    : options.workingDirectory
      ? path.resolve(options.workingDirectory)
      : os.tmpdir();
  const stagingDirectory = await makePrivateTemporaryDirectory(parent, "wheat-backup-restore-");
  try {
    return await extractAndValidate(archivePath, stagingDirectory, limits);
  } catch (error) {
    await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Fully validates an archive in disposable staging and leaves no extracted data behind. */
export async function validateWheatBackup(
  archivePath: string,
  options: ValidateWheatBackupOptions = {},
): Promise<WheatBackupSummary> {
  const staged = await extractWheatBackupToStaging({
    archivePath,
    limits: options.limits,
    stagingParentDirectory: options.workingDirectory,
  });
  try {
    return {
      archivePath: staged.archivePath,
      archiveSize: staged.archiveSize,
      manifest: staged.manifest,
      totalPayloadBytes: staged.totalPayloadBytes,
    };
  } finally {
    await fsp.rm(staged.stagingDirectory, { recursive: true, force: true });
  }
}
