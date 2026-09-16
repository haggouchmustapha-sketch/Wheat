import fs from "node:fs";
import path from "node:path";
import { signingBuilderOptions } from "./wheatSigning.mjs";

/**
 * The edition system, from the build side.
 *
 * `src/wheatEdition.ts` is the same knowledge for the running application.
 * Build scripts run as plain Node and cannot import the TypeScript module, so
 * the two facts they both need — the list of editions and the installer file
 * name — are stated here as well, and `tests/wheat-edition-unit.spec.cjs` loads
 * both and fails if they ever disagree. That is the same drift guard the
 * release signature payload uses, and for the same reason: two definitions of
 * one name eventually differ, and the failure mode of differing about an
 * installer name is an update that downloads a file which does not exist.
 */

export const WHEAT_EDITIONS = ["standard", "lightweight"];

export const EDITION_LABELS = {
  standard: "Standard",
  lightweight: "Lightweight",
};

export function assertEdition(value) {
  const edition = String(value ?? "").trim().toLowerCase();
  if (!WHEAT_EDITIONS.includes(edition)) {
    throw new Error(`Unknown Wheat edition "${value}". Valid editions are ${WHEAT_EDITIONS.join(", ")}.`);
  }
  return edition;
}

/** Must stay identical to `wheatInstallerFileName` in src/wheatEdition.ts. */
export function wheatInstallerFileName(edition, version) {
  return `Wheat-${EDITION_LABELS[assertEdition(edition)]}-${version}-Setup.exe`;
}

/**
 * Resources excluded from an edition's installer, by their `extraResources`
 * source path.
 *
 * Lightweight does not package the PaddleOCR runtime: two gigabytes of Python,
 * wheels and recognition models, which is essentially the whole difference in
 * installer size. It is excluded from the *package*, never deleted from the
 * repository and never installed-then-removed at runtime — Standard builds the
 * same commit and packages it exactly as before.
 */
const EXCLUDED_EXTRA_RESOURCES = {
  standard: [],
  lightweight: ["resources/paddleocr"],
};

function normalizeResourcePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * Composes the electron-builder configuration for one edition.
 *
 * The configuration in package.json stays the single base: an edition applies a
 * small, declarative difference to it rather than owning a second copy that
 * would slowly stop matching. Both editions therefore inherit every future
 * change to files, asarUnpack, NSIS behaviour and signing automatically.
 */
export function editionBuilderConfig(baseBuildConfig, edition, version, { root, env = process.env }) {
  const id = assertEdition(edition);
  if (!root) throw new Error("editionBuilderConfig needs the repository root: the signing configuration is read from the tree.");
  const excluded = new Set(EXCLUDED_EXTRA_RESOURCES[id].map(normalizeResourcePath));
  const extraResources = (baseBuildConfig.extraResources ?? []).filter((entry) => {
    const from = normalizeResourcePath(typeof entry === "string" ? entry : entry.from);
    return !excluded.has(from);
  });

  // Windows code signing is composed once and merged into both editions, so the
  // two installers can only ever carry the same publisher identity. Standard and
  // Lightweight are one product; a user who switches edition must not be told
  // they are installing software from somebody else, and SmartScreen publisher
  // reputation must accumulate across both rather than be split in half.
  const signing = signingBuilderOptions(root, env);

  return {
    ...baseBuildConfig,
    win: { ...baseBuildConfig.win, ...signing },
    // One identity, one install directory, one uninstall entry and one
    // %APPDATA%\Wheat for both editions. Switching edition is therefore an
    // ordinary in-place install that keeps the dossier, the documents, the
    // backups and the settings exactly where they were.
    appId: baseBuildConfig.appId,
    productName: baseBuildConfig.productName,
    artifactName: wheatInstallerFileName(id, version),
    extraResources,
    directories: { ...baseBuildConfig.directories, output: `release/${version}` },
  };
}

/** The installers of one prepared release, in a stable order. */
export function editionArtifactPaths(root, version) {
  return WHEAT_EDITIONS.map((edition) => ({
    edition,
    fileName: wheatInstallerFileName(edition, version),
    path: path.join(root, "release", version, wheatInstallerFileName(edition, version)),
  }));
}

export function readPackageBuildConfig(root) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!metadata.build) throw new Error("package.json has no electron-builder `build` configuration.");
  return { version: metadata.version, build: metadata.build };
}
