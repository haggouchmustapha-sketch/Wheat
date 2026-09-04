const { test, expect } = require("@playwright/test");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const modulePath = path.join(root, "electron", "creditNotes14.ts");
const pdfModulePath = path.join(root, "electron", "creditNotePdf14.ts");
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

let creditNotes;
let creditPdf;
let prisma;
let temporaryRoot;
let databasePath;
let fixture;
let service;

const day = (value) => new Date(`${value}T00:00:00.000Z`);
const sqliteUrl = (value) => `file:${value.replace(/\\/g, "/")}`;

function payloadFor(original, line, overrides = {}) {
  return {
    companyId: original.companyId,
    creditedInvoiceId: original.id,
    invoiceDate: "2026-08-10",
    creditReason: "Réduction commerciale documentée",
    lines: [{
      creditedInvoiceLineId: line.id,
      htCents: "5000",
      vatCents: "1000",
      ttcCents: "6000",
    }],
    ...overrides,
  };
}

async function createFixture(db) {
  const company = await db.company.create({
    data: {
      name: "Atlas Credit Test",
      legalForm: "SARL",
      ice: `ICE-${crypto.randomUUID()}`,
      taxId: "IF-CREDIT",
      city: "Rabat",
      fiscalYears: { create: [{ label: "2026", startsOn: day("2026-01-01"), endsOn: day("2026-12-31"), status: "OPEN" }] },
      journals: { create: [
        { code: "VE", label: "Ventes", nextNumber: 1 },
        { code: "AC", label: "Achats", nextNumber: 1 },
      ] },
      accounts: { create: [
        { code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
        { code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY" },
        { code: "445500", label: "TVA facturée", classNo: 4, type: "LIABILITY" },
        { code: "345520", label: "TVA récupérable", classNo: 3, type: "ASSET" },
        { code: "712400", label: "Prestations", classNo: 7, type: "REVENUE" },
        { code: "711100", label: "Ventes", classNo: 7, type: "REVENUE" },
        { code: "612500", label: "Achats", classNo: 6, type: "EXPENSE" },
      ] },
    },
    include: { accounts: true },
  });
  const account = (code) => company.accounts.find((row) => row.code === code);
  const customer = await db.counterparty.create({
    data: {
      companyId: company.id,
      kind: "CUSTOMER",
      displayName: "Client Atlas",
      legalName: "Client Atlas SARL",
      ice: "001111111111111",
      identityKey: `ICE:${crypto.randomUUID()}`,
      defaultReceivableAccountId: account("342100").id,
    },
  });
  const supplier = await db.counterparty.create({
    data: {
      companyId: company.id,
      kind: "SUPPLIER",
      displayName: "Fournisseur Atlas",
      legalName: "Fournisseur Atlas SARL",
      ice: "002222222222222",
      identityKey: `ICE:${crypto.randomUUID()}`,
      defaultPayableAccountId: account("441100").id,
    },
  });
  const sale = await db.invoice.create({
    data: {
      companyId: company.id,
      kind: "SALE",
      counterparty: customer.displayName,
      counterpartyId: customer.id,
      counterpartyNameSnapshot: customer.displayName,
      iceSnapshot: customer.ice,
      invoiceNo: `FA-${crypto.randomUUID()}`,
      numberKey: `SALE:${crypto.randomUUID()}`,
      invoiceDate: day("2026-08-01"),
      dueDate: day("2026-08-31"),
      currency: "MAD",
      htCents: 15000n,
      vatCents: 3000n,
      ttcCents: 18000n,
      status: "UNPAID",
      lifecycleStatus: "POSTED",
      source: "TEST",
      needsReview: false,
      controlAccountId: account("342100").id,
      vatAccountId: account("445500").id,
      lines: { create: [
        { position: 1, description: "Prestation A", accountId: account("712400").id, vatRateBps: 2000, htCents: 10000n, vatCents: 2000n, ttcCents: 12000n },
        { position: 2, description: "Prestation B", accountId: account("711100").id, vatRateBps: 2000, htCents: 5000n, vatCents: 1000n, ttcCents: 6000n },
      ] },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  const purchase = await db.invoice.create({
    data: {
      companyId: company.id,
      kind: "PURCHASE",
      counterparty: supplier.displayName,
      counterpartyId: supplier.id,
      counterpartyNameSnapshot: supplier.displayName,
      iceSnapshot: supplier.ice,
      invoiceNo: `FR-${crypto.randomUUID()}`,
      numberKey: `PURCHASE:${crypto.randomUUID()}`,
      invoiceDate: day("2026-08-02"),
      dueDate: day("2026-09-01"),
      currency: "MAD",
      htCents: 13000n,
      vatCents: 2600n,
      ttcCents: 15600n,
      status: "UNPAID",
      lifecycleStatus: "POSTED",
      source: "TEST",
      needsReview: false,
      controlAccountId: account("441100").id,
      vatAccountId: account("345520").id,
      lines: { create: [
        { position: 1, description: "Achat A", accountId: account("612500").id, vatRateBps: 2000, htCents: 13000n, vatCents: 2600n, ttcCents: 15600n },
      ] },
    },
    include: { lines: true },
  });
  return { company, account, customer, supplier, sale, purchase };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  [creditNotes, creditPdf] = await Promise.all([
    tsxRequire(modulePath, __filename),
    tsxRequire(pdfModulePath, __filename),
  ]);
});

test.beforeEach(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-14-credit-"));
  databasePath = path.join(temporaryRoot, "atlas.sqlite");
  fs.copyFileSync(migratedDatabasePath, databasePath);
  prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
  await prisma.$connect();
  fixture = await createFixture(prisma);
  service = creditNotes.createCreditNotes14Service({
    getPrisma: () => prisma,
    now: () => new Date("2026-08-10T12:34:56.000Z"),
  });
});

test.afterEach(async () => {
  if (prisma) await prisma.$disconnect();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  prisma = null;
  service = null;
  fixture = null;
  temporaryRoot = null;
});

test("rejects JavaScript money numbers and cross-company source invoices", async () => {
  await expect(service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: 5000, vatCents: "1000", ttcCents: "6000" }],
  }))).rejects.toThrow(/nombre JavaScript/i);

  const other = await prisma.company.create({
    data: { name: "Autre société", legalForm: "SARL", ice: `OTHER-${crypto.randomUUID()}`, taxId: "IF-OTHER", city: "Fès" },
  });
  await expect(service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], { companyId: other.id }))).rejects.toThrow(/n'appartient pas/i);
  expect(await prisma.invoice.count({ where: { documentType: "CREDIT_NOTE", companyId: fixture.company.id } })).toBe(0);
});

