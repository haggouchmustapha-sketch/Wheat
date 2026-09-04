/**
 * Document understanding: what Wheat makes of a recognised page.
 *
 * Every fixture here is a real PaddleOCR result captured from a document in
 * `test documents for use/`. Feeding recorded recognition rather than running
 * the recogniser keeps the two failure modes apart: if one of these tests goes
 * red, the characters were demonstrably on the page and the fault is in Wheat's
 * mapping. Recognition quality itself is covered by `ocr-meaningful.spec.cjs`,
 * which drives the whole pipeline against generated documents.
 *
 * The regression that motivated the suite: on a supplier invoice whose header
 * reads "FACT° 39/2026", Wheat left the invoice number blank, named the
 * supplier after a letterhead slogan, read the VAT as the HT total printed on
 * the line above it, and then overwrote a correctly read TTC with HT + VAT.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const fixtureDir = path.join(__dirname, "fixtures", "ocr");

const { extractDocumentFields } = tsxRequire(path.join(cwd, "electron", "ocrFieldExtraction.ts"), __filename);
const { parseDocumentAmount, evaluateTotals, isAmountLike } = tsxRequire(path.join(cwd, "electron", "ocrAmounts.ts"), __filename);
const { buildDocumentLayout } = tsxRequire(path.join(cwd, "electron", "ocrLayout.ts"), __filename);

function readFixture(name) {
  const recognised = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
  return [{ page: 1, text: recognised.text, confidence: recognised.confidence, words: recognised.words }];
}

function extract(name, context = {}) {
  return extractDocumentFields(readFixture(name), { fileName: name, ...context });
}

/** Builds a synthetic page whose rows are laid out like a real invoice. */
function syntheticPage(rows, options = {}) {
  const lineHeight = options.lineHeight ?? 30;
  const words = [];
  rows.forEach((row, rowIndex) => {
    const top = 100 + rowIndex * (lineHeight + 12);
    row.forEach((cell) => {
      const text = typeof cell === "string" ? cell : cell.text;
      const x0 = typeof cell === "string" ? 120 : cell.x;
      const drop = typeof cell === "string" ? 0 : (cell.drop ?? 0);
      words.push({
        text,
        confidence: typeof cell === "string" ? 98 : (cell.confidence ?? 98),
        page: 1,
        bbox: { x0, y0: top + drop, x1: x0 + Math.max(40, text.length * 11), y1: top + drop + lineHeight },
      });
    });
  });
  return [{ page: 1, text: words.map((word) => word.text).join("\n"), confidence: 96, words }];
}

const value = (result, key) => result.fields[key]?.value ?? null;

test.describe("amount reading", () => {
  test("reads every separator convention a Moroccan document uses", () => {
    const cases = [
      ["4 500,00", 4500], ["4.500,00", 4500], ["4,500.00", 4500], ["4500", 4500],
      ["7 542,76", 7542.76], ["75 000.00", 75000], ["83.33", 83.33], ["1 020,00", 1020],
      ["2 151 408 390", 2151408390],
    ];
    for (const [text, expected] of cases) {
      expect(parseDocumentAmount(text), `parsing ${text}`).toMatchObject({ value: expected });
    }
  });

  test("repairs a decimal group the scanner duplicated", () => {
    // "6 240.00.00" is what the recogniser returned for a printed 6 240,00.
    expect(parseDocumentAmount("6 240.00.00")).toMatchObject({ value: 6240, repairedDuplicateDecimals: true });
  });

  test("refuses identifiers, dates and percentages", () => {
    for (const text of ["003983471000077", "12/08/2026", "39/2026", "20%", "ICE"]) {
      expect(isAmountLike(text), `${text} must not read as an amount`).toBe(false);
    }
  });

  test("reads a negative total in either notation", () => {
    expect(parseDocumentAmount("-1 200,00")).toMatchObject({ value: -1200 });
    expect(parseDocumentAmount("(1 200,00)")).toMatchObject({ value: -1200 });
  });
});

