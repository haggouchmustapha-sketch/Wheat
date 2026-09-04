const { test, expect } = require("@playwright/test");
const { require: tsxRequire } = require("tsx/cjs/api");
const ExcelJS = require("exceljs");
const { jsPDF } = require("jspdf");
const path = require("node:path");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const importer = tsxRequire(path.join(cwd, "electron", "bankStatementImporter.ts"), __filename);
const reconciliation = tsxRequire(path.join(cwd, "electron", "reconciliation.ts"), __filename);

const expectedCore = [
  { date: "2026-08-01", label: "Fournisseur Atlas", reference: "REF-001", amountCents: "-123456" },
  { date: "2026-08-02", label: "Client Maroc", reference: "REF-002", amountCents: "250000" },
  { date: "2026-08-03", label: "Frais Banque", reference: "REF-003", amountCents: "-1525" },
];

function base64(value) {
  return Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(value, "utf8").toString("base64");
}

async function parse(name, content) {
  return importer.parseBankStatement({ sourceName: name, bytesBase64: base64(content) });
}

function normalizedCore(parsed) {
  return reconciliation.normalizeStatementRows({
    bankAccountId: "bank-format-consistency",
    rows: parsed.rows,
    mapping: parsed.suggestedMapping,
  }).map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    label: row.label,
    reference: row.reference,
    amountCents: row.amountCents.toString(),
  }));
}

const csvDebitCredit = [
  "Date opération;Date valeur;Libellé;Référence;Débit;Crédit;Solde;Devise",
  '01/08/2026;01/08/2026;Fournisseur Atlas;REF-001;"1 234,56";;9000,00;MAD',
  '02/08/2026;02/08/2026;Client Maroc;REF-002;;"2 500,00";11500,00;MAD',
  '03/08/2026;03/08/2026;Frais Banque;REF-003;"15,25";;11484,75;MAD',
].join("\r\n");

const signedCsv = [
  "Date,Description,Reference,Amount,Currency",
  '2026-08-01,Fournisseur Atlas,REF-001,"-1234.56",MAD',
  '2026-08-02,Client Maroc,REF-002,"2500.00",MAD',
  '2026-08-03,Frais Banque,REF-003,"-15.25",MAD',
].join("\n");

const semicolonTxt = [
  "Date;Description;Reference;Amount;Currency",
  "01-08-2026;Fournisseur Atlas;REF-001;-1 234,56;MAD",
  "02-08-2026;Client Maroc;REF-002;2 500,00;MAD",
  "03-08-2026;Frais Banque;REF-003;-15,25;MAD",
].join("\n");

const tabTxt = [
  "Date\tDescription\tReference\tAmount\tCurrency",
  "2026-08-01\tFournisseur Atlas\tREF-001\t-1234.56\tMAD",
  "2026-08-02\tClient Maroc\tREF-002\t2500.00\tMAD",
  "2026-08-03\tFrais Banque\tREF-003\t-15.25\tMAD",
].join("\n");

const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</STATUS></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>MAD<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260801000000<TRNAMT>-1234.56<FITID>TX-001<CHECKNUM>REF-001<NAME>Fournisseur Atlas</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260802000000<TRNAMT>2500.00<FITID>TX-002<CHECKNUM>REF-002<NAME>Client Maroc</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803000000<TRNAMT>-15.25<FITID>TX-003<CHECKNUM>REF-003<NAME>Frais Banque</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const qif = `!Type:Bank
D01/08/2026
T-1234.56
PFournisseur Atlas
NREF-001
^
D02/08/2026
T2500.00
PClient Maroc
NREF-002
^
D03/08/2026
T-15.25
PFrais Banque
NREF-003
^`;

const mt940 = `:20:ATLAS-TEST
:25:MA000TEST
:28C:00001/001
:60F:C260731MAD10234,56
:61:2608010801D1234,56NTRFREF-001
:86:Fournisseur Atlas
:61:2608020802C2500,00NTRFREF-002
:86:Client Maroc
:61:2608030803D15,25NCHGREF-003
:86:Frais Banque
:62F:C260803MAD11484,75`;

