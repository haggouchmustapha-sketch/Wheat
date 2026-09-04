const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Wheat posts a tax-versioned invoice and linked credit with immutable evidence", async () => {
  test.setTimeout(90_000);
  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-14-integration-"));
  const userDataDir = path.join(profileRoot, "userData");
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });

  let databasePath;
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15_000 });
    await page.evaluate(() => window.wheat.resetWorkspace({ mode: "demo" }));
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15_000 });

    const result = await page.evaluate(async () => {
      const atlas = window.wheat;
      const boot = await atlas.getBootstrap();
      const company = boot.companies[0];
      if (!company) throw new Error("La démonstration ne contient aucune société.");
      const counterparties = await atlas.listCounterparties({ companyId: company.id, kind: "CUSTOMER", limit: 20 });
      const counterparty = counterparties.items.find((item) => item.active);
      const revenueAccount = company.accounts.find((account) => account.code === "711100");
      if (!counterparty || !revenueAccount) throw new Error("Le tiers client ou le compte 711100 est absent.");

      const configurationDraft = await atlas.saveTaxConfigurationDraft({
        companyId: company.id,
        name: "TVA 2026 vérifiée",
        accountingBasis: "COLLECTION",
        frequency: "MONTHLY",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        sourceReference: "Paramétrage de test contrôlé — CGI 2026, base encaissements",
        rates: [{ code: "TVA20", label: "TVA 20 %", rateBps: 2000, direction: "COLLECTED", deductibilityBps: 0 }],
      });
      const configuration = await atlas.activateTaxConfiguration({
        companyId: company.id,
        id: configurationDraft.id,
        expectedVersion: configurationDraft.version,
      });
      const rate = configuration.rates[0];

      const invoiceDraft = await atlas.createInvoiceDraft({
        companyId: company.id,
        kind: "SALE",
        counterpartyId: counterparty.id,
        invoiceDate: "2026-08-10",
        dueDate: "2026-09-09",
        currency: "MAD",
        taxConfigurationVersionId: configuration.id,
        lines: [{
          description: "Prestation Wheat",
          accountId: revenueAccount.id,
          ht: "100.00",
          vat: "20.00",
          ttc: "120.00",
          vatRateBps: 2000,
          taxRateDefinitionId: rate.id,
        }],
      });
      const invoice = await atlas.postInvoice({ id: invoiceDraft.id, companyId: company.id, expectedVersion: invoiceDraft.version });
      const artifactResult = await atlas.listInvoiceArtifacts({ companyId: company.id, invoiceId: invoice.id });
      const invoiceArtifact = artifactResult.items[0];
      const invoiceVerification = await atlas.verifyInvoiceArtifact({ companyId: company.id, artifactId: invoiceArtifact.id });

      const creditDraft = await atlas.createCreditNoteDraft({
        companyId: company.id,
        creditedInvoiceId: invoice.id,
        invoiceDate: "2026-08-15",
        creditReason: "Réduction commerciale partielle documentée",
        lines: [{ creditedInvoiceLineId: invoice.lines[0].id, htCents: "2000", vatCents: "400", ttcCents: "2400" }],
      });
      const credit = await atlas.postCreditNote({ id: creditDraft.id, companyId: company.id, expectedVersion: creditDraft.version });
      const creditArtifacts = await atlas.listInvoiceArtifacts({ companyId: company.id, invoiceId: credit.id });
      const creditVerification = await atlas.verifyInvoiceArtifact({ companyId: company.id, artifactId: creditArtifacts.items[0].id });
      const settlement = await atlas.getInvoiceSettlement({ companyId: company.id, id: invoice.id });

      let overpaymentRejected = false;
      try {
        await atlas.createPaymentDraft({
          companyId: company.id,
          kind: "RECEIPT",
          counterpartyId: counterparty.id,
          paymentDate: "2026-08-20",
          reference: "OVER-CREDIT-CAP",
          method: "Virement",
          amount: "100.00",
          allocations: [{ invoiceId: invoice.id, amount: "100.00" }],
        });
      } catch (error) {
        overpaymentRejected = /dépasse|solde|imput/i.test(String(error));
      }

      const integrity = await atlas.getAccountingIntegrity({ companyId: company.id, maxIssues: 250 });
      const databasePath = await atlas.getDatabasePath();
      await atlas.resetWorkspace({ mode: "blank" });
      const blank = await atlas.getBootstrap();
      return {
        databasePath,
        invoice: { status: invoice.lifecycleStatus, documentType: invoice.documentType, artifactRequired: invoice.artifactRequired },
        invoiceArtifact: { valid: invoiceVerification.valid, kind: invoiceArtifact.kind, immutable: invoiceArtifact.immutable },
        credit: { status: credit.lifecycleStatus, documentType: credit.documentType, creditedInvoiceId: credit.creditedInvoiceId },
        creditArtifactValid: creditVerification.valid,
        settlement: {
          originalCents: invoice.ttcCents,
          creditedCents: settlement.creditedCents,
          balanceCents: settlement.balanceCents,
        },
        overpaymentRejected,
        integrity: { status: integrity.status, issues: integrity.issues },
        blankCompanyCount: blank.companies.length,
      };
    });

    databasePath = result.databasePath;
    expect(result.invoice).toEqual({ status: "POSTED", documentType: "INVOICE", artifactRequired: true });
    expect(result.invoiceArtifact).toEqual({ valid: true, kind: "INVOICE_PDF", immutable: true });
    expect(result.credit).toMatchObject({ status: "POSTED", documentType: "CREDIT_NOTE" });
    expect(result.credit.creditedInvoiceId).toBeTruthy();
    expect(result.creditArtifactValid).toBe(true);
    expect(result.settlement).toEqual({ originalCents: "12000", creditedCents: "2400", balanceCents: "9600" });
    expect(result.overpaymentRejected).toBe(true);
    expect(result.integrity.issues.filter((issue) => issue.severity === "ERROR")).toEqual([]);
    expect(result.blankCompanyCount).toBe(0);
  } finally {
    await app.close();
  }

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM InvoiceArtifact").get().count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'InvoiceArtifact_immutable_%'").get().count).toBe(2);
    expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
