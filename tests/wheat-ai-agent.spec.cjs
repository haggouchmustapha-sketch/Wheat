const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const registry = tsxRequire(path.join(root, "electron", "wheatAiCapabilityRegistry.ts"), __filename);
const gatewayModule = tsxRequire(path.join(root, "electron", "wheatAiDomainGateway.ts"), __filename);
const ai = tsxRequire(path.join(root, "electron", "wheatAi.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

test("the 2.1.260901 registry is broad, typed, categorized and contains no raw-system capabilities", () => {
  const capabilities = registry.publicWheatAiCapabilities();
  expect(capabilities.length).toBeGreaterThanOrEqual(60);
  expect(new Set(capabilities.map((item) => item.category)).size).toBeGreaterThanOrEqual(10);
  for (const category of ["accounts", "journals", "entries", "banking", "documents", "vat", "fiscal", "reports", "imports", "navigation"]) {
    expect(capabilities.some((item) => item.category === category), `missing ${category}`).toBe(true);
  }
  for (const item of capabilities) {
    expect(item.companyScoped).toBe(true);
    expect(item.requiredRoles.length).toBeGreaterThan(0);
    expect([0, 1, 2, 3]).toContain(item.riskLevel);
    expect(item.inputSchema.type).toBe("object");
    expect(item).toHaveProperty("outputSchema");
    expect(item).toHaveProperty("auditCategory");
  }
  const serialized = JSON.stringify(capabilities).toLowerCase();
  for (const forbidden of ["runsql", "executeprisma", "readdatabase", "writedatabase", "executeshell", "readanyfile", "deleteanyfile"]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test("strict schemas reject unknown fields, malformed cents and unsafe dates", () => {
  const createEntry = registry.getWheatAiCapability("entries.create_draft");
  expect(() => registry.validateWheatAiCapabilityInput(createEntry, {
    journalId: "journal", date: "2026-08-28", label: "Achat", lines: [
      { accountId: "expense", label: "Charge", debitCents: "120000", creditCents: "0", sql: "DROP TABLE Entry" },
    ],
  })).toThrow(/champs non autorisés/i);
  expect(() => registry.validateWheatAiCapabilityInput(createEntry, {
    journalId: "journal", date: "28/08/2026", label: "Achat", lines: [{ accountId: "expense", label: "Charge", debitCents: "1200.50", creditCents: "0" }],
  })).toThrow(/format invalide/i);
  expect(() => registry.validateWheatAiCapabilityInput(registry.getWheatAiCapability("accounts.save"), { code: "61234", label: "Honoraires", type: "EXPENSE", arbitrary: true })).toThrow(/non autorisés/i);
});

test("intent guard distinguishes questions, previews and explicit execution", () => {
  expect(registry.classifyWheatAiIntent("Can Wheat create fiscal years?")).toBe("INFORMATION");
  expect(registry.classifyWheatAiIntent("What would happen if you posted it?")).toBe("PREVIEW");
  expect(registry.classifyWheatAiIntent("Show me what you would change before doing it.")).toBe("PREVIEW");
  expect(registry.classifyWheatAiIntent("Create account 61234 named Honoraires comptables.")).toBe("EXECUTION");
  expect(registry.classifyWheatAiIntent("Post it.")).toBe("EXECUTION");
  const selected = registry.selectWheatAiCapabilities("Create a purchase entry for this invoice", "entries");
  expect(selected.some((item) => item.id === "entries.create_draft")).toBe(true);
  expect(selected.length).toBeLessThanOrEqual(40);
});

test.describe("Wheat AI domain gateway", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });
  let temporaryRoot;
  let prisma;
  let actor;
  let company;
  let otherCompany;
  let journal;
  let expense;
  let payable;
  let gateway;

  test.beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-211-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();
    actor = await prisma.user.create({ data: { name: "Agent Admin", email: `agent-${Date.now()}-${Math.random()}@atlas.local`, role: "ADMIN" } });
    company = await prisma.company.create({ data: { name: "Agent Company", legalForm: "SARL", ice: "001234567890123", taxId: "IF-AI", city: "Rabat", vatFrequency: "MONTHLY" } });
    otherCompany = await prisma.company.create({ data: { name: "Other Company", legalForm: "SARL", ice: "009876543210123", taxId: "IF-OTHER", city: "Fès", vatFrequency: "MONTHLY" } });
    await prisma.companyUser.create({ data: { companyId: company.id, userId: actor.id, role: "ADMIN" } });
    await prisma.wheatAiSettings.create({ data: { companyId: company.id, permissionMode: "ASSISTANT" } });
    await prisma.fiscalYear.create({ data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" } });
    journal = await prisma.journal.create({ data: { companyId: company.id, code: "ACH", label: "Achats", active: true, locked: false, nextNumber: 1 } });
    expense = await prisma.account.create({ data: { companyId: company.id, code: "612", label: "Services extérieurs", classNo: 6, type: "EXPENSE", isStandard: true, active: true, postable: true, searchText: "612 services exterieurs" } });
    payable = await prisma.account.create({ data: { companyId: company.id, code: "441", label: "Fournisseurs", classNo: 4, type: "LIABILITY", isStandard: true, active: true, postable: true, searchText: "441 fournisseurs" } });
    gateway = gatewayModule.createWheatAiDomainGateway({ getPrisma: async () => prisma, getActorUserId: async () => actor.id });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("safe mutation, dry-run and audit use the real account service", async () => {
    const before = await prisma.account.count({ where: { companyId: company.id, code: "61234" } });
    const prepared = await gateway.prepare(company.id, "accounts.save", { parentCode: "612", code: "61234", label: "Honoraires comptables", type: "EXPENSE" });
    expect(prepared.preview.summary).toMatch(/créer|compte|subdivision/i);
    expect(await prisma.account.count({ where: { companyId: company.id, code: "61234" } })).toBe(before);
    // A clear level-1 draft/metadata edit runs in assistant mode. The intent
    // guard still applies to model calls; direct typed execution is already the
    // renderer's explicit action.
    const created = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61234", label: "Honoraires comptables", type: "EXPENSE" } }, actor.id);
    expect(created.executed).toBe(true);
    expect(created.result).toMatchObject({ code: "61234", label: "Honoraires comptables" });
    expect(await prisma.auditEvent.findFirst({ where: { chain: { companyId: company.id }, action: "CREATE_ACCOUNT", entityId: created.result.id } })).toBeTruthy();
    expect(await prisma.wheatAiAuditEvent.findFirst({ where: { companyId: company.id, toolName: "accounts.save", status: "SUCCEEDED" } })).toBeTruthy();
  });

  test("deterministic local-model guards reject ambiguous and malformed mutations and execute a clear safe edit", async () => {
    const ambiguous = await ai.processWheatAiCapabilityCalls({ prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "ambiguous", permissionMode: "ASSISTANT", prompt: "Can Wheat create this account?", dryRun: false, calls: [{ capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61240", label: "Ambigu", type: "EXPENSE" } }] });
    expect(ambiguous.results[0].status).toBe("NOT_AUTHORIZED_BY_INTENT");
    const malformed = await ai.processWheatAiCapabilityCalls({ prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "malformed", permissionMode: "ASSISTANT", prompt: "Create account 61240 named Safe", dryRun: false, calls: [{ capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61240", label: "Safe", type: "EXPENSE", prisma: { deleteMany: true } } }] });
    expect(malformed.results[0]).toMatchObject({ status: "FAILED" });
    expect(await prisma.account.count({ where: { companyId: company.id, code: "61240" } })).toBe(0);
    const explicit = await ai.processWheatAiCapabilityCalls({ prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "explicit", permissionMode: "ASSISTANT", prompt: "Create account 61240 named Safe", dryRun: false, calls: [{ capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61240", label: "Safe", type: "EXPENSE" } }] });
    expect(explicit.results[0].status).toBe("SUCCEEDED");
    expect(explicit.proposals).toEqual([]);
    expect(await prisma.account.count({ where: { companyId: company.id, code: "61240" } })).toBe(1);
  });

  test("company membership and role checks prevent cross-dossier privilege escalation", async () => {
    const foreign = await prisma.account.create({ data: { companyId: otherCompany.id, code: "61299", label: "Foreign", classNo: 6, type: "EXPENSE" } });
    await expect(gateway.execute(company.id, "accounts.get", { accountId: foreign.id })).rejects.toThrow(/dossier actif/i);
    await expect(gateway.execute(otherCompany.id, "company.get", {})).rejects.toThrow(/n'a pas accès/i);
    await prisma.companyUser.update({ where: { companyId_userId: { companyId: company.id, userId: actor.id } }, data: { role: "VIEWER" } });
    await prisma.user.update({ where: { id: actor.id }, data: { role: "VIEWER" } });
    await expect(gateway.prepare(company.id, "accounts.save", { parentCode: "612", code: "61235", label: "Interdit", type: "EXPENSE" })).rejects.toThrow(/rôle viewer/i);
  });

  test("foreign top-level and nested IDs cannot read, mutate, delete, or link across dossiers", async () => {
    const localFiscalYear = await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: company.id } });
    const foreignFiscalYear = await prisma.fiscalYear.create({ data: { companyId: otherCompany.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" } });
    const foreignJournal = await prisma.journal.create({ data: { companyId: otherCompany.id, code: "OD", label: "Foreign OD" } });
    const foreignAccount = await prisma.account.create({ data: { companyId: otherCompany.id, code: "61299", label: "Foreign account", classNo: 6, type: "EXPENSE", active: true, postable: true, searchText: "61299 foreign" } });
    const localCounterparty = await prisma.counterparty.create({ data: { companyId: company.id, kind: "SUPPLIER", displayName: "Local supplier", identityKey: "local-supplier" } });
    const foreignCounterparty = await prisma.counterparty.create({ data: { companyId: otherCompany.id, kind: "SUPPLIER", displayName: "Foreign supplier", identityKey: "foreign-supplier" } });
    const localEntry = await prisma.entry.create({ data: {
      companyId: company.id, journalId: journal.id, number: "LOCAL-SCOPE", date: new Date("2026-08-25T00:00:00Z"), pieceNumber: "LOCAL-SCOPE", label: "Local scope line", journalCodeSnapshot: journal.code,
      lines: { create: [{ accountId: expense.id, label: "Local line", debitCents: 100n, creditCents: 0n, position: 1, accountCodeSnapshot: expense.code, accountLabelSnapshot: expense.label }] },
    }, include: { lines: true } });
    const foreignEntry = await prisma.entry.create({ data: {
      companyId: otherCompany.id, journalId: foreignJournal.id, number: "FOREIGN-SCOPE", date: new Date("2026-08-25T00:00:00Z"), pieceNumber: "FOREIGN-SCOPE", label: "Foreign scope line", journalCodeSnapshot: foreignJournal.code,
      lines: { create: [{ accountId: foreignAccount.id, counterpartyId: foreignCounterparty.id, label: "Foreign line", debitCents: 100n, creditCents: 0n, position: 1, accountCodeSnapshot: foreignAccount.code, accountLabelSnapshot: foreignAccount.label }] },
    }, include: { lines: true } });
    const localTaxConfiguration = await prisma.taxConfigurationVersion.create({ data: { companyId: company.id, lineageKey: "scope-local", name: "Local VAT", accountingBasis: "INVOICE", filingFrequency: "MONTHLY", effectiveFrom: new Date("2026-01-01T00:00:00Z"), payloadSha256: "1".repeat(64) } });
    const foreignTaxConfiguration = await prisma.taxConfigurationVersion.create({ data: { companyId: otherCompany.id, lineageKey: "scope-foreign", name: "Foreign VAT", accountingBasis: "INVOICE", filingFrequency: "MONTHLY", effectiveFrom: new Date("2026-01-01T00:00:00Z"), payloadSha256: "2".repeat(64) } });
    const foreignTaxRate = await prisma.taxRateDefinition.create({ data: { taxConfigurationVersionId: foreignTaxConfiguration.id, code: "TVA20", label: "Foreign VAT 20%", rateBps: 2000, direction: "BOTH", position: 1 } });
    const bankAccount = await prisma.bankAccount.create({ data: { companyId: company.id, bankName: "Local bank", iban: "MA-SCOPE", balanceCents: 0n, ledgerAccountId: expense.id } });
    const movement = await prisma.bankMovement.create({ data: { bankAccountId: bankAccount.id, date: new Date("2026-08-25T00:00:00Z"), label: "Local movement", amountCents: 100n, reference: "SCOPE", status: "UNMATCHED", confidence: 100 } });
    const foreignPayment = await prisma.payment.create({ data: { companyId: otherCompany.id, counterpartyId: foreignCounterparty.id, kind: "DISBURSEMENT", paymentDate: new Date("2026-08-25T00:00:00Z"), method: "WIRE", amountCents: 100n } });
    const foreignDocument = await prisma.document.create({ data: { companyId: otherCompany.id, title: "Foreign evidence", type: "OTHER", fiscalYear: "2026", storedPath: "managed://foreign-scope", mimeType: "application/pdf", byteSize: 1n, contentSha256: "3".repeat(64), tags: "", ocrText: "", extracted: "{}", status: "EXTRACTED" } });
    const foreignVatWorkpaper = await prisma.vatWorkpaper.create({ data: { companyId: otherCompany.id, taxConfigurationVersionId: foreignTaxConfiguration.id, lineageKey: "foreign-vat", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), basisSnapshot: "INVOICE", frequencySnapshot: "MONTHLY", sourceSha256: "4".repeat(64) } });
    const foreignVatEvidence = await prisma.vatWorkpaperEvidence.create({ data: { workpaperId: foreignVatWorkpaper.id, documentId: foreignDocument.id, role: "SUPPORT", contentSha256Snapshot: foreignDocument.contentSha256 } });
    const localVatWorkpaper = await prisma.vatWorkpaper.create({ data: { companyId: company.id, taxConfigurationVersionId: localTaxConfiguration.id, lineageKey: "local-vat", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), basisSnapshot: "INVOICE", frequencySnapshot: "MONTHLY", sourceSha256: "5".repeat(64) } });
    const localFiscalPackage = await prisma.fiscalPackage.create({ data: { companyId: company.id, fiscalYearId: localFiscalYear.id, regime: "NORMAL", templateVersion: "scope-local", schemaVersion: "1" } });
    const foreignFiscalPackage = await prisma.fiscalPackage.create({ data: { companyId: otherCompany.id, fiscalYearId: foreignFiscalYear.id, regime: "NORMAL", templateVersion: "scope-foreign", schemaVersion: "1" } });
    const foreignFiscalTable = await prisma.fiscalTableWorkpaper.create({ data: { fiscalPackageId: foreignFiscalPackage.id, tableId: "T13", templateVersion: "scope" } });
    const foreignFiscalEvidence = await prisma.fiscalTableEvidence.create({ data: { workpaperId: foreignFiscalTable.id, documentId: foreignDocument.id, documentTitleSnapshot: foreignDocument.title, contentSha256Snapshot: foreignDocument.contentSha256 } });

    const activeScopeError = /dossier actif/i;
    await expect(gateway.execute(company.id, "accounts.get", { accountId: foreignAccount.id })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "accounts.save", { id: foreignAccount.id, code: foreignAccount.code, label: "Mutated", type: "EXPENSE" })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "entries.delete_draft", { entryId: foreignEntry.id })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "fiscal.attach_evidence", { fiscalPackageId: localFiscalPackage.id, tableId: "T13", documentId: foreignDocument.id })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "counterparties.create", { kind: "SUPPLIER", displayName: "Bad defaults", defaultPayableAccountId: foreignAccount.id })).rejects.toThrow(activeScopeError);

    const entryBase = { journalId: journal.id, date: "2026-08-28", label: "Scoped entry" };
    await expect(gateway.prepare(company.id, "entries.create_draft", { ...entryBase, lines: [{ accountId: foreignAccount.id, label: "Foreign account", debitCents: "100", creditCents: "0" }] })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "entries.create_draft", { ...entryBase, lines: [{ accountId: expense.id, counterpartyId: foreignCounterparty.id, label: "Foreign party", debitCents: "100", creditCents: "0" }] })).rejects.toThrow(activeScopeError);
    const invoiceBase = { kind: "PURCHASE", counterpartyId: localCounterparty.id, invoiceDate: "2026-08-28", dueDate: "2026-09-27", currency: "MAD" };
    await expect(gateway.prepare(company.id, "invoices.create_draft", { ...invoiceBase, lines: [{ description: "Foreign account", quantity: "1", htCents: "100", vatCents: "0", ttcCents: "100", accountId: foreignAccount.id }] })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "invoices.create_draft", { ...invoiceBase, lines: [{ description: "Foreign tax", quantity: "1", htCents: "100", vatCents: "0", ttcCents: "100", accountId: expense.id, taxRateDefinitionId: foreignTaxRate.id }] })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "banking.confirm_reconciliation", { movementId: movement.id, allocations: [{ entryLineId: foreignEntry.lines[0].id, amountCents: "100" }] })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "banking.confirm_reconciliation", { movementId: movement.id, allocations: [{ entryLineId: localEntry.lines[0].id, amountCents: "100" }], paymentEvidence: [{ paymentId: foreignPayment.id, amountCents: "100" }] })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "vat.remove_evidence", { id: localVatWorkpaper.id, evidenceId: foreignVatEvidence.id })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "fiscal.remove_evidence", { fiscalPackageId: localFiscalPackage.id, tableId: "T13", evidenceId: foreignFiscalEvidence.id })).rejects.toThrow(activeScopeError);
    await expect(gateway.prepare(company.id, "fiscal.add_adjustment", { fiscalPackageId: localFiscalPackage.id, kind: "REINTEGRATION", label: "Foreign evidence", amountCents: "100", legalReference: "CGI", evidence: [foreignDocument.id] })).rejects.toThrow(activeScopeError);
  });

  test("exact-cent draft creation, post preview and high-risk confirmation are enforced", async () => {
    const input = {
      journalId: journal.id,
      date: "2026-08-28",
      label: "Facture fournisseur 1200 DH",
      lines: [
        { accountId: expense.id, label: "Honoraires", debitCents: "120000", creditCents: "0" },
        { accountId: payable.id, label: "Fournisseur", debitCents: "0", creditCents: "120000" },
      ],
    };
    await expect(ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.create_draft", arguments: input }, actor.id)).rejects.toThrow(/confirmation explicite/i);
    const draft = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.create_draft", arguments: input, confirmed: true }, actor.id);
    expect(draft.result.status).toBe("DRAFT");
    expect(draft.result.lines.reduce((sum, line) => sum + BigInt(line.debitCents), 0n)).toBe(120000n);
    expect((await gateway.execute(company.id, "entries.get", { entryId: draft.result.id })).result.label).toBe(input.label);
    const updated = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.update_draft", arguments: { ...input, entryId: draft.result.id, label: "Facture fournisseur corrigée" }, confirmed: true }, actor.id);
    expect(updated.result.label).toBe("Facture fournisseur corrigée");
    const dryRun = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.post", arguments: { entryId: updated.result.id }, dryRun: true }, actor.id);
    expect(dryRun).toMatchObject({ dryRun: true, executed: false, riskLevel: 3 });
    expect((await prisma.entry.findUnique({ where: { id: updated.result.id } })).status).toBe("DRAFT");
    await expect(ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.post", arguments: { entryId: updated.result.id } }, actor.id)).rejects.toThrow(/confirmation explicite/i);
    const posted = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "entries.post", arguments: { entryId: updated.result.id }, confirmed: true }, actor.id);
    expect(posted.result.status).toBe("POSTED");
    expect(posted.result.number).toMatch(/^ACH-2026-/);
  });

  test("invoice and payment drafts adapt exact cent schemas into the existing subledger service", async () => {
    const supplier = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "counterparties.create", confirmed: true, arguments: { kind: "SUPPLIER", displayName: "Cabinet Atlas", defaultPayableAccountId: payable.id } }, actor.id);
    const invoice = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "invoices.create_draft", confirmed: true, arguments: {
      kind: "PURCHASE", counterpartyId: supplier.result.id, invoiceNo: "F-211", invoiceDate: "2026-08-28", dueDate: "2026-09-27", currency: "MAD",
      lines: [{ description: "Honoraires", quantity: "1", unitPriceCents: "100000", htCents: "100000", vatCents: "20000", ttcCents: "120000", vatRateBps: 2000, accountId: expense.id }],
    } }, actor.id);
    expect(invoice.result).toMatchObject({ lifecycleStatus: "DRAFT", htCents: 100000n, vatCents: 20000n, ttcCents: 120000n });
    const bankLedger = await prisma.account.create({ data: { companyId: company.id, code: "514", label: "Banque", classNo: 5, type: "ASSET", active: true, postable: true, searchText: "514 banque" } });
    const bank = await prisma.bankAccount.create({ data: { companyId: company.id, bankName: "Atlas Bank", iban: "MA00TEST", balanceCents: 0n, currency: "MAD", ledgerAccountId: bankLedger.id } });
    const payment = await ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId: "payments.create_draft", confirmed: true, arguments: { kind: "DISBURSEMENT", counterpartyId: supplier.result.id, paymentDate: "2026-08-29", amountCents: "120000", currency: "MAD", method: "VIREMENT", bankAccountId: bank.id, controlAccountId: payable.id, settlementAccountId: bankLedger.id } }, actor.id);
    expect(payment.result).toMatchObject({ lifecycleStatus: "DRAFT", amountCents: 120000n, paymentDate: new Date("2026-08-29T00:00:00.000Z") });
  });

  test("stale previews fail instead of overwriting a concurrent update", async () => {
    const created = await gateway.execute(company.id, "accounts.save", { parentCode: "612", code: "61236", label: "Version initiale", type: "EXPENSE" });
    const prepared = await gateway.prepare(company.id, "accounts.save", { id: created.result.id, code: "61236", label: "Version proposée", type: "EXPENSE" });
    await prisma.account.update({ where: { id: created.result.id }, data: { label: "Modification concurrente", version: { increment: 1 } } });
    await expect(gateway.execute(company.id, "accounts.save", prepared.arguments, { preconditions: prepared.preconditions })).rejects.toThrow(/changé depuis la prévisualisation/i);
    expect((await prisma.account.findUnique({ where: { id: created.result.id } })).label).toBe("Modification concurrente");
  });

  test("bulk plans report partial failure without silently skipping it", async () => {
    const result = await ai.executeRegisteredPlan(prisma, gateway, {
      companyId: company.id,
      stopOnError: false,
      confirmed: true,
      calls: [
        { capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61237", label: "Premier", type: "EXPENSE" } },
        { capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61237", label: "Doublon", type: "EXPENSE" } },
        { capabilityId: "accounts.save", arguments: { parentCode: "612", code: "61238", label: "Troisième", type: "EXPENSE" } },
      ],
    }, actor.id);
    expect(result).toMatchObject({ executed: true, total: 3, completed: 2, failed: 1, stoppedEarly: false });
    expect(result.results.map((item) => item.status)).toEqual(["SUCCEEDED", "FAILED", "SUCCEEDED"]);
    expect(await prisma.account.count({ where: { companyId: company.id, code: { in: ["61237", "61238"] } } })).toBe(2);
  });

  test("navigation is non-mutating and attachment IDs remain company-scoped", async () => {
    const navigation = await gateway.execute(company.id, "navigation.open", { target: "bilan" });
    expect(navigation.result).toEqual({ navigation: { target: "bilan", entityId: null }, message: "Ouverture de bilan." });
    const foreignDocument = await prisma.document.create({ data: { companyId: otherCompany.id, title: "Foreign invoice", type: "INVOICE", fiscalYear: "2026", storedPath: "managed://foreign", mimeType: "application/pdf", byteSize: 1n, contentSha256: "a".repeat(64), tags: "", ocrText: "", extracted: "{}", status: "EXTRACTED" } });
    await expect(gateway.prepare(company.id, "fiscal.attach_evidence", { fiscalPackageId: "missing", tableId: "T13", documentId: foreignDocument.id })).rejects.toThrow(/document.*dossier actif|liasse.*dossier actif/i);
  });
});