test("posts a balanced sale credit in opposite directions and atomically creates its deterministic PDF", async () => {
  const draft = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0]));
  expect(draft).toMatchObject({
    documentType: "CREDIT_NOTE",
    lifecycleStatus: "DRAFT",
    artifactRequired: true,
    ttcCents: "6000",
    originalInvoice: { id: fixture.sale.id, kind: "SALE", currency: "MAD" },
    remainingCredit: { remainingTtcCents: "18000", activePaymentCents: "0", postedCreditCents: "0" },
  });
  expect(draft.lines[0]).toMatchObject({ creditedInvoiceLineId: fixture.sale.lines[0].id, accountId: fixture.sale.lines[0].accountId, htCents: "5000", vatCents: "1000", ttcCents: "6000" });

  const posted = await service.postCreditNote({ id: draft.id, companyId: fixture.company.id, expectedVersion: draft.version });
  expect(posted.invoiceNo).toMatch(/^AV-2026-\d{6}$/);
  expect(posted).toMatchObject({ lifecycleStatus: "POSTED", status: "CREDITED", remainingCredit: { postedCreditCents: "6000", remainingTtcCents: "12000" } });
  expect(posted.artifacts).toHaveLength(1);
  expect(posted.artifacts[0]).toMatchObject({ kind: "CREDIT_NOTE_PDF", revision: 1, mimeType: "application/pdf", immutable: true });

  const entry = await prisma.entry.findUniqueOrThrow({ where: { id: posted.postedEntryId }, include: { lines: { include: { account: true }, orderBy: { position: "asc" } } } });
  expect(entry.reversalOfId).toBeNull();
  expect(entry.status).toBe("POSTED");
  expect(entry.lines.map((line) => [line.account.code, line.debitCents.toString(), line.creditCents.toString()])).toEqual([
    ["712400", "5000", "0"],
    ["445500", "1000", "0"],
    ["342100", "0", "6000"],
  ]);
  expect(entry.lines.reduce((sum, line) => sum + line.debitCents, 0n)).toBe(entry.lines.reduce((sum, line) => sum + line.creditCents, 0n));

  const artifact = await prisma.invoiceArtifact.findFirstOrThrow({ where: { invoiceId: draft.id } });
  expect(Buffer.from(artifact.pdfBytes).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
  expect(Buffer.from(artifact.pdfBytes).toString("latin1")).toContain("WHEAT - AVOIR");
  expect(Buffer.from(artifact.pdfBytes).toString("latin1")).not.toContain("ATLAS LEDGER");
  expect(crypto.createHash("sha256").update(Buffer.from(artifact.pdfBytes)).digest("hex")).toBe(artifact.contentSha256);
  const evidence = JSON.parse(artifact.payloadJson);
  const deterministicSnapshot = {
    company: evidence.company,
    creditNote: evidence.creditNote,
    originalInvoice: evidence.originalInvoice,
    entry: evidence.entry,
    lines: evidence.lines,
    payloadSha256: artifact.payloadSha256,
  };
  const regeneratedA = creditPdf.generateCreditNotePdf14(deterministicSnapshot);
  const regeneratedB = creditPdf.generateCreditNotePdf14(deterministicSnapshot);
  expect(regeneratedA).toEqual(regeneratedB);
  expect(regeneratedA).toEqual(Buffer.from(artifact.pdfBytes));
  const verified = await service.verifyInvoiceArtifact({ companyId: fixture.company.id, artifactId: artifact.id });
  expect(verified).toEqual(expect.objectContaining({ valid: true, problems: [] }));
  const exported = await service.exportInvoiceArtifact({ companyId: fixture.company.id, artifactId: artifact.id });
  expect(Buffer.from(exported.bytesBase64, "base64")).toEqual(Buffer.from(artifact.pdfBytes));
});

