/**
 * Guided work: detect, prepare, validate, approve, execute, next.
 *
 * The suite drives the real engine against a real migrated database, with the
 * domain services stubbed only so the test can observe *what* would be called
 * and prove that nothing is called without approval. Every assertion is about
 * one of the rules the rework exists to establish:
 *
 *   - preparation reads the dossier and produces concrete operations, not advice
 *   - nothing is written until `approve`, and then only what was named
 *   - one unusable document does not block the rest of the batch
 *   - an operation that disappeared between preparation and approval is refused
 *   - a postponed step steps aside without pretending to be finished
 *   - progress survives leaving and coming back, because it is derived
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const guidedModule = tsxRequire(path.join(root, "electron", "wheatGuidedWork.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

const sqliteUrl = (databasePath) => `file:${databasePath.replace(/\\/g, "/")}`;

/** The dossier keeping the books, and the supplier that invoices it. */
const DOSSIER = { name: "IFCOF", ice: "000187958000077", taxId: "1110375", city: "Casablanca" };
const SUPPLIER = { name: "SOCIETE LAKHOUILI SARL", ice: "001589742000063", taxId: "48291073" };

/**
 * A stored extraction in the shape the recogniser actually writes.
 *
 * Both parties are named with their identifiers, which is what lets the planner
 * decide the direction from evidence rather than from a default.
 */
function extraction({ number, date, ht, tva, ttc, confidence = 93, uncertainFields = [], duplicateIds = [], issuer = SUPPLIER, recipient = DOSSIER }) {
  const field = (value, score = confidence) => ({ value, confidence: score });
  return JSON.stringify({
    documentType: "INVOICE",
    documentTypeLabel: "Facture",
    confidence,
    uncertainFields,
    duplicateIds,
    parties: {
      issuer: { name: issuer.name, ice: issuer.ice, taxId: issuer.taxId },
      recipient: { name: recipient.name, ice: recipient.ice, taxId: recipient.taxId },
    },
    fields: {
      invoiceNumber: number, date, ht, tva, ttc, currency: "MAD",
    },
    fieldConfidence: {
      invoiceNumber: confidence, date: confidence, ht: confidence, tva: confidence, ttc: confidence, currency: confidence,
    },
    tableRows: [],
    // The shape the field mapper reads amounts back from.
    fieldValues: { invoiceNumber: field(number), date: field(date) },
  });
}

