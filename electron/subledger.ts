import { randomUUID } from "node:crypto";
import { assertCreditNoteTechnicalVoidBlocked14, createImmutablePostedInvoiceArtifact14 } from "./creditNotes14";
import {
  ENTRY_STATUS,
  optionalText,
  parseAccountingDate,
  provisionalEntryNumber,
  rendererSerialize,
  requireId,
  requireText,
} from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { allocatePieceNumber } from "./pieceNumbering21";
import { normalizeAccountSearch } from "./chartOfAccounts21";

export const SUBLEDGER_IPC_CHANNELS = {
  counterpartyList: "wheat:counterparty:list",
  counterpartyCreate: "wheat:counterparty:create",
  counterpartyUpdate: "wheat:counterparty:update",
  counterpartyArchive: "wheat:counterparty:archive",
  counterpartyRestore: "wheat:counterparty:restore",
  invoiceList: "wheat:invoice:list",
  invoiceCreate: "wheat:invoice:create",
  invoiceUpdate: "wheat:invoice:update",
  invoiceDeleteDraft: "wheat:invoice:delete-draft",
  invoicePost: "wheat:invoice:post",
  invoiceVoid: "wheat:invoice:void",
  invoiceSettlement: "wheat:invoice:settlement",
  paymentList: "wheat:payment:list",
  paymentCreate: "wheat:payment:create",
  paymentUpdate: "wheat:payment:update",
  paymentDeleteDraft: "wheat:payment:delete-draft",
  paymentPost: "wheat:payment:post",
  paymentVoid: "wheat:payment:void",
  paymentAllocate: "wheat:payment:allocate",
  paymentReverseAllocation: "wheat:payment:reverse-allocation",
} as const;

export const SUBLEDGER_STATUS = {
  draft: "DRAFT",
  posted: "POSTED",
  void: "VOIDED",
} as const;

const COUNTERPARTY_KINDS = new Set(["CUSTOMER", "SUPPLIER", "BOTH"]);
const INVOICE_KINDS = new Set(["SALE", "PURCHASE"]);
const PAYMENT_KINDS = new Set(["RECEIPT", "DISBURSEMENT"]);
const SUBLEDGER_LIFECYCLE_STATUSES = new Set([SUBLEDGER_STATUS.draft, SUBLEDGER_STATUS.posted, SUBLEDGER_STATUS.void, "LEGACY"]);
const SUBLEDGER_PAGE_DEFAULT = 50;
const SUBLEDGER_PAGE_MAX = 100;
const SUBLEDGER_CURSOR_MAX_LENGTH = 2_048;
const MAX_SIGNED_64 = 2n ** 63n - 1n;

type PrismaLike = Record<string, any> & {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type GetPrisma = () => PrismaLike | Promise<PrismaLike>;

type RegisterableIpc = {
  handle(channel: string, listener: (event: unknown, payload?: any) => any): unknown;
};

export type SubledgerRegistrationOptions = {
  ipcMain: RegisterableIpc;
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  serialize?: (value: any) => any;
  now?: () => Date;
};

type ServiceOptions = {
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  now?: () => Date;
};

type InvoiceSettlementInput = {
  ttcCents: bigint;
  dueDate: Date | string | null;
  lifecycleStatus: string;
  allocations?: Array<{
    amountCents: bigint;
    status: string;
    payment?: { lifecycleStatus: string; paymentDate: Date | string } | null;
  }>;
  creditNotes?: Array<{
    ttcCents: bigint;
    lifecycleStatus: string;
    invoiceDate?: Date | string;
  }>;
};

export type InvoiceSettlement = {
  paymentAllocatedCents: bigint;
  creditedCents: bigint;
  allocatedCents: bigint;
  balanceCents: bigint;
  settlementStatus: "DRAFT" | "VOIDED" | "UNPAID" | "OVERDUE" | "PARTIALLY_PAID" | "PARTIALLY_PAID_OVERDUE" | "PAID" | "PAID_LATE" | "OVERPAID";
  paidAt: Date | null;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  return value as Record<string, unknown>;
}

function exactInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function expectedVersion(value: unknown): number {
  return exactInteger(value, "La version attendue", 1, 2_147_483_647);
}

function pageLimit(input: Record<string, unknown>): number {
  return exactInteger(input.limit ?? input.take ?? SUBLEDGER_PAGE_DEFAULT, "La limite de page", 1, SUBLEDGER_PAGE_MAX);
}

function encodePageCursor(type: string, values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, type, ...values }), "utf8").toString("base64url");
}

function decodePageCursor(value: unknown, type: string): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return null;
  const encoded = requireText(value, "Le curseur", SUBLEDGER_CURSOR_MAX_LENGTH);
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const cursor = record(JSON.parse(decoded), "Le curseur");
    if (cursor.v !== 1 || cursor.type !== type) throw new Error("scope");
    return cursor;
  } catch {
    throw new Error("Le curseur de page est invalide ou ne correspond plus aux filtres actifs.");
  }
}

function cursorText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Le curseur (${label}) est invalide.`);
  return value;
}

function cursorBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Le curseur (${label}) est invalide.`);
  return value;
}

function cursorDate(value: unknown, label: string): Date {
  const raw = cursorText(value, label, 40);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) throw new Error(`Le curseur (${label}) est invalide.`);
  return parsed;
}

function pageEnvelope<T>(rows: T[], limit: number, totalCount: number, cursorFor: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore && items.length ? cursorFor(items[items.length - 1]) : null,
    hasMore,
    limit,
    totalCount,
  };
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("La valeur oui/non est invalide.");
  return value;
}

function enumValue(value: unknown, label: string, allowed: Set<string>, aliases: Record<string, string> = {}): string {
  const raw = requireText(value, label, 40).toUpperCase();
  const normalized = aliases[raw] ?? raw;
  if (!allowed.has(normalized)) throw new Error(`${label} est invalide.`);
  return normalized;
}