const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>ATLAS-TEST</Id>
<Ntry><Amt Ccy="MAD">1234.56</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-01</Dt></BookgDt><ValDt><Dt>2026-08-01</Dt></ValDt><AcctSvcrRef>REF-001</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>Fournisseur Atlas</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="MAD">2500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-08-02</Dt></BookgDt><AcctSvcrRef>REF-002</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>Client Maroc</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="MAD">15.25</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-03</Dt></BookgDt><AcctSvcrRef>REF-003</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>Frais Banque</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test("CSV debit/credit preserves French cents, dates and accents without mapping balance as amount", async () => {
  const parsed = await parse("releve.csv", csvDebitCredit);
  expect(parsed.format).toBe("CSV");
  expect(parsed.suggestedMapping).toMatchObject({ date: "Date opération", label: "Libellé", debit: "Débit", credit: "Crédit", currency: "Devise" });
  expect(parsed.suggestedMapping.amount).toBeUndefined();
  expect(normalizedCore(parsed)).toEqual(expectedCore);
});

test("CSV signed amount and TXT semicolon/tab variants normalize identically", async () => {
  const variants = await Promise.all([
    parse("signed.csv", signedCsv),
    parse("semicolon.txt", semicolonTxt),
    parse("tab.txt", tabTxt),
  ]);
  expect(variants.map((item) => item.format)).toEqual(["CSV", "TXT", "TXT"]);
  for (const parsed of variants) expect(normalizedCore(parsed)).toEqual(expectedCore);
});

test("Windows-1252 text is decoded and reported", async () => {
  const bytes = Buffer.from("Date;Libellé;Référence;Montant\n01/08/2026;Opération été;RÉF-1;-10,50", "latin1");
  const parsed = await parse("cp1252.txt", bytes);
  expect(parsed.warnings.join(" ")).toContain("Windows-1252");
  expect(parsed.rows[0].Libellé).toBe("Opération été");
});

test("a moderately large statement keeps the preview bounded while preserving every row", async () => {
  const lines = ["Date;Description;Reference;Amount"];
  for (let index = 0; index < 1_000; index += 1) {
    lines.push(`2026-08-${String((index % 28) + 1).padStart(2, "0")};Ligne ${index + 1};LARGE-${index + 1};${index % 2 ? "-" : ""}${index + 1},01`);
  }
  const startedAt = Date.now();
  const parsed = await parse("large.txt", lines.join("\n"));
  expect(parsed.rowCount).toBe(1_000);
  expect(parsed.previewRows).toHaveLength(20);
  expect(Date.now() - startedAt).toBeLessThan(5_000);
});

test("XLSX is detected by content signature even when renamed", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Relevé");
  sheet.addRows([
    ["Date", "Description", "Reference", "Amount", "Currency"],
    ["2026-08-01", "Fournisseur Atlas", "REF-001", "-1234.56", "MAD"],
    ["2026-08-02", "Client Maroc", "REF-002", "2500.00", "MAD"],
    ["2026-08-03", "Frais Banque", "REF-003", "-15.25", "MAD"],
  ]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parse("renamed.csv", bytes);
  expect(parsed.format).toBe("XLSX");
  expect(normalizedCore(parsed)).toEqual(expectedCore);
});

test("OFX, QIF, MT940 and CAMT.053 normalize the same core transactions", async () => {
  const variants = await Promise.all([
    parse("statement.dat", ofx),
    parse("statement.qif", qif),
    parse("statement.sta", mt940),
    parse("statement.xml", camt),
  ]);
  expect(variants.map((item) => item.format)).toEqual(["OFX", "QIF", "MT940", "CAMT053"]);
  for (const parsed of variants) expect(normalizedCore(parsed)).toEqual(expectedCore);
});

test("text PDF imports only a recognizable delimited table", async () => {
  const pdf = new jsPDF();
  pdf.setFont("courier", "normal");
  pdf.setFontSize(10);
  [
    "ATLAS TEST SARL - RELEVE BANCAIRE CONTROLE",
    "Date | Description | Reference | Amount | Currency",
    "2026-08-01 | Fournisseur Atlas | REF-001 | -1234.56 | MAD",
    "2026-08-02 | Client Maroc | REF-002 | 2500.00 | MAD",
    "2026-08-03 | Frais Banque | REF-003 | -15.25 | MAD",
  ].forEach((line, index) => pdf.text(line, 15, 20 + index * 8));
  const parsed = await parse("statement.pdf", Buffer.from(pdf.output("arraybuffer")));
  expect(parsed.format).toBe("PDF_TEXT");
  expect(normalizedCore(parsed)).toEqual(expectedCore);
  expect(parsed.warnings.join(" ")).toContain("PDF texte");
});

