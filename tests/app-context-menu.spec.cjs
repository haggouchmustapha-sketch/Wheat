const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile, openDossierForWork } = require("./wheat-ui-helpers.cjs");

test("context actions delete drafts while bank exclusions preserve history", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-context-menu-"));
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
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    // This spec writes companies, entries and documents. Fail loudly if it is
    // pointed at anything other than the profile it created for itself.
    await assertIsolatedProfile(page, tempDir);
    await page.getByText("Wheat", { exact: true }).first().waitFor({ timeout: 15000 });

    const fixture = await page.evaluate(async () => {
      const api = window.wheat;
      let boot = await api.getBootstrap();
      let company = boot.companies.find((item) => item.id === boot.activeCompanyId) ?? boot.companies[0];
      if (!company) {
        company = await api.createCompany({
          name: "CONTEXT BASE SARL",
          legalForm: "SARL",
          ice: "001000000000001",
          taxId: "IF 100001",
          city: "Casablanca",
          fiscalYearStart: "2026-01-01",
          fiscalYearEnd: "2026-12-31",
        });
        boot = await api.getBootstrap(company.id);
        company = boot.companies.find((item) => item.id === company.id) ?? boot.companies[0];
      }
      const journal = company.journals.find((item) => item.code === "OD") ?? company.journals[0];
      const debitAccount = company.accounts.find((item) => item.code === "342100") ?? company.accounts[0];
      const creditAccount = company.accounts.find((item) => item.code.startsWith("7")) ?? company.accounts[1];
      const pieceNumber = `CTX-ENTRY-${Date.now()}`;
      const bankRef = `CTX-BANK-${Date.now()}`;
      const companyName = `CTX COMPANY ${Date.now()}`;
      const bankAccount = boot.bankAccounts[0];
      const employee = boot.employees[0];

      await api.createEntry({
        companyId: company.id,
        journalId: journal.id,
        date: "2026-05-21T00:00:00.000Z",
        pieceNumber,
        label: "Context menu deletion entry",
        source: "CONTEXT_MENU_TEST",
        lines: [
          { accountId: debitAccount.id, label: "Context debit", debit: 1111, credit: 0 },
          { accountId: creditAccount.id, label: "Context credit", debit: 0, credit: 1111 },
        ],
      });

      const statementText = `Date;Libelle;Montant;Reference\n2026-05-21;Context menu bank movement;777.00;${bankRef}\n`;
      const statementBytes = new TextEncoder().encode(statementText);
      const statementHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", statementBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await api.importBankStatement({
        bankAccountId: bankAccount.id,
        sourceName: `${bankRef}.csv`,
        sourceSha256: statementHash,
        sourceBytesBase64: btoa(statementText),
        rows: [{ Date: "2026-05-21", Libelle: "Context menu bank movement", Montant: "777.00", Reference: bankRef }],
        mapping: { date: "Date", label: "Libelle", amount: "Montant", reference: "Reference" },
      });

      await api.createCompany({
        name: companyName,
        legalForm: "SARL",
        ice: "009999999999999",
        taxId: "IF 999999",
        city: "Casablanca",
      });

      return {
        companyId: company.id,
        pieceNumber,
        bankRef,
        companyName,
        employeeName: employee?.fullName ?? null,
      };
    });

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByText("Wheat", { exact: true }).first().waitFor({ timeout: 15000 });
    // The fixture also creates a second, empty dossier, which stays in guided
    // preparation. The one this test works in is the one holding its records.
    await openDossierForWork(page, { companyId: fixture.companyId });
    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    const entryRow = page.locator("tbody tr").filter({ hasText: fixture.pieceNumber });
    await expect(entryRow).toHaveCount(1);
    await entryRow.click({ button: "right" });
    await expect(page.locator(".context-menu")).toContainText("Supprimer le brouillon");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".context-menu button").filter({ hasText: "Supprimer le brouillon" }).click();
    await expect(entryRow).toHaveCount(0, { timeout: 15000 });

    await page.locator(".wt-rail").getByRole("button", { name: "Banque & rapprochement", exact: true }).click();
    const movementRow = page.locator(".op-recon-table tbody tr").filter({ hasText: fixture.bankRef });
    await expect(movementRow).toHaveCount(1);
    await movementRow.click();
    await expect(page.locator(".op-inspector")).toContainText("Mouvement sélectionné");
    await expect(page.locator(".op-inspector")).toContainText("Examiner l’exclusion");
    await page.locator(".op-inspector").getByRole("button", { name: "Examiner l’exclusion" }).click();
    await page.locator(".op-inspector").getByLabel("Motif d’exclusion").fill("Mouvement de test conservé dans l'historique");
    await page.locator(".op-inspector").getByRole("button", { name: "Confirmer" }).click();
    await expect(page.locator(".op-inspector")).toContainText("Mouvement exclu", { timeout: 15000 });

    if (fixture.employeeName) {
      await page.locator(".wt-rail").getByRole("button", { name: "Paie", exact: true }).click();
      const employeeRow = page.locator("tbody tr").filter({ hasText: fixture.employeeName });
      await expect(employeeRow).toHaveCount(1);
      await employeeRow.click({ button: "right" });
      await expect(page.locator(".context-menu")).toContainText("Supprimer le salarié");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator(".context-menu button").filter({ hasText: "Supprimer le salarié" }).click();
      await expect(employeeRow).toHaveCount(0, { timeout: 15000 });
    }

    await page.locator(".wt-rail").getByRole("button", { name: "Dossiers", exact: true }).click();
    const companyCard = page.locator(".company-card").filter({ hasText: fixture.companyName });
    await expect(companyCard).toHaveCount(1);
    await companyCard.click({ button: "right" });
    await expect(page.locator(".context-menu")).toContainText("Supprimer le dossier");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".context-menu button").filter({ hasText: "Supprimer le dossier" }).click();
    await expect(companyCard).toHaveCount(0, { timeout: 15000 });

    await page.locator(".wt-rail").getByRole("button", { name: "Rapports comptables", exact: true }).click();
    await expect(page.locator(".books13-shell")).toBeVisible();
    await expect(page.locator(".books13-shell")).toContainText("Rapports");
    await expect(page.locator(".report-card")).toHaveCount(0);

    const remaining = await page.evaluate(async ({ pieceNumber, bankRef, companyName, employeeName }) => {
      const boot = await window.wheat.getBootstrap();
      return {
        entryExists: boot.entries.some((entry) => entry.pieceNumber === pieceNumber),
        movementExists: boot.bankAccounts.flatMap((account) => account.movements).some((movement) => movement.reference === bankRef),
        movementStatus: boot.bankAccounts.flatMap((account) => account.movements).find((movement) => movement.reference === bankRef)?.status ?? null,
        companyExists: boot.companies.some((company) => company.name === companyName),
        employeeExists: employeeName ? boot.employees.some((employee) => employee.fullName === employeeName) : false,
      };
    }, fixture);

    expect(remaining.entryExists).toBe(false);
    expect(remaining.movementExists).toBe(true);
    expect(remaining.movementStatus).toBe("EXCLUDED");
    expect(remaining.companyExists).toBe(false);
    if (fixture.employeeName) expect(remaining.employeeExists).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