function currencyValue(value: unknown, fallback = "MAD"): string {
  const currency = value === undefined || value === null || value === "" ? fallback : requireText(value, "La devise", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("La devise doit utiliser un code ISO de trois lettres.");
  return currency;
}

/**
 * Converts a decimal string directly to integer cents. JavaScript numbers are
 * intentionally rejected so accounting values never pass through binary float.
 */
export function strictDecimalToCents(value: unknown, label = "Le montant", allowZero = true): bigint {
  if (typeof value === "number") {
    throw new Error(`${label} doit être transmis sous forme de texte décimal, jamais comme nombre flottant.`);
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SIGNED_64) throw new Error(`${label} est hors limites.`);
    if (!allowZero && value === 0n) throw new Error(`${label} doit être strictement positif.`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${label} est obligatoire sous forme de texte décimal.`);
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${label} doit être un montant positif avec au plus deux décimales.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents > MAX_SIGNED_64) throw new Error(`${label} est hors limites.`);
  if (!allowZero && cents === 0n) throw new Error(`${label} doit être strictement positif.`);
  return cents;
}

function optionalMoney(value: unknown, label: string): bigint | null {
  return value === undefined || value === null || value === "" ? null : strictDecimalToCents(value, label);
}

export function quantityToMilli(value: unknown, label: string): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d+(?:[.,]\d{1,3})?$/.test(value.trim())) {
    throw new Error(`${label} doit être un texte décimal positif avec au plus trois décimales.`);
  }
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  const milli = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0") || "0");
  if (milli > MAX_SIGNED_64) throw new Error(`${label} est hors limites.`);
  return milli;
}

function canonicalText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function counterpartyIdentityKey(input: { displayName: string; ice?: string | null; taxId?: string | null }): string {
  const ice = canonicalText(input.ice ?? "").replace(/\s/g, "");
  if (ice) return `ICE:${ice}`;
  const taxId = canonicalText(input.taxId ?? "").replace(/\s/g, "");
  if (taxId) return `TAX:${taxId}`;
  const name = canonicalText(input.displayName);
  if (!name) throw new Error("Le nom du tiers ne permet pas de créer une identité stable.");
  return `NAME:${name}`;
}

function invoiceNumberKey(kind: string, counterpartyId: string, invoiceNo: string): string {
  const number = canonicalText(invoiceNo).replace(/\s/g, "");
  if (!number) throw new Error("Le numéro de facture est invalide.");
  return kind === "PURCHASE" ? `PURCHASE:${counterpartyId}:${number}` : `SALE:${number}`;
}

function paymentKindForInvoice(kind: string): string {
  return kind === "SALE" ? "RECEIPT" : "DISBURSEMENT";
}

function counterpartySupports(counterpartyKind: string, invoiceKind: string): boolean {
  return counterpartyKind === "BOTH" || (invoiceKind === "SALE" ? counterpartyKind === "CUSTOMER" : counterpartyKind === "SUPPLIER");
}

export function deriveInvoiceSettlement(invoice: InvoiceSettlementInput, asOf = new Date()): InvoiceSettlement {
  if (invoice.ttcCents < 0n) throw new Error("Le total TTC de la facture ne peut pas être négatif.");
  if (invoice.lifecycleStatus === SUBLEDGER_STATUS.draft) {
    return { paymentAllocatedCents: 0n, creditedCents: 0n, allocatedCents: 0n, balanceCents: invoice.ttcCents, settlementStatus: "DRAFT", paidAt: null };
  }
  if (invoice.lifecycleStatus === SUBLEDGER_STATUS.void) {
    return { paymentAllocatedCents: 0n, creditedCents: 0n, allocatedCents: 0n, balanceCents: 0n, settlementStatus: "VOIDED", paidAt: null };
  }

  let paymentAllocatedCents = 0n;
  let creditedCents = 0n;
  let paidAt: Date | null = null;
  for (const allocation of invoice.allocations ?? []) {
    const payment = allocation.payment;
    if (allocation.status !== "ACTIVE" || !payment || ![SUBLEDGER_STATUS.posted, "LEGACY"].includes(payment.lifecycleStatus)) continue;
    if (allocation.amountCents <= 0n) throw new Error("Une imputation active contient un montant invalide.");
    paymentAllocatedCents += allocation.amountCents;
    const paymentDate = new Date(payment.paymentDate);
    if (Number.isNaN(paymentDate.getTime())) throw new Error("Une imputation contient une date de paiement invalide.");
    if (!paidAt || paymentDate > paidAt) paidAt = paymentDate;
  }

  for (const creditNote of invoice.creditNotes ?? []) {
    if (creditNote.lifecycleStatus !== SUBLEDGER_STATUS.posted) continue;
    if (creditNote.ttcCents <= 0n) throw new Error("Un avoir comptabilisé contient un montant invalide.");
    creditedCents += creditNote.ttcCents;
    if (creditNote.invoiceDate) {
      const creditDate = new Date(creditNote.invoiceDate);
      if (Number.isNaN(creditDate.getTime())) throw new Error("Un avoir contient une date invalide.");
      if (!paidAt || creditDate > paidAt) paidAt = creditDate;
    }
  }

  const allocatedCents = paymentAllocatedCents + creditedCents;
  const rawBalance = invoice.ttcCents - allocatedCents;
  const balanceCents = rawBalance > 0n ? rawBalance : 0n;
  const dueDate = invoice.dueDate === null ? null : new Date(invoice.dueDate);
  if (dueDate && Number.isNaN(dueDate.getTime())) throw new Error("La date d'échéance est invalide.");
  const asOfDay = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const dueDay = dueDate ? Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate()) : null;
  const overdue = dueDay !== null && asOfDay > dueDay;
  let settlementStatus: InvoiceSettlement["settlementStatus"];
  if (allocatedCents > invoice.ttcCents) settlementStatus = "OVERPAID";
  else if (balanceCents === 0n) settlementStatus = dueDate && paidAt && paidAt.getTime() > dueDate.getTime() ? "PAID_LATE" : "PAID";
  else if (allocatedCents > 0n) settlementStatus = overdue ? "PARTIALLY_PAID_OVERDUE" : "PARTIALLY_PAID";
  else settlementStatus = overdue ? "OVERDUE" : "UNPAID";
  return { paymentAllocatedCents, creditedCents, allocatedCents, balanceCents, settlementStatus, paidAt: balanceCents === 0n ? paidAt : null };
}

function normalizeCounterpartyPayload(payload: unknown) {
  const input = record(payload, "Les données du tiers");
  const displayName = requireText(input.displayName, "Le nom du tiers", 250);
  const kind = enumValue(input.kind, "Le type de tiers", COUNTERPARTY_KINDS, {
    CLIENT: "CUSTOMER",
    VENDOR: "SUPPLIER",
    FOURNISSEUR: "SUPPLIER",
  });
  const ice = optionalText(input.ice, 40);
  const taxId = optionalText(input.taxId, 60);
  return {
    companyId: requireId(input.companyId, "La société"),
    kind,
    displayName,
    legalName: optionalText(input.legalName, 250),
    ice,
    taxId,
    email: optionalText(input.email, 250),
    phone: optionalText(input.phone, 80),
    address: optionalText(input.address, 500),
    city: optionalText(input.city, 120),
    identityKey: counterpartyIdentityKey({ displayName, ice, taxId }),
    defaultReceivableAccountId: input.defaultReceivableAccountId ? requireId(input.defaultReceivableAccountId, "Le compte client") : null,
    defaultPayableAccountId: input.defaultPayableAccountId ? requireId(input.defaultPayableAccountId, "Le compte fournisseur") : null,
    paymentTermsDays: input.paymentTermsDays === undefined ? 30 : exactInteger(input.paymentTermsDays, "Le délai de paiement", 0, 3_650),
    active: optionalBoolean(input.active, true),
  };
}

type NormalizedInvoiceLine = {
  position: number;
  description: string;
  accountId: string;
  quantityMilli: bigint | null;
  unitPriceCents: bigint | null;
  discountCents: bigint;
  vatRateBps: number | null;
  taxRateDefinitionId: string | null;
  htCents: bigint;
  vatCents: bigint;
  ttcCents: bigint;
};

function normalizeInvoiceLines(value: unknown): NormalizedInvoiceLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new Error("Une facture doit contenir entre 1 et 500 lignes.");
  }
  return value.map((raw, index) => {
    const line = record(raw, `La ligne ${index + 1}`);
    const htCents = strictDecimalToCents(line.ht, `Le montant HT de la ligne ${index + 1}`);
    const vatCents = strictDecimalToCents(line.vat ?? "0", `La TVA de la ligne ${index + 1}`);
    const ttcCents = line.ttc === undefined || line.ttc === null || line.ttc === ""
      ? htCents + vatCents
      : strictDecimalToCents(line.ttc, `Le montant TTC de la ligne ${index + 1}`);
    if (ttcCents !== htCents + vatCents) throw new Error(`Le TTC de la ligne ${index + 1} doit être égal au HT plus la TVA.`);
    if (ttcCents === 0n) throw new Error(`La ligne ${index + 1} doit comporter un montant.`);
    const vatRateBps = line.vatRateBps === undefined || line.vatRateBps === null
      ? null
      : exactInteger(line.vatRateBps, `Le taux de TVA de la ligne ${index + 1}`, 0, 10_000);
    return {
      position: index + 1,
      description: requireText(line.description, `Le libellé de la ligne ${index + 1}`, 500),
      accountId: requireId(line.accountId, `Le compte de la ligne ${index + 1}`),
      quantityMilli: quantityToMilli(line.quantity, `La quantité de la ligne ${index + 1}`),
      unitPriceCents: optionalMoney(line.unitPrice, `Le prix unitaire de la ligne ${index + 1}`),
      discountCents: strictDecimalToCents(line.discount ?? "0", `La remise de la ligne ${index + 1}`),
      vatRateBps,
      taxRateDefinitionId: line.taxRateDefinitionId ? requireId(line.taxRateDefinitionId, `La règle de TVA de la ligne ${index + 1}`) : null,
      htCents,
      vatCents,
      ttcCents,
    };
  });
}

function normalizeInvoicePayload(payload: unknown) {
  const input = record(payload, "Les données de la facture");
  const kind = enumValue(input.kind, "Le type de facture", INVOICE_KINDS, {
    SALES: "SALE",
    VENTE: "SALE",
    ACHAT: "PURCHASE",
  });
  const invoiceDate = parseAccountingDate(input.invoiceDate, "La date de facture");
  const dueDate = input.dueDate === null || input.dueDate === undefined || input.dueDate === ""
    ? null
    : parseAccountingDate(input.dueDate, "La date d'échéance");
  if (dueDate && dueDate < invoiceDate) throw new Error("La date d'échéance ne peut pas précéder la date de facture.");
  const lines = normalizeInvoiceLines(input.lines);
  const htCents = lines.reduce((sum, line) => sum + line.htCents, 0n);
  const vatCents = lines.reduce((sum, line) => sum + line.vatCents, 0n);
  const ttcCents = lines.reduce((sum, line) => sum + line.ttcCents, 0n);
  for (const [field, total, label] of [
    [input.ht, htCents, "Le total HT"],
    [input.vat, vatCents, "Le total de TVA"],
    [input.ttc, ttcCents, "Le total TTC"],
  ] as const) {
    if (field !== undefined && field !== null && field !== "" && strictDecimalToCents(field, label) !== total) {
      throw new Error(`${label} ne correspond pas à la somme des lignes.`);
    }
  }
  return {
    companyId: requireId(input.companyId, "La société"),
    counterpartyId: requireId(input.counterpartyId, "Le tiers"),
    kind,
    invoiceNo: optionalText(input.invoiceNo, 100),
    series: optionalText(input.series, 20)?.toUpperCase() ?? (kind === "SALE" ? "FA" : null),
    invoiceDate,
    dueDate,
    currency: currencyValue(input.currency),
    paymentMethod: optionalText(input.paymentMethod, 80),
    notes: optionalText(input.notes, 2_000),
    controlAccountId: input.controlAccountId ? requireId(input.controlAccountId, "Le compte collectif") : null,
    vatAccountId: input.vatAccountId ? requireId(input.vatAccountId, "Le compte de TVA") : null,
    taxConfigurationVersionId: input.taxConfigurationVersionId ? requireId(input.taxConfigurationVersionId, "La configuration fiscale") : null,
    lines,
    htCents,
    vatCents,
    ttcCents,
  };
}

async function resolveInvoiceTaxConfiguration(tx: any, normalized: ReturnType<typeof normalizeInvoicePayload>) {
  const requiresTaxRule = normalized.lines.some((line) => line.vatCents > 0n);
  if (!normalized.taxConfigurationVersionId) {
    return {
      configuration: null,
      lines: normalized.lines.map((line) => ({
        ...line,
        taxRateDefinitionId: null,
        taxRateCodeSnapshot: null,
        taxRateLabelSnapshot: null,
        taxRateDirectionSnapshot: null,
        taxConfigurationRevisionSnapshot: null,
      })),
      requiresTaxReview: requiresTaxRule,
    };
  }
  const configuration = await tx.taxConfigurationVersion.findFirst({
    where: { id: normalized.taxConfigurationVersionId, companyId: normalized.companyId },
    include: { rates: true },
  });
  if (!configuration || configuration.status !== "ACTIVE") throw new Error("La configuration TVA sélectionnée n'est pas active dans cette société.");
  if (configuration.effectiveFrom > normalized.invoiceDate || (configuration.effectiveTo && configuration.effectiveTo < normalized.invoiceDate)) {
    throw new Error("La configuration TVA sélectionnée ne couvre pas la date de facture.");
  }
  const rates = new Map(configuration.rates.filter((rate: any) => rate.active).map((rate: any) => [rate.id, rate]));
  const expectedDirection = normalized.kind === "SALE" ? "COLLECTED" : "DEDUCTIBLE";
  const lines = normalized.lines.map((line, index) => {
    if (!line.taxRateDefinitionId) {
      if (line.vatCents > 0n) throw new Error(`Sélectionnez le taux de TVA de la ligne ${index + 1}.`);
      return {
        ...line,
        taxRateDefinitionId: null,
        taxRateCodeSnapshot: null,
        taxRateLabelSnapshot: null,
        taxRateDirectionSnapshot: null,
        taxConfigurationRevisionSnapshot: configuration.revision,
      };
    }
    const rate = rates.get(line.taxRateDefinitionId) as any;
    if (!rate) throw new Error(`La règle de TVA de la ligne ${index + 1} n'appartient pas à la configuration active.`);
    if (rate.direction !== "BOTH" && rate.direction !== expectedDirection) throw new Error(`Le sens du taux ${rate.code} ne correspond pas à cette facture.`);
    if (line.vatRateBps !== null && line.vatRateBps !== rate.rateBps) throw new Error(`Le taux de la ligne ${index + 1} ne correspond pas à la règle ${rate.code}.`);
    const expectedVatCents = (line.htCents * BigInt(rate.rateBps) + 5_000n) / 10_000n;
    if (line.vatCents !== expectedVatCents) {
      throw new Error(`La TVA de la ligne ${index + 1} doit être ${expectedVatCents.toString()} centimes selon le taux ${rate.label}.`);
    }
    return {
      ...line,
      vatRateBps: rate.rateBps,
      taxRateDefinitionId: rate.id,
      taxRateCodeSnapshot: rate.code,
      taxRateLabelSnapshot: rate.label,
      taxRateDirectionSnapshot: rate.direction,
      taxConfigurationRevisionSnapshot: configuration.revision,
    };
  });
  return { configuration, lines, requiresTaxReview: false };
}

