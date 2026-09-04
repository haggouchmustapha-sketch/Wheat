const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile } = require("./wheat-ui-helpers.cjs");

const privateFixtures = [
  {
    name: "TVA deduction PDF",
    path: path.resolve(__dirname, "..", "..", "ReleveDeduction_EDI TVA TVA LASM (CC) MR AMINE OUA_260521_172044.pdf"),
    expectedType: "TAX",
    minTableRows: 20,
  },
  {
    name: "Delivery note PDF",
    path: path.resolve(__dirname, "..", "..", "BL LAHGAGCHA 0705.pdf"),
    expectedType: "RECEIPT",
    minTableRows: 2,
    requireAmounts: true,
  },
  {
    name: "Scanned TVA deduction JPG",
    path: path.resolve(__dirname, "..", "..", "CamScanner 22-5-2026 18.13_1.jpg"),
    expectedType: "TAX",
    minTableRows: 20,
  },
  {
    name: "Bank spreadsheet",
    path: path.resolve(__dirname, "..", "..", "Banque.xlsx"),
    expectedType: "BANK_STATEMENT",
    minTransactions: 100,
  },
];

test("private local OCR samples classify and extract useful structure", async () => {
  test.setTimeout(360000);
  test.skip(privateFixtures.some((fixture) => !fs.existsSync(fixture.path)), "Private OCR samples are not present on this machine.");

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-private-ocr-"));

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

    const results = await page.evaluate(async ({ fixtures }) => {
      const api = window.wheat;
      let boot = await api.getBootstrap();
      let company = boot.companies?.find((item) => item.id === boot.activeCompanyId) ?? boot.companies?.[0];
      if (!company) {
        company = await api.createCompany({
          name: "PRIVATE OCR TEST",
          legalForm: "SARL",
          ice: "000000000000000",
          taxId: "IF 000000",
          city: "Casablanca",
        });
      }

      const output = [];
      for (const fixture of fixtures) {
        const docs = (await api.smartOcrProcess({ companyId: company.id, filePaths: [fixture.path] })).documents;
        const extracted = docs[0] ? JSON.parse(docs[0].extracted || "{}") : {};
        output.push({
          name: fixture.name,
          importedCount: docs.length,
          type: extracted.documentType,
          confidence: extracted.confidence,
          tableRows: extracted.tableRows?.length ?? 0,
          bankTransactions: extracted.bankTransactions?.length ?? 0,
          hasHt: Number(extracted.fields?.ht ?? 0) > 0,
          hasTva: Number(extracted.fields?.tva ?? 0) > 0,
          hasTtc: Number(extracted.fields?.ttc ?? 0) > 0,
          warnings: extracted.warnings ?? [],
        });
      }
      return output;
    }, { fixtures: privateFixtures.map((fixture) => ({ name: fixture.name, path: fixture.path })) });

    for (const fixture of privateFixtures) {
      const result = results.find((item) => item.name === fixture.name);
      expect(result, fixture.name).toBeTruthy();
      expect(result.importedCount, fixture.name).toBe(1);
      expect(result.type, fixture.name).toBe(fixture.expectedType);
      expect(result.confidence, fixture.name).toBeGreaterThanOrEqual(70);
      expect(result.warnings.filter((warning) => /failed|error|crash/i.test(warning)), fixture.name).toEqual([]);
      if (fixture.minTableRows) expect(result.tableRows, fixture.name).toBeGreaterThanOrEqual(fixture.minTableRows);
      if (fixture.minTransactions) expect(result.bankTransactions, fixture.name).toBeGreaterThanOrEqual(fixture.minTransactions);
      if (fixture.requireAmounts) {
        expect(result.hasHt, `${fixture.name} HT`).toBe(true);
        expect(result.hasTva, `${fixture.name} TVA`).toBe(true);
        expect(result.hasTtc, `${fixture.name} TTC`).toBe(true);
      }
    }

    console.log(JSON.stringify(results.map((result) => ({
      sample: result.name,
      type: result.type,
      confidence: result.confidence,
      tableRows: result.tableRows,
      bankTransactions: result.bankTransactions,
    })), null, 2));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