test.describe("accounting validation", () => {
  test("accepts the statutory Moroccan rates", () => {
    for (const [rateBps, ht, tva] of [[2000, 1000, 200], [1400, 1000, 140], [1000, 1000, 100], [700, 1000, 70]]) {
      const evaluation = evaluateTotals({ HT: ht, TVA: tva, TTC: ht + tva }, rateBps);
      expect(evaluation.consistent, `${rateBps} bps`).toBe(true);
    }
  });

  test("fails a total that misses the sum of its printed parts", () => {
    const evaluation = evaluateTotals({ HT: 4216.07, TVA: 843.33, TTC: 5060 }, 2000);
    expect(evaluation.consistent).toBe(false);
    expect(evaluation.checks.find((check) => check.id === "total-is-sum-of-parts").status).toBe("FAILED");
    expect(evaluation.failedFields).toEqual(expect.arrayContaining(["HT", "TVA", "TTC"]));
  });

  test("rejects a VAT that equals its own base", () => {
    // The exact shape of the bug this suite exists for: HT and VAT identical.
    const evaluation = evaluateTotals({ HT: 4500, TVA: 4500, TTC: 9000 }, 2000);
    expect(evaluation.consistent).toBe(false);
    expect(evaluation.checks.find((check) => check.id === "vat-matches-rate").status).toBe("FAILED");
  });

  test("balances a total only once disbursements are added", () => {
    const evaluation = evaluateTotals({ HT: 4500, TVA: 900, TTC: 7542.76, DEBOURS: 2142.76 }, 2000);
    expect(evaluation.consistent).toBe(true);
    expect(evaluation.deboursAdditive).toBe(true);
  });

  test("balances a total after a discount", () => {
    const evaluation = evaluateTotals({ HT: 10000, TVA: 2000, TTC: 11500, DISCOUNT: 500 }, 2000);
    expect(evaluation.consistent).toBe(true);
  });

  test("invents nothing when only one amount was read", () => {
    const evaluation = evaluateTotals({ TTC: 1200 }, null);
    expect(evaluation.checks.find((check) => check.id === "total-is-sum-of-parts").status).toBe("SKIPPED");
  });
});

test.describe("supplier invoice with disbursements (SFKT141P26081319210)", () => {
  const company = { name: "ANOUAL HEALTH SOLUTIONS", ice: "003983471000077" };
  let result;
  test.beforeAll(() => { result = extract("scanned-invoice-debours-ifcof.json", { company }); });

  test("is classified as a purchase invoice for the open dossier", () => {
    expect(result.classification.type).toBe("INVOICE");
    expect(result.classification.direction).toBe("PURCHASE");
  });

  test("reads the invoice number behind the abbreviated label", () => {
    // "FACT°" is the whole label the document prints; the old vocabulary only
    // knew "facture" and left the field blank.
    expect(value(result, "invoiceNumber")).toBe("39/2026");
  });

  test("reads the invoice date", () => {
    expect(value(result, "date")).toBe("2026-08-12");
  });

  test("attributes each ICE to the party that printed it", () => {
    expect(result.parties.recipient.name).toBe("ANOUAL HEALTH SOLUTIONS");
    expect(result.parties.recipient.ice).toBe("003983471000077");
    expect(result.parties.issuer.ice).toBe("000187958000077");
    expect(result.parties.issuer.taxId).toBe("1110375");
    expect(result.parties.issuer.rc).toBe("193109");
    expect(result.parties.issuer.tp).toBe("32690363");
    expect(result.parties.issuer.cnss).toBe("7976361");
  });

  test("names the issuer from its own contact domain when the letterhead gives none", () => {
    expect(value(result, "supplier")).toBe("IFCOF");
    expect(result.fields.supplier.source).toBe("issuer/derived-from-domain");
    // Derived, not read: the confidence has to say so.
    expect(result.fields.supplier.confidence).toBeLessThan(72);
  });

  test("never names the supplier after the letterhead slogan", () => {
    for (const key of ["supplier", "counterparty", "client"]) {
      expect(String(value(result, key) ?? "")).not.toContain("Cabinet Comptable");
    }
  });

  test("reads the totals and the disbursements", () => {
    expect(value(result, "ht")).toBe(4500);
    expect(value(result, "tva")).toBe(900);
    expect(value(result, "ttc")).toBe(7542.76);
    expect(value(result, "debours")).toBe(2142.76);
    expect(value(result, "vatRate")).toBe(2000);
    expect(value(result, "currency")).toBe("MAD");
  });

  test("does not reproduce the reading that made VAT equal to HT", () => {
    expect(value(result, "tva")).not.toBe(4500);
    expect(value(result, "ttc")).not.toBe(9000);
  });

  test("the retained reading satisfies the document's own arithmetic", () => {
    expect(result.totals.evaluation.consistent).toBe(true);
    expect(result.totals.evaluation.deboursAdditive).toBe(true);
  });
});

