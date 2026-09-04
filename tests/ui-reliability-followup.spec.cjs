const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile, chooseOption } = require("./wheat-ui-helpers.cjs");

test("follow-up UI reliability: forms, modal cleanup, stale loads, theme, and error recovery", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-ui-followup-"));
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
    await browserWindow.evaluate((win) => win.setSize(1120, 700));
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    // This spec writes companies, entries and documents. Fail loudly if it is
    // pointed at anything other than the profile it created for itself.
    await assertIsolatedProfile(page, tempDir);

    const fixture = await page.evaluate(async () => {
      const api = window.wheat;
      const company = await api.createCompany({
        name: `UI FOLLOW-UP ${Date.now()} SARL`,
        legalForm: "SARL",
        ice: "009888777666555",
        taxId: "IF 998877",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
      const boot = await api.getBootstrap(company.id);
      const loaded = boot.companies.find((item) => item.id === company.id);
      const journal = loaded.journals.find((item) => item.code === "OD") ?? loaded.journals[0];
      const debitAccount = loaded.accounts.find((item) => item.code === "342100") ?? loaded.accounts[0];
      const creditAccount = loaded.accounts.find((item) => item.code.startsWith("7")) ?? loaded.accounts[1];
      const pieceNumber = `UI${String(Date.now()).slice(-8)}`;
      const entry = await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-22T00:00:00.000Z",
        pieceNumber,
        label: "UI follow-up Sage entry",
        source: "UI_RELIABILITY_TEST",
        lines: [
          { accountId: debitAccount.id, label: "UI debit", debit: "10.00", credit: "0" },
          { accountId: creditAccount.id, label: "UI credit", debit: "0", credit: "10.00" },
        ],
      });
      await api.postEntry(entry.id);
      return { companyId: company.id, companyName: company.name };
    });

    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { value: fixture.companyId });
    await expect(page.locator('.company-switcher [role="combobox"]')).toContainText(fixture.companyName ?? "");

    // High-value controlled form: caret editing, validation correction, shortcut
    // isolation, theme changes, and save/reopen.
    await page.locator(".wt-rail").getByRole("button", { name: "Factures & paiements", exact: true }).click();
    await expect(page.locator(".op-shell")).toBeVisible({ timeout: 15000 });
    await page.getByRole("tab", { name: /Tiers/ }).click();
    await page.getByRole("button", { name: "Nouveau tiers" }).click();
    const displayName = page.getByLabel("Nom affiché");
    await displayName.fill("Client Alpa");
    await displayName.press("ArrowLeft");
    await displayName.press("h");
    await expect(displayName).toHaveValue("Client Alpha");
    await displayName.press("Control+K");
    await expect(page.locator(".wt-palette")).toHaveCount(0);
    await expect(displayName).toHaveValue("Client Alpha");

    await page.getByLabel("E-mail").fill("client@example.ma");
    await page.getByLabel("Ville").fill("Rabat");
    await page.getByRole("button", { name: /le mode sombre/ }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(displayName).toHaveValue("Client Alpha");
    const operationalColors = await page.locator(".op-shell").evaluate((element) => ({
      shellBackground: getComputedStyle(element).backgroundColor,
    }));
    const operationalInputColors = await displayName.evaluate((input) => ({
      inputBackground: getComputedStyle(input).backgroundColor,
      inputColor: getComputedStyle(input).color,
    }));
    expect(operationalColors.shellBackground).not.toBe("rgb(255, 255, 255)");
    expect(operationalInputColors.inputBackground).not.toBe("rgb(255, 255, 255)");
    expect(operationalInputColors.inputColor).not.toBe("rgb(24, 33, 52)");
    await page.getByRole("button", { name: "Créer le tiers" }).click();
    await expect(page.locator(".op-composer")).toHaveCount(0);
    await expect(page.locator(".op-table")).toContainText("Client Alpha");

    await page.getByRole("tab", { name: /Ventes/ }).click();
    await page.getByRole("button", { name: "Nouvelle facture" }).click();
    await expect(page.getByRole("tab", { name: /Achats/ })).toBeDisabled();
    await chooseOption(page, page.getByRole("combobox", { name: /Tiers/ }).first(), { label: "Client Alpha" });
    const invoiceLine = page.locator(".op-line-editor__row").first();
    await invoiceLine.getByLabel("Libellé").fill("Service UI fiable");
    await chooseOption(page, invoiceLine.getByRole("combobox", { name: "Compte de produit ou de charge" }), { index: 1 });
    const invoiceHt = invoiceLine.getByLabel(/HT \(MAD\)/);
    await invoiceHt.fill("1000.");
    await expect(invoiceHt).toHaveValue("1000.");
    await invoiceHt.pressSequentially("01");
    await expect(invoiceHt).toHaveValue("1000.01");
    await invoiceLine.getByLabel("Libellé").press("Delete");
    await expect(page.locator(".op-line-editor__row")).toHaveCount(1);
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.locator(".op-composer")).toHaveCount(0);
    const invoiceRow = page.locator(".op-table tbody tr").filter({ hasText: "Client Alpha" }).first();
    await expect(invoiceRow).toContainText("1 000,01 MAD");
    await invoiceRow.getByRole("button", { name: "Comptabiliser" }).click();
    const postDialog = page.getByRole("alertdialog", { name: "Comptabiliser cette facture ?" });
    await expect(postDialog).toBeVisible();
    await postDialog.getByRole("button", { name: "Comptabiliser" }).click();
    await expect(postDialog).toHaveCount(0);

    await page.getByRole("tab", { name: /Paiements/ }).click();
    await page.getByRole("button", { name: "Nouveau paiement" }).click();
    await chooseOption(page, page.getByRole("combobox", { name: /Tiers/ }).first(), { label: "Client Alpha" });
    const paymentAmount = page.getByLabel("Montant (MAD)");
    await paymentAmount.fill("1000,");
    await expect(paymentAmount).toHaveValue("1000,");
    await paymentAmount.pressSequentially("01");
    await page.getByLabel("Référence").fill("PAY-UI-001");
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    const allocationRow = page.locator(".op-allocation-editor__row");
    await chooseOption(page, allocationRow.getByRole("combobox", { name: "Facture à solder" }), { index: 0 });
    await expect(allocationRow.getByLabel("Montant imputé (MAD)")).toHaveValue("1000,01");
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.locator(".op-table")).toContainText("PAY-UI-001");

    await page.getByRole("tab", { name: /Tiers/ }).click();

    // The operational alert dialog must take focus, lock scroll, close with
    // Escape, fully clean up, and restore its exact trigger.
    const archiveButton = page.getByRole("button", { name: "Archiver Client Alpha" });
    await archiveButton.click();
    const confirmation = page.getByRole("alertdialog", { name: "Archiver ce tiers ?" });
    await expect(confirmation).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await expect.poll(() => confirmation.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await expect(archiveButton).toBeFocused();
    await expect(page.locator(".op-confirm-backdrop")).toHaveCount(0);

    // Enter is a normal submit path for the company dialog, and the dialog
    // must not require a mouse-only click.
    await page.getByRole("button", { name: "Nouveau dossier", exact: true }).click();
    const companyDialog = page.getByRole("dialog", { name: "Créer un dossier" });
    await expect(companyDialog).toBeVisible();
    const enterCompanyName = `ENTER SUBMIT ${Date.now()} SARL`;
    await companyDialog.locator("#company-name").fill(enterCompanyName);
    await companyDialog.locator("#company-name").press("Enter");

    // A dossier created with nothing but a name has no ICE and no declared VAT
    // rhythm, so the shared review says so before anything is written. It is a
    // warning, not a refusal: the person acknowledges it and continues.
    const reviewSurface = page.locator(".wt-review");
    await expect(reviewSurface).toBeVisible({ timeout: 15000 });
    await expect(reviewSurface).toContainText("ICE");
    await reviewSurface.locator(".wt-review__ack input").check();
    // A machine with a local model may add a model observation, and passing
    // one of those requires a written reason. Supply it when it is asked for.
    const override = reviewSurface.locator(".wt-review__override textarea");
    if (await override.count()) await override.fill("Identifiants légaux à compléter après réception du modèle J.");
    await reviewSurface.getByRole("button", { name: "Continuer" }).click();
    await expect(reviewSurface).toHaveCount(0, { timeout: 15000 });
    await expect(companyDialog).toHaveCount(0, { timeout: 15000 });
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { value: fixture.companyId });

    // Settings forms must remain normal editable forms and must not carry an
    // unfinished record into another company when the topbar scope changes.
    await page.locator(".wt-rail").getByRole("button", { name: "Rapports comptables", exact: true }).click();
    await page.getByRole("tab", { name: /Référentiels/ }).click();
    await page.getByRole("button", { name: "Comptes", exact: true }).click();
    const accountNumber = page.getByLabel("Numéro");
    await accountNumber.fill("912345");
    await expect(accountNumber).toHaveValue("912345");
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { label: enterCompanyName });
    // Changing dossier returns the workspace to its first tab, so the form has
    // to be reopened before its contents can be inspected at all. Asserting on
    // the field without reopening asserted on an element that is never present,
    // which passes for a guarantee without being one.
    await page.getByRole("tab", { name: /Référentiels/ }).click();
    await page.getByRole("button", { name: "Comptes", exact: true }).click();
    // The guarantee itself: an unfinished record does not follow the user into
    // another dossier.
    await expect(accountNumber).toHaveValue("");
    await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { value: fixture.companyId });
    await page.getByRole("tab", { name: /Référentiels/ }).click();
    await page.getByRole("button", { name: "Comptes", exact: true }).click();
    await accountNumber.fill("912345");
    await page.getByLabel("Libellé").fill("Compte UI fiable");
    await page.locator(".books13-settings-form").getByRole("button", { name: "Créer le compte" }).click();
    const accountArticle = page.locator(".books13-entity-list article").filter({ hasText: "912345" });
    await expect(accountArticle).toContainText("Compte UI fiable");
    await accountArticle.getByRole("button", { name: "Modifier" }).click();
    await page.getByLabel("Libellé").fill("Compte UI modifié");
    await page.locator(".books13-settings-form").getByRole("button", { name: "Enregistrer" }).click();
    await expect(accountArticle).toContainText("Compte UI modifié");
    const settingsSearch = page.locator(".books13-list-search input");
    await settingsSearch.fill("912345");
    await expect(page.locator(".books13-entity-list article")).toHaveCount(1);
    await settingsSearch.press("Control+A");
    await settingsSearch.press("Backspace");

    await page.getByRole("button", { name: "Journaux", exact: true }).click();
    await page.getByLabel("Code").fill("ux");
    await expect(page.getByLabel("Code")).toHaveValue("UX");
    await page.getByLabel("Libellé").fill("Journal UI");
    await page.locator(".books13-settings-form").getByRole("button", { name: "Créer le journal" }).click();
    await expect(page.locator(".books13-entity-list")).toContainText("UX · Journal UI");

    // A delayed persisted Sage profile must not replace mappings typed after
    // the request started.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("wheat:sage-profile:get");
      ipcMain.handle("wheat:sage-profile:get", async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return {
          profileType: "SAGE100_TXT",
          outputKind: "TXT",
          accountLength: "VARIABLE",
          encoding: "windows-1252",
          includeHeader: false,
          journalMappings: { OD: "OLD" },
          accountMappings: {},
        };
      });
    });
    await page.locator(".wt-rail").getByRole("button", { name: "Export Sage & FEC", exact: true }).click();
    const journalMapping = page.getByLabel("Journal OD vers code Sage");
    await journalMapping.fill("USR");
    await page.waitForTimeout(3200);
    await expect(journalMapping).toHaveValue("USR");

    // A recoverable IPC failure must preserve the user's typed note and
    // release the busy state so they can retry.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("wheat:audit-seal:create");
      ipcMain.handle("wheat:audit-seal:create", async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error("Injected recoverable seal failure");
      });
    });
    await page.locator(".wt-rail").getByRole("button", { name: "TVA", exact: true }).click();
    await page.getByRole("button", { name: /Intégrité/ }).click();
    const sealNote = page.getByPlaceholder("Ex. revue mensuelle interne");
    await sealNote.fill("Note à conserver après erreur");
    const createSeal = page.getByRole("button", { name: "Créer un point" });
    await createSeal.click();
    await expect(page.locator(".compliance14-message.is-error")).toContainText("Injected recoverable seal failure");
    await expect(sealNote).toHaveValue("Note à conserver après erreur");
    await expect(createSeal).toBeEnabled();

    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