test("requires a supplier reference and posts a purchase credit in inverse directions", async () => {
  const base = payloadFor(fixture.purchase, fixture.purchase.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.purchase.lines[0].id, htCents: "3000", vatCents: "600", ttcCents: "3600" }],
  });
  await expect(service.createCreditNote(base)).rejects.toThrow(/référence.*fournisseur/i);
  const draft = await service.createCreditNote({ ...base, invoiceNo: "AF-SUP-2026-001" });
  const posted = await service.postCreditNote({ id: draft.id, companyId: fixture.company.id, expectedVersion: draft.version });
  expect(posted.invoiceNo).toBe("AF-SUP-2026-001");
  const entry = await prisma.entry.findUniqueOrThrow({ where: { id: posted.postedEntryId }, include: { lines: { include: { account: true }, orderBy: { position: "asc" } } } });
  expect(entry.lines.map((line) => [line.account.code, line.debitCents.toString(), line.creditCents.toString()])).toEqual([
    ["612500", "0", "3000"],
    ["345520", "0", "600"],
    ["441100", "3600", "0"],
  ]);
});

test("enforces global payment capacity and per-line HT/TVA/TTC capacity", async () => {
  const first = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "9000", vatCents: "1800", ttcCents: "10800" }],
  }));
  await service.postCreditNote({ id: first.id, companyId: fixture.company.id, expectedVersion: first.version });
  await expect(service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "1100", vatCents: "200", ttcCents: "1300" }],
  }))).rejects.toThrow(/dépasse son solde/i);

  const payment = await prisma.payment.create({
    data: {
      companyId: fixture.company.id,
      counterpartyId: fixture.customer.id,
      kind: "RECEIPT",
      paymentDate: day("2026-08-05"),
      method: "Virement",
      amountCents: 6000n,
      lifecycleStatus: "POSTED",
      source: "TEST",
    },
  });
  await prisma.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: fixture.sale.id, amountCents: 6000n, status: "ACTIVE" } });
  await expect(service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[1], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[1].id, htCents: "2000", vatCents: "400", ttcCents: "2400" }],
  }))).rejects.toThrow(/sur-créditée|sur-payée|dépasserait/i);
});