test.describe("guided work", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let company;
  let service;
  let calls;

  /** Records every domain call so "nothing ran" is provable, not assumed. */
  function stubServices() {
    calls = [];
    return {
      async createInvoiceDraftFromDocument(input) {
        calls.push({ kind: "createInvoiceDraftFromDocument", input });
        const document = await prisma.document.findUniqueOrThrow({ where: { id: input.documentId } });
        const counterparty = await prisma.counterparty.upsert({
          where: { companyId_identityKey: { companyId: input.companyId, identityKey: `ICE:${SUPPLIER.ice}` } },
          update: {},
          create: { companyId: input.companyId, kind: "SUPPLIER", displayName: SUPPLIER.name, identityKey: `ICE:${SUPPLIER.ice}`, ice: SUPPLIER.ice, taxId: SUPPLIER.taxId },
        });
        const invoice = await prisma.invoice.create({
          data: {
            companyId: input.companyId, kind: "PURCHASE", counterparty: SUPPLIER.name, counterpartyId: counterparty.id,
            invoiceNo: `${document.title}`, invoiceDate: new Date("2026-08-12T00:00:00Z"),
            htCents: 450000n, vatCents: 90000n, ttcCents: 540000n,
            status: "DRAFT", lifecycleStatus: "DRAFT", source: "OCR_1_3",
          },
        });
        await prisma.document.update({ where: { id: input.documentId }, data: { invoiceId: invoice.id, status: "INVOICE_DRAFT" } });
        return { invoiceDraft: invoice };
      },
      async updateDocumentExtraction(input) {
        calls.push({ kind: "updateDocumentExtraction", input });
        const document = await prisma.document.findUniqueOrThrow({ where: { id: input.documentId } });
        const previous = JSON.parse(document.extracted || "{}");
        const next = {
          ...previous,
          fields: { ...(previous.fields ?? {}), ...input.fields },
          fieldConfidence: { ...(previous.fieldConfidence ?? {}), ...Object.fromEntries(Object.keys(input.fields).map((key) => [key, 100])) },
        };
        return prisma.document.update({ where: { id: input.documentId }, data: { extracted: JSON.stringify(next) } });
      },
      async postInvoice(input) {
        calls.push({ kind: "postInvoice", input });
        const invoice = await prisma.invoice.update({ where: { id: input.id }, data: { lifecycleStatus: "POSTED", version: { increment: 1 } } });
        return { invoice };
      },
      async saveFiscalYear(input) {
        calls.push({ kind: "saveFiscalYear", input });
        return prisma.fiscalYear.create({
          data: {
            companyId: input.companyId, label: input.label,
            startsOn: new Date(`${input.startsOn}T00:00:00Z`), endsOn: new Date(`${input.endsOn}T00:00:00Z`), status: "OPEN",
          },
        });
      },
      async saveTaxConfigDraft(input) {
        calls.push({ kind: "saveTaxConfigDraft", input });
        return prisma.taxConfigurationVersion.create({
          data: {
            companyId: input.companyId, lineageKey: "guided-test", revision: 1, status: "DRAFT",
            name: input.name, accountingBasis: "COLLECTION", filingFrequency: input.filingFrequency,
            effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`), sourceReference: input.sourceReference,
            payloadSha256: "a".repeat(64),
          },
        });
      },
      async activateTaxConfig(input) {
        calls.push({ kind: "activateTaxConfig", input });
        return prisma.taxConfigurationVersion.update({ where: { id: input.id }, data: { status: "ACTIVE", activatedAt: new Date() } });
      },
    };
  }

  /** A dossier with the chart of accounts the planner needs to resolve roles. */
  async function seedChart() {
    const accounts = [
      ["441100", "Fournisseurs", 4, "LIABILITY"],
      ["342100", "Clients", 3, "ASSET"],
      ["445500", "Etat TVA facturee", 4, "LIABILITY"],
      ["345520", "Etat TVA recuperable", 3, "ASSET"],
      ["613600", "Honoraires et charges externes", 6, "EXPENSE"],
      ["611100", "Achats de marchandises", 6, "EXPENSE"],
      ["712400", "Ventes de prestations", 7, "REVENUE"],
      ["711100", "Ventes de marchandises", 7, "REVENUE"],
      ["348800", "Debiteurs divers", 3, "ASSET"],
    ];
    for (const [code, label, classNo, type] of accounts) {
      await prisma.account.create({
        data: { companyId: company.id, code, label, classNo, type, active: true, postable: true, searchText: `${code} ${label.toLowerCase()}` },
      });
    }
    await prisma.journal.create({ data: { companyId: company.id, code: "AC", label: "Achats", active: true } });
  }

  const addDocument = (title, extracted) => prisma.document.create({
    data: { companyId: company.id, title, type: "Facture", fiscalYear: "2026", tags: "wheat-ocr", ocrText: title, extracted, status: "EXTRACTED" },
  });

  const step = (state, id) => state.steps.find((item) => item.id === id);

  test.beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-guided-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();
    company = await prisma.company.create({
      data: { name: DOSSIER.name, legalForm: "SARL", ice: DOSSIER.ice, taxId: DOSSIER.taxId, city: DOSSIER.city, vatFrequency: "MONTHLY" },
    });
    service = guidedModule.createWheatGuidedWorkService({
      getPrisma: async () => prisma,
      services: stubServices(),
      now: () => new Date("2026-09-01T09:00:00Z"),
    });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------- DETECT */

  test("state keeps the derived journey and marks which steps Wheat can perform", async () => {
    const state = await service.state({ companyId: company.id });
    expect(state.version).toBe("WHEAT_GUIDED_1");
    expect(state.total).toBe(15);
    expect(step(state, "documents").automatable).toBe(true);
    expect(step(state, "invoices").automatable).toBe(true);
    // A step Wheat cannot prepare says so rather than pretending.
    expect(step(state, "opening").automatable).toBe(false);
    expect(step(state, "closing").automatable).toBe(false);
  });

  /* --------------------------------------------------- PREPARE + VALIDATE */

  test("a fiscal year is proposed with concrete dates, not merely recommended", async () => {
    const proposal = await service.prepare({ companyId: company.id, stepId: "fiscal-year" });
    expect(proposal.operations).toHaveLength(1);
    const [operation] = proposal.operations;
    expect(operation.kind).toBe("CREATE_FISCAL_YEAR");
    expect(operation.status).toBe("READY");
    expect(operation.payload.startsOn).toBe("2026-01-01");
    expect(operation.payload.endsOn).toBe("2026-12-31");
    expect(proposal.approvable).toBe(true);
    // Preparation writes nothing.
    expect(calls).toHaveLength(0);
    expect(await prisma.fiscalYear.count({ where: { companyId: company.id } })).toBe(0);
  });

  test("the VAT configuration is built from the rates the dossier actually shows", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    // A 14 % line already recorded in the subledger is evidence too.
    const counterparty = await prisma.counterparty.create({
      data: { companyId: company.id, kind: "SUPPLIER", displayName: SUPPLIER.name, identityKey: `ICE:${SUPPLIER.ice}`, ice: SUPPLIER.ice },
    });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "PURCHASE", counterparty: SUPPLIER.name, counterpartyId: counterparty.id,
        invoiceNo: "ANC-1", invoiceDate: new Date("2026-03-01T00:00:00Z"),
        htCents: 10000n, vatCents: 1400n, ttcCents: 11400n, status: "DRAFT", lifecycleStatus: "DRAFT",
      },
    });
    const account = await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: "613600" } });
    await prisma.invoiceLine.create({
      data: { invoiceId: invoice.id, position: 1, description: "Honoraires", accountId: account.id, htCents: 10000n, vatCents: 1400n, ttcCents: 11400n, vatRateBps: 1400 },
    });

    const proposal = await service.prepare({ companyId: company.id, stepId: "vat-configuration" });
    expect(proposal.operations).toHaveLength(1);
    const [operation] = proposal.operations;
    expect(operation.kind).toBe("ACTIVATE_TAX_CONFIGURATION");
    expect(operation.status).toBe("READY");
    expect(operation.payload.filingFrequency).toBe("MONTHLY");
    // 14 % was observed; the statutory set was not substituted for it.
    const rates = operation.payload.rates.map((rate) => rate.rateBps);
    expect(rates).toContain(1400);
    expect(new Set(operation.payload.rates.map((rate) => rate.direction))).toEqual(new Set(["COLLECTED", "DEDUCTIBLE"]));
    // The accounts come from this dossier's own chart.
    expect(proposal.detected.map((item) => item.value).join(" ")).toMatch(/445500/);
    expect(proposal.detected.map((item) => item.value).join(" ")).toMatch(/345520/);
    expect(calls).toHaveLength(0);
  });

  test("without a declared filing rhythm Wheat refuses to configure VAT and says why", async () => {
    await seedChart();
    await prisma.company.update({ where: { id: company.id }, data: { vatFrequency: "" } });
    const proposal = await service.prepare({ companyId: company.id, stepId: "vat-configuration" });
    expect(proposal.operations).toHaveLength(0);
    expect(proposal.approvable).toBe(false);
    expect(proposal.findings[0].severity).toBe("BLOCKER");
    expect(proposal.findings[0].message).toMatch(/mois ou tous les trimestres/i);
  });

  /* ------------------------------------------------------- the batch path */

  test("a batch of recognised invoices becomes reviewable operations, one per document", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    await addDocument("F-2026-2", extraction({ number: "F-2026-2", date: "2026-08-13", ht: 1000, tva: 200, ttc: 1200 }));
    await addDocument("F-2026-3", extraction({ number: "F-2026-3", date: "2026-08-14", ht: 800, tva: 160, ttc: 960, confidence: 55, uncertainFields: ["ttc"] }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    expect(proposal.operations).toHaveLength(3);
    expect(proposal.readyCount).toBe(2);
    expect(proposal.reviewCount).toBe(1);
    expect(proposal.blockedCount).toBe(0);
    expect(proposal.summary).toMatch(/3 pièce\(s\) analysée\(s\)/);

    const uncertain = proposal.operations.find((operation) => operation.label.includes("F-2026-3"));
    expect(uncertain.status).toBe("REVIEW");
    expect(uncertain.attention).toContain("ttc");
    expect(uncertain.reasons.join(" ")).toMatch(/réserve|Confiance/);

    // Direction and third party were decided from the page, not defaulted.
    for (const operation of proposal.operations) {
      expect(operation.label.startsWith("Achat")).toBe(true);
      expect(operation.detail).toMatch(/Nouveau fournisseur : SOCIETE LAKHOUILI SARL/);
      expect(operation.target.page).toBe("documents");
    }
    // Detection is reported so the summary can be checked.
    expect(proposal.detected.find((item) => item.label === "Tiers à créer").value).toBe("1");
    expect(calls).toHaveLength(0);
  });

  test("one unreadable document is isolated; the rest of the batch stays approvable", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    // No number, no date, no parties: the planner refuses this one by design.
    await addDocument("scan-illisible", JSON.stringify({ documentType: "INVOICE", confidence: 20, fields: {}, fieldConfidence: {} }));
    await addDocument("F-2026-2", extraction({ number: "F-2026-2", date: "2026-08-13", ht: 1000, tva: 200, ttc: 1200 }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    expect(proposal.operations).toHaveLength(3);
    expect(proposal.blockedCount).toBe(1);
    const blocked = proposal.operations.find((operation) => operation.status === "BLOCKED");
    expect(blocked.label).toBe("scan-illisible");
    expect(blocked.reasons[0]).toBeTruthy();
    // The batch is still worth approving.
    expect(proposal.approvable).toBe(true);
    expect(proposal.approveLabel).toMatch(/2 brouillon/);
  });

  test("a document that resembles one already filed is offered for review, not silently repeated", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400, duplicateIds: ["doc-existant"] }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    expect(proposal.operations[0].status).toBe("REVIEW");
    expect(proposal.operations[0].reasons.join(" ")).toMatch(/déjà présente/i);
    expect(proposal.findings.some((item) => /doublon/i.test(item.message))).toBe(true);
  });

  /* ---------------------------------------------------- APPROVE + EXECUTE */

  test("approval performs exactly the operations it was given, and nothing else", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    await addDocument("F-2026-2", extraction({ number: "F-2026-2", date: "2026-08-13", ht: 1000, tva: 200, ttc: 1200 }));
    await addDocument("F-2026-3", extraction({ number: "F-2026-3", date: "2026-08-14", ht: 800, tva: 160, ttc: 960 }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const chosen = proposal.operations.slice(0, 2).map((operation) => operation.id);
    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: chosen });

    expect(execution.executed).toHaveLength(2);
    expect(execution.failed).toHaveLength(0);
    expect(calls.filter((call) => call.kind === "createInvoiceDraftFromDocument")).toHaveLength(2);
    // The third document was not approved, so it was not touched.
    expect(await prisma.invoice.count({ where: { companyId: company.id } })).toBe(2);
    expect(await prisma.document.count({ where: { companyId: company.id, invoiceId: null } })).toBe(1);
  });

  test("an empty approval is refused rather than treated as approving everything", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    await expect(service.approve({ companyId: company.id, stepId: "documents", operationIds: [] })).rejects.toThrow(/Aucune opération/i);
    expect(calls).toHaveLength(0);
  });

  test("an operation that no longer exists is reported, not replayed", async () => {
    await seedChart();
    const document = await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    // Somebody handled the document in another window between the two calls.
    await prisma.document.delete({ where: { id: document.id } });

    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: proposal.operations.map((item) => item.id) });
    expect(execution.executed).toHaveLength(0);
    expect(execution.failed).toHaveLength(1);
    expect(execution.failed[0].reason).toMatch(/n'existe plus/i);
    expect(calls).toHaveLength(0);
  });

  test("a blocked operation is refused even when its id is submitted", async () => {
    await seedChart();
    await addDocument("scan-illisible", JSON.stringify({ documentType: "INVOICE", confidence: 20, fields: {}, fieldConfidence: {} }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: [proposal.operations[0].id] });
    expect(execution.executed).toHaveLength(0);
    expect(execution.failed).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  /* --------------------------------------------------------- posting */

  test("posting is offered only for drafts that pass every deterministic check", async () => {
    await seedChart();
    await prisma.fiscalYear.create({
      data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" },
    });
    const counterparty = await prisma.counterparty.create({
      data: { companyId: company.id, kind: "SUPPLIER", displayName: SUPPLIER.name, identityKey: `ICE:${SUPPLIER.ice}`, ice: SUPPLIER.ice },
    });
    const account = await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: "613600" } });
    const makeDraft = async (invoiceNo, ht, vat, ttc, lineHt, needsReview = false) => {
      const invoice = await prisma.invoice.create({
        data: {
          companyId: company.id, kind: "PURCHASE", counterparty: SUPPLIER.name, counterpartyId: counterparty.id,
          invoiceNo, invoiceDate: new Date("2026-08-12T00:00:00Z"),
          htCents: BigInt(ht), vatCents: BigInt(vat), ttcCents: BigInt(ttc), status: "DRAFT", lifecycleStatus: "DRAFT",
          needsReview,
        },
      });
      await prisma.invoiceLine.create({
        data: { invoiceId: invoice.id, position: 1, description: "Honoraires", accountId: account.id, htCents: BigInt(lineHt), vatCents: BigInt(vat), ttcCents: BigInt(Number(lineHt) + Number(vat)), vatRateBps: 2000 },
      });
      return invoice;
    };
    await makeDraft("OK-1", 450000, 90000, 540000, 450000);
    // Lines no longer total the header: an arithmetic failure, not a warning.
    await makeDraft("KO-1", 100000, 20000, 120000, 90000);
    // A draft built from a recognised document always carries `needsReview`.
    // It is arithmetically sound and still must not post itself.
    await makeDraft("OCR-1", 200000, 40000, 240000, 200000, true);

    const proposal = await service.prepare({ companyId: company.id, stepId: "invoices" });
    expect(proposal.operations).toHaveLength(3);
    const ok = proposal.operations.find((operation) => operation.label.includes("OK-1"));
    const ko = proposal.operations.find((operation) => operation.label.includes("KO-1"));
    const ocr = proposal.operations.find((operation) => operation.label.includes("OCR-1"));
    expect(ok.status).toBe("READY");
    expect(ko.status).toBe("BLOCKED");
    expect(ko.reasons.join(" ")).toMatch(/lignes ne totalisent plus/i);
    expect(ocr.status).toBe("REVIEW");
    expect(ocr.attention).toContain("reviewNote");

    const execution = await service.approve({ companyId: company.id, stepId: "invoices", operationIds: [ok.id] });
    expect(execution.executed).toHaveLength(1);
    expect(calls.filter((call) => call.kind === "postInvoice")).toHaveLength(1);
    expect(calls.find((call) => call.kind === "postInvoice").input.expectedVersion).toBe(1);
  });

  test("a draft dated in a locked period is never offered for posting", async () => {
    await seedChart();
    await prisma.fiscalYear.create({
      data: {
        companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"),
        status: "OPEN", lockedTo: new Date("2026-08-31T00:00:00Z"),
      },
    });
    const counterparty = await prisma.counterparty.create({
      data: { companyId: company.id, kind: "SUPPLIER", displayName: SUPPLIER.name, identityKey: `ICE:${SUPPLIER.ice}`, ice: SUPPLIER.ice },
    });
    const account = await prisma.account.findFirstOrThrow({ where: { companyId: company.id, code: "613600" } });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "PURCHASE", counterparty: SUPPLIER.name, counterpartyId: counterparty.id,
        invoiceNo: "LOCKED-1", invoiceDate: new Date("2026-08-12T00:00:00Z"),
        htCents: 450000n, vatCents: 90000n, ttcCents: 540000n, status: "DRAFT", lifecycleStatus: "DRAFT",
        needsReview: false,
      },
    });
    await prisma.invoiceLine.create({
      data: { invoiceId: invoice.id, position: 1, description: "Honoraires", accountId: account.id, htCents: 450000n, vatCents: 90000n, ttcCents: 540000n, vatRateBps: 2000 },
    });

    const proposal = await service.prepare({ companyId: company.id, stepId: "invoices" });
    expect(proposal.operations[0].status).toBe("BLOCKED");
    expect(proposal.operations[0].reasons.join(" ")).toMatch(/verrouillée/i);
  });

  /* ----------------------------------------------- postpone, resume, NEXT */

  test("a postponed step steps aside without ever being reported as done", async () => {
    const before = await service.state({ companyId: company.id });
    const target = before.next.id;

    await service.decide({ companyId: company.id, stepId: target, decision: "POSTPONED", note: "Le client cherche l'attestation." });
    const after = await service.state({ companyId: company.id });
    expect(after.next.id).not.toBe(target);
    const postponed = step(after, target);
    expect(postponed.decision.kind).toBe("POSTPONED");
    expect(postponed.decision.note).toMatch(/attestation/);
    // Postponing is not completing: the derived status is untouched.
    expect(postponed.status).toBe(step(before, target).status);
    expect(after.completed).toBe(before.completed);

    await service.decide({ companyId: company.id, stepId: target, decision: "RESUMED" });
    const resumed = await service.state({ companyId: company.id });
    expect(resumed.next.id).toBe(target);
    expect(step(resumed, target).decision).toBeNull();
  });

  test("progress survives leaving and coming back, because it is derived from the dossier", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    await service.approve({ companyId: company.id, stepId: "documents", operationIds: [proposal.operations[0].id] });

    // A brand-new service instance, as though Wheat had been closed and reopened.
    const reopened = guidedModule.createWheatGuidedWorkService({
      getPrisma: async () => prisma,
      services: stubServices(),
      now: () => new Date("2026-09-01T09:00:00Z"),
    });
    const later = await reopened.prepare({ companyId: company.id, stepId: "documents" });
    // The document is linked now, so it is no longer proposed.
    expect(later.operations).toHaveLength(0);
    const state = await reopened.state({ companyId: company.id });
    expect(step(state, "invoices").state).toMatch(/1 en brouillon/);
  });


  /* ---------------------------------------- inline correction and its gate */

  test("a document naming neither party is prepared for confirmation, not discarded", async () => {
    await seedChart();
    // A supplier the dossier has never dealt with, invoicing somebody else.
    await addDocument("F-INCONNU", extraction({
      number: "F-INCONNU", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400,
      issuer: { name: "LUNA STEEL", ice: "003358098000067", taxId: "53977847" },
      recipient: { name: "CHANI MAROC", ice: "003206387000051" },
    }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const [operation] = proposal.operations;
    // Everything the page carried is on the row: refusing would have cost all
    // of it to settle a single unknown.
    expect(operation.status).toBe("REVIEW");
    expect(operation.detail).toMatch(/HT 4500,00/);
    expect(operation.detail).toMatch(/Pièce du 2026-08-12/);
    // The row names the piece and both candidate parties, and claims no side.
    expect(operation.label).toMatch(/^Pièce F-INCONNU — sens à confirmer/);
    expect(operation.label).toContain("LUNA STEEL");
    expect(operation.label).toContain("CHANI MAROC");
    expect(operation.attention).toContain("kind");
    // And the unknown is asked about, on the row, as a required choice.
    const direction = operation.edits.find((edit) => edit.field === "kind");
    expect(direction).toBeTruthy();
    expect(direction.required).toBe(true);
    expect(direction.value).toBe("");
    expect(direction.choices.map((choice) => choice.value).sort()).toEqual(["PURCHASE", "SALE"]);
    expect(proposal.detected.find((item) => item.label === "Sens à confirmer").value).toBe("1");
  });

  test("an assumed direction is refused at approval until a person settles it", async () => {
    await seedChart();
    await addDocument("F-INCONNU", extraction({
      number: "F-INCONNU", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400,
      issuer: { name: "LUNA STEEL", ice: "003358098000067", taxId: "53977847" },
      recipient: { name: "CHANI MAROC", ice: "003206387000051" },
    }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });

    // The guard that keeps preparation's assumption out of the ledger.
    const execution = await service.approve({
      companyId: company.id, stepId: "documents", operationIds: [proposal.operations[0].id],
    });
    expect(execution.executed).toHaveLength(0);
    expect(execution.failed[0].reason).toMatch(/ne peut pas décider à votre place/i);
    expect(execution.failed[0].reason).toMatch(/Sens de la pièce/);
    expect(calls).toHaveLength(0);
    expect(await prisma.invoice.count({ where: { companyId: company.id } })).toBe(0);
  });

  test("the answer settles it, and the draft is created in the direction chosen", async () => {
    await seedChart();
    await addDocument("F-INCONNU", extraction({
      number: "F-INCONNU", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400,
      issuer: { name: "LUNA STEEL", ice: "003358098000067", taxId: "53977847" },
      recipient: { name: "CHANI MAROC", ice: "003206387000051" },
    }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const operationId = proposal.operations[0].id;
    const corrections = [{ operationId, fields: { kind: "SALE" } }];

    // Correcting re-runs preparation: the row is re-planned, and the choice is
    // reflected in the label and in the third party the draft would post against.
    const corrected = await service.prepare({ companyId: company.id, stepId: "documents", corrections });
    expect(corrected.operations[0].label).toMatch(/^Vente/);
    expect(corrected.operations[0].detail).toMatch(/CHANI MAROC/);
    expect(corrected.operations[0].edits.find((edit) => edit.field === "kind").value).toBe("SALE");
    // Correcting is not posting.
    expect(calls).toHaveLength(0);

    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: [operationId], corrections });
    expect(execution.failed).toHaveLength(0);
    expect(execution.executed).toHaveLength(1);
    // The confirmed direction reaches the domain service as an explicit choice.
    const call = calls.find((item) => item.kind === "createInvoiceDraftFromDocument");
    expect(call.input.forcedKind).toBe("SALE");
  });

  test("a corrected amount is written to the document, then the draft is built from it", async () => {
    await seedChart();
    // Totals that do not add up: the planner refuses, and says which fields.
    await addDocument("F-DESEQUILIBRE", extraction({ number: "F-DESEQUILIBRE", date: "2026-08-12", ht: 4216.07, tva: 643.33, ttc: 5060 }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const blocked = proposal.operations[0];
    expect(blocked.status).toBe("BLOCKED");
    // The document's own arithmetic determines the reading, so it is offered
    // rather than left as "these three numbers disagree".
    expect(blocked.suggestion.fields).toEqual({ ht: 4216.67, tva: 843.33, ttc: 5060, vatRate: 2000 });
    expect(blocked.edits.map((edit) => edit.field).sort()).toEqual(["ht", "ttc", "tva"]);
    expect(blocked.edits.find((edit) => edit.field === "ht").value).toBe("4216.67");

    const corrections = [{ operationId: blocked.id, fields: { ht: "4216.67", tva: "843.33", ttc: "5060" } }];
    const corrected = await service.prepare({ companyId: company.id, stepId: "documents", corrections });
    // Re-validated by the planner, not by the screen: the row is now buildable.
    expect(corrected.operations[0].status).not.toBe("BLOCKED");
    expect(corrected.operations[0].detail).toMatch(/HT 4216,67/);
    expect(corrected.operations[0].reasons.join(" ")).toMatch(/Corrigé ici avant approbation/);
    expect(calls).toHaveLength(0);

    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: [blocked.id], corrections });
    expect(execution.failed).toHaveLength(0);
    // The correction went through the ordinary OCR-correction service, so it is
    // a correction of the *document* and survives any later rebuild.
    const written = calls.find((item) => item.kind === "updateDocumentExtraction");
    expect(written).toBeTruthy();
    expect(written.input.fields).toEqual({ ht: 4216.67, tva: 843.33, ttc: 5060 });
    expect(calls.findIndex((item) => item.kind === "updateDocumentExtraction"))
      .toBeLessThan(calls.findIndex((item) => item.kind === "createInvoiceDraftFromDocument"));
  });

  test("a correction that still does not add up is refused, not absorbed", async () => {
    await seedChart();
    await addDocument("F-DESEQUILIBRE", extraction({ number: "F-DESEQUILIBRE", date: "2026-08-12", ht: 4216.07, tva: 643.33, ttc: 5060 }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const corrections = [{ operationId: proposal.operations[0].id, fields: { ht: "1", tva: "1", ttc: "5060" } }];

    const corrected = await service.prepare({ companyId: company.id, stepId: "documents", corrections });
    expect(corrected.operations[0].status).toBe("BLOCKED");
    // No proposal this time: 1 + 1 is not 5 060 by any misread digit.
    expect(corrected.operations[0].suggestion).toBeNull();

    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: [proposal.operations[0].id], corrections });
    expect(execution.executed).toHaveLength(0);
    expect(calls.some((item) => item.kind === "updateDocumentExtraction")).toBe(false);
  });

  test("a supplier the dossier already knows settles the direction of its next invoice", async () => {
    await seedChart();
    // The dossier has dealt with this supplier before.
    await prisma.counterparty.create({
      data: {
        companyId: company.id, kind: "SUPPLIER", displayName: SUPPLIER.name,
        identityKey: `ICE:${SUPPLIER.ice}`, ice: SUPPLIER.ice, taxId: SUPPLIER.taxId,
      },
    });
    // A new invoice from it whose recipient block carries an ICE and no name,
    // so the page itself cannot be tied to the dossier.
    await addDocument("F-SUITE", extraction({
      number: "F-SUITE", date: "2026-08-20", ht: 5300, tva: 1060, ttc: 6360,
      recipient: { name: null, ice: "001864713000017" },
    }));

    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const [operation] = proposal.operations;
    expect(operation.label).toMatch(/^Achat F-SUITE/);
    // A deduction, so it is offered for review — but it does not have to be
    // re-answered, because Wheat can defend it.
    expect(operation.status).toBe("REVIEW");
    expect(operation.edits.find((edit) => edit.field === "kind").required).toBe(false);
    expect(operation.reasons.join(" ")).toMatch(/déjà enregistré comme fournisseur/);

    // And it can be approved as it stands.
    const execution = await service.approve({ companyId: company.id, stepId: "documents", operationIds: [operation.id] });
    expect(execution.failed).toHaveLength(0);
  });

  test("corrections never reach an operation the reviewer did not approve", async () => {
    await seedChart();
    await addDocument("F-2026-1", extraction({ number: "F-2026-1", date: "2026-08-12", ht: 4500, tva: 900, ttc: 5400 }));
    await addDocument("F-2026-2", extraction({ number: "F-2026-2", date: "2026-08-13", ht: 1000, tva: 200, ttc: 1200 }));
    const proposal = await service.prepare({ companyId: company.id, stepId: "documents" });
    const [first, second] = proposal.operations;

    await service.approve({
      companyId: company.id, stepId: "documents", operationIds: [first.id],
      corrections: [{ operationId: second.id, fields: { ht: "9999" } }],
    });
    // The correction belonged to a row that was not approved, so nothing was
    // written for it — not the extraction, not the draft.
    const written = calls.filter((item) => item.kind === "updateDocumentExtraction");
    expect(written).toHaveLength(0);
    const created = calls.filter((item) => item.kind === "createInvoiceDraftFromDocument");
    expect(created).toHaveLength(1);
    expect(created[0].input.documentId).toBe(first.payload.documentId);
  });

  test("a step Wheat cannot prepare says so instead of returning an empty proposal", async () => {
    await expect(service.prepare({ companyId: company.id, stepId: "closing" })).rejects.toThrow(/ne prépare pas encore/i);
  });
});
