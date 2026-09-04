/**
 * The guided dossier journey, derived from the dossier itself.
 *
 * The point of this suite is that the journey holds no state of its own. Every
 * assertion below changes a *record* — creates a fiscal year, maps a bank
 * account, posts an invoice — and expects the journey to move accordingly on
 * the next read. A parallel task table would pass none of these without extra
 * bookkeeping; that is exactly why there isn't one.
 *
 * It also pins the two things Wheat must never guess: the VAT filing rhythm and
 * the bank-to-ledger mapping. Both surface as one focused question that says
 * why it is being asked and where the answer lives.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const journeyModule = tsxRequire(path.join(root, "electron", "wheatJourney.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

test.describe("guided dossier journey", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let company;
  let service;

  const stage = (state, id) => state.stages.find((item) => item.id === id);

  test.beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-journey-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();
    company = await prisma.company.create({
      data: { name: "NOUVEAU DOSSIER", legalForm: "SARL", ice: "", taxId: "", city: "", vatFrequency: "" },
    });
    service = journeyModule.createWheatJourneyService({ getPrisma: async () => prisma });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("with no dossier at all, the single next action is to create one", async () => {
    const state = await service.state({});
    expect(state.companyId).toBeNull();
    expect(state.next.id).toBe("dossier");
    expect(state.next.action.target).toBe("companies");
  });

  test("a bare dossier asks its unanswered question first, not its easiest step", async () => {
    const state = await service.state({ companyId: company.id });
    expect(state.total).toBe(15);
    // Identity is incomplete and the VAT rhythm is unknown. The rhythm is the
    // one Wheat cannot infer, so it is what the user is asked.
    expect(state.next.status).toBe("NEEDS_ANSWER");
    expect(state.next.id).toBe("vat-configuration");
    expect(state.next.question.prompt).toMatch(/mois ou tous les trimestres/i);
    expect(state.next.question.why).toMatch(/ne peut pas le déduire|suppose/i);
    expect(state.next.question.whereToFind).toMatch(/attestation fiscale|déclaration/i);
  });

  test("every stage carries why it matters and what the dossier currently shows", async () => {
    const state = await service.state({ companyId: company.id });
    for (const item of state.stages) {
      expect(String(item.why).length, item.id).toBeGreaterThan(30);
      expect(String(item.state).length, item.id).toBeGreaterThan(5);
      expect(["DONE", "READY", "BLOCKED", "NEEDS_ANSWER"], item.id).toContain(item.status);
      if (item.status === "BLOCKED") expect(item.blockedBy, item.id).toBeTruthy();
      if (item.status === "NEEDS_ANSWER") expect(item.question, item.id).toBeTruthy();
    }
  });

  test("completing the identity and the exercise moves both stages to done", async () => {
    let state = await service.state({ companyId: company.id });
    expect(stage(state, "identity").status).toBe("READY");
    expect(stage(state, "identity").state).toMatch(/ICE/);
    expect(stage(state, "fiscal-year").status).toBe("READY");

    await prisma.company.update({
      where: { id: company.id },
      data: { ice: "000187958000077", taxId: "1110375", city: "Casablanca", vatFrequency: "MONTHLY" },
    });
    await prisma.fiscalYear.create({
      data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" },
    });

    state = await service.state({ companyId: company.id });
    expect(stage(state, "identity").status).toBe("DONE");
    expect(stage(state, "fiscal-year").status).toBe("DONE");
    // The exercise Wheat picked on its own is shown rather than asked about.
    expect(state.inferred.join(" ")).toMatch(/Exercice retenu automatiquement : 2026/);
  });

  test("the chart of accounts and journals are reported as installed once they exist", async () => {
    expect(stage(await service.state({ companyId: company.id }), "chart").status).toBe("READY");
    await prisma.account.create({
      data: { companyId: company.id, code: "342100", label: "Clients", classNo: 3, type: "ASSET", active: true, postable: true, searchText: "342100 clients" },
    });
    await prisma.journal.create({ data: { companyId: company.id, code: "VT", label: "Ventes", active: true } });
    const state = await service.state({ companyId: company.id });
    expect(stage(state, "chart").status).toBe("DONE");
    expect(state.inferred.join(" ")).toMatch(/Plan comptable installé/);
  });

  test("an unmapped bank account asks which ledger account it is, and stops asking once mapped", async () => {
    const ledger = await prisma.account.create({
      data: { companyId: company.id, code: "514100", label: "Banque", classNo: 5, type: "ASSET", active: true, postable: true, searchText: "514100 banque" },
    });
    const bank = await prisma.bankAccount.create({
      data: { companyId: company.id, bankName: "BMCE", iban: "MA000", balanceCents: 0n, active: true },
    });

    let state = await service.state({ companyId: company.id });
    const unmapped = stage(state, "bank-account");
    expect(unmapped.status).toBe("NEEDS_ANSWER");
    expect(unmapped.question.prompt).toMatch(/BMCE/);
    expect(unmapped.question.why).toMatch(/jamais un compte de trésorerie de sa propre initiative/i);
    expect(unmapped.question.whereToFind).toMatch(/classe 5/i);
    // Reconciliation depends on it, and says so rather than sitting idle.
    expect(stage(state, "reconciliation").status).toBe("BLOCKED");
    expect(stage(state, "reconciliation").blockedBy).toBe("bank-account");

    await prisma.bankAccount.update({ where: { id: bank.id }, data: { ledgerAccountId: ledger.id } });
    state = await service.state({ companyId: company.id });
    expect(stage(state, "bank-account").status).toBe("DONE");
    expect(stage(state, "bank-account").question).toBeNull();
    expect(stage(state, "reconciliation").status).toBe("READY");
  });

  test("draft invoices and unallocated payments become the next action, in the accounting order", async () => {
    await prisma.company.update({ where: { id: company.id }, data: { ice: "000187958000077", taxId: "1110375", city: "Casablanca", vatFrequency: "MONTHLY" } });
    await prisma.fiscalYear.create({
      data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" },
    });
    const counterparty = await prisma.counterparty.create({
      data: { companyId: company.id, kind: "CUSTOMER", displayName: "CLIENT", identityKey: "NAME:CLIENT" },
    });
    await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "SALE", counterparty: "CLIENT", counterpartyId: counterparty.id,
        invoiceNo: "FA-1", invoiceDate: new Date("2026-02-01T00:00:00Z"),
        htCents: 1000n, vatCents: 200n, ttcCents: 1200n, status: "DRAFT", lifecycleStatus: "DRAFT",
      },
    });

    let state = await service.state({ companyId: company.id });
    expect(stage(state, "invoices").status).toBe("READY");
    expect(stage(state, "invoices").state).toMatch(/1 en brouillon/);
    // No posted invoice yet, so there is nothing a payment could settle.
    expect(stage(state, "payments").status).toBe("BLOCKED");
    expect(stage(state, "payments").blockedBy).toBe("invoices");

    await prisma.invoice.updateMany({ where: { companyId: company.id }, data: { lifecycleStatus: "POSTED" } });
    state = await service.state({ companyId: company.id });
    expect(stage(state, "invoices").status).toBe("DONE");
    expect(stage(state, "payments").status).toBe("READY");
  });

  test("reports and closing stay blocked until something is actually posted", async () => {
    const state = await service.state({ companyId: company.id });
    expect(stage(state, "reports").status).toBe("BLOCKED");
    expect(stage(state, "reports").blockedBy).toBe("entries");
    expect(stage(state, "closing").status).toBe("BLOCKED");
    expect(stage(state, "reports").why).toMatch(/comptabilisées/i);
  });

  test("a dossier that no longer exists is refused rather than answered emptily", async () => {
    await expect(service.state({ companyId: "gone" })).rejects.toThrow(/n'existe plus/i);
  });
});