async function validateStoredInvoiceTaxConfiguration(tx: any, invoice: any) {
  const requiresTaxRule = invoice.lines.some((line: any) => BigInt(line.vatCents) > 0n);
  if (!invoice.taxConfigurationVersionId) {
    if (requiresTaxRule) throw new Error("Cette facture contient de la TVA sans configuration fiscale versionnée. Modifiez le brouillon avant de le comptabiliser.");
    return;
  }
  const configuration = await tx.taxConfigurationVersion.findFirst({
    where: { id: invoice.taxConfigurationVersionId, companyId: invoice.companyId },
    include: { rates: true },
  });
  if (!configuration || configuration.status !== "ACTIVE") throw new Error("La configuration fiscale de la facture n'est plus active.");
  if (configuration.effectiveFrom > invoice.invoiceDate || (configuration.effectiveTo && configuration.effectiveTo < invoice.invoiceDate)) {
    throw new Error("La configuration fiscale ne couvre plus la date de cette facture.");
  }
  const rateById = new Map(configuration.rates.filter((rate: any) => rate.active).map((rate: any) => [rate.id, rate]));
  const expectedDirection = invoice.kind === "SALE" ? "COLLECTED" : "DEDUCTIBLE";
  for (const [index, line] of invoice.lines.entries()) {
    if (!line.taxRateDefinitionId) {
      if (BigInt(line.vatCents) > 0n) throw new Error(`La ligne ${index + 1} contient de la TVA sans règle versionnée.`);
      continue;
    }
    const rate = rateById.get(line.taxRateDefinitionId) as any;
    if (!rate || (rate.direction !== "BOTH" && rate.direction !== expectedDirection)) throw new Error(`La règle fiscale de la ligne ${index + 1} n'est plus applicable.`);
    const expectedVatCents = (BigInt(line.htCents) * BigInt(rate.rateBps) + 5_000n) / 10_000n;
    if (BigInt(line.vatCents) !== expectedVatCents
      || line.vatRateBps !== rate.rateBps
      || line.taxRateCodeSnapshot !== rate.code
      || line.taxConfigurationRevisionSnapshot !== configuration.revision) {
      throw new Error(`Le snapshot fiscal de la ligne ${index + 1} ne correspond plus à sa configuration versionnée.`);
    }
  }
}

type NormalizedAllocation = { invoiceId: string; amountCents: bigint };

function normalizeAllocations(value: unknown): NormalizedAllocation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error("La liste des imputations est invalide.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const allocation = record(raw, `L'imputation ${index + 1}`);
    const invoiceId = requireId(allocation.invoiceId, `La facture de l'imputation ${index + 1}`);
    if (seen.has(invoiceId)) throw new Error("Une facture ne peut apparaître qu'une fois dans le plan d'imputation.");
    seen.add(invoiceId);
    return {
      invoiceId,
      amountCents: strictDecimalToCents(allocation.amount, `Le montant de l'imputation ${index + 1}`, false),
    };
  });
}

function normalizePaymentPayload(payload: unknown) {
  const input = record(payload, "Les données du paiement");
  const kind = enumValue(input.kind, "Le type de paiement", PAYMENT_KINDS, {
    INBOUND: "RECEIPT",
    OUTBOUND: "DISBURSEMENT",
    ENCAISSEMENT: "RECEIPT",
    DECAISSEMENT: "DISBURSEMENT",
  });
  return {
    companyId: requireId(input.companyId, "La société"),
    counterpartyId: requireId(input.counterpartyId, "Le tiers"),
    kind,
    paymentDate: parseAccountingDate(input.paymentDate, "La date du paiement"),
    reference: optionalText(input.reference, 120),
    method: requireText(input.method, "Le mode de paiement", 80),
    currency: currencyValue(input.currency),
    amountCents: strictDecimalToCents(input.amount, "Le montant du paiement", false),
    notes: optionalText(input.notes, 2_000),
    controlAccountId: input.controlAccountId ? requireId(input.controlAccountId, "Le compte collectif") : null,
    settlementAccountId: input.settlementAccountId ? requireId(input.settlementAccountId, "Le compte de règlement") : null,
    bankAccountId: input.bankAccountId ? requireId(input.bankAccountId, "Le compte bancaire") : null,
    allocations: normalizeAllocations(input.allocations),
  };
}

async function actorUserId(options: ServiceOptions): Promise<string | null> {
  return (await options.getActorUserId?.()) ?? null;
}

async function audit(tx: any, options: ServiceOptions, data: {
  companyId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  description: string;
  details?: Record<string, unknown>;
}) {
  await appendActivityAndAudit(tx, {
    companyId: data.companyId,
    actorUserId: await actorUserId(options),
    action: data.action,
    entityType: data.entity,
    entityId: data.entityId ?? null,
    description: data.description,
    payload: data.details ?? {},
  });
}

async function requireCompany(tx: any, companyId: string) {
  const company = await tx.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("La société sélectionnée n'existe plus.");
  return company;
}

async function requireCounterparty(tx: any, companyId: string, counterpartyId: string, active = true) {
  const counterparty = await tx.counterparty.findUnique({ where: { id: counterpartyId } });
  if (!counterparty || counterparty.companyId !== companyId) throw new Error("Le tiers n'appartient pas à la société sélectionnée.");
  if (active && !counterparty.active) throw new Error("Le tiers sélectionné est archivé.");
  return counterparty;
}

async function validateAccountIds(tx: any, companyId: string, accountIds: Array<string | null>, context: string) {
  const ids = [...new Set(accountIds.filter((value): value is string => Boolean(value)))];
  if (!ids.length) return new Map<string, any>();
  const accounts = await tx.account.findMany({ where: { id: { in: ids } } });
  const byId = new Map<string, any>(accounts.map((account: any) => [account.id, account]));
  for (const id of ids) {
    const account = byId.get(id);
    if (!account || account.companyId !== companyId) throw new Error(`${context} utilise un compte d'une autre société ou inexistant.`);
    if (!account.active) throw new Error(`${context} utilise un compte désactivé.`);
  }
  return byId;
}

async function validateFiscalDate(tx: any, companyId: string, date: Date, label: string) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } },
  });
  if (!fiscalYear) throw new Error(`${label} ne correspond à aucun exercice comptable.`);
  if (fiscalYear.status !== "OPEN") throw new Error(`L'exercice « ${fiscalYear.label} » est clôturé.`);
  if (fiscalYear.lockedTo && date <= fiscalYear.lockedTo) {
    throw new Error(`La période est verrouillée jusqu'au ${fiscalYear.lockedTo.toISOString().slice(0, 10)} inclus.`);
  }
  return fiscalYear;
}

async function findFallbackAccount(tx: any, companyId: string, preferredId: string | null, code: string, label: string) {
  if (preferredId) {
    const map = await validateAccountIds(tx, companyId, [preferredId], label);
    return map.get(preferredId);
  }
  const account = await tx.account.findUnique({ where: { companyId_code: { companyId, code } } });
  if (!account || !account.active) throw new Error(`${label} n'est pas configuré. Sélectionnez un compte actif.`);
  return account;
}

async function createAndPostEntry(tx: any, data: {
  companyId: string;
  journalCode: string;
  date: Date;
  pieceNumber: string;
  label: string;
  source: string;
  auditNote: string;
  reversalOfId?: string | null;
  lines: Array<{
    accountId: string;
    label: string;
    debitCents: bigint;
    creditCents: bigint;
    thirdParty?: string | null;
    counterpartyId?: string | null;
  }>;
}) {
  await validateFiscalDate(tx, data.companyId, data.date, "La date de comptabilisation");
  const journal = await tx.journal.findUnique({ where: { companyId_code: { companyId: data.companyId, code: data.journalCode } } });
  if (!journal) throw new Error(`Le journal ${data.journalCode} n'est pas configuré pour cette société.`);
  if (!journal.active || journal.locked) throw new Error(`Le journal ${journal.code} est archivé ou verrouillé.`);
  if (data.lines.length < 2) throw new Error("Une écriture comptable doit contenir au moins deux lignes.");
  const accountById = await validateAccountIds(tx, data.companyId, data.lines.map((line) => line.accountId), "L'écriture");
  const debitCents = data.lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const creditCents = data.lines.reduce((sum, line) => sum + line.creditCents, 0n);
  if (data.lines.some((line) => line.debitCents < 0n || line.creditCents < 0n || (line.debitCents > 0n && line.creditCents > 0n))) {
    throw new Error("L'écriture contient une ligne invalide.");
  }
  if (debitCents !== creditCents || debitCents === 0n) throw new Error("L'écriture générée par le sous-livre est déséquilibrée.");

  const piece = await allocatePieceNumber(tx, {
    companyId: data.companyId,
    journalId: journal.id,
    date: data.date,
    source: data.source,
  });

  const draft = await tx.entry.create({
    data: {
      companyId: data.companyId,
      journalId: journal.id,
      journalCodeSnapshot: journal.code,
      number: provisionalEntryNumber(),
      date: data.date,
      ...piece,
      pieceNumberRaw: data.pieceNumber.slice(0, 80),
      pieceNumberSearch: normalizeAccountSearch(`${piece.pieceNumber} ${data.pieceNumber}`),
      label: data.label.slice(0, 300),
      status: ENTRY_STATUS.draft,
      source: data.source,
      auditNote: data.auditNote,
      reversalOfId: data.reversalOfId ?? null,
      lines: {
        create: data.lines.map((line, index) => {
          const account = accountById.get(line.accountId);
          if (!account) throw new Error("Un compte de l'écriture n'existe plus.");
          return {
            ...line,
            position: index + 1,
            accountCodeSnapshot: account.code,
            accountLabelSnapshot: account.label,
            label: line.label.slice(0, 250),
          };
        }),
      },
    },
  });

  let sequence = journal.nextNumber;
  let number = `${journal.code}-${data.date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const occupied = await tx.entry.findUnique({ where: { companyId_number: { companyId: data.companyId, number } }, select: { id: true } });
    if (!occupied) break;
    sequence += 1;
    number = `${journal.code}-${data.date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
    if (attempts === 9_999) throw new Error("Wheat n'a pas pu attribuer un numéro d'écriture libre.");
  }
  await tx.journal.update({ where: { id: journal.id }, data: { nextNumber: sequence + 1 } });
  const postedAt = new Date();
  const changed = await tx.entry.updateMany({
    where: { id: draft.id, status: ENTRY_STATUS.draft },
    data: { number, status: ENTRY_STATUS.posted, postedAt, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new Error("L'écriture a déjà été traitée dans une autre opération.");
  return tx.entry.findUniqueOrThrow({ where: { id: draft.id }, include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } });
}

async function createReversalEntry(tx: any, sourceEntryId: string, date: Date, reason: string, source: string) {
  const original = await tx.entry.findUnique({ where: { id: sourceEntryId }, include: { journal: true, lines: true } });
  if (!original || original.status !== ENTRY_STATUS.posted) throw new Error("L'écriture d'origine n'est plus disponible pour extourne.");
  const existing = await tx.entry.findFirst({ where: { reversalOfId: original.id } });
  if (existing) throw new Error(`Cette écriture a déjà été extournée par ${existing.number}.`);
  const reversal = await createAndPostEntry(tx, {
    companyId: original.companyId,
    journalCode: original.journal.code,
    date,
    pieceNumber: `${original.pieceNumber}-EXT`,
    label: `Extourne - ${original.label}`,
    source,
    auditNote: reason,
    reversalOfId: original.id,
    lines: original.lines.map((line: any) => ({
      accountId: line.accountId,
      label: line.label,
      debitCents: line.creditCents,
      creditCents: line.debitCents,
      thirdParty: line.thirdParty,
      counterpartyId: line.counterpartyId,
    })),
  });
  const changed = await tx.entry.updateMany({
    where: { id: original.id, status: ENTRY_STATUS.posted },
    data: { status: ENTRY_STATUS.reversed, reversedAt: new Date(), version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new Error("L'écriture d'origine a déjà été traitée.");
  return reversal;
}

const invoiceInclude = {
  counterpartyModel: true,
  lines: { include: { account: true, creditedInvoiceLine: { select: { id: true, position: true, description: true, htCents: true, vatCents: true, ttcCents: true } } }, orderBy: { position: "asc" } },
  creditedInvoice: { select: { id: true, invoiceNo: true, invoiceDate: true, ttcCents: true } },
  creditNotes: { select: { id: true, invoiceNo: true, invoiceDate: true, ttcCents: true, lifecycleStatus: true } },
  artifacts: { select: { id: true, kind: true, revision: true, byteSize: true, contentSha256: true, payloadSha256: true, createdAt: true }, orderBy: { revision: "desc" } },
  postedEntry: { include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } },
  voidEntry: true,
  allocations: { include: { payment: true }, orderBy: { createdAt: "asc" } },
  documents: true,
};

const paymentInclude = {
  counterparty: true,
  controlAccount: true,
  settlementAccount: true,
  bankAccount: true,
  postedEntry: { include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } },
  voidEntry: true,
  allocations: { include: { invoice: true }, orderBy: { createdAt: "asc" } },
  bankEvidence: { include: { reconciliation: true } },
  documents: true,
};

function withSettlement(invoice: any, now: Date) {
  return { ...invoice, settlement: deriveInvoiceSettlement(invoice, now) };
}

async function refreshInvoiceProjection(tx: any, invoiceId: string, now: Date) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: { allocations: { include: { payment: true } }, creditNotes: true },
  });
  if (!invoice) return null;
  const settlement = deriveInvoiceSettlement(invoice, now);
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { status: settlement.settlementStatus, paymentDate: settlement.paidAt },
  });
  return settlement;
}