test.describe("invoice whose totals column is printed below its labels (SFKT141P26081319260)", () => {
  let result;
  test.beforeAll(() => { result = extract("scanned-invoice-offset-totals-column.json"); });

  test("prefers the alignment that balances over the one that is merely closest", () => {
    expect(value(result, "ht")).toBe(5300);
    expect(value(result, "tva")).toBe(1060);
    expect(value(result, "ttc")).toBe(8915);
    expect(value(result, "debours")).toBe(2555);
    expect(result.totals.evaluation.consistent).toBe(true);
  });

  test("keeps the rejected alignment and why it lost", () => {
    const rejected = result.totals.alternatives.filter((alternative) => !alternative.consistent);
    expect(rejected.length).toBeGreaterThan(0);
    // The nearest-neighbour reading pairs "Total HT" with the disbursements
    // total; it is kept in the trace so a future mis-read is diagnosable.
    expect(result.totals.alternatives.some((alternative) => alternative.assignment.HT === 2555 && !alternative.consistent)).toBe(true);
  });

  test("reads the number, the date and both parties", () => {
    expect(value(result, "invoiceNumber")).toBe("34/2026");
    expect(value(result, "date")).toBe("2026-07-22");
    expect(result.parties.recipient.name).toBe("MARIS HOLDING");
    expect(result.parties.recipient.ice).toBe("001864713000017");
    expect(result.parties.issuer.taxId).toBe("1110375");
  });

  test("recovers an ICE whose label lost a letter to the scanner", () => {
    // The footer was recognised as "CE: 000187958000077 - RC: …".
    expect(result.parties.issuer.ice).toBe("000187958000077");
  });
});

test.describe("photographed invoice (COMADEB EZ-ZETOUNI)", () => {
  let result;
  test.beforeAll(() => { result = extract("photo-invoice-comadeb.json"); });

  test("separates the customer named on a labelled line from the issuer's footer", () => {
    expect(result.parties.recipient.name).toBe("RESTOPRO BOUSKORA");
    expect(result.parties.recipient.ice).toBe("000034157000037");
    expect(result.parties.issuer.name).toBe("COMADEB EZ-ZETOUNI");
    expect(result.parties.issuer.ice).toBe("002889661000036");
  });

  test("reads an invoice number that carries a slash", () => {
    expect(value(result, "invoiceNumber")).toBe("0001/2026");
  });

  test("reads a total whose decimals the recogniser duplicated", () => {
    expect(value(result, "ht")).toBe(5200);
    expect(value(result, "tva")).toBe(1040);
    expect(value(result, "ttc")).toBe(6240);
    expect(result.totals.evaluation.consistent).toBe(true);
  });

  test("never names a party after the amount written out in words", () => {
    expect(String(result.parties.issuer.name)).not.toMatch(/mille|dirhams/i);
  });
});

test.describe("photographed invoice whose HT was misread (SOCIETE LAKHOUILI)", () => {
  let result;
  test.beforeAll(() => { result = extract("photo-invoice-lakhouili.json"); });

  test("reads both parties and the invoice number", () => {
    expect(result.parties.issuer.name).toBe("SOCIETE LAKHOUILI sarl.");
    expect(result.parties.issuer.ice).toBe("000069016000035");
    expect(result.parties.recipient.name).toBe("LAHGAGCHA NEGOCE");
    expect(result.parties.recipient.ice).toBe("003377972000073");
    expect(value(result, "invoiceNumber")).toBe("00741/26");
  });

  test("flags the amounts instead of presenting a misread digit as certain", () => {
    // The document prints 4 216,67; recognition returned 4 216,07, so the
    // totals no longer add up. Wheat must say so rather than round it away.
    expect(result.totals.evaluation.consistent).toBe(false);
    expect(result.totals.evaluation.failedFields).toEqual(expect.arrayContaining(["HT", "TTC"]));
    expect(result.fields.ht.confidence).toBeLessThan(72);
    expect(result.fields.ttc.confidence).toBeLessThan(72);
  });
});

test.describe("a document that is not an invoice", () => {
  let result;
  test.beforeAll(() => { result = extract("scanned-bank-statement.json"); });

  test("is recognised as a bank statement", () => {
    expect(result.classification.type).toBe("BANK_STATEMENT");
    expect(result.classification.direction).toBeNull();
  });

  test("acquires no invoice amounts it cannot justify", () => {
    expect(value(result, "ht")).toBeNull();
    expect(value(result, "tva")).toBeNull();
    expect(value(result, "ttc")).toBeNull();
    expect(value(result, "invoiceNumber")).toBeNull();
  });
});

