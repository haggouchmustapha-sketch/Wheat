const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The stock module as a user meets it.
 *
 * The domain tests prove the arithmetic and the database guarantees. This one
 * proves the part none of them can: that the module is reachable from Wheat's
 * navigation, that the stock card renders the columns the specification names,
 * and that the numbers on the screen are the ones the valuation engine
 * computed — the acceptance scenario, followed through the real interface of a
 * real Electron build.
 *
 * Runs against a throwaway profile directory. It never opens the developer
 * database or `%APPDATA%\Wheat`.
 */

/**
 * Wheat groups thousands with a narrow no-break space, which is not the space
 * this file can comfortably contain; the expectation is written with an
 * ordinary space and converted here.
 */
const grouped = (value) => value.replace(/ /g, String.fromCharCode(0x202f));

test("the stock card shows the acceptance scenario in the specified columns", async () => {
  test.setTimeout(150000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-stock-ui-"));
  const rendererErrors = [];

  const app = await electron.launch({
    executablePath: electronExe,
    args: packagedExe ? [] : [cwd],
    cwd,
    env: {
      ...process.env,
      APPDATA: path.join(tempDir, "appData"),
      LOCALAPPDATA: path.join(tempDir, "localAppData"),
      WHEAT_USER_DATA_DIR: path.join(tempDir, "userData"),
    },
  });

  try {
    const page = await app.firstWindow();
    const browserWindow = await app.browserWindow(page);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });

    await page.waitForLoadState("domcontentloaded");
    await browserWindow.evaluate((win) => win.setSize(1366, 800));
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    await page.locator(".app-shell, .onboarding-shell").first().waitFor({ timeout: 25000 });

    if (await page.locator(".onboarding-shell").count()) {
      // Named exactly "TEST", which is Wheat's documented way of saying "this
      // is somebody trying the application out". A freshly created client
      // dossier sits behind the setup gate, and the gate — correctly — hides
      // Stock along with every other workspace until the foundation is
      // approved; this test is about the stock card, not about that gate.
      await page.evaluate(async () => {
        await window.wheat.createCompany({
          name: "TEST",
          legalForm: "SARL",
          ice: "001999888777666",
          taxId: "IF 999888",
          city: "Casablanca",
          fiscalYearStart: "2026-01-01",
          fiscalYearEnd: "2026-12-31",
          vatFrequency: "MONTHLY",
        });
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    }
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });

    /*
     * The acceptance scenario, entered through the same bridge the interface
     * uses: opening 10 × 100, a second entry of 10 × 120, then an issue of 5.
     * Expected after those three: 15 units, 1 650,00 of value, CMP 110.
     *
     * The second entry is a production receipt rather than a purchase, which
     * also pins down the column rule: it increases stock without being an
     * "Achat", so the Achats column stays empty and the movement appears under
     * its own label instead.
     */
    const prepared = await page.evaluate(async () => {
      const bootstrap = await window.wheat.getBootstrap();
      // The chart and the journals are carried on the active dossier, not at
      // the top of the payload: bootstrap only hydrates the one being worked on.
      const companyId = bootstrap.activeCompanyId ?? bootstrap.companies?.[0]?.id;
      const company = bootstrap.companies.find((candidate) => candidate.id === companyId);

      const accounts = company?.accounts ?? [];
      const stockAccount = accounts.find((account) => account.code === "3111");
      const variationAccount = accounts.find((account) => account.code === "6114");
      const journal = (company?.journals ?? [])[0];
      if (!stockAccount || !variationAccount || !journal) {
        return { error: `missing setup: stock=${Boolean(stockAccount)} variation=${Boolean(variationAccount)} journal=${Boolean(journal)}` };
      }

      await window.wheat.saveStockSettings({ companyId, stockJournalId: journal.id, allowNegativeStock: false });
      await window.wheat.saveStockAccountMapping({
        companyId, scope: "COMPANY",
        stockAccountId: stockAccount.id, variationAccountId: variationAccount.id,
      });

      const unit = await window.wheat.saveStockUnit({ companyId, code: "UN", label: "Unité" });
      const warehouse = await window.wheat.saveStockWarehouse({ companyId, code: "PRIN", name: "DEPOT PRINCIPAL" });
      const article = await window.wheat.saveStockArticle({
        companyId, sku: "ART-001", designation: "Produit Test", unitId: unit.id, valuationMethod: "CMP",
      });

      const validate = async (payload) => {
        const document = await window.wheat.saveStockDocument({ companyId, warehouseId: warehouse.id, ...payload });
        return window.wheat.validateStockDocument({ companyId, documentId: document.id });
      };

      await validate({
        type: "OPENING_STOCK", documentDate: "2026-01-01",
        lines: [{ articleId: article.id, quantity: "10", unitValue: "100" }],
      });
      await validate({
        type: "PRODUCTION_RECEIPT", documentDate: "2026-01-05",
        lines: [{ articleId: article.id, quantity: "10", unitValue: "120" }],
      });
      const issue = await validate({
        type: "INTERNAL_CONSUMPTION", documentDate: "2026-01-10",
        lines: [{ articleId: article.id, quantity: "5" }],
      });

      return { companyId, articleId: article.id, issueEntryId: issue.accountingEntryId };
    });

    expect(prepared.error, prepared.error ?? "").toBeUndefined();
    expect(prepared.issueEntryId).toBeTruthy();

    // Stock has its own entry in the navigation rail, like every other feature.
    await page.locator(".wt-rail").getByRole("button", { name: "Stock", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Fiche de stock/ })).toBeVisible({ timeout: 20000 });

    // The columns the specification names, in the order it names them.
    const headers = page.locator(".stock-table thead th");
    await expect(headers).toHaveCount(8);
    await expect(headers.nth(0)).toHaveText("Date");
    await expect(headers.nth(1)).toHaveText("Désignation");
    await expect(headers.nth(2)).toHaveText("Stock init (1er achat)");
    await expect(headers.nth(3)).toHaveText("Achats");
    await expect(headers.nth(4)).toHaveText("Ventes");
    await expect(headers.nth(6)).toHaveText("Stock en quant");
    await expect(headers.nth(7)).toHaveText("Stock en valeur");

    const rows = page.locator(".stock-table tbody tr");
    await expect(rows).toHaveCount(3);

    // Opening lands in "Stock init", and the running position after it is 10.
    await expect(rows.nth(0).locator("td").nth(1)).toContainText("Stock initial");
    await expect(rows.nth(0).locator("td").nth(2)).toHaveText("10");
    await expect(rows.nth(0).locator("td").nth(6)).toHaveText("10");
    await expect(rows.nth(0).locator("td").nth(7)).toHaveText(grouped("1 000,00"));

    // A production receipt is an entry, not a purchase: it does not claim the
    // Achats column it did not earn.
    await expect(rows.nth(1).locator("td").nth(1)).toContainText("Production");
    await expect(rows.nth(1).locator("td").nth(3)).toHaveText("");
    await expect(rows.nth(1).locator("td").nth(5)).toHaveText("+10");
    await expect(rows.nth(1).locator("td").nth(6)).toHaveText("20");
    await expect(rows.nth(1).locator("td").nth(7)).toHaveText(grouped("2 200,00"));

    // And the issue leaves exactly the specification's figures behind.
    await expect(rows.nth(2).locator("td").nth(6)).toHaveText("15");
    await expect(rows.nth(2).locator("td").nth(7)).toHaveText(grouped("1 650,00"));

    // The header restates the current position and the derived CMP.
    const identity = page.locator(".stock-card__identity");
    await expect(identity).toContainText("Produit Test");
    await expect(identity).toContainText("ART-001");
    await expect(identity).toContainText("CMP");

    // Opening a row explains where its value came from.
    await rows.nth(2).click();
    const detail = page.locator(".stock-detail");
    await expect(detail).toBeVisible({ timeout: 10000 });
    await expect(detail).toContainText("Quantité avant");
    await expect(detail).toContainText("Valeur après");
    await expect(detail.getByRole("button", { name: /Ouvrir l'écriture/ })).toBeVisible();
    await expect(detail.getByRole("button", { name: /DRAFT/ })).toBeVisible();

    // The état du stock agrees with the card.
    await page.getByRole("tab", { name: /État du stock/ }).click();
    await expect(page.locator(".stock-table tfoot")).toContainText(grouped("1 650,00"));

    // And the movements list offers the correction path rather than an edit.
    await page.getByRole("tab", { name: /Mouvements/ }).click();
    await expect(page.getByRole("button", { name: "Contrepasser" }).first()).toBeVisible();

    // The workflows added after the core are reachable from the same workspace
    // and render against the same dossier — not a second interface beside it.
    await page.getByRole("tab", { name: /Inventaire physique/ }).click();
    await expect(page.getByRole("button", { name: "Nouvelle campagne" })).toBeVisible();

    await page.getByRole("tab", { name: /Dépréciations/ }).click();
    await expect(page.getByRole("button", { name: /Constater une dépréciation/ })).toBeVisible();

    await page.getByRole("tab", { name: /Imports/ }).click();
    await expect(page.getByRole("button", { name: "Prévisualiser" })).toBeVisible();

    // The valuation report reaches the same position the card just showed.
    await page.getByRole("tab", { name: /Rapports/ }).click();
    await expect(page.locator(".stock-table tfoot")).toContainText(grouped("1 650,00"));

    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
