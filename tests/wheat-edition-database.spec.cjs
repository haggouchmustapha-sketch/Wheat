const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * One database format, two editions — and the proof.
 *
 * A dossier must not be able to tell which Wheat created it. That is what makes
 * "install the other edition over this one" an ordinary upgrade rather than a
 * migration, and it is the single property that, if it ever broke, would leave
 * an accountant with two Wheats and one set of books they can only half open.
 *
 * So this file opens a real SQLite database written by one edition, under the
 * other edition, and compares what is inside it — schema, migration history and
 * accounting rows.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const SEED = path.join(root, "prisma", "dev.db");

let edition;
let profile;

test.beforeAll(() => {
  edition = tsxRequire(path.join(root, "src", "wheatEdition.ts"), __filename);
  profile = tsxRequire(path.join(root, "electron", "profileMigration.ts"), __filename);
});

/** Opens a SQLite file through Prisma and reads it, whatever the edition. */
async function readDatabase(databasePath) {
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replaceAll("\\", "/")}` } } });
  try {
    const tables = await client.$queryRawUnsafe(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const indexes = await client.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const migrations = await client.$queryRawUnsafe(
      "SELECT migration_name FROM _prisma_migrations ORDER BY migration_name",
    ).catch(() => []);
    const companies = await client.company.findMany({ select: { id: true, name: true, ice: true }, orderBy: { id: "asc" } });
    const accounts = await client.account.count();
    const journals = await client.journal.count();
    return {
      tables: tables.map((row) => `${row.name}::${String(row.sql ?? "").replace(/\s+/g, " ").trim()}`),
      indexes: indexes.map((row) => row.name),
      migrations: migrations.map((row) => row.migration_name),
      companies,
      accounts,
      journals,
    };
  } finally {
    await client.$disconnect();
  }
}

test("the profile directory is the same for both editions", () => {
  // Both editions resolve %APPDATA%\Wheat. A per-edition profile would give a
  // user who switched a second, empty set of books — and the first set would
  // simply appear to have vanished.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-appdata-"));
  try {
    const resolved = profile.resolveProfileDirectory(appData);
    expect(path.basename(resolved.profileDirectory)).toBe("Wheat");
    expect(profile.WHEAT_PROFILE_DIRECTORY_NAME).toBe("Wheat");
    expect(profile.WHEAT_DATABASE_FILE_NAME).toBe("wheat.sqlite");
    // Nothing in the path resolution has any notion of an edition.
    const source = fs.readFileSync(path.join(root, "electron", "profileMigration.ts"), "utf8");
    expect(source).not.toMatch(/edition/i);
    const database = fs.readFileSync(path.join(root, "electron", "database.ts"), "utf8");
    expect(database).not.toMatch(/edition/i);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("a database written by one edition opens unchanged in the other", async () => {
  test.skip(!fs.existsSync(SEED), "the seeded development database is not present");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-edition-db-"));
  try {
    // Two copies of one real Wheat database — schema, migration history, chart
    // of accounts, journals and a dossier.
    const madeByStandard = path.join(workspace, "made-by-standard.sqlite");
    const madeByLightweight = path.join(workspace, "made-by-lightweight.sqlite");
    fs.copyFileSync(SEED, madeByStandard);
    fs.copyFileSync(SEED, madeByLightweight);

    // Read each one while this process *is* the other edition, so the assertion
    // is about an edition opening a foreign file and not about copying bytes.
    process.env.WHEAT_EDITION = "lightweight";
    expect(edition.resolveWheatEdition()).toBe("lightweight");
    const inLightweight = await readDatabase(madeByStandard);

    process.env.WHEAT_EDITION = "standard";
    expect(edition.resolveWheatEdition()).toBe("standard");
    const inStandard = await readDatabase(madeByLightweight);

    expect(inLightweight.tables).toEqual(inStandard.tables);
    expect(inLightweight.indexes).toEqual(inStandard.indexes);
    expect(inLightweight.migrations).toEqual(inStandard.migrations);
    expect(inLightweight.companies).toEqual(inStandard.companies);
    expect(inLightweight.accounts).toBe(inStandard.accounts);
    expect(inLightweight.journals).toBe(inStandard.journals);

    // And it is a real accounting database, not an empty file that would make
    // the comparison above vacuous.
    expect(inStandard.tables.length).toBeGreaterThan(15);
    expect(inStandard.accounts).toBeGreaterThan(10);
    expect(inStandard.migrations.length).toBeGreaterThan(0);
  } finally {
    delete process.env.WHEAT_EDITION;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("no migration is conditional on an edition", () => {
  const migrations = path.join(root, "prisma", "migrations");
  test.skip(!fs.existsSync(migrations), "no migrations directory");
  const offenders = [];
  for (const entry of fs.readdirSync(migrations)) {
    const sql = path.join(migrations, entry, "migration.sql");
    if (!fs.existsSync(sql)) continue;
    const source = fs.readFileSync(sql, "utf8");
    // Deliberately not the bare word "standard": the chart of accounts has
    // `isStandard` and `standardVersion` columns for CGNC standard accounts,
    // which have nothing to do with a Wheat edition.
    if (/edition|lightweight|wheat[_-]?edition/i.test(source)) offenders.push(entry);
  }
  // A migration that branched on an edition would be two database formats
  // wearing one name, which is the failure this whole file exists to exclude.
  expect(offenders).toEqual([]);
});