test("scanned/image-only PDF is rejected instead of inventing transactions", async () => {
  const pdf = new jsPDF();
  pdf.setFillColor(20, 20, 20);
  pdf.rect(10, 10, 180, 250, "F");
  await expect(parse("scan.pdf", Buffer.from(pdf.output("arraybuffer")))).rejects.toThrow(/couche texte fiable|scannés/i);
});

test("legacy XLS, corrupt XLSX, malformed delimited rows and ambiguous PDF fail safely", async () => {
  await expect(parse("legacy.xls", Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]))).rejects.toThrow(/XLS binaire hérité/);
  await expect(parse("corrupt.xlsx", Buffer.from("PK-not-a-workbook"))).rejects.toThrow(/corrompu/);
  await expect(parse("broken.csv", 'Date,Description,Amount\n2026-08-01,"broken,-10')).rejects.toThrow(/guillemets non fermé/);
  const pdf = new jsPDF();
  pdf.text("This is readable PDF prose, but it has no reliable bank statement table or recognizable delimited header.", 10, 20, { maxWidth: 180 });
  await expect(parse("ambiguous.pdf", Buffer.from(pdf.output("arraybuffer")))).rejects.toThrow(/mise en page|tableau délimité/i);
});

test("review reports row errors, within-file duplicates, and currency mismatch before persistence", async () => {
  let transactionCalls = 0;
  const prisma = {
    $transaction: async (callback) => { transactionCalls += 1; return callback(prisma); },
    bankAccount: { findUnique: async () => ({ id: "bank-review", companyId: "company-review", active: true, currency: "MAD" }) },
    bankMovement: { findMany: async () => [] },
    bankStatementImport: { findUnique: async () => null },
  };
  const service = reconciliation.createReconciliationService(prisma);
  const review = await service.reviewStatement({
    bankAccountId: "bank-review",
    sourceSha256: "b".repeat(64),
    sourceCurrency: "EUR",
    mapping: { date: "Date", label: "Description", reference: "Reference", amount: "Amount", currency: "Currency" },
    rows: [
      { Date: "2026-08-20", Description: "Mouvement", Reference: "REF-1", Amount: "10,00", Currency: "MAD" },
      { Date: "32/08/2026", Description: "Date invalide", Reference: "REF-2", Amount: "5,00", Currency: "MAD" },
      { Date: "2026-08-20", Description: "Mouvement", Reference: "REF-1", Amount: "10,00", Currency: "MAD" },
    ],
  });
  expect(review).toMatchObject({ rowCount: 3, validCount: 2, duplicateCount: 2, readyCount: 0, canImport: false, exactFileDuplicate: false });
  expect(review.errors.map((item) => item.row)).toEqual([2, 0]);
  expect(review.duplicateRows).toEqual([1, 3]);
  expect(transactionCalls).toBe(0);
});

test("review detects an exact prior file and a renamed equivalent transaction without writing", async () => {
  let fingerprint;
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    bankAccount: { findUnique: async () => ({ id: "bank-review", companyId: "company-review", active: true, currency: "MAD" }) },
    bankMovement: { findMany: async (query) => {
      fingerprint = query.where.fingerprint.in[0];
      return [{ fingerprint }];
    } },
    bankStatementImport: { findUnique: async () => ({ id: "prior", sourceName: "original.csv" }) },
  };
  const review = await reconciliation.createReconciliationService(prisma).reviewStatement({
    bankAccountId: "bank-review",
    sourceSha256: "c".repeat(64),
    mapping: { date: "Date", label: "Description", reference: "Reference", amount: "Amount" },
    rows: [{ Date: "2026-08-20", Description: "Equivalent renommé", Reference: "REF-SAME", Amount: "10.00" }],
  });
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(review).toMatchObject({ exactFileDuplicate: true, duplicateCount: 1, readyCount: 0, canImport: false });
});