async function allocateSaleInvoiceNumber(tx: any, invoice: any) {
  if (invoice.kind !== "SALE" || !invoice.numberKey?.startsWith("DRAFT:")) return invoice;
  const series = invoice.series ?? "FA";
  const year = invoice.invoiceDate.getUTCFullYear();
  let sequenceRow = await tx.invoiceSequence.findUnique({
    where: { companyId_series_year: { companyId: invoice.companyId, series, year } },
  });
  let sequenceNo: number;
  let padding = 6;
  if (!sequenceRow) {
    sequenceNo = 1;
    sequenceRow = await tx.invoiceSequence.create({ data: { companyId: invoice.companyId, series, year, nextNumber: 2, padding } });
  } else {
    sequenceNo = sequenceRow.nextNumber;
    padding = sequenceRow.padding;
    await tx.invoiceSequence.update({ where: { id: sequenceRow.id }, data: { nextNumber: { increment: 1 } } });
  }
  let invoiceNo = `${series}-${year}-${String(sequenceNo).padStart(padding, "0")}`;
  let numberKey = invoiceNumberKey("SALE", invoice.counterpartyId, invoiceNo);
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const occupied = await tx.invoice.findUnique({ where: { companyId_numberKey: { companyId: invoice.companyId, numberKey } }, select: { id: true } });
    if (!occupied || occupied.id === invoice.id) break;
    sequenceNo += 1;
    await tx.invoiceSequence.update({ where: { id: sequenceRow.id }, data: { nextNumber: { increment: 1 } } });
    invoiceNo = `${series}-${year}-${String(sequenceNo).padStart(padding, "0")}`;
    numberKey = invoiceNumberKey("SALE", invoice.counterpartyId, invoiceNo);
    if (attempts === 9_999) throw new Error("Wheat n'a pas pu attribuer un numéro de facture libre.");
  }
  const updated = await tx.invoice.update({
    where: { id: invoice.id },
    data: { invoiceNo, numberKey, series, sequenceYear: year, sequenceNo },
  });
  return { ...invoice, ...updated };
}

async function validateAllocationPlan(tx: any, data: {
  companyId: string;
  counterpartyId: string;
  paymentKind: string;
  paymentAmountCents: bigint;
  allocations: NormalizedAllocation[];
  excludePaymentId?: string;
  now: Date;
}) {
  const planned = data.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0n);
  if (planned > data.paymentAmountCents) throw new Error("Le total imputé dépasse le montant du paiement.");
  if (!data.allocations.length) return;
  const invoices = await tx.invoice.findMany({
    where: { id: { in: data.allocations.map((allocation) => allocation.invoiceId) } },
    include: { allocations: { include: { payment: true } }, creditNotes: true },
  });
  const byId = new Map(invoices.map((invoice: any) => [invoice.id, invoice]));
  for (const allocation of data.allocations) {
    const invoice = byId.get(allocation.invoiceId) as any;
    if (!invoice || invoice.companyId !== data.companyId) throw new Error("Une facture imputée n'appartient pas à la société.");
    if ((invoice.documentType ?? "INVOICE") !== "INVOICE") throw new Error("Un paiement ne peut pas être imputé à un avoir.");
    if (invoice.counterpartyId !== data.counterpartyId) throw new Error("Une facture imputée appartient à un autre tiers.");
    if (invoice.lifecycleStatus !== SUBLEDGER_STATUS.posted) throw new Error("Seule une facture comptabilisée peut recevoir une imputation.");
    if (paymentKindForInvoice(invoice.kind) !== data.paymentKind) throw new Error("Le sens du paiement ne correspond pas au type de facture.");
    const filtered = {
      ...invoice,
      allocations: invoice.allocations.filter((row: any) => row.paymentId !== data.excludePaymentId),
    };
    const settlement = deriveInvoiceSettlement(filtered, data.now);
    if (allocation.amountCents > settlement.balanceCents) {
      throw new Error(`L'imputation dépasse le solde disponible de la facture ${invoice.invoiceNo}.`);
    }
  }
}

async function resolvePaymentAccounts(tx: any, normalized: ReturnType<typeof normalizePaymentPayload>, counterparty: any) {
  const bankAccount = normalized.bankAccountId
    ? await tx.bankAccount.findUnique({ where: { id: normalized.bankAccountId } })
    : null;
  if (bankAccount && bankAccount.companyId !== normalized.companyId) throw new Error("Le compte bancaire n'appartient pas à la société.");
  if (bankAccount && !bankAccount.active) throw new Error("Le compte bancaire est archivé. Restaurez-le avant de l'utiliser pour un paiement.");
  if (bankAccount && bankAccount.currency !== normalized.currency) throw new Error("La devise du compte bancaire ne correspond pas au paiement.");
  const defaultControl = normalized.kind === "RECEIPT" ? counterparty.defaultReceivableAccountId : counterparty.defaultPayableAccountId;
  const controlCode = normalized.kind === "RECEIPT" ? "342100" : "441100";
  const controlAccount = await findFallbackAccount(tx, normalized.companyId, normalized.controlAccountId ?? defaultControl, controlCode, "Le compte collectif");
  const settlementId = normalized.settlementAccountId ?? bankAccount?.ledgerAccountId ?? null;
  const settlementAccount = await findFallbackAccount(tx, normalized.companyId, settlementId, bankAccount ? "514100" : "516100", "Le compte de règlement");
  return { bankAccount, controlAccount, settlementAccount };
}

