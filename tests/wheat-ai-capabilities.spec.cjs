/**
 * What Wheat AI can actually reach, and what it is told when it cannot.
 *
 * Three failures motivate this suite.
 *
 * The first was a crash: `wheat:ai:chat` threw
 * `PrismaClientValidationError — Unknown field \`revision\` for select statement
 * on model \`Document\``, because three read paths selected a column the schema
 * has never had. Nothing exercised those reads, so the mismatch survived every
 * green run. `every read capability answers` now drives all of them against a
 * real database, which is the only check that would have caught it.
 *
 * The second was a capability the assistant had but was never handed: the tool
 * selection scored on keywords and fell back to five read-only tools, so
 * "corrige cette facture" arrived with nothing that could change an invoice and
 * the answer was "je n'ai pas d'outil typé pour cette action".
 *
 * The third was identity: asked to bill ANOUAL HEALTH SOLUTIONS, the assistant
 * created a second one, and on an inverted document it proposed the open
 * dossier as its own customer.
 */

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

/* ------------------------------------------------------------------ */
/* Tool selection                                                      */
/* ------------------------------------------------------------------ */

test.describe("what the model is offered", () => {
  test("orientation tools are present whatever the wording, including for a prompt that matches nothing", () => {
    for (const prompt of ["", "bonjour", "zzzz qqqq", "aide moi"]) {
      const ids = registry.selectWheatAiCapabilities(prompt).map((item) => item.id);
      for (const required of ["company.get", "counterparties.resolve", "invoices.get", "documents.get", "accounts.search", "navigation.open"]) {
        expect(ids, `prompt ${JSON.stringify(prompt)} missing ${required}`).toContain(required);
      }
    }
  });

  test("a request to change an invoice is offered the tools that can change one", () => {
    const ids = registry.selectWheatAiCapabilities("corrige la facture 39/2026, elle est enregistrée en achat", "invoices").map((item) => item.id);
    expect(ids).toContain("invoices.update_draft");
    expect(ids).toContain("invoices.reclassify_draft");
    expect(ids).toContain("invoices.get");
  });

  test("a document question reaches the OCR tools, and the list stays bounded", () => {
    const selected = registry.selectWheatAiCapabilities("relance l'ocr sur ce document et crée le brouillon", "documents");
    const ids = selected.map((item) => item.id);
    expect(ids).toContain("documents.rerun_ocr");
    expect(ids).toContain("documents.create_invoice_draft");
    expect(selected.length).toBeLessThanOrEqual(45);
  });

  test("the registry stays typed, scoped and free of any escape hatch", () => {
    const capabilities = registry.publicWheatAiCapabilities();
    expect(capabilities.length).toBeGreaterThanOrEqual(90);
    for (const item of capabilities) {
      expect(item.companyScoped).toBe(true);
      expect(item.inputSchema.type).toBe("object");
      expect([0, 1, 2, 3]).toContain(item.riskLevel);
    }
    const serialized = JSON.stringify(capabilities).toLowerCase();
    for (const forbidden of ["runsql", "rawquery", "executeprisma", "executeshell", "readanyfile", "evaluate"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("destructive capabilities always require confirmation, and reads never do", () => {
    for (const id of ["invoices.reclassify_draft", "invoices.delete_draft", "entries.post", "payments.void", "vat.review"]) {
      const definition = registry.getWheatAiCapability(id);
      expect(definition, id).toBeTruthy();
      expect(definition.riskLevel, id).toBe(3);
      expect(definition.confirmation, id).toBe("ALWAYS");
    }
    for (const id of ["counterparties.resolve", "accounts.suggest", "payments.get", "invoices.get", "documents.get"]) {
      const definition = registry.getWheatAiCapability(id);
      expect(definition, id).toBeTruthy();
      expect(definition.riskLevel, id).toBe(0);
      expect(definition.confirmation, id).toBe("NEVER");
    }
  });
});

/* ------------------------------------------------------------------ */
/* User-facing failures                                                */
/* ------------------------------------------------------------------ */

test.describe("what the user is told when a tool fails", () => {
  test("an internal fault becomes a sentence, and is not shown raw", () => {
    const prismaFault = new Error("Invalid `prisma.document.findMany()` invocation\n\nUnknown field `revision` for select statement on model `Document`.");
    prismaFault.name = "PrismaClientValidationError";
    const described = ai.describeCapabilityFailure("documents.search", prismaFault);
    expect(described).not.toMatch(/prisma|revision|findMany/i);
    expect(described).toMatch(/documents\.search/);
    expect(described).toMatch(/erreur interne/i);
    expect(described).toMatch(/journal/i);
  });

  test("a Wheat refusal is shown exactly as written, because it already says what to do", () => {
    const domain = new Error("Le compte 445500 n'est pas configuré. Sélectionnez un compte actif.");
    expect(ai.describeCapabilityFailure("invoices.create_draft", domain)).toBe(domain.message);
  });

  test("a programming fault is caught by the same net", () => {
    expect(ai.describeCapabilityFailure("reports.bilan", new TypeError("Cannot read properties of undefined (reading 'rows')")))
      .toMatch(/erreur interne/i);
  });
});

/* ------------------------------------------------------------------ */
/* Against a real dossier                                              */
/* ------------------------------------------------------------------ */

test.describe("Wheat AI against a dossier", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  let temporaryRoot;
  let prisma;
  let actor;
  let company;
  let gateway;
  let customer;

  test.beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ai-caps-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();
    actor = await prisma.user.create({ data: { name: "Caps Admin", email: `caps-${Date.now()}-${Math.random()}@wheat.local`, role: "ADMIN" } });
    company = await prisma.company.create({ data: { name: "IFCOF", legalForm: "SARL", ice: "000187958000077", taxId: "1110375", city: "Casablanca", vatFrequency: "MONTHLY" } });
    await prisma.companyUser.create({ data: { companyId: company.id, userId: actor.id, role: "ADMIN" } });
    await prisma.wheatAiSettings.create({ data: { companyId: company.id, permissionMode: "ASSISTANT" } });
    await prisma.fiscalYear.create({ data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" } });
    for (const [code, label, classNo, type] of [
      ["342100", "Clients", 3, "ASSET"],
      ["441100", "Fournisseurs", 4, "LIABILITY"],
      ["445500", "Etat - TVA facturée", 4, "LIABILITY"],
      ["345520", "TVA récupérable sur charges", 3, "ASSET"],
      ["712400", "Prestations de services", 7, "REVENUE"],
      ["3488", "Divers débiteurs", 3, "ASSET"],
    ]) {
      await prisma.account.create({ data: { companyId: company.id, code, label, classNo, type, isStandard: true, active: true, postable: true, searchText: `${code} ${label}`.toLowerCase() } });
    }
    customer = await prisma.counterparty.create({
      data: {
        companyId: company.id, kind: "CUSTOMER", displayName: "ANOUAL HEALTH SOLUTIONS", legalName: "ANOUAL HEALTH SOLUTIONS",
        ice: "003983471000077", identityKey: "ICE:003983471000077", paymentTermsDays: 30,
      },
    });
    gateway = gatewayModule.createWheatAiDomainGateway({ getPrisma: async () => prisma, getActorUserId: async () => actor.id });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  /**
   * The guard for the crash. Every read the assistant can make is executed; a
   * query naming a column the schema does not have fails loudly here instead of
   * in the user's chat window.
   */
  test("every read capability answers without a schema mismatch", async () => {
    const reads = registry.WHEAT_AI_CAPABILITY_REGISTRY.filter((item) => item.mode === "READ");
    expect(reads.length).toBeGreaterThanOrEqual(30);
    const sampleArguments = {
      "accounts.get": { code: "342100" },
      "accounts.suggest": { role: "REVENUE_SERVICE" },
      "counterparties.resolve": { name: "ANOUAL HEALTH SOLUTIONS" },
      "counterparties.get": { id: customer.id },
      "reports.balance": { view: "GENERAL", to: "2026-12-31" },
      "reports.bilan": { asOf: "2026-12-31", variant: "NORMAL" },
      "documents.search": { query: "facture" },
    };
    const schemaFaults = [];
    const requiresRecord = [];
    for (const definition of reads) {
      const args = sampleArguments[definition.id] ?? {};
      // A capability that needs a record id has nothing to point at in a fresh
      // dossier; its refusal is a domain answer, not a schema fault.
      if (!(definition.id in sampleArguments) && (definition.inputSchema.required ?? []).length) {
        requiresRecord.push(definition.id);
        continue;
      }
      try {
        await gateway.execute(company.id, definition.id, args, {});
      } catch (error) {
        const message = String(error?.message ?? error);
        if (/Prisma|Unknown field|Unknown arg|Invalid `prisma|is not a function|Cannot read propert/i.test(message)) {
          schemaFaults.push(`${definition.id}: ${message.split("\n")[0]}`);
        }
      }
    }
    expect(schemaFaults, schemaFaults.join("\n")).toEqual([]);
    // The skipped ones are skipped for want of a record, not for want of a
    // handler: an unregistered capability would throw a different error.
    for (const id of requiresRecord) {
      await expect(gateway.execute(company.id, id, {}, {}), id).rejects.not.toThrow(/n'est pas enregistrée|not supported/i);
    }
  });

  test("documents.search reads a dossier that has documents, and one that has none", async () => {
    expect(await gateway.execute(company.id, "documents.search", {}, {})).toMatchObject({ result: [] });
    await prisma.document.create({
      data: {
        companyId: company.id, title: "Facture 39-2026.pdf", type: "Facture", fiscalYear: "2026",
        tags: "wheat-ocr,invoice", ocrText: "FACT 39/2026", extracted: "{}", status: "TO_REVIEW", contentSha256: "a".repeat(64),
      },
    });
    const found = await gateway.execute(company.id, "documents.search", { query: "facture" }, {});
    expect(found.result).toHaveLength(1);
    expect(found.result[0]).toMatchObject({ title: "Facture 39-2026.pdf", status: "TO_REVIEW" });
    // The reason the crash existed: the selection must name only real columns.
    expect(found.result[0]).not.toHaveProperty("revision");
  });

  test("counterparties.resolve finds the existing customer instead of inviting a duplicate", async () => {
    const byIce = await gateway.execute(company.id, "counterparties.resolve", { ice: "003983471000077" }, {});
    expect(byIce.result.exactMatch).toMatchObject({ id: customer.id, displayName: "ANOUAL HEALTH SOLUTIONS" });
    expect(byIce.result.exactMatch.match.basis).toBe("ICE");
    expect(byIce.result.guidance).toMatch(/existe déjà/i);

    // A name written differently is the same party, and must not be "new".
    const byName = await gateway.execute(company.id, "counterparties.resolve", { name: "anoual health solutions sarl" }, {});
    expect(byName.result.exactMatch?.id).toBe(customer.id);
  });

  test("counterparties.resolve refuses to treat the open dossier as its own third party", async () => {
    const asSelf = await gateway.execute(company.id, "counterparties.resolve", { name: "IFCOF", ice: "000187958000077" }, {});
    expect(asSelf.result.isActiveDossier).toBe(true);
    expect(asSelf.result.exactMatch).toBeNull();
    expect(asSelf.result.guidance).toMatch(/ne peut pas être son propre client/i);

    // Even by name alone, when the dossier records no ICE of its own to compare.
    const byNameOnly = await gateway.execute(company.id, "counterparties.resolve", { name: "Sté IFCOF S.A.R.L." }, {});
    expect(byNameOnly.result.isActiveDossier).toBe(true);
  });

  test("counterparties.resolve reports an unknown party plainly, so creating one is justified", async () => {
    const unknown = await gateway.execute(company.id, "counterparties.resolve", { name: "SOCIETE INCONNUE", ice: "000000000000123" }, {});
    expect(unknown.result.exactMatch).toBeNull();
    expect(unknown.result.candidates).toEqual([]);
    expect(unknown.result.guidance).toMatch(/création d'un nouveau tiers est justifiée/i);
  });

  test("counterparties.resolve asks for something to search on rather than listing the dossier", async () => {
    await expect(gateway.execute(company.id, "counterparties.resolve", {}, {})).rejects.toThrow(/au moins un nom, un ICE/i);
  });

  test("accounts.suggest answers from the dossier's own chart, and admits when a role is unconfigured", async () => {
    const revenue = await gateway.execute(company.id, "accounts.suggest", { role: "REVENUE_SERVICE", context: "honoraires" }, {});
    expect(revenue.result.suggested).toMatchObject({ code: "712400" });
    expect(revenue.result.basis).toBe("CODE");

    const disbursement = await gateway.execute(company.id, "accounts.suggest", { role: "DISBURSEMENT" }, {});
    expect(disbursement.result.suggested).toMatchObject({ code: "3488" });

    await prisma.account.deleteMany({ where: { companyId: company.id, code: "445500" } });
    const missing = await gateway.execute(company.id, "accounts.suggest", { role: "VAT_COLLECTED" }, {});
    expect(missing.result.suggested).toBeNull();
    expect(missing.result.guidance).toMatch(/n'est configuré et actif/i);
  });

  test("payments.get reports what is still unallocated, in exact centimes", async () => {
    const payment = await prisma.payment.create({
      data: {
        companyId: company.id, kind: "RECEIPT", counterpartyId: customer.id, paymentDate: new Date("2026-08-20T00:00:00Z"),
        amountCents: 754276n, method: "VIREMENT", reference: "VIR-1", lifecycleStatus: "DRAFT",
      },
    });
    const read = await gateway.execute(company.id, "payments.get", { id: payment.id }, {});
    expect(read.result.checks).toMatchObject({ allocatedCents: "0", unallocatedCents: "754276", fullyAllocated: false });
    await expect(gateway.execute(company.id, "payments.get", { id: "nope" }, {})).rejects.toThrow();
  });

  test("a level-3 capability is a proposal until a person confirms it, and the audit records both", async () => {
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "SALE", counterparty: customer.displayName, counterpartyId: customer.id,
        invoiceNo: "39/2026", numberKey: "SALE:392026", invoiceDate: new Date("2026-08-12T00:00:00Z"), dueDate: new Date("2026-09-11T00:00:00Z"),
        htCents: 450000n, vatCents: 90000n, ttcCents: 540000n, status: "DRAFT", lifecycleStatus: "DRAFT", currency: "MAD",
      },
    });
    const processed = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "confirm-test", permissionMode: "ASSISTANT",
      prompt: "Supprime le brouillon 39/2026.", dryRun: false,
      calls: [{ capabilityId: "invoices.delete_draft", arguments: { id: invoice.id } }],
    });
    expect(processed.results[0].status).toBe("PENDING_CONFIRMATION");
    expect(await prisma.invoice.count({ where: { id: invoice.id } })).toBe(1);
    await ai.confirmWheatAiAction(prisma, gateway, { companyId: company.id, proposalId: processed.proposals[0].id, confirmed: true }, actor.id);
    expect(await prisma.invoice.count({ where: { id: invoice.id } })).toBe(0);
    expect(await prisma.wheatAiAuditEvent.findFirst({ where: { companyId: company.id, toolName: "invoices.delete_draft", status: "CONFIRMED_EXECUTED" } })).toBeTruthy();
  });

  test("two concurrent confirmations execute a proposal exactly once", async () => {
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "SALE", counterparty: customer.displayName, counterpartyId: customer.id,
        invoiceNo: "RACE-1", numberKey: "SALE:RACE1", invoiceDate: new Date("2026-08-12T00:00:00Z"), dueDate: new Date("2026-09-11T00:00:00Z"),
        htCents: 10000n, vatCents: 2000n, ttcCents: 12000n, status: "DRAFT", lifecycleStatus: "DRAFT", currency: "MAD",
      },
    });
    const processed = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "confirm-race", permissionMode: "ASSISTANT",
      prompt: "Supprime le brouillon RACE-1.", dryRun: false,
      calls: [{ capabilityId: "invoices.delete_draft", arguments: { id: invoice.id } }],
    });
    const request = { companyId: company.id, proposalId: processed.proposals[0].id, confirmed: true };
    const outcomes = await Promise.allSettled([
      ai.confirmWheatAiAction(prisma, gateway, request, actor.id),
      ai.confirmWheatAiAction(prisma, gateway, request, actor.id),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { id: invoice.id } })).toBe(0);
    const audit = await prisma.wheatAiAuditEvent.findUnique({ where: { id: processed.proposals[0].id } });
    expect(audit.status).toBe("CONFIRMED_EXECUTED");
  });

  test("a question never authorises a mutation, whatever tool the model proposed", async () => {
    const asked = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "intent", permissionMode: "ASSISTANT",
      prompt: "Cette facture est-elle du bon sens ?", dryRun: false,
      calls: [{ capabilityId: "invoices.reclassify_draft", arguments: { invoiceId: "x", kind: "SALE" } }],
    });
    expect(asked.results[0].status).toBe("NOT_AUTHORIZED_BY_INTENT");
  });

  test("a read-only dossier refuses every mutation while still answering questions", async () => {
    await prisma.wheatAiSettings.update({ where: { companyId: company.id }, data: { permissionMode: "READ_ONLY" } });
    const refused = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "read-only", permissionMode: "READ_ONLY",
      prompt: "Crée le tiers SOCIETE X.", dryRun: false,
      calls: [{ capabilityId: "counterparties.create", arguments: { kind: "CUSTOMER", displayName: "SOCIETE X" } }],
    });
    expect(refused.results[0]).toMatchObject({ status: "REJECTED" });
    expect(await gateway.execute(company.id, "counterparties.resolve", { name: "SOCIETE X" }, {})).toBeTruthy();
  });
});