test("optimistic versions and the posting reservation prevent stale and concurrent over-credit", async () => {
  const stale = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "1000", vatCents: "200", ttcCents: "1200" }],
  }));
  const updated = await service.updateCreditNote({
    ...payloadFor(fixture.sale, fixture.sale.lines[0], {
      lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "2000", vatCents: "400", ttcCents: "2400" }],
    }),
    id: stale.id,
    expectedVersion: stale.version,
  });
  await expect(service.postCreditNote({ id: stale.id, companyId: fixture.company.id, expectedVersion: stale.version })).rejects.toThrow(/modifié/i);
  expect(updated.version).toBe(stale.version + 1);

  const a = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "10000", vatCents: "2000", ttcCents: "12000" }],
  }));
  const b = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0], {
    lines: [{ creditedInvoiceLineId: fixture.sale.lines[0].id, htCents: "10000", vatCents: "2000", ttcCents: "12000" }],
  }));
  const results = await Promise.allSettled([
    service.postCreditNote({ id: a.id, companyId: fixture.company.id, expectedVersion: a.version }),
    service.postCreditNote({ id: b.id, companyId: fixture.company.id, expectedVersion: b.version }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const posted = await prisma.invoice.findMany({ where: { creditedInvoiceId: fixture.sale.id, documentType: "CREDIT_NOTE", lifecycleStatus: "POSTED" } });
  expect(posted.reduce((sum, row) => sum + row.ttcCents, 0n)).toBeLessThanOrEqual(fixture.sale.ttcCents);
});

test("rolls back entry, numbering, audit, and source reservation when PDF generation fails", async () => {
  const draft = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0]));
  const originalBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.sale.id } });
  const journalBefore = await prisma.journal.findUniqueOrThrow({ where: { companyId_code: { companyId: fixture.company.id, code: "VE" } } });
  const failing = creditNotes.createCreditNotes14Service({
    getPrisma: () => prisma,
    generateArtifact: async () => { throw new Error("PDF storage unavailable"); },
    now: () => new Date("2026-08-10T12:34:56.000Z"),
  });
  await expect(failing.postCreditNote({ id: draft.id, companyId: fixture.company.id, expectedVersion: draft.version })).rejects.toThrow(/PDF storage unavailable/);
  const [unchanged, originalAfter, journalAfter, artifacts, entries, postAudits] = await Promise.all([
    prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } }),
    prisma.invoice.findUniqueOrThrow({ where: { id: fixture.sale.id } }),
    prisma.journal.findUniqueOrThrow({ where: { companyId_code: { companyId: fixture.company.id, code: "VE" } } }),
    prisma.invoiceArtifact.count({ where: { invoiceId: draft.id } }),
    prisma.entry.count({ where: { companyId: fixture.company.id, source: "SUBLEDGER_CREDIT_NOTE_1_4" } }),
    prisma.auditEvent.count({ where: { entityId: draft.id, action: "POST_CREDIT_NOTE" } }),
  ]);
  expect(unchanged.lifecycleStatus).toBe("DRAFT");
  expect(unchanged.postedEntryId).toBeNull();
  expect(originalAfter.version).toBe(originalBefore.version);
  expect(journalAfter.nextNumber).toBe(journalBefore.nextNumber);
  expect({ artifacts, entries, postAudits }).toEqual({ artifacts: 0, entries: 0, postAudits: 0 });
});

test("database triggers block artifact mutation/deletion and verification detects hostile tampering", async () => {
  const draft = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0]));
  const posted = await service.postCreditNote({ id: draft.id, companyId: fixture.company.id, expectedVersion: draft.version });
  const artifactId = posted.artifacts[0].id;
  await expect(prisma.$executeRawUnsafe('UPDATE "InvoiceArtifact" SET "payloadJson" = ? WHERE "id" = ?', "{}", artifactId)).rejects.toThrow(/cannot be updated/i);
  await expect(prisma.invoiceArtifact.delete({ where: { id: artifactId } })).rejects.toThrow(/cannot be deleted|foreign key constraint/i);

  // Simulate an attacker with enough database access to remove a guard. The
  // application-level verifier must still refuse the changed evidence.
  await prisma.$executeRawUnsafe('DROP TRIGGER "InvoiceArtifact_immutable_update"');
  await prisma.$executeRawUnsafe('UPDATE "InvoiceArtifact" SET "pdfBytes" = ? WHERE "id" = ?', Buffer.from("%PDF-1.4 hostile"), artifactId);
  const verification = await service.verifyInvoiceArtifact({ companyId: fixture.company.id, artifactId });
  expect(verification.valid).toBe(false);
  expect(verification.problems.join(" ")).toMatch(/empreinte|taille/i);
  await expect(service.exportInvoiceArtifact({ companyId: fixture.company.id, artifactId })).rejects.toThrow(/intégrité/i);
});

