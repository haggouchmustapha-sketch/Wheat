import { randomUUID } from "node:crypto";
import { ENTRY_STATUS, optionalText, parseAccountingDate, provisionalEntryNumber, requireId, requireText } from "./accounting";
import { appendActivityAndAudit, canonicalAuditJson } from "./audit13";
import { generateCreditNotePdf14, sha256Hex14, type CreditNotePdfSnapshot } from "./creditNotePdf14";
import { allocatePieceNumber } from "./pieceNumbering21";
import { normalizeAccountSearch } from "./chartOfAccounts21";

export const CREDIT_NOTES_14_IPC_CHANNELS = {
  creditCreate: "wheat:invoice:credit:create",
  creditUpdate: "wheat:invoice:credit:update",
  creditPost: "wheat:invoice:credit:post",
  artifactList: "wheat:invoice:artifact:list",
  artifactVerify: "wheat:invoice:artifact:verify",
  artifactExport: "wheat:invoice:artifact:export",
} as const;

export type PrismaLike = any;

type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type RegisterableIpc = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export type CreditNoteArtifactGenerator = (input: {
  snapshot: CreditNotePdfSnapshot;
  payloadJson: string;
  payloadSha256: string;
}) => Uint8Array | Promise<Uint8Array>;

export type CreditNotes14ServiceOptions = {
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  now?: () => Date;
  generateArtifact?: CreditNoteArtifactGenerator;
};

export type CreditNotes14RegistrationOptions = CreditNotes14ServiceOptions & {
  ipcMain: RegisterableIpc;
  serialize?: (value: any) => any;
};

const CREDIT_DOCUMENT_TYPE = "CREDIT_NOTE";
const NORMAL_DOCUMENT_TYPE = "INVOICE";
const CREDIT_SOURCE = "CREDIT_NOTE_1_4";
const CREDIT_ARTIFACT_KIND = "CREDIT_NOTE_PDF";
const MAX_SIGNED_64 = 2n ** 63n - 1n;

type NormalizedCreditLine = {
  position: number;
  creditedInvoiceLineId: string;
  htCents: bigint;
  vatCents: bigint;
  ttcCents: bigint;
};

type NormalizedCreditPayload = {
  companyId: string;
  creditedInvoiceId: string;
  invoiceDate: Date;
  invoiceNo: string | null;
  creditReason: string;
  lines: NormalizedCreditLine[];
};

type CreditCapacity = {
  originalTtcCents: bigint;
  activePaymentCents: bigint;
  postedCreditCents: bigint;
  remainingTtcCents: bigint;
  lines: Array<{
    creditedInvoiceLineId: string;
    originalHtCents: bigint;
    originalVatCents: bigint;
    originalTtcCents: bigint;
    postedCreditHtCents: bigint;
    postedCreditVatCents: bigint;
    postedCreditTtcCents: bigint;
    remainingHtCents: bigint;
    remainingVatCents: bigint;
    remainingTtcCents: bigint;
  }>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  return value as Record<string, unknown>;
}

function exactVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("La version attendue est invalide.");
  }
  return value;
}

/** IPC money is deliberately accepted only as an integer-cent string. */
export function exactCentString14(value: unknown, label: string, allowZero = true): bigint {
  if (typeof value === "number") throw new Error(`${label} doit être transmis comme texte exact en centimes, jamais comme nombre JavaScript.`);
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error(`${label} doit être un texte entier positif exprimé en centimes.`);
  }
  const result = BigInt(value.trim());
  if (result > MAX_SIGNED_64) throw new Error(`${label} est hors limites.`);
  if (!allowZero && result === 0n) throw new Error(`${label} doit être strictement positif.`);
  return result;
}

function normalizeLines(value: unknown): NormalizedCreditLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new Error("Un avoir doit contenir entre 1 et 500 lignes liées à la facture d'origine.");
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const input = record(raw, `La ligne d'avoir ${index + 1}`);
    const creditedInvoiceLineId = requireId(input.creditedInvoiceLineId, `La ligne d'origine ${index + 1}`);
    if (seen.has(creditedInvoiceLineId)) throw new Error("Une ligne de facture d'origine ne peut être créditée qu'une fois dans le même avoir.");
    seen.add(creditedInvoiceLineId);
    const htCents = exactCentString14(input.htCents, `Le HT de la ligne ${index + 1}`);
    const vatCents = exactCentString14(input.vatCents, `La TVA de la ligne ${index + 1}`);
    const ttcCents = exactCentString14(input.ttcCents, `Le TTC de la ligne ${index + 1}`, false);
    if (htCents + vatCents !== ttcCents) throw new Error(`Le TTC de la ligne ${index + 1} doit être égal au HT plus la TVA.`);
    return { position: index + 1, creditedInvoiceLineId, htCents, vatCents, ttcCents };
  });
}

function normalizeCreditPayload(value: unknown): NormalizedCreditPayload {
  const input = record(value, "Les données de l'avoir");
  return {
    companyId: requireId(input.companyId, "La société"),
    creditedInvoiceId: requireId(input.creditedInvoiceId, "La facture d'origine"),
    invoiceDate: parseAccountingDate(input.invoiceDate, "La date de l'avoir"),
    invoiceNo: optionalText(input.invoiceNo, 100),
    creditReason: requireText(input.creditReason, "Le motif de l'avoir", 1_000),
    lines: normalizeLines(input.lines),
  };
}

function canonicalNumberKey(value: string) {
  const normalized = value.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!normalized) throw new Error("La référence de l'avoir est invalide.");
  return normalized;
}

function total(lines: NormalizedCreditLine[], field: "htCents" | "vatCents" | "ttcCents") {
  return lines.reduce((sum, line) => sum + line[field], 0n);
}

function centsView(value: bigint | string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  return BigInt(value).toString();
}

function dateView(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function capacityView(capacity: CreditCapacity) {
  return {
    originalTtcCents: centsView(capacity.originalTtcCents),
    activePaymentCents: centsView(capacity.activePaymentCents),
    postedCreditCents: centsView(capacity.postedCreditCents),
    remainingTtcCents: centsView(capacity.remainingTtcCents),
    lines: capacity.lines.map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))),
  };
}

function artifactMetadata(artifact: any) {
  const invoiceNo = artifact.invoice?.invoiceNo ?? null;
  const fileName = invoiceNo ? `${String(invoiceNo).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf` : `${artifact.id}.pdf`;
  return {
    id: artifact.id,
    invoiceId: artifact.invoiceId,
    companyId: artifact.companyId,
    kind: artifact.kind,
    revision: artifact.revision,
    fileName,
    suggestedName: fileName,
    mimeType: artifact.mimeType,
    byteSize: centsView(artifact.byteSize),
    contentSha256: artifact.contentSha256,
    payloadSha256: artifact.payloadSha256,
    immutable: artifact.immutable,
    createdAt: dateView(artifact.createdAt),
  };
}

