import { createHash } from "node:crypto";

export type CreditNotePdfLine = {
  position: number;
  description: string;
  htCents: string;
  vatCents: string;
  ttcCents: string;
};

export type CreditNotePdfSnapshot = {
  company: { name: string; legalForm?: string | null; ice?: string | null; taxId?: string | null; city?: string | null };
  creditNote: {
    invoiceNo: string;
    invoiceDate: string;
    kind: string;
    currency: string;
    counterpartyName: string;
    counterpartyIce?: string | null;
    creditReason: string;
    htCents: string;
    vatCents: string;
    ttcCents: string;
  };
  originalInvoice?: { invoiceNo: string; invoiceDate: string } | null;
  entry: { number: string };
  lines: CreditNotePdfLine[];
  payloadSha256: string;
  documentTitle?: string;
  reasonLabel?: string;
};

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const ROWS_PER_PAGE = 24;

function latin1(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

function pdfText(value: unknown) {
  return latin1(value).replace(/([\\()])/g, "\\$1");
}

function truncate(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(1, maximum - 3))}...`;
}

export function formatExactCents(centsValue: string, currency = "MAD") {
  const cents = BigInt(centsValue);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped},${fraction} ${currency}`;
}

function textCommand(x: number, y: number, value: unknown, options: { bold?: boolean; size?: number } = {}) {
  const font = options.bold ? "F2" : "F1";
  const size = options.size ?? 9;
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET`;
}

function pageContent(snapshot: CreditNotePdfSnapshot, pageLines: CreditNotePdfLine[], pageIndex: number, pageCount: number) {
  const currency = snapshot.creditNote.currency;
  const commands: string[] = [
    "0.12 0.25 0.42 rg",
    "48 775 499 38 re f",
    "1 1 1 rg",
    textCommand(62, 789, snapshot.documentTitle ?? "WHEAT - AVOIR", { bold: true, size: 17 }),
    textCommand(438, 789, snapshot.creditNote.invoiceNo, { bold: true, size: 10 }),
    "0.08 0.12 0.18 rg",
    textCommand(48, 751, `${snapshot.company.name}${snapshot.company.legalForm ? ` - ${snapshot.company.legalForm}` : ""}`, { bold: true, size: 12 }),
    textCommand(48, 735, `ICE: ${snapshot.company.ice ?? "-"}   IF: ${snapshot.company.taxId ?? "-"}   Ville: ${snapshot.company.city ?? "-"}`, { size: 8 }),
    textCommand(48, 706, `Client / fournisseur: ${snapshot.creditNote.counterpartyName}`, { bold: true, size: 10 }),
    textCommand(48, 691, `ICE tiers: ${snapshot.creditNote.counterpartyIce ?? "-"}`),
    textCommand(335, 706, `Date de l'avoir: ${snapshot.creditNote.invoiceDate}`),
    ...(snapshot.originalInvoice ? [textCommand(335, 691, `Facture d'origine: ${snapshot.originalInvoice.invoiceNo}`)] : []),
    textCommand(48, 665, `${snapshot.reasonLabel ?? "Motif"}: ${truncate(snapshot.creditNote.creditReason, 105)}`, { size: 8 }),
    "0.88 0.91 0.95 rg",
    "48 636 499 23 re f",
    "0.08 0.12 0.18 rg",
    textCommand(55, 644, "Description", { bold: true, size: 8 }),
    textCommand(345, 644, "HT", { bold: true, size: 8 }),
    textCommand(421, 644, "TVA", { bold: true, size: 8 }),
    textCommand(492, 644, "TTC", { bold: true, size: 8 }),
  ];

  pageLines.forEach((line, index) => {
    const y = 620 - index * 20;
    if (index % 2 === 1) {
      commands.push("0.97 0.98 0.99 rg", `48 ${y - 5} 499 20 re f`, "0.08 0.12 0.18 rg");
    }
    commands.push(
      textCommand(55, y, `${line.position}. ${truncate(line.description, 51)}`, { size: 7.5 }),
      textCommand(345, y, formatExactCents(line.htCents, currency), { size: 7 }),
      textCommand(421, y, formatExactCents(line.vatCents, currency), { size: 7 }),
      textCommand(492, y, formatExactCents(line.ttcCents, currency), { size: 7 }),
    );
  });

  if (pageIndex === pageCount - 1) {
    commands.push(
      "0.12 0.25 0.42 RG 0.8 w",
      "320 103 m 547 103 l S",
      "0.08 0.12 0.18 rg",
      textCommand(336, 88, "Total HT", { bold: true, size: 9 }),
      textCommand(450, 88, formatExactCents(snapshot.creditNote.htCents, currency), { bold: true, size: 9 }),
      textCommand(336, 70, "Total TVA", { bold: true, size: 9 }),
      textCommand(450, 70, formatExactCents(snapshot.creditNote.vatCents, currency), { bold: true, size: 9 }),
      "0.12 0.25 0.42 rg",
      "320 34 227 27 re f",
      "1 1 1 rg",
      textCommand(336, 43, "Total TTC", { bold: true, size: 10 }),
      textCommand(450, 43, formatExactCents(snapshot.creditNote.ttcCents, currency), { bold: true, size: 10 }),
    );
  }

  commands.push(
    "0.35 0.39 0.45 rg",
    textCommand(48, 21, `Ecriture: ${snapshot.entry.number} | Empreinte: ${snapshot.payloadSha256.slice(0, 24)}... | Page ${pageIndex + 1}/${pageCount}`, { size: 6.5 }),
  );
  return Buffer.from(commands.join("\n"), "latin1");
}

/**
 * Builds a deterministic, dependency-free PDF. Identical evidence snapshots
 * always produce identical bytes; no wall-clock timestamp or random file ID is
 * embedded in the document.
 */
export function generateCreditNotePdf14(snapshot: CreditNotePdfSnapshot): Buffer {
  if (!snapshot.lines.length) throw new Error("L'avoir ne contient aucune ligne à imprimer.");
  const pages: CreditNotePdfLine[][] = [];
  for (let offset = 0; offset < snapshot.lines.length; offset += ROWS_PER_PAGE) {
    pages.push(snapshot.lines.slice(offset, offset + ROWS_PER_PAGE));
  }

  const pageObjectIds = pages.map((_, index) => 5 + index * 2);
  const objects = new Map<number, Buffer>();
  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"));
  objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`, "ascii"));
  objects.set(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "ascii"));
  objects.set(4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>", "ascii"));

  pages.forEach((lines, index) => {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    const stream = pageContent(snapshot, lines, index, pages.length);
    objects.set(pageId, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`, "ascii"));
    objects.set(contentId, Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("\nendstream", "ascii"),
    ]));
  });

  const maxObjectId = Math.max(...objects.keys());
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = new Array<number>(maxObjectId + 1).fill(0);
  let offset = chunks[0].length;
  for (let id = 1; id <= maxObjectId; id += 1) {
    const object = objects.get(id);
    if (!object) throw new Error("La structure PDF de l'avoir est incomplète.");
    offsets[id] = offset;
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii")]);
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xrefOffset = offset;
  const xref = ["xref", `0 ${maxObjectId + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= maxObjectId; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  const trailer = `${xref.join("\n")}\ntrailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "ascii"));
  return Buffer.concat(chunks);
}

export function sha256Hex14(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