test("rolls back posting when artifact persistence fails after the ledger entry was prepared", async () => {
  const draft = await service.createCreditNote(payloadFor(fixture.sale, fixture.sale.lines[0]));
  const payloadJson = "{}";
  const payloadSha256 = crypto.createHash("sha256").update(payloadJson).digest("hex");
  const pdfBytes = Buffer.from("%PDF-1.4 existing");
  await prisma.invoiceArtifact.create({
    data: {
      companyId: fixture.company.id,
      invoiceId: draft.id,
      kind: "CREDIT_NOTE_PDF",
      revision: 1,
      pdfBytes,
      byteSize: BigInt(pdfBytes.length),
      contentSha256: crypto.createHash("sha256").update(pdfBytes).digest("hex"),
      payloadJson,
      payloadSha256,
      immutable: true,
    },
  });
  await expect(service.postCreditNote({ id: draft.id, companyId: fixture.company.id, expectedVersion: draft.version })).rejects.toThrow(/Unique constraint|unique/i);
  const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  expect(unchanged.lifecycleStatus).toBe("DRAFT");
  expect(unchanged.postedEntryId).toBeNull();
  expect(await prisma.entry.count({ where: { companyId: fixture.company.id, source: "SUBLEDGER_CREDIT_NOTE_1_4" } })).toBe(0);
});

test("creates normal-invoice evidence through the same caller transaction primitive", async () => {
  const journal = await prisma.journal.findUniqueOrThrow({ where: { companyId_code: { companyId: fixture.company.id, code: "VE" } } });
  const entry = await prisma.entry.create({
    data: {
      companyId: fixture.company.id,
      journalId: journal.id,
      journalCodeSnapshot: journal.code,
      number: `VE-2026-${crypto.randomUUID()}`,
      date: day("2026-08-01"),
      pieceNumber: fixture.sale.invoiceNo,
      label: `Facture ${fixture.sale.invoiceNo}`,
      status: "POSTED",
      postedAt: day("2026-08-01"),
      source: "TEST_NORMAL_INVOICE_ARTIFACT",
      lines: { create: [
        { position: 1, accountId: fixture.account("342100").id, accountCodeSnapshot: "342100", accountLabelSnapshot: "Clients", label: "Client", debitCents: 18000n, creditCents: 0n },
        { position: 2, accountId: fixture.account("712400").id, accountCodeSnapshot: "712400", accountLabelSnapshot: "Prestations", label: "Prestation", debitCents: 0n, creditCents: 15000n },
        { position: 3, accountId: fixture.account("445500").id, accountCodeSnapshot: "445500", accountLabelSnapshot: "TVA facturée", label: "TVA", debitCents: 0n, creditCents: 3000n },
      ] },
    },
  });
  const artifact = await prisma.$transaction((tx) => creditNotes.createImmutablePostedInvoiceArtifact14(tx, {
    companyId: fixture.company.id,
    invoiceId: fixture.sale.id,
    entryId: entry.id,
    createdByUserId: null,
  }));
  const storedArtifact = await prisma.invoiceArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
  expect(Buffer.from(storedArtifact.pdfBytes).toString("latin1")).toContain("WHEAT - FACTURE");
  expect(Buffer.from(storedArtifact.pdfBytes).toString("latin1")).not.toContain("ATLAS LEDGER");
  expect(artifact).toMatchObject({ invoiceId: fixture.sale.id, kind: "INVOICE_PDF", revision: 1, immutable: true, mimeType: "application/pdf" });
  expect(await service.verifyInvoiceArtifact({ companyId: fixture.company.id, artifactId: artifact.id })).toEqual(expect.objectContaining({ valid: true, problems: [] }));
  await expect(prisma.$transaction((tx) => creditNotes.createImmutablePostedInvoiceArtifact14(tx, {
    companyId: fixture.company.id,
    invoiceId: fixture.sale.id,
    entryId: entry.id,
  }))).rejects.toThrow(/Unique constraint|unique/i);
});