function creditView(invoice: any, capacity?: CreditCapacity) {
  const original = invoice.creditedInvoice ?? null;
  return {
    id: invoice.id,
    companyId: invoice.companyId,
    documentType: invoice.documentType,
    creditedInvoiceId: invoice.creditedInvoiceId,
    creditReason: invoice.creditReason,
    artifactRequired: invoice.artifactRequired,
    kind: invoice.kind,
    counterpartyId: invoice.counterpartyId,
    counterparty: invoice.counterparty,
    counterpartyNameSnapshot: invoice.counterpartyNameSnapshot,
    iceSnapshot: invoice.iceSnapshot,
    invoiceNo: invoice.invoiceNo,
    invoiceDate: dateView(invoice.invoiceDate),
    dueDate: dateView(invoice.dueDate),
    currency: invoice.currency,
    htCents: centsView(invoice.htCents),
    vatCents: centsView(invoice.vatCents),
    ttcCents: centsView(invoice.ttcCents),
    lifecycleStatus: invoice.lifecycleStatus,
    status: invoice.status,
    postedEntryId: invoice.postedEntryId,
    postedAt: dateView(invoice.postedAt),
    version: invoice.version,
    originalInvoice: original ? {
      id: original.id,
      invoiceNo: original.invoiceNo,
      invoiceDate: dateView(original.invoiceDate),
      kind: original.kind,
      currency: original.currency,
      counterpartyId: original.counterpartyId,
      ttcCents: centsView(original.ttcCents),
      version: original.version,
    } : null,
    lines: (invoice.lines ?? []).map((line: any) => ({
      id: line.id,
      position: line.position,
      creditedInvoiceLineId: line.creditedInvoiceLineId,
      description: line.description,
      accountId: line.accountId,
      vatRateBps: line.vatRateBps,
      taxRateDefinitionId: line.taxRateDefinitionId,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot,
      taxRateLabelSnapshot: line.taxRateLabelSnapshot,
      taxRateDirectionSnapshot: line.taxRateDirectionSnapshot,
      taxConfigurationRevisionSnapshot: line.taxConfigurationRevisionSnapshot,
      htCents: centsView(line.htCents),
      vatCents: centsView(line.vatCents),
      ttcCents: centsView(line.ttcCents),
    })),
    artifacts: (invoice.artifacts ?? []).map(artifactMetadata),
    remainingCredit: capacity ? capacityView(capacity) : null,
  };
}

const creditInclude = {
  creditedInvoice: true,
  counterpartyModel: true,
  lines: { include: { account: true, creditedInvoiceLine: true }, orderBy: { position: "asc" } },
  postedEntry: { include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } },
  artifacts: { include: { invoice: { select: { invoiceNo: true } } }, orderBy: [{ revision: "desc" }, { createdAt: "desc" }] },
};

async function getOriginal(tx: any, companyId: string, originalInvoiceId: string) {
  const original = await tx.invoice.findUnique({
    where: { id: originalInvoiceId },
    include: {
      counterpartyModel: true,
      lines: { include: { account: true }, orderBy: { position: "asc" } },
      allocations: { include: { payment: true } },
    },
  });
  if (!original || original.companyId !== companyId) throw new Error("La facture d'origine n'appartient pas à la société sélectionnée.");
  if (original.documentType !== NORMAL_DOCUMENT_TYPE) throw new Error("Un avoir ne peut cibler qu'une facture normale, jamais un autre avoir.");
  if (original.lifecycleStatus !== "POSTED") throw new Error("Seule une facture normale comptabilisée peut recevoir un avoir.");
  if (!original.counterpartyId || !original.counterpartyModel) throw new Error("La facture d'origine ne possède pas de tiers opérationnel fiable.");
  if (!original.counterpartyModel.active) throw new Error("Le tiers de la facture d'origine est archivé.");
  if (!new Set(["SALE", "PURCHASE"]).has(original.kind)) throw new Error("Le type de facture d'origine n'est pas pris en charge.");
  if (!/^[A-Z]{3}$/.test(original.currency)) throw new Error("La devise de la facture d'origine est invalide.");
  if (!original.lines.length || original.lines.some((line: any) => !line.accountId)) {
    throw new Error("Chaque ligne de la facture d'origine doit être liée à un compte comptable.");
  }
  validateOriginalIntegrity(original);
  return original;
}

/** Computes the exact amount still eligible for credits. */
export async function calculateCreditCapacity14(tx: any, original: any, excludeCreditId?: string | null): Promise<CreditCapacity> {
  const postedCredits = await tx.invoice.findMany({
    where: {
      companyId: original.companyId,
      documentType: CREDIT_DOCUMENT_TYPE,
      creditedInvoiceId: original.id,
      lifecycleStatus: "POSTED",
      ...(excludeCreditId ? { NOT: { id: excludeCreditId } } : {}),
    },
    include: { lines: true },
  });
  const activePaymentCents = (original.allocations ?? []).reduce((sum: bigint, allocation: any) => {
    if (allocation.status !== "ACTIVE" || !allocation.payment || !new Set(["POSTED", "LEGACY"]).has(allocation.payment.lifecycleStatus)) return sum;
    const amount = BigInt(allocation.amountCents);
    if (amount <= 0n) throw new Error("Une imputation de paiement active contient un montant non positif.");
    return sum + amount;
  }, 0n);
  const postedCreditCents = postedCredits.reduce((sum: bigint, credit: any) => {
    const amount = BigInt(credit.ttcCents);
    if (amount <= 0n) throw new Error(`L'avoir comptabilisé ${credit.invoiceNo} contient un total non positif.`);
    return sum + amount;
  }, 0n);
  const remainingTtcCents = BigInt(original.ttcCents) - activePaymentCents - postedCreditCents;
  const perLine = new Map<string, { ht: bigint; vat: bigint; ttc: bigint }>();
  for (const credit of postedCredits) {
    for (const line of credit.lines) {
      if (!line.creditedInvoiceLineId) throw new Error(`L'avoir comptabilisé ${credit.invoiceNo} contient une ligne sans origine vérifiable.`);
      const accumulated = perLine.get(line.creditedInvoiceLineId) ?? { ht: 0n, vat: 0n, ttc: 0n };
      accumulated.ht += BigInt(line.htCents);
      accumulated.vat += BigInt(line.vatCents);
      accumulated.ttc += BigInt(line.ttcCents);
      if (BigInt(line.htCents) < 0n || BigInt(line.vatCents) < 0n || BigInt(line.ttcCents) <= 0n || BigInt(line.htCents) + BigInt(line.vatCents) !== BigInt(line.ttcCents)) {
        throw new Error(`L'avoir comptabilisé ${credit.invoiceNo} contient une ligne de montant invalide.`);
      }
      perLine.set(line.creditedInvoiceLineId, accumulated);
    }
  }
  const lines = original.lines.map((line: any) => {
    const credited = perLine.get(line.id) ?? { ht: 0n, vat: 0n, ttc: 0n };
    return {
      creditedInvoiceLineId: line.id,
      originalHtCents: BigInt(line.htCents),
      originalVatCents: BigInt(line.vatCents),
      originalTtcCents: BigInt(line.ttcCents),
      postedCreditHtCents: credited.ht,
      postedCreditVatCents: credited.vat,
      postedCreditTtcCents: credited.ttc,
      remainingHtCents: BigInt(line.htCents) - credited.ht,
      remainingVatCents: BigInt(line.vatCents) - credited.vat,
      remainingTtcCents: BigInt(line.ttcCents) - credited.ttc,
    };
  });
  if (remainingTtcCents < 0n || lines.some((line: any) => line.remainingHtCents < 0n || line.remainingVatCents < 0n || line.remainingTtcCents < 0n)) {
    throw new Error("La facture d'origine est déjà sur-créditée ou sur-payée. Corrigez ses imputations avant de continuer.");
  }
  return {
    originalTtcCents: BigInt(original.ttcCents),
    activePaymentCents,
    postedCreditCents,
    remainingTtcCents,
    lines,
  };
}

