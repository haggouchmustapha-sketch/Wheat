/**
 * Wheat's environment variables are named WHEAT_*.
 *
 * The pre-rename ATLAS_* names are still accepted as a fallback so an existing
 * developer shell, CI job or packaging script keeps working across the rename
 * instead of silently falling back to a default profile. This compatibility
 * layer is scheduled for removal in Wheat 2.3: delete LEGACY_ENVIRONMENT_NAMES
 * and this module's fallback branch, and the reads become plain lookups.
 */
export const LEGACY_ENVIRONMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  WHEAT_USER_DATA_DIR: "ATLAS_LEDGER_USER_DATA_DIR",
  WHEAT_CWD: "ATLAS_LEDGER_CWD",
  WHEAT_EXE: "ATLAS_LEDGER_EXE",
  WHEAT_UPDATES_DIR: "ATLAS_LEDGER_UPDATES_DIR",
  WHEAT_LOCAL_UPDATE_DIR: "ATLAS_LEDGER_LOCAL_UPDATE_DIR",
  WHEAT_UPDATE_FEED_URL: "ATLAS_LEDGER_UPDATE_FEED_URL",
  WHEAT_UPDATE_REPOSITORY: "ATLAS_LEDGER_UPDATE_REPOSITORY",
  WHEAT_UPDATE_PUBLIC_KEY: "ATLAS_LEDGER_UPDATE_PUBLIC_KEY",
  WHEAT_PADDLEOCR_PYTHON: "ATLAS_PADDLEOCR_PYTHON",
  WHEAT_PADDLEOCR_WORKER: "ATLAS_PADDLEOCR_WORKER",
  WHEAT_PADDLEOCR_LANG: "ATLAS_PADDLEOCR_LANG",
  WHEAT_PADDLEOCR_DEVICE: "ATLAS_PADDLEOCR_DEVICE",
  WHEAT_PADDLEOCR_ORIENTATION: "ATLAS_PADDLEOCR_ORIENTATION",
  WHEAT_PADDLEOCR_DETECTION_MODEL: "ATLAS_PADDLEOCR_DETECTION_MODEL",
  WHEAT_PADDLEOCR_RECOGNITION_MODEL: "ATLAS_PADDLEOCR_RECOGNITION_MODEL",
});

/** Reads a WHEAT_* variable, falling back to its pre-rename ATLAS_* name. */
export function readWheatEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  const current = env[name];
  if (current !== undefined) return current;
  const legacy = LEGACY_ENVIRONMENT_NAMES[name];
  return legacy === undefined ? undefined : env[legacy];
}

/**
 * Removes a Wheat variable under both its current and legacy names.
 *
 * Used where an inherited value must not cross a trust boundary — leaving the
 * legacy name behind would let it override the profile the boundary just chose.
 */
export function deleteWheatEnv(env: NodeJS.ProcessEnv, name: string) {
  delete env[name];
  const legacy = LEGACY_ENVIRONMENT_NAMES[name];
  if (legacy !== undefined) delete env[legacy];
}

/**
 * Resolves the given WHEAT_* names into a plain record, so a child process that
 * reads them directly still honours a value the caller set under a legacy
 * ATLAS_* name. Names with no value on either side are omitted.
 */
export function resolveWheatEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const resolved: Record<string, string> = {};
  for (const name of names) {
    const value = readWheatEnv(name, env);
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}
