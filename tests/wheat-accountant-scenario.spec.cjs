const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * A full dossier walked the way a fiduciaire walks one: identity, tiers,
 * facture d'achat, facture de vente, règlements, then every report read back
 * and compared against totals computed here from the invoices alone.
 *
 * The reports must agree with arithmetic done outside Wheat; one Wheat surface
 * confirming another proves nothing.
 */
test("a real dossier posts, reports and locks the way an accountant expects", async () => {
  test.setTimeout(180000);
  const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-accountant-"));
  const profile = path.join(temporary, "profile");
  const launch = async () => electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: profile },
  });

  let app = await launch();
  let result;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    await page.getByLabel("Nom de la société").fill("FIDUCIAIRE ESSAOUIRA SARL");
    await page.getByLabel("Ville").fill("Essaouira");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30000 });

    result = await page.evaluate(async () => {
      const api = window.wheat;
      const boot = await api.getBootstrap();
      const company = boot.companies[0];
      const year = company.fiscalYears[0];
      const account = (code) => company.accounts.find((row) => row.code === code);
      const day = (offset) => {
        const start = new Date(`${year.startsOn.slice(0, 10)}T00:00:00.000Z`);
        start.setUTCDate(start.getUTCDate() + offset);
        return start.toISOString().slice(0, 10);
      };

      // Une configuration TVA versionnée est la condition d'entrée : Wheat
      // refuse de comptabiliser de la TVA sans règle datée et hachée.
      const taxDraft = await api.saveTaxConfigurationDraft({
        companyId: company.id,
        name: "TVA Maroc 2026",
        accountingBasis: "COLLECTION",
        filingFrequency: "MONTHLY",
        effectiveFrom: `${year.startsOn.slice(0, 4)}-01-01`,
        sourceReference: "CGI - Livre II, Titre premier",
        rates: [
          { code: "TVA20C", label: "TVA collectée 20 %", rateBps: 2000, direction: "COLLECTED", accountId: account("445500").id },
          { code: "TVA20D", label: "TVA déductible 20 %", rateBps: 2000, direction: "DEDUCTIBLE", accountId: account("345520").id },
        ],
      });
      const taxConfig = await api.activateTaxConfiguration({ companyId: company.id, id: taxDraft.id, expectedVersion: taxDraft.version });
      const rateId = (code) => taxConfig.rates.find((rate) => rate.code === code).id;

      const supplier = await api.createCounterparty({
        companyId: company.id, kind: "SUPPLIER", displayName: "SOCIETE ATLAS FOURNITURES SARL",
        ice: "001234567000045", taxId: "14785236", city: "Casablanca", paymentTermsDays: 30,
      });
      const customer = await api.createCounterparty({
        companyId: company.id, kind: "CUSTOMER", displayName: "MAROC TELECOM SERVICES SA",
        ice: "009876543000012", taxId: "98745612", city: "Rabat", paymentTermsDays: 60,
      });

      // Achat : 12 000,00 HT + 2 400,00 TVA (20 %) = 14 400,00 TTC sur deux lignes.
      const purchaseDraft = await api.createInvoiceDraft({
        companyId: company.id, counterpartyId: supplier.id, kind: "PURCHASE",
        invoiceNo: "FA-2026-0451", invoiceDate: day(10), dueDate: day(40), currency: "MAD",
        taxConfigurationVersionId: taxConfig.id,
        lines: [
          { description: "Marchandises", accountId: account("611100").id, ht: "9000.00", vat: "1800.00", vatRateBps: 2000, taxRateDefinitionId: rateId("TVA20D") },
          { description: "Fournitures de bureau", accountId: account("612500").id, ht: "3000.00", vat: "600.00", vatRateBps: 2000, taxRateDefinitionId: rateId("TVA20D") },
        ],
      });
      const purchase = await api.postInvoice({ companyId: company.id, id: purchaseDraft.id, expectedVersion: purchaseDraft.version });

      // Vente : 20 000,00 HT + 4 000,00 TVA = 24 000,00 TTC.
      const saleDraft = await api.createInvoiceDraft({
        companyId: company.id, counterpartyId: customer.id, kind: "SALE",
        invoiceDate: day(15), dueDate: day(75), currency: "MAD",
        taxConfigurationVersionId: taxConfig.id,
        lines: [{ description: "Prestation de conseil", accountId: account("712400").id, ht: "20000.00", vat: "4000.00", vatRateBps: 2000, taxRateDefinitionId: rateId("TVA20C") }],
      });
      const sale = await api.postInvoice({ companyId: company.id, id: saleDraft.id, expectedVersion: saleDraft.version });

      // Règlement fournisseur partiel : 10 000,00 sur 14 400,00.
      const disbursementDraft = await api.createPaymentDraft({
        companyId: company.id, counterpartyId: supplier.id, kind: "DISBURSEMENT",
        paymentDate: day(20), method: "VIREMENT", reference: "VIR-001", amount: "10000.00",
        settlementAccountId: account("514100").id,
        allocations: [{ invoiceId: purchase.id, amount: "10000.00" }],
      });
      const disbursement = await api.postPayment({ companyId: company.id, id: disbursementDraft.id, expectedVersion: disbursementDraft.version });

      // Encaissement client intégral.
      const receiptDraft = await api.createPaymentDraft({
        companyId: company.id, counterpartyId: customer.id, kind: "RECEIPT",
        paymentDate: day(25), method: "VIREMENT", reference: "ENC-001", amount: "24000.00",
        settlementAccountId: account("514100").id,
        allocations: [{ invoiceId: sale.id, amount: "24000.00" }],
      });
      const receipt = await api.postPayment({ companyId: company.id, id: receiptDraft.id, expectedVersion: receiptDraft.version });

      const to = year.endsOn.slice(0, 10);
      const balance = await api.getBalanceFamily({ companyId: company.id, view: "GENERAL", from: day(0), to });
      const trial = await api.getTrialBalance({ companyId: company.id, from: day(0), to });
      const integrity = await api.getAccountingIntegrity({ companyId: company.id });
      const purchaseSettlement = await api.getInvoiceSettlement({ companyId: company.id, id: purchase.id });
      const saleSettlement = await api.getInvoiceSettlement({ companyId: company.id, id: sale.id });
      const balanceRow = (code) => balance.rows.find((row) => row.code === code) ?? null;

      // Correction : un avoir fournisseur sur la ligne « Fournitures de bureau »
      // (3 000,00 HT + 600,00 TVA). Wheat corrige par pièce liée, jamais en
      // réécrivant la facture d'origine.
      const creditedLine = purchase.lines.find((line) => line.description === "Fournitures de bureau");
      const creditDraft = await api.createCreditNoteDraft({
        companyId: company.id, creditedInvoiceId: purchase.id, invoiceDate: day(28),
        invoiceNo: "AV-2026-0031", creditReason: "Fournitures retournées au fournisseur",
        lines: [{ creditedInvoiceLineId: creditedLine.id, htCents: "300000", vatCents: "60000", ttcCents: "360000" }],
      });
      const credit = await api.postCreditNote({ companyId: company.id, id: creditDraft.id, expectedVersion: creditDraft.version });
      const creditEntry = await api.getReportEntryDetail({ companyId: company.id, entryId: credit.postedEntryId });
      const afterCredit = await api.getBalanceFamily({ companyId: company.id, view: "GENERAL", from: day(0), to });
      const afterCreditRow = (code) => afterCredit.rows.find((row) => row.code === code) ?? null;

      // Extourne d'une écriture manuelle : les deux pièces restent au grand
      // livre et se neutralisent, la pièce d'origine n'est jamais effacée.
      const manual = await api.createEntry({
        companyId: company.id, journalId: company.journals.find((journal) => journal.code === "OD").id, date: day(27),
        label: "Régularisation à extourner", status: "POSTED",
        lines: [
          { accountId: account("614100").id, label: "Charge", debit: "1500.00", credit: "0" },
          { accountId: account("441100").id, label: "Fournisseur", debit: "0", credit: "1500.00" },
        ],
      });
      const reversal = await api.reverseEntry({ companyId: company.id, entryId: manual.id, date: day(29), reason: "Régularisation erronée" });
      const afterReversal = await api.getBalanceFamily({ companyId: company.id, view: "GENERAL", from: day(0), to });
      const afterReversalRow = (code) => afterReversal.rows.find((row) => row.code === code) ?? null;
      const manualAfterReversal = await api.getReportEntryDetail({ companyId: company.id, entryId: manual.id });

      // Rapprochement bancaire : le relevé porte exactement les deux règlements
      // déjà comptabilisés. Après pointage, la banque et la comptabilité disent
      // le même solde, et le rapprochement ne crée aucune écriture.
      const bankAccount = boot.bankAccounts?.[0] ?? (await api.getReconciliationWorkspace({ companyId: company.id })).accounts[0];
      const statementRows = [
        { date: day(20), label: "VIREMENT FOURNISSEUR ATLAS", reference: "VIR-001", amount: "-10000.00", currency: "MAD" },
        { date: day(25), label: "ENCAISSEMENT MAROC TELECOM", reference: "ENC-001", amount: "24000.00", currency: "MAD" },
      ];
      const csv = ["Date;Description;Reference;Amount;Currency", ...statementRows.map((row) => `${row.date};${row.label};${row.reference};${row.amount};${row.currency}`)].join("\r\n");
      const bytes = new TextEncoder().encode(csv);
      const bytesBase64 = btoa(String.fromCharCode(...bytes));
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const parsed = await api.parseBankStatement({ sourceName: "releve-essaouira.csv", bytesBase64 });
      const mapping = { date: "Date", label: "Description", reference: "Reference", amount: "Amount", currency: "Currency" };
      const statementReview = await api.reviewBankStatement({
        bankAccountId: bankAccount.id, sourceSha256: digest, rows: parsed.rows, mapping, sourceCurrency: parsed.currency,
      });
      // Un CSV ne déclare aucun solde : ceux du relevé papier sont saisis, et
      // Wheat refuse l'import si les mouvements ne les relient pas exactement.
      let contradictedBalances = "";
      try {
        await api.importBankStatement({
          companyId: company.id, bankAccountId: bankAccount.id, sourceName: "releve-essaouira.csv", sourceSha256: digest,
          sourceBytesBase64: bytesBase64, sourceFormat: parsed.format, sourceCurrency: parsed.currency, rows: parsed.rows, mapping,
          openingBalanceCents: "0", closingBalanceCents: "1500000",
        });
      } catch (error) { contradictedBalances = String(error?.message ?? error); }

      const imported = await api.importBankStatement({
        companyId: company.id, bankAccountId: bankAccount.id, sourceName: "releve-essaouira.csv", sourceSha256: digest,
        sourceBytesBase64: bytesBase64, sourceFormat: parsed.format, sourceCurrency: parsed.currency, rows: parsed.rows, mapping,
        // 0 + (−10 000 + 24 000) = 14 000, tel qu'imprimé sur le relevé.
        openingBalanceCents: "0", closingBalanceCents: "1400000",
      });

      const reconciled = [];
      for (const movement of imported.movements ?? []) {
        const candidates = await api.getReconciliationCandidates({ movementId: movement.id });
        const best = (candidates.entryLines ?? [])[0];
        if (!best) { reconciled.push({ reference: movement.reference, matched: false }); continue; }
        const confirmation = await api.confirmReconciliation({
          movementId: movement.id, expectedRevision: movement.revision ?? 0,
          allocations: [{ entryLineId: best.id, amountCents: best.suggestedCents }],
          paymentEvidence: (candidates.paymentEvidence ?? []).slice(0, 1).map((payment) => ({ paymentId: payment.id, amountCents: best.suggestedCents })),
          note: "Pointage du relevé",
        });
        reconciled.push({ reference: movement.reference, matched: true, allocated: best.suggestedCents, status: confirmation.movement?.status ?? null });
      }
      const bankTotal = await api.getBankTotal({ companyId: company.id, asOf: to });
      // Un rapprochement pointe, il ne comptabilise pas.
      const afterReconciliation = await api.getBalanceFamily({ companyId: company.id, view: "GENERAL", from: day(0), to });

      // Un deuxième import du même fichier doit être refusé.
      let duplicateImport = "";
      try {
        await api.importBankStatement({
          companyId: company.id, bankAccountId: bankAccount.id, sourceName: "releve-essaouira.csv", sourceSha256: digest,
          sourceBytesBase64: bytesBase64, sourceFormat: parsed.format, sourceCurrency: parsed.currency, rows: parsed.rows, mapping,
        });
      } catch (error) { duplicateImport = String(error?.message ?? error); }

      // Verrou de période : plus rien d'antérieur ne doit pouvoir être comptabilisé.
      await api.lockFiscalPeriod({ companyId: company.id, fiscalYearId: year.id, lockedTo: day(30) });
      const rejections = {};
      const attempt = async (name, run) => {
        try { rejections[name] = { blocked: false, value: String((await run())?.id ?? "ok") }; }
        catch (error) { rejections[name] = { blocked: true, message: String(error?.message ?? error) }; }
      };
      await attempt("entry", () => api.createEntry({
        companyId: company.id, journalId: company.journals.find((journal) => journal.code === "OD").id, date: day(5),
        label: "Écriture dans une période verrouillée", status: "POSTED",
        lines: [
          { accountId: account("611100").id, label: "Débit", debit: "50.00", credit: "0" },
          { accountId: account("441100").id, label: "Crédit", debit: "0", credit: "50.00" },
        ],
      }));
      await attempt("invoice", async () => {
        const draft = await api.createInvoiceDraft({
          companyId: company.id, counterpartyId: supplier.id, kind: "PURCHASE",
          invoiceNo: "FA-2026-0452", invoiceDate: day(12), currency: "MAD",
          taxConfigurationVersionId: taxConfig.id,
          lines: [{ description: "Après verrou", accountId: account("611100").id, ht: "100.00", vat: "20.00", vatRateBps: 2000, taxRateDefinitionId: rateId("TVA20D") }],
        });
        return api.postInvoice({ companyId: company.id, id: draft.id, expectedVersion: draft.version });
      });
      await attempt("payment", async () => {
        const draft = await api.createPaymentDraft({
          companyId: company.id, counterpartyId: supplier.id, kind: "DISBURSEMENT",
          paymentDate: day(8), method: "ESPECES", amount: "10.00", settlementAccountId: account("516100").id,
        });
        return api.postPayment({ companyId: company.id, id: draft.id, expectedVersion: draft.version });
      });
      // Les à-nouveaux se datent au premier jour de l'exercice : ils tombent
      // donc toujours à l'intérieur d'un verrou pris en cours d'exercice, et
      // doivent être refusés comme n'importe quelle autre comptabilisation.
      const priorEnd = new Date(`${year.startsOn.slice(0, 10)}T00:00:00.000Z`);
      priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
      const priorStart = new Date(priorEnd);
      priorStart.setUTCDate(priorStart.getUTCDate() - 364);
      const priorYear = await api.saveFiscalYear({
        companyId: company.id,
        label: `Exercice ${priorStart.getUTCFullYear()}`,
        startsOn: priorStart.toISOString().slice(0, 10),
        endsOn: priorEnd.toISOString().slice(0, 10),
      });
      await api.createEntry({
        companyId: company.id, journalId: company.journals.find((journal) => journal.code === "OD").id,
        date: priorEnd.toISOString().slice(0, 10), label: "Situation de clôture N-1", status: "POSTED",
        lines: [
          { accountId: account("514100").id, label: "Banque", debit: "5000.00", credit: "0" },
          { accountId: account("111100").id, label: "Capital", debit: "0", credit: "5000.00" },
        ],
      });
      await attempt("openingBalance", () => api.postOpeningBalance({
        companyId: company.id, fiscalYearId: year.id, sourceFiscalYearId: priorYear.id, confirmed: true,
      }));

      return {
        companyId: company.id,
        fiscalYearId: year.id,
        purchase: { id: purchase.id, journal: purchase.postedEntry?.journal?.code ?? null },
        sale: { id: sale.id, invoiceNo: sale.invoiceNo, journal: sale.postedEntry?.journal?.code ?? null },
        purchaseLines: (purchase.postedEntry?.lines ?? []).map((line) => [line.accountCodeSnapshot, line.debitCents, line.creditCents]),
        saleLines: (sale.postedEntry?.lines ?? []).map((line) => [line.accountCodeSnapshot, line.debitCents, line.creditCents]),
        disbursementLines: (disbursement.postedEntry?.lines ?? []).map((line) => [line.accountCodeSnapshot, line.debitCents, line.creditCents]),
        receiptLines: (receipt.postedEntry?.lines ?? []).map((line) => [line.accountCodeSnapshot, line.debitCents, line.creditCents]),
        balance: {
          balanced: balance.balanced,
          totalDebit: balance.totals.periodDebitCents,
          totalCredit: balance.totals.periodCreditCents,
          rows: Object.fromEntries(["611100", "612500", "712400", "342100", "441100", "445500", "345520", "514100"]
            .map((code) => {
              const row = balanceRow(code);
              return [code, row ? { debit: row.periodDebitCents, credit: row.periodCreditCents, cumulative: row.cumulativeBalanceCents } : null];
            })),
        },
        trial: { debit: trial.totals?.debitCents ?? null, credit: trial.totals?.creditCents ?? null },
        integrityErrors: (integrity.issues ?? []).filter((issue) => issue.severity === "ERROR").map((issue) => issue.code),
        credit: {
          journal: creditEntry.entry?.journal?.code ?? creditEntry.journal?.code ?? null,
          lines: ((creditEntry.entry ?? creditEntry).lines ?? []).map((line) => [line.accountCodeSnapshot ?? line.account?.code, line.debitCents, line.creditCents]),
          supplier: afterCreditRow("441100")?.cumulativeBalanceCents ?? null,
          supplies: afterCreditRow("612500")?.cumulativeBalanceCents ?? null,
          deductibleVat: afterCreditRow("345520")?.cumulativeBalanceCents ?? null,
          balanced: afterCredit.balanced,
        },
        reversal: {
          originalStatus: manualAfterReversal.entry?.status ?? manualAfterReversal.status ?? null,
          reversalOf: reversal.reversalOfId ?? null,
          rentExpense: afterReversalRow("614100")?.cumulativeBalanceCents ?? null,
          supplier: afterReversalRow("441100")?.cumulativeBalanceCents ?? null,
          balanced: afterReversal.balanced,
          totalDebit: afterReversal.totals.periodDebitCents,
        },
        purchaseSettlement: purchaseSettlement.settlementStatus,
        saleSettlement: saleSettlement.settlementStatus,
        rejections,
        bank: {
          parsedRows: parsed.rows?.length ?? null,
          reviewCanImport: statementReview.canImport ?? null,
          importedCount: (imported.movements ?? []).length,
          reconciled,
          rows: (bankTotal.rows ?? []).map((row) => [row.accountingCents, row.bankCents, row.differenceCents]),
          ledgerUnchanged: afterReconciliation.totals.periodDebitCents,
          duplicateImport,
          contradictedBalances,
        },
      };
    });
  } finally {
    await app.close();
  }

  // Facture d'achat : 611100 et 612500 au débit HT, 345520 la TVA récupérable,
  // 441100 le TTC au crédit.
  expect(result.purchaseLines).toEqual([
    ["611100", "900000", "0"],
    ["612500", "300000", "0"],
    ["345520", "240000", "0"],
    ["441100", "0", "1440000"],
  ]);
  expect(result.saleLines).toEqual([
    ["712400", "0", "2000000"],
    ["445500", "0", "400000"],
    ["342100", "2400000", "0"],
  ]);
  expect(result.purchase.journal).toBe("AC");
  expect(result.sale.journal).toBe("VE");

  expect(result.balance.balanced).toBe(true);
  expect(result.balance.totalDebit).toBe(result.balance.totalCredit);
  expect(result.balance.rows["611100"]).toMatchObject({ debit: "900000", credit: "0" });
  expect(result.balance.rows["612500"]).toMatchObject({ debit: "300000", credit: "0" });
  expect(result.balance.rows["712400"]).toMatchObject({ debit: "0", credit: "2000000" });
  expect(result.balance.rows["345520"]).toMatchObject({ debit: "240000", credit: "0" });
  expect(result.balance.rows["445500"]).toMatchObject({ debit: "0", credit: "400000" });
  // Client : 24 000 au débit puis 24 000 au crédit → solde nul.
  expect(result.balance.rows["342100"]).toMatchObject({ debit: "2400000", credit: "2400000", cumulative: "0" });
  // Fournisseur : 14 400 au crédit, 10 000 réglés → 4 400 restant dû.
  expect(result.balance.rows["441100"]).toMatchObject({ debit: "1000000", credit: "1440000", cumulative: "-440000" });
  // Banque : 24 000 encaissés, 10 000 décaissés.
  expect(result.balance.rows["514100"]).toMatchObject({ debit: "2400000", credit: "1000000", cumulative: "1400000" });

  expect(result.trial.debit).toBe(result.trial.credit);
  expect(result.integrityErrors).toEqual([]);

  // L'avoir fournisseur s'écrit à l'envers de la facture : 441100 au débit,
  // 612500 et 345520 au crédit, dans le journal des achats.
  expect(result.credit.journal).toBe("AC");
  expect(result.credit.balanced).toBe(true);
  expect(result.credit.lines).toEqual(expect.arrayContaining([
    ["612500", "0", "300000"],
    ["345520", "0", "60000"],
    ["441100", "360000", "0"],
  ]));
  // 612500 : 3 000 débit − 3 000 crédit = 0. TVA déductible : 2 400 − 600 = 1 800.
  expect(result.credit.supplies).toBe("0");
  expect(result.credit.deductibleVat).toBe("180000");
  // Fournisseur : −14 400 + 10 000 réglés + 3 600 d'avoir = −800.
  expect(result.credit.supplier).toBe("-80000");

  // Le relevé est lu, contrôlé, importé une seule fois, puis pointé.
  expect(result.bank.parsedRows).toBe(2);
  expect(result.bank.reviewCanImport).toBe(true);
  expect(result.bank.importedCount).toBe(2);
  expect(result.bank.reconciled.every((row) => row.matched)).toBe(true);
  // Un relevé dont les mouvements contredisent ses soldes est refusé avant
  // toute écriture, et il reste importable une fois les soldes corrigés.
  expect(result.bank.contradictedBalances).toMatch(/incohérent/i);
  // Banque et comptabilité disent le même solde : 24 000 − 10 000 = 14 000.
  expect(result.bank.rows).toEqual([["1400000", "1400000", "0"]]);
  // Un rapprochement pointe des écritures existantes ; il n'en écrit aucune.
  expect(result.bank.ledgerUnchanged).toBe(result.reversal.totalDebit);
  expect(result.bank.duplicateImport).toMatch(/already imported|déjà/i);

  // L'extourne neutralise sans effacer : l'écriture d'origine reste au grand
  // livre, marquée REVERSED, et les deux pièces s'annulent.
  expect(result.reversal.originalStatus).toBe("REVERSED");
  expect(result.reversal.balanced).toBe(true);
  expect(result.reversal.rentExpense).toBe("0");
  expect(result.reversal.supplier).toBe("-80000");
  expect(result.purchaseSettlement).toMatch(/^PARTIALLY_PAID/);
  expect(result.saleSettlement).toMatch(/^PAID/);

  // Le verrou de période refuse toute comptabilisation antérieure, quelle que
  // soit la porte empruntée — y compris les à-nouveaux.
  expect(result.rejections.entry.blocked).toBe(true);
  expect(result.rejections.invoice.blocked).toBe(true);
  expect(result.rejections.payment.blocked).toBe(true);
  expect(result.rejections.openingBalance.blocked).toBe(true);
  expect(result.rejections.openingBalance.message).toMatch(/verrouill/i);

  // Les données survivent à un redémarrage complet du poste.
  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    const persisted = await page.evaluate(async ({ companyId, fiscalYearId }) => {
      const api = window.wheat;
      const boot = await api.getBootstrap();
      const company = boot.companies.find((row) => row.id === companyId);
      const year = company.fiscalYears.find((row) => row.id === fiscalYearId);
      const balance = await api.getBalanceFamily({ companyId, view: "GENERAL", from: year.startsOn.slice(0, 10), to: year.endsOn.slice(0, 10) });
      const integrity = await api.getAccountingIntegrity({ companyId });
      const invoices = await api.listInvoices({ companyId, lifecycleStatus: "POSTED" });
      const rows = invoices.items ?? [];
      return {
        balanced: balance.balanced,
        totalDebit: balance.totals.periodDebitCents,
        supplierBalance: balance.rows.find((row) => row.code === "441100")?.cumulativeBalanceCents ?? null,
        postedNumbers: rows.map((row) => row.invoiceNo).sort(),
        integrityErrors: (integrity.issues ?? []).filter((issue) => issue.severity === "ERROR").length,
      };
    }, { companyId: result.companyId, fiscalYearId: result.fiscalYearId });
    expect(persisted.balanced).toBe(true);
    // Le dossier rouvert reproduit exactement l'état laissé après corrections.
    expect(persisted.totalDebit).toBe(result.reversal.totalDebit);
    expect(persisted.supplierBalance).toBe("-80000");
    // Facture d'achat, facture de vente et avoir lié : le brouillon refusé par
    // le verrou reste un brouillon et n'apparaît pas.
    expect(persisted.postedNumbers).toEqual(["AV-2026-0031", "FA-2026-0451", result.sale.invoiceNo].sort());
    expect(persisted.integrityErrors).toBe(0);
  } finally {
    await app.close();
  }
});
