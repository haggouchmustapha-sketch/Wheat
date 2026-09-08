const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption, openDossierForWork } = require("./wheat-ui-helpers.cjs");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = process.env.WHEAT_EXE ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");

async function launch(userDataDir) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: process.env.WHEAT_EXE ? [`--user-data-dir=${userDataDir}`] : [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
  return { app, page };
}

async function createFirstCompany(page, name) {
  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
  await page.getByLabel("Nom de la société").fill(name);
  await page.getByLabel("Ville").fill("Casablanca");
  await page.getByRole("textbox", { name: "ICE", exact: true }).fill("001111222233334");
  await page.getByRole("textbox", { name: "Identifiant fiscal", exact: true }).fill("IF-2026-ATLAS");
  await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
}

async function createCounterparty(page, kind, displayName, ice) {
  await page.getByRole("tab", { name: /Tiers/ }).click();
  await page.getByRole("button", { name: "Nouveau tiers" }).click();
  const form = page.locator(".op-composer");
  await expect(form).toContainText("Nouveau tiers");
  await form.getByLabel("Type").selectOption(kind);
  await form.getByLabel("Nom affiché").fill(displayName);
  await form.getByLabel(/Raison sociale/).fill(displayName);
  await form.getByLabel("ICE", { exact: true }).fill(ice);
  await form.getByLabel("Identifiant fiscal").fill(`IF-${ice.slice(-6)}`);
  await form.getByLabel("Ville").fill("Casablanca");
  await form.getByLabel("Délai de paiement").fill("30");
  await form.getByRole("button", { name: "Créer le tiers" }).click();
  await expect(page.locator(".op-table tbody tr").filter({ hasText: displayName })).toBeVisible({ timeout: 15000 });
}

async function chooseAccount(page, form, ariaLabel, code) {
  await chooseOption(page, form.getByRole("combobox", { name: ariaLabel }), { label: code });
}

