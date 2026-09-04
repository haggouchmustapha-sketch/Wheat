const { test, expect, _electron: electron } = require("@playwright/test");
const { chooseOption, openDossierForWork } = require("./wheat-ui-helpers.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { jsPDF } = require("jspdf");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = process.env.WHEAT_EXE ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");

function writeText(root, name, value, encoding = "utf8") {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, value, encoding);
  return filePath;
}

async function makeFixtures(root) {
  const fixtures = {};
  fixtures.csv = writeText(root, "atlas-bank-csv.csv", [
    "Date opération;Libellé;Référence;Débit;Crédit;Devise",
    "20/08/2026;Virement Client Test;REF-CSV;;100,00;MAD",
  ].join("\r\n"));
  fixtures.semicolon = writeText(root, "atlas-bank-semicolon.txt", "Date;Description;Reference;Amount;Currency\n21/08/2026;Frais TXT;REF-TXT-SEMI;-11,25;MAD\n");
  fixtures.tab = writeText(root, "atlas-bank-tab.txt", "Date\tDescription\tReference\tAmount\tCurrency\n2026-08-22\tEncaissement TAB\tREF-TXT-TAB\t12.50\tMAD\n");
  fixtures.bad = writeText(root, "atlas-bank-bad.csv", "Date;Description;Reference;Amount\n32/08/2026;Date impossible;REF-BAD;10,00\n");
  fixtures.ofx = writeText(root, "atlas-bank.ofx", "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX><STMTRS><CURDEF>MAD<BANKTRANLIST><STMTTRN><DTPOSTED>20260824000000<TRNAMT>14.00<FITID>OFX-001<CHECKNUM>REF-OFX<NAME>Encaissement OFX</STMTTRN></BANKTRANLIST></STMTRS></OFX>");
  fixtures.qif = writeText(root, "atlas-bank.qif", "!Type:Bank\nD25/08/2026\nT-15.00\nPFrais QIF\nNREF-QIF\n^\n");
  fixtures.mt940 = writeText(root, "atlas-bank.sta", ":20:ATLAS-RUNTIME\n:25:MA000TEST\n:60F:C260825MAD1000,00\n:61:2608260826C16,00NTRFREF-MT940\n:86:Encaissement MT940\n:62F:C260826MAD1016,00\n");
  fixtures.camt = writeText(root, "atlas-bank.xml", "<?xml version=\"1.0\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Ntry><Amt Ccy=\"MAD\">17.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-27</Dt></BookgDt><AcctSvcrRef>REF-CAMT</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>Frais CAMT</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>");
  fixtures.xls = path.join(root, "legacy-bank.xls");
  fs.writeFileSync(fixtures.xls, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]));

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Relevé").addRows([
    ["Date", "Description", "Reference", "Amount", "Currency"],
    ["2026-08-23", "Frais XLSX", "REF-XLSX", "-13.00", "MAD"],
  ]);
  fixtures.xlsx = path.join(root, "atlas-bank.xlsx");
  await workbook.xlsx.writeFile(fixtures.xlsx);

  const pdf = new jsPDF();
  pdf.setFont("courier", "normal");
  pdf.setFontSize(10);
  [
    "ATLAS TEST SARL - RELEVE PDF TEXTE",
    "Date | Description | Reference | Amount | Currency",
    "2026-08-28 | Encaissement PDF | REF-PDF | 18.00 | MAD",
  ].forEach((line, index) => pdf.text(line, 15, 20 + index * 8));
  fixtures.pdf = path.join(root, "atlas-bank.pdf");
  fs.writeFileSync(fixtures.pdf, Buffer.from(pdf.output("arraybuffer")));
  fixtures.renamedCsv = path.join(root, "copie-renommee.csv");
  fs.copyFileSync(fixtures.csv, fixtures.renamedCsv);
  return fixtures;
}

