import fs from "node:fs";
import path from "node:path";

export const WHEAT_PROFILE_DIRECTORY_NAME = "Wheat";
export const LEGACY_PROFILE_DIRECTORY_NAME = "Atlas Ledger";

export const WHEAT_DATABASE_FILE_NAME = "wheat.sqlite";
export const LEGACY_DATABASE_FILE_NAME = "atlas-ledger.sqlite";

/**
 * Profile files that carry the old product name. Renamed in place after the
 * directory itself has moved, and re-attempted on every launch so an
 * interrupted migration simply finishes the next time Wheat starts.
 *
 * The SQLite sidecars travel with the database: a hot write-ahead log holds
 * committed transactions, and SQLite locates it by the database's own name, so
 * the three must keep matching stems.
 */
const LEGACY_PROFILE_FILES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [LEGACY_DATABASE_FILE_NAME, WHEAT_DATABASE_FILE_NAME],
  [`${LEGACY_DATABASE_FILE_NAME}-wal`, `${WHEAT_DATABASE_FILE_NAME}-wal`],
  [`${LEGACY_DATABASE_FILE_NAME}-shm`, `${WHEAT_DATABASE_FILE_NAME}-shm`],
  ["atlas-ledger-main-errors.log", "wheat-main-errors.log"],
  ["atlas-ledger-startup.log", "wheat-startup.log"],
];

/**
 * Directories renamed inside the profile. The downloaded-model cache cannot
 * simply become "wheat-ai": that name is already taken by the AI provider
 * credential store, and merging the two would mix unrelated state.
 */
const LEGACY_PROFILE_DIRECTORIES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["atlas-ai", "wheat-ai-models"],
];

export type ProfileMigrationResult = {
  /** The directory Wheat should use as userData for this launch. */
  profileDirectory: string;
  /** Human-readable record of what the migration did, for the profile log. */
  events: string[];
};

function isDirectory(target: string) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the profile directory, moving a pre-Wheat profile across if needed.
 *
 * The move is a single same-volume `rename`, which the filesystem performs
 * atomically: the profile is either entirely at the old path or entirely at the
 * new one, never split across both. If the rename fails — most plausibly
 * because another Wheat still holds the database open — nothing has moved, and
 * this returns the legacy directory so the dossier opens normally rather than
 * the app starting on an empty database.
 *
 * When both directories exist the new one wins and the legacy one is left
 * untouched; the two are never merged.
 */
export function resolveProfileDirectory(appDataDirectory: string): ProfileMigrationResult {
  const target = path.join(appDataDirectory, WHEAT_PROFILE_DIRECTORY_NAME);
  const legacy = path.join(appDataDirectory, LEGACY_PROFILE_DIRECTORY_NAME);
  const events: string[] = [];
  const legacyExists = isDirectory(legacy);

  if (isDirectory(target)) {
    if (legacyExists) events.push(`legacy-profile-ignored path="${legacy}" reason="current profile already exists"`);
  } else if (legacyExists) {
    try {
      fs.renameSync(legacy, target);
      events.push(`profile-moved from="${legacy}" to="${target}"`);
    } catch (error) {
      events.push(`profile-move-failed from="${legacy}" reason="${describe(error)}" continuing-with="${legacy}"`);
      return { profileDirectory: legacy, events };
    }
  }

  events.push(...completeLegacyFileRenames(target));
  return { profileDirectory: target, events };
}

/**
 * Idempotent second half of the migration. A crash between the directory move
 * and these renames leaves the database under its old name; running this on
 * every launch repairs that, and `resolveProfileDatabaseFile` opens the old
 * name meanwhile so no data is ever out of reach.
 */
function completeLegacyFileRenames(directory: string) {
  const events: string[] = [];
  if (!isDirectory(directory)) return events;
  for (const [legacyName, currentName] of [...LEGACY_PROFILE_FILES, ...LEGACY_PROFILE_DIRECTORIES]) {
    const from = path.join(directory, legacyName);
    const to = path.join(directory, currentName);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
      events.push(`profile-entry-renamed from="${legacyName}" to="${currentName}"`);
    } catch (error) {
      events.push(`profile-entry-rename-failed entry="${legacyName}" reason="${describe(error)}"`);
    }
  }
  return events;
}

/**
 * The database file inside a profile directory, tolerating a migration that was
 * interrupted before the file rename completed.
 */
export function resolveProfileDatabaseFile(directory: string) {
  const current = path.join(directory, WHEAT_DATABASE_FILE_NAME);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(directory, LEGACY_DATABASE_FILE_NAME);
  return fs.existsSync(legacy) ? legacy : current;
}

/** Appends migration events to the profile's own log; never throws. */
export function recordProfileMigration(profileDirectory: string, events: readonly string[]) {
  if (events.length === 0) return;
  try {
    fs.mkdirSync(profileDirectory, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(
      path.join(profileDirectory, "wheat-profile-migration.log"),
      `${events.map((event) => `[${stamp}] ${event}`).join("\n")}\n`,
    );
  } catch {
    // A profile log that cannot be written must not stop Wheat from starting.
  }
}