function validateOriginalIntegrity(original: any) {
  const ht = original.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.htCents), 0n);
  const vat = original.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.vatCents), 0n);
  const ttc = original.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.ttcCents), 0n);
  if (ht !== BigInt(original.htCents) || vat !== BigInt(original.vatCents) || ttc !== BigInt(original.ttcCents) || ht + vat !== ttc || ttc <= 0n) {
    throw new Error("Les totaux de la facture d'origine ne correspondent plus à ses lignes.");
  }
}

function validateStoredCreditIntegrity(original: any, credit: any) {
  const sourceById = new Map(original.lines.map((line: any) => [line.id, line]));
  for (const line of credit.lines) {
    const source = sourceById.get(line.creditedInvoiceLineId) as any;
    if (!source) throw new Error("Une ligne de l'avoir n'est plus liée à une ligne de la facture d'origine.");
    const snapshotFields = [
      "accountId",
      "vatRateBps",
      "taxRateDefinitionId",
      "taxRateCodeSnapshot",
      "taxRateLabelSnapshot",
      "taxRateDirectionSnapshot",
      "taxConfigurationRevisionSnapshot",
    ];
    for (const field of snapshotFields) {
      if ((line[field] ?? null) !== (source[field] ?? null)) {
        throw new Error(`La ligne « ${source.description} » ne conserve plus le compte ou le snapshot fiscal de la facture d'origine.`);
      }
    }
  }
  const ht = credit.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.htCents), 0n);
  const vat = credit.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.vatCents), 0n);
  const ttc = credit.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.ttcCents), 0n);
  if (ht !== BigInt(credit.htCents) || vat !== BigInt(credit.vatCents) || ttc !== BigInt(credit.ttcCents) || ht + vat !== ttc || ttc <= 0n) {
    throw new Error("Les totaux de l'avoir ne correspondent plus à ses lignes.");
  }
}

function validateRequestedCredit(original: any, normalized: NormalizedCreditPayload, capacity: CreditCapacity) {
  const sourceById = new Map(original.lines.map((line: any) => [line.id, line]));
  const capacityById = new Map(capacity.lines.map((line) => [line.creditedInvoiceLineId, line]));
  for (const line of normalized.lines) {
    const source = sourceById.get(line.creditedInvoiceLineId) as any;
    const remaining = capacityById.get(line.creditedInvoiceLineId);
    if (!source || !remaining) throw new Error("Une ligne d'avoir ne correspond pas à la facture d'origine.");
    if (line.htCents > remaining.remainingHtCents || line.vatCents > remaining.remainingVatCents || line.ttcCents > remaining.remainingTtcCents) {
      throw new Error(`La ligne « ${source.description} » dépasse son solde HT, TVA ou TTC encore créditable.`);
    }
    if (source.htCents === 0n && line.htCents !== 0n) throw new Error("Un HT ne peut pas être ajouté à une ligne d'origine sans HT.");
    if (source.vatCents === 0n && line.vatCents !== 0n) throw new Error("Une TVA ne peut pas être ajoutée à une ligne d'origine sans TVA.");
  }
  const requestedTtc = total(normalized.lines, "ttcCents");
  if (requestedTtc > capacity.remainingTtcCents) {
    throw new Error("Le total des paiements actifs et des avoirs comptabilisés dépasserait le TTC de la facture d'origine.");
  }
}

function inheritedLines(original: any, normalized: NormalizedCreditPayload) {
  const sourceById = new Map(original.lines.map((line: any) => [line.id, line]));
  return normalized.lines.map((line) => {
    const source = sourceById.get(line.creditedInvoiceLineId) as any;
    if (!source) throw new Error("Une ligne de facture d'origine n'existe plus.");
    return {
      position: line.position,
      creditedInvoiceLineId: source.id,
      description: source.description,
      accountId: source.accountId,
      quantityMilli: null,
      unitPriceCents: null,
      discountCents: 0n,
      vatRateBps: source.vatRateBps,
      taxRateDefinitionId: source.taxRateDefinitionId,
      taxRateCodeSnapshot: source.taxRateCodeSnapshot,
      taxRateLabelSnapshot: source.taxRateLabelSnapshot,
      taxRateDirectionSnapshot: source.taxRateDirectionSnapshot,
      taxConfigurationRevisionSnapshot: source.taxConfigurationRevisionSnapshot,
      htCents: line.htCents,
      vatCents: line.vatCents,
      ttcCents: line.ttcCents,
      isLegacySummary: false,
    };
  });
}

async function validateFiscalDate(tx: any, companyId: string, date: Date) {
  const fiscalYear = await tx.fiscalYear.findFirst({ where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } } });
  if (!fiscalYear) throw new Error("La date de l'avoir ne correspond à aucun exercice comptable.");
  if (fiscalYear.status !== "OPEN") throw new Error(`L'exercice « ${fiscalYear.label} » est clôturé.`);
  if (fiscalYear.lockedTo && date <= fiscalYear.lockedTo) throw new Error(`La période est verrouillée jusqu'au ${fiscalYear.lockedTo.toISOString().slice(0, 10)} inclus.`);
}

