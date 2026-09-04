const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertIsolatedProfile } = require("./wheat-ui-helpers.cjs");
const sharp = require("sharp");
const { jsPDF } = require("jspdf");

function writeFile(dir, fileName, content) {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function invoiceSvg(title = "FACTURE N F-2026-9001") {
  const lines = [
    title,
    "Fournisseur: Maroc Telecom SARL",
    "ICE: 001589742000063",
    "IF: 48291073",
    "Date: 20/05/2026",
    "Montant HT: 12 000,00 MAD",
    "TVA 20%: 2 400,00 MAD",
    "Total TTC: 14 400,00 MAD",
    "Mode de paiement: Virement",
    "Table: Designation | HT | TVA | TTC",
    "Internet Fibre Pro | 12000 | 2400 | 14400",
  ];

  return `<svg width="1700" height="1200" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#fff"/>
    <rect x="60" y="60" width="1580" height="1080" fill="none" stroke="#0f172a" stroke-width="4"/>
    <text x="100" y="150" font-family="Arial" font-size="58" font-weight="700" fill="#111827">${lines[0]}</text>
    ${lines.slice(1).map((line, index) => `<text x="105" y="${250 + index * 78}" font-family="Arial" font-size="48" fill="#111827">${line}</text>`).join("")}
  </svg>`;
}

async function createFixtures(rootDir) {
  const fixtureDir = path.join(rootDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const txtInvoice = writeFile(fixtureDir, "facture-maroc-telecom.txt", [
    "FACTURE N F-2026-9001",
    "Fournisseur: Maroc Telecom SARL",
    "ICE: 001589742000063",
    "IF: 48291073",
    "Date: 20/05/2026",
    "Montant HT: 12 000,00 MAD",
    "TVA: 2 400,00 MAD",
    "Total TTC: 14 400,00 MAD",
    "Mode de paiement: Virement",
  ].join("\n"));

  const cleanPng = path.join(fixtureDir, "facture-clean.png");
  await sharp(Buffer.from(invoiceSvg())).png().toFile(cleanPng);

  const rotatedJpg = path.join(fixtureDir, "facture-rotation-bruit.jpg");
  await sharp(Buffer.from(invoiceSvg("FACTURE N F-2026-ROT")))
    .rotate(3.5, { background: "#ffffff" })
    .resize({ width: 1350 })
    .grayscale()
    .modulate({ brightness: 1.06, saturation: 0.6 })
    .jpeg({ quality: 55, mozjpeg: true })
    .toFile(rotatedJpg);

  const bankCsv = writeFile(fixtureDir, "releve-bancaire-bmce.csv", [
    "Date;Description;Debit;Credit;Solde",
    "20/05/2026;VIR MAROC TELECOM F-2026-9001;;14400,00;51400,00",
    "21/05/2026;FRAIS BANCAIRES;120,00;;51280,00",
  ].join("\n"));

  const flashStyleInvoice = writeFile(fixtureDir, "facture-flash-economie-style.txt", [
    "Facture",
    "Ref. : FA1811-0025",
    "Date facturation : 07/11/2018",
    "Date echeance : 07/11/2018",
    "Emetteur:",
    "FLASH ECONOMIE",
    "28 AVENUE DES FAR",
    "02000 CASABLANCA",
    "Tel.: 0522203031 Maroc",
    "Email: contact@example.ma",
    "Adresse a:",
    "BFR & ASSOCIES",
    "Montants exprimes en MAD",
    "Total HT: 2 902,00",
    "Total TVA: 580,40",
    "Total TTC: 3 482,40",
    "Conditions de paiement: A reception",
    "ICE: 001742857000083",
    "Banque: ATTIJARIWAFABANK CASA MARHABA",
    "RIB: 007 780 0000000000000000 00",
  ].join("\n"));

  const mediproStyleInvoice = writeFile(fixtureDir, "facture-e-solution-style.txt", [
    "Facture N : FA201605231",
    "ICE : 000161508000016",
    "Date d'emission : 27 mai 2016",
    "Date d'echeance : 27 juillet 2016",
    "Mode de reglement : Cheque",
    "Statut : Payee",
    "Emetteur:",
    "E-solution",
    "39 Rue ELFOURAT Etage 1 N 10",
    "Casablanca Maroc",
    "I.F : 14415051",
    "Adresse a :",
    "MEDIPRO ACADEMY",
    "Details de la facture Montants exprimes en MAD",
    "Total HT: 1 600,00",
    "TVA: 320,00",
    "Net a payer: 1 920,00",
    "Societe Generale - RIB : 022 780 000 149 00 040020 97 74",
  ].join("\n"));

  const digitalPdf = path.join(fixtureDir, "facture-digital.pdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  pdf.setFontSize(22);
  pdf.text("FACTURE N F-2026-PDF", 50, 70);
  pdf.setFontSize(14);
  [
    "Fournisseur: Maroc Telecom SARL",
    "ICE: 001589742000063",
    "IF: 48291073",
    "Date: 20/05/2026",
    "Montant HT: 12 000,00 MAD",
    "TVA: 2 400,00 MAD",
    "Total TTC: 14 400,00 MAD",
    "Mode de paiement: Virement",
  ].forEach((line, index) => pdf.text(line, 50, 120 + index * 28));
  fs.writeFileSync(digitalPdf, Buffer.from(pdf.output("arraybuffer")));

  const scannedPdf = path.join(fixtureDir, "facture-scan.pdf");
  const scan = new jsPDF({ unit: "pt", format: "a4" });
  const scanImage = await sharp(cleanPng).resize({ width: 1100 }).jpeg({ quality: 80 }).toBuffer();
  scan.addImage(scanImage.toString("base64"), "JPEG", 20, 30, 555, 392);
  fs.writeFileSync(scannedPdf, Buffer.from(scan.output("arraybuffer")));

  return [
    { name: "TXT invoice", path: txtInvoice, expectedType: "INVOICE", expectedTtc: 14400, expectedTva: 2400 },
    { name: "Clean PNG invoice", path: cleanPng, expectedType: "INVOICE", expectedTtc: 14400, expectedTva: 2400 },
    { name: "Rotated noisy JPG invoice", path: rotatedJpg, expectedType: "INVOICE", expectedTtc: 14400, expectedTva: 2400 },
    { name: "Digital PDF invoice", path: digitalPdf, expectedType: "INVOICE", expectedTtc: 14400, expectedTva: 2400 },
    { name: "Scanned PDF invoice", path: scannedPdf, expectedType: "INVOICE", expectedTtc: 14400, expectedTva: 2400 },
    { name: "Bank CSV statement", path: bankCsv, expectedType: "BANK_STATEMENT", expectedTransactions: 2 },
    {
      name: "Flash Economie public-layout invoice",
      path: flashStyleInvoice,
      expectedType: "INVOICE",
      expectedTtc: 3482.4,
      expectedTva: 580.4,
      expectedFields: {
        invoiceNumber: "FA1811-0025",
        reference: "FA1811-0025",
        supplier: "FLASH ECONOMIE",
        client: "BFR & ASSOCIES",
        dueDate: "2018-11-07",
        ice: "001742857000083",
      },
    },
    {
      name: "E-solution public-layout invoice",
      path: mediproStyleInvoice,
      expectedType: "INVOICE",
      expectedTtc: 1920,
      expectedTva: 320,
      expectedFields: {
        invoiceNumber: "FA201605231",
        supplier: "E-solution",
        client: "MEDIPRO ACADEMY",
        date: "2016-05-27",
        dueDate: "2016-07-27",
        if: "14415051",
        paymentTerms: "Cheque",
      },
    },
  ];
}

test("Smart OCR Organizer extracts structured data from real file types", async () => {
  test.setTimeout(240000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const packagedExe = process.env.WHEAT_EXE;
  const electronExe = packagedExe ?? path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-meaningful-ocr-"));
  const fixtures = await createFixtures(tempDir);

  const app = await electron.launch({
    executablePath: electronExe,
    args: packagedExe ? [] : [cwd],
    cwd,
    env: {
      ...process.env,
      APPDATA: path.join(tempDir, "appData"),
      LOCALAPPDATA: path.join(tempDir, "localAppData"),
      WHEAT_USER_DATA_DIR: path.join(tempDir, "userData"),
      ELECTRON_ENABLE_LOGGING: "1",
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

    const results = await page.evaluate(async ({ fixtures }) => {
      const api = window.wheat;
      let boot = await api.getBootstrap();
      let company = boot.companies?.find((item) => item.id === boot.activeCompanyId) ?? boot.companies?.[0];
      if (!company) {
        company = await api.createCompany({
          name: "OCR TEST SARL",
          legalForm: "SARL",
          ice: "001589742000063",
          taxId: "IF 48291073",
          city: "Casablanca",
        });
      }

      const output = [];
      for (const fixture of fixtures) {
        const before = await api.getBootstrap(company.id);
        // Import returns the batch it created plus what it refused; a
        // single-file import is simply a batch of one.
        const docs = (await api.smartOcrProcess({ companyId: company.id, filePaths: [fixture.path] })).documents;
        const after = await api.getBootstrap(company.id);
        const doc = docs[0];
        const extracted = doc ? JSON.parse(doc.extracted || "{}") : null;
        output.push({
          fixture: fixture.name,
          importedCount: docs.length,
          documentIncrease: after.documents.length - before.documents.length,
          type: extracted?.documentType ?? null,
          engine: extracted?.engine ?? null,
          confidence: extracted?.confidence ?? null,
          fields: extracted?.fields ?? {},
          bankTransactions: extracted?.bankTransactions ?? [],
          tableRows: extracted?.tableRows ?? [],
          preprocessing: extracted?.preprocessing ?? [],
          warnings: extracted?.warnings ?? [],
          text: doc?.ocrText ?? "",
          status: doc?.status ?? null,
          // Wheat 2.1 checks the document's own arithmetic; a failure here is
          // what sends an otherwise well-read document to review.
          accountingChecks: extracted?.accountingChecks ?? [],
          amountsNotFound: extracted?.amountsNotFound ?? [],
          uncertainFields: extracted?.uncertainFields ?? [],
          fieldRaw: extracted?.fieldRaw ?? {},
        });
      }
      return output;
    }, { fixtures });

    for (const fixture of fixtures) {
      const result = results.find((item) => item.fixture === fixture.name);
      expect(result, fixture.name).toBeTruthy();
      expect(result.importedCount, fixture.name).toBe(1);
      expect(result.documentIncrease, fixture.name).toBe(1);
      expect(result.engine, fixture.name).toBe("Wheat Vision OCR");
      expect(result.type, fixture.name).toBe(fixture.expectedType);
      expect(result.warnings.filter((warning) => /failed|error|crash/i.test(warning)), fixture.name).toEqual([]);

      if (fixture.expectedTtc) expect(Number(result.fields.ttc), fixture.name).toBe(fixture.expectedTtc);
      if (fixture.expectedTva) expect(Number(result.fields.tva), fixture.name).toBe(fixture.expectedTva);
      if (fixture.expectedTransactions) expect(result.bankTransactions.length, fixture.name).toBe(fixture.expectedTransactions);
      if (fixture.expectedFields) {
        for (const [field, value] of Object.entries(fixture.expectedFields)) {
          expect(String(result.fields[field] ?? ""), `${fixture.name} ${field}`).toBe(String(value));
        }
      }
    }

    console.log(JSON.stringify(results.map((result) => ({
      fixture: result.fixture,
      type: result.type,
      confidence: result.confidence,
      ttc: result.fields.ttc,
      tva: result.fields.tva,
      bankTransactions: result.bankTransactions.length,
      status: result.status,
      preprocessing: result.preprocessing,
      amountsNotFound: result.amountsNotFound,
      uncertainFields: result.uncertainFields,
      failedChecks: result.accountingChecks.filter((check) => check.status === "FAILED").map((check) => `${check.id}: ${check.detail}`),
      vatRate: result.fields.vatRate ?? null,
      vatRateRaw: result.fieldRaw?.vatRate ?? null,
    })), null, 2));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