export function createSubledgerService(options: ServiceOptions) {
  const now = () => options.now?.() ?? new Date();

  return {
    async listCounterparties(payload: unknown) {
      const input = record(payload, "Les filtres des tiers");
      const companyId = requireId(input.companyId, "La société");
      const prisma = await options.getPrisma();
      const includeArchived = optionalBoolean(input.includeArchived, false);
      const limit = pageLimit(input);
      const cursorType = `counterparty:${includeArchived ? "all" : "active"}`;
      const cursor = decodePageCursor(input.cursor, cursorType);
      const baseWhere = { companyId, ...(includeArchived ? {} : { active: true }) };
      let afterWhere: Record<string, unknown> | undefined;
      if (cursor) {
        const active = cursorBoolean(cursor.active, "statut");
        const displayName = cursorText(cursor.displayName, "nom");
        const id = requireId(cursor.id, "Le curseur (identifiant)");
        afterWhere = {
          OR: [
            ...(active ? [{ active: false }] : []),
            { active, displayName: { gt: displayName } },
            { active, displayName, id: { gt: id } },
          ],
        };
      }
      const [rows, totalCount] = await Promise.all([
        prisma.counterparty.findMany({
          where: afterWhere ? { AND: [baseWhere, afterWhere] } : baseWhere,
          include: { defaultReceivableAccount: true, defaultPayableAccount: true, _count: { select: { invoices: true, payments: true } } },
          orderBy: [{ active: "desc" }, { displayName: "asc" }, { id: "asc" }],
          take: limit + 1,
        }),
        prisma.counterparty.count({ where: baseWhere }),
      ]);
      return pageEnvelope(rows, limit, totalCount, (counterparty: any) => encodePageCursor(cursorType, {
        active: counterparty.active,
        displayName: counterparty.displayName,
        id: counterparty.id,
      }));
    },

    async createCounterparty(payload: unknown) {
      const normalized = normalizeCounterpartyPayload(payload);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        await requireCompany(tx, normalized.companyId);
        await validateAccountIds(tx, normalized.companyId, [normalized.defaultReceivableAccountId, normalized.defaultPayableAccountId], "Le tiers");
        const duplicate = await tx.counterparty.findUnique({
          where: { companyId_identityKey: { companyId: normalized.companyId, identityKey: normalized.identityKey } },
        });
        if (duplicate) throw new Error("Un tiers possédant la même identité existe déjà dans cette société.");
        const created = await tx.counterparty.create({ data: normalized });
        await audit(tx, options, {
          companyId: normalized.companyId,
          action: "CREATE_COUNTERPARTY",
          entity: "Counterparty",
          entityId: created.id,
          description: `Tiers ${created.displayName} créé`,
          details: { kind: created.kind, identityKey: created.identityKey },
        });
        return created;
      });
    },

    async updateCounterparty(payload: unknown) {
      const input = record(payload, "Les données du tiers");
      const id = requireId(input.id, "Le tiers");
      const version = expectedVersion(input.expectedVersion);
      const normalized = normalizeCounterpartyPayload(input);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.counterparty.findUnique({ where: { id } });
        if (!current || current.companyId !== normalized.companyId) throw new Error("Le tiers n'existe plus dans cette société.");
        await validateAccountIds(tx, normalized.companyId, [normalized.defaultReceivableAccountId, normalized.defaultPayableAccountId], "Le tiers");
        const duplicate = await tx.counterparty.findFirst({
          where: { companyId: normalized.companyId, identityKey: normalized.identityKey, NOT: { id } },
        });
        if (duplicate) throw new Error("Un autre tiers possède déjà la même identité.");
        const changed = await tx.counterparty.updateMany({
          where: { id, companyId: normalized.companyId, version },
          data: { ...normalized, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw new Error("Le tiers a été modifié dans une autre fenêtre. Rechargez puis réessayez.");
        const updated = await tx.counterparty.findUniqueOrThrow({ where: { id } });
        await audit(tx, options, {
          companyId: updated.companyId,
          action: "UPDATE_COUNTERPARTY",
          entity: "Counterparty",
          entityId: id,
          description: `Tiers ${updated.displayName} mis à jour (v${updated.version})`,
          details: { previousVersion: version, newVersion: updated.version },
        });
        return updated;
      });
    },

    async archiveCounterparty(payload: unknown) {
      const input = record(payload, "La demande d'archivage");
      const id = requireId(input.id, "Le tiers");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await requireCounterparty(tx, companyId, id, false);
        if (!current.active) throw new Error("Ce tiers est déjà archivé.");
        const changed = await tx.counterparty.updateMany({
          where: { id, companyId, version, active: true },
          data: { active: false, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw new Error("Le tiers a été modifié dans une autre fenêtre.");
        const updated = await tx.counterparty.findUniqueOrThrow({ where: { id } });
        await audit(tx, options, { companyId, action: "ARCHIVE_COUNTERPARTY", entity: "Counterparty", entityId: id, description: `Tiers ${current.displayName} archivé` });
        return updated;
      });
    },

    async restoreCounterparty(payload: unknown) {
      const input = record(payload, "La demande de restauration");
      const id = requireId(input.id, "Le tiers");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await requireCounterparty(tx, companyId, id, false);
        if (current.active) throw new Error("Ce tiers est déjà actif.");
        const changed = await tx.counterparty.updateMany({
          where: { id, companyId, version, active: false },
          data: { active: true, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw new Error("Le tiers a été modifié dans une autre fenêtre.");
        const updated = await tx.counterparty.findUniqueOrThrow({ where: { id } });
        await audit(tx, options, { companyId, action: "RESTORE_COUNTERPARTY", entity: "Counterparty", entityId: id, description: `Tiers ${current.displayName} restauré` });
        return updated;
      });
    },

    async listInvoices(payload: unknown) {
      const input = record(payload, "Les filtres de facture");
      const companyId = requireId(input.companyId, "La société");
      const prisma = await options.getPrisma();
      const kind = input.kind === undefined ? null : enumValue(input.kind, "Le type de facture", INVOICE_KINDS);
      const lifecycleStatus = input.lifecycleStatus === undefined
        ? null
        : enumValue(input.lifecycleStatus, "Le statut de facture", SUBLEDGER_LIFECYCLE_STATUSES);
      const from = input.from === undefined ? null : parseAccountingDate(input.from, "La date de début");
      const to = input.to === undefined ? null : parseAccountingDate(input.to, "La date de fin");
      if (from && to && from > to) throw new Error("La date de début ne peut pas suivre la date de fin.");
      const search = optionalText(input.search, 160);
      const limit = pageLimit(input);
      const cursorType = `invoice:${kind ?? "all"}:${lifecycleStatus ?? "all"}:${from?.toISOString().slice(0, 10) ?? ""}:${to?.toISOString().slice(0, 10) ?? ""}:${search ?? ""}`;
      const cursor = decodePageCursor(input.cursor, cursorType);
      const baseWhere = {
        companyId,
        ...(kind ? { kind } : {}),
        ...(lifecycleStatus ? { lifecycleStatus } : {}),
        ...(from || to ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(search ? { OR: [{ invoiceNo: { contains: search } }, { counterparty: { contains: search } }, { counterpartyNameSnapshot: { contains: search } }] } : {}),
      };
      let afterWhere: Record<string, unknown> | undefined;
      if (cursor) {
        const invoiceDate = cursorDate(cursor.invoiceDate, "date de facture");
        const createdAt = cursorDate(cursor.createdAt, "date de création");
        const id = requireId(cursor.id, "Le curseur (identifiant)");
        afterWhere = {
          OR: [
            { invoiceDate: { lt: invoiceDate } },
            { invoiceDate, createdAt: { lt: createdAt } },
            { invoiceDate, createdAt, id: { lt: id } },
          ],
        };
      }
      const [rows, totalCount] = await Promise.all([
        prisma.invoice.findMany({
          where: afterWhere ? { AND: [baseWhere, afterWhere] } : baseWhere,
          include: invoiceInclude,
          orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        prisma.invoice.count({ where: baseWhere }),
      ]);
      const result = pageEnvelope(rows, limit, totalCount, (invoice: any) => encodePageCursor(cursorType, {
        invoiceDate: invoice.invoiceDate.toISOString(),
        createdAt: invoice.createdAt.toISOString(),
        id: invoice.id,
      }));
      return { ...result, items: result.items.map((invoice: any) => withSettlement(invoice, now())) };
    },

    async createInvoiceDraft(payload: unknown) {
      const normalized = normalizeInvoicePayload(payload);
      if (normalized.kind === "PURCHASE" && !normalized.invoiceNo) throw new Error("Le numéro de facture fournisseur est obligatoire.");
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const company = await requireCompany(tx, normalized.companyId);
        if (company.baseCurrency !== normalized.currency) throw new Error("La devise de la facture doit correspondre à la devise de base de la société.");
        const counterparty = await requireCounterparty(tx, normalized.companyId, normalized.counterpartyId);
        if (!counterpartySupports(counterparty.kind, normalized.kind)) throw new Error("Le type du tiers ne correspond pas à cette facture.");
        await validateAccountIds(tx, normalized.companyId, [normalized.controlAccountId, normalized.vatAccountId, ...normalized.lines.map((line) => line.accountId)], "La facture");
        const tax = await resolveInvoiceTaxConfiguration(tx, normalized);
        const generatedDraftId = randomUUID();
        const invoiceNo = normalized.invoiceNo ?? `BROUILLON-${generatedDraftId}`;
        const numberKey = normalized.invoiceNo
          ? invoiceNumberKey(normalized.kind, normalized.counterpartyId, normalized.invoiceNo)
          : `DRAFT:${generatedDraftId}`;
        const duplicate = await tx.invoice.findUnique({ where: { companyId_numberKey: { companyId: normalized.companyId, numberKey } } });
        if (duplicate) throw new Error("Une facture portant ce numéro existe déjà.");
        const created = await tx.invoice.create({
          data: {
            companyId: normalized.companyId,
            kind: normalized.kind,
            counterparty: counterparty.displayName,
            ice: counterparty.ice,
            invoiceNo,
            invoiceDate: normalized.invoiceDate,
            dueDate: normalized.dueDate,
            paymentDate: null,
            htCents: normalized.htCents,
            vatCents: normalized.vatCents,
            ttcCents: normalized.ttcCents,
            status: "DRAFT",
            paymentMethod: normalized.paymentMethod,
            counterpartyId: counterparty.id,
            numberKey,
            series: normalized.series,
            currency: normalized.currency,
            counterpartyNameSnapshot: counterparty.displayName,
            iceSnapshot: counterparty.ice,
            taxIdSnapshot: counterparty.taxId,
            billingAddressSnapshot: counterparty.address,
            lifecycleStatus: SUBLEDGER_STATUS.draft,
            documentType: "INVOICE",
            artifactRequired: false,
            source: "MANUAL",
            notes: normalized.notes,
            needsReview: tax.requiresTaxReview,
            reviewNote: tax.requiresTaxReview ? "Configuration et taux de TVA à sélectionner avant comptabilisation." : null,
            controlAccountId: normalized.controlAccountId,
            vatAccountId: normalized.vatAccountId,
            taxConfigurationVersionId: tax.configuration?.id ?? null,
            lines: { create: tax.lines },
          },
          include: invoiceInclude,
        });
        await audit(tx, options, {
          companyId: created.companyId,
          action: "CREATE_INVOICE_DRAFT",
          entity: "Invoice",
          entityId: created.id,
          description: `Brouillon de facture ${created.invoiceNo} créé`,
          details: { kind: created.kind, ttcCents: created.ttcCents.toString(), version: created.version },
        });
        return withSettlement(created, now());
      });
    },

    async updateInvoiceDraft(payload: unknown) {
      const input = record(payload, "Les données de la facture");
      const id = requireId(input.id, "La facture");
      const version = expectedVersion(input.expectedVersion);
      const normalized = normalizeInvoicePayload(input);
      if (normalized.kind === "PURCHASE" && !normalized.invoiceNo) throw new Error("Le numéro de facture fournisseur est obligatoire.");
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.invoice.findUnique({ where: { id } });
        if (!current || current.companyId !== normalized.companyId) throw new Error("La facture n'existe plus dans cette société.");
        if ((current.documentType ?? "INVOICE") !== "INVOICE") throw new Error("Un avoir doit être modifié avec le workflow d'avoir lié Wheat.");
        if (current.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Une facture comptabilisée ou annulée ne peut plus être modifiée.");
        const company = await requireCompany(tx, normalized.companyId);
        if (company.baseCurrency !== normalized.currency) throw new Error("La devise de la facture doit correspondre à la devise de base.");
        const counterparty = await requireCounterparty(tx, normalized.companyId, normalized.counterpartyId);
        if (!counterpartySupports(counterparty.kind, normalized.kind)) throw new Error("Le type du tiers ne correspond pas à cette facture.");
        await validateAccountIds(tx, normalized.companyId, [normalized.controlAccountId, normalized.vatAccountId, ...normalized.lines.map((line) => line.accountId)], "La facture");
        const tax = await resolveInvoiceTaxConfiguration(tx, normalized);
        const requestedInvoiceNo = current.numberKey?.startsWith("DRAFT:") && normalized.invoiceNo === current.invoiceNo
          ? null
          : normalized.invoiceNo;
        const retainsDraftNumber = !requestedInvoiceNo && normalized.kind === "SALE";
        const invoiceNo = retainsDraftNumber ? current.invoiceNo : requestedInvoiceNo!;
        const numberKey = retainsDraftNumber && current.numberKey?.startsWith("DRAFT:")
          ? current.numberKey
          : invoiceNumberKey(normalized.kind, normalized.counterpartyId, invoiceNo);
        const duplicate = await tx.invoice.findFirst({ where: { companyId: normalized.companyId, numberKey, NOT: { id } } });
        if (duplicate) throw new Error("Une autre facture porte déjà ce numéro.");
        const changed = await tx.invoice.updateMany({
          where: { id, companyId: normalized.companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version },
          data: {
            kind: normalized.kind,
            counterparty: counterparty.displayName,
            ice: counterparty.ice,
            invoiceNo,
            invoiceDate: normalized.invoiceDate,
            dueDate: normalized.dueDate,
            htCents: normalized.htCents,
            vatCents: normalized.vatCents,
            ttcCents: normalized.ttcCents,
            paymentMethod: normalized.paymentMethod,
            counterpartyId: counterparty.id,
            numberKey,
            series: normalized.series,
            currency: normalized.currency,
            counterpartyNameSnapshot: counterparty.displayName,
            iceSnapshot: counterparty.ice,
            taxIdSnapshot: counterparty.taxId,
            billingAddressSnapshot: counterparty.address,
            notes: normalized.notes,
            controlAccountId: normalized.controlAccountId,
            vatAccountId: normalized.vatAccountId,
            taxConfigurationVersionId: tax.configuration?.id ?? null,
            needsReview: tax.requiresTaxReview,
            reviewNote: tax.requiresTaxReview ? "Configuration et taux de TVA à sélectionner avant comptabilisation." : null,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("La facture a été modifiée dans une autre fenêtre. Rechargez puis réessayez.");
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLine.createMany({ data: tax.lines.map((line) => ({ ...line, invoiceId: id })) });
        const updated = await tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
        await audit(tx, options, {
          companyId: updated.companyId,
          action: "UPDATE_INVOICE_DRAFT",
          entity: "Invoice",
          entityId: id,
          description: `Brouillon ${updated.invoiceNo} mis à jour (v${updated.version})`,
          details: { previousVersion: version, newVersion: updated.version, ttcCents: updated.ttcCents.toString() },
        });
        return withSettlement(updated, now());
      });
    },

    async deleteInvoiceDraft(payload: unknown) {
      const input = record(payload, "La demande de suppression");
      const id = requireId(input.id, "La facture");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.invoice.findUnique({ where: { id }, include: { documents: true } });
        if (!current || current.companyId !== companyId) throw new Error("La facture n'existe plus.");
        if (current.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Seul un brouillon de facture peut être supprimé.");
        await tx.document.updateMany({ where: { invoiceId: id }, data: { invoiceId: null, entryId: null, status: "TO_REVIEW" } });
        const removed = await tx.invoice.deleteMany({ where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version } });
        if (removed.count !== 1) throw new Error("La facture a été modifiée dans une autre fenêtre.");
        await audit(tx, options, { companyId, action: "DELETE_INVOICE_DRAFT", entity: "Invoice", entityId: id, description: `Brouillon ${current.invoiceNo} supprimé ; documents conservés` });
        return { ok: true, id, invoiceNo: current.invoiceNo };
      });
    },

    async postInvoice(payload: unknown) {
      const input = record(payload, "La demande de comptabilisation");
      const id = requireId(input.id, "La facture");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        let invoice = await tx.invoice.findUnique({ where: { id }, include: { counterpartyModel: true, lines: true } });
        if (!invoice || invoice.companyId !== companyId) throw new Error("La facture n'existe plus dans cette société.");
        if ((invoice.documentType ?? "INVOICE") !== "INVOICE") throw new Error("Un avoir doit être comptabilisé avec le workflow d'avoir lié Wheat.");
        if (invoice.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Seul un brouillon peut être comptabilisé.");
        if (invoice.version !== version) throw new Error("La facture a été modifiée dans une autre fenêtre.");
        if (!invoice.counterpartyModel || !invoice.counterpartyModel.active) throw new Error("Le tiers de la facture est absent ou archivé.");
        if (!invoice.lines.length) throw new Error("La facture ne contient aucune ligne.");
        await validateFiscalDate(tx, companyId, invoice.invoiceDate, "La date de facture");
        await validateStoredInvoiceTaxConfiguration(tx, invoice);
        invoice = await allocateSaleInvoiceNumber(tx, invoice);
        const counterparty = invoice.counterpartyModel;
        const controlDefault = invoice.kind === "SALE" ? counterparty.defaultReceivableAccountId : counterparty.defaultPayableAccountId;
        const controlCode = invoice.kind === "SALE" ? "342100" : "441100";
        const vatCode = invoice.kind === "SALE" ? "445500" : "345520";
        const controlAccount = await findFallbackAccount(tx, companyId, invoice.controlAccountId ?? controlDefault, controlCode, "Le compte collectif");
        const vatAccount = invoice.vatCents > 0n
          ? await findFallbackAccount(tx, companyId, invoice.vatAccountId, vatCode, "Le compte de TVA")
          : null;
        await validateAccountIds(tx, companyId, invoice.lines.map((line: any) => line.accountId), "La facture");
        if (invoice.lines.some((line: any) => !line.accountId)) throw new Error("Chaque ligne de facture doit avoir un compte comptable.");
        const calculatedHt = invoice.lines.reduce((sum: bigint, line: any) => sum + line.htCents, 0n);
        const calculatedVat = invoice.lines.reduce((sum: bigint, line: any) => sum + line.vatCents, 0n);
        const calculatedTtc = invoice.lines.reduce((sum: bigint, line: any) => sum + line.ttcCents, 0n);
        if (calculatedHt !== invoice.htCents || calculatedVat !== invoice.vatCents || calculatedTtc !== invoice.ttcCents || invoice.htCents + invoice.vatCents !== invoice.ttcCents) {
          throw new Error("Les totaux de la facture ne correspondent plus à ses lignes.");
        }
        const thirdParty = invoice.counterpartyNameSnapshot ?? counterparty.displayName;
        const operationalLines = invoice.lines.map((line: any) => ({
          accountId: line.accountId,
          label: line.description,
          debitCents: invoice.kind === "PURCHASE" ? line.htCents : 0n,
          creditCents: invoice.kind === "SALE" ? line.htCents : 0n,
          thirdParty,
          counterpartyId: counterparty.id,
        }));
        if (vatAccount && invoice.vatCents > 0n) {
          operationalLines.push({
            accountId: vatAccount.id,
            label: `TVA - ${invoice.invoiceNo}`,
            debitCents: invoice.kind === "PURCHASE" ? invoice.vatCents : 0n,
            creditCents: invoice.kind === "SALE" ? invoice.vatCents : 0n,
            thirdParty,
            counterpartyId: counterparty.id,
          });
        }
        operationalLines.push({
          accountId: controlAccount.id,
          label: `Tiers - ${invoice.invoiceNo}`,
          debitCents: invoice.kind === "SALE" ? invoice.ttcCents : 0n,
          creditCents: invoice.kind === "PURCHASE" ? invoice.ttcCents : 0n,
          thirdParty,
          counterpartyId: counterparty.id,
        });
        const entry = await createAndPostEntry(tx, {
          companyId,
          journalCode: invoice.kind === "SALE" ? "VE" : "AC",
          date: invoice.invoiceDate,
          pieceNumber: invoice.invoiceNo,
          label: `${invoice.kind === "SALE" ? "Facture client" : "Facture fournisseur"} ${invoice.invoiceNo}`,
          source: "SUBLEDGER_INVOICE",
          auditNote: `Écriture générée depuis la facture ${invoice.id}`,
          lines: operationalLines,
        });
        const artifactActorUserId = (await options.getActorUserId?.()) ?? null;
        const artifact = await createImmutablePostedInvoiceArtifact14(tx, {
          companyId,
          invoiceId: id,
          entryId: entry.id,
          createdByUserId: artifactActorUserId,
        });
        const changed = await tx.invoice.updateMany({
          where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version },
          data: {
            lifecycleStatus: SUBLEDGER_STATUS.posted,
            status: "UNPAID",
            postedEntryId: entry.id,
            postedAt: entry.postedAt,
            controlAccountId: controlAccount.id,
            vatAccountId: vatAccount?.id ?? null,
            artifactRequired: true,
            needsReview: false,
            reviewNote: null,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("La facture a été traitée dans une autre fenêtre.");
        await tx.document.updateMany({
          where: { invoiceId: id },
          data: { entryId: entry.id, status: "POSTED" },
        });
        await audit(tx, options, {
          companyId,
          action: "POST_INVOICE",
          entity: "Invoice",
          entityId: id,
          description: `Facture ${invoice.invoiceNo} comptabilisée par ${entry.number}`,
          details: {
            entryId: entry.id,
            entryNumber: entry.number,
            ttcCents: invoice.ttcCents.toString(),
            artifactId: artifact.id,
            artifactContentSha256: artifact.contentSha256,
            artifactPayloadSha256: artifact.payloadSha256,
            previousVersion: version,
          },
        });
        const posted = await tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
        return withSettlement(posted, now());
      });
    },

    async voidInvoice(payload: unknown) {
      const input = record(payload, "La demande d'annulation");
      const id = requireId(input.id, "La facture");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const reason = requireText(input.reason, "Le motif d'annulation", 500);
      const voidDate = parseAccountingDate(input.date ?? now(), "La date d'annulation");
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const invoice = await tx.invoice.findUnique({ where: { id }, include: { allocations: { include: { payment: true } } } });
        if (!invoice || invoice.companyId !== companyId) throw new Error("La facture n'existe plus.");
        assertCreditNoteTechnicalVoidBlocked14(invoice);
        if (invoice.lifecycleStatus !== SUBLEDGER_STATUS.posted || !invoice.postedEntryId) throw new Error("Seule une facture comptabilisée peut être annulée.");
        if (invoice.version !== version) throw new Error("La facture a été modifiée dans une autre fenêtre.");
        const settlement = deriveInvoiceSettlement(invoice, now());
        if (settlement.allocatedCents > 0n) throw new Error("Annulez d'abord les imputations de paiement actives de cette facture.");
        const reversal = await createReversalEntry(tx, invoice.postedEntryId, voidDate, reason, "SUBLEDGER_INVOICE_VOID");
        const changed = await tx.invoice.updateMany({
          where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.posted, version },
          data: {
            lifecycleStatus: SUBLEDGER_STATUS.void,
            status: "VOIDED",
            paymentDate: null,
            voidEntryId: reversal.id,
            voidedAt: reversal.postedAt,
            voidReason: reason,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("La facture a été traitée dans une autre fenêtre.");
        await tx.document.updateMany({
          where: { invoiceId: id },
          data: { entryId: reversal.id, status: "VOIDED" },
        });
        await audit(tx, options, {
          companyId,
          action: "VOID_INVOICE",
          entity: "Invoice",
          entityId: id,
          description: `Facture ${invoice.invoiceNo} annulée par ${reversal.number}`,
          details: { reason, reversalEntryId: reversal.id, previousVersion: version },
        });
        const voided = await tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
        return withSettlement(voided, now());
      });
    },

    async getInvoiceSettlement(payload: unknown) {
      const input = record(payload, "La demande de solde");
      const id = requireId(input.id, "La facture");
      const companyId = requireId(input.companyId, "La société");
      const prisma = await options.getPrisma();
      const invoice = await prisma.invoice.findUnique({ where: { id }, include: { allocations: { include: { payment: true } }, creditNotes: true } });
      if (!invoice || invoice.companyId !== companyId) throw new Error("La facture n'existe plus dans cette société.");
      return { invoiceId: id, ...deriveInvoiceSettlement(invoice, now()) };
    },

    async listPayments(payload: unknown) {
      const input = record(payload, "Les filtres de paiement");
      const companyId = requireId(input.companyId, "La société");
      const prisma = await options.getPrisma();
      const kind = input.kind === undefined ? null : enumValue(input.kind, "Le type de paiement", PAYMENT_KINDS);
      const lifecycleStatus = input.lifecycleStatus === undefined
        ? null
        : enumValue(input.lifecycleStatus, "Le statut de paiement", SUBLEDGER_LIFECYCLE_STATUSES);
      const limit = pageLimit(input);
      const cursorType = `payment:${kind ?? "all"}:${lifecycleStatus ?? "all"}`;
      const cursor = decodePageCursor(input.cursor, cursorType);
      const baseWhere = {
        companyId,
        ...(kind ? { kind } : {}),
        ...(lifecycleStatus ? { lifecycleStatus } : {}),
      };
      let afterWhere: Record<string, unknown> | undefined;
      if (cursor) {
        const paymentDate = cursorDate(cursor.paymentDate, "date de paiement");
        const createdAt = cursorDate(cursor.createdAt, "date de création");
        const id = requireId(cursor.id, "Le curseur (identifiant)");
        afterWhere = {
          OR: [
            { paymentDate: { lt: paymentDate } },
            { paymentDate, createdAt: { lt: createdAt } },
            { paymentDate, createdAt, id: { lt: id } },
          ],
        };
      }
      const [rows, totalCount] = await Promise.all([
        prisma.payment.findMany({
          where: afterWhere ? { AND: [baseWhere, afterWhere] } : baseWhere,
          include: paymentInclude,
          orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        prisma.payment.count({ where: baseWhere }),
      ]);
      return pageEnvelope(rows, limit, totalCount, (payment: any) => encodePageCursor(cursorType, {
        paymentDate: payment.paymentDate.toISOString(),
        createdAt: payment.createdAt.toISOString(),
        id: payment.id,
      }));
    },

    async createPaymentDraft(payload: unknown) {
      const normalized = normalizePaymentPayload(payload);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const company = await requireCompany(tx, normalized.companyId);
        if (company.baseCurrency !== normalized.currency) throw new Error("La devise du paiement doit correspondre à la devise de base.");
        const counterparty = await requireCounterparty(tx, normalized.companyId, normalized.counterpartyId);
        const expectedCounterpartyKind = normalized.kind === "RECEIPT" ? "SALE" : "PURCHASE";
        if (!counterpartySupports(counterparty.kind, expectedCounterpartyKind)) throw new Error("Le type du tiers ne correspond pas au sens du paiement.");
        const accounts = await resolvePaymentAccounts(tx, normalized, counterparty);
        await validateAllocationPlan(tx, { ...normalized, paymentKind: normalized.kind, paymentAmountCents: normalized.amountCents, now: now() });
        const created = await tx.payment.create({
          data: {
            companyId: normalized.companyId,
            counterpartyId: normalized.counterpartyId,
            kind: normalized.kind,
            paymentDate: normalized.paymentDate,
            reference: normalized.reference,
            method: normalized.method,
            currency: normalized.currency,
            amountCents: normalized.amountCents,
            lifecycleStatus: SUBLEDGER_STATUS.draft,
            source: "MANUAL",
            notes: normalized.notes,
            controlAccountId: accounts.controlAccount.id,
            settlementAccountId: accounts.settlementAccount.id,
            bankAccountId: accounts.bankAccount?.id ?? null,
            allocations: { create: normalized.allocations.map((allocation) => ({ ...allocation, status: "ACTIVE" })) },
          },
          include: paymentInclude,
        });
        await audit(tx, options, {
          companyId: created.companyId,
          action: "CREATE_PAYMENT_DRAFT",
          entity: "Payment",
          entityId: created.id,
          description: `Brouillon de paiement ${created.reference ?? created.id} créé`,
          details: { amountCents: created.amountCents.toString(), kind: created.kind, version: created.version },
        });
        return created;
      });
    },

    async updatePaymentDraft(payload: unknown) {
      const input = record(payload, "Les données du paiement");
      const id = requireId(input.id, "Le paiement");
      const version = expectedVersion(input.expectedVersion);
      const normalized = normalizePaymentPayload(input);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.payment.findUnique({ where: { id } });
        if (!current || current.companyId !== normalized.companyId) throw new Error("Le paiement n'existe plus dans cette société.");
        if (current.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Un paiement comptabilisé ou annulé ne peut plus être modifié.");
        const company = await requireCompany(tx, normalized.companyId);
        if (company.baseCurrency !== normalized.currency) throw new Error("La devise du paiement doit correspondre à la devise de base.");
        const counterparty = await requireCounterparty(tx, normalized.companyId, normalized.counterpartyId);
        const expectedCounterpartyKind = normalized.kind === "RECEIPT" ? "SALE" : "PURCHASE";
        if (!counterpartySupports(counterparty.kind, expectedCounterpartyKind)) throw new Error("Le type du tiers ne correspond pas au paiement.");
        const accounts = await resolvePaymentAccounts(tx, normalized, counterparty);
        await validateAllocationPlan(tx, { ...normalized, paymentKind: normalized.kind, paymentAmountCents: normalized.amountCents, excludePaymentId: id, now: now() });
        const changed = await tx.payment.updateMany({
          where: { id, companyId: normalized.companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version },
          data: {
            counterpartyId: normalized.counterpartyId,
            kind: normalized.kind,
            paymentDate: normalized.paymentDate,
            reference: normalized.reference,
            method: normalized.method,
            currency: normalized.currency,
            amountCents: normalized.amountCents,
            notes: normalized.notes,
            controlAccountId: accounts.controlAccount.id,
            settlementAccountId: accounts.settlementAccount.id,
            bankAccountId: accounts.bankAccount?.id ?? null,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        await tx.paymentAllocation.deleteMany({ where: { paymentId: id } });
        if (normalized.allocations.length) {
          await tx.paymentAllocation.createMany({ data: normalized.allocations.map((allocation) => ({ ...allocation, paymentId: id, status: "ACTIVE" })) });
        }
        const updated = await tx.payment.findUniqueOrThrow({ where: { id }, include: paymentInclude });
        await audit(tx, options, {
          companyId: updated.companyId,
          action: "UPDATE_PAYMENT_DRAFT",
          entity: "Payment",
          entityId: id,
          description: `Brouillon de paiement mis à jour (v${updated.version})`,
          details: { previousVersion: version, newVersion: updated.version, amountCents: updated.amountCents.toString() },
        });
        return updated;
      });
    },

    async deletePaymentDraft(payload: unknown) {
      const input = record(payload, "La demande de suppression");
      const id = requireId(input.id, "Le paiement");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.payment.findUnique({ where: { id }, include: { documents: true } });
        if (!current || current.companyId !== companyId) throw new Error("Le paiement n'existe plus.");
        if (current.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Seul un brouillon de paiement peut être supprimé.");
        await tx.document.updateMany({ where: { paymentId: id }, data: { paymentId: null } });
        await tx.paymentAllocation.deleteMany({ where: { paymentId: id } });
        const removed = await tx.payment.deleteMany({ where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version } });
        if (removed.count !== 1) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        await audit(tx, options, { companyId, action: "DELETE_PAYMENT_DRAFT", entity: "Payment", entityId: id, description: "Brouillon de paiement supprimé ; documents conservés" });
        return { ok: true, id };
      });
    },

    async postPayment(payload: unknown) {
      const input = record(payload, "La demande de comptabilisation");
      const id = requireId(input.id, "Le paiement");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const payment = await tx.payment.findUnique({ where: { id }, include: { counterparty: true, allocations: true, controlAccount: true, settlementAccount: true } });
        if (!payment || payment.companyId !== companyId) throw new Error("Le paiement n'existe plus dans cette société.");
        if (payment.lifecycleStatus !== SUBLEDGER_STATUS.draft) throw new Error("Seul un brouillon de paiement peut être comptabilisé.");
        if (payment.version !== version) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        if (!payment.counterparty.active) throw new Error("Le tiers du paiement est archivé.");
        if (!payment.controlAccount || !payment.settlementAccount) throw new Error("Les comptes du paiement ne sont pas configurés.");
        await validateFiscalDate(tx, companyId, payment.paymentDate, "La date du paiement");
        await validateAccountIds(tx, companyId, [payment.controlAccountId, payment.settlementAccountId], "Le paiement");
        await validateAllocationPlan(tx, {
          companyId,
          counterpartyId: payment.counterpartyId,
          paymentKind: payment.kind,
          paymentAmountCents: payment.amountCents,
          allocations: payment.allocations.map((allocation: any) => ({ invoiceId: allocation.invoiceId, amountCents: allocation.amountCents })),
          excludePaymentId: id,
          now: now(),
        });
        const isReceipt = payment.kind === "RECEIPT";
        const entry = await createAndPostEntry(tx, {
          companyId,
          journalCode: payment.bankAccountId ? "BQ" : "CA",
          date: payment.paymentDate,
          pieceNumber: payment.reference ?? `PAY-${payment.id.slice(0, 12)}`,
          label: `${isReceipt ? "Encaissement" : "Décaissement"} ${payment.counterparty.displayName}`,
          source: "SUBLEDGER_PAYMENT",
          auditNote: `Écriture générée depuis le paiement ${payment.id}`,
          lines: [
            {
              accountId: payment.settlementAccountId,
              label: payment.reference ?? payment.counterparty.displayName,
              debitCents: isReceipt ? payment.amountCents : 0n,
              creditCents: isReceipt ? 0n : payment.amountCents,
              thirdParty: payment.counterparty.displayName,
              counterpartyId: payment.counterpartyId,
            },
            {
              accountId: payment.controlAccountId,
              label: payment.reference ?? payment.counterparty.displayName,
              debitCents: isReceipt ? 0n : payment.amountCents,
              creditCents: isReceipt ? payment.amountCents : 0n,
              thirdParty: payment.counterparty.displayName,
              counterpartyId: payment.counterpartyId,
            },
          ],
        });
        const changed = await tx.payment.updateMany({
          where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.draft, version },
          data: { lifecycleStatus: SUBLEDGER_STATUS.posted, postedEntryId: entry.id, postedAt: entry.postedAt, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw new Error("Le paiement a été traité dans une autre fenêtre.");
        for (const invoiceId of new Set(payment.allocations.map((allocation: any) => allocation.invoiceId))) {
          await refreshInvoiceProjection(tx, invoiceId as string, now());
        }
        await audit(tx, options, {
          companyId,
          action: "POST_PAYMENT",
          entity: "Payment",
          entityId: id,
          description: `Paiement comptabilisé par ${entry.number}`,
          details: { entryId: entry.id, entryNumber: entry.number, amountCents: payment.amountCents.toString(), previousVersion: version },
        });
        return tx.payment.findUniqueOrThrow({ where: { id }, include: paymentInclude });
      });
    },

    async voidPayment(payload: unknown) {
      const input = record(payload, "La demande d'annulation");
      const id = requireId(input.id, "Le paiement");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const reason = requireText(input.reason, "Le motif d'annulation", 500);
      const voidDate = parseAccountingDate(input.date ?? now(), "La date d'annulation");
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const payment = await tx.payment.findUnique({ where: { id }, include: paymentInclude });
        if (!payment || payment.companyId !== companyId) throw new Error("Le paiement n'existe plus.");
        if (payment.lifecycleStatus !== SUBLEDGER_STATUS.posted || !payment.postedEntryId) throw new Error("Seul un paiement comptabilisé peut être annulé.");
        if (payment.version !== version) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        if (payment.bankEvidence.some((evidence: any) => evidence.reconciliation.status === "ACTIVE")) {
          throw new Error("Annulez d'abord le rapprochement bancaire actif lié à ce paiement.");
        }
        const activeLedgerEvidence = await tx.bankReconciliationAllocation.findFirst({
          where: {
            entryLine: { entryId: payment.postedEntryId },
            reconciliation: { status: "ACTIVE" },
          },
          select: { id: true },
        });
        if (activeLedgerEvidence) {
          throw new Error("Annulez d'abord le rapprochement bancaire actif lié à l'écriture de ce paiement.");
        }
        const reversal = await createReversalEntry(tx, payment.postedEntryId, voidDate, reason, "SUBLEDGER_PAYMENT_VOID");
        const activeInvoiceIds = [...new Set(payment.allocations.filter((row: any) => row.status === "ACTIVE").map((row: any) => row.invoiceId))] as string[];
        await tx.paymentAllocation.updateMany({
          where: { paymentId: id, status: "ACTIVE" },
          data: { status: "REVERSED", reversedAt: now(), reversalAccountingDate: voidDate, reversalReason: reason },
        });
        const changed = await tx.payment.updateMany({
          where: { id, companyId, lifecycleStatus: SUBLEDGER_STATUS.posted, version },
          data: {
            lifecycleStatus: SUBLEDGER_STATUS.void,
            voidEntryId: reversal.id,
            voidedAt: reversal.postedAt,
            voidReason: reason,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("Le paiement a été traité dans une autre fenêtre.");
        for (const invoiceId of activeInvoiceIds) await refreshInvoiceProjection(tx, invoiceId, now());
        await audit(tx, options, {
          companyId,
          action: "VOID_PAYMENT",
          entity: "Payment",
          entityId: id,
          description: `Paiement annulé par ${reversal.number}`,
          details: { reason, reversalEntryId: reversal.id, previousVersion: version },
        });
        return tx.payment.findUniqueOrThrow({ where: { id }, include: paymentInclude });
      });
    },

    async allocatePayment(payload: unknown) {
      const input = record(payload, "La demande d'imputation");
      const paymentId = requireId(input.paymentId, "Le paiement");
      const invoiceId = requireId(input.invoiceId, "La facture");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedVersion);
      const amountCents = strictDecimalToCents(input.amount, "Le montant imputé", false);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
        if (!payment || payment.companyId !== companyId) throw new Error("Le paiement n'existe plus.");
        if (payment.lifecycleStatus !== SUBLEDGER_STATUS.posted) throw new Error("Seul un paiement comptabilisé peut recevoir une nouvelle imputation.");
        if (payment.version !== version) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        const alreadyAllocated = payment.allocations.filter((row: any) => row.status === "ACTIVE").reduce((sum: bigint, row: any) => sum + row.amountCents, 0n);
        if (alreadyAllocated + amountCents > payment.amountCents) throw new Error("L'imputation dépasse le montant non imputé du paiement.");
        await validateAllocationPlan(tx, {
          companyId,
          counterpartyId: payment.counterpartyId,
          paymentKind: payment.kind,
          paymentAmountCents: amountCents,
          allocations: [{ invoiceId, amountCents }],
          now: now(),
        });
        const changed = await tx.payment.updateMany({ where: { id: paymentId, companyId, lifecycleStatus: SUBLEDGER_STATUS.posted, version }, data: { version: { increment: 1 } } });
        if (changed.count !== 1) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        const allocation = await tx.paymentAllocation.create({ data: { paymentId, invoiceId, amountCents, status: "ACTIVE" } });
        await refreshInvoiceProjection(tx, invoiceId, now());
        await audit(tx, options, {
          companyId,
          action: "ALLOCATE_PAYMENT",
          entity: "PaymentAllocation",
          entityId: allocation.id,
          description: `Paiement imputé à hauteur de ${amountCents.toString()} centimes`,
          details: { paymentId, invoiceId, amountCents: amountCents.toString(), previousPaymentVersion: version },
        });
        return tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: paymentInclude });
      });
    },

    async reversePaymentAllocation(payload: unknown) {
      const input = record(payload, "La demande d'annulation d'imputation");
      const allocationId = requireId(input.allocationId, "L'imputation");
      const companyId = requireId(input.companyId, "La société");
      const version = expectedVersion(input.expectedPaymentVersion);
      const reason = requireText(input.reason, "Le motif d'annulation", 500);
      const reversalDate = parseAccountingDate(input.date ?? now(), "La date d'annulation de l'imputation");
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const allocation = await tx.paymentAllocation.findUnique({ where: { id: allocationId }, include: { payment: true, invoice: true } });
        if (!allocation || allocation.payment.companyId !== companyId || allocation.invoice.companyId !== companyId) throw new Error("L'imputation n'existe plus dans cette société.");
        if (allocation.payment.lifecycleStatus !== SUBLEDGER_STATUS.posted) throw new Error("Le paiement de cette imputation n'est pas comptabilisé.");
        if (allocation.payment.version !== version) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        if (allocation.status !== "ACTIVE") throw new Error("Cette imputation est déjà annulée.");
        await validateFiscalDate(tx, companyId, reversalDate, "La date d'annulation de l'imputation");
        const claimedPayment = await tx.payment.updateMany({
          where: { id: allocation.paymentId, companyId, lifecycleStatus: SUBLEDGER_STATUS.posted, version },
          data: { version: { increment: 1 } },
        });
        if (claimedPayment.count !== 1) throw new Error("Le paiement a été modifié dans une autre fenêtre.");
        const changed = await tx.paymentAllocation.updateMany({
          where: { id: allocationId, status: "ACTIVE" },
          data: { status: "REVERSED", reversedAt: now(), reversalAccountingDate: reversalDate, reversalReason: reason },
        });
        if (changed.count !== 1) throw new Error("L'imputation a déjà été traitée.");
        await refreshInvoiceProjection(tx, allocation.invoiceId, now());
        await audit(tx, options, {
          companyId,
          action: "REVERSE_PAYMENT_ALLOCATION",
          entity: "PaymentAllocation",
          entityId: allocationId,
          description: "Imputation de paiement annulée sans suppression d'historique",
          details: { reason, reversalAccountingDate: reversalDate.toISOString().slice(0, 10), paymentId: allocation.paymentId, invoiceId: allocation.invoiceId, amountCents: allocation.amountCents.toString() },
        });
        return tx.payment.findUniqueOrThrow({ where: { id: allocation.paymentId }, include: paymentInclude });
      });
    },
  };
}