async function validateActiveAccounts(tx: any, companyId: string, ids: string[], context: string) {
  const unique = [...new Set(ids.filter(Boolean))];
  const accounts = await tx.account.findMany({ where: { id: { in: unique } } });
  const byId = new Map(accounts.map((account: any) => [account.id, account]));
  for (const id of unique) {
    const account = byId.get(id) as any;
    if (!account || account.companyId !== companyId) throw new Error(`${context} utilise un compte d'une autre société ou inexistant.`);
    if (!account.active) throw new Error(`${context} utilise le compte archivé ${account.code}.`);
  }
  return byId;
}

async function allocateSaleCreditNumber(tx: any, credit: any) {
  if (credit.kind !== "SALE") return credit;
  const year = credit.invoiceDate.getUTCFullYear();
  const series = "AV";
  let sequence = await tx.invoiceSequence.findUnique({ where: { companyId_series_year: { companyId: credit.companyId, series, year } } });
  let sequenceNo = sequence?.nextNumber ?? 1;
  const padding = sequence?.padding ?? 6;
  if (!sequence) {
    sequence = await tx.invoiceSequence.create({ data: { companyId: credit.companyId, series, year, nextNumber: 2, padding } });
  } else {
    await tx.invoiceSequence.update({ where: { id: sequence.id }, data: { nextNumber: { increment: 1 } } });
  }
  let invoiceNo = `${series}-${year}-${String(sequenceNo).padStart(padding, "0")}`;
  let numberKey = `CREDIT:SALE:${canonicalNumberKey(invoiceNo)}`;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const occupied = await tx.invoice.findUnique({ where: { companyId_numberKey: { companyId: credit.companyId, numberKey } }, select: { id: true } });
    if (!occupied || occupied.id === credit.id) break;
    sequenceNo += 1;
    await tx.invoiceSequence.update({ where: { id: sequence.id }, data: { nextNumber: { increment: 1 } } });
    invoiceNo = `${series}-${year}-${String(sequenceNo).padStart(padding, "0")}`;
    numberKey = `CREDIT:SALE:${canonicalNumberKey(invoiceNo)}`;
    if (attempt === 9_999) throw new Error("Wheat n'a pas pu attribuer un numéro d'avoir client libre.");
  }
  const updated = await tx.invoice.update({
    where: { id: credit.id },
    data: { invoiceNo, numberKey, series, sequenceYear: year, sequenceNo },
  });
  return { ...credit, ...updated };
}

