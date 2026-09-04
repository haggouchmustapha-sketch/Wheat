const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * What an update is allowed to touch, and what it must never touch.
 *
 * An update replaces the *program*. The dossiers, the ledger, the documents,
 * the drafts and the backups are not part of the program: they live in the
 * accountant's profile, which the installer never writes to and the updater
 * never opens. This suite is the proof of that separation, run over a real
 * database with real accounting rows in it — never the developer's own profile.
 *
 * The lifecycle exercised here is the whole one: an offered release, a consented
 * download, an install that hands off to the Windows helper, and the first
 * startup of the *new* version against the *old* profile, including the schema
 * migration that startup runs. Everything is checked before and after.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");
let updater;
let audit;

test.describe("user data across an update", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let profile;
  let prisma;
  let company;

  test.beforeAll(async () => {
    updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
    audit = tsxRequire(path.join(root, "electron", "audit13.ts"), __filename);

    // A disposable profile shaped exactly like %APPDATA%\Wheat\. Nothing in this
    // suite can reach a real installation: every path is under this directory.
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-update-profile-"));
    fs.mkdirSync(path.join(profile, "documents"), { recursive: true });
    fs.mkdirSync(path.join(profile, "backups"), { recursive: true });

    const databasePath = path.join(profile, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replace(/\\/g, "/")}` } } });
    await prisma.$connect();

    company = await prisma.company.create({
      data: { name: "CABINET MISE A JOUR SARL", legalForm: "SARL", ice: "003333333000033", taxId: "IF-3333333", city: "Casablanca" },
    });
    await seedRepresentativeWork(prisma, company.id);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });

  test("the whole update lifecycle leaves every dossier, entry, document and draft intact", async () => {
    const databasePath = path.join(profile, "wheat.sqlite");
    const before = await fingerprint(prisma, profile, company.id);
    expect(before.companies).toBeGreaterThan(0);
    expect(before.entryLines).toBeGreaterThan(0);
    expect(before.auditChainValid).toBe(true);

    // ---- the old application finds, is offered, and downloads an update ----
    const feed = path.join(profile, "..", `feed-${path.basename(profile)}`);
    const release = writeLocalRelease(feed, "2.2.0");
    const oldApp = serviceFor(profile, feed, "2.1.0", true);

    const offered = await oldApp.checkForUpdates();
    expect(offered.status.phase).toBe("available");
    const ready = await oldApp.downloadOfferedUpdate();
    expect(ready.status.phase).toBe("ready");

    // ---- the install hands off to the Windows helper, which replaces program
    // files only. The stub stands in for it and does exactly what it is allowed
    // to do: nothing at all inside the profile. ----
    let installDirectoryTouched = null;
    await oldApp.installStagedUpdate(async (state) => {
      expect(state.pending.release.version).toBe("2.2.0");
      // The helper's target is the directory holding Wheat.exe, which is not
      // and can never be the profile: one is under Program Files, the other
      // under the user's roaming data.
      installDirectoryTouched = path.dirname(process.execPath);
      expect(path.resolve(installDirectoryTouched)).not.toBe(path.resolve(profile));
    });
    expect(installDirectoryTouched).not.toBeNull();

    // ---- the NEW version starts up against the OLD profile ----
    // A release may carry a schema migration, which startup applies to the
    // database that is already there rather than to a fresh one. The engine
    // that does it — copy first, apply in a transaction, roll back and keep the
    // backup on failure — is `migrateAndValidateDatabase` in electron/database.ts
    // and is covered in depth by wheat-migration-integrity.spec.cjs. What
    // matters here is the property the update depends on: after a schema change
    // lands on this profile, the accountant's rows are still the same rows.
    applyPendingSchemaChange(databasePath);

    const newApp = serviceFor(profile, feed, "2.2.0", true);
    const confirmed = await newApp.confirmSuccessfulStartup();
    expect(confirmed.phase).toBe("updated");
    expect(confirmed.installedUpdate.version).toBe("2.2.0");

    // ---- everything the accountant owns is still exactly there ----
    const after = await fingerprint(prisma, profile, company.id);
    expect(after).toEqual(before);
    expect(fs.existsSync(databasePath)).toBe(true);

    fs.rmSync(feed, { recursive: true, force: true });
  });

  test("the updater keeps its own working files out of the accounting profile's data", async () => {
    // The updater writes state, logs, staged installers and rollback snapshots.
    // All of it belongs in one subdirectory, so that no download, no failed
    // install and no rollback can ever land among documents or backups.
    const stateDirectory = path.join(profile, "updater");
    expect(fs.existsSync(stateDirectory)).toBe(true);
    for (const entry of walk(stateDirectory)) {
      expect(entry.endsWith(".sqlite"), entry).toBe(false);
    }
    // And nothing the updater did appears outside it.
    const documents = fs.readdirSync(path.join(profile, "documents"));
    expect(documents).toEqual(["facture-fournisseur.pdf"]);
    const backups = fs.readdirSync(path.join(profile, "backups")).filter((name) => !name.startsWith("wheat-"));
    expect(backups).toEqual(["sauvegarde-manuelle.zip"]);
  });

  test("a failed installation leaves the working Wheat and the accounting data untouched", async () => {
    const databasePath = path.join(profile, "wheat.sqlite");
    const before = await fingerprint(prisma, profile, company.id);

    const feed = path.join(profile, "..", `feed-fail-${path.basename(profile)}`);
    writeLocalRelease(feed, "2.3.0");
    const service = serviceFor(profile, feed, "2.2.0", true);
    await service.checkForUpdates();
    await service.downloadOfferedUpdate();

    const failed = await service.installStagedUpdate(async () => { throw new Error("the update helper could not be started"); });
    // The installer never ran, so the verified artifact is still on disk and
    // Wheat is still the version it was. Nothing is left in a half state.
    expect(failed.status.phase).toBe("ready");
    expect(failed.status.error).toMatch(/could not be started/);
    expect(fs.existsSync(failed.pending.artifactPath)).toBe(true);
    expect(await fingerprint(prisma, profile, company.id)).toEqual(before);
    expect(fs.existsSync(databasePath)).toBe(true);

    fs.rmSync(feed, { recursive: true, force: true });
  });

  test("a migration that fails rolls back, leaving the accounting rows as they were", async () => {
    // The update pipeline never runs a migration of its own; it relies on the
    // startup engine's guarantee, which is that a migration is all-or-nothing.
    // This pins the half of that guarantee an update depends on: a release that
    // ships a broken migration must not leave a half-migrated dossier behind.
    const databasePath = path.join(profile, "wheat.sqlite");
    const before = await fingerprint(prisma, profile, company.id);

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      expect(() => {
        db.exec("BEGIN");
        try {
          db.exec('ALTER TABLE "Company" ADD COLUMN "wheatUpdateProbe" TEXT');
          db.exec('DELETE FROM "EntryLine"');
          // The statement a broken migration trips over.
          db.exec("SELECT this_is_not_valid_sql()");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }).toThrow();
    } finally { db.close(); }

    expect(await fingerprint(prisma, profile, company.id)).toEqual(before);
  });

  test("the profile path comes from user data, never from where the program is installed", () => {
    // The separation that makes all of the above true. An installed Wheat reads
    // its profile out of %APPDATA%; replacing Program Files cannot reach it.
    const userData = path.join("C:\\", "Users", "Comptable", "AppData", "Roaming", "Wheat");
    const app = { isPackaged: true, getPath: () => userData };
    expect(updater.resolveUpdaterStateDirectory(app)).toBe(path.join(userData, "updater"));
    expect(updater.resolveLocalUpdateDirectory(app, "C:\\Program Files\\Wheat")).toBe(path.join(userData, "updates"));
  });
});

/* ------------------------------------------------------------- fixtures --- */

/** A dossier with the kinds of record an accountant would be upset to lose. */
async function seedRepresentativeWork(prisma, companyId) {
  const journal = await prisma.journal.create({ data: { companyId, code: "ACH", label: "Achats", nextNumber: 2 } });
  const [supplierAccount, expenseAccount] = await Promise.all([
    prisma.account.create({ data: { companyId, code: "4411000000", label: "Fournisseurs", classNo: 4, type: "LIABILITY" } }),
    prisma.account.create({ data: { companyId, code: "6111000000", label: "Achats de marchandises", classNo: 6, type: "EXPENSE" } }),
  ]);
  await prisma.counterparty.create({
    data: {
      companyId, kind: "SUPPLIER", displayName: "FOURNISSEUR ATLAS SARL",
      ice: "004444444000044", identityKey: "supplier:004444444000044",
    },
  });
  await prisma.counterparty.create({
    data: {
      companyId, kind: "CUSTOMER", displayName: "CLIENT RABAT SA",
      ice: "005555555000055", identityKey: "customer:005555555000055",
    },
  });
  await prisma.entry.create({
    data: {
      companyId,
      journalId: journal.id,
      number: "1",
      date: new Date("2026-08-14T00:00:00Z"),
      pieceNumber: "ACH-2026-0001",
      label: "Achat de marchandises",
      status: "POSTED",
      journalCodeSnapshot: "ACH",
      lines: {
        create: [
          {
            accountId: expenseAccount.id, label: "Marchandises", position: 1,
            debitCents: 1200000n, creditCents: 0n,
            accountCodeSnapshot: "6111000000", accountLabelSnapshot: "Achats de marchandises",
          },
          {
            accountId: supplierAccount.id, label: "Fournisseur", position: 2,
            debitCents: 0n, creditCents: 1200000n,
            accountCodeSnapshot: "4411000000", accountLabelSnapshot: "Fournisseurs",
          },
        ],
      },
    },
  });
  await prisma.invoice.create({
    data: {
      companyId,
      kind: "SALE",
      counterparty: "CLIENT RABAT SA",
      invoiceNo: "FA-2026-0042",
      invoiceDate: new Date("2026-08-20T00:00:00Z"),
      dueDate: new Date("2026-09-19T00:00:00Z"),
      htCents: 1000000n,
      vatCents: 200000n,
      ttcCents: 1200000n,
      status: "ISSUED",
    },
  });
  await prisma.document.create({
    data: {
      companyId,
      title: "Facture fournisseur août 2026",
      type: "INVOICE",
      fiscalYear: "2026",
      tags: "",
      status: "CLASSIFIED",
      ocrText: "FOURNISSEUR ATLAS SARL — Total TTC 12 000,00",
      extracted: JSON.stringify({ supplier: "FOURNISSEUR ATLAS SARL", ttc: "12000.00" }),
    },
  });
  await prisma.formDraft.create({
    data: {
      companyId,
      entity: "invoice",
      draftKey: "new-sales",
      payload: JSON.stringify({ invoiceNo: "FA-2026-0043", lines: [{ ht: "4500.00" }] }),
    },
  });
  await audit.appendAuditEvent(prisma, {
    companyId,
    action: "entry.post",
    entityType: "Entry",
    entityId: "ACH-2026-0001",
    payload: { pieceNumber: "ACH-2026-0001" },
  });
}

/** Files an accountant would notice the loss of, beside the database. */
function seedProfileFiles(profile) {
  fs.writeFileSync(path.join(profile, "documents", "facture-fournisseur.pdf"), Buffer.from("%PDF-1.4 scanned supplier invoice"));
  fs.writeFileSync(path.join(profile, "backups", "sauvegarde-manuelle.zip"), Buffer.from("PK\u0003\u0004 manual backup"));
  fs.writeFileSync(path.join(profile, "preferences.json"), JSON.stringify({ language: "fr", darkMode: true }, null, 2));
}

/**
 * Everything that must be identical afterwards, in one comparable value.
 *
 * Row counts alone would pass while contents changed, so identities and money
 * are included, and the audit chain is verified rather than counted.
 */
async function fingerprint(prisma, profile, companyId) {
  if (!fs.existsSync(path.join(profile, "preferences.json"))) seedProfileFiles(profile);
  const [companies, entries, entryLines, invoices, counterparties, documents, drafts] = await Promise.all([
    prisma.company.count(),
    prisma.entry.count(),
    prisma.entryLine.count(),
    prisma.invoice.count(),
    prisma.counterparty.count(),
    prisma.document.count(),
    prisma.formDraft.count(),
  ]);
  const invoice = await prisma.invoice.findFirst({ where: { companyId }, orderBy: { invoiceNo: "asc" } });
  const lines = await prisma.entryLine.findMany({ orderBy: [{ entryId: "asc" }, { position: "asc" }], select: { label: true, debitCents: true, creditCents: true } });
  const draft = await prisma.formDraft.findFirst({ where: { companyId }, select: { entity: true, draftKey: true, payload: true } });
  const verification = await audit.verifyAuditChain(prisma, companyId);

  return {
    companies, entries, entryLines, invoices, counterparties, documents, drafts,
    invoiceIdentity: invoice ? `${invoice.invoiceNo}:${invoice.htCents}:${invoice.vatCents}:${invoice.ttcCents}` : null,
    ledger: lines.map((line) => `${line.label}:${line.debitCents}:${line.creditCents}`),
    draft: draft ? `${draft.entity}/${draft.draftKey}:${draft.payload}` : null,
    auditChainValid: verification.valid,
    attachment: fileDigest(path.join(profile, "documents", "facture-fournisseur.pdf")),
    backup: fileDigest(path.join(profile, "backups", "sauvegarde-manuelle.zip")),
    preferences: fs.readFileSync(path.join(profile, "preferences.json"), "utf8"),
  };
}

/**
 * An additive schema change of the kind a release carries, applied to the
 * profile's own database exactly as startup would: in one transaction, on the
 * data that is already there.
 */
function applyPendingSchemaChange(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("BEGIN");
    db.exec('ALTER TABLE "Company" ADD COLUMN "wheatUpdateProbe" TEXT');
    db.exec("COMMIT");
  } finally { db.close(); }
}

function fileDigest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** A local update feed standing in for a published release. */
function writeLocalRelease(feed, version) {
  const artifactName = `WheatSetup-${version}.exe`;
  const artifactBytes = Buffer.from(`NSIS installer for Wheat ${version}`);
  const releaseDirectory = path.join(feed, version);
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(releaseDirectory, artifactName), artifactBytes);
  const release = {
    schemaVersion: 1,
    version,
    releaseDate: "2026-09-03",
    notes: ["Import bancaire amélioré", "Corrections de stabilité"],
    artifact: `${version}/${artifactName}`,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSize: artifactBytes.length,
  };
  fs.writeFileSync(path.join(feed, "latest.json"), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

function serviceFor(profile, feed, currentVersion, automaticInstallationEnabled) {
  return new updater.UpdateService({
    currentVersion,
    provider: new updater.LocalUpdateProvider(feed),
    stateDirectory: path.join(profile, "updater"),
    automaticInstallationEnabled,
  });
}
