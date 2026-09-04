/**
 * The shared pre-submission review, against a real dossier.
 *
 * Everything here runs the actual pipeline from `electron/wheatReview.ts` on a
 * real SQLite copy of the migrated schema. The only thing mocked is the model,
 * and it is mocked deterministically: a canned JSON reply, so what the suite
 * asserts is the *gate* around the model, never the model's own behaviour.
 *
 * What has to hold, and is asserted below:
 *
 *  - a deterministic rule names the exact problem and blocks;
 *  - the review never writes anything, whatever it says;
 *  - a model finding is dropped unless its evidence is corroborated in the
 *    bounded context the model was given;
 *  - a model can never emit a blocker, and its confidence is capped;
 *  - a proposal never touches a date, a rate, an account or an identifier;
 *  - with no model reachable, the result says so in words and the deterministic
 *    half still runs — it is never presented as an AI reading;
 *  - a remote provider is never used without recorded consent.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const reviewModule = tsxRequire(path.join(root, "electron", "wheatReview.ts"), __filename);
const migratedDatabasePath = path.join(root, "prisma", "dev.db");

function sqliteUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

/** A model that answers with exactly what the test wants it to answer. */
function cannedModel(reply, locality = "LOCAL") {
  const calls = [];
  return {
    calls,
    resolve: async () => ({
      channel: {
        locality,
        provider: locality === "LOCAL" ? "OLLAMA" : "REMOTE",
        modelId: locality === "LOCAL" ? "ollama:test-model" : "remote:auto",
        run: async (request) => {
          calls.push(request);
          return typeof reply === "function" ? reply(request) : reply;
        },
      },
    }),
  };
}

const NO_MODEL = async () => ({
  channel: null,
  status: "UNAVAILABLE",
  message: "Aucun modèle n'est installé ni configuré : seuls les contrôles déterministes de Wheat ont été exécutés.",
});