async function createPostedCreditEntry(tx: any, input: {
  credit: any;
  original: any;
  now: Date;
}) {
  const { credit, original } = input;
  await validateFiscalDate(tx, credit.companyId, credit.invoiceDate);
  const journalCode = credit.kind === "SALE" ? "VE" : "AC";
  const journal = await tx.journal.findUnique({ where: { companyId_code: { companyId: credit.companyId, code: journalCode } } });
  if (!journal) throw new Error(`Le journal ${journalCode} n'est pas configuré.`);
  if (!journal.active || journal.locked) throw new Error(`Le journal ${journalCode} est archivé ou verrouillé.`);
  const controlId = original.controlAccountId;
  if (!controlId) throw new Error("Le compte collectif figé sur la facture d'origine est absent.");
  if (credit.vatCents > 0n && !original.vatAccountId) throw new Error("Le compte de TVA figé sur la facture d'origine est absent.");
  const accountIds = [...credit.lines.map((line: any) => line.accountId), controlId, ...(credit.vatCents > 0n ? [original.vatAccountId] : [])];
  const accountById = await validateActiveAccounts(tx, credit.companyId, accountIds, "L'avoir");
  const thirdParty = credit.counterpartyNameSnapshot ?? credit.counterparty;
  const lines: Array<any> = credit.lines.map((line: any) => ({
    accountId: line.accountId,
    label: `Avoir - ${line.description}`,
    debitCents: credit.kind === "SALE" ? BigInt(line.htCents) : 0n,
    creditCents: credit.kind === "PURCHASE" ? BigInt(line.htCents) : 0n,
    thirdParty,
    counterpartyId: credit.counterpartyId,
  }));
  if (credit.vatCents > 0n) {
    lines.push({
      accountId: original.vatAccountId,
      label: `TVA avoir - ${credit.invoiceNo}`,
      debitCents: credit.kind === "SALE" ? BigInt(credit.vatCents) : 0n,
      creditCents: credit.kind === "PURCHASE" ? BigInt(credit.vatCents) : 0n,
      thirdParty,
      counterpartyId: credit.counterpartyId,
    });
  }
  lines.push({
    accountId: controlId,
    label: `Tiers avoir - ${credit.invoiceNo}`,
    debitCents: credit.kind === "PURCHASE" ? BigInt(credit.ttcCents) : 0n,
    creditCents: credit.kind === "SALE" ? BigInt(credit.ttcCents) : 0n,
    thirdParty,
    counterpartyId: credit.counterpartyId,
  });
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const creditTotal = lines.reduce((sum, line) => sum + line.creditCents, 0n);
  if (debit === 0n || debit !== creditTotal) throw new Error("L'écriture générée pour l'avoir n'est pas équilibrée.");
  const piece = await allocatePieceNumber(tx, { companyId: credit.companyId, journalId: journal.id, date: credit.invoiceDate, source: "SUBLEDGER_CREDIT_NOTE_1_4" });
  const draft = await tx.entry.create({
    data: {
      companyId: credit.companyId,
      journalId: journal.id,
      journalCodeSnapshot: journal.code,
      number: provisionalEntryNumber(),
      date: credit.invoiceDate,
      ...piece,
      pieceNumberRaw: credit.invoiceNo,
      pieceNumberSearch: normalizeAccountSearch(`${piece.pieceNumber} ${credit.invoiceNo}`),
      label: `Avoir ${credit.kind === "SALE" ? "client" : "fournisseur"} ${credit.invoiceNo}`,
      status: ENTRY_STATUS.draft,
      source: "SUBLEDGER_CREDIT_NOTE_1_4",
      auditNote: `Écriture opposée générée depuis l'avoir ${credit.id}, sans lien d'extourne`,
      reversalOfId: null,
      lines: {
        create: lines.map((line, index) => {
          const account = accountById.get(line.accountId) as any;
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
  let sequenceNo = journal.nextNumber;
  let number = `${journal.code}-${credit.invoiceDate.getUTCFullYear()}-${String(sequenceNo).padStart(6, "0")}`;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const occupied = await tx.entry.findUnique({ where: { companyId_number: { companyId: credit.companyId, number } }, select: { id: true } });
    if (!occupied) break;
    sequenceNo += 1;
    number = `${journal.code}-${credit.invoiceDate.getUTCFullYear()}-${String(sequenceNo).padStart(6, "0")}`;
    if (attempt === 9_999) throw new Error("Wheat n'a pas pu attribuer un numéro d'écriture à l'avoir.");
  }
  await tx.journal.update({ where: { id: journal.id }, data: { nextNumber: sequenceNo + 1 } });
  const changed = await tx.entry.updateMany({
    where: { id: draft.id, status: ENTRY_STATUS.draft },
    data: { number, status: ENTRY_STATUS.posted, postedAt: input.now, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new Error("L'écriture de l'avoir a été traitée dans une autre opération.");
  return tx.entry.findUniqueOrThrow({ where: { id: draft.id }, include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } });
}

function artifactPayload(company: any, credit: any, original: any, entry: any) {
  return {
    schema: "ma.wheat.credit-note-artifact.v1",
    company: { id: company.id, name: company.name, legalForm: company.legalForm, ice: company.ice, taxId: company.taxId, city: company.city },
    creditNote: {
      id: credit.id,
      documentType: credit.documentType,
      invoiceNo: credit.invoiceNo,
      invoiceDate: credit.invoiceDate.toISOString().slice(0, 10),
      kind: credit.kind,
      currency: credit.currency,
      counterpartyId: credit.counterpartyId,
      counterpartyName: credit.counterpartyNameSnapshot ?? credit.counterparty,
      counterpartyIce: credit.iceSnapshot,
      creditReason: credit.creditReason,
      htCents: BigInt(credit.htCents).toString(),
      vatCents: BigInt(credit.vatCents).toString(),
      ttcCents: BigInt(credit.ttcCents).toString(),
    },
    originalInvoice: {
      id: original.id,
      invoiceNo: original.invoiceNo,
      invoiceDate: original.invoiceDate.toISOString().slice(0, 10),
      kind: original.kind,
      currency: original.currency,
      counterpartyId: original.counterpartyId,
      htCents: BigInt(original.htCents).toString(),
      vatCents: BigInt(original.vatCents).toString(),
      ttcCents: BigInt(original.ttcCents).toString(),
    },
    entry: { id: entry.id, number: entry.number, journalCode: entry.journalCodeSnapshot, date: entry.date.toISOString().slice(0, 10) },
    lines: credit.lines.map((line: any) => ({
      id: line.id,
      position: line.position,
      creditedInvoiceLineId: line.creditedInvoiceLineId,
      description: line.description,
      accountId: line.accountId,
      accountCodeSnapshot: line.account?.code,
      accountLabelSnapshot: line.account?.label,
      vatRateBps: line.vatRateBps,
      taxRateDefinitionId: line.taxRateDefinitionId,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot,
      taxRateLabelSnapshot: line.taxRateLabelSnapshot,
      taxRateDirectionSnapshot: line.taxRateDirectionSnapshot,
      taxConfigurationRevisionSnapshot: line.taxConfigurationRevisionSnapshot,
      htCents: BigInt(line.htCents).toString(),
      vatCents: BigInt(line.vatCents).toString(),
      ttcCents: BigInt(line.ttcCents).toString(),
    })),
  };
}

function pdfSnapshot(payload: any, payloadSha256: string): CreditNotePdfSnapshot {
  return {
    company: payload.company,
    creditNote: payload.creditNote,
    originalInvoice: payload.originalInvoice,
    entry: payload.entry,
    lines: payload.lines,
    payloadSha256,
  };
}

export type PostedInvoiceArtifact14Input = {
  companyId: string;
  invoiceId: string;
  entryId: string;
  createdByUserId?: string | null;
  generateArtifact?: CreditNoteArtifactGenerator;
};

/**
 * Creates the immutable PDF evidence for a newly posted normal invoice. Call
 * this inside the same Prisma transaction after its Entry is posted and before
 * the invoice header is transitioned from DRAFT to POSTED. Any render or insert
 * failure rejects the caller's transaction.
 */
export async function createImmutablePostedInvoiceArtifact14(tx: any, input: PostedInvoiceArtifact14Input) {
  const companyId = requireId(input.companyId, "La société");
  const invoiceId = requireId(input.invoiceId, "La facture");
  const entryId = requireId(input.entryId, "L'écriture");
  const [company, invoice, entry] = await Promise.all([
    tx.company.findUnique({ where: { id: companyId } }),
    tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { include: { account: true }, orderBy: { position: "asc" } } },
    }),
    tx.entry.findUnique({ where: { id: entryId }, include: { journal: true } }),
  ]);
  if (!company) throw new Error("La société de l'artefact n'existe plus.");
  if (!invoice || invoice.companyId !== companyId) throw new Error("La facture de l'artefact n'appartient pas à cette société.");
  if (invoice.documentType !== NORMAL_DOCUMENT_TYPE) throw new Error("Ce générateur est réservé aux factures normales ; les avoirs utilisent leur artefact lié.");
  if (!new Set(["DRAFT", "POSTED"]).has(invoice.lifecycleStatus)) throw new Error("La facture normale n'est pas dans un état publiable.");
  if (!entry || entry.companyId !== companyId || entry.status !== ENTRY_STATUS.posted) throw new Error("L'écriture comptabilisée de la facture n'est pas disponible dans cette société.");
  if (entry.reversalOfId) throw new Error("Une facture normale ne peut pas utiliser une écriture d'extourne comme preuve de comptabilisation.");
  if (!invoice.lines.length || invoice.lines.some((line: any) => !line.accountId || !line.account?.active)) {
    throw new Error("Chaque ligne de la facture doit conserver un compte actif avant la génération de son artefact.");
  }
  validateOriginalIntegrity(invoice);
  const evidence = {
    schema: "ma.wheat.invoice-artifact.v1",
    company: { id: company.id, name: company.name, legalForm: company.legalForm, ice: company.ice, taxId: company.taxId, city: company.city },
    invoice: {
      id: invoice.id,
      documentType: invoice.documentType,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
      kind: invoice.kind,
      currency: invoice.currency,
      counterpartyId: invoice.counterpartyId,
      counterpartyName: invoice.counterpartyNameSnapshot ?? invoice.counterparty,
      counterpartyIce: invoice.iceSnapshot,
      notes: invoice.notes,
      htCents: BigInt(invoice.htCents).toString(),
      vatCents: BigInt(invoice.vatCents).toString(),
      ttcCents: BigInt(invoice.ttcCents).toString(),
      taxConfigurationVersionId: invoice.taxConfigurationVersionId,
    },
    entry: { id: entry.id, number: entry.number, journalCode: entry.journalCodeSnapshot, date: entry.date.toISOString().slice(0, 10) },
    lines: invoice.lines.map((line: any) => ({
      id: line.id,
      position: line.position,
      description: line.description,
      accountId: line.accountId,
      accountCodeSnapshot: line.account.code,
      accountLabelSnapshot: line.account.label,
      vatRateBps: line.vatRateBps,
      taxRateDefinitionId: line.taxRateDefinitionId,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot,
      taxRateLabelSnapshot: line.taxRateLabelSnapshot,
      taxRateDirectionSnapshot: line.taxRateDirectionSnapshot,
      taxConfigurationRevisionSnapshot: line.taxConfigurationRevisionSnapshot,
      htCents: BigInt(line.htCents).toString(),
      vatCents: BigInt(line.vatCents).toString(),
      ttcCents: BigInt(line.ttcCents).toString(),
    })),
  };
  const payloadJson = canonicalAuditJson(evidence);
  const payloadSha256 = sha256Hex14(payloadJson);
  const snapshot: CreditNotePdfSnapshot = {
    company: evidence.company,
    creditNote: {
      invoiceNo: evidence.invoice.invoiceNo,
      invoiceDate: evidence.invoice.invoiceDate,
      kind: evidence.invoice.kind,
      currency: evidence.invoice.currency,
      counterpartyName: evidence.invoice.counterpartyName,
      counterpartyIce: evidence.invoice.counterpartyIce,
      creditReason: evidence.invoice.notes ?? "Facture comptabilisée dans Wheat",
      htCents: evidence.invoice.htCents,
      vatCents: evidence.invoice.vatCents,
      ttcCents: evidence.invoice.ttcCents,
    },
    originalInvoice: null,
    entry: evidence.entry,
    lines: evidence.lines,
    payloadSha256,
    documentTitle: "WHEAT - FACTURE",
    reasonLabel: "Objet",
  };
  const generateArtifact = input.generateArtifact ?? ((renderInput: Parameters<CreditNoteArtifactGenerator>[0]) => generateCreditNotePdf14(renderInput.snapshot));
  const pdfBytes = Buffer.from(await generateArtifact({ snapshot, payloadJson, payloadSha256 }));
  if (!pdfBytes.length) throw new Error("La génération du PDF probant de la facture a produit un fichier vide.");
  const created = await tx.invoiceArtifact.create({
    data: {
      companyId,
      invoiceId,
      kind: "INVOICE_PDF",
      revision: 1,
      supersedesArtifactId: null,
      pdfBytes,
      storedPath: null,
      mimeType: "application/pdf",
      byteSize: BigInt(pdfBytes.length),
      contentSha256: sha256Hex14(pdfBytes),
      payloadJson,
      payloadSha256,
      createdByUserId: input.createdByUserId ?? null,
      immutable: true,
    },
    include: { invoice: { select: { invoiceNo: true } } },
  });
  return artifactMetadata(created);
}

async function appendAudit(tx: any, options: CreditNotes14ServiceOptions, data: {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  payload: Record<string, unknown>;
}) {
  await appendActivityAndAudit(tx, {
    ...data,
    actorUserId: (await options.getActorUserId?.()) ?? null,
  });
}

function assertArtifactImmutable(invoice: any) {
  if (invoice.documentType === CREDIT_DOCUMENT_TYPE || invoice.artifactRequired) {
    throw new Error(invoice.documentType === CREDIT_DOCUMENT_TYPE
      ? "Un avoir 1.4 et son artefact probant sont immuables après comptabilisation ; créez un nouvel avoir correctif."
      : "Cette facture 1.4 possède un artefact probant immuable ; corrigez-la par un avoir lié.");
  }
}

/** Exported for the legacy subledger void guard. */
export function assertCreditNoteTechnicalVoidBlocked14(invoice: any) {
  assertArtifactImmutable(invoice);
}

async function loadArtifact(tx: any, companyId: string, artifactId: string) {
  const artifact = await tx.invoiceArtifact.findUnique({ where: { id: artifactId }, include: { invoice: true } });
  if (!artifact || artifact.companyId !== companyId || artifact.invoice?.companyId !== companyId) throw new Error("L'artefact de facture n'existe pas dans cette société.");
  if (!artifact.immutable) throw new Error("L'artefact demandé ne porte pas le marqueur d'immuabilité Wheat.");
  return artifact;
}

function verifyArtifactRecord(artifact: any) {
  const problems: string[] = [];
  const bytes = Buffer.from(artifact.pdfBytes);
  const contentSha256 = sha256Hex14(bytes);
  const payloadSha256 = sha256Hex14(artifact.payloadJson);
  if (contentSha256 !== artifact.contentSha256) problems.push("L'empreinte SHA-256 du PDF ne correspond plus aux octets enregistrés.");
  if (payloadSha256 !== artifact.payloadSha256) problems.push("L'empreinte SHA-256 du contenu probant ne correspond plus au snapshot enregistré.");
  if (BigInt(bytes.length) !== BigInt(artifact.byteSize)) problems.push("La taille enregistrée ne correspond plus aux octets du PDF.");
  if (!bytes.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4")) problems.push("Le contenu enregistré n'est pas un PDF Wheat reconnu.");
  try {
    const parsed = JSON.parse(artifact.payloadJson);
    if (canonicalAuditJson(parsed) !== artifact.payloadJson) problems.push("Le snapshot probant n'est plus dans sa forme canonique.");
    if ((parsed.creditNote?.id ?? parsed.invoice?.id) !== artifact.invoiceId) problems.push("Le snapshot probant pointe vers une autre facture.");
  } catch {
    problems.push("Le snapshot probant n'est plus un JSON lisible.");
  }
  return { valid: problems.length === 0, problems, bytes, contentSha256, payloadSha256 };
}

export function createCreditNotes14Service(options: CreditNotes14ServiceOptions) {
  const now = () => options.now?.() ?? new Date();
  const generateArtifact = options.generateArtifact ?? ((input) => generateCreditNotePdf14(input.snapshot));

  return {
    async createCreditNote(payload: unknown) {
      const normalized = normalizeCreditPayload(payload);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const company = await tx.company.findUnique({ where: { id: normalized.companyId } });
        if (!company) throw new Error("La société sélectionnée n'existe plus.");
        const original = await getOriginal(tx, normalized.companyId, normalized.creditedInvoiceId);
        if (original.kind === "PURCHASE" && !normalized.invoiceNo) throw new Error("La référence de l'avoir fournisseur est obligatoire.");
        const capacity = await calculateCreditCapacity14(tx, original);
        validateRequestedCredit(original, normalized, capacity);
        const invoiceNo = original.kind === "SALE" ? `BROUILLON-AV-${randomUUID()}` : normalized.invoiceNo!;
        const numberKey = original.kind === "SALE"
          ? `DRAFT:CREDIT:${randomUUID()}`
          : `CREDIT:PURCHASE:${original.counterpartyId}:${canonicalNumberKey(invoiceNo)}`;
        const created = await tx.invoice.create({
          data: {
            companyId: normalized.companyId,
            documentType: CREDIT_DOCUMENT_TYPE,
            creditedInvoiceId: original.id,
            creditReason: normalized.creditReason,
            artifactRequired: true,
            taxConfigurationVersionId: original.taxConfigurationVersionId,
            kind: original.kind,
            counterpartyId: original.counterpartyId,
            counterparty: original.counterparty,
            counterpartyNameSnapshot: original.counterpartyNameSnapshot ?? original.counterparty,
            ice: original.ice,
            iceSnapshot: original.iceSnapshot,
            taxIdSnapshot: original.taxIdSnapshot,
            billingAddressSnapshot: original.billingAddressSnapshot,
            invoiceNo,
            numberKey,
            series: original.kind === "SALE" ? "AV" : null,
            invoiceDate: normalized.invoiceDate,
            dueDate: normalized.invoiceDate,
            currency: original.currency,
            htCents: total(normalized.lines, "htCents"),
            vatCents: total(normalized.lines, "vatCents"),
            ttcCents: total(normalized.lines, "ttcCents"),
            status: "DRAFT",
            lifecycleStatus: "DRAFT",
            source: CREDIT_SOURCE,
            needsReview: false,
            controlAccountId: original.controlAccountId,
            vatAccountId: original.vatAccountId,
            lines: { create: inheritedLines(original, normalized) },
          },
          include: creditInclude,
        });
        await appendAudit(tx, options, {
          companyId: created.companyId,
          action: "CREATE_CREDIT_NOTE_DRAFT",
          entityType: "Invoice",
          entityId: created.id,
          description: `Brouillon d'avoir lié à ${original.invoiceNo} créé`,
          payload: { originalInvoiceId: original.id, ttcCents: created.ttcCents.toString(), artifactRequired: true },
        });
        return creditView(created, capacity);
      });
    },

    async updateCreditNote(payload: unknown) {
      const input = record(payload, "La mise à jour de l'avoir");
      const id = requireId(input.id, "L'avoir");
      const version = exactVersion(input.expectedVersion);
      const normalized = normalizeCreditPayload(input);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        const current = await tx.invoice.findUnique({ where: { id } });
        if (!current || current.companyId !== normalized.companyId || current.documentType !== CREDIT_DOCUMENT_TYPE) throw new Error("L'avoir n'existe plus dans cette société.");
        if (current.lifecycleStatus !== "DRAFT") throw new Error("Seul un brouillon d'avoir peut être modifié.");
        if (current.version !== version) throw new Error("L'avoir a été modifié dans une autre fenêtre. Rechargez puis réessayez.");
        if (current.creditedInvoiceId !== normalized.creditedInvoiceId) throw new Error("La facture d'origine d'un avoir ne peut pas être remplacée.");
        const original = await getOriginal(tx, normalized.companyId, normalized.creditedInvoiceId);
        if (original.kind === "PURCHASE" && !normalized.invoiceNo) throw new Error("La référence de l'avoir fournisseur est obligatoire.");
        const capacity = await calculateCreditCapacity14(tx, original, id);
        validateRequestedCredit(original, normalized, capacity);
        const invoiceNo = original.kind === "SALE" ? current.invoiceNo : normalized.invoiceNo!;
        const numberKey = original.kind === "SALE" ? current.numberKey : `CREDIT:PURCHASE:${original.counterpartyId}:${canonicalNumberKey(invoiceNo)}`;
        const changed = await tx.invoice.updateMany({
          where: { id, companyId: normalized.companyId, documentType: CREDIT_DOCUMENT_TYPE, lifecycleStatus: "DRAFT", version },
          data: {
            invoiceNo,
            numberKey,
            invoiceDate: normalized.invoiceDate,
            dueDate: normalized.invoiceDate,
            creditReason: normalized.creditReason,
            htCents: total(normalized.lines, "htCents"),
            vatCents: total(normalized.lines, "vatCents"),
            ttcCents: total(normalized.lines, "ttcCents"),
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("L'avoir a été modifié dans une autre fenêtre.");
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLine.createMany({ data: inheritedLines(original, normalized).map((line) => ({ ...line, invoiceId: id })) });
        await appendAudit(tx, options, {
          companyId: normalized.companyId,
          action: "UPDATE_CREDIT_NOTE_DRAFT",
          entityType: "Invoice",
          entityId: id,
          description: `Brouillon d'avoir de ${original.invoiceNo} mis à jour`,
          payload: { previousVersion: version, ttcCents: total(normalized.lines, "ttcCents").toString() },
        });
        const updated = await tx.invoice.findUniqueOrThrow({ where: { id }, include: creditInclude });
        return creditView(updated, capacity);
      });
    },

    async postCreditNote(payload: unknown) {
      const input = record(payload, "La comptabilisation de l'avoir");
      const id = requireId(input.id, "L'avoir");
      const companyId = requireId(input.companyId, "La société");
      const version = exactVersion(input.expectedVersion);
      const prisma = await options.getPrisma();
      return prisma.$transaction(async (tx: any) => {
        let credit = await tx.invoice.findUnique({ where: { id }, include: creditInclude });
        if (!credit || credit.companyId !== companyId || credit.documentType !== CREDIT_DOCUMENT_TYPE) throw new Error("L'avoir n'existe plus dans cette société.");
        if (credit.lifecycleStatus !== "DRAFT") throw new Error("Seul un brouillon d'avoir peut être comptabilisé.");
        if (credit.version !== version) throw new Error("L'avoir a été modifié dans une autre fenêtre.");
        if (!credit.artifactRequired) throw new Error("L'avoir ne porte pas l'obligation d'artefact Wheat.");
        if (!credit.creditedInvoiceId) throw new Error("L'avoir n'est lié à aucune facture d'origine.");

        // Acquire SQLite's writer lock before reading allocations and prior
        // credits. Rolling back any later check also rolls this reservation back.
        const originalBeforeReservation = await tx.invoice.findUnique({ where: { id: credit.creditedInvoiceId }, select: { id: true, version: true } });
        if (!originalBeforeReservation) throw new Error("La facture d'origine n'existe plus.");
        const reserved = await tx.invoice.updateMany({
          where: { id: originalBeforeReservation.id, companyId, documentType: NORMAL_DOCUMENT_TYPE, lifecycleStatus: "POSTED", version: originalBeforeReservation.version },
          data: { version: { increment: 1 } },
        });
        if (reserved.count !== 1) throw new Error("La facture d'origine vient d'être modifiée ; rechargez son solde avant de comptabiliser l'avoir.");
        const original = await getOriginal(tx, companyId, credit.creditedInvoiceId);
        if (credit.kind !== original.kind || credit.currency !== original.currency || credit.counterpartyId !== original.counterpartyId) {
          throw new Error("Le type, la devise et le tiers de l'avoir doivent rester identiques à ceux de la facture d'origine.");
        }
        validateOriginalIntegrity(original);
        validateStoredCreditIntegrity(original, credit);
        const normalized: NormalizedCreditPayload = {
          companyId,
          creditedInvoiceId: original.id,
          invoiceDate: credit.invoiceDate,
          invoiceNo: credit.kind === "PURCHASE" ? credit.invoiceNo : null,
          creditReason: credit.creditReason,
          lines: credit.lines.map((line: any, index: number) => ({
            position: index + 1,
            creditedInvoiceLineId: line.creditedInvoiceLineId,
            htCents: BigInt(line.htCents),
            vatCents: BigInt(line.vatCents),
            ttcCents: BigInt(line.ttcCents),
          })),
        };
        if (credit.kind === "PURCHASE" && !credit.invoiceNo) throw new Error("La référence de l'avoir fournisseur est obligatoire.");
        const capacity = await calculateCreditCapacity14(tx, original, id);
        validateRequestedCredit(original, normalized, capacity);
        await validateFiscalDate(tx, companyId, credit.invoiceDate);
        await allocateSaleCreditNumber(tx, credit);
        credit = await tx.invoice.findUniqueOrThrow({ where: { id }, include: creditInclude });
        const postedAt = now();
        const entry = await createPostedCreditEntry(tx, { credit, original, now: postedAt });
        const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
        const evidence = artifactPayload(company, credit, original, entry);
        const payloadJson = canonicalAuditJson(evidence);
        const payloadSha256 = sha256Hex14(payloadJson);
        const snapshot = pdfSnapshot(evidence, payloadSha256);
        const generated = await generateArtifact({ snapshot, payloadJson, payloadSha256 });
        const content = Buffer.from(generated);
        if (!content.length) throw new Error("La génération du PDF probant de l'avoir a produit un fichier vide.");
        const contentSha256 = sha256Hex14(content);
        const artifactActorUserId = (await options.getActorUserId?.()) ?? null;
        await tx.invoiceArtifact.create({
          data: {
            companyId,
            invoiceId: id,
            kind: CREDIT_ARTIFACT_KIND,
            revision: 1,
            supersedesArtifactId: null,
            storedPath: null,
            mimeType: "application/pdf",
            pdfBytes: content,
            byteSize: BigInt(content.length),
            contentSha256,
            payloadJson,
            payloadSha256,
            createdByUserId: artifactActorUserId,
            immutable: true,
          },
        });
        const changed = await tx.invoice.updateMany({
          where: { id, companyId, documentType: CREDIT_DOCUMENT_TYPE, lifecycleStatus: "DRAFT", version },
          data: {
            lifecycleStatus: "POSTED",
            status: "CREDITED",
            postedEntryId: entry.id,
            postedAt,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new Error("L'avoir a été traité dans une autre fenêtre.");
        await appendAudit(tx, options, {
          companyId,
          action: "POST_CREDIT_NOTE",
          entityType: "Invoice",
          entityId: id,
          description: `Avoir ${credit.invoiceNo} comptabilisé avec artefact PDF immuable`,
          payload: {
            originalInvoiceId: original.id,
            originalInvoiceNo: original.invoiceNo,
            originalPreviousVersion: originalBeforeReservation.version,
            originalNewVersion: originalBeforeReservation.version + 1,
            entryId: entry.id,
            entryNumber: entry.number,
            ttcCents: BigInt(credit.ttcCents).toString(),
            payloadSha256,
            contentSha256,
            artifactRequired: true,
          },
        });
        const posted = await tx.invoice.findUniqueOrThrow({ where: { id }, include: creditInclude });
        const remainingAfter = await calculateCreditCapacity14(tx, original);
        return creditView(posted, remainingAfter);
      });
    },

    async listInvoiceArtifacts(payload: unknown) {
      const input = record(payload, "Les filtres d'artefacts");
      const companyId = requireId(input.companyId, "La société");
      const invoiceId = input.invoiceId ? requireId(input.invoiceId, "La facture") : null;
      const prisma = await options.getPrisma();
      const artifacts = await prisma.invoiceArtifact.findMany({
        where: { companyId, ...(invoiceId ? { invoiceId } : {}) },
        include: { invoice: { select: { invoiceNo: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 250,
      });
      return { items: artifacts.map(artifactMetadata), truncated: artifacts.length === 250 };
    },

    async verifyInvoiceArtifact(payload: unknown) {
      const input = record(payload, "La vérification d'artefact");
      const companyId = requireId(input.companyId, "La société");
      const artifactId = requireId(input.artifactId, "L'artefact");
      const prisma = await options.getPrisma();
      const artifact = await loadArtifact(prisma, companyId, artifactId);
      const verification = verifyArtifactRecord(artifact);
      return { artifact: artifactMetadata(artifact), valid: verification.valid, problems: verification.problems };
    },

    async exportInvoiceArtifact(payload: unknown) {
      const input = record(payload, "L'export d'artefact");
      const companyId = requireId(input.companyId, "La société");
      const artifactId = requireId(input.artifactId, "L'artefact");
      const prisma = await options.getPrisma();
      const artifact = await loadArtifact(prisma, companyId, artifactId);
      const verification = verifyArtifactRecord(artifact);
      if (!verification.valid) throw new Error(`L'artefact ne peut pas être exporté car son intégrité a échoué : ${verification.problems.join(" ")}`);
      return {
        artifact: artifactMetadata(artifact),
        bytesBase64: verification.bytes.toString("base64"),
      };
    },
  };
}

export type CreditNotes14Service = ReturnType<typeof createCreditNotes14Service>;

export function registerCreditNotes14Ipc(options: CreditNotes14RegistrationOptions) {
  const service = createCreditNotes14Service(options);
  const serialize = options.serialize ?? ((value: any) => value);
  const bind = (channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  };
  bind(CREDIT_NOTES_14_IPC_CHANNELS.creditCreate, service.createCreditNote);
  bind(CREDIT_NOTES_14_IPC_CHANNELS.creditUpdate, service.updateCreditNote);
  bind(CREDIT_NOTES_14_IPC_CHANNELS.creditPost, service.postCreditNote);
  bind(CREDIT_NOTES_14_IPC_CHANNELS.artifactList, service.listInvoiceArtifacts);
  bind(CREDIT_NOTES_14_IPC_CHANNELS.artifactVerify, service.verifyInvoiceArtifact);
  bind(CREDIT_NOTES_14_IPC_CHANNELS.artifactExport, service.exportInvoiceArtifact);
  return service;
}