async function createAndPostInvoice(page, { tab, counterparty, invoiceNo, accountCode, description, ht }) {
  await page.getByRole("tab", { name: new RegExp(tab) }).click();
  await page.getByRole("button", { name: "Nouvelle facture" }).click();
  const form = page.locator(".op-composer form");
  await chooseOption(page, form.getByRole("combobox", { name: /Tiers/ }), { label: counterparty });
  const invoiceNumber = form.locator('label:has-text("N° de facture") input');
  await invoiceNumber.fill(invoiceNo);
  await form.getByLabel("Date", { exact: true }).fill("2026-08-20");
  await form.getByLabel("Échéance").fill("2026-09-19");
  await form.getByPlaceholder("Produit ou service facturé").fill(description);
  await chooseAccount(page, form, "Compte de produit ou de charge", accountCode);
  await form.getByLabel("HT (MAD)").fill(ht);
  await form.getByLabel("TVA (MAD)").fill("0,00");
  await expect(form.locator(".op-form-total")).toContainText(`${Number(ht).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD`);
  await form.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  const row = page.locator(".op-table tbody tr").filter({ hasText: invoiceNo });
  await expect(row).toContainText("Brouillon", { timeout: 15000 });

  // Reopen and save once to exercise real draft persistence/edit propagation.
  await row.getByRole("button", { name: new RegExp(`Modifier la facture ${invoiceNo}`) }).click();
  await expect(page.locator(".op-composer")).toContainText("Modifier facture");
  await page.locator(".op-composer").getByPlaceholder("Produit ou service facturé").fill(`${description} contrôlé`);
  await page.locator(".op-composer").getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(row).toContainText(invoiceNo, { timeout: 15000 });

  await row.getByRole("button", { name: /Comptabiliser/ }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Comptabiliser cette facture");
  await confirmation.getByRole("button", { name: "Comptabiliser", exact: true }).click();
  await page.waitForTimeout(600);
  if ((await row.textContent()).includes("Brouillon")) {
    throw new Error(`La facture ${invoiceNo} est restée en brouillon après confirmation: ${await page.locator(".op-notice").textContent().catch(() => "aucun message")}`);
  }
  await expect(row).toContainText("Non réglée", { timeout: 15000 });
}

test("a Moroccan accountant workflow remains consistent across subledgers, books, dashboard, and restart", async () => {
  test.setTimeout(150000);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-accountant-2-"));
  const userDataDir = path.join(tempRoot, "userData");
  let app;
  try {
    let launched = await launch(userDataDir);
    app = launched.app;
    let page = launched.page;
    const rendererErrors = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await createFirstCompany(page, "Atlas Test SARL");
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".wt-rail").getByRole("button", { name: "Factures & paiements", exact: true }).click();
    await expect(page.getByRole("region", { name: "Factures et paiements" })).toBeVisible({ timeout: 15000 });
    await createCounterparty(page, "CUSTOMER", "CLIENT MAROC SERVICES", "001000000000111");
    await createCounterparty(page, "SUPPLIER", "FOURNITURES ATLAS SARL", "001000000000222");

    await createAndPostInvoice(page, {
      tab: "Ventes",
      counterparty: "CLIENT MAROC SERVICES",
      invoiceNo: "FV-2026-001",
      accountCode: "711100",
      description: "Prestations Atlas",
      ht: "1000.00",
    });
    await createAndPostInvoice(page, {
      tab: "Achats",
      counterparty: "FOURNITURES ATLAS SARL",
      invoiceNo: "FA-2026-001",
      accountCode: "611100",
      description: "Fournitures de bureau",
      ht: "300.00",
    });

    // Record, allocate and post a real customer receipt.
    await page.getByRole("tab", { name: /Paiements/ }).click();
    await page.getByRole("button", { name: "Nouveau paiement" }).click();
    let form = page.locator(".op-composer form");
    await form.getByLabel("Sens").selectOption("RECEIPT");
    await chooseOption(page, form.getByRole("combobox", { name: /Tiers/ }), { label: "CLIENT MAROC SERVICES" });
    await form.getByLabel("Date", { exact: true }).fill("2026-08-20");
    await form.getByLabel("Montant (MAD)").fill("1000,00");
    await form.getByLabel("Référence").fill("VIR-CLIENT-001");
    await chooseOption(page, form.getByRole("combobox", { name: "Compte bancaire du règlement" }), { index: 0 });
    await form.getByRole("button", { name: "Ajouter" }).click();
    await chooseOption(page, form.getByRole("combobox", { name: "Facture à solder" }), { label: "FV-2026-001" });
    await form.getByLabel("Montant imputé (MAD)").fill("1000.00");
    await form.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    const paymentRow = page.locator(".op-table tbody tr").filter({ hasText: "VIR-CLIENT-001" });
    await expect(paymentRow).toContainText("Brouillon", { timeout: 15000 });
    await paymentRow.getByRole("button", { name: /Comptabiliser/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Comptabiliser", exact: true }).click();
    await expect(paymentRow).toContainText("Comptabilisé", { timeout: 15000 });

    // The sales invoice must now be settled in the same UI.
    await page.getByRole("tab", { name: /Ventes/ }).click();
    await expect(page.locator(".op-table tbody tr").filter({ hasText: "FV-2026-001" })).toContainText("Réglée", { timeout: 15000 });

    // Cross-check exact ledger/trial-balance/report state produced solely by
    // the UI actions above. No database rows are injected by the test.
    const snapshot = await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      const company = boot.companies.find((item) => item.id === boot.activeCompanyId) ?? boot.companies[0];
      const [sales, purchases, payments, counterparties, trial] = await Promise.all([
        window.wheat.listInvoices({ companyId: company.id, kind: "SALE", limit: 50 }),
        window.wheat.listInvoices({ companyId: company.id, kind: "PURCHASE", limit: 50 }),
        window.wheat.listPayments({ companyId: company.id, limit: 50 }),
        window.wheat.listCounterparties({ companyId: company.id, includeArchived: true, limit: 50 }),
        window.wheat.getTrialBalance({ companyId: company.id, from: "2026-01-01", to: "2026-12-31", includeZero: false }),
      ]);
      const items = (value) => Array.isArray(value) ? value : value.items;
      return {
        companyId: company.id,
        sales: items(sales).map((item) => ({ no: item.invoiceNo, status: item.lifecycleStatus, balance: item.settlement.balanceCents })),
        purchases: items(purchases).map((item) => ({ no: item.invoiceNo, status: item.lifecycleStatus, balance: item.settlement.balanceCents })),
        paymentCount: items(payments).length,
        counterpartyCount: items(counterparties).length,
        trialDebit: trial.totals.periodDebitCents,
        trialCredit: trial.totals.periodCreditCents,
        trialBalanced: trial.balanced,
        dashboardRevenue: boot.dashboardMetrics.revenueCents,
        dashboardExpense: boot.dashboardMetrics.expensesCents,
      };
    });
    expect(snapshot.sales).toEqual([{ no: "FV-2026-001", status: "POSTED", balance: "0" }]);
    expect(snapshot.purchases).toEqual([{ no: "FA-2026-001", status: "POSTED", balance: "30000" }]);
    expect(snapshot).toMatchObject({ paymentCount: 1, counterpartyCount: 2, trialBalanced: true, dashboardRevenue: "100000", dashboardExpense: "30000" });
    // 1000 MAD sale + 300 MAD purchase + 1000 MAD receipt, on each side.
    expect(snapshot.trialDebit).toBe("230000");
    expect(snapshot.trialCredit).toBe("230000");

    await page.locator(".wt-rail").getByRole("button", { name: "Rapports comptables", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Rapports/ })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /Balance/ }).first().click();
    await page.getByRole("button", { name: "Produire l’état" }).click();
    await expect(page.locator(".books13-result-foot")).toContainText("Balance équilibrée", { timeout: 15000 });

    await page.locator(".wt-rail").getByRole("button", { name: "Tableau de bord", exact: true }).click();
    await expect(page.locator(".page")).toContainText("1 000,00 MAD", { timeout: 15000 });

    await app.close();
    app = null;
    launched = await launch(userDataDir);
    app = launched.app;
    page = launched.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Factures & paiements", exact: true }).click();
    await expect(page.locator(".op-table tbody tr").filter({ hasText: "FV-2026-001" })).toContainText("Réglée", { timeout: 15000 });
    await page.getByRole("tab", { name: /Tiers/ }).click();
    await expect(page.locator(".op-table")).toContainText("CLIENT MAROC SERVICES");
    await expect(page.locator(".op-table")).toContainText("FOURNITURES ATLAS SARL");
    expect(rendererErrors).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
