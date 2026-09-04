/**
 * Preparing a dossier before it is opened for work.
 *
 * Guided work could already prepare, validate and execute; what it could not do
 * was insist. A new dossier dropped the accountant into the whole application
 * with no exercise, no chart, no journals and no VAT regime, and left them to
 * work out in what order those had to exist — which is precisely the knowledge
 * the application is supposed to hold for them. Entries made before that
 * foundation exists are entries somebody has to unpick later.
 *
 * So this suite pins a gate, and pins its limits just as hard. A gate that can
 * shut somebody out of their own books is a worse failure than the one it
 * fixes, so: it opens permanently the first time the foundation is approved, it
 * never applies to a dossier somebody made to try the application out, it
 * cannot be opened while the records say the dossier is incomplete, and it
 * writes no accounting data of its own.
 *
 * Progress is derived, never stored. Whether a fiscal year exists is a question
 * the fiscal year table answers; keeping a second answer beside it is how the
 * two come to disagree. The only things recorded are the two facts no record
 * can show — which situation the dossier starts from, and that a person
 * approved the foundation.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const setupModule = tsxRequire(path.join(root, "electron", "wheatDossierSetup.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

test.describe("dossier setup", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let service;

  const makeCompany = (name, ice) => prisma.company.create({
    data: { name, legalForm: "SARL", ice, taxId: `IF-${ice}`, city: "Casablanca" },
  });

  /**
   * Brings a dossier up to a complete foundation.
   *
   * The VAT configuration is included because a normal dossier has one, not
   * because the gate demands it: VAT is prepared and tracked, never blocking.
   */
  async function buildFoundation(companyId) {
    await prisma.fiscalYear.create({
      data: {
        companyId, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"),
        endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN",
      },
    });
    await prisma.account.create({
      data: { companyId, code: "411000", label: "Clients", classNo: 4, type: "ASSET" },
    });
    await prisma.journal.create({ data: { companyId, code: "OD", label: "Opérations diverses", nextNumber: 1 } });
    await prisma.taxConfigurationVersion.create({
      data: {
        companyId, lineageKey: `tax-${companyId}`, name: "Régime TVA 2026", status: "ACTIVE",
        accountingBasis: "DEBIT", filingFrequency: "MONTHLY",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"), payloadSha256: "0".repeat(64),
      },
    });
  }

  test.beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-setup-"));
    const databasePath = path.join(temporaryRoot, "setup.db");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replace(/\\/g, "/")}` } } });
    await prisma.$connect();
    service = setupModule.createWheatDossierSetupService(async () => prisma);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------ the gate */

  test("a brand new dossier is not yet open for work", async () => {
    const company = await makeCompany("NOUVEAU DOSSIER SARL", "004000000000001");
    const state = await service.state({ companyId: company.id });
    expect(state.mode).toBe("SETUP");
    expect(state.readyToUnlock).toBe(false);
  });

  test("it says what is missing, and why each thing is required", async () => {
    // A requirement without a reason is an obstacle. Every one carries its own.
    const company = await makeCompany("SANS BASE SARL", "004000000000002");
    const state = await service.state({ companyId: company.id });
    expect(state.stages.map((stage) => stage.id)).toEqual(["situation", "fiscal-year", "chart", "journals", "vat-configuration"]);
    for (const stage of state.stages) {
      expect(stage.why.length, `${stage.id} has no reason`).toBeGreaterThan(30);
    }
    expect(state.blockingReason).toMatch(/il manque/i);
  });

  test("it asks the one question it cannot work out for itself", async () => {
    const company = await makeCompany("A QUESTIONNER SARL", "004000000000003");
    const state = await service.state({ companyId: company.id });
    expect(state.question.prompt).toMatch(/comment démarrons-nous/i);
    expect(state.question.why.length).toBeGreaterThan(30);
    expect(state.question.whereToFind.length).toBeGreaterThan(30);
    expect(state.situationOptions.map((option) => option.value)).toEqual(["NEW", "EXISTING", "DOCUMENTS"]);
  });

  test("answering it stops it being asked again", async () => {
    const company = await makeCompany("REPRISE SARL", "004000000000004");
    const answered = await service.setSituation({ companyId: company.id, situation: "EXISTING" });
    expect(answered.situation).toBe("EXISTING");
    expect(answered.question).toBeNull();
    expect(answered.stages.find((stage) => stage.id === "situation").done).toBe(true);
  });

  test("an unrecognised answer is refused", async () => {
    const company = await makeCompany("MAUVAISE REPONSE SARL", "004000000000005");
    await expect(service.setSituation({ companyId: company.id, situation: "PEUT-ETRE" }))
      .rejects.toThrow(/n'est pas reconnue/i);
  });

  /* --------------------------------------------------------- progress */

  test("progress is read from the dossier's own records, not a checklist", async () => {
    const company = await makeCompany("PROGRESSION SARL", "004000000000006");
    await service.setSituation({ companyId: company.id, situation: "NEW" });

    const done = async () => (await service.state({ companyId: company.id })).stages.filter((stage) => stage.done).map((stage) => stage.id);
    expect(await done()).toEqual(["situation"]);

    await prisma.fiscalYear.create({
      data: {
        companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"),
        endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN",
      },
    });
    // No call told the setup service this happened; it looked.
    expect(await done()).toEqual(["situation", "fiscal-year"]);
  });


  test("a VAT regime is prepared and tracked, but never blocks the dossier", async () => {
    // A company that is not VAT-registered — an auto-entrepreneur, an exempt
    // activity — has no regime to configure. Gating on it would shut such a
    // dossier permanently, which is a trap rather than a gate.
    const company = await makeCompany("SANS TVA SARL", "004000000000020");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    await prisma.fiscalYear.create({
      data: {
        companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"),
        endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN",
      },
    });
    await prisma.account.create({ data: { companyId: company.id, code: "411000", label: "Clients", classNo: 4, type: "ASSET" } });
    await prisma.journal.create({ data: { companyId: company.id, code: "OD", label: "OD", nextNumber: 1 } });

    const state = await service.state({ companyId: company.id });
    expect(state.readyToUnlock).toBe(true);
    // Still listed, still not done — raised by guided work rather than by a lock.
    expect(state.outstanding).toContain("vat-configuration");
    expect(state.stages.find((stage) => stage.id === "vat-configuration").blocking).toBe(false);
    expect((await service.unlock({ companyId: company.id })).mode).toBe("UNLOCKED");
  });

  test("what makes an entry impossible does block", async () => {
    const company = await makeCompany("SANS JOURNAL SARL", "004000000000021");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    const state = await service.state({ companyId: company.id });
    expect(state.stages.filter((stage) => stage.blocking).map((stage) => stage.id))
      .toEqual(["situation", "fiscal-year", "chart", "journals"]);
    await expect(service.unlock({ companyId: company.id })).rejects.toThrow(/pas encore prêt/i);
  });

  /* ------------------------------------------------------- unlocking */

  test("an incomplete dossier cannot be opened, whoever asks", async () => {
    const company = await makeCompany("PAS PRET SARL", "004000000000007");
    await expect(service.unlock({ companyId: company.id })).rejects.toThrow(/pas encore prêt/i);
    expect((await service.state({ companyId: company.id })).mode).toBe("SETUP");
  });

  test("a complete foundation can be approved, and then the dossier is open", async () => {
    const company = await makeCompany("PRET SARL", "004000000000008");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    await buildFoundation(company.id);

    const ready = await service.state({ companyId: company.id });
    expect(ready.readyToUnlock).toBe(true);
    expect(ready.blockingReason).toBeNull();
    // What is being approved is stated, not implied.
    expect(ready.summary.join(" ")).toMatch(/PRET SARL/);

    const opened = await service.unlock({ companyId: company.id });
    expect(opened.mode).toBe("UNLOCKED");
  });

  test("once open, it stays open", async () => {
    // A gate that can swing back and shut somebody out of a dossier they are
    // working in is worse than no gate.
    const company = await makeCompany("TOUJOURS OUVERT SARL", "004000000000009");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    await buildFoundation(company.id);
    await service.unlock({ companyId: company.id });

    // Even if a blocking requirement is later dismantled, it does not re-lock.
    await prisma.journal.deleteMany({ where: { companyId: company.id } });
    const state = await service.state({ companyId: company.id });
    expect(state.mode).toBe("UNLOCKED");
    expect(state.readyToUnlock).toBe(false);
  });

  test("unlocking twice is not an error", async () => {
    const company = await makeCompany("DEUX FOIS SARL", "004000000000010");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    await buildFoundation(company.id);
    await service.unlock({ companyId: company.id });
    expect((await service.unlock({ companyId: company.id })).mode).toBe("UNLOCKED");
  });

  /* ------------------------------------------------ trying Wheat out */

  test("a dossier named TEST is never gated", async () => {
    const company = await makeCompany("TEST", "004000000000011");
    const state = await service.state({ companyId: company.id });
    expect(state.isTestDossier).toBe(true);
    expect(state.mode).toBe("UNLOCKED");
    // And is not badgered with the setup question either.
    expect(state.question).toBeNull();
  });

  test("a real company whose name merely contains TEST is gated normally", async () => {
    // The escape hatch is for somebody trying Wheat out, not a licence for any
    // dossier that happens to have those four letters in its name.
    const company = await makeCompany("TEST INDUSTRIES SARL", "004000000000012");
    expect((await service.state({ companyId: company.id })).mode).toBe("SETUP");
    expect(setupModule.isTestDossier("TEST INDUSTRIES SARL")).toBe(false);
    expect(setupModule.isTestDossier("  test  ")).toBe(true);
  });

  /* --------------------------------------------------------- refusals */

  test("a dossier that no longer exists is refused", async () => {
    await expect(service.state({ companyId: "disparu" })).rejects.toThrow(/n'existe plus/i);
  });

  test("setup writes no accounting data of its own", async () => {
    const company = await makeCompany("SANS ECRITURE SARL", "004000000000013");
    const before = {
      entries: await prisma.entry.count({ where: { companyId: company.id } }),
      accounts: await prisma.account.count({ where: { companyId: company.id } }),
      journals: await prisma.journal.count({ where: { companyId: company.id } }),
    };
    await service.setSituation({ companyId: company.id, situation: "DOCUMENTS" });
    expect({
      entries: await prisma.entry.count({ where: { companyId: company.id } }),
      accounts: await prisma.account.count({ where: { companyId: company.id } }),
      journals: await prisma.journal.count({ where: { companyId: company.id } }),
    }).toEqual(before);
  });

  test("the two stored facts are the only two, and live where decisions live", async () => {
    // Everything else is derived. These two are not visible in any record.
    const company = await makeCompany("DECISIONS SARL", "004000000000014");
    await service.setSituation({ companyId: company.id, situation: "NEW" });
    await buildFoundation(company.id);
    await service.unlock({ companyId: company.id });
    const stored = await prisma.guidedStepDecision.findMany({ where: { companyId: company.id }, select: { stepId: true } });
    expect(stored.map((row) => row.stepId).sort()).toEqual(["setup:situation", "setup:unlocked"]);
  });
});

/* ------------------------------------------------------------------------ */

test.describe("how the interface uses the gate", () => {
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

  test("a locked dossier still reaches guided work, the dossier list and settings", () => {
    // Guided work is where the missing pieces get prepared, and somebody must
    // always be able to leave for another dossier or change their settings.
    const app = read("src", "App.tsx");
    expect(app).toMatch(/setupAllowedPages: Page\[\] = \["guided", "companies", "settings", "reports", "documents"\]/);
  });

  test("destinations that would refuse to open are not offered", () => {
    const app = read("src", "App.tsx");
    expect(app).toMatch(/allowedPages=\{dossierLocked \? setupAllowedPages : null\}/);
    expect(app).toMatch(/group\.pages\.filter\(\(target\) => !allowedPages/);
  });

  test("a setup state that cannot be read leaves the application open", () => {
    // Failing closed here would lock somebody out of their own books because a
    // query failed. The rest of Wheat still validates every write regardless.
    const app = read("src", "App.tsx");
    const block = app.slice(app.indexOf("const refreshDossierSetup"), app.indexOf("const dossierLocked"));
    expect(block).toMatch(/catch\s*\{\s*setDossierSetup\(null\)/);
    const gate = read("src", "components", "DossierSetupGate.tsx");
    expect(gate).toMatch(/if \(!setup \|\| setup\.mode === "UNLOCKED"\) return null/);
  });

  test("the gate explains itself rather than only refusing", () => {
    const gate = read("src", "components", "DossierSetupGate.tsx");
    expect(gate).toMatch(/Ce n'est pas une restriction/);
    expect(gate).toMatch(/stage\.why/);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The gate must never become a trap.
 *
 * Every one of these covers the same failure from a different angle: Wheat
 * updating and shutting somebody out of books they were working in yesterday.
 * A dossier with entries, invoices or documents in it has passed initial
 * preparation by definition, whatever its configuration happens to look like.
 */
test.describe("dossiers already in use", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let service;

  test.beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-setup-legacy-"));
    const databasePath = path.join(temporaryRoot, "legacy.db");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath.split("\\").join("/")}` } } });
    await prisma.$connect();
    service = setupModule.createWheatDossierSetupService(async () => prisma);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const legacyCompany = (name, ice) => prisma.company.create({
    data: { name, legalForm: "SARL", ice, taxId: `IF-${ice}`, city: "Casablanca" },
  });

  test("a dossier holding entries is open, however it is configured", async () => {
    const company = await legacyCompany("DOSSIER EN COURS SARL", "005000000000001");
    const journal = await prisma.journal.create({ data: { companyId: company.id, code: "OD", label: "OD", nextNumber: 2 } });
    await prisma.entry.create({
      data: {
        companyId: company.id, journalId: journal.id, number: "OD-2026-000001",
        date: new Date("2026-04-02T00:00:00Z"), pieceNumber: "OD-2026-000001",
        label: "Écriture existante", status: "POSTED", journalCodeSnapshot: "OD",
      },
    });
    const state = await service.state({ companyId: company.id });
    // No fiscal year, no chart, no VAT configuration — and still not gated.
    expect(state.mode).toBe("UNLOCKED");
    expect(state.question).toBeNull();
  });

  test("a dossier holding documents is open", async () => {
    const company = await legacyCompany("DOSSIER AVEC PIECES SARL", "005000000000002");
    await prisma.document.create({
      data: {
        companyId: company.id, title: "Facture.pdf", type: "Facture fournisseur",
        fiscalYear: "2026", tags: "achat", ocrText: "", extracted: "{}", status: "EXTRACTED",
      },
    });
    expect((await service.state({ companyId: company.id })).mode).toBe("UNLOCKED");
  });

  test("an empty dossier is still gated", async () => {
    // The distinction has to be work, not merely existing.
    const company = await legacyCompany("DOSSIER VIDE SARL", "005000000000003");
    expect((await service.state({ companyId: company.id })).mode).toBe("SETUP");
  });

  test("an in-use dossier still lists its incomplete foundations", async () => {
    const company = await legacyCompany("INCOMPLET MAIS ACTIF SARL", "005000000000004");
    await prisma.document.create({
      data: {
        companyId: company.id, title: "Relevé.pdf", type: "Relevé bancaire",
        fiscalYear: "2026", tags: "banque", ocrText: "", extracted: "{}", status: "EXTRACTED",
      },
    });
    const state = await service.state({ companyId: company.id });
    expect(state.mode).toBe("UNLOCKED");
    expect(state.readyToUnlock).toBe(false);
    expect(state.stages.filter((stage) => !stage.done).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ */

/**
 * Having been in use is remembered, not merely observed.
 *
 * A dossier whose only entry is deleted would stop *looking* in use. If that
 * re-closed it, the gate would shut behind somebody who was working in it a
 * moment earlier — a gate that can trap is worse than no gate at all.
 */
test.describe("passing setup is permanent", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let service;

  test.beforeAll(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-setup-sticky-"));
    const databasePath = path.join(temporaryRoot, "sticky.db");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath.split("\\").join("/")}` } } });
    await prisma.$connect();
    service = setupModule.createWheatDossierSetupService(async () => prisma);
  });

  test.afterAll(async () => {
    await prisma?.$disconnect();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("deleting the last record does not re-close the dossier", async () => {
    const company = await prisma.company.create({
      data: { name: "STICKY SARL", legalForm: "SARL", ice: "006000000000001", taxId: "IF-6", city: "Casablanca" },
    });
    const journal = await prisma.journal.create({ data: { companyId: company.id, code: "OD", label: "OD", nextNumber: 2 } });
    const entry = await prisma.entry.create({
      data: {
        companyId: company.id, journalId: journal.id, number: "OD-2026-000001",
        date: new Date("2026-04-02T00:00:00Z"), pieceNumber: "OD-2026-000001",
        label: "Seule écriture", status: "DRAFT", journalCodeSnapshot: "OD",
      },
    });
    expect((await service.state({ companyId: company.id })).mode).toBe("UNLOCKED");

    await prisma.entry.delete({ where: { id: entry.id } });
    // Nothing is in it any more, and it is still open.
    expect((await service.state({ companyId: company.id })).mode).toBe("UNLOCKED");
  });

  test("the fact is recorded where every other setup decision lives", async () => {
    const company = await prisma.company.create({
      data: { name: "STICKY TRACE SARL", legalForm: "SARL", ice: "006000000000002", taxId: "IF-7", city: "Rabat" },
    });
    await prisma.document.create({
      data: {
        companyId: company.id, title: "Pièce.pdf", type: "Facture fournisseur",
        fiscalYear: "2026", tags: "achat", ocrText: "", extracted: "{}", status: "EXTRACTED",
      },
    });
    await service.state({ companyId: company.id });
    const stored = await prisma.guidedStepDecision.findMany({ where: { companyId: company.id } });
    expect(stored.map((row) => row.stepId)).toEqual(["setup:unlocked"]);
    expect(stored[0].note).toMatch(/déjà en cours/i);
  });

  test("an empty dossier is not quietly opened by being looked at", async () => {
    const company = await prisma.company.create({
      data: { name: "TOUJOURS VIDE SARL", legalForm: "SARL", ice: "006000000000003", taxId: "IF-8", city: "Fès" },
    });
    await service.state({ companyId: company.id });
    expect(await prisma.guidedStepDecision.count({ where: { companyId: company.id } })).toBe(0);
    expect((await service.state({ companyId: company.id })).mode).toBe("SETUP");
  });
});
