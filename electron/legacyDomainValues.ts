/**
 * Values the pre-rename product wrote into user data.
 *
 * Wheat writes the current value everywhere and accepts the legacy one on read.
 * The stored values are deliberately never rewritten in place:
 *
 *  - `AuditEvent.action` is hashed into the SHA-256 audit chain (audit13.ts),
 *    so editing stored history would invalidate every company's chain;
 *  - backups and credit-note PDFs are immutable hashed artifacts, and an
 *    artifact's schema marker describes the format it was actually written in.
 *
 * Reading both is therefore the only correct option, not merely the cheaper
 * one. These pairs stay for as long as data written before the rename can still
 * be opened, which in an append-only ledger is indefinitely.
 */

export const WHEAT_AI_ORIGIN = "WHEAT_AI";
export const LEGACY_AI_ORIGIN = "ATLAS_AI";
export const WHEAT_UI_ORIGIN = "WHEAT_UI";
export const LEGACY_UI_ORIGIN = "ATLAS_LEDGER_UI";

/** True for entries and audit rows created by the assistant, before or after the rename. */
export function isWheatAiOrigin(value: unknown) {
  return value === WHEAT_AI_ORIGIN || value === LEGACY_AI_ORIGIN;
}

/** Both spellings of an origin, for `where: { in: [...] }` filters over mixed history. */
export function aiOriginValues() {
  return [WHEAT_AI_ORIGIN, LEGACY_AI_ORIGIN] as const;
}

export function uiOriginValues() {
  return [WHEAT_UI_ORIGIN, LEGACY_UI_ORIGIN] as const;
}

/**
 * Audit action and category names. New rows carry the WHEAT_ prefix; rows
 * written before the rename keep ATLAS_ forever, so anything searching audit
 * history by action must accept both spellings.
 */
export const LEGACY_AUDIT_PREFIX = "ATLAS_";
export const WHEAT_AUDIT_PREFIX = "WHEAT_";

/** Both spellings of an audit action, for history searches that span the rename. */
export function auditActionValues(action: string) {
  const bare = action.startsWith(WHEAT_AUDIT_PREFIX) ? action.slice(WHEAT_AUDIT_PREFIX.length) : action;
  return [`${WHEAT_AUDIT_PREFIX}${bare}`, `${LEGACY_AUDIT_PREFIX}${bare}`];
}

/** Backup archive markers. Wheat writes the first and restores any of them. */
export const WHEAT_BACKUP_FORMAT = "wheat-backup";
export const LEGACY_BACKUP_FORMATS = ["atlas-ledger-backup"] as const;
export const WHEAT_BACKUP_DATABASE_PATH = "database/wheat.sqlite";
export const LEGACY_BACKUP_DATABASE_PATHS = ["database/atlas-ledger.sqlite"] as const;

export function isSupportedBackupFormat(value: unknown) {
  return value === WHEAT_BACKUP_FORMAT || LEGACY_BACKUP_FORMATS.includes(value as never);
}

export function isBackupDatabasePath(value: string) {
  return value === WHEAT_BACKUP_DATABASE_PATH || LEGACY_BACKUP_DATABASE_PATHS.includes(value as never);
}

/**
 * The tag every OCR-sourced document carries. Documents scanned before the
 * rename keep the old tag, so document filters must match either.
 */
export const WHEAT_OCR_TAG = "wheat-vision-ocr";
export const LEGACY_OCR_TAG = "atlas-vision-ocr";

export function ocrTagValues() {
  return [WHEAT_OCR_TAG, LEGACY_OCR_TAG] as const;
}

export function hasOcrTag(tags: string | null | undefined) {
  if (!tags) return false;
  const parts = tags.split(",").map((tag) => tag.trim());
  return parts.includes(WHEAT_OCR_TAG) || parts.includes(LEGACY_OCR_TAG);
}

/**
 * Stored contract versions stamped into extracted OCR, reconciliation and
 * fiscal records. Existing records keep the ATLAS_ spelling and are still
 * interpreted, because the marker records the shape the row was written in.
 */
export const STORED_SCHEMA_VERSIONS = Object.freeze({
  invoice: { current: "WHEAT_INVOICE_1", legacy: ["ATLAS_INVOICE_1"] },
  bank: { current: "WHEAT_BANK_1", legacy: ["ATLAS_BANK_1"] },
  fiscal: { current: "WHEAT_FISCAL_1", legacy: ["ATLAS_FISCAL_1"] },
  fiscalCloseChecks: { current: "WHEAT_FISCAL_CLOSE_CHECKS_V1", legacy: ["ATLAS_FISCAL_CLOSE_CHECKS_V1"] },
  fiscalReopen: { current: "WHEAT_FISCAL_REOPEN_V1", legacy: ["ATLAS_FISCAL_REOPEN_V1"] },
  localModels: { current: "WHEAT_LOCAL_MODELS_1", legacy: ["ATLAS_LOCAL_MODELS_1"] },
});

export type StoredSchemaKind = keyof typeof STORED_SCHEMA_VERSIONS;

export function isKnownSchemaVersion(kind: StoredSchemaKind, value: unknown) {
  const entry = STORED_SCHEMA_VERSIONS[kind];
  return value === entry.current || entry.legacy.includes(value as string);
}

export function schemaVersionValues(kind: StoredSchemaKind) {
  const entry = STORED_SCHEMA_VERSIONS[kind];
  return [entry.current, ...entry.legacy];
}

/**
 * The seeded local administrator. The account is looked up by either address so
 * an existing installation keeps its one admin user instead of gaining a second
 * one beside it; only a fresh install creates the current address.
 */
export const WHEAT_ADMIN_EMAIL = "admin@wheat.local";
export const LEGACY_ADMIN_EMAILS = ["admin@atlasledger.local"] as const;

export function adminEmailValues() {
  return [WHEAT_ADMIN_EMAIL, ...LEGACY_ADMIN_EMAILS];
}