async function launchApp(userDataDir, runtimeErrors) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: process.env.WHEAT_EXE ? [`--user-data-dir=${userDataDir}`] : [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: userDataDir },
  });
  app.process().stderr?.on("data", (chunk) => runtimeErrors.push(String(chunk)));
  const page = await app.firstWindow();
  page.on("pageerror", (error) => runtimeErrors.push(`RENDERER_PAGE_ERROR: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`RENDERER_CONSOLE_ERROR: ${message.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
  return { app, page };
}

async function selectNativeFile(app, filePath) {
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, filePath);
}

test("Wheat 2.0 reviews, imports, deduplicates and persists every implemented bank format", async () => {
  test.setTimeout(180000);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bank-2-"));
  const userDataDir = path.join(tempRoot, "userData");
  const fixtures = await makeFixtures(tempRoot);
  const runtimeErrors = [];
  let app;

  try {
    let launched = await launchApp(userDataDir, runtimeErrors);
    app = launched.app;
    let page = launched.page;
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("Atlas Test SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("textbox", { name: "ICE", exact: true }).fill("001234567890123");
    await page.getByRole("textbox", { name: "Identifiant fiscal", exact: true }).fill("IF-ATLAS-TEST");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    // Create and post a real balanced bank entry through the editor so the
    // first imported movement can be reconciled through the user-facing UI.
    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    await page.getByRole("banner").getByRole("button", { name: "Nouvelle écriture" }).click();
    const entryDialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await entryDialog.locator("#entry-date").fill("2026-08-20");
    await entryDialog.locator("#entry-piece").fill("BANK-CSV-100");
    await entryDialog.locator("#entry-label").fill("Virement Client Test");
    await chooseOption(page, entryDialog.getByRole("combobox", { name: "Compte de la ligne 1" }), { label: "514100" });
    await chooseOption(page, entryDialog.getByRole("combobox", { name: "Compte de la ligne 2" }), { label: "711100" });
    await entryDialog.locator("#entry-line-0-label").fill("Banque débit");
    await entryDialog.locator("#entry-line-1-label").fill("Produit test");
    await entryDialog.locator("#entry-line-0-debit").fill("100,00");
    await entryDialog.locator("#entry-line-1-credit").fill("100.00");
    await expect(entryDialog.locator(".modal-total")).toContainText("Équilibrée");
    await entryDialog.getByRole("button", { name: /Enregistrer le brouillon/ }).click();
    const entryRow = page.locator("tbody tr").filter({ hasText: "BANK-CSV-100" });
    await expect(entryRow).toBeVisible();
    await entryRow.getByRole("button", { name: "Comptabiliser" }).click();
    await expect(entryRow).toContainText("Comptabilisée", { timeout: 15000 });

    await page.locator(".wt-rail").getByRole("button", { name: "Banque & rapprochement", exact: true }).click();
    await expect(page.getByText("Rapprochement bancaire", { exact: true })).toBeVisible({ timeout: 15000 });
    const bankSetup = await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      const company = boot.companies.find((item) => item.id === boot.activeCompanyId) ?? boot.companies[0];
      const workspace = await window.wheat.getReconciliationWorkspace({ companyId: company.id, includeExcluded: true });
      return { companyId: company.id, bootstrapBanks: boot.bankAccounts.length, workspaceAccounts: workspace.accounts.length };
    });
    expect(bankSetup).toMatchObject({ bootstrapBanks: 1, workspaceAccounts: 1 });
    const bankSelect = page.locator(".op-field--bank").getByRole("combobox", { name: "Compte bancaire" });
    await expect(bankSelect).toBeEnabled({ timeout: 15000 });
    await chooseOption(page, bankSelect, { index: 1 });
    await expect(page.getByRole("button", { name: "Importer un relevé" })).toBeEnabled({ timeout: 15000 });

    const importReviewed = async (filePath, formatPattern, reference) => {
      await selectNativeFile(app, filePath);
      await page.getByRole("button", { name: "Importer un relevé" }).click();
      const modal = page.getByRole("dialog", { name: "Contrôler le relevé bancaire" });
      await expect(modal).toBeVisible({ timeout: 15000 });
      await expect(modal.getByTestId("bank-import-format")).toContainText(formatPattern);
      await modal.getByTestId("bank-import-review").click();
      const errorCounter = modal.getByTestId("bank-import-validation").locator(".wt-stat").last();
      await expect(errorCounter).toContainText("Erreurs", { timeout: 15000 });
      await expect(errorCounter.locator(".wt-stat__value")).toHaveText("0");
      await expect(modal.getByTestId("bank-import-confirm")).toBeEnabled();
      await modal.getByTestId("bank-import-confirm").click();
      await expect(page.getByTestId("bank-import-report")).toBeVisible({ timeout: 15000 });
      // Once the import has run the dialog renames itself, so the closing
      // action is reached through the report dialog rather than the review one.
      await page.getByRole("dialog", { name: "Import terminé" }).getByRole("button", { name: "Terminer" }).click();
      await expect(page.locator(".op-recon-table")).toContainText(reference, { timeout: 15000 });
    };

    await importReviewed(fixtures.csv, /CSV/, "REF-CSV");

    // Exact bytes remain blocked after a rename; the file chooser never writes
    // a second movement before this review finishes.
    await selectNativeFile(app, fixtures.renamedCsv);
    await page.getByRole("button", { name: "Importer un relevé" }).click();
    let modal = page.getByRole("dialog", { name: "Contrôler le relevé bancaire" });
    await modal.getByTestId("bank-import-review").click();
    await expect(modal).toContainText("Ce fichier a déjà été importé", { timeout: 15000 });
    await expect(modal).toContainText("Le contenu exact de ce fichier existe déjà dans ce compte", { timeout: 15000 });
    await expect(modal.getByTestId("bank-import-confirm")).toBeDisabled();
    await modal.getByRole("button", { name: "Fermer" }).click();

    await importReviewed(fixtures.semicolon, /TXT/, "REF-TXT-SEMI");
    await importReviewed(fixtures.tab, /TXT/, "REF-TXT-TAB");
    await importReviewed(fixtures.xlsx, /XLSX/, "REF-XLSX");
    await importReviewed(fixtures.ofx, /OFX/, "REF-OFX");
    await importReviewed(fixtures.qif, /QIF/, "REF-QIF");
    await importReviewed(fixtures.mt940, /MT940/, "REF-MT940");
    await importReviewed(fixtures.camt, /CAMT\.053/, "REF-CAMT");
    await importReviewed(fixtures.pdf, /PDF/, "REF-PDF");

    // Bad rows block atomic persistence in the review screen.
    await selectNativeFile(app, fixtures.bad);
    await page.getByRole("button", { name: "Importer un relevé" }).click();
    modal = page.getByRole("dialog", { name: "Contrôler le relevé bancaire" });
    await modal.getByTestId("bank-import-review").click();
    await expect(modal).toContainText("Date de la ligne 1", { timeout: 15000 });
    await expect(modal.getByTestId("bank-import-confirm")).toBeDisabled();
    await modal.getByRole("button", { name: "Fermer" }).click();

    // Legacy XLS is content-detected and rejected with an actionable message.
    await selectNativeFile(app, fixtures.xls);
    await page.getByRole("button", { name: "Importer un relevé" }).click();
    await expect(page.locator(".op-notice")).toContainText("XLS binaire hérité", { timeout: 15000 });

    // Reconcile the CSV movement against the posted bank line.
    const movementRow = page.locator(".op-recon-table tbody tr").filter({ hasText: "REF-CSV" });
    await movementRow.click();
    const inspector = page.getByRole("complementary", { name: "Inspecteur de rapprochement" });
    await expect(inspector).toContainText("BANK-CSV-100", { timeout: 15000 });
    await inspector.getByRole("button", { name: /BANK-CSV-100/ }).click();
    await inspector.getByRole("button", { name: "Examiner l’allocation" }).click();
    await inspector.getByRole("button", { name: "Confirmer" }).click();
    await expect(inspector).toContainText("Rapproché", { timeout: 15000 });
    await page.locator(".op-compact-select select").selectOption("ALL");
    await expect(page.locator(".op-recon-table tbody tr").filter({ hasText: "REF-CSV" })).toContainText("Rapproché", { timeout: 15000 });

    const firstRuntimeSnapshot = await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      const company = boot.companies.find((item) => item.id === boot.activeCompanyId);
      const workspace = await window.wheat.getReconciliationWorkspace({ companyId: company.id, includeExcluded: true });
      return {
        companyId: company.id,
        movementCount: workspace.movements.length,
        statementCount: workspace.accounts[0].statements.length,
        formats: workspace.accounts[0].statements.map((item) => item.sourceFormat).sort(),
        reconciled: workspace.movements.filter((item) => item.reconciliation.status === "RECONCILED").length,
      };
    });
    expect(firstRuntimeSnapshot).toMatchObject({ movementCount: 9, statementCount: 9, reconciled: 1 });
    expect(firstRuntimeSnapshot.formats).toEqual(["CAMT053", "CSV", "MT940", "OFX", "PDF_TEXT", "QIF", "TXT", "TXT", "XLSX"]);

    await app.close();
    app = null;

    // Full Electron restart against the same userData database.
    launched = await launchApp(userDataDir, runtimeErrors);
    app = launched.app;
    page = launched.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Banque & rapprochement", exact: true }).click();
    await expect(page.locator(".op-recon-table")).toContainText("REF-PDF", { timeout: 15000 });
    await expect(page.getByTestId("bank-import-history-row")).toHaveCount(9);
    await page.locator(".op-compact-select select").selectOption("ALL");
    await expect(page.locator(".op-recon-table tbody tr").filter({ hasText: "REF-CSV" })).toContainText("Rapproché");
    const restartSnapshot = await page.evaluate(async (companyId) => {
      const workspace = await window.wheat.getReconciliationWorkspace({ companyId, includeExcluded: true });
      return {
        movements: workspace.movements.length,
        statements: workspace.accounts[0].statements.length,
        reconciled: workspace.movements.filter((item) => item.reconciliation.status === "RECONCILED").length,
      };
    }, firstRuntimeSnapshot.companyId);
    expect(restartSnapshot).toEqual({ movements: 9, statements: 9, reconciled: 1 });

    const meaningfulErrors = runtimeErrors.filter((message) => /RENDERER_(?:PAGE|CONSOLE)_ERROR|UnhandledPromiseRejection|uncaught exception/i.test(message));
    expect(meaningfulErrors).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
