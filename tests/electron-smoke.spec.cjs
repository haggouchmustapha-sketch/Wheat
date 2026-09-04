const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile } = require("./wheat-ui-helpers.cjs");
const { execFileSync } = require("node:child_process");

test("Wheat desktop core workflows mutate SQLite through preload API", async () => {
  test.setTimeout(90000);
  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-ocr-"));
  const sampleInvoicePath = path.join(tempDir, "facture-maroc-telecom.txt");
  const sampleInvoiceImagePath = path.join(tempDir, "facture-maroc-telecom.png");
  fs.writeFileSync(sampleInvoicePath, [
    "FACTURE N F-2026-9001",
    "Fournisseur: Maroc Telecom SARL",
    "ICE: 001589742000063",
    "IF: 48291073",
    "Date: 20/05/2026",
    "Montant HT: 12000,00 MAD",
    "TVA: 2400,00 MAD",
    "Total TTC: 14400,00 MAD",
    "Mode de paiement: Virement",
  ].join("\n"));
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    [
      "Add-Type -AssemblyName System.Drawing",
      "$bmp=New-Object System.Drawing.Bitmap 1200,700",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.Clear([System.Drawing.Color]::White)",
      "$font=New-Object System.Drawing.Font 'Arial',38",
      "$brush=[System.Drawing.Brushes]::Black",
      "$lines=@('FACTURE N F-2026-IMG','Fournisseur: Maroc Telecom SARL','ICE: 001589742000063','IF: 48291073','Date: 20/05/2026','Montant HT: 12000,00 MAD','TVA: 2400,00 MAD','Total TTC: 14400,00 MAD')",
      "$y=40",
      "foreach($line in $lines){$g.DrawString($line,$font,$brush,40,$y); $y+=74}",
      `$bmp.Save('${sampleInvoiceImagePath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$g.Dispose(); $bmp.Dispose(); $font.Dispose()",
    ].join("; "),
  ]);
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
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Wheat").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".window-controls")).toHaveCount(0);

  // A fresh Atlas profile is intentionally blank and starts with the real
  // onboarding flow. Prove that creating the first dossier does not inject any
  // sample accounting data before switching to the explicit demo workspace for
  // the broader legacy smoke coverage below.
  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
  await page.getByLabel("Nom de la société").fill("SMOKE CLEAN SARL");
  await page.getByLabel("Ville").fill("Casablanca");
  await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
  const cleanStart = await page.evaluate(async () => {
    const boot = await window.wheat.getBootstrap();
    const result = { companyCount: boot.companies.length, entryCount: boot.entries.length };
    await window.wheat.resetWorkspace({ mode: "demo" });
    return result;
  });
  expect(cleanStart).toEqual({ companyCount: 1, entryCount: 0 });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
  // This spec writes companies, entries and documents. Fail loudly if it is
  // pointed at anything other than the profile it created for itself.
  await assertIsolatedProfile(page, tempDir);
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });

  await page.locator(".topbar-search input").click();
  await page.keyboard.type("atlas");
  await expect(page.locator(".topbar-search input")).toHaveValue("atlas");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");

  await page.keyboard.press("Control+K");
  await expect(page.locator(".command-input input")).toBeFocused();
  await page.keyboard.type("tva");
  await expect(page.locator(".command-input input")).toHaveValue("tva");
  await page.keyboard.press("Escape");
  await expect(page.locator(".command-palette")).toHaveCount(0);

  await page.locator(".topbar .primary-button").click();
  await expect(page.locator(".entry-modal")).toBeVisible({ timeout: 15000 });
  await page.locator(".entry-modal input").nth(1).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("TEST-PIECE");
  await expect(page.locator(".entry-modal input").nth(1)).toHaveValue("TEST-PIECE");
  await page.getByRole("button", { name: "Annuler" }).click();

  await page.locator(".wt-rail").getByRole("button", { name: "Production du jour", exact: true }).click();
  await expect(page.locator(".production-page")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".production-step")).toHaveCount(5);
  await page.locator(".wt-rail").getByRole("button", { name: "Documents & OCR", exact: true }).click();
  await expect(page.locator(".ocr-workbench")).toBeVisible({ timeout: 15000 });
  await page.locator(".ocr-toolbar input").click();
  await page.keyboard.type("telecom");
  await expect(page.locator(".ocr-toolbar input")).toHaveValue("telecom");
  const scrollBox = await page.locator(".page").boundingBox();
  if (!scrollBox) throw new Error("Scrollable page container missing");
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(250);
  const pageScroll = await page.evaluate(() => {
    const scrollArea = document.querySelector(".page");
    return {
      scrollTop: scrollArea?.scrollTop ?? 0,
      scrollHeight: scrollArea?.scrollHeight ?? 0,
      clientHeight: scrollArea?.clientHeight ?? 0,
    };
  });
  expect(pageScroll.scrollHeight).toBeGreaterThan(pageScroll.clientHeight);
  expect(pageScroll.scrollTop).toBeGreaterThan(0);

  const result = await page.evaluate(async ({ sampleInvoicePath, sampleInvoiceImagePath, sampleFolderPath }) => {
    const api = window.wheat;
    if (!api) throw new Error("window.wheat preload API missing");

    const first = await api.getBootstrap();
    const company = first.companies.find((item) => item.id === first.activeCompanyId) ?? first.companies[0];
    const journal = company.journals.find((item) => item.code === "OD") ?? company.journals[0];
    const debitAccount = company.accounts.find((item) => item.code === "342100") ?? company.accounts[0];
    const creditAccount = company.accounts.find((item) => item.code.startsWith("7")) ?? company.accounts[1];

    const created = await api.createEntry({
      companyId: company.id,
      journalId: journal.id,
      date: "2026-05-20T00:00:00.000Z",
      pieceNumber: `SMOKE-${Date.now()}`,
      label: "Smoke balanced entry",
      source: "SMOKE",
      lines: [
        { accountId: debitAccount.id, label: "Smoke debit", debit: 1234, credit: 0 },
        { accountId: creditAccount.id, label: "Smoke credit", debit: 0, credit: 1234 },
      ],
    });

    if (created.status !== "DRAFT") throw new Error("Manual entry was not created as a draft");
    await api.postEntry(created.id);

    const afterCreate = await api.getBootstrap(company.id);
    await api.duplicateEntry(created.id);
    await api.reverseEntry(created.id, "2026-05-31");

    const bankAccount = afterCreate.bankAccounts[0];
    const bankRows = [{ Date: "2026-05-20", Libelle: "SMOKE BANK IMPORT", Montant: "2500.00", Reference: "SMOKE-BANK" }];
    const statementText = "Date;Libelle;Montant;Reference\n2026-05-20;SMOKE BANK IMPORT;2500.00;SMOKE-BANK\n";
    const statementBytes = new TextEncoder().encode(statementText);
    const statementHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", statementBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await api.importBankStatement({
      bankAccountId: bankAccount.id,
      sourceName: "smoke-bank.csv",
      sourceSha256: statementHash,
      sourceBytesBase64: btoa(statementText),
      rows: bankRows,
      mapping: { date: "Date", label: "Libelle", amount: "Montant", reference: "Reference" },
    });

    const document = afterCreate.documents.find((item) => {
      if (item.status === "POSTED" || item.invoiceId) return false;
      try {
        const extracted = JSON.parse(item.extracted);
        const fields = extracted.fields ?? extracted;
        return Boolean(fields.ttc && fields.ht);
      } catch {
        return false;
      }
    });
    if (document) await api.postDocumentEntry(document.id);
    await api.postPayrollEntry(company.id, "2026-06");
    const smartOcr = await api.smartOcrProcess({ companyId: company.id, filePaths: [sampleInvoicePath] });
    const smartDocs = smartOcr.documents;
    const smartImageDocs = (await api.smartOcrProcess({ companyId: company.id, filePaths: [sampleInvoiceImagePath] })).documents;
    // A dropped folder is now an import, not a refusal: Wheat walks it and
    // recognises everything supported inside. The two sample invoices are
    // already filed, so this returns them a second time and the duplicate
    // detection is what flags them — the point here is only that a folder is
    // accepted and produces documents.
    const folderImport = await api.smartOcrProcess({ companyId: company.id, filePaths: [sampleFolderPath] });

    const final = await api.getBootstrap(company.id);
    const createdCompany = await api.createCompany({
      name: `SMOKE NEW COMPANY ${Date.now()}`,
      legalForm: "SARL",
      ice: "009999999999999",
      taxId: "IF 999999",
      city: "Casablanca",
    });
    const afterCompany = await api.getBootstrap(createdCompany.id);
    await api.resetWorkspace({ mode: "blank" });
    const afterBlank = await api.getBootstrap();
    return {
      firstEntries: first.entries.length,
      finalEntries: final.entries.length,
      firstBankMovements: first.bankAccounts.reduce((sum, account) => sum + account.movements.length, 0),
      finalBankMovements: final.bankAccounts.reduce((sum, account) => sum + account.movements.length, 0),
      linkedDocuments: final.documents.filter((item) => item.invoiceId).length,
      ocrLinkedDraftDocuments: final.documents.filter((item) => item.invoiceId && item.status === "INVOICE_DRAFT").length,
      ocrDraftInvoices: final.invoices.filter((item) => item.source === "OCR_1_3" && item.lifecycleStatus === "DRAFT").length,
      ocrHandoffAuditEvents: final.activityLogs.filter((item) => item.action === "CREATE_INVOICE_DRAFT_FROM_OCR").length,
      matchedMovements: final.bankAccounts.flatMap((account) => account.movements).filter((item) => item.status === "MATCHED").length,
      payrollEntries: final.entries.filter((entry) => entry.source === "PAYROLL").length,
      reversedEntries: final.entries.filter((entry) => entry.status === "REVERSED").length,
      reversalEntries: final.entries.filter((entry) => entry.source === "REVERSAL" && entry.status === "POSTED").length,
      draftEntries: final.entries.filter((entry) => entry.status === "DRAFT").length,
      smartOcrDocuments: smartDocs.length,
      smartOcrRejections: smartOcr.rejections.length,
      folderImportDocuments: folderImport.documents.length,
      smartOcrType: JSON.parse(smartDocs[0].extracted).documentType,
      smartOcrTtc: JSON.parse(smartDocs[0].extracted).fields.ttc,
      smartOcrCounterparty: JSON.parse(smartDocs[0].extracted).fields.counterparty,
      smartImageOcrDocuments: smartImageDocs.length,
      smartImageOcrEngine: JSON.parse(smartImageDocs[0].extracted).engine,
      smartImageOcrPreprocessing: JSON.parse(smartImageDocs[0].extracted).preprocessing,
      smartImageOcrType: JSON.parse(smartImageDocs[0].extracted).documentType,
      smartImageOcrText: smartImageDocs[0].ocrText,
      smartImageOcrTtc: JSON.parse(smartImageDocs[0].extracted).fields.ttc,
      companyCountAfterCreate: afterCompany.companies.length,
      blankCompanyCount: afterBlank.companies.length,
      databasePath: final.databasePath,
    };
  }, { sampleInvoicePath, sampleInvoiceImagePath, sampleFolderPath: tempDir });

  expect(result.finalEntries).toBeGreaterThan(result.firstEntries + 3);
  expect(result.finalBankMovements).toBeGreaterThan(result.firstBankMovements);
  expect(result.linkedDocuments).toBeGreaterThan(0);
  expect(result.ocrLinkedDraftDocuments).toBeGreaterThan(0);
  expect(result.ocrDraftInvoices).toBeGreaterThan(0);
  expect(result.ocrHandoffAuditEvents).toBeGreaterThan(0);
  expect(result.matchedMovements).toBeGreaterThan(0);
  expect(result.payrollEntries).toBeGreaterThan(0);
  expect(result.reversedEntries).toBeGreaterThan(0);
  expect(result.reversalEntries).toBeGreaterThan(0);
  expect(result.draftEntries).toBeGreaterThan(0);
  expect(result.smartOcrDocuments).toBe(1);
  expect(result.smartOcrRejections).toBe(0);
  // The folder held both samples plus the profile Wheat itself wrote into it,
  // so a walk of it must find at least the two documents.
  expect(result.folderImportDocuments).toBeGreaterThanOrEqual(2);
  expect(result.smartOcrType).toBe("INVOICE");
  expect(result.smartOcrTtc).toBe(14400);
  expect(result.smartOcrCounterparty).toContain("Maroc Telecom SARL");
  expect(result.smartImageOcrDocuments).toBe(1);
  expect(result.smartImageOcrEngine).toBe("Wheat Vision OCR");
  expect(result.smartImageOcrPreprocessing.join(" ")).toContain("sharp-auto-rotate");
  expect(result.smartImageOcrType).toBe("INVOICE");
  expect(result.smartImageOcrText).toContain("FACTURE");
  expect(result.smartImageOcrTtc).toBe(14400);
  expect(result.companyCountAfterCreate).toBeGreaterThan(1);
  expect(result.blankCompanyCount).toBe(0);
  console.log(JSON.stringify(result, null, 2));

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
