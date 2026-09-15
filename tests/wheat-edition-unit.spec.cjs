const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The edition system: identity, resource policy, packaging, and the guarantee
 * that none of it reaches accounting.
 *
 * Wheat Standard and Wheat Lightweight are one product built twice. The whole
 * point of this file is to pin down where that difference is *allowed* to show
 * up — packaging, recognition strategy, resource budgets, presentation — and to
 * prove it does not show up anywhere else.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let edition;
let editions;

test.beforeAll(async () => {
  edition = tsxRequire(path.join(root, "src", "wheatEdition.ts"), __filename);
  editions = await import(pathToFileUrl(path.join(root, "scripts", "lib", "wheatEditions.mjs")));
});

function pathToFileUrl(target) {
  return new URL(`file://${target.replaceAll("\\", "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
}

/* ------------------------------------------------------------- resolution */

test("resolves both editions and refuses anything else", () => {
  expect(edition.resolveWheatEdition("standard")).toBe("standard");
  expect(edition.resolveWheatEdition("lightweight")).toBe("lightweight");
  expect(edition.resolveWheatEdition("Lightweight")).toBe("lightweight");
  expect(edition.resolveWheatEdition("  standard  ")).toBe("standard");
});

test("an unknown edition fails loudly rather than silently becoming Standard", () => {
  // A build that names an edition Wheat does not know is a build mistake. It
  // must stop, not quietly run as Standard while its installer, its updater
  // asset and the website's download button all say something else.
  expect(() => edition.resolveWheatEdition("lite")).toThrow(/unknown edition/i);
  expect(() => edition.resolveWheatEdition("pro")).toThrow(/unknown edition/i);
  expect(() => edition.resolveWheatEdition("")).toThrow(/unknown edition/i);
});

test("nothing configured at all is Standard, which is what Wheat has always been", () => {
  expect(edition.resolveWheatEdition(null)).toBe("standard");
});

test("the running edition is a constant, not something a caller can change", () => {
  const before = edition.WHEAT_EDITION;
  expect(edition.WHEAT_EDITIONS).toContain(before);
  // Resolving another edition's profile must not move the module's own idea of
  // which edition this is.
  edition.wheatEditionProfile("lightweight");
  edition.wheatEditionProfile("standard");
  expect(edition.WHEAT_EDITION).toBe(before);
  expect(edition.WHEAT_EDITION_PROFILE.edition).toBe(before);
});

/* ---------------------------------------------------------------- profiles */

test("Standard packages local recognition; Lightweight does not", () => {
  expect(edition.wheatEditionProfile("standard").hasBundledLocalOcr).toBe(true);
  expect(edition.wheatEditionProfile("lightweight").hasBundledLocalOcr).toBe(false);
});

test("Lightweight is the conservative resource profile", () => {
  const standard = edition.wheatEditionProfile("standard").resource;
  const lightweight = edition.wheatEditionProfile("lightweight").resource;
  expect(lightweight.maxOcrConcurrency).toBeLessThan(standard.maxOcrConcurrency);
  expect(lightweight.recognitionCacheLimit).toBeLessThan(standard.recognitionCacheLimit);
  expect(lightweight.warmLocalOcrAtStartup).toBe(false);
  expect(standard.warmLocalOcrAtStartup).toBe(true);
});

test("neither edition is named or described as a lesser product", () => {
  for (const id of edition.WHEAT_EDITIONS) {
    const profile = edition.wheatEditionProfile(id);
    expect(profile.label).not.toMatch(/lite|basique|r[ée]duit|limit[ée]|basic/i);
    expect(profile.summary).toMatch(/fonctionnalit[ée]s comptables/i);
  }
  // Both summaries promise the same accounting capability.
  expect(edition.wheatEditionProfile("lightweight").summary).toMatch(/Toutes les fonctionnalit[ée]s comptables/i);
});

/* ------------------------------------------------------------- artifacts */

test("installer names carry the edition and share one version", () => {
  expect(edition.wheatInstallerFileName("standard", "2.7.0")).toBe("Wheat-Standard-2.7.0-Setup.exe");
  expect(edition.wheatInstallerFileName("lightweight", "2.7.0")).toBe("Wheat-Lightweight-2.7.0-Setup.exe");
});

test("the application and the build scripts agree on every installer name", () => {
  // Two definitions of one name eventually differ, and the failure mode of
  // differing about an installer name is an update that downloads a file which
  // does not exist. This is the guard that keeps them identical.
  for (const id of edition.WHEAT_EDITIONS) {
    for (const version of ["2.7.0", "2.1.2609082", "10.0.1"]) {
      expect(editions.wheatInstallerFileName(id, version)).toBe(edition.wheatInstallerFileName(id, version));
    }
  }
  expect([...editions.WHEAT_EDITIONS].sort()).toEqual([...edition.WHEAT_EDITIONS].sort());
});

/* -------------------------------------------------------------- packaging */

test("the Lightweight package excludes the local recognition runtime and nothing else", () => {
  const { version, build } = editions.readPackageBuildConfig(root);
  const standard = editions.editionBuilderConfig(build, "standard", version);
  const lightweight = editions.editionBuilderConfig(build, "lightweight", version);

  const names = (config) => config.extraResources.map((entry) => (typeof entry === "string" ? entry : entry.from));
  expect(names(standard)).toContain("resources/paddleocr");
  expect(names(lightweight)).not.toContain("resources/paddleocr");

  // Everything else both editions need is still packaged in both: the seed
  // database, the Tesseract fallback data, the model manifest, the updater
  // helper. Excluding one of those would be a feature difference, not a
  // resource difference.
  for (const shared of names(lightweight)) expect(names(standard)).toContain(shared);
  expect(names(standard).length - names(lightweight).length).toBe(1);
  for (const config of [standard, lightweight]) {
    expect(names(config)).toContain("resources/tessdata");
    expect(names(config)).toContain("prisma/dev.db");
  }
});

test("both editions keep one Windows identity, one install directory and one profile", () => {
  const { version, build } = editions.readPackageBuildConfig(root);
  const standard = editions.editionBuilderConfig(build, "standard", version);
  const lightweight = editions.editionBuilderConfig(build, "lightweight", version);

  // This is what makes switching edition an ordinary in-place install that
  // keeps the dossier, the documents, the backups and the settings. A second
  // appId or productName would give the other edition its own %APPDATA%,
  // its own uninstall entry, and a user with two Wheats and one set of books.
  expect(lightweight.appId).toBe(standard.appId);
  expect(lightweight.productName).toBe(standard.productName);
  expect(lightweight.nsis).toEqual(standard.nsis);
  expect(lightweight.files).toEqual(standard.files);
  expect(lightweight.asarUnpack).toEqual(standard.asarUnpack);
  expect(lightweight.directories.output).toBe(standard.directories.output);

  // Only the artifact name differs, and it differs by the edition word.
  expect(standard.artifactName).toBe(editions.wheatInstallerFileName("standard", version));
  expect(lightweight.artifactName).toBe(editions.wheatInstallerFileName("lightweight", version));
});

test("an unknown edition cannot produce a package configuration", () => {
  const { version, build } = editions.readPackageBuildConfig(root);
  expect(() => editions.editionBuilderConfig(build, "lite", version)).toThrow(/Unknown Wheat edition/);
});

/* --------------------------------------------------- the parity guarantee */

test("no accounting module consults the edition", () => {
  /*
   * The rule this repository must never break: the edition decides packaging,
   * recognition strategy, resource budgets and presentation — never what a
   * number is. A `WHEAT_EDITION` read inside a posting, balance, VAT, journal,
   * report or reconciliation module would be an accounting difference between
   * two builds of the same product, and there is no version of that which is
   * acceptable.
   *
   * So the accounting modules are listed, and they are read.
   */
  const accounting = [
    "accounting.ts", "subledger.ts", "reconciliation.ts", "reporting.ts", "reporting21.ts",
    "fiscal21.ts", "compliance14.ts", "creditNotes14.ts", "entryCommands21.ts", "operations13.ts",
    "chartOfAccounts21.ts", "pieceNumbering21.ts", "audit13.ts", "database.ts", "dashboard.ts",
    "portfolio.ts", "bankStatementImporter.ts", "importValidation.ts", "wheatDossierSetup.ts",
  ];
  const offenders = [];
  for (const file of accounting) {
    const target = path.join(root, "electron", file);
    if (!fs.existsSync(target)) continue;
    const source = fs.readFileSync(target, "utf8");
    if (/WHEAT_EDITION|wheatEdition|WheatEdition/.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("the Prisma schema and its migrations are edition-blind", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  expect(schema).not.toMatch(/edition/i);

  const migrationsDirectory = path.join(root, "prisma", "migrations");
  if (!fs.existsSync(migrationsDirectory)) return;
  const offenders = [];
  for (const entry of fs.readdirSync(migrationsDirectory)) {
    const sql = path.join(migrationsDirectory, entry, "migration.sql");
    if (!fs.existsSync(sql)) continue;
    if (/edition/i.test(fs.readFileSync(sql, "utf8"))) offenders.push(entry);
  }
  // A single database format for both editions means no migration may ever
  // branch on one. A dossier must not be able to tell which Wheat made it.
  expect(offenders).toEqual([]);
});

test("the edition never reaches the renderer as an environment value", () => {
  const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  expect(preload).not.toMatch(/process\.env/);
  // It crosses through one controlled channel, and only that one.
  expect(preload).toMatch(/wheat:app:edition/);
});