test.describe("shared review pipeline", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let temporaryRoot;
  let prisma;
  let actor;
  let company;
  let fiscalYear;
  let journal;
  let accounts;
  let customer;

  test.beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-review-"));
    const databasePath = path.join(temporaryRoot, "wheat.sqlite");
    fs.copyFileSync(migratedDatabasePath, databasePath);
    prisma = new PrismaClient({ datasourceUrl: sqliteUrl(databasePath) });
    await prisma.$connect();

    actor = await prisma.user.create({ data: { name: "Review Admin", email: `review-${Date.now()}-${Math.random()}@wheat.local`, role: "ADMIN" } });
    company = await prisma.company.create({
      data: { name: "IFCOF", legalForm: "SARL", ice: "000187958000077", taxId: "1110375", city: "Casablanca", vatFrequency: "MONTHLY" },
    });
    await prisma.companyUser.create({ data: { companyId: company.id, userId: actor.id, role: "ADMIN" } });
    fiscalYear = await prisma.fiscalYear.create({
      data: { companyId: company.id, label: "2026", startsOn: new Date("2026-01-01T00:00:00Z"), endsOn: new Date("2026-12-31T00:00:00Z"), status: "OPEN" },
    });
    journal = await prisma.journal.create({ data: { companyId: company.id, code: "OD", label: "Opérations diverses", active: true } });
    accounts = {};
    for (const [key, code, label, classNo, type] of [
      ["customer", "342100", "Clients", 3, "ASSET"],
      ["supplier", "441100", "Fournisseurs", 4, "LIABILITY"],
      ["vatCollected", "445500", "Etat - TVA facturée", 4, "LIABILITY"],
      ["revenue", "712400", "Prestations de services", 7, "REVENUE"],
      ["bank", "514100", "Banque", 5, "ASSET"],
    ]) {
      accounts[key] = await prisma.account.create({
        data: { companyId: company.id, code, label, classNo, type, isStandard: true, active: true, postable: true, searchText: `${code} ${label}`.toLowerCase() },
      });
    }
    customer = await prisma.counterparty.create({
      data: {
        companyId: company.id, kind: "CUSTOMER", displayName: "ANOUAL HEALTH SOLUTIONS",
        ice: "003983471000077", identityKey: "ICE:003983471000077", paymentTermsDays: 30,
      },
    });
  });

  test.afterEach(async () => {
    await prisma?.$disconnect();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const service = (resolveModel) => reviewModule.createWheatReviewService({
    getPrisma: async () => prisma,
    getActorUserId: async () => actor.id,
    resolveModel,
  });

  const entryDraft = (overrides = {}) => ({
    companyId: company.id,
    journalId: journal.id,
    date: "2026-05-21",
    label: "Vente de prestations",
    lines: [
      { accountId: accounts.customer.id, label: "Client", debit: "1200.00", credit: "0" },
      { accountId: accounts.revenue.id, label: "Produit", debit: "0", credit: "1200.00" },
    ],
    ...overrides,
  });

  /* ------------------------------------------------------ deterministic gate */

  test("an unbalanced entry is blocked, and the finding names the exact gap", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: accounts.customer.id, label: "Client", debit: "1200.00", credit: "0" },
          { accountId: accounts.revenue.id, label: "Produit", debit: "0", credit: "1000.00" },
        ],
      }),
    });

    expect(result.blocked).toBe(true);
    expect(result.outcome).toBe("ATTENTION_REQUIRED");
    const unbalanced = result.findings.find((item) => item.code === "ENTRY.UNBALANCED");
    expect(unbalanced).toBeTruthy();
    expect(unbalanced.severity).toBe("BLOCKER");
    expect(unbalanced.origin).toBe("DETERMINISTIC");
    // The exact amounts, in exact centimes, not a vague "check your entry".
    expect(unbalanced.explanation).toContain("1200,00 MAD");
    expect(unbalanced.explanation).toContain("1000,00 MAD");
    expect(unbalanced.explanation).toContain("200,00 MAD");
    expect(unbalanced.accountingReason).toMatch(/partie double/i);
    expect(result.nextAction).toContain(unbalanced.title);
  });

  test("a balanced entry in an open period passes, and says what it checked", async () => {
    const result = await service(NO_MODEL).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft() });
    expect(result.blocked).toBe(false);
    expect(result.outcome).toBe("PASS");
    expect(result.confirmed.join(" ")).toContain("1200,00 MAD");
    expect(result.checked.join(" ")).toMatch(/Équilibre débit\/crédit/);
  });

  /**
   * Found by driving the real entry form: it leaves the unused side of each
   * line empty, and an empty box was being read as an unreadable amount. Every
   * ordinary one-sided line came back "malformed" and the totals came back
   * zero — the review contradicted a perfectly valid draft.
   */
  test("a blank amount box is a zero, not an unreadable value", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: accounts.customer.id, label: "Client", debit: "1200.00", credit: "" },
          { accountId: accounts.revenue.id, label: "Produit", credit: "1200.00" },
        ],
      }),
    });
    expect(result.findings.map((item) => item.code)).not.toContain("ENTRY.LINE_MALFORMED");
    expect(result.blocked).toBe(false);
    expect(result.confirmed.join(" ")).toContain("1200,00 MAD");
  });

  test("an amount that really is unreadable is still reported, and no balance is claimed", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: accounts.customer.id, label: "Client", debit: "mille deux cents", credit: "" },
          { accountId: accounts.revenue.id, label: "Produit", credit: "1200.00" },
        ],
      }),
    });
    expect(result.findings.map((item) => item.code)).toContain("ENTRY.LINE_MALFORMED");
    // A total computed from a line that could not be read is not a balance.
    expect(result.confirmed.join(" ")).not.toMatch(/équilibrée/i);
  });

  /**
   * The review may be stricter in what it *says* than the entry service, never
   * in what it *allows*: refusing a draft Wheat itself accepts would make the
   * assistant an obstacle rather than a reviewer.
   */
  test("a grouping account is a warning, an archived one is a blocker", async () => {
    const grouping = await prisma.account.create({
      data: { companyId: company.id, code: "34", label: "Créances", classNo: 3, type: "ASSET", active: true, postable: false, searchText: "34" },
    });
    const grouped = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: grouping.id, label: "Client", debit: "1200.00", credit: "" },
          { accountId: accounts.revenue.id, label: "Produit", credit: "1200.00" },
        ],
      }),
    });
    const warning = grouped.findings.find((item) => item.code === "ENTRY.ACCOUNT_NOT_POSTABLE");
    expect(warning.severity).toBe("WARNING");
    expect(grouped.blocked).toBe(false);

    const archived = await prisma.account.create({
      data: { companyId: company.id, code: "342199", label: "Ancien client", classNo: 3, type: "ASSET", active: false, postable: true, searchText: "342199" },
    });
    const refused = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: archived.id, label: "Client", debit: "1200.00", credit: "" },
          { accountId: accounts.revenue.id, label: "Produit", credit: "1200.00" },
        ],
      }),
    });
    expect(refused.findings.map((item) => item.code)).toContain("ENTRY.ACCOUNT_ARCHIVED");
    expect(refused.blocked).toBe(true);
  });

  test("a locked period blocks the entry at its date", async () => {
    await prisma.fiscalYear.update({ where: { id: fiscalYear.id }, data: { lockedTo: new Date("2026-06-30T00:00:00Z") } });
    const result = await service(NO_MODEL).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft() });
    expect(result.blocked).toBe(true);
    expect(result.findings.map((item) => item.code)).toContain("PERIOD.LOCKED");
  });

  test("a date outside every fiscal year is refused rather than guessed", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id, workflowId: "entry.create", draft: entryDraft({ date: "2019-03-04" }),
    });
    expect(result.findings.map((item) => item.code)).toContain("PERIOD.NO_FISCAL_YEAR");
  });

  test("an account from another dossier is refused", async () => {
    const other = await prisma.company.create({ data: { name: "AUTRE", legalForm: "SARL", ice: "000000000000001", taxId: "X", city: "Rabat" } });
    const foreign = await prisma.account.create({
      data: { companyId: other.id, code: "342100", label: "Clients", classNo: 3, type: "ASSET", active: true, postable: true, searchText: "342100" },
    });
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({
        lines: [
          { accountId: foreign.id, label: "Client", debit: "10.00", credit: "0" },
          { accountId: accounts.revenue.id, label: "Produit", debit: "0", credit: "10.00" },
        ],
      }),
    });
    expect(result.findings.map((item) => item.code)).toContain("ENTRY.ACCOUNT_FOREIGN");
  });

  test("an invoice whose HT + TVA does not make the TTC is blocked, with the correct total proposed", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "invoice.create_draft",
      draft: {
        kind: "SALE", counterpartyId: customer.id, invoiceNo: "FA-2026-0001",
        invoiceDate: "2026-05-21", dueDate: "2026-06-20",
        lines: [{ description: "Prestation", htCents: "100000", vatCents: "20000", ttcCents: "115000" }],
      },
    });
    const finding = result.findings.find((item) => item.code === "INVOICE.LINE_TOTALS");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("BLOCKER");
    expect(finding.currentValue).toBe("1150,00 MAD");
    expect(finding.proposedValue).toBe("1200,00 MAD");
    expect(finding.accountingReason).toMatch(/tiers/i);
  });

  test("a purchase invoice on a customer-only third party is a warning, not a silent pass", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "invoice.create_draft",
      draft: {
        kind: "PURCHASE", counterpartyId: customer.id, invoiceNo: "FA-2026-0002",
        invoiceDate: "2026-05-21", dueDate: "2026-06-20",
        lines: [{ description: "Achat", htCents: "100000", vatCents: "20000", ttcCents: "120000" }],
      },
    });
    const finding = result.findings.find((item) => item.code === "INVOICE.COUNTERPARTY_DIRECTION");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("WARNING");
    expect(result.acknowledgementRequired).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test("an allocation beyond the payment's remaining balance is blocked in exact centimes", async () => {
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id, kind: "SALE", counterparty: customer.displayName, counterpartyId: customer.id,
        invoiceNo: "FA-2026-0010", invoiceDate: new Date("2026-05-01T00:00:00Z"),
        htCents: 100000n, vatCents: 20000n, ttcCents: 120000n, status: "UNPAID", lifecycleStatus: "POSTED", currency: "MAD",
      },
    });
    const payment = await prisma.payment.create({
      data: {
        companyId: company.id, counterpartyId: customer.id, kind: "RECEIPT", paymentDate: new Date("2026-05-10T00:00:00Z"),
        method: "VIREMENT", amountCents: 50000n, lifecycleStatus: "POSTED", currency: "MAD",
      },
    });
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "payment.allocate",
      draft: { paymentId: payment.id, invoiceId: invoice.id, amountCents: "80000" },
    });
    const finding = result.findings.find((item) => item.code === "ALLOCATION.OVER_PAYMENT");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("BLOCKER");
    expect(finding.proposedValue).toBe("500,00 MAD");
    expect(result.blocked).toBe(true);
  });

  test("a third party whose identity is the dossier itself is blocked", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "IFCOF", ice: "000187958000077" },
    });
    const finding = result.findings.find((item) => item.code === "COUNTERPARTY.IS_DOSSIER");
    expect(finding).toBeTruthy();
    expect(finding.severity).toBe("BLOCKER");
    expect(finding.accountingReason).toMatch(/son propre tiers/i);
  });

  test("a posted entry cannot be deleted, and the reviewer says why", async () => {
    const entry = await prisma.entry.create({
      data: {
        companyId: company.id, journalId: journal.id, number: "OD-2026-000001", date: new Date("2026-05-21T00:00:00Z"),
        pieceNumber: "OD-2026-000001", label: "Déjà comptabilisée", status: "POSTED", journalCodeSnapshot: "OD",
      },
    });
    const result = await service(NO_MODEL).review({
      companyId: company.id, workflowId: "entry.delete_draft", draft: { entryId: entry.id },
    });
    const finding = result.findings.find((item) => item.code === "DRAFT.NOT_DRAFT");
    expect(finding).toBeTruthy();
    expect(finding.accountingReason).toMatch(/ajout seul/i);
    expect(result.blocked).toBe(true);
  });

  test("the dossier's own VAT knowledge is never invented", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "tax_config.save_draft",
      draft: { effectiveFrom: "2026-01-01", rates: [{ code: "TVA20", direction: "COLLECTED" }] },
    });
    expect(result.findings.map((item) => item.code)).toContain("TAX_CONFIG.RATE_MISSING");
    const notice = result.findings.find((item) => item.code === "TAX_CONFIG.VERIFY_SOURCE");
    expect(notice.explanation).toMatch(/source officielle|professionnel/i);
  });

  test("preparing a VAT period states plainly that Wheat files nothing", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id, workflowId: "vat.generate", draft: { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
    });
    const notice = result.findings.find((item) => item.code === "VAT.NOT_A_FILING");
    expect(notice).toBeTruthy();
    expect(notice.explanation).toMatch(/DGI/);
    expect(notice.requiresAcknowledgement).toBe(false);
  });

  /* ------------------------------------------------------- non-mutation proof */

  test("a review writes nothing to the dossier it inspects", async () => {
    const before = {
      entries: await prisma.entry.count({ where: { companyId: company.id } }),
      invoices: await prisma.invoice.count({ where: { companyId: company.id } }),
      counterparties: await prisma.counterparty.count({ where: { companyId: company.id } }),
      accounts: await prisma.account.count({ where: { companyId: company.id } }),
    };
    for (const [workflowId, draft] of [
      ["entry.create", entryDraft()],
      ["counterparty.create", { kind: "CUSTOMER", displayName: "NOUVEAU TIERS" }],
      ["invoice.create_draft", { kind: "SALE", counterpartyId: customer.id, invoiceDate: "2026-05-21", dueDate: "2026-06-20", lines: [{ description: "x", htCents: "100", vatCents: "20", ttcCents: "120" }] }],
      ["account.save", { code: "712401", label: "Autres prestations", type: "REVENUE" }],
    ]) {
      await service(NO_MODEL).review({ companyId: company.id, workflowId, draft });
    }
    expect({
      entries: await prisma.entry.count({ where: { companyId: company.id } }),
      invoices: await prisma.invoice.count({ where: { companyId: company.id } }),
      counterparties: await prisma.counterparty.count({ where: { companyId: company.id } }),
      accounts: await prisma.account.count({ where: { companyId: company.id } }),
    }).toEqual(before);
  });

  /* --------------------------------------------------------- AI availability */

  test("with no model reachable, the result says so and the deterministic half still ran", async () => {
    // Asked for explicitly, so a reading is genuinely owed here: that is the
    // case in which "no model answered" is a fact the reader needs.
    const result = await service(NO_MODEL).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.ran).toBe(false);
    expect(result.model.status).toBe("UNAVAILABLE");
    expect(result.model.locality).toBe("NONE");
    expect(result.model.message).toMatch(/déterministes/i);
    // The honest part: nothing in the result pretends a model looked at this.
    expect(result.findings.every((item) => item.origin === "DETERMINISTIC")).toBe(true);
    expect(result.checked.length).toBeGreaterThan(0);
  });

  test("a refused remote review is reported as declined, never as a completed reading", async () => {
    const declined = async () => ({
      channel: null,
      status: "DECLINED",
      message: "Aucun modèle local n'est disponible. Une relecture distante exige votre accord explicite.",
    });
    const result = await service(declined).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.ran).toBe(false);
    expect(result.model.status).toBe("DECLINED");
    expect(result.model.message).toMatch(/accord explicite/i);
  });

  test("a model failure is reported as a failure, not as a clean pass", async () => {
    const failing = async () => ({
      channel: { locality: "LOCAL", provider: "OLLAMA", modelId: "ollama:test", run: async () => { throw new Error("socket hang up"); } },
    });
    const result = await service(failing).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.ran).toBe(false);
    expect(result.model.status).toBe("FAILED");
    // The sentence a person reads says what happened and what still ran. The
    // provider's own error text is diagnostic, so it lives with the identifiers
    // behind the details disclosure rather than in front of somebody saving.
    expect(result.model.message).toMatch(/n'a pas abouti/i);
    expect(result.model.message).toMatch(/contrôles comptables/i);
    expect(result.model.message).not.toMatch(/socket hang up/);
    expect(result.model.detail).toMatch(/socket hang up/);
    expect(result.model.detail).toMatch(/ollama:test/);
  });

  test("a deterministic-only workflow never calls a model, and says why", async () => {
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({
      companyId: company.id, workflowId: "fiscal_period.lock",
      draft: { fiscalYearId: fiscalYear.id, lockedTo: "2026-06-30" },
    });
    expect(model.calls).toHaveLength(0);
    expect(result.model.status).toBe("NOT_APPLICABLE");
    expect(result.model.message).toMatch(/règle de date/i);
  });

  /* -------------------------------------------------------- the model's gate */

  test("a corroborated model finding is kept, capped, and clearly attributed", async () => {
    const model = cannedModel(JSON.stringify({
      findings: [{
        code: "LABEL_VAGUE",
        severity: "WARNING",
        title: "Le libellé ne dit pas de quelle prestation il s'agit.",
        explanation: "« Vente de prestations » ne permettra pas de retrouver l'opération dans six mois.",
        target: "label",
        evidence: "Vente de prestations",
        proposedValue: "Vente de prestations — client ANOUAL, mai 2026",
        confidence: 99,
        accountingReason: "Le libellé est la première justification d'une écriture au livre-journal.",
      }],
    }));

    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(model.calls).toHaveLength(1);
    // The model receives the bounded context, never the dossier at large.
    expect(model.calls[0].user).toContain("Vente de prestations");
    expect(model.calls[0].user).not.toContain(company.id);

    const finding = result.findings.find((item) => item.origin === "MODEL");
    expect(finding).toBeTruthy();
    expect(finding.code).toBe("MODEL.LABEL_VAGUE");
    // A re-reading is never more certain than the dossier's own data.
    expect(finding.confidence).toBeLessThanOrEqual(70);
    expect(finding.evidence).toContain("Vente de prestations");
    expect(finding.safeAutofix).toBe(true);
    expect(result.model.ran).toBe(true);
    expect(result.model.locality).toBe("LOCAL");
    expect(result.model.message).toMatch(/quitté cet ordinateur/i);
  });

  test("a model finding with no support in the context is dropped", async () => {
    const model = cannedModel(JSON.stringify({
      findings: [{
        code: "INVENTED",
        severity: "WARNING",
        title: "Le fournisseur SOCIETE FANTOME est inconnu.",
        explanation: "Ce nom n'apparaît nulle part.",
        target: "label",
        evidence: "SOCIETE FANTOME NON EXISTANTE",
        confidence: 90,
      }],
    }));
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.findings.filter((item) => item.origin === "MODEL")).toHaveLength(0);
    expect(result.model.message).toMatch(/écartée/i);
  });

  test("a model cannot emit a blocker, whatever severity it claims", async () => {
    const model = cannedModel(JSON.stringify({
      findings: [{
        code: "STOP", severity: "BLOCKER", title: "Refuse cette écriture.",
        explanation: "Non.", target: "label", evidence: "Vente de prestations", confidence: 100,
      }],
    }));
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    const finding = result.findings.find((item) => item.origin === "MODEL");
    expect(finding.severity).toBe("INFO");
    expect(result.blocked).toBe(false);
  });

  test("a model proposal never targets a date, a rate, an account or an identifier", async () => {
    for (const target of ["date", "vatRateBps", "accountId", "ice", "amountCents"]) {
      const model = cannedModel(JSON.stringify({
        findings: [{
          code: "REWRITE", severity: "WARNING", title: `Corrige ${target}.`, explanation: "…",
          target, evidence: "Vente de prestations", proposedValue: "2020-01-01", confidence: 80,
        }],
      }));
      const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
      const finding = result.findings.find((item) => item.origin === "MODEL");
      expect(finding, target).toBeTruthy();
      expect(finding.safeAutofix, `${target} must not be autofixable`).toBe(false);
    }
  });

  test("an unparseable model reply degrades to the deterministic review", async () => {
    const model = cannedModel("je ne sais pas répondre en JSON");
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.findings.filter((item) => item.origin === "MODEL")).toHaveLength(0);
    expect(result.model.ran).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test("a remote reading is labelled remote, so the user knows the data left the machine", async () => {
    const model = cannedModel('{"findings":[]}', "REMOTE");
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.locality).toBe("REMOTE");
    expect(result.model.status).toBe("REMOTE");
    expect(result.model.message).toMatch(/distance/i);
    expect(result.model.message).toMatch(/consentement/i);
  });

  /* ---------------------------------------------------------------- audit */

  test("a review that raised something is appended to the company audit chain", async () => {
    const before = await prisma.auditEvent.count({ where: { chain: { companyId: company.id } } });
    await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "entry.create",
      draft: entryDraft({ lines: [{ accountId: accounts.customer.id, label: "Seule ligne", debit: "10.00", credit: "0" }] }),
    });
    const after = await prisma.auditEvent.count({ where: { chain: { companyId: company.id } } });
    expect(after).toBeGreaterThan(before);
    const event = await prisma.auditEvent.findFirst({ where: { chain: { companyId: company.id } }, orderBy: { sequence: "desc" } });
    expect(event.action).toBe("WHEAT_REVIEW_COMPLETED");
    expect(event.payloadJson).toContain("ENTRY.UNBALANCED");
  });

  test("a clean review with no model leaves the audit chain alone", async () => {
    const before = await prisma.auditEvent.count({ where: { chain: { companyId: company.id } } });
    const result = await service(NO_MODEL).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft() });
    expect(result.outcome).toBe("PASS");
    expect(await prisma.auditEvent.count({ where: { chain: { companyId: company.id } } })).toBe(before);
  });

  /* --------------------------------------------------------------- refusals */

  test("an unknown workflow is refused rather than waved through", async () => {
    await expect(service(NO_MODEL).review({ companyId: company.id, workflowId: "entry.launch_missiles", draft: {} }))
      .rejects.toThrow(/matrice de relecture/i);
  });

  test("a review for another dossier's company id is refused", async () => {
    await expect(service(NO_MODEL).review({ companyId: "company-that-does-not-exist", workflowId: "entry.create", draft: entryDraft() }))
      .rejects.toThrow(/n'existe plus/i);
  });

  test("an exempt workflow is answered without pretending anything was reviewed", async () => {
    const result = await service(NO_MODEL).review({ companyId: company.id, workflowId: "backup.create", draft: {} });
    expect(result.outcome).toBe("PASS");
    expect(result.classification).toBe("EXEMPT");
    expect(result.model.status).toBe("NOT_APPLICABLE");
    expect(result.checked).toEqual([]);
  });

  /* --------------------------------------------------- when a model is asked */

  /**
   * The review used to call a model on every reviewed save. Correcting one
   * field on one document — the commonest act in the application — waited on a
   * model in order to be told nothing was wrong, and did it again on the next
   * field. What follows pins the rule that replaced that, in both directions:
   * routine work is not interviewed, and consequential work still is.
   *
   * The line that matters most is the last one. Skipping the model never skips
   * a check: the deterministic pass runs on every review, and the domain
   * service re-validates inside its own transaction either way.
   */

  test("a routine draft that passes every check is saved without asking a model", async () => {
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "FOURNISSEUR ORDINAIRE SARL", ice: "001234567000041" },
    });
    expect(model.calls).toHaveLength(0);
    expect(result.model.ran).toBe(false);
    expect(result.model.status).toBe("NOT_NEEDED");
    expect(result.outcome).toBe("PASS");
  });

  test("the same operation asks a model as soon as Wheat's own checks find something", async () => {
    // Identical workflow and risk level; the only difference is that there is
    // now an anomaly worth a second reading.
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "IFCOF", ice: "000187958000077" },
    });
    expect(model.calls).toHaveLength(1);
    expect(result.findings.some((item) => item.severity === "BLOCKER")).toBe(true);
  });

  test("an operation with real accounting consequence is always read", async () => {
    /*
     * Risk level 3 is where the ledger itself changes — posting, extourne,
     * voiding, confirming an import. A reading is unconditional there, findings
     * or not, because that is the write nobody can quietly undo.
     *
     * Level 2 — preparing a draft, uploading a document, configuring a bank
     * account — deliberately does not qualify. Those are saved dozens of times
     * an hour, and asking a model to agree with Wheat's own checks each time is
     * what put a review dialog in front of ordinary bookkeeping.
     */
    const entry = await prisma.entry.create({
      data: {
        companyId: company.id, journalId: journal.id, number: "OD-2026-000090", date: new Date("2026-05-21T00:00:00Z"),
        pieceNumber: "OD-2026-000090", label: "À comptabiliser", status: "DRAFT", journalCodeSnapshot: "OD",
        lines: {
          create: [
            { position: 1, accountId: accounts.revenue.id, accountCodeSnapshot: accounts.revenue.code, accountLabelSnapshot: accounts.revenue.label, label: "Charge", debitCents: 100000n, creditCents: 0n },
            { position: 2, accountId: accounts.customer.id, accountCodeSnapshot: accounts.customer.code, accountLabelSnapshot: accounts.customer.label, label: "Fournisseur", debitCents: 0n, creditCents: 100000n },
          ],
        },
      },
    });
    const model = cannedModel('{"findings":[]}');
    const posted = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.post", draft: { entryId: entry.id } });
    expect(model.calls).toHaveLength(1);
    expect(posted.riskLevel).toBe(3);

    // The same dossier, a level-2 preparation with nothing wrong: no reading.
    const preparation = cannedModel('{"findings":[]}');
    const draft = await service(preparation.resolve).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "FOURNISSEUR SANS ANOMALIE SARL", ice: "001234567000065" },
    });
    expect(preparation.calls).toHaveLength(0);
    expect(draft.model.status).toBe("NOT_NEEDED");
  });

  test("asking for a review explicitly gets one, anomaly or not", async () => {
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "FOURNISSEUR ORDINAIRE SARL", ice: "001234567000041" },
      requested: true,
    });
    expect(model.calls).toHaveLength(1);
    expect(result.model.ran).toBe(true);
  });

  test("skipping the model never skips a check", async () => {
    // The guarantee the whole policy rests on: a draft that must be refused is
    // still refused, by the deterministic pass, with no model involved.
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({
      companyId: company.id,
      workflowId: "invoice.create_draft",
      draft: {
        kind: "SALE", counterpartyId: customer.id, invoiceNo: "FA-2026-9100",
        invoiceDate: "2026-05-21", dueDate: "2026-06-20",
        lines: [{ description: "Prestation", htCents: "100000", vatCents: "20000", ttcCents: "115000" }],
      },
    });
    expect(result.blocked).toBe(true);
    expect(result.findings.some((item) => item.code === "INVOICE.LINE_TOTALS")).toBe(true);
    expect(result.checked.length).toBeGreaterThan(0);
  });

  test("a skipped reading is reported as skipped, never as a completed one", async () => {
    const result = await service(NO_MODEL).review({
      companyId: company.id,
      workflowId: "counterparty.create",
      draft: { kind: "SUPPLIER", displayName: "AUTRE FOURNISSEUR SARL", ice: "001234567000058" },
    });
    expect(result.model.ran).toBe(false);
    expect(result.model.message).toMatch(/aucune relecture par un modèle/i);
  });

  /* ------------------------------------------------ what the reader is shown */

  test("no provider or model identifier reaches the ordinary reading path", async () => {
    // The regression: "remote:openrouter:google/gemma-4-26b-a4b-it:free" in
    // front of somebody saving an invoice. Identifiers belong in `detail`.
    const model = cannedModel('{"findings":[]}', "REMOTE");
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.ran).toBe(true);
    expect(result.model.message).not.toMatch(/remote:|openrouter|ollama:|gemma/i);
    expect(result.model.message).toMatch(/distance/i);
  });

  test("the identifiers are still available, for the places that need them", async () => {
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.detail).toContain("ollama:test-model");
    expect(result.model.provider).toBe("OLLAMA");
  });

  test("a local reading still says the dossier stayed on this machine", async () => {
    const model = cannedModel('{"findings":[]}');
    const result = await service(model.resolve).review({ companyId: company.id, workflowId: "entry.create", draft: entryDraft(), requested: true });
    expect(result.model.message).toMatch(/quitté cet ordinateur/i);
    expect(result.model.message).not.toMatch(/ollama/i);
  });
});
