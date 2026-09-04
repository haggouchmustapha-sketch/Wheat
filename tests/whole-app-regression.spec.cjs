const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption } = require("./wheat-ui-helpers.cjs");

test("whole app shell stays usable across pages, language changes, and inputs", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-whole-app-"));
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
    await browserWindow.evaluate((win) => win.setSize(1280, 700));
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.locator(".app-shell, .onboarding-shell").first().waitFor({ timeout: 20000 });
    if (await page.locator(".onboarding-shell").count()) {
      await page.evaluate(async () => {
        await window.wheat.createCompany({
          name: "WHOLE APP TEST SARL",
          legalForm: "SARL",
          ice: "001222333444555",
          taxId: "IF 222333",
          city: "Casablanca",
          fiscalYearStart: "2026-01-01",
          fiscalYearEnd: "2026-12-31",
          vatFrequency: "MONTHLY",
        });
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    }
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    const fixture = await page.evaluate(async () => {
      const api = window.wheat;
      const companyId = (await api.createCompany({
        name: `WHOLE APP TEST ${Date.now()} SARL`,
        legalForm: "SARL",
        ice: "001222333444555",
        taxId: "IF 222333",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      })).id;
      const boot = await api.getBootstrap(companyId);
      const company = boot.companies.find((item) => item.id === companyId);
      const journal = company.journals.find((item) => item.code === "OD") ?? company.journals[0];
      const debitAccount = company.accounts.find((item) => item.code === "342100") ?? company.accounts[0];
      const creditAccount = company.accounts.find((item) => item.code.startsWith("7")) ?? company.accounts[1];
      if (!journal || !debitAccount || !creditAccount) throw new Error("Starter accounting references are missing");
      const pieceNumber = `SMK${String(Date.now()).slice(-8)}`;
      const entry = await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-22T00:00:00.000Z",
        pieceNumber,
        label: "Sage smoke",
        source: "WHOLE_APP_TEST",
        lines: [
          { accountId: debitAccount.id, label: "Sage debit", debit: 1000, credit: 0 },
          { accountId: creditAccount.id, label: "Sage credit", debit: 0, credit: 1000 },
        ],
      });
      await api.postEntry(entry.id);
      return { companyId, pieceNumber };
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { value: fixture.companyId });
    await expect(page.locator('.company-switcher [role="combobox"]')).toContainText(fixture.companyName ?? "");

    const visit = async (label, expectedText) => {
      await page.locator(".wt-rail").getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(".page")).toContainText(expectedText, { timeout: 15000 });
      await expect(page.locator(".page")).toBeVisible();
    };

    await visit("Accueil", "Le point de départ guidé");
    await visit("Production du jour", "La file de travail du jour");
    await visit("Tableau de bord", "Chiffre d'affaires");
    await expect(page.locator(".metric-card").first()).toContainText("1 000,00 MAD");
    await visit("Dossiers", "Créer, ouvrir et basculer");
    await visit("Écritures", "Saisir et comptabiliser les écritures");
    await visit("Documents & OCR", "Documents & OCR");
    await visit("Banque & rapprochement", "Importer les relevés bancaires");
    await visit("TVA", "Préparer, contrôler et archiver la déclaration");
    await visit("Paie", "Salariés, éléments de paie");
    await visit("Rapports comptables", "Éditer les rapports comptables");
    await visit("Export Sage & FEC", "Exporter les écritures vers Sage");
    await page.getByRole("button", { name: "Reprendre les codes Wheat" }).click();
    await expect(page.locator(".validation-list .ok")).toBeVisible();
    await expect(page.locator(".sage-preview")).toContainText(`;220526;${fixture.pieceNumber};`);
    let sagePreviewLines = (await page.locator(".sage-preview").textContent()).trim().split("\n");
    const smokeLine = sagePreviewLines.find((line) => line.includes(fixture.pieceNumber));
    expect(smokeLine).toBeTruthy();
    expect(smokeLine.split(";")).toHaveLength(10);
    expect(smokeLine.split(";").slice(0, 4)).toEqual(["OD", "220526", fixture.pieceNumber, "342100"]);
    expect(sagePreviewLines[0]).not.toContain("Code journal");

    await page.getByLabel(/Inclure une ligne d'en-tête/).check();
    await expect(page.locator(".sage-preview")).toContainText("Code journal;Date de pièce;N° pièce");
    await page.getByLabel(/Inclure une ligne d'en-tête/).uncheck();

    await chooseOption(page, page.getByRole("combobox", { name: "Type de fichier" }), { value: "PNM" });
    await expect(page.locator(".validation-list")).toContainText("Export PNM bloqué");
    await expect(page.getByRole("button", { name: /Exporter en \.PNM/ }).first()).toBeDisabled();
    await expect(page.locator(".sage-preview")).toContainText("Aucun aperçu PNM");
    await chooseOption(page, page.getByRole("combobox", { name: "Type de fichier" }), { value: "TXT" });
    await expect(page.locator(".validation-list .ok")).toBeVisible();

    const exportDir = path.join(tempDir, "sage-exports");
    fs.mkdirSync(exportDir, { recursive: true });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showSaveDialog = async (options) => {
        const cleanName = String(options.defaultPath ?? "atlas-export.dat").replace(/[\\/:*?"<>|]/g, "_");
        return { canceled: false, filePath: `${dir}\\${cleanName}` };
      };
    }, exportDir);
    await page.getByRole("button", { name: /Exporter en \.TXT/ }).first().click();
    await chooseOption(page, page.getByRole("combobox", { name: "Type de fichier" }), { value: "CSV" });
    await page.getByRole("button", { name: /Exporter en \.CSV/ }).first().click();
    await page.getByRole("button", { name: /Exporter en Excel/ }).first().click();
    await expect.poll(() => fs.readdirSync(exportDir).length).toBe(3);
    const sageExports = fs.readdirSync(exportDir).sort();
    expect(sageExports.map((file) => path.extname(file))).toEqual([".csv", ".txt", ".xlsx"]);
    const txtContent = fs.readFileSync(path.join(exportDir, sageExports.find((file) => file.endsWith(".txt"))), "latin1");
    const csvContent = fs.readFileSync(path.join(exportDir, sageExports.find((file) => file.endsWith(".csv"))), "latin1");
    expect(txtContent).toContain(`OD;220526;${fixture.pieceNumber};342100;;Sage debit;1000,00;0,00;;`);
    expect(csvContent).toContain(`OD;220526;${fixture.pieceNumber};342100;;Sage debit;1000,00;0,00;;`);
    expect(csvContent).not.toContain("Code journal;Date de pièce");
    await page.getByRole("button", { name: "Enregistrer ce profil pour le dossier" }).click();
    await expect(page.locator(".toast-stack")).toContainText("base locale et ses sauvegardes");
    await page.evaluate((companyId) => window.localStorage.removeItem(`atlas-ledger-sage-profile-${companyId}`), fixture.companyId);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { value: fixture.companyId });
    await page.locator(".wt-rail").getByRole("button", { name: "Export Sage & FEC", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Type de fichier" })).toContainText("CSV");
    await expect(page.getByLabel("Journal OD vers code Sage")).toHaveValue("OD");
    await visit("Réglages", "Profil, sécurité locale");

    await page.locator(".wt-rail").getByRole("button", { name: "Accueil", exact: true }).click();
    await page.locator(".user-card").click();
    await expect(page.locator(".page")).toContainText("Profil utilisateur");

    const newUserName = `M. Test Atlas ${Date.now()}`;
    await page.getByLabel("Nom affiché").fill(newUserName);
    await page.getByRole("button", { name: "Enregistrer le nom" }).click();
    await expect(page.locator(".user-card strong")).toHaveText(newUserName, { timeout: 15000 });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".user-card strong")).toHaveText(newUserName, { timeout: 15000 });

    await page.locator(".topbar-search input").click();
    await page.keyboard.type("maroc telecom");
    await expect(page.locator(".topbar-search input")).toHaveValue("maroc telecom");
    await page.keyboard.press("Control+N");
    await expect(page.locator(".entry-modal")).toHaveCount(0);
    expect(app.windows()).toHaveLength(1);
    await expect(page.locator(".topbar-search input")).toHaveValue("maroc telecom");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".topbar-search input")).toHaveValue("");

    await page.locator(".topbar-search input").evaluate((input) => input.blur());
    await page.keyboard.press("Control+N");
    await expect(page.getByRole("dialog", { name: "Nouvelle écriture" })).toBeVisible();
    await expect(page.getByPlaceholder("Référence de la pièce")).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.getByPlaceholder("Référence de la pièce").fill("UIDEC001");
    await page.getByPlaceholder("Ex : Facture client mars 2026").fill("Test saisie exacte");
    await page.getByPlaceholder("Détail de la ligne").nth(0).fill("Débit exact");
    await page.getByPlaceholder("Détail de la ligne").nth(1).fill("Crédit exact");
    const debitInput = page.getByLabel(/^Débit de la ligne/).nth(0);
    await debitInput.click();
    await page.keyboard.type("0.");
    await expect(debitInput).toHaveValue("0.");
    await page.keyboard.type("01");
    await expect(debitInput).toHaveValue("0.01");
    await page.getByLabel(/^Crédit de la ligne/).nth(1).fill("0,01");
    await expect(page.locator(".modal-total")).toContainText("Débit 0,01 MAD");
    await expect(page.locator(".modal-total")).toContainText("Équilibrée");
    await page.getByRole("button", { name: /Enregistrer le brouillon/ }).click();
    await expect(page.locator(".entry-modal")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");

    await page.locator(".wt-rail").getByRole("button", { name: "Paie", exact: true }).click();
    const addEmployeeButton = page.getByRole("button", { name: "Ajouter un salarié" }).first();
    await addEmployeeButton.click();
    await expect(page.getByRole("dialog", { name: "Ajouter un salarié" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Ajouter un salarié" })).toHaveCount(0);
    await expect(addEmployeeButton).toBeFocused();
    await addEmployeeButton.click();
    await page.getByLabel("Nom complet").fill("Salarié Exact");
    await page.getByLabel("CIN").fill("CIN-EXACT");
    await page.getByLabel("Numéro CNSS").fill("CNSS-EXACT");
    await page.getByLabel("Poste").fill("Testeur");
    const grossSalaryInput = page.getByLabel("Salaire brut");
    await grossSalaryInput.click();
    await page.keyboard.type("1000.");
    await expect(grossSalaryInput).toHaveValue("1000.");
    await page.keyboard.type("01");
    await page.getByLabel("Retenue CNSS").fill("0,01");
    await expect(page.locator(".modal-total")).toContainText("Net calculé 1 000,00 MAD");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.locator(".entry-modal")).toHaveCount(0);
    await expect(page.locator(".page")).toContainText("Salarié Exact");

    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    await chooseOption(page, page.locator("#settings-language"), { value: "en" });
    await expect(page.locator(".wt-rail").getByRole("button", { name: "Journal entries", exact: true })).toBeVisible();
    await page.locator(".wt-rail").getByRole("button", { name: "Journal entries", exact: true }).click();
    await expect(page.locator(".page")).toContainText("Accounting entries");

    await page.locator(".wt-rail").getByRole("button", { name: "Settings", exact: true }).click();
    await chooseOption(page, page.locator("#settings-language"), { value: "fr" });
    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    await expect(page.locator(".page")).toContainText("Écritures comptables");
    await expect(page.locator(".page")).not.toContainText("Accounting entries");

    await page.keyboard.press("Control+K");
    await expect(page.getByRole("dialog", { name: "Palette de commandes" })).toBeVisible();
    await page.locator(".wt-palette__search input").fill("paie");
    await expect(page.locator(".wt-palette__search input")).toHaveValue("paie");
    await page.keyboard.press("Escape");
    await expect(page.locator(".wt-palette")).toHaveCount(0);

    await page.evaluate(async () => {
      const api = window.wheat;
      let boot = await api.getBootstrap();
      let company = boot.companies.find((item) => item.id === boot.activeCompanyId) ?? boot.companies[0];
      if (!company) {
        company = await api.createCompany({
          name: "SCROLL TEST SARL",
          legalForm: "SARL",
          ice: "001111111111111",
          taxId: "IF 111111",
          city: "Casablanca",
        });
        boot = await api.getBootstrap(company.id);
        company = boot.companies.find((item) => item.id === company.id) ?? boot.companies[0];
      }
      const journal = company.journals.find((item) => item.code === "OD") ?? company.journals[0];
      const debitAccount = company.accounts.find((item) => item.code === "342100") ?? company.accounts[0];
      const creditAccount = company.accounts.find((item) => item.code.startsWith("7")) ?? company.accounts[1];

      for (let index = 0; index < 70; index += 1) {
        await api.createEntry({
          companyId: company.id,
          journalId: journal.id,
          date: "2026-05-22T00:00:00.000Z",
          pieceNumber: `SCROLL-${Date.now()}-${index}`,
          label: `Scroll regression entry ${index + 1}`,
          source: "WHOLE_APP_TEST",
          lines: [
            { accountId: debitAccount.id, label: "Scroll debit", debit: 100 + index, credit: 0 },
            { accountId: creditAccount.id, label: "Scroll credit", debit: 0, credit: 100 + index },
          ],
        });
      }
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await browserWindow.evaluate((win) => win.setSize(1280, 500));
    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    await expect(page.locator(".page")).toContainText("Écritures comptables", { timeout: 15000 });
    await expect(page.locator(".table-wrap")).toBeVisible({ timeout: 15000 });
    const scrollState = await page.evaluate(async () => {
      const scrollAreas = Array.from(document.querySelectorAll(".page, .table-wrap, .main-content"));
      for (const scrollArea of scrollAreas) {
        if (scrollArea.scrollHeight <= scrollArea.clientHeight + 1) continue;
        const before = scrollArea.scrollTop;
        scrollArea.scrollTop = scrollArea.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
          before,
          after: scrollArea.scrollTop,
          canScroll: true,
          className: scrollArea.className,
        };
      }
      return {
        before: 0,
        after: 0,
        canScroll: false,
        className: "none",
        metrics: scrollAreas.map((scrollArea) => ({
          className: scrollArea.className,
          scrollHeight: scrollArea.scrollHeight,
          clientHeight: scrollArea.clientHeight,
        })),
      };
    });
    expect(scrollState.canScroll, JSON.stringify(scrollState)).toBe(true);
    expect(scrollState.after).toBeGreaterThan(scrollState.before);

    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
