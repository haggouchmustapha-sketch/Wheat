const { test, expect } = require("@playwright/test");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { createSubledgerService } = tsxRequire(path.join(root, "electron/subledger.ts"), __filename);
const { createReportingService } = tsxRequire(path.join(root, "electron/reporting.ts"), __filename);

test("invoices with an unknown due date can be corrected and posted without inventing terms", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-optional-due-"));
  const databasePath = path.join(directory, "wheat.sqlite");
  fs.copyFileSync(path.join(root, "prisma/dev.db"), databasePath);
  const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath.replace(/\\/g, "/")}` });
  try {
    const company = await prisma.company.create({ data: {
      name: "AUDIT TEST SARL", legalForm: "SARL", ice: "001234567890123", taxId: "TEST-IF", city: "Casablanca",
      fiscalYears: { create: [{ label: "2026", startsOn: new Date("2026-01-01Z"), endsOn: new Date("2026-12-31Z") }] },
      journals: { create: [{ code: "VE", label: "Ventes" }, { code: "AC", label: "Achats" }] },
      accounts: { create: [
        { code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
        { code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY" },
        { code: "711100", label: "Ventes", classNo: 7, type: "REVENUE" },
        { code: "611100", label: "Achats", classNo: 6, type: "EXPENSE" },
      ] },
    }, include: { accounts: true } });
    const service = createSubledgerService({ getPrisma: () => prisma });
    const invoices = [];
    for (const kind of ["SALE", "PURCHASE"]) {
      const counterparty = await service.createCounterparty({ companyId: company.id, kind: kind === "SALE" ? "CUSTOMER" : "SUPPLIER", displayName: `Tiers test ${kind}` });
      const payload = {
        companyId: company.id, counterpartyId: counterparty.id, kind, invoiceNo: `AUDIT-${kind}-001`, invoiceDate: "2026-09-01", dueDate: null,
        lines: [{ description: "Marchandises test", accountId: company.accounts.find((account) => account.code === (kind === "SALE" ? "711100" : "611100")).id, ht: kind === "SALE" ? "1000.01" : "300.02", vat: "0" }],
      };
      const draft = await service.createInvoiceDraft(payload);
      expect(draft.dueDate).toBeNull();
      expect(draft.settlement.settlementStatus).toBe("DRAFT");
      await expect(service.createInvoiceDraft(payload)).rejects.toThrow(/numéro.*existe/i);
      const dated = await service.updateInvoiceDraft({ ...payload, id: draft.id, expectedVersion: draft.version, dueDate: "2026-09-30" });
      const undated = await service.updateInvoiceDraft({ ...payload, id: draft.id, expectedVersion: dated.version, dueDate: "" });
      expect(undated.dueDate).toBeNull();
      await expect(service.updateInvoiceDraft({ ...payload, id: draft.id, expectedVersion: dated.version })).rejects.toThrow(/autre fenêtre/i);
      await expect(service.updateInvoiceDraft({ ...payload, id: draft.id, expectedVersion: undated.version, dueDate: "2026-08-31" })).rejects.toThrow(/précéder/i);
      await service.postInvoice({ companyId: company.id, id: draft.id, expectedVersion: undated.version });
      invoices.push(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } }));
    }
    await prisma.$disconnect();
    await prisma.$connect();
    for (const invoice of invoices) {
      const persisted = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(persisted.dueDate).toBeNull();
      expect(persisted.lifecycleStatus).toBe("POSTED");
      expect(await prisma.invoiceArtifact.count({ where: { invoiceId: invoice.id, immutable: true } })).toBe(1);
    }
    const lines = await prisma.entryLine.findMany({ where: { entry: { companyId: company.id, status: "POSTED" } } });
    // Independent expected sums: sale 100001 centimes + purchase 30002.
    expect(lines.reduce((sum, line) => sum + line.debitCents, 0n)).toBe(130003n);
    expect(lines.reduce((sum, line) => sum + line.creditCents, 0n)).toBe(130003n);
    const reports = createReportingService({ getPrisma: () => prisma });
    const trial = await reports.trialBalance({ companyId: company.id, from: "2026-01-01", to: "2026-12-31" });
    expect(trial.totals.periodDebitCents).toBe("130003");
    expect(trial.totals.periodCreditCents).toBe("130003");
  } finally {
    await prisma.$disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