test.describe("layouts the recorded documents do not cover", () => {
  test("reads a sales invoice as a sale when the dossier is the issuer", () => {
    const pages = syntheticPage([
      [{ text: "ATLAS NEGOCE SARL", x: 120 }],
      [{ text: "ICE : 001111111000011", x: 120 }, { text: "IF : 4455667", x: 520 }, { text: "RC : 12345", x: 760 }],
      [{ text: "Client :", x: 120 }, { text: "BOUTIQUE ZERHOUNI", x: 300 }],
      [{ text: "ICE : 002222222000022", x: 300 }],
      [{ text: "FACTURE N°", x: 120 }, { text: "FA-2026-0007", x: 400 }],
      [{ text: "Date", x: 120 }, { text: "14/03/2026", x: 400 }],
      [{ text: "Total HT", x: 600 }, { text: "10 000,00", x: 900 }],
      [{ text: "TVA 14%", x: 600 }, { text: "1 400,00", x: 900 }],
      [{ text: "Total TTC", x: 600 }, { text: "11 400,00", x: 900 }],
    ]);
    const result = extractDocumentFields(pages, { fileName: "vente.png", company: { name: "ATLAS NEGOCE SARL", ice: "001111111000011" } });
    expect(result.classification.direction).toBe("SALE");
    expect(result.parties.issuer.isCurrentCompany).toBe(true);
    expect(value(result, "invoiceNumber")).toBe("FA-2026-0007");
    expect(value(result, "vatRate")).toBe(1400);
    expect(value(result, "ttc")).toBe(11400);
    // On a sale the third party is the customer, not the issuer.
    expect(value(result, "counterparty")).toBe("BOUTIQUE ZERHOUNI");
  });

  test("reads a discount line and still balances the total", () => {
    const pages = syntheticPage([
      [{ text: "FOURNITURES DU SUD SARL", x: 120 }],
      [{ text: "ICE : 003333333000033", x: 120 }, { text: "IF : 7788990", x: 520 }, { text: "TP : 11223344", x: 760 }],
      [{ text: "FACTURE N°", x: 120 }, { text: "2026-0142", x: 400 }],
      [{ text: "Date facture", x: 120 }, { text: "02/09/2026", x: 400 }],
      [{ text: "Total HT", x: 600 }, { text: "10 000,00", x: 900 }],
      [{ text: "Remise", x: 600 }, { text: "500,00", x: 900 }],
      [{ text: "TVA 20%", x: 600 }, { text: "2 000,00", x: 900 }],
      [{ text: "Total TTC", x: 600 }, { text: "11 500,00", x: 900 }],
    ]);
    const result = extractDocumentFields(pages, { fileName: "remise.png" });
    expect(value(result, "discount")).toBe(500);
    expect(value(result, "ttc")).toBe(11500);
    expect(value(result, "currency")).toBeNull();
    expect(result.totals.evaluation.consistent).toBe(true);
    // An invoice number that is only digits and dashes is still a number.
    expect(value(result, "invoiceNumber")).toBe("2026-0142");
  });

  test("does not mistake an identifier or a phone number for the invoice number", () => {
    const pages = syntheticPage([
      [{ text: "CABLES ET RESEAUX SARL", x: 120 }],
      [{ text: "Tel : 0522 44 94 56", x: 120 }],
      [{ text: "ICE : 004444444000044", x: 120 }, { text: "IF : 5566778", x: 520 }, { text: "CNSS : 9988776", x: 760 }],
      [{ text: "FACTURE", x: 120 }, { text: "F-2026/88", x: 400 }],
      [{ text: "Total HT", x: 600 }, { text: "1 000,00", x: 900 }],
      [{ text: "TVA 10%", x: 600 }, { text: "100,00", x: 900 }],
      [{ text: "Total TTC", x: 600 }, { text: "1 100,00", x: 900 }],
    ]);
    const result = extractDocumentFields(pages, { fileName: "identifiants.png" });
    expect(value(result, "invoiceNumber")).toBe("F-2026/88");
    expect(value(result, "vatRate")).toBe(1000);
  });

  test("keeps a low-confidence reading low-confidence", () => {
    const pages = syntheticPage([
      [{ text: "SOCIETE FLOUE SARL", x: 120, confidence: 41 }],
      [{ text: "ICE : 005555555000055", x: 120, confidence: 44 }, { text: "IF : 1212121", x: 520, confidence: 40 }],
      [{ text: "Total HT", x: 600, confidence: 38 }, { text: "1 000,00", x: 900, confidence: 39 }],
      [{ text: "TVA 20%", x: 600, confidence: 37 }, { text: "200,00", x: 900, confidence: 36 }],
      [{ text: "Total TTC", x: 600, confidence: 35 }, { text: "1 200,00", x: 900, confidence: 34 }],
    ]);
    const result = extractDocumentFields(pages, { fileName: "flou.png" });
    expect(result.totals.evaluation.consistent).toBe(true);
    // The arithmetic holds, but nothing was read clearly: the supplier name
    // must not come back looking certain.
    expect(result.fields.supplier.confidence).toBeLessThan(72);
  });

  test("reads a totals block printed with the value column half a line low", () => {
    const pages = syntheticPage([
      [{ text: "ENTREPRISE DECALEE SARL", x: 120 }],
      [{ text: "ICE : 006666666000066", x: 120 }, { text: "IF : 3434343", x: 520 }],
      [{ text: "Total HT", x: 600 }, { text: "2 000,00", x: 900, drop: 14 }],
      [{ text: "TVA 20%", x: 600 }, { text: "400,00", x: 900, drop: 14 }],
      [{ text: "Total TTC", x: 600 }, { text: "2 400,00", x: 900, drop: 14 }],
    ]);
    const result = extractDocumentFields(pages, { fileName: "decale.png" });
    expect(value(result, "ht")).toBe(2000);
    expect(value(result, "tva")).toBe(400);
    expect(value(result, "ttc")).toBe(2400);
  });
});

