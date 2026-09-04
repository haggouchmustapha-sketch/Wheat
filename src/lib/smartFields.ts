/**
 * The fields Wheat reads off a document, and how the correction screen shows
 * them.
 *
 * This module exists because the renderer used to keep its own closed list of
 * field names. The extraction pipeline would read a field, store it on the
 * document, and the one screen built for correcting extractions would neither
 * display it nor let anybody fix it — Débours being the case that made the
 * consequence concrete, since the draft planner needs it to balance
 * HT + TVA + débours = TTC and refuses the invoice without it.
 *
 * The rule here is that the extraction decides what exists and this module only
 * decides how it is ordered, labelled, and converted for a text input. A field
 * the recogniser learns to read tomorrow shows up on its own.
 */

/**
 * Display order. Every field either extractor can produce appears here; a key
 * absent from this list is still kept and shown, just after the ordered ones.
 */
export const smartFieldOrder = [
  "date", "invoiceNumber", "reference", "dueDate", "paymentTerms",
  "counterparty", "supplier", "client",
  "ice", "if", "supplierRc", "supplierTp", "supplierCnss", "clientIce", "clientIf",
  "ht", "tva", "vatRate", "debours", "discount", "ttc", "netPaid", "stamp", "currency",
  "employee", "gross", "cnss", "amo", "ir", "net",
];

export const smartFieldLabels: Record<string, string> = {
  date: "Date",
  invoiceNumber: "N facture",
  reference: "Reference",
  counterparty: "Tiers",
  supplier: "Fournisseur",
  client: "Client",
  ice: "ICE",
  if: "IF",
  supplierRc: "RC fournisseur",
  supplierTp: "TP fournisseur",
  supplierCnss: "CNSS fournisseur",
  clientIce: "ICE client",
  clientIf: "IF client",
  ht: "HT",
  tva: "TVA",
  vatRate: "Taux de TVA (%)",
  debours: "Débours",
  discount: "Remise",
  ttc: "TTC",
  netPaid: "Net à payer",
  stamp: "Timbre",
  paymentTerms: "Paiement",
  dueDate: "Échéance",
  currency: "Devise",
  employee: "Employe",
  gross: "Brut",
  cnss: "CNSS",
  amo: "AMO",
  ir: "IR",
  net: "Net",
};

/**
 * Fields offered for entry even when the recogniser read nothing there, per
 * document type. A blank box the accountant can fill is the difference between
 * "Wheat missed the débours" and "Wheat cannot record a débours".
 */
export const smartFieldCore: Record<string, string[]> = {
  INVOICE: [
    "date", "invoiceNumber", "reference", "dueDate", "paymentTerms",
    "counterparty", "supplier", "client", "ice", "if",
    "ht", "tva", "vatRate", "debours", "discount", "ttc", "netPaid", "currency",
  ],
  RECEIPT: ["date", "reference", "counterparty", "ht", "tva", "ttc", "netPaid", "currency"],
  PAYROLL: ["date", "employee", "gross", "cnss", "amo", "ir", "net", "currency"],
};

export const smartFieldCoreFallback = ["date", "reference", "counterparty", "currency"];

/**
 * Which boxes this document gets: the core set for its type, plus every field
 * the extraction actually carries, in display order, with anything unrecognised
 * appended rather than dropped.
 */
export function visibleSmartFields(fields: Record<string, unknown>, documentType: string) {
  const core = smartFieldCore[documentType] ?? smartFieldCoreFallback;
  const present = Object.keys(fields ?? {});
  const wanted = new Set<string>([...core, ...present]);
  const ordered = smartFieldOrder.filter((key) => wanted.has(key));
  const extra = present.filter((key) => !smartFieldOrder.includes(key)).sort();
  return [...ordered, ...extra];
}

/**
 * `vatRate` is carried through the whole pipeline in basis points — 2000 is
 * 20 % — because that is what `documentInvoiceDraft.ts` reads back when it
 * plans the entry. Showing a person "2000" in a box labelled "Taux de TVA"
 * invites them to correct it to "20", which the planner would then read as
 * 0,2 %. The conversion belongs here, at the edge, in both directions.
 */
export function smartFieldToInput(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (key === "vatRate") {
    const bps = Number(value);
    if (!Number.isFinite(bps)) return String(value);
    return String(Number((bps / 100).toFixed(2)));
  }
  return String(value);
}

export function smartFieldFromInput(key: string, value: string): unknown {
  const text = value.trim();
  if (key === "vatRate") {
    if (!text) return null;
    const percent = Number(text.replace(",", "."));
    if (!Number.isFinite(percent)) return value;
    return Math.round(percent * 100);
  }
  return value;
}

export function readSmartFields(extracted: any) {
  return extracted?.fields ?? {
    date: extracted?.date ?? "",
    invoiceNumber: extracted?.invoiceNumber ?? extracted?.invoiceNo ?? "",
    reference: extracted?.reference ?? "",
    counterparty: extracted?.counterparty ?? "",
    supplier: extracted?.supplier ?? extracted?.counterparty ?? "",
    client: extracted?.client ?? "",
    ice: extracted?.ice ?? "",
    if: extracted?.if ?? extracted?.taxId ?? "",
    ht: extracted?.ht ?? "",
    tva: extracted?.tva ?? extracted?.vat ?? "",
    ttc: extracted?.ttc ?? "",
    debours: extracted?.debours ?? "",
    discount: extracted?.discount ?? "",
    netPaid: extracted?.netPaid ?? "",
    paymentTerms: extracted?.paymentTerms ?? extracted?.paymentMethod ?? "",
    dueDate: extracted?.dueDate ?? "",
    currency: extracted?.currency ?? "MAD",
  };
}

export function readSmartType(extracted: any, fallback: string) {
  if (extracted?.documentType) return extracted.documentType;
  const lower = String(fallback ?? "").toLowerCase();
  if (lower.includes("fact")) return "INVOICE";
  if (lower.includes("banc") || lower.includes("relevé")) return "BANK_STATEMENT";
  if (lower.includes("paie")) return "PAYROLL";
  if (lower.includes("fisc")) return "TAX";
  return "UNKNOWN";
}

/**
 * The editable snapshot of an extraction.
 *
 * Every key the document carries is kept, whether or not this screen has a
 * label for it, so that saving a correction can never be the act that loses a
 * field. `keys` decides what is rendered; this decides what is held.
 */
export function stringifyFields(fields: Record<string, unknown>, keys: string[]) {
  const all = new Set<string>([...keys, ...Object.keys(fields ?? {})]);
  return Object.fromEntries([...all].map((key) => [key, smartFieldToInput(key, fields?.[key])]));
}
