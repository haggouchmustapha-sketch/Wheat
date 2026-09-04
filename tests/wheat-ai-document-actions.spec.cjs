/**
 * Wheat AI as an interface into Wheat, not a second accounting system.
 *
 * The assistant can now read an OCR extraction, diagnose an invoice that does
 * not add up, correct extracted fields, re-run recognition and create the
 * purchase-invoice draft a document describes. Each of those reaches the very
 * same function the button in the interface calls, and each mutating one is a
 * proposal until a person approves it.
 *
 * What this suite pins down is the boundary: read actions run, write actions
 * change nothing until approved, approval executes exactly what was previewed,
 * cancellation executes nothing, invalid arguments are refused with a message
 * the model can act on, and a document belonging to another dossier is out of
 * reach whatever the model asks for.
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

const sqliteUrl = (databasePath) => `file:${databasePath.replace(/\\/g, "/")}`;

/** An extraction whose VAT and total contradict the base, as the old bug produced. */
function inconsistentExtraction() {
  return {
    documentType: "INVOICE",
    documentDirection: "PURCHASE",
    confidence: 61,
    uncertainFields: ["tva", "ttc"],
    accountingChecks: [
      { id: "vat-matches-rate", label: "TVA = base HT x taux", status: "FAILED", detail: "20.00 % de 4500.00 donne 900.00, le document indique 4500.00." },
      { id: "total-is-sum-of-parts", label: "TTC = HT + TVA (+ debours - remise)", status: "FAILED", detail: "4500.00 + 4500.00 ne donne pas 7542.76." },
    ],
    parties: { issuer: { name: "IFCOF", ice: "000187958000077" }, recipient: { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077" } },
    fields: { invoiceNumber: "39/2026", date: "2026-08-12", supplier: "IFCOF", ht: 4500, tva: 4500, ttc: 9000, vatRate: 2000, currency: "MAD" },
    fieldConfidence: { ht: 93, tva: 45, ttc: 45 },
  };
}

test.describe("Wheat AI document and invoice actions", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let temporaryRoot;
  let prisma;
  let actor;
  let company;
  let otherCompany;
  let gateway;
  let document;
  let foreignDocument;
  /** Every call the gateway made into Wheat's own document commands. */
  let calls;

  /**
   * Stands in for the main process's document commands.
   *
   * It records what it was asked to do and enforces the same dossier check the
   * real ones do, so the tests can assert both that nothing ran before approval
   * and that a cross-company request never reaches the command at all.
   */
  function documentCommands() {
    const guard = (companyId, documentRow) => {
      if (!documentRow) throw new Error("Le document demandé n'existe plus.");
      if (documentRow.companyId !== companyId) throw new Error("Le document appartient à un autre dossier.");
    };
    return {
      read: async (companyId, documentId) => {
        const row = await prisma.document.findUnique({ where: { id: documentId } });
        guard(companyId, row);
        calls.push({ command: "read", companyId, documentId });
        const extracted = JSON.parse(row.extracted || "{}");
        return { id: row.id, title: row.title, status: row.status, fields: extracted.fields ?? {}, accountingChecks: extracted.accountingChecks ?? [], uncertainFields: extracted.uncertainFields ?? [] };
      },
      updateExtraction: async (companyId, payload) => {
        const row = await prisma.document.findUnique({ where: { id: payload.documentId } });
        guard(companyId, row);
        calls.push({ command: "updateExtraction", companyId, payload });
        const previous = JSON.parse(row.extracted || "{}");
        const next = { ...previous, fields: { ...(previous.fields ?? {}), ...payload.fields } };
        return prisma.document.update({ where: { id: row.id }, data: { extracted: JSON.stringify(next), status: "EXTRACTED" } });
      },
      rerunOcr: async (companyId, documentId) => {
        const row = await prisma.document.findUnique({ where: { id: documentId } });
        guard(companyId, row);
        calls.push({ command: "rerunOcr", companyId, documentId });
        return { id: row.id, status: row.status };
      },
      createInvoiceDraft: async (companyId, documentId, kind) => {
        const row = await prisma.document.findUnique({ where: { id: documentId } });
        guard(companyId, row);
        calls.push({ command: "createInvoiceDraft", companyId, documentId, kind: kind ?? null });
        return { document: { id: row.id }, invoiceDraft: { id: "draft-1", invoiceNo: "39/2026" } };
      },
    };
  }

  test.beforeEach(async () => {
    calls = [];
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ai-docs-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();

    actor = await prisma.user.create({ data: { name: "Comptable", email: `docs-${Date.now()}-${Math.random()}@wheat.local`, role: "ADMIN" } });
    company = await prisma.company.create({ data: { name: "Anoual Health Solutions", legalForm: "SARL", ice: "003983471000077", taxId: "IF-1", city: "Casablanca", vatFrequency: "MONTHLY" } });
    otherCompany = await prisma.company.create({ data: { name: "Autre Dossier", legalForm: "SARL", ice: "004444444444444", taxId: "IF-2", city: "Rabat", vatFrequency: "MONTHLY" } });
    await prisma.companyUser.create({ data: { companyId: company.id, userId: actor.id, role: "ADMIN" } });
    await prisma.companyUser.create({ data: { companyId: otherCompany.id, userId: actor.id, role: "ADMIN" } });
    await prisma.wheatAiSettings.create({ data: { companyId: company.id, permissionMode: "ASSISTANT" } });

    const documentData = (companyId, title) => ({
      companyId,
      title,
      type: "Facture",
      fiscalYear: "2026",
      tags: "atlas-vision-ocr,invoice,needs-review",
      storedPath: path.join(temporaryRoot, `${title}.pdf`),
      contentSha256: "a".repeat(64),
      mimeType: "application/pdf",
      byteSize: BigInt(1024),
      ocrText: "FACT° : 39/2026",
      extracted: JSON.stringify(inconsistentExtraction()),
      status: "TO_REVIEW",
    });
    document = await prisma.document.create({ data: documentData(company.id, "facture-39-2026") });
    foreignDocument = await prisma.document.create({ data: documentData(otherCompany.id, "facture-autre-dossier") });

    gateway = gatewayModule.createWheatAiDomainGateway({
      getPrisma: async () => prisma,
      getActorUserId: async () => actor.id,
      documentCommands: documentCommands(),
    });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("the document and invoice capabilities are registered, typed and scoped", () => {
    for (const id of ["documents.get", "documents.update_extraction", "documents.rerun_ocr", "documents.create_invoice_draft", "invoices.get"]) {
      const capability = registry.getWheatAiCapability(id);
      expect(capability, id).toBeTruthy();
      expect(capability.companyScoped).toBe(true);
      expect(capability.inputSchema.type).toBe("object");
    }
    expect(registry.getWheatAiCapability("documents.get").riskLevel).toBe(0);
    expect(registry.getWheatAiCapability("invoices.get").riskLevel).toBe(0);
    expect(registry.getWheatAiCapability("documents.update_extraction").riskLevel).toBeGreaterThan(0);
    expect(registry.getWheatAiCapability("documents.create_invoice_draft").riskLevel).toBeGreaterThan(0);
  });

  test("READ — the assistant can inspect a document's extraction without changing it", async () => {
    const before = await prisma.document.findUnique({ where: { id: document.id } });
    const result = await gateway.execute(company.id, "documents.get", { documentId: document.id });
    expect(result.result.fields.invoiceNumber).toBe("39/2026");
    expect(calls).toEqual([{ command: "read", companyId: company.id, documentId: document.id }]);
    const after = await prisma.document.findUnique({ where: { id: document.id } });
    expect(after.extracted).toBe(before.extracted);
    expect(after.status).toBe(before.status);
  });

  test("READ — the assistant can diagnose an invoice that does not add up", async () => {
    const counterparty = await prisma.counterparty.create({ data: { companyId: company.id, kind: "SUPPLIER", displayName: "IFCOF", legalName: "IFCOF", identityKey: "ifcof" } });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "PURCHASE", counterparty: "IFCOF", invoiceNo: "39/2026",
        invoiceDate: new Date("2026-08-12T00:00:00Z"), dueDate: new Date("2026-09-12T00:00:00Z"),
        htCents: 450000n, vatCents: 450000n, ttcCents: 754276n, status: "DRAFT", lifecycleStatus: "DRAFT",
        counterpartyId: counterparty.id, numberKey: "PURCHASE:ifcof:392026", currency: "MAD",
        lines: { create: { position: 1, description: "Honoraires", htCents: 450000n, vatCents: 450000n, ttcCents: 754276n } },
      },
    });
    const result = await gateway.execute(company.id, "invoices.get", { id: invoice.id });
    // The check is computed in exact centimes here, not restated by the model.
    expect(result.result.checks.totalsBalance).toBe(false);
    expect(result.result.checks.impliedVatRateBps).toBe(10_000);
    expect(result.result.checks.totalsDetail).toContain("≠");
  });

  test("WRITE — a proposed correction shows the before and after and changes nothing", async () => {
    const before = await prisma.document.findUnique({ where: { id: document.id } });
    const prepared = await gateway.prepare(company.id, "documents.update_extraction", {
      documentId: document.id,
      fields: { tva: 900, ttc: 7542.76 },
    });

    const fieldsChange = prepared.preview.changes.find((change) => change.field === "fields");
    expect(fieldsChange).toBeTruthy();
    // "Are you sure?" is not a preview: the current values have to be visible.
    expect(String(fieldsChange.before)).toContain("4500");
    expect(String(fieldsChange.after)).toContain("900");
    expect(String(fieldsChange.after)).toContain("7542.76");

    const after = await prisma.document.findUnique({ where: { id: document.id } });
    expect(after.extracted).toBe(before.extracted);
    expect(calls.some((call) => call.command === "updateExtraction")).toBe(false);
  });

  test("WRITE — a clear level-1 extraction correction executes immediately through Wheat's command", async () => {
    const processed = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "fix-tva",
      permissionMode: "ASSISTANT", prompt: "Corrige la TVA et le TTC de cette facture.", dryRun: false,
      calls: [{ capabilityId: "documents.update_extraction", arguments: { documentId: document.id, fields: { tva: 900, ttc: 7542.76 } } }],
    });

    expect(processed.proposals).toEqual([]);
    expect(processed.results[0].status).toBe("SUCCEEDED");
    expect(calls.filter((call) => call.command === "updateExtraction")).toHaveLength(1);

    const updated = JSON.parse((await prisma.document.findUnique({ where: { id: document.id } })).extracted);
    expect(updated.fields.tva).toBe(900);
    expect(updated.fields.ttc).toBe(7542.76);
    // The base was not in the proposal and must not have moved.
    expect(updated.fields.ht).toBe(4500);

    const audited = await prisma.wheatAiAuditEvent.findFirst({ where: { companyId: company.id, sessionId: "fix-tva", toolName: "documents.update_extraction" } });
    expect(audited.status).toBe("SUCCEEDED");
    expect(JSON.parse(audited.confirmationJson)).toMatchObject({ required: false, confirmed: false });
  });

  test("WRITE — approving without the explicit flag is refused", async () => {
    const proposals = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "no-flag",
      permissionMode: "ASSISTANT", prompt: "Corrige la TVA de cette facture.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id } }],
    });
    await expect(ai.confirmWheatAiAction(prisma, gateway, { companyId: company.id, proposalId: proposals.proposals[0].id, confirmed: false }, actor.id))
      .rejects.toThrow(/confirmation explicite/i);
    expect(calls.some((call) => call.command === "createInvoiceDraft")).toBe(false);
  });

  test("WRITE — cancelling a proposal executes nothing and records the refusal", async () => {
    const proposals = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "cancel",
      permissionMode: "ASSISTANT", prompt: "Corrige la TVA de cette facture.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id } }],
    });
    const proposal = proposals.proposals[0];
    await ai.cancelWheatAiAction(prisma, { companyId: company.id, proposalId: proposal.id }, actor.id);

    expect(calls.some((call) => call.command === "createInvoiceDraft")).toBe(false);
    expect(JSON.parse((await prisma.document.findUnique({ where: { id: document.id } })).extracted).fields.tva).toBe(4500);
    const cancelled = await prisma.wheatAiAuditEvent.findUnique({ where: { id: proposal.id } });
    expect(cancelled.status).toBe("CANCELLED");
  });

  test("WRITE — creating the invoice draft goes through Wheat's own command", async () => {
    const proposals = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "draft",
      permissionMode: "ASSISTANT", prompt: "Crée le brouillon de facture pour ce document.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id } }],
    });
    const proposal = proposals.proposals[0];
    expect(proposal.requiresConfirmation).toBe(true);
    expect(calls.some((call) => call.command === "createInvoiceDraft")).toBe(false);

    const executed = await ai.confirmWheatAiAction(prisma, gateway, { companyId: company.id, proposalId: proposal.id, confirmed: true }, actor.id);
    expect(executed.result.invoiceDraft.invoiceNo).toBe("39/2026");
    expect(calls.filter((call) => call.command === "createInvoiceDraft")).toHaveLength(1);
  });

  test("AUTOMATED — a model cannot silently force OCR direction", async () => {
    const ambiguous = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "automated-unproved-direction",
      permissionMode: "AUTOMATED", prompt: "Crée le brouillon de facture pour ce document.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id, kind: "SALE" } }],
    });
    expect(ambiguous.results[0].status).toBe("PENDING_CONFIRMATION");
    expect(ambiguous.proposals).toHaveLength(1);
    expect(calls.filter((call) => call.command === "createInvoiceDraft")).toHaveLength(0);

    const explicit = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "automated-explicit-sale",
      permissionMode: "AUTOMATED", prompt: "Crée une facture de vente pour ce document.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id, kind: "SALE" } }],
    });
    expect(explicit.results[0].status).toBe("SUCCEEDED");
    expect(explicit.proposals).toEqual([]);
    expect(calls.filter((call) => call.command === "createInvoiceDraft")).toEqual([
      { command: "createInvoiceDraft", companyId: company.id, documentId: document.id, kind: "SALE" },
    ]);

    const contradictory = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "automated-contradictory-direction",
      permissionMode: "AUTOMATED", prompt: "Crée une facture de vente pour ce document.", dryRun: false,
      calls: [{ capabilityId: "documents.create_invoice_draft", arguments: { documentId: document.id, kind: "PURCHASE" } }],
    });
    expect(contradictory.results[0]).toMatchObject({ status: "REJECTED" });
    expect(contradictory.results[0].error).toMatch(/contredit/i);
    expect(calls.some((call) => call.command === "createInvoiceDraft" && call.kind === "PURCHASE")).toBe(false);
  });

  test("re-running recognition is a clear level-1 action and executes immediately", async () => {
    const processed = await ai.processWheatAiCapabilityCalls({
      prisma, gateway, companyId: company.id, actorUserId: actor.id, sessionId: "rerun",
      permissionMode: "ASSISTANT", prompt: "Relance l'OCR sur ce document.", dryRun: false,
      calls: [{ capabilityId: "documents.rerun_ocr", arguments: { documentId: document.id } }],
    });
    expect(processed.results[0].status).toBe("SUCCEEDED");
    expect(processed.proposals).toEqual([]);
    expect(calls.filter((call) => call.command === "rerunOcr")).toHaveLength(1);
  });

  test("invalid arguments are rejected with a message the model can act on", async () => {
    const capability = registry.getWheatAiCapability("documents.update_extraction");
    expect(() => registry.validateWheatAiCapabilityInput(capability, { documentId: document.id })).toThrow(/requis|obligatoire|manquant/i);
    expect(() => registry.validateWheatAiCapabilityInput(capability, { documentId: document.id, fields: { tva: 900 }, sql: "DROP TABLE Document" })).toThrow(/non autorisés/i);
    await expect(gateway.execute(company.id, "documents.get", { documentId: "" })).rejects.toThrow();
    await expect(gateway.execute(company.id, "documents.get", { documentId: "inexistant" })).rejects.toThrow(/dossier actif/i);
    expect(calls.some((call) => call.command === "updateExtraction")).toBe(false);
  });

  test("a document in another dossier is out of reach whatever the model asks", async () => {
    for (const capabilityId of ["documents.get", "documents.rerun_ocr", "documents.create_invoice_draft"]) {
      await expect(gateway.execute(company.id, capabilityId, { documentId: foreignDocument.id }), capabilityId)
        .rejects.toThrow(/dossier actif/i);
    }
    await expect(gateway.prepare(company.id, "documents.update_extraction", { documentId: foreignDocument.id, fields: { tva: 900 } }))
      .rejects.toThrow(/dossier actif/i);
    expect(calls).toHaveLength(0);
    // The foreign document is untouched.
    expect(JSON.parse((await prisma.document.findUnique({ where: { id: foreignDocument.id } })).extracted).fields.tva).toBe(4500);
  });

  test("read-only mode refuses every document mutation", async () => {
    // The mode is read from the dossier's own settings, never from the request:
    // a model that asks to run in automated mode does not thereby run in it.
    await prisma.wheatAiSettings.update({ where: { companyId: company.id }, data: { permissionMode: "READ_ONLY" } });
    for (const capabilityId of ["documents.update_extraction", "documents.rerun_ocr", "documents.create_invoice_draft"]) {
      await expect(
        ai.executeRegisteredCapability(prisma, gateway, { companyId: company.id, capabilityId, arguments: { documentId: document.id, fields: { tva: 900 } }, permissionMode: "AUTOMATED", confirmed: true }, actor.id),
        capabilityId,
      ).rejects.toThrow(/lecture seule/i);
    }
    expect(calls).toHaveLength(0);
    expect(JSON.parse((await prisma.document.findUnique({ where: { id: document.id } })).extracted).fields.tva).toBe(4500);
  });

  test("a plan with one unreachable step runs none of it", async () => {
    // Every step is validated and scoped before any of them runs, so a plan
    // that could only half-succeed is refused whole rather than leaving one
    // corrected document and one untouched.
    await expect(ai.executeRegisteredPlan(prisma, gateway, {
      companyId: company.id,
      confirmed: true,
      calls: [
        { capabilityId: "documents.update_extraction", arguments: { documentId: document.id, fields: { tva: 900 } } },
        { capabilityId: "documents.update_extraction", arguments: { documentId: foreignDocument.id, fields: { tva: 900 } } },
      ],
    }, actor.id)).rejects.toThrow(/dossier actif/i);

    expect(calls.some((call) => call.command === "updateExtraction")).toBe(false);
    for (const row of [document, foreignDocument]) {
      const stored = await prisma.document.findUnique({ where: { id: row.id } });
      expect(JSON.parse(stored.extracted).fields.tva).toBe(4500);
      expect(stored.status).toBe("TO_REVIEW");
    }
  });

  test("a plan containing only level-1 edits executes without confirmation", async () => {
    const result = await ai.executeRegisteredPlan(prisma, gateway, {
      companyId: company.id,
      calls: [
        { capabilityId: "documents.update_extraction", arguments: { documentId: document.id, fields: { tva: 900 } } },
        { capabilityId: "documents.rerun_ocr", arguments: { documentId: document.id } },
      ],
    }, actor.id);
    expect(result).toMatchObject({ executed: true, completed: 2, failed: 0 });
    expect(calls.filter((call) => call.command === "updateExtraction")).toHaveLength(1);
    expect(calls.filter((call) => call.command === "rerunOcr")).toHaveLength(1);
  });

  test("the assistant reaches Wheat's commands, never the database directly", () => {
    const source = fs.readFileSync(path.join(root, "electron", "wheatAiDomainGateway.ts"), "utf8");
    for (const capabilityId of ["documents.update_extraction", "documents.rerun_ocr", "documents.create_invoice_draft"]) {
      const line = source.split("\n").find((candidate) => candidate.includes(`case "${capabilityId}"`));
      expect(line, capabilityId).toContain("documentCommands()");
    }
    // No capability is allowed to hand raw SQL or a Prisma delegate to a model.
    const serialized = JSON.stringify(registry.publicWheatAiCapabilities()).toLowerCase();
    for (const forbidden of ["rawquery", "executeraw", "queryraw", "$transaction"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