test.describe("documents without geometry", () => {
  test("reads a digital PDF text layer through the same engine", () => {
    const text = [
      "LS LUNA STEEL",
      "27 Lot Kadiria, 3ème étage, Lissasfa, Casablanca",
      "ICE : 003358098000067 • IF : 53977847 • TP : 36206946 • CNSS : 6043168 • RC : 597773",
      "FACTURE N° 25072026",
      "CLIENT",
      "CHANI MAROC",
      "252 ROUTE L OASIS Casablanca",
      "ICE : 003206387000051",
      "DATE DE FACTURE",
      "25/07/2026",
      "LIBELLÉ P.U. (DH) QTÉ MONTANT (DH)",
      "Pyjamas 83.33 1100 75 000.00",
      "Montant H.T 75 000.00",
      "T.V.A 20% 15 000.00",
      "Montant T.T.C 90 000.00",
    ].join("\n");
    const result = extractDocumentFields([{ page: 1, text, confidence: 93 }], { fileName: "luna.pdf" });
    expect(value(result, "invoiceNumber")).toBe("25072026");
    expect(value(result, "date")).toBe("2026-07-25");
    expect(value(result, "ht")).toBe(75000);
    expect(value(result, "tva")).toBe(15000);
    expect(value(result, "ttc")).toBe(90000);
    expect(result.parties.issuer.ice).toBe("003358098000067");
    expect(result.parties.recipient.ice).toBe("003206387000051");
    expect(result.parties.recipient.name).toBe("CHANI MAROC");
    expect(result.parties.recipient.address).toBe("252 ROUTE L OASIS Casablanca");
  });

  test("keeps one text line as one row so a packed footer still yields every identifier", () => {
    const layout = buildDocumentLayout([{ page: 1, text: "ICE : 000187958000077 - RC : 193109 - IF : 1110375", confidence: 90 }]);
    expect(layout.rows).toHaveLength(1);
    expect(layout.hasGeometry).toBe(false);
  });
});

test.describe("multi-page documents", () => {
  test("reads a total stated once at the end of a repeated header", () => {
    const header = [
      { text: "PAPETERIE CENTRALE SARL", x: 120 },
      { text: "ICE : 007777777000077", x: 520 },
    ];
    const page = (rows) => syntheticPage([header, ...rows])[0];
    const first = page([[{ text: "Article A", x: 120 }, { text: "100,00", x: 900 }]]);
    const second = page([
      [{ text: "Article B", x: 120 }, { text: "900,00", x: 900 }],
      [{ text: "Total HT", x: 600 }, { text: "1 000,00", x: 900 }],
      [{ text: "TVA 20%", x: 600 }, { text: "200,00", x: 900 }],
      [{ text: "Total TTC", x: 600 }, { text: "1 200,00", x: 900 }],
    ]);
    const result = extractDocumentFields([first, { ...second, page: 2 }], { fileName: "deux-pages.pdf" });
    expect(value(result, "ht")).toBe(1000);
    expect(value(result, "ttc")).toBe(1200);
    expect(result.totals.evaluation.consistent).toBe(true);
  });
});

test("every extraction records why it chose what it chose", () => {
  const result = extract("scanned-invoice-debours-ifcof.json");
  expect(result.trace.candidates.length).toBeGreaterThan(0);
  const accepted = result.trace.candidates.filter((candidate) => candidate.accepted);
  const rejected = result.trace.candidates.filter((candidate) => !candidate.accepted);
  expect(accepted.length).toBeGreaterThan(0);
  expect(rejected.length).toBeGreaterThan(0);
  for (const candidate of result.trace.candidates) expect(candidate.reason).toBeTruthy();
});
