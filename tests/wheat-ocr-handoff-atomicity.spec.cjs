const { test, expect, _electron: electron } = require("@playwright/test");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
const linkageTriggerName = "atlas_test_abort_ocr_document_linkage";

function launchAtlas(userDataDir) {
  return electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
}

async function openAtlas(userDataDir) {
  const app = await launchAtlas(userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20_000 });
  return { app, page };
}

function installLinkageFailureTrigger(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS "${linkageTriggerName}";
      CREATE TRIGGER "${linkageTriggerName}"
      BEFORE UPDATE OF "invoiceId" ON "Document"
      WHEN OLD."invoiceId" IS NULL AND NEW."invoiceId" IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'atlas_test_abort_ocr_document_linkage');
      END;
    `);
  } finally {
    database.close();
  }
}

function dropLinkageFailureTrigger(databasePath) {
  if (!fs.existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`DROP TRIGGER IF EXISTS "${linkageTriggerName}"`);
  } finally {
    database.close();
  }
}

function count(database, sql, ...params) {
  const row = database.prepare(sql).get(...params);
  return Number(row?.count ?? 0);
}

function readHandoffState(databasePath, companyId, documentId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const document = database.prepare(`
      SELECT "id", "status", "invoiceId", "paymentId", "entryId"
      FROM "Document"
      WHERE "id" = ? AND "companyId" = ?
    `).get(documentId, companyId);
    const chain = database.prepare(`
      SELECT "id", "lastSequence", "lastEventHash"
      FROM "AuditChain"
      WHERE "companyId" = ?
    `).get(companyId);
    return {
      document,
      counterparties: count(database, 'SELECT COUNT(*) AS "count" FROM "Counterparty" WHERE "companyId" = ?', companyId),
      ocrInvoices: count(
        database,
        'SELECT COUNT(*) AS "count" FROM "Invoice" WHERE "companyId" = ? AND "source" = ?',
        companyId,
        "OCR_1_3",
      ),
      ocrInvoiceLines: count(database, `
        SELECT COUNT(*) AS "count"
        FROM "InvoiceLine" line
        JOIN "Invoice" invoice ON invoice."id" = line."invoiceId"
        WHERE invoice."companyId" = ? AND invoice."source" = 'OCR_1_3'
      `, companyId),
      ocrActivityRows: count(database, `
        SELECT COUNT(*) AS "count"
        FROM "ActivityLog"
        WHERE "companyId" = ?
          AND "action" IN ('CREATE_COUNTERPARTY_FROM_OCR', 'CREATE_INVOICE_DRAFT_FROM_OCR')
      `, companyId),
      ocrAuditRows: count(database, `
        SELECT COUNT(*) AS "count"
        FROM "AuditEvent" event
        JOIN "AuditChain" chain ON chain."id" = event."chainId"
        WHERE chain."companyId" = ?
          AND event."action" IN ('CREATE_COUNTERPARTY_FROM_OCR', 'CREATE_INVOICE_DRAFT_FROM_OCR')
      `, companyId),
      chainSequence: chain ? Number(chain.lastSequence) : 0,
      chainHash: chain?.lastEventHash ?? null,
    };
  } finally {
    database.close();
  }
}

test("OCR invoice handoff rolls back every row on linkage failure and commits every row on retry", async () => {
  test.setTimeout(120_000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-1-3-ocr-atomicity-"));
  const userDataDir = path.join(tempDir, "userData");
  const sampleInvoicePath = path.join(tempDir, "FACT-ATOMIC-2026-0814.txt");
  // The document names both parties, as a real supplier invoice does. Wheat no
  // longer treats an unattributable piece as a purchase by default, so a
  // fixture that never mentions its own dossier is now correctly refused before
  // it reaches the transaction this test is about.
  fs.writeFileSync(sampleInvoicePath, [
    "FACTURE N FACT-ATOMIC-2026-0814",
    "Fournisseur: ATOMIC OCR SUPPLIER SARL",
    "ICE: 009876543210123",
    "IF: 55667788",
    "RC: 445566",
    "Client: ATLAS OCR ATOMICITY SARL",
    "ICE: 001234567890123",
    "Date: 14/08/2026",
    "Montant HT: 1000,00 MAD",
    "TVA: 200,00 MAD",
    "Total TTC: 1200,00 MAD",
    "Mode de paiement: Virement",
  ].join("\n"), "utf8");

  let runningApp = null;
  let databasePath = null;
  try {
    let session = await openAtlas(userDataDir);
    runningApp = session.app;
    const prepared = await session.page.evaluate(async (sourcePath) => {
      const api = window.wheat;
      await api.resetWorkspace({ mode: "blank" });
      const company = await api.createCompany({
        name: "ATLAS OCR ATOMICITY SARL",
        legalForm: "SARL",
        ice: "001234567890123",
        taxId: "IF-ATOMIC-2026",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
      const documents = (await api.smartOcrProcess({ companyId: company.id, filePaths: [sourcePath] })).documents;
      const bootstrap = await api.getBootstrap(company.id);
      return {
        companyId: company.id,
        documentId: documents[0]?.id,
        documentStatus: documents[0]?.status,
        extracted: documents[0]?.extracted,
        databasePath: bootstrap.databasePath,
      };
    }, sampleInvoicePath);
    expect(prepared.documentId).toBeTruthy();
    expect(JSON.parse(prepared.extracted).documentType).toBe("INVOICE");
    databasePath = prepared.databasePath;
    await runningApp.close();
    runningApp = null;

    const beforeFailure = readHandoffState(databasePath, prepared.companyId, prepared.documentId);
    expect(beforeFailure.document.invoiceId).toBeNull();
    expect(beforeFailure.counterparties).toBe(0);
    expect(beforeFailure.ocrInvoices).toBe(0);
    expect(beforeFailure.ocrActivityRows).toBe(0);
    expect(beforeFailure.ocrAuditRows).toBe(0);
    installLinkageFailureTrigger(databasePath);

    session = await openAtlas(userDataDir);
    runningApp = session.app;
    const failedAttempt = await session.page.evaluate(async (documentId) => {
      try {
        await window.wheat.postDocumentEntry(documentId);
        return { rejected: false, message: "" };
      } catch (error) {
        return { rejected: true, message: error instanceof Error ? error.message : String(error) };
      }
    }, prepared.documentId);
    expect(failedAttempt.rejected).toBe(true);
    // Prisma maps SQLite RAISE(ABORT) from this UPDATE trigger to its generic
    // constraint error and does not preserve the trigger's custom message.
    expect(failedAttempt.message).toMatch(/document\.updateMany|constraint/i);
    await runningApp.close();
    runningApp = null;

    const afterFailure = readHandoffState(databasePath, prepared.companyId, prepared.documentId);
    expect(afterFailure.document).toEqual(beforeFailure.document);
    expect(afterFailure.counterparties).toBe(0);
    expect(afterFailure.ocrInvoices).toBe(0);
    expect(afterFailure.ocrInvoiceLines).toBe(0);
    expect(afterFailure.ocrActivityRows).toBe(0);
    expect(afterFailure.ocrAuditRows).toBe(0);
    expect(afterFailure.chainSequence).toBe(beforeFailure.chainSequence);
    expect(afterFailure.chainHash).toBe(beforeFailure.chainHash);

    dropLinkageFailureTrigger(databasePath);
    session = await openAtlas(userDataDir);
    runningApp = session.app;
    const committed = await session.page.evaluate(
      async (documentId) => window.wheat.postDocumentEntry(documentId),
      prepared.documentId,
    );
    expect(committed.document.invoiceId).toBe(committed.invoiceDraft.id);
    expect(committed.document.status).toBe("INVOICE_DRAFT");
    expect(committed.invoiceDraft.source).toBe("OCR_1_3");
    expect(committed.invoiceDraft.lifecycleStatus).toBe("DRAFT");
    await runningApp.close();
    runningApp = null;

    const afterRetry = readHandoffState(databasePath, prepared.companyId, prepared.documentId);
    expect(afterRetry.document.invoiceId).toBe(committed.invoiceDraft.id);
    expect(afterRetry.document.status).toBe("INVOICE_DRAFT");
    expect(afterRetry.document.paymentId).toBeNull();
    expect(afterRetry.document.entryId).toBeNull();
    expect(afterRetry.counterparties).toBe(1);
    expect(afterRetry.ocrInvoices).toBe(1);
    expect(afterRetry.ocrInvoiceLines).toBe(1);
    expect(afterRetry.ocrActivityRows).toBe(2);
    expect(afterRetry.ocrAuditRows).toBe(2);
    expect(afterRetry.chainSequence).toBe(beforeFailure.chainSequence + 2);
    expect(afterRetry.chainHash).not.toBe(beforeFailure.chainHash);
  } finally {
    if (runningApp) await runningApp.close().catch(() => undefined);
    if (databasePath) dropLinkageFailureTrigger(databasePath);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