export function registerSubledgerIpc(options: SubledgerRegistrationOptions) {
  const service = createSubledgerService(options);
  const serialize = options.serialize ?? rendererSerialize;
  const bind = (channel: string, handler: (payload: unknown) => Promise<any>) => {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  };

  bind(SUBLEDGER_IPC_CHANNELS.counterpartyList, service.listCounterparties);
  bind(SUBLEDGER_IPC_CHANNELS.counterpartyCreate, service.createCounterparty);
  bind(SUBLEDGER_IPC_CHANNELS.counterpartyUpdate, service.updateCounterparty);
  bind(SUBLEDGER_IPC_CHANNELS.counterpartyArchive, service.archiveCounterparty);
  bind(SUBLEDGER_IPC_CHANNELS.counterpartyRestore, service.restoreCounterparty);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceList, service.listInvoices);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceCreate, service.createInvoiceDraft);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceUpdate, service.updateInvoiceDraft);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceDeleteDraft, service.deleteInvoiceDraft);
  bind(SUBLEDGER_IPC_CHANNELS.invoicePost, service.postInvoice);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceVoid, service.voidInvoice);
  bind(SUBLEDGER_IPC_CHANNELS.invoiceSettlement, service.getInvoiceSettlement);
  bind(SUBLEDGER_IPC_CHANNELS.paymentList, service.listPayments);
  bind(SUBLEDGER_IPC_CHANNELS.paymentCreate, service.createPaymentDraft);
  bind(SUBLEDGER_IPC_CHANNELS.paymentUpdate, service.updatePaymentDraft);
  bind(SUBLEDGER_IPC_CHANNELS.paymentDeleteDraft, service.deletePaymentDraft);
  bind(SUBLEDGER_IPC_CHANNELS.paymentPost, service.postPayment);
  bind(SUBLEDGER_IPC_CHANNELS.paymentVoid, service.voidPayment);
  bind(SUBLEDGER_IPC_CHANNELS.paymentAllocate, service.allocatePayment);
  bind(SUBLEDGER_IPC_CHANNELS.paymentReverseAllocation, service.reversePaymentAllocation);
  return service;
}
