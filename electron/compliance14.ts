import { createHash, randomUUID } from "node:crypto";
import { STORED_SCHEMA_VERSIONS } from "./legacyDomainValues";
import { appendActivityAndAudit, verifyAuditChain } from "./audit13";

/**
 * Wheat compliance workspaces are preparation and evidence tools. They do
 * not transmit a tax return and a local audit checkpoint is not an external
 * signature, timestamp, or certification.
 */
export const COMPLIANCE_14_IPC_CHANNELS = {
  taxWorkspace: "wheat:tax:workspace",
  taxConfigSaveDraft: "wheat:tax:config:save-draft",
  taxConfigActivate: "wheat:tax:config:activate",
  taxConfigClone: "wheat:tax:config:clone",
  vatWorkpaperList: "wheat:vat-workpaper:list",
  vatWorkpaperGet: "wheat:vat-workpaper:get",
  vatWorkpaperGenerate: "wheat:vat-workpaper:generate",
  vatWorkpaperRegenerate: "wheat:vat-workpaper:regenerate",
  vatWorkpaperAddAdjustment: "wheat:vat-workpaper:add-adjustment",
  vatWorkpaperAttachEvidence: "wheat:vat-workpaper:attach-evidence",
  vatWorkpaperRemoveEvidence: "wheat:vat-workpaper:remove-evidence",
  vatWorkpaperReview: "wheat:vat-workpaper:review",
  vatWorkpaperReturnToDraft: "wheat:vat-workpaper:return-to-draft",
  vatWorkpaperRecordFiled: "wheat:vat-workpaper:record-filed",
  vatWorkpaperReopen: "wheat:vat-workpaper:reopen",
  fiscalClosePreview: "wheat:fiscal-close:preview",
  fiscalCloseClose: "wheat:fiscal-close:close",
  fiscalCloseReopen: "wheat:fiscal-close:reopen",
  fiscalCloseRuns: "wheat:fiscal-close:runs",
  auditSealList: "wheat:audit-seal:list",
  auditSealCreate: "wheat:audit-seal:create",
  auditSealVerify: "wheat:audit-seal:verify",
} as const;

type PrismaLike = any;

type GetPrisma = () => any | Promise<any>;

export interface Compliance14Options {
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  serialize?: <T>(value: T) => T;
  now?: () => Date;
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): unknown;
}

export interface Compliance14RegistrationOptions extends Compliance14Options {
  ipcMain: IpcMainLike;
}

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TEXT = 500;
const MAX_WORKSPACE_ROWS = 100;
const MAX_RATES = 100;

function record(value: unknown, message = "Les donn\u00e9es sont invalides."): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maximum = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} est requis.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} est trop long.`);
  return normalized;
}

function optionalText(value: unknown, maximum = MAX_TEXT) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Le texte fourni est invalide.");
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error("Le texte fourni est trop long.");
  return normalized || null;
}

function requireId(value: unknown, label: string) {
  return requireText(value, label, 191);
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} doit \u00eatre un entier compris entre ${minimum} et ${maximum}.`);
  }
  return value;
}

/** Monetary values crossing this boundary are integer-cent strings only. */
export function exactMoneyString(value: unknown, label = "Le montant", allowNegative = true) {
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) {
    throw new Error(`${label} doit \u00eatre fourni comme une cha\u00eene exacte de centimes entiers.`);
  }
  const amount = BigInt(value);
  if (!allowNegative && amount < 0n) throw new Error(`${label} ne peut pas \u00eatre n\u00e9gatif.`);
  return amount;
}

function parseDay(value: unknown, label: string) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) throw new Error(`${label} doit utiliser le format AAAA-MM-JJ.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} est invalide.`);
  return date;
}

function isoDay(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

function dateAfter(day: Date) {
  const after = new Date(day);
  after.setUTCDate(after.getUTCDate() + 1);
  return after;
}

function canonical(value: unknown): Canonical {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Une valeur non finie ne peut pas \u00eatre hach\u00e9e.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const result: Record<string, Canonical> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonical(child);
    }
    return result;
  }
  throw new Error(`Le type ${typeof value} ne peut pas \u00eatre hach\u00e9.`);
}

export function complianceCanonicalJson(value: unknown) {
  return JSON.stringify(canonical(value));
}

export function complianceSha256(value: unknown) {
  const source = typeof value === "string" ? value : complianceCanonicalJson(value);
  return createHash("sha256").update(source, "utf8").digest("hex");
}

type AllocationWeight = { id: string; weight: bigint };

/**
 * Allocates an exact integer total using floors then deterministic largest
 * remainders. Ties are resolved by id, so database row order cannot alter a
 * workpaper.
 */
export function largestRemainderAllocate(totalValue: bigint | string, weightsValue: AllocationWeight[]) {
  const total = typeof totalValue === "string" ? exactMoneyString(totalValue, "Le total") : totalValue;
  if (typeof total !== "bigint" || total < 0n) throw new Error("Le total \u00e0 r\u00e9partir doit \u00eatre positif ou nul.");
  if (!Array.isArray(weightsValue) || weightsValue.length === 0) {
    if (total === 0n) return [] as Array<{ id: string; amount: bigint }>;
    throw new Error("Au moins un poids est requis pour r\u00e9partir un montant non nul.");
  }
  const ids = new Set<string>();
  const weights = weightsValue.map((row) => {
    const id = requireId(row.id, "L'identifiant de r\u00e9partition");
    if (ids.has(id)) throw new Error("Les identifiants de r\u00e9partition doivent \u00eatre uniques.");
    ids.add(id);
    if (typeof row.weight !== "bigint" || row.weight < 0n) throw new Error("Chaque poids doit \u00eatre un entier positif ou nul.");
    return { id, weight: row.weight };
  });
  const denominator = weights.reduce((sum, row) => sum + row.weight, 0n);
  if (denominator === 0n) {
    if (total === 0n) return weights.map((row) => ({ id: row.id, amount: 0n }));
    throw new Error("La somme des poids ne peut pas \u00eatre nulle.");
  }
  const portions = weights.map((row) => {
    const numerator = total * row.weight;
    return { id: row.id, amount: numerator / denominator, remainder: numerator % denominator };
  });
  let left = total - portions.reduce((sum, row) => sum + row.amount, 0n);
  portions.sort((leftRow, rightRow) => {
    if (leftRow.remainder === rightRow.remainder) return leftRow.id.localeCompare(rightRow.id);
    return leftRow.remainder > rightRow.remainder ? -1 : 1;
  });
  for (let index = 0; left > 0n; index += 1, left -= 1n) portions[index % portions.length].amount += 1n;
  return portions.sort((leftRow, rightRow) => leftRow.id.localeCompare(rightRow.id)).map(({ id, amount }) => ({ id, amount }));
}

function serialize<T>(options: Compliance14Options, value: T): T {
  if (options.serialize) return options.serialize(value);
  return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child)) as T;
}

async function actorId(options: Compliance14Options) {
  return options.getActorUserId ? await options.getActorUserId() : null;
}

function currentTime(options: Compliance14Options) {
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("L'horloge locale est invalide.");
  return new Date(now);
}

type InvoiceTaxLine = {
  id: string;
  position?: number | null;
  htCents: bigint;
  vatCents: bigint;
  ttcCents: bigint;
  vatRateBps?: number | null;
};

export type CollectionAllocationLine = {
  invoiceLineId: string;
  position: number;
  rateBps: number | null;
  grossCents: bigint;
  taxableCents: bigint;
  vatCents: bigint;
};

/**
 * Applies a collection-basis settlement proportionally to immutable invoice
 * line totals. Gross and VAT targets are allocated independently with the
 * largest-remainder method; taxable is the exact gross residual. This keeps
 * every cent and is stable for mixed rates.
 */
export function allocateCollectionAcrossInvoiceLines(
  settlementCents: bigint | string,
  invoice: { htCents: bigint; vatCents: bigint; ttcCents: bigint; lines: InvoiceTaxLine[] },
): CollectionAllocationLine[] {
  const settlement = typeof settlementCents === "string"
    ? exactMoneyString(settlementCents, "Le montant encaiss\u00e9", false)
    : settlementCents;
  if (typeof settlement !== "bigint" || settlement < 0n) throw new Error("Le montant encaiss\u00e9 est invalide.");
  if (invoice.ttcCents <= 0n) throw new Error("Une facture sans total TTC positif ne peut pas alimenter la TVA sur encaissements.");
  if (settlement > invoice.ttcCents) throw new Error("Le montant affect\u00e9 d\u00e9passe le TTC de la facture.");
  const sourceLines = invoice.lines.length > 0
    ? invoice.lines
    : [{ id: "invoice-total", position: 1, htCents: invoice.htCents, vatCents: invoice.vatCents, ttcCents: invoice.ttcCents, vatRateBps: null }];
  for (const line of sourceLines) {
    if (line.htCents < 0n || line.vatCents < 0n || line.ttcCents < 0n || line.htCents + line.vatCents !== line.ttcCents) {
      throw new Error("Les montants d'une ligne de facture ne sont pas coh\u00e9rents.");
    }
  }
  const sourceTtc = sourceLines.reduce((sum, line) => sum + line.ttcCents, 0n);
  const sourceVat = sourceLines.reduce((sum, line) => sum + line.vatCents, 0n);
  if (sourceTtc !== invoice.ttcCents || sourceVat !== invoice.vatCents) {
    throw new Error("Les lignes de facture ne correspondent pas aux totaux fig\u00e9s.");
  }
  const lineKey = (line: InvoiceTaxLine) => `${String(line.position ?? 0).padStart(9, "0")}:${line.id}`;
  const gross = new Map(largestRemainderAllocate(settlement, sourceLines.map((line) => ({ id: lineKey(line), weight: line.ttcCents }))).map((row) => [row.id, row.amount]));
  const vatTarget = (2n * settlement * invoice.vatCents + invoice.ttcCents) / (2n * invoice.ttcCents);
  const vat = sourceVat === 0n
    ? new Map(sourceLines.map((line) => [lineKey(line), 0n]))
    : new Map(largestRemainderAllocate(vatTarget, sourceLines.map((line) => ({ id: lineKey(line), weight: line.vatCents }))).map((row) => [row.id, row.amount]));
  return [...sourceLines]
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id))
    .map((line, index) => {
      const key = lineKey(line);
      const grossCents = gross.get(key) ?? 0n;
      const vatCents = vat.get(key) ?? 0n;
      if (vatCents > grossCents) throw new Error("La part TVA calcul\u00e9e d\u00e9passe le montant encaiss\u00e9 de la ligne.");
      return {
        invoiceLineId: line.id,
        position: line.position ?? index + 1,
        rateBps: line.vatRateBps ?? null,
        grossCents,
        taxableCents: grossCents - vatCents,
        vatCents,
      };
    });
}

type TaxSourceEvent = {
  eventKey: string;
  eventType: string;
  eventDate: Date;
  direction: "COLLECTED" | "DEDUCTIBLE";
  invoiceId: string;
  paymentAllocationId: string | null;
  invoiceLineId: string | null;
  rateBps: number | null;
  grossCents: bigint;
  taxableCents: bigint;
  vatCents: bigint;
  snapshot: Record<string, unknown>;
};

function isWithin(date: Date, start: Date, end: Date) {
  const value = date.getTime();
  return value >= start.getTime() && value <= end.getTime();
}

function invoiceDirection(kind: unknown): "COLLECTED" | "DEDUCTIBLE" {
  if (kind === "SALE" || kind === "CUSTOMER" || kind === "OUTPUT") return "COLLECTED";
  if (kind === "PURCHASE" || kind === "SUPPLIER" || kind === "INPUT") return "DEDUCTIBLE";
  throw new Error(`Le type de facture ${String(kind)} n'est pas compatible avec la TVA.`);
}

function sourceEventHash(events: TaxSourceEvent[]) {
  return complianceSha256(events.map((event) => ({
    ...event,
    eventDate: event.eventDate.toISOString(),
    snapshot: event.snapshot,
  })));
}

function workpaperTotals(events: Array<Pick<TaxSourceEvent, "direction" | "taxableCents" | "vatCents">>) {
  let collectedTaxableCents = 0n;
  let collectedVatCents = 0n;
  let deductibleTaxableCents = 0n;
  let deductibleVatCents = 0n;
  for (const event of events) {
    if (event.direction === "COLLECTED") {
      collectedTaxableCents += event.taxableCents;
      collectedVatCents += event.vatCents;
    } else {
      deductibleTaxableCents += event.taxableCents;
      deductibleVatCents += event.vatCents;
    }
  }
  const net = collectedVatCents - deductibleVatCents;
  return {
    collectedTaxableCents,
    collectedVatCents,
    deductibleTaxableCents,
    deductibleVatCents,
    dueVatCents: net > 0n ? net : 0n,
    creditVatCents: net < 0n ? -net : 0n,
  };
}

export function computeAuditSealRoot(input: {
  chainId: string;
  fromSequence: bigint | string;
  throughSequence: bigint | string;
  events: Array<{ sequence: bigint | string; eventHash: string | null }>;
}) {
  const fromSequence = BigInt(input.fromSequence);
  const throughSequence = BigInt(input.throughSequence);
  if (fromSequence < 1n || throughSequence < fromSequence) throw new Error("Le segment du point de contr\u00f4le est invalide.");
  const normalized = [...input.events]
    .map((event) => ({ sequence: BigInt(event.sequence), eventHash: event.eventHash }))
    .sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0);
  if (normalized.length !== Number(throughSequence - fromSequence + 1n)) throw new Error("Le segment du point de contr\u00f4le est incomplet.");
  for (let index = 0; index < normalized.length; index += 1) {
    const expected = fromSequence + BigInt(index);
    if (normalized[index].sequence !== expected) throw new Error(`La s\u00e9quence ${expected.toString()} manque au point de contr\u00f4le.`);
    const eventHash = normalized[index].eventHash;
    if (!eventHash || !HASH_PATTERN.test(eventHash)) {
      throw new Error(`L'\u00e9v\u00e9nement ${expected.toString()} ne poss\u00e8de pas de hash v\u00e9rifiable.`);
    }
  }
  return complianceSha256({
    algorithm: "SHA256",
    chainId: requireId(input.chainId, "La cha\u00eene d'audit"),
    fromSequence: fromSequence.toString(),
    throughSequence: throughSequence.toString(),
    events: normalized.map((event) => ({ sequence: event.sequence.toString(), eventHash: event.eventHash })),
  });
}

async function requireCompany(prisma: PrismaLike, companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("La soci\u00e9t\u00e9 n'existe plus.");
  return company;
}

async function requireAdmin(tx: PrismaLike, companyId: string, actorUserId: string | null) {
  if (!actorUserId) throw new Error("Une session administrateur identifi\u00e9e est requise.");
  const actor = await tx.user.findUnique({ where: { id: actorUserId } });
  if (!actor) throw new Error("L'utilisateur actif n'existe plus.");
  const membership = await tx.companyUser.findFirst({ where: { companyId, userId: actorUserId } });
  if (actor.role !== "ADMIN" && membership?.role !== "ADMIN") throw new Error("Cette action est r\u00e9serv\u00e9e aux administrateurs.");
  return actor;
}

async function requireHashedDocument(tx: PrismaLike, companyId: string, documentIdValue: unknown, expectedType?: string) {
  const documentId = requireId(documentIdValue, "La pi\u00e8ce justificative");
  const document = await tx.document.findFirst({ where: { id: documentId, companyId } });
  if (!document) throw new Error("La pi\u00e8ce justificative n'appartient pas \u00e0 la soci\u00e9t\u00e9.");
  if (expectedType && document.type !== expectedType) throw new Error(`La pi\u00e8ce doit \u00eatre de type ${expectedType}.`);
  if (!document.contentSha256 || !HASH_PATTERN.test(document.contentSha256)) throw new Error("La pi\u00e8ce justificative ne poss\u00e8de pas de hash SHA-256 v\u00e9rifiable.");
  if (!document.storedPath || document.byteSize === null || document.byteSize === undefined || BigInt(document.byteSize) < 1n) {
    throw new Error("La pi\u00e8ce justificative n'est pas conserv\u00e9e comme fichier g\u00e9r\u00e9 avec une taille connue.");
  }
  return document;
}

async function createSealForCurrentTerminal(tx: PrismaLike, input: {
  companyId: string;
  actorUserId: string | null;
  note: string | null;
  appendCheckpointEvent: boolean;
  purpose?: string;
  payloadSha256?: string | null;
}) {
  const before = await verifyAuditChain(tx, input.companyId);
  if (!before.valid) throw new Error(`La cha\u00eene d'audit est invalide : ${before.problems.join(" ")}`);
  if (input.appendCheckpointEvent) {
    await appendActivityAndAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "CREATE_LOCAL_AUDIT_CHECKPOINT",
      entityType: "AuditChain",
      entityId: input.companyId,
      description: "Point de contr\u00f4le local de la cha\u00eene d'audit cr\u00e9\u00e9",
      payload: {
        scope: "LOCAL_CHECKPOINT_ONLY",
        externalCertification: false,
        externalTimestamp: false,
        note: input.note,
      },
    });
  }
  const chain = await tx.auditChain.findUnique({ where: { companyId: input.companyId } });
  if (!chain || BigInt(chain.lastSequence) < 1n || !chain.lastEventHash) throw new Error("La cha\u00eene d'audit ne contient aucun \u00e9v\u00e9nement v\u00e9rifiable.");
  const previousSeal = await tx.auditSeal.findFirst({ where: { chainId: chain.id }, orderBy: [{ throughSequence: "desc" }, { id: "desc" }] });
  const afterPrevious = previousSeal ? BigInt(previousSeal.throughSequence) : 0n;
  const events = await tx.auditEvent.findMany({
    where: { chainId: chain.id, sequence: { gt: afterPrevious }, integrityStatus: "CHAINED" },
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });
  if (events.length === 0) throw new Error("Aucun nouvel \u00e9v\u00e9nement ne doit \u00eatre scell\u00e9.");
  const fromSequence = BigInt(events[0].sequence);
  const throughSequence = BigInt(events[events.length - 1].sequence);
  if (throughSequence !== BigInt(chain.lastSequence) || events[events.length - 1].eventHash !== chain.lastEventHash) {
    throw new Error("Le point de contr\u00f4le ne correspond pas au terminal actuel de la cha\u00eene.");
  }
  const rootHash = computeAuditSealRoot({ chainId: chain.id, fromSequence, throughSequence, events });
  const seal = await tx.auditSeal.create({
    data: {
      chainId: chain.id,
      fromSequence,
      throughSequence,
      eventCount: events.length,
      rootHash,
      algorithm: "SHA256",
      actorUserId: input.actorUserId,
      note: input.note,
      purpose: input.purpose ?? "GENERAL",
      payloadSha256: input.payloadSha256 ?? null,
      verificationStatus: "VERIFIED_LOCAL",
      verifiedAt: new Date(),
      verificationNote: "Segment et terminal v\u00e9rifi\u00e9s localement lors de la cr\u00e9ation ; aucune certification externe.",
    },
  });
  return { seal, chain };
}

async function verifyOneSeal(prisma: PrismaLike, companyId: string, sealId: string) {
  const chainVerification = await verifyAuditChain(prisma, companyId);
  const chain = await prisma.auditChain.findUnique({ where: { companyId } });
  if (!chain) throw new Error("La cha\u00eene d'audit n'existe pas.");
  const seal = await prisma.auditSeal.findFirst({ where: { id: sealId, chainId: chain.id } });
  if (!seal) throw new Error("Le point de contr\u00f4le local n'existe plus.");
  const events = await prisma.auditEvent.findMany({
    where: { chainId: chain.id, sequence: { gte: seal.fromSequence, lte: seal.throughSequence } },
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });
  const problems = [...chainVerification.problems];
  let computedRootHash: string | null = null;
  try {
    computedRootHash = computeAuditSealRoot({
      chainId: chain.id,
      fromSequence: seal.fromSequence,
      throughSequence: seal.throughSequence,
      events,
    });
    if (computedRootHash !== seal.rootHash) problems.push("Le hash racine du point de contr\u00f4le ne correspond plus au segment.");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "Le segment du point de contr\u00f4le est invalide.");
  }
  const isCurrentTerminal = BigInt(seal.throughSequence) === BigInt(chain.lastSequence)
    && events.at(-1)?.eventHash === chain.lastEventHash;
  return {
    seal,
    valid: chainVerification.valid && computedRootHash === seal.rootHash,
    isCurrentTerminal,
    chainAdvancedSinceSeal: BigInt(chain.lastSequence) > BigInt(seal.throughSequence),
    computedRootHash,
    problems,
    notice: "Point de contr\u00f4le local uniquement ; aucune certification ni horodatage externe.",
  };
}

async function listAuditSeals(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const prisma = await options.getPrisma();
  await requireCompany(prisma, companyId);
  const chain = await prisma.auditChain.findUnique({ where: { companyId } });
  if (!chain) return serialize(options, { items: [], count: 0, truncated: false, notice: "Aucun point de contr\u00f4le local." });
  const count = await prisma.auditSeal.count({ where: { chainId: chain.id } });
  const items = await prisma.auditSeal.findMany({
    where: { chainId: chain.id },
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
    orderBy: [{ throughSequence: "desc" }, { id: "desc" }],
    take: MAX_WORKSPACE_ROWS,
  });
  return serialize(options, {
    items,
    count,
    truncated: count > items.length,
    currentTerminalSequence: BigInt(chain.lastSequence).toString(),
    notice: "Points de contr\u00f4le locaux uniquement ; ils ne sont ni certifi\u00e9s ni horodat\u00e9s par un tiers.",
  });
}

async function createAuditSeal(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const note = optionalText(payload.note, 500);
  const prisma = await options.getPrisma();
  await requireCompany(prisma, companyId);
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction((tx: PrismaLike) => createSealForCurrentTerminal(tx, {
    companyId,
    actorUserId,
    note,
    appendCheckpointEvent: true,
  }));
  return serialize(options, {
    ...result,
    valid: true,
    isCurrentTerminal: true,
    notice: "Point de contr\u00f4le local cr\u00e9\u00e9 ; aucune certification ni transmission externe.",
  });
}

async function verifyAuditSeal(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const sealId = requireId(payload.sealId, "Le point de contr\u00f4le");
  const prisma = await options.getPrisma();
  await requireCompany(prisma, companyId);
  return serialize(options, await verifyOneSeal(prisma, companyId, sealId));
}

function normalizeTaxRates(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RATES) {
    throw new Error(`La configuration doit contenir entre 1 et ${MAX_RATES} taux.`);
  }
  const seen = new Set<string>();
  return value.map((rateValue, index) => {
    const rate = record(rateValue, `Le taux ${index + 1} est invalide.`);
    const code = requireText(rate.code, `Le code du taux ${index + 1}`, 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(code)) throw new Error(`Le code ${code} contient des caract\u00e8res non autoris\u00e9s.`);
    if (seen.has(code)) throw new Error(`Le code de taux ${code} est dupliqu\u00e9.`);
    seen.add(code);
    const direction = rate.direction === "COLLECTED" || rate.direction === "DEDUCTIBLE" || rate.direction === "BOTH"
      ? rate.direction
      : null;
    if (!direction) throw new Error(`La direction du taux ${code} est invalide.`);
    return {
      code,
      label: requireText(rate.label, `Le libell\u00e9 du taux ${code}`, 120),
      rateBps: requireInteger(rate.rateBps, `Le taux ${code}`, 0, 10_000),
      direction,
      accountId: rate.accountId ? requireId(rate.accountId, `Le compte du taux ${code}`) : null,
      deductibilityBps: direction === "COLLECTED"
        ? 0
        : rate.deductibilityBps === undefined ? 10_000 : requireInteger(rate.deductibilityBps, `La d\u00e9ductibilit\u00e9 ${code}`, 0, 10_000),
      position: index + 1,
    };
  });
}

function normalizeTaxConfigPayload(payloadValue: unknown) {
  const payload = record(payloadValue);
  const frequencyValue = payload.filingFrequency ?? payload.frequency;
  const frequency = frequencyValue === "MONTHLY" || frequencyValue === "QUARTERLY" ? frequencyValue : null;
  if (!frequency) throw new Error("La fr\u00e9quence TVA est invalide.");
  const accountingBasis = payload.accountingBasis ?? payload.basis;
  if (accountingBasis !== "COLLECTION") throw new Error("Wheat prend en charge uniquement une configuration explicitement fond\u00e9e sur les encaissements.");
  const effectiveFrom = parseDay(payload.effectiveFrom, "La date d'effet");
  const effectiveTo = payload.effectiveTo ? parseDay(payload.effectiveTo, "La date de fin d'effet") : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("La fin d'effet doit suivre le d\u00e9but d'effet.");
  if (effectiveFrom.getUTCDate() !== 1) throw new Error("La date d'effet doit commencer le premier jour d'une p\u00e9riode fiscale.");
  if (effectiveTo && dateAfter(effectiveTo).getUTCDate() !== 1) throw new Error("La fin d'effet doit correspondre au dernier jour d'un mois.");
  if (frequency === "QUARTERLY") {
    if (![0, 3, 6, 9].includes(effectiveFrom.getUTCMonth())) throw new Error("Une configuration trimestrielle doit commencer au d\u00e9but d'un trimestre civil.");
    if (effectiveTo && ![2, 5, 8, 11].includes(effectiveTo.getUTCMonth())) throw new Error("Une configuration trimestrielle doit finir \u00e0 la fin d'un trimestre civil.");
  }
  return {
    raw: payload,
    companyId: requireId(payload.companyId, "La soci\u00e9t\u00e9"),
    name: requireText(payload.name, "Le nom de la configuration", 120),
    accountingBasis: "COLLECTION",
    filingFrequency: frequency,
    effectiveFrom,
    effectiveTo,
    sourceReference: requireText(payload.sourceReference, "La r\u00e9f\u00e9rence de la r\u00e8gle", 500),
    rates: normalizeTaxRates(payload.rates),
  };
}

function rangesOverlap(leftStart: Date, leftEnd: Date | null, rightStart: Date, rightEnd: Date | null) {
  const leftMaximum = leftEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightMaximum = rightEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftStart.getTime() <= rightMaximum && rightStart.getTime() <= leftMaximum;
}

function assertConfigurationSupportsEvents(configuration: any, events: TaxSourceEvent[]) {
  const rules = Array.isArray(configuration.rates) ? configuration.rates : [];
  for (const event of events) {
    if (event.vatCents === 0n) continue;
    if (event.rateBps === null) throw new Error(`La source ${event.eventKey} contient de la TVA sans taux explicite.`);
    const supported = rules.some((rule: any) => Number(rule.rateBps) === event.rateBps
      && (rule.direction === "BOTH" || rule.direction === event.direction));
    if (!supported) throw new Error(`Le taux ${event.rateBps} points de base de la source ${event.eventKey} n'est pas couvert par la configuration active.`);
  }
}

function signed(value: bigint, sign: 1n | -1n) {
  return sign === 1n ? value : -value;
}

function paymentEventsForAllocation(allocation: any, eventDate: Date, sign: 1n | -1n, eventKind: string) {
  const invoice = allocation.invoice;
  const amount = BigInt(allocation.amountCents);
  const portions = allocateCollectionAcrossInvoiceLines(amount, {
    htCents: BigInt(invoice.htCents),
    vatCents: BigInt(invoice.vatCents),
    ttcCents: BigInt(invoice.ttcCents),
    lines: invoice.lines.map((line: any) => ({
      id: line.id,
      position: line.position,
      htCents: BigInt(line.htCents),
      vatCents: BigInt(line.vatCents),
      ttcCents: BigInt(line.ttcCents),
      vatRateBps: line.vatRateBps,
    })),
  });
  const direction = invoiceDirection(invoice.kind);
  return portions.map((portion) => ({
    eventKey: `${eventKind}:${allocation.id}:${portion.invoiceLineId}`,
    eventType: eventKind,
    eventDate,
    direction,
    invoiceId: invoice.id,
    paymentAllocationId: allocation.id,
    invoiceLineId: portion.invoiceLineId === "invoice-total" ? null : portion.invoiceLineId,
    rateBps: portion.rateBps,
    grossCents: signed(portion.grossCents, sign),
    taxableCents: signed(portion.taxableCents, sign),
    vatCents: signed(portion.vatCents, sign),
    snapshot: {
      allocationId: allocation.id,
      allocationStatus: allocation.status,
      allocationAmountCents: amount.toString(),
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNo,
      invoiceKind: invoice.kind,
      invoiceDocumentType: invoice.documentType ?? "INVOICE",
      invoiceVersion: invoice.version,
      paymentId: allocation.payment.id,
      paymentDate: isoDay(allocation.payment.paymentDate),
      paymentLifecycleStatus: allocation.payment.lifecycleStatus,
      reversalDate: allocation.reversalAccountingDate
        ? isoDay(allocation.reversalAccountingDate)
        : allocation.reversedAt ? isoDay(allocation.reversedAt) : null,
      sign: sign.toString(),
    },
  } satisfies TaxSourceEvent));
}

function creditEventsForInvoice(invoice: any, eventDate: Date, sign: 1n | -1n, eventKind: string) {
  const direction = invoiceDirection(invoice.kind);
  const lines = invoice.lines.length > 0 ? invoice.lines : [{
    id: "invoice-total",
    position: 1,
    htCents: invoice.htCents,
    vatCents: invoice.vatCents,
    ttcCents: invoice.ttcCents,
    vatRateBps: null,
  }];
  return lines.map((line: any) => ({
    eventKey: `${eventKind}:${invoice.id}:${line.id}`,
    eventType: eventKind,
    eventDate,
    direction,
    invoiceId: invoice.id,
    paymentAllocationId: null,
    invoiceLineId: line.id === "invoice-total" ? null : line.id,
    rateBps: line.vatRateBps ?? null,
    grossCents: signed(BigInt(line.ttcCents), sign),
    taxableCents: signed(BigInt(line.htCents), sign),
    vatCents: signed(BigInt(line.vatCents), sign),
    snapshot: {
      creditNoteId: invoice.id,
      creditNoteNumber: invoice.invoiceNo,
      creditedInvoiceId: invoice.creditedInvoiceId ?? null,
      creditReason: invoice.creditReason ?? null,
      invoiceKind: invoice.kind,
      invoiceVersion: invoice.version,
      lifecycleStatus: invoice.lifecycleStatus,
      sign: sign.toString(),
    },
  } satisfies TaxSourceEvent));
}

async function collectTaxSourceEvents(tx: PrismaLike, input: {
  companyId: string;
  periodStart: Date;
  periodEnd: Date;
  configuration: any;
}) {
  if (input.configuration.accountingBasis !== "COLLECTION") throw new Error("La configuration du document de travail n'est pas fond\u00e9e sur les encaissements.");
  const allocations = await tx.paymentAllocation.findMany({
    where: {
      invoice: { companyId: input.companyId },
      OR: [
        { payment: { paymentDate: { gte: input.periodStart, lte: input.periodEnd }, lifecycleStatus: { in: ["POSTED", "VOIDED"] } } },
        { reversalAccountingDate: { gte: input.periodStart, lte: input.periodEnd } },
      ],
    },
    include: {
      payment: true,
      invoice: { include: { lines: { orderBy: [{ position: "asc" }, { id: "asc" }] } } },
    },
    orderBy: [{ id: "asc" }],
  });
  const events: TaxSourceEvent[] = [];
  for (const allocation of allocations) {
    if ((allocation.invoice.documentType ?? "INVOICE") === "CREDIT_NOTE") continue;
    const paymentDate = new Date(allocation.payment.paymentDate);
    if (isWithin(paymentDate, input.periodStart, input.periodEnd)
      && (allocation.payment.lifecycleStatus === "POSTED" || allocation.payment.lifecycleStatus === "VOIDED")) {
      events.push(...paymentEventsForAllocation(allocation, paymentDate, 1n, "PAYMENT_ALLOCATION"));
    }
    const reversalDate = allocation.reversalAccountingDate
      ? new Date(allocation.reversalAccountingDate)
      : allocation.reversedAt
        ? new Date(allocation.reversedAt)
      : allocation.payment.lifecycleStatus === "VOIDED" && allocation.payment.voidedAt
        ? new Date(allocation.payment.voidedAt)
        : null;
    if (reversalDate && isWithin(reversalDate, input.periodStart, input.periodEnd)) {
      events.push(...paymentEventsForAllocation(allocation, reversalDate, -1n, "PAYMENT_ALLOCATION_REVERSAL"));
    }
  }

  const creditNotes = await tx.invoice.findMany({
    where: {
      companyId: input.companyId,
      documentType: "CREDIT_NOTE",
      lifecycleStatus: { in: ["POSTED", "VOIDED"] },
      OR: [
        { invoiceDate: { gte: input.periodStart, lte: input.periodEnd } },
        { voidedAt: { gte: input.periodStart, lte: input.periodEnd } },
      ],
    },
    include: { lines: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
    orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
  });
  for (const creditNote of creditNotes) {
    const issueDate = new Date(creditNote.invoiceDate);
    if (isWithin(issueDate, input.periodStart, input.periodEnd)) events.push(...creditEventsForInvoice(creditNote, issueDate, -1n, "CREDIT_NOTE"));
    if (creditNote.voidedAt) {
      const voidedAt = new Date(creditNote.voidedAt);
      if (isWithin(voidedAt, input.periodStart, input.periodEnd)) events.push(...creditEventsForInvoice(creditNote, voidedAt, 1n, "CREDIT_NOTE_VOID"));
    }
  }
  events.sort((left, right) => left.eventDate.getTime() - right.eventDate.getTime() || left.eventKey.localeCompare(right.eventKey));
  assertConfigurationSupportsEvents(input.configuration, events);
  return { events, sourceHash: sourceEventHash(events), totals: workpaperTotals(events) };
}

async function assertTaxAccounts(tx: PrismaLike, companyId: string, rates: ReturnType<typeof normalizeTaxRates>) {
  const accountIds = [...new Set(rates.map((rate) => rate.accountId).filter((id): id is string => Boolean(id)))];
  if (accountIds.length === 0) return;
  const count = await tx.account.count({ where: { companyId, id: { in: accountIds }, active: true } });
  if (count !== accountIds.length) throw new Error("Un ou plusieurs comptes fiscaux sont archiv\u00e9s ou n'appartiennent pas \u00e0 la soci\u00e9t\u00e9.");
}

async function saveTaxConfigDraft(options: Compliance14Options, payloadValue: unknown) {
  const normalized = normalizeTaxConfigPayload(payloadValue);
  const id = normalized.raw.id ? requireId(normalized.raw.id, "La configuration") : null;
  const expectedVersion = normalized.raw.expectedVersion === undefined ? null : requireInteger(normalized.raw.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    await requireCompany(tx, normalized.companyId);
    await assertTaxAccounts(tx, normalized.companyId, normalized.rates);
    const payloadSha256 = complianceSha256({
      accountingBasis: normalized.accountingBasis,
      effectiveFrom: isoDay(normalized.effectiveFrom),
      effectiveTo: normalized.effectiveTo ? isoDay(normalized.effectiveTo) : null,
      filingFrequency: normalized.filingFrequency,
      name: normalized.name,
      rates: normalized.rates,
      sourceReference: normalized.sourceReference,
    });
    let configuration;
    if (id) {
      const current = await tx.taxConfigurationVersion.findFirst({ where: { id, companyId: normalized.companyId }, include: { rates: true } });
      if (!current) throw new Error("La configuration fiscale n'existe plus.");
      if (current.status !== "DRAFT") throw new Error("Une configuration activ\u00e9e ou retir\u00e9e est immuable ; clonez-la pour cr\u00e9er une nouvelle r\u00e9vision.");
      if (expectedVersion === null) throw new Error("La version attendue est requise pour modifier un brouillon.");
      const updated = await tx.taxConfigurationVersion.updateMany({
        where: { id, companyId: normalized.companyId, status: "DRAFT", version: expectedVersion },
        data: {
          name: normalized.name,
          accountingBasis: normalized.accountingBasis,
          filingFrequency: normalized.filingFrequency,
          effectiveFrom: normalized.effectiveFrom,
          effectiveTo: normalized.effectiveTo,
          sourceReference: normalized.sourceReference,
          payloadSha256,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("Ce brouillon a \u00e9t\u00e9 modifi\u00e9 ailleurs. Actualisez avant de r\u00e9essayer.");
      await tx.taxRateDefinition.deleteMany({ where: { taxConfigurationVersionId: id } });
      await tx.taxRateDefinition.createMany({ data: normalized.rates.map((rate) => ({
        ...rate,
        taxConfigurationVersionId: id,
        deductibilityBps: rate.deductibilityBps,
        active: true,
      })) });
      configuration = await tx.taxConfigurationVersion.findUniqueOrThrow({ where: { id }, include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } } });
    } else {
      const lineageKey = randomUUID();
      configuration = await tx.taxConfigurationVersion.create({
        data: {
          companyId: normalized.companyId,
          lineageKey,
          revision: 1,
          status: "DRAFT",
          name: normalized.name,
          accountingBasis: normalized.accountingBasis,
          filingFrequency: normalized.filingFrequency,
          effectiveFrom: normalized.effectiveFrom,
          effectiveTo: normalized.effectiveTo,
          sourceReference: normalized.sourceReference,
          payloadSha256,
          createdByUserId: actorUserId,
          rates: { create: normalized.rates.map((rate) => ({
            ...rate,
            deductibilityBps: rate.deductibilityBps,
            active: true,
          })) },
        },
        include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
      });
    }
    await appendActivityAndAudit(tx, {
      companyId: normalized.companyId,
      actorUserId,
      action: id ? "UPDATE_TAX_CONFIGURATION_DRAFT" : "CREATE_TAX_CONFIGURATION_DRAFT",
      entityType: "TaxConfigurationVersion",
      entityId: configuration.id,
      description: id ? "Brouillon de configuration fiscale mis \u00e0 jour" : "Brouillon de configuration fiscale cr\u00e9\u00e9",
      payload: { lineageKey: configuration.lineageKey, revision: configuration.revision, payloadSha256 },
    });
    return configuration;
  });
  return serialize(options, result);
}

async function activateTaxConfig(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "La configuration");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const activated = await prisma.$transaction(async (tx: PrismaLike) => {
    const configuration = await tx.taxConfigurationVersion.findFirst({ where: { id, companyId }, include: { rates: true } });
    if (!configuration) throw new Error("La configuration fiscale n'existe plus.");
    if (configuration.status !== "DRAFT") throw new Error("Seul un brouillon peut \u00eatre activ\u00e9.");
    if (configuration.version !== expectedVersion) throw new Error("Cette configuration a \u00e9t\u00e9 modifi\u00e9e ailleurs.");
    if (!configuration.payloadSha256 || !HASH_PATTERN.test(configuration.payloadSha256) || configuration.rates.length === 0) {
      throw new Error("La configuration n'est pas compl\u00e8te et hach\u00e9e.");
    }
    const active = await tx.taxConfigurationVersion.findMany({ where: { companyId, status: "ACTIVE", id: { not: id } } });
    const overlap = active.find((other: any) => rangesOverlap(configuration.effectiveFrom, configuration.effectiveTo, other.effectiveFrom, other.effectiveTo));
    if (overlap) throw new Error(`La p\u00e9riode d'effet chevauche la configuration active \u00ab ${overlap.name} \u00bb (r\u00e9vision ${overlap.revision}).`);
    const now = currentTime(options);
    const updated = await tx.taxConfigurationVersion.updateMany({
      where: { id, companyId, status: "DRAFT", version: expectedVersion },
      data: { status: "ACTIVE", activatedAt: now, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("La configuration a chang\u00e9 pendant l'activation.");
    const result = await tx.taxConfigurationVersion.findUniqueOrThrow({ where: { id }, include: { rates: true } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "ACTIVATE_TAX_CONFIGURATION",
      entityType: "TaxConfigurationVersion",
      entityId: id,
      description: "Configuration fiscale activ\u00e9e et rendue immuable",
      payload: { lineageKey: result.lineageKey, revision: result.revision, payloadSha256: result.payloadSha256, effectiveFrom: result.effectiveFrom, effectiveTo: result.effectiveTo },
    });
    return result;
  });
  return serialize(options, activated);
}

async function cloneTaxConfig(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "La configuration source");
  const effectiveFrom = payload.effectiveFrom ? parseDay(payload.effectiveFrom, "La nouvelle date d'effet") : null;
  const effectiveTo = payload.effectiveTo ? parseDay(payload.effectiveTo, "La nouvelle date de fin d'effet") : null;
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const cloned = await prisma.$transaction(async (tx: PrismaLike) => {
    const source = await tx.taxConfigurationVersion.findFirst({ where: { id, companyId }, include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } } });
    if (!source) throw new Error("La configuration source n'existe plus.");
    const latest = await tx.taxConfigurationVersion.findFirst({ where: { companyId, lineageKey: source.lineageKey }, orderBy: [{ revision: "desc" }, { id: "desc" }] });
    const nextStart = effectiveFrom ?? source.effectiveFrom;
    const nextEnd = effectiveTo ?? source.effectiveTo;
    if (nextEnd && nextEnd < nextStart) throw new Error("La fin d'effet doit suivre le d\u00e9but d'effet.");
    if (nextStart.getUTCDate() !== 1 || (nextEnd && dateAfter(nextEnd).getUTCDate() !== 1)) {
      throw new Error("La nouvelle plage d'effet doit couvrir des mois civils complets.");
    }
    if (source.filingFrequency === "QUARTERLY"
      && (![0, 3, 6, 9].includes(nextStart.getUTCMonth()) || (nextEnd && ![2, 5, 8, 11].includes(nextEnd.getUTCMonth())))) {
      throw new Error("La nouvelle plage trimestrielle doit couvrir des trimestres civils complets.");
    }
    const payloadSha256 = complianceSha256({
      accountingBasis: source.accountingBasis,
      effectiveFrom: isoDay(nextStart),
      effectiveTo: nextEnd ? isoDay(nextEnd) : null,
      filingFrequency: source.filingFrequency,
      name: source.name,
      rates: source.rates.map((rate: any) => ({
        code: rate.code,
        label: rate.label,
        rateBps: rate.rateBps,
        direction: rate.direction,
        accountId: rate.accountId,
        deductibilityBps: rate.deductibilityBps,
        position: rate.position,
      })),
      sourceReference: source.sourceReference,
    });
    const result = await tx.taxConfigurationVersion.create({
      data: {
        companyId,
        lineageKey: source.lineageKey,
        revision: Number(latest?.revision ?? 0) + 1,
        status: "DRAFT",
        name: source.name,
        accountingBasis: source.accountingBasis,
        filingFrequency: source.filingFrequency,
        effectiveFrom: nextStart,
        effectiveTo: nextEnd,
        sourceReference: source.sourceReference,
        payloadSha256,
        createdByUserId: actorUserId,
        rates: { create: source.rates.map((rate: any) => ({
          code: rate.code,
          label: rate.label,
          rateBps: rate.rateBps,
          direction: rate.direction,
          accountId: rate.accountId,
          deductibilityBps: rate.deductibilityBps,
          position: rate.position,
          active: rate.active,
        })) },
      },
      include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "CLONE_TAX_CONFIGURATION",
      entityType: "TaxConfigurationVersion",
      entityId: result.id,
      description: "Nouvelle r\u00e9vision fiscale cr\u00e9\u00e9e depuis une version existante",
      payload: { sourceId: source.id, lineageKey: result.lineageKey, revision: result.revision },
    });
    return result;
  });
  return serialize(options, cloned);
}

function assertVatPeriod(frequency: string, start: Date, end: Date) {
  if (start.getUTCDate() !== 1) throw new Error("Une p\u00e9riode TVA doit commencer le premier jour du mois.");
  const expected = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (frequency === "MONTHLY" ? 1 : 3), 0));
  if (end.getTime() !== expected.getTime()) throw new Error(`La fin de p\u00e9riode ne correspond pas \u00e0 la fr\u00e9quence ${frequency}.`);
  if (frequency === "QUARTERLY" && ![0, 3, 6, 9].includes(start.getUTCMonth())) {
    throw new Error("Une p\u00e9riode trimestrielle doit commencer en janvier, avril, juillet ou octobre.");
  }
}

async function requireTaxConfiguration(tx: PrismaLike, companyId: string, configurationId: string, periodStart?: Date, periodEnd?: Date) {
  const configuration = await tx.taxConfigurationVersion.findFirst({
    where: { id: configurationId, companyId },
    include: { rates: { where: { active: true }, orderBy: [{ position: "asc" }, { id: "asc" }] } },
  });
  if (!configuration) throw new Error("La configuration fiscale n'existe plus.");
  if (configuration.status !== "ACTIVE") throw new Error("Une configuration fiscale active est requise.");
  if (configuration.accountingBasis !== "COLLECTION") throw new Error("Cette configuration n'utilise pas la base encaissements prise en charge.");
  if (periodStart && periodEnd) {
    if (configuration.effectiveFrom > periodStart || (configuration.effectiveTo && configuration.effectiveTo < periodEnd)) {
      throw new Error("La configuration fiscale n'est pas effective pendant toute la p\u00e9riode demand\u00e9e.");
    }
    assertVatPeriod(configuration.filingFrequency, periodStart, periodEnd);
  }
  return configuration;
}

function rateSnapshot(configuration: any, event: TaxSourceEvent) {
  if (event.rateBps === null) return { code: "UNSPECIFIED_ZERO", label: "Taux nul sans code", deductibilityBps: 10_000 };
  const rate = configuration.rates.find((candidate: any) => Number(candidate.rateBps) === event.rateBps
    && (candidate.direction === "BOTH" || candidate.direction === event.direction));
  if (!rate) throw new Error(`Aucun taux configur\u00e9 ne correspond \u00e0 ${event.rateBps} points de base.`);
  return { code: rate.code, label: rate.label, deductibilityBps: Number(rate.deductibilityBps) };
}

function applyBasisPoints(amount: bigint, basisPoints: number) {
  const bps = BigInt(requireInteger(basisPoints, "Le coefficient de d\u00e9ductibilit\u00e9", 0, 10_000));
  const sign = amount < 0n ? -1n : 1n;
  const absolute = amount < 0n ? -amount : amount;
  return sign * ((absolute * bps + 5_000n) / 10_000n);
}

function workpaperEvidenceHash(workpaper: any) {
  return complianceSha256({
    sourceSha256: workpaper.sourceSha256,
    lines: [...(workpaper.lines ?? [])].sort((left: any, right: any) => left.position - right.position || left.id.localeCompare(right.id)).map((line: any) => ({
      eventKey: line.eventKey,
      eventType: line.eventType,
      eventDate: isoDay(line.eventDate),
      direction: line.direction,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot,
      taxRateLabelSnapshot: line.taxRateLabelSnapshot,
      rateBps: line.rateBps,
      taxableCents: BigInt(line.taxableCents).toString(),
      vatCents: BigInt(line.vatCents).toString(),
      grossCents: BigInt(line.grossCents).toString(),
      eligibility: line.eligibility,
      snapshotJson: line.snapshotJson,
    })),
    adjustments: [...(workpaper.adjustments ?? [])].sort((left: any, right: any) => left.position - right.position || left.id.localeCompare(right.id)).map((adjustment: any) => ({
      direction: adjustment.direction,
      taxableCents: BigInt(adjustment.taxableCents).toString(),
      vatCents: BigInt(adjustment.vatCents).toString(),
      reason: adjustment.reason,
      evidenceDocumentId: adjustment.evidenceDocumentId,
      snapshotJson: adjustment.snapshotJson,
    })),
    evidence: [...(workpaper.evidence ?? [])].sort((left: any, right: any) => left.role.localeCompare(right.role) || left.documentId.localeCompare(right.documentId)).map((evidence: any) => ({
      documentId: evidence.documentId,
      role: evidence.role,
      contentSha256Snapshot: evidence.contentSha256Snapshot,
      byteSizeSnapshot: BigInt(evidence.byteSizeSnapshot).toString(),
      note: evidence.note,
    })),
  });
}

function adjustmentTotals(adjustments: any[]) {
  let collected = 0n;
  let deductible = 0n;
  for (const adjustment of adjustments) {
    if (adjustment.direction === "COLLECTED") collected += BigInt(adjustment.vatCents);
    else if (adjustment.direction === "DEDUCTIBLE") deductible += BigInt(adjustment.vatCents);
    else throw new Error("Une direction d'ajustement enregistr\u00e9e est invalide.");
  }
  return { collected, deductible, net: collected - deductible };
}

function workpaperAmounts(sourceTotals: ReturnType<typeof workpaperTotals>, adjustments: any[]) {
  const adjustment = adjustmentTotals(adjustments);
  const collectedVatCents = sourceTotals.collectedVatCents;
  const deductibleVatCents = sourceTotals.deductibleVatCents;
  const net = collectedVatCents - deductibleVatCents + adjustment.net;
  return {
    collectedVatCents,
    deductibleVatCents,
    adjustmentVatCents: adjustment.net,
    netVatDueCents: net > 0n ? net : 0n,
    creditCarryforwardCents: net < 0n ? -net : 0n,
  };
}

async function getWorkpaperWithEvidence(tx: PrismaLike, id: string, companyId: string) {
  const workpaper = await tx.vatWorkpaper.findFirst({
    where: { id, companyId },
    include: {
      taxConfigurationVersion: { include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } } },
      lines: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      adjustments: { include: { evidenceDocument: true }, orderBy: [{ position: "asc" }, { id: "asc" }] },
      evidence: { include: { document: true }, orderBy: [{ role: "asc" }, { id: "asc" }] },
      filingReceiptDocument: true,
    },
  });
  if (!workpaper) throw new Error("Le document de travail TVA n'existe plus.");
  return workpaper;
}

async function createWorkpaperRevision(tx: PrismaLike, input: {
  companyId: string;
  configuration: any;
  periodStart: Date;
  periodEnd: Date;
  lineageKey: string;
  revision: number;
  supersedesWorkpaperId: string | null;
  copyFrom?: any;
}) {
  const source = await collectTaxSourceEvents(tx, {
    companyId: input.companyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    configuration: input.configuration,
  });
  const copiedAdjustments = input.copyFrom?.adjustments ?? [];
  const preparedLines = source.events.map((event, index) => {
    const rate = rateSnapshot(input.configuration, event);
    const vatCents = event.direction === "DEDUCTIBLE"
      ? applyBasisPoints(event.vatCents, rate.deductibilityBps)
      : event.vatCents;
    return {
      event,
      rate,
      position: index + 1,
      vatCents,
      eligibility: event.direction !== "DEDUCTIBLE" || rate.deductibilityBps === 10_000
        ? "INCLUDED"
        : rate.deductibilityBps === 0 ? "EXCLUDED" : "PARTIAL",
    };
  });
  const eligibleTotals = workpaperTotals(preparedLines.map((line) => ({
    direction: line.event.direction,
    taxableCents: line.event.taxableCents,
    vatCents: line.vatCents,
  })));
  const amounts = workpaperAmounts(eligibleTotals, copiedAdjustments);
  const workpaper = await tx.vatWorkpaper.create({
    data: {
      companyId: input.companyId,
      taxConfigurationVersionId: input.configuration.id,
      lineageKey: input.lineageKey,
      revision: input.revision,
      supersedesWorkpaperId: input.supersedesWorkpaperId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: "DRAFT",
      basisSnapshot: input.configuration.accountingBasis,
      frequencySnapshot: input.configuration.filingFrequency,
      sourceSha256: source.sourceHash,
      evidenceSha256: "",
      ...amounts,
      lines: { create: preparedLines.map(({ event, rate, position, vatCents, eligibility }) => {
        return {
          position,
          eventKey: event.eventKey,
          eventType: event.eventType,
          eventDate: event.eventDate,
          invoiceId: event.invoiceId,
          invoiceLineId: event.invoiceLineId,
          paymentAllocationId: event.paymentAllocationId,
          direction: event.direction,
          taxRateCodeSnapshot: rate.code,
          taxRateLabelSnapshot: rate.label,
          rateBps: event.rateBps ?? 0,
          taxableCents: event.taxableCents,
          vatCents,
          grossCents: event.grossCents,
          eligibility,
          snapshotJson: complianceCanonicalJson({ ...event.snapshot, sourceVatCents: event.vatCents, deductibilityBps: rate.deductibilityBps }),
        };
      }) },
      adjustments: copiedAdjustments.length ? { create: copiedAdjustments.map((adjustment: any, index: number) => ({
        position: index + 1,
        direction: adjustment.direction,
        taxableCents: adjustment.taxableCents,
        vatCents: adjustment.vatCents,
        reason: adjustment.reason,
        evidenceDocumentId: adjustment.evidenceDocumentId,
        snapshotJson: adjustment.snapshotJson,
      })) } : undefined,
      evidence: input.copyFrom?.evidence?.length ? { create: input.copyFrom.evidence.filter((evidence: any) => evidence.role !== "FILING_RECEIPT").map((evidence: any) => ({
        documentId: evidence.documentId,
        role: evidence.role,
        contentSha256Snapshot: evidence.contentSha256Snapshot,
        byteSizeSnapshot: evidence.byteSizeSnapshot,
        note: evidence.note,
      })) } : undefined,
    },
  });
  const hydrated = await getWorkpaperWithEvidence(tx, workpaper.id, input.companyId);
  const evidenceSha256 = workpaperEvidenceHash(hydrated);
  await tx.vatWorkpaper.update({ where: { id: workpaper.id }, data: { evidenceSha256 } });
  return getWorkpaperWithEvidence(tx, workpaper.id, input.companyId);
}

async function generateVatWorkpaper(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const taxConfigurationVersionId = requireId(payload.taxConfigurationVersionId, "La configuration fiscale");
  const periodStart = parseDay(payload.periodStart, "Le d\u00e9but de p\u00e9riode");
  const periodEnd = parseDay(payload.periodEnd, "La fin de p\u00e9riode");
  if (periodEnd < periodStart) throw new Error("La p\u00e9riode TVA est invers\u00e9e.");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const created = await prisma.$transaction(async (tx: PrismaLike) => {
    const configuration = await requireTaxConfiguration(tx, companyId, taxConfigurationVersionId, periodStart, periodEnd);
    const occupied = await tx.vatWorkpaper.findFirst({
      where: { companyId, periodStart, periodEnd, status: { not: "SUPERSEDED" } },
      orderBy: [{ revision: "desc" }, { id: "desc" }],
    });
    if (occupied) throw new Error("Un document de travail courant existe d\u00e9j\u00e0 pour cette p\u00e9riode. Utilisez la r\u00e9g\u00e9n\u00e9ration.");
    const workpaper = await createWorkpaperRevision(tx, {
      companyId,
      configuration,
      periodStart,
      periodEnd,
      lineageKey: randomUUID(),
      revision: 1,
      supersedesWorkpaperId: null,
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "GENERATE_VAT_WORKPAPER",
      entityType: "VatWorkpaper",
      entityId: workpaper.id,
      description: "Document de travail TVA local g\u00e9n\u00e9r\u00e9",
      payload: { periodStart, periodEnd, sourceSha256: workpaper.sourceSha256, evidenceSha256: workpaper.evidenceSha256, filingTransmission: false },
    });
    return workpaper;
  });
  return serialize(options, created);
}

async function regenerateVatWorkpaper(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const created = await prisma.$transaction(async (tx: PrismaLike) => {
    const current = await getWorkpaperWithEvidence(tx, id, companyId);
    if (current.status !== "DRAFT") throw new Error("Seul un brouillon peut \u00eatre r\u00e9g\u00e9n\u00e9r\u00e9. Renvoyez d'abord un document relu en brouillon.");
    if (current.version !== expectedVersion) throw new Error("Le document de travail a \u00e9t\u00e9 modifi\u00e9 ailleurs.");
    const configuration = await requireTaxConfiguration(tx, companyId, current.taxConfigurationVersionId, current.periodStart, current.periodEnd);
    const superseded = await tx.vatWorkpaper.updateMany({
      where: { id, companyId, status: "DRAFT", version: expectedVersion },
      data: { status: "SUPERSEDED", version: { increment: 1 } },
    });
    if (superseded.count !== 1) throw new Error("Le document de travail a chang\u00e9 pendant la r\u00e9g\u00e9n\u00e9ration.");
    const workpaper = await createWorkpaperRevision(tx, {
      companyId,
      configuration,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      lineageKey: current.lineageKey,
      revision: current.revision + 1,
      supersedesWorkpaperId: current.id,
      copyFrom: current,
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "REGENERATE_VAT_WORKPAPER",
      entityType: "VatWorkpaper",
      entityId: workpaper.id,
      description: "Nouvelle r\u00e9vision du document de travail TVA g\u00e9n\u00e9r\u00e9e",
      payload: { supersedesWorkpaperId: current.id, revision: workpaper.revision, sourceSha256: workpaper.sourceSha256, evidenceSha256: workpaper.evidenceSha256 },
    });
    return workpaper;
  });
  return serialize(options, created);
}

async function updateDraftVersion(tx: PrismaLike, workpaper: any, expectedVersion: number) {
  if (workpaper.status !== "DRAFT") throw new Error("Seul un document de travail brouillon peut \u00eatre modifi\u00e9.");
  if (workpaper.version !== expectedVersion) throw new Error("Le document de travail a \u00e9t\u00e9 modifi\u00e9 ailleurs.");
  const claimed = await tx.vatWorkpaper.updateMany({
    where: { id: workpaper.id, status: "DRAFT", version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new Error("Le document de travail a chang\u00e9 pendant l'op\u00e9ration.");
}

async function refreshWorkpaperDerived(tx: PrismaLike, companyId: string, id: string) {
  const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
  const sourceTotals = workpaperTotals(workpaper.lines.map((line: any) => ({
    direction: line.direction,
    taxableCents: BigInt(line.taxableCents),
    vatCents: BigInt(line.vatCents),
  })));
  const amounts = workpaperAmounts(sourceTotals, workpaper.adjustments);
  const evidenceSha256 = workpaperEvidenceHash(workpaper);
  await tx.vatWorkpaper.update({ where: { id }, data: { ...amounts, evidenceSha256 } });
  return getWorkpaperWithEvidence(tx, id, companyId);
}

async function addVatAdjustment(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const direction = payload.direction === "COLLECTED" || payload.direction === "DEDUCTIBLE" ? payload.direction : null;
  if (!direction) throw new Error("La direction de l'ajustement est invalide.");
  const taxableCents = exactMoneyString(payload.taxableCents, "La base de l'ajustement");
  const vatCents = exactMoneyString(payload.vatCents, "La TVA de l'ajustement");
  if (taxableCents === 0n && vatCents === 0n) throw new Error("Un ajustement nul n'est pas autoris\u00e9.");
  const reason = requireText(payload.reason, "Le motif de l'ajustement", 500);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
    await updateDraftVersion(tx, workpaper, expectedVersion);
    const evidence = await requireHashedDocument(tx, companyId, payload.evidenceDocumentId);
    const last = await tx.vatWorkpaperAdjustment.findFirst({ where: { workpaperId: id }, orderBy: [{ position: "desc" }, { id: "desc" }] });
    const adjustment = await tx.vatWorkpaperAdjustment.create({
      data: {
        workpaperId: id,
        position: (last?.position ?? 0) + 1,
        direction,
        taxableCents,
        vatCents,
        reason,
        evidenceDocumentId: evidence.id,
        snapshotJson: complianceCanonicalJson({
          documentId: evidence.id,
          contentSha256: evidence.contentSha256,
          byteSize: BigInt(evidence.byteSize).toString(),
          title: evidence.title,
          type: evidence.type,
        }),
      },
    });
    const updated = await refreshWorkpaperDerived(tx, companyId, id);
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "ADD_VAT_WORKPAPER_ADJUSTMENT",
      entityType: "VatWorkpaperAdjustment",
      entityId: adjustment.id,
      description: "Ajustement justifi\u00e9 ajout\u00e9 au document de travail TVA",
      payload: { workpaperId: id, direction, taxableCents, vatCents, reason, evidenceDocumentId: evidence.id, evidenceContentSha256: evidence.contentSha256 },
    });
    return updated;
  });
  return serialize(options, result);
}

async function attachVatEvidence(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const role = requireText(payload.role, "Le r\u00f4le de la preuve", 80).toUpperCase();
  if (role === "FILING_RECEIPT") throw new Error("Le re\u00e7u de d\u00e9p\u00f4t se joint uniquement lors de l'enregistrement du d\u00e9p\u00f4t externe.");
  const note = optionalText(payload.note, 500);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
    await updateDraftVersion(tx, workpaper, expectedVersion);
    const document = await requireHashedDocument(tx, companyId, payload.documentId);
    const evidence = await tx.vatWorkpaperEvidence.create({
      data: {
        workpaperId: id,
        documentId: document.id,
        role,
        contentSha256Snapshot: document.contentSha256,
        byteSizeSnapshot: document.byteSize,
        note,
      },
    });
    const updated = await refreshWorkpaperDerived(tx, companyId, id);
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "ATTACH_VAT_WORKPAPER_EVIDENCE",
      entityType: "VatWorkpaperEvidence",
      entityId: evidence.id,
      description: "Pi\u00e8ce hach\u00e9e jointe au document de travail TVA",
      payload: { workpaperId: id, documentId: document.id, role, contentSha256Snapshot: document.contentSha256 },
    });
    return updated;
  });
  return serialize(options, result);
}

async function removeVatEvidence(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const evidenceId = requireId(payload.evidenceId, "La preuve");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
    await updateDraftVersion(tx, workpaper, expectedVersion);
    const evidence = await tx.vatWorkpaperEvidence.findFirst({ where: { id: evidenceId, workpaperId: id } });
    if (!evidence) throw new Error("La preuve n'appartient pas \u00e0 ce document de travail.");
    if (evidence.role === "FILING_RECEIPT") throw new Error("Un re\u00e7u de d\u00e9p\u00f4t ne peut pas \u00eatre retir\u00e9 de cette mani\u00e8re.");
    await tx.vatWorkpaperEvidence.delete({ where: { id: evidenceId } });
    const updated = await refreshWorkpaperDerived(tx, companyId, id);
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "REMOVE_VAT_WORKPAPER_EVIDENCE",
      entityType: "VatWorkpaperEvidence",
      entityId: evidenceId,
      description: "Pi\u00e8ce d\u00e9tach\u00e9e du brouillon TVA",
      payload: { workpaperId: id, documentId: evidence.documentId, role: evidence.role },
    });
    return updated;
  });
  return serialize(options, result);
}

async function assertWorkpaperFresh(tx: PrismaLike, workpaper: any) {
  const source = await collectTaxSourceEvents(tx, {
    companyId: workpaper.companyId,
    periodStart: workpaper.periodStart,
    periodEnd: workpaper.periodEnd,
    configuration: workpaper.taxConfigurationVersion,
  });
  if (source.sourceHash !== workpaper.sourceSha256) {
    throw new Error("Les sources comptables ont chang\u00e9 depuis la g\u00e9n\u00e9ration. R\u00e9g\u00e9n\u00e9rez une nouvelle r\u00e9vision avant la revue.");
  }
  for (const evidence of workpaper.evidence) {
    if (!evidence.document || evidence.document.companyId !== workpaper.companyId
      || evidence.document.contentSha256 !== evidence.contentSha256Snapshot
      || BigInt(evidence.document.byteSize ?? -1) !== BigInt(evidence.byteSizeSnapshot)) {
      throw new Error(`La preuve ${evidence.id} ne correspond plus \u00e0 son instantan\u00e9 hach\u00e9.`);
    }
  }
  for (const adjustment of workpaper.adjustments) {
    const document = adjustment.evidenceDocument;
    if (!document || !document.contentSha256 || !HASH_PATTERN.test(document.contentSha256)) {
      throw new Error(`L'ajustement ${adjustment.id} ne poss\u00e8de plus de preuve hach\u00e9e.`);
    }
    let snapshot: any;
    try {
      snapshot = JSON.parse(adjustment.snapshotJson);
    } catch {
      throw new Error(`L'instantan\u00e9 de preuve de l'ajustement ${adjustment.id} est illisible.`);
    }
    if (snapshot.contentSha256 !== document.contentSha256 || BigInt(snapshot.byteSize ?? -1) !== BigInt(document.byteSize ?? -2)) {
      throw new Error(`La preuve de l'ajustement ${adjustment.id} ne correspond plus \u00e0 son hash.`);
    }
  }
  const evidenceSha256 = workpaperEvidenceHash(workpaper);
  if (workpaper.evidenceSha256 && workpaper.evidenceSha256 !== evidenceSha256) {
    throw new Error("L'empreinte du dossier de preuves ne correspond plus aux donn\u00e9es enregistr\u00e9es.");
  }
  return { source, evidenceSha256 };
}

async function reviewVatWorkpaper(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  if (!actorUserId) throw new Error("Une session identifi\u00e9e est requise pour signer la revue locale.");
  const reviewed = await prisma.$transaction(async (tx: PrismaLike) => {
    const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
    if (workpaper.status !== "DRAFT") throw new Error("Seul un brouillon peut \u00eatre marqu\u00e9 comme relu.");
    if (workpaper.version !== expectedVersion) throw new Error("Le document de travail a \u00e9t\u00e9 modifi\u00e9 ailleurs.");
    const freshness = await assertWorkpaperFresh(tx, workpaper);
    const updated = await tx.vatWorkpaper.updateMany({
      where: { id, companyId, status: "DRAFT", version: expectedVersion },
      data: {
        status: "REVIEWED",
        sourceSha256: freshness.source.sourceHash,
        evidenceSha256: freshness.evidenceSha256,
        reviewedAt: currentTime(options),
        reviewedByUserId: actorUserId,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("Le document a chang\u00e9 pendant la revue.");
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "REVIEW_VAT_WORKPAPER",
      entityType: "VatWorkpaper",
      entityId: id,
      description: "Document de travail TVA relu localement",
      payload: { sourceSha256: freshness.source.sourceHash, evidenceSha256: freshness.evidenceSha256, filingTransmission: false },
    });
    return getWorkpaperWithEvidence(tx, id, companyId);
  });
  return serialize(options, reviewed);
}

async function returnVatWorkpaperToDraft(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const updated = await tx.vatWorkpaper.updateMany({
      where: { id, companyId, status: "REVIEWED", version: expectedVersion },
      data: { status: "DRAFT", reviewedAt: null, reviewedByUserId: null, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("Seul un document relu et non modifi\u00e9 peut revenir en brouillon.");
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "RETURN_VAT_WORKPAPER_TO_DRAFT",
      entityType: "VatWorkpaper",
      entityId: id,
      description: "Document de travail TVA renvoy\u00e9 en brouillon",
      payload: { filingTransmission: false },
    });
    return getWorkpaperWithEvidence(tx, id, companyId);
  });
  return serialize(options, result);
}

async function recordVatWorkpaperFiled(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const expectedVersion = requireInteger(payload.expectedVersion, "La version attendue", 1, 1_000_000_000);
  const filingReference = requireText(payload.filingReference, "La r\u00e9f\u00e9rence externe de d\u00e9p\u00f4t", 200);
  const filedAt = parseDay(payload.filedOn, "La date externe de d\u00e9p\u00f4t");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  if (!actorUserId) throw new Error("Une session identifi\u00e9e est requise pour enregistrer ce constat.");
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const workpaper = await getWorkpaperWithEvidence(tx, id, companyId);
    if (workpaper.status !== "REVIEWED" || workpaper.version !== expectedVersion) {
      throw new Error("Seul un document relu et non modifi\u00e9 peut enregistrer un d\u00e9p\u00f4t externe.");
    }
    if (filedAt < workpaper.periodEnd) throw new Error("La date externe de d\u00e9p\u00f4t ne peut pas pr\u00e9c\u00e9der la fin de la p\u00e9riode.");
    if (filedAt > currentTime(options)) throw new Error("La date externe de d\u00e9p\u00f4t ne peut pas \u00eatre future.");
    await assertWorkpaperFresh(tx, workpaper);
    const receipt = await requireHashedDocument(tx, companyId, payload.filingReceiptDocumentId, "FILING_RECEIPT");
    const alreadyUsed = await tx.vatWorkpaper.findFirst({ where: { filingReceiptDocumentId: receipt.id, id: { not: id } } });
    if (alreadyUsed) throw new Error("Ce re\u00e7u de d\u00e9p\u00f4t est d\u00e9j\u00e0 rattach\u00e9 \u00e0 un autre document de travail.");
    await tx.vatWorkpaperEvidence.create({
      data: {
        workpaperId: id,
        documentId: receipt.id,
        role: "FILING_RECEIPT",
        contentSha256Snapshot: receipt.contentSha256,
        byteSizeSnapshot: receipt.byteSize,
        note: `R\u00e9f\u00e9rence externe enregistr\u00e9e : ${filingReference}`,
      },
    });
    const hydrated = await getWorkpaperWithEvidence(tx, id, companyId);
    const evidenceSha256 = workpaperEvidenceHash(hydrated);
    const updated = await tx.vatWorkpaper.updateMany({
      where: { id, companyId, status: "REVIEWED", version: expectedVersion },
      data: {
        status: "FILED",
        filedAt,
        filedByUserId: actorUserId,
        filingReference,
        filingReceiptDocumentId: receipt.id,
        evidenceSha256,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("Le document a chang\u00e9 pendant l'enregistrement.");
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "RECORD_EXTERNAL_VAT_FILING",
      entityType: "VatWorkpaper",
      entityId: id,
      description: "D\u00e9p\u00f4t externe TVA enregistr\u00e9 manuellement avec re\u00e7u hach\u00e9",
      payload: {
        filingReference,
        filedAt,
        filingReceiptDocumentId: receipt.id,
        receiptSha256: receipt.contentSha256,
        evidenceSha256,
        transmittedByWheat: false,
      },
    });
    return getWorkpaperWithEvidence(tx, id, companyId);
  });
  return serialize(options, {
    ...result,
    notice: "Wheat a seulement enregistr\u00e9 une r\u00e9f\u00e9rence et un re\u00e7u externes ; aucune transmission n'a \u00e9t\u00e9 effectu\u00e9e par l'application.",
  });
}

async function reopenVatWorkpaper(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const reason = requireText(payload.reason, "Le motif de r\u00e9ouverture", 500);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    const current = await getWorkpaperWithEvidence(tx, id, companyId);
    if (current.status !== "FILED") throw new Error("Seul un document enregistr\u00e9 comme d\u00e9pos\u00e9 peut \u00eatre rouvert en nouvelle r\u00e9vision.");
    const superseded = await tx.vatWorkpaper.updateMany({
      where: { id, companyId, status: "FILED", version: current.version },
      data: { status: "SUPERSEDED", version: { increment: 1 } },
    });
    if (superseded.count !== 1) throw new Error("Le document de travail a chang\u00e9 pendant la r\u00e9ouverture.");
    const workpaper = await createWorkpaperRevision(tx, {
      companyId,
      configuration: current.taxConfigurationVersion,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      lineageKey: current.lineageKey,
      revision: current.revision + 1,
      supersedesWorkpaperId: current.id,
      copyFrom: current,
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "REOPEN_FILED_VAT_WORKPAPER",
      entityType: "VatWorkpaper",
      entityId: workpaper.id,
      description: "Document de travail TVA rouvert comme nouvelle r\u00e9vision brouillon",
      payload: { supersedesWorkpaperId: current.id, reason, filingTransmission: false },
    });
    return workpaper;
  });
  return serialize(options, result);
}

async function listVatWorkpapers(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const prisma = await options.getPrisma();
  await requireCompany(prisma, companyId);
  const where = { companyId, ...(payload.status ? { status: requireText(payload.status, "Le statut", 40) } : {}) };
  const count = await prisma.vatWorkpaper.count({ where });
  const items = await prisma.vatWorkpaper.findMany({
    where,
    include: { taxConfigurationVersion: { select: { id: true, name: true, revision: true, accountingBasis: true, filingFrequency: true } }, _count: { select: { lines: true, adjustments: true, evidence: true } } },
    orderBy: [{ periodStart: "desc" }, { revision: "desc" }, { id: "desc" }],
    take: MAX_WORKSPACE_ROWS,
  });
  return serialize(options, { items, count, truncated: count > items.length });
}

async function getVatWorkpaper(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const id = requireId(payload.id, "Le document de travail");
  const prisma = await options.getPrisma();
  const workpaper = await getWorkpaperWithEvidence(prisma, id, companyId);
  return serialize(options, {
    ...workpaper,
    notice: "Document de travail et dossier de preuves locaux ; aucune transmission fiscale automatique.",
  });
}

type CloseCheck = {
  code: string;
  severity: "BLOCKER" | "WARNING" | "INFO";
  passed: boolean;
  count: number;
  message: string;
  sampleIds: string[];
};

async function evaluateFiscalClose(tx: PrismaLike, companyId: string, fiscalYearId: string, cutoffAt?: Date) {
  const fiscalYear = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } });
  if (!fiscalYear) throw new Error("L'exercice n'appartient pas \u00e0 la soci\u00e9t\u00e9.");
  const cutoff = cutoffAt ?? fiscalYear.endsOn;
  if (cutoff.getTime() !== fiscalYear.endsOn.getTime()) throw new Error("La cl\u00f4ture doit porter sur la date de fin de l'exercice.");
  const dateWhere = { gte: fiscalYear.startsOn, lte: fiscalYear.endsOn };
  const [
    draftEntries,
    invalidEntryLines,
    unsafeImports,
    unreviewedDocuments,
    requiredArtifacts,
    missingRequiredArtifacts,
    legacyArtifacts,
    unreconciledMovements,
    reviewedUnfiled,
    applicableConfigs,
    workpapers,
    chainVerification,
  ] = await Promise.all([
    tx.entry.findMany({ where: { companyId, date: dateWhere, status: "DRAFT" }, select: { id: true }, take: 21 }),
    tx.entry.findMany({
      where: {
        companyId,
        date: dateWhere,
        status: { in: ["POSTED", "REVERSED"] },
        OR: [{ lines: { none: {} } }, { lines: { some: { debitCents: { lt: 0n } } } }, { lines: { some: { creditCents: { lt: 0n } } } }],
      },
      select: { id: true },
      take: 21,
    }),
    tx.ledgerImportBatch.findMany({ where: { companyId, importedAt: { lte: dateAfter(fiscalYear.endsOn) }, status: { in: ["STAGED", "REVIEW_REQUIRED"] } }, select: { id: true }, take: 21 }),
    tx.document.findMany({ where: { companyId, createdAt: { lte: dateAfter(fiscalYear.endsOn) }, status: "TO_REVIEW" }, select: { id: true }, take: 21 }),
    tx.invoice.findMany({ where: { companyId, invoiceDate: dateWhere, lifecycleStatus: "POSTED", artifactRequired: true }, select: { id: true }, take: 10_001 }),
    tx.invoice.findMany({
      where: { companyId, invoiceDate: dateWhere, lifecycleStatus: "POSTED", artifactRequired: true, artifacts: { none: { immutable: true } } },
      select: { id: true },
      take: 21,
    }),
    tx.invoiceArtifact.findMany({ where: { invoice: { companyId, invoiceDate: dateWhere }, OR: [{ immutable: false }, { contentSha256: "" }, { payloadSha256: "" }] }, select: { id: true }, take: 21 }),
    tx.bankMovement.findMany({
      where: {
        bankAccount: { companyId },
        date: dateWhere,
        excludedAt: null,
        reconciliations: { none: { status: "ACTIVE" } },
      },
      select: { id: true },
      take: 21,
    }),
    tx.vatWorkpaper.findMany({ where: { companyId, periodStart: { lte: fiscalYear.endsOn }, periodEnd: { gte: fiscalYear.startsOn }, status: "REVIEWED" }, select: { id: true }, take: 21 }),
    tx.taxConfigurationVersion.findMany({
      where: {
        companyId,
        status: "ACTIVE",
        effectiveFrom: { lte: fiscalYear.endsOn },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: fiscalYear.startsOn } }],
      },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
    }),
    tx.vatWorkpaper.findMany({
      where: { companyId, periodStart: { gte: fiscalYear.startsOn }, periodEnd: { lte: fiscalYear.endsOn }, status: { in: ["REVIEWED", "FILED"] } },
      select: { id: true, periodStart: true, periodEnd: true, status: true, taxConfigurationVersionId: true },
      take: 100,
    }),
    verifyAuditChain(tx, companyId),
  ]);

  const invalidBalancedIds: string[] = [];
  const postedEntries = await tx.entry.findMany({
    where: { companyId, date: dateWhere, status: { in: ["POSTED", "REVERSED"] } },
    select: { id: true, lines: { select: { debitCents: true, creditCents: true } } },
    take: 100_001,
  });
  if (postedEntries.length > 100_000) throw new Error("L'exercice d\u00e9passe la limite de contr\u00f4le de 100 000 \u00e9critures ; fractionnez ou archivez avant la cl\u00f4ture.");
  for (const entry of postedEntries) {
    const debit = entry.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.debitCents), 0n);
    const credit = entry.lines.reduce((sum: bigint, line: any) => sum + BigInt(line.creditCents), 0n);
    if (debit === 0n || debit !== credit) invalidBalancedIds.push(entry.id);
    if (invalidBalancedIds.length >= 20) break;
  }

  const missingPeriods: string[] = [];
  for (const configuration of applicableConfigs) {
    let cursor = configuration.effectiveFrom > fiscalYear.startsOn ? new Date(configuration.effectiveFrom) : new Date(fiscalYear.startsOn);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const activeEnd = configuration.effectiveTo && configuration.effectiveTo < fiscalYear.endsOn ? configuration.effectiveTo : fiscalYear.endsOn;
    const months = configuration.filingFrequency === "QUARTERLY" ? 3 : 1;
    while (cursor <= activeEnd) {
      const periodEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + months, 0));
      if (periodEnd > fiscalYear.endsOn || periodEnd > activeEnd) break;
      const found = workpapers.some((workpaper: any) => workpaper.taxConfigurationVersionId === configuration.id
        && isoDay(workpaper.periodStart) === isoDay(cursor)
        && isoDay(workpaper.periodEnd) === isoDay(periodEnd));
      if (!found) missingPeriods.push(`${isoDay(cursor)}:${isoDay(periodEnd)}`);
      cursor = dateAfter(periodEnd);
    }
  }

  const check = (code: string, severity: CloseCheck["severity"], failures: any[], message: string): CloseCheck => ({
    code,
    severity,
    passed: failures.length === 0,
    count: failures.length,
    message,
    sampleIds: failures.slice(0, 20).map((row: any) => typeof row === "string" ? row : row.id),
  });
  const checks: CloseCheck[] = [
    check("NO_DRAFT_ENTRIES", "BLOCKER", draftEntries, "Aucune \u00e9criture brouillon dans l'exercice."),
    check("POSTED_ENTRIES_VALID", "BLOCKER", [...invalidEntryLines, ...invalidBalancedIds], "Toutes les \u00e9critures comptabilis\u00e9es sont non vides, positives et \u00e9quilibr\u00e9es."),
    check("NO_PENDING_IMPORTS", "BLOCKER", unsafeImports, "Aucun import n'attend validation ou correction."),
    check("EVIDENCE_REVIEWED", "BLOCKER", unreviewedDocuments, "Toutes les pi\u00e8ces du p\u00e9rim\u00e8tre ont \u00e9t\u00e9 revues."),
    check("REQUIRED_INVOICE_ARTIFACTS", "BLOCKER", missingRequiredArtifacts, "Les factures exigeant un artefact poss\u00e8dent un artefact immuable."),
    check("AUDIT_CHAIN_VALID", "BLOCKER", chainVerification.valid ? [] : chainVerification.problems, "La cha\u00eene d'audit locale est valide."),
    check("REQUIRED_VAT_WORKPAPERS", "BLOCKER", missingPeriods, "Chaque p\u00e9riode TVA configur\u00e9e poss\u00e8de un document relu ou d\u00e9pos\u00e9."),
    check("LEGACY_ARTIFACTS", "WARNING", legacyArtifacts, "Certains artefacts sont historiques, mutables ou sans empreinte compl\u00e8te."),
    check("UNRECONCILED_BANK", "WARNING", unreconciledMovements, "Certains mouvements bancaires ne sont pas rapproch\u00e9s."),
    check("IMPORTED_UNSEALED", "WARNING", Array.from({ length: Math.min(chainVerification.importedUnsealedCount, 20) }, (_value, index) => `legacy-${index + 1}`), "Des \u00e9v\u00e9nements historiques import\u00e9s ne revendiquent pas d'int\u00e9grit\u00e9 ant\u00e9rieure."),
    check("REVIEWED_UNFILED_VAT", "WARNING", reviewedUnfiled, "Des documents TVA relus n'ont pas de constat de d\u00e9p\u00f4t externe."),
  ];
  const blockers = checks.filter((item) => item.severity === "BLOCKER" && !item.passed);
  const warnings = checks.filter((item) => item.severity === "WARNING" && !item.passed);
  const snapshot = {
    schema: STORED_SCHEMA_VERSIONS.fiscalCloseChecks.current,
    companyId,
    fiscalYearId,
    fiscalYear: { label: fiscalYear.label, startsOn: isoDay(fiscalYear.startsOn), endsOn: isoDay(fiscalYear.endsOn) },
    cutoffAt: isoDay(cutoff),
    checks,
  };
  const checksJson = complianceCanonicalJson(snapshot);
  const checksSha256 = complianceSha256(checksJson);
  return {
    fiscalYear,
    cutoffAt: cutoff,
    checks,
    blockers,
    warnings,
    ready: blockers.length === 0,
    checksJson,
    checksSha256,
    counts: { postedEntries: postedEntries.length, artifactRequiredInvoices: requiredArtifacts.length },
  };
}

async function previewFiscalClose(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
  const prisma = await options.getPrisma();
  const preview = await evaluateFiscalClose(prisma, companyId, fiscalYearId);
  return serialize(options, {
    ...preview,
    checkHash: preview.checksSha256,
    notice: "Contr\u00f4le local pr\u00e9paratoire ; il ne constitue ni un d\u00e9p\u00f4t ni une certification externe.",
  });
}

async function nextCloseSequence(tx: PrismaLike, fiscalYearId: string) {
  const latest = await tx.fiscalCloseRun.findFirst({ where: { fiscalYearId }, orderBy: [{ sequence: "desc" }, { id: "desc" }] });
  return Number(latest?.sequence ?? 0) + 1;
}

async function closeFiscalYear(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
  const expectedCheckHash = requireText(payload.checkHash, "L'empreinte du contr\u00f4le pr\u00e9alable", 64).toLowerCase();
  if (!HASH_PATTERN.test(expectedCheckHash)) throw new Error("L'empreinte du contr\u00f4le pr\u00e9alable est invalide.");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    if (!actorUserId) throw new Error("Une session identifi\u00e9e est requise pour cl\u00f4turer un exercice.");
    const fiscalYear = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } });
    if (!fiscalYear) throw new Error("L'exercice n'appartient pas \u00e0 la soci\u00e9t\u00e9.");
    if (fiscalYear.status !== "OPEN") throw new Error("Seul un exercice ouvert peut \u00eatre cl\u00f4tur\u00e9.");
    const preview = await evaluateFiscalClose(tx, companyId, fiscalYearId, fiscalYear.endsOn);
    if (preview.checksSha256 !== expectedCheckHash) {
      throw new Error("Les donn\u00e9es ont chang\u00e9 depuis l'aper\u00e7u. Relancez les contr\u00f4les avant de cl\u00f4turer.");
    }
    if (!preview.ready) throw new Error(`La cl\u00f4ture est bloqu\u00e9e : ${preview.blockers.map((blocker) => blocker.message).join(" ")}`);
    const sequence = await nextCloseSequence(tx, fiscalYearId);
    const run = await tx.fiscalCloseRun.create({
      data: {
        companyId,
        fiscalYearId,
        sequence,
        action: "CLOSE",
        status: "READY",
        cutoffAt: preview.cutoffAt,
        checksJson: preview.checksJson,
        checksSha256: preview.checksSha256,
        actorUserId,
      },
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "CLOSE_FISCAL_YEAR",
      entityType: "FiscalCloseRun",
      entityId: run.id,
      description: `Exercice ${fiscalYear.label} cl\u00f4tur\u00e9 localement`,
      payload: {
        fiscalYearId,
        cutoffAt: preview.cutoffAt,
        checksSha256: preview.checksSha256,
        blockers: 0,
        warningCodes: preview.warnings.map((warning) => warning.code),
        externalCertification: false,
      },
    });
    const { seal } = await createSealForCurrentTerminal(tx, {
      companyId,
      actorUserId,
      note: `Cl\u00f4ture locale ${fiscalYear.label} ; contr\u00f4les ${preview.checksSha256}`,
      appendCheckpointEvent: false,
      purpose: "FISCAL_CLOSE",
      payloadSha256: preview.checksSha256,
    });
    const closedAt = currentTime(options);
    const updated = await tx.fiscalYear.updateMany({
      where: { id: fiscalYearId, companyId, status: "OPEN", version: fiscalYear.version },
      data: {
        status: "CLOSED",
        lockedTo: fiscalYear.endsOn,
        closedAt,
        closedByUserId: actorUserId,
        closeRunId: run.id,
        reopenedAt: null,
        reopenedByUserId: null,
        reopenReason: null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("L'exercice a chang\u00e9 pendant la cl\u00f4ture.");
    const completedRun = await tx.fiscalCloseRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", auditSealId: seal.id, completedAt: closedAt, version: { increment: 1 } },
      include: { auditSeal: true },
    });
    return { run: completedRun, fiscalYear: await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } }), checks: preview.checks, warnings: preview.warnings };
  });
  return serialize(options, {
    ...result,
    notice: "Exercice verrouill\u00e9 et point de contr\u00f4le local cr\u00e9\u00e9 ; aucune certification externe.",
  });
}

async function reopenFiscalYear(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
  const reason = requireText(payload.reason, "Le motif de r\u00e9ouverture", 500);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  const result = await prisma.$transaction(async (tx: PrismaLike) => {
    await requireAdmin(tx, companyId, actorUserId);
    const fiscalYear = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } });
    if (!fiscalYear) throw new Error("L'exercice n'appartient pas \u00e0 la soci\u00e9t\u00e9.");
    if (fiscalYear.status !== "CLOSED" || !fiscalYear.closeRunId) throw new Error("Seul un exercice cl\u00f4tur\u00e9 par Wheat peut \u00eatre rouvert.");
    const laterClosed = await tx.fiscalYear.findFirst({
      where: { companyId, endsOn: { gt: fiscalYear.endsOn }, status: "CLOSED" },
      orderBy: { endsOn: "desc" },
    });
    if (laterClosed) throw new Error(`Rouvrez d'abord l'exercice post\u00e9rieur ${laterClosed.label} ; les r\u00e9ouvertures suivent l'ordre inverse des cl\u00f4tures.`);
    const latestCompleted = await tx.fiscalCloseRun.findFirst({
      where: { companyId, status: "COMPLETED" },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    if (!latestCompleted || latestCompleted.fiscalYearId !== fiscalYearId || latestCompleted.action !== "CLOSE") {
      throw new Error("La r\u00e9ouverture doit annuler la derni\u00e8re cl\u00f4ture compl\u00e9t\u00e9e dans l'ordre inverse.");
    }
    const chainVerification = await verifyAuditChain(tx, companyId);
    if (!chainVerification.valid) throw new Error("La cha\u00eene d'audit doit \u00eatre valide avant une r\u00e9ouverture.");
    const sequence = await nextCloseSequence(tx, fiscalYearId);
    const snapshot = {
      schema: STORED_SCHEMA_VERSIONS.fiscalReopen.current,
      companyId,
      fiscalYearId,
      reversesCloseRunId: fiscalYear.closeRunId,
      reason,
      previousStatus: fiscalYear.status,
      previousLockedTo: fiscalYear.lockedTo ? isoDay(fiscalYear.lockedTo) : null,
    };
    const checksJson = complianceCanonicalJson(snapshot);
    const checksSha256 = complianceSha256(checksJson);
    const run = await tx.fiscalCloseRun.create({
      data: {
        companyId,
        fiscalYearId,
        sequence,
        action: "REOPEN",
        status: "READY",
        cutoffAt: fiscalYear.endsOn,
        checksJson,
        checksSha256,
        reason,
        actorUserId,
      },
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "REOPEN_FISCAL_YEAR",
      entityType: "FiscalCloseRun",
      entityId: run.id,
      description: `Exercice ${fiscalYear.label} rouvert par un administrateur`,
      payload: { fiscalYearId, reason, reversesCloseRunId: fiscalYear.closeRunId, checksSha256, externalCertification: false },
    });
    const { seal } = await createSealForCurrentTerminal(tx, {
      companyId,
      actorUserId,
      note: `R\u00e9ouverture locale ${fiscalYear.label} ; ${reason}`,
      appendCheckpointEvent: false,
      purpose: "FISCAL_REOPEN",
      payloadSha256: checksSha256,
    });
    const reopenedAt = currentTime(options);
    const updated = await tx.fiscalYear.updateMany({
      where: { id: fiscalYearId, companyId, status: "CLOSED", version: fiscalYear.version },
      data: {
        status: "OPEN",
        lockedTo: null,
        closeRunId: null,
        reopenedAt,
        reopenedByUserId: actorUserId,
        reopenReason: reason,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("L'exercice a chang\u00e9 pendant la r\u00e9ouverture.");
    const completedRun = await tx.fiscalCloseRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", auditSealId: seal.id, completedAt: reopenedAt, version: { increment: 1 } },
      include: { auditSeal: true },
    });
    return { run: completedRun, fiscalYear: await tx.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } }) };
  });
  return serialize(options, {
    ...result,
    notice: "R\u00e9ouverture administrative locale consign\u00e9e ; le point de contr\u00f4le ant\u00e9rieur reste historique.",
  });
}

async function listFiscalCloseRuns(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const prisma = await options.getPrisma();
  await requireCompany(prisma, companyId);
  const where = { companyId, ...(payload.fiscalYearId ? { fiscalYearId: requireId(payload.fiscalYearId, "L'exercice") } : {}) };
  const count = await prisma.fiscalCloseRun.count({ where });
  const items = await prisma.fiscalCloseRun.findMany({
    where,
    include: { fiscalYear: true, actor: { select: { id: true, name: true, email: true, role: true } }, auditSeal: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_WORKSPACE_ROWS,
  });
  return serialize(options, { items, count, truncated: count > items.length });
}

async function taxWorkspace(options: Compliance14Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La soci\u00e9t\u00e9");
  const prisma = await options.getPrisma();
  const company = await requireCompany(prisma, companyId);
  const chain = await prisma.auditChain.findUnique({ where: { companyId } });
  const [
    configurationCount,
    configurations,
    workpaperCount,
    workpapers,
    fiscalYearCount,
    fiscalYears,
    closeRunCount,
    closeRuns,
    sealCount,
    seals,
    creditNoteCount,
    creditNotes,
  ] = await Promise.all([
    prisma.taxConfigurationVersion.count({ where: { companyId } }),
    prisma.taxConfigurationVersion.findMany({
      where: { companyId },
      include: { rates: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
      orderBy: [{ effectiveFrom: "desc" }, { revision: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }),
    prisma.vatWorkpaper.count({ where: { companyId } }),
    prisma.vatWorkpaper.findMany({
      where: { companyId },
      include: {
        taxConfigurationVersion: { select: { id: true, name: true, revision: true, accountingBasis: true, filingFrequency: true } },
        _count: { select: { lines: true, adjustments: true, evidence: true } },
      },
      orderBy: [{ periodStart: "desc" }, { revision: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }),
    prisma.fiscalYear.count({ where: { companyId } }),
    prisma.fiscalYear.findMany({
      where: { companyId },
      include: { closeRun: { include: { auditSeal: true } } },
      orderBy: [{ startsOn: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }),
    prisma.fiscalCloseRun.count({ where: { companyId } }),
    prisma.fiscalCloseRun.findMany({
      where: { companyId },
      include: { fiscalYear: true, actor: { select: { id: true, name: true, email: true, role: true } }, auditSeal: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }),
    chain ? prisma.auditSeal.count({ where: { chainId: chain.id } }) : Promise.resolve(0),
    chain ? prisma.auditSeal.findMany({
      where: { chainId: chain.id },
      include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: [{ throughSequence: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }) : Promise.resolve([]),
    prisma.invoice.count({ where: { companyId, documentType: "CREDIT_NOTE" } }),
    prisma.invoice.findMany({
      where: { companyId, documentType: "CREDIT_NOTE" },
      select: {
        id: true,
        invoiceNo: true,
        invoiceDate: true,
        dueDate: true,
        kind: true,
        lifecycleStatus: true,
        counterparty: true,
        counterpartyNameSnapshot: true,
        creditedInvoiceId: true,
        creditReason: true,
        htCents: true,
        vatCents: true,
        ttcCents: true,
        version: true,
        creditedInvoice: { select: { id: true, invoiceNo: true, invoiceDate: true, lifecycleStatus: true, ttcCents: true } },
        lines: {
          select: { id: true, position: true, description: true, creditedInvoiceLineId: true, vatRateBps: true, taxRateCodeSnapshot: true, htCents: true, vatCents: true, ttcCents: true },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          take: 500,
        },
        artifacts: {
          select: { id: true, kind: true, revision: true, mimeType: true, byteSize: true, contentSha256: true, payloadSha256: true, createdAt: true, immutable: true },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
          take: 20,
        },
      },
      orderBy: [{ invoiceDate: "desc" }, { id: "desc" }],
      take: MAX_WORKSPACE_ROWS,
    }),
  ]);
  const meta = (count: number, items: unknown[]) => ({ count, returned: items.length, truncated: count > items.length });
  return serialize(options, {
    company: { id: company.id, name: company.name, vatFrequency: company.vatFrequency, baseCurrency: company.baseCurrency },
    configurations,
    workpapers,
    fiscalYears,
    closeRuns,
    seals,
    creditNotes,
    limits: {
      configurations: meta(configurationCount, configurations),
      workpapers: meta(workpaperCount, workpapers),
      fiscalYears: meta(fiscalYearCount, fiscalYears),
      closeRuns: meta(closeRunCount, closeRuns),
      seals: meta(sealCount, seals),
      creditNotes: meta(creditNoteCount, creditNotes),
      maximumPerCollection: MAX_WORKSPACE_ROWS,
    },
    notices: {
      tax: "Espace local de pr\u00e9paration et de preuves ; Wheat ne transmet aucune d\u00e9claration fiscale.",
      seals: "Les points de contr\u00f4le sont locaux, sans certification ni horodatage externe.",
    },
  });
}

export function createCompliance14Service(options: Compliance14Options) {
  return {
    taxWorkspace: (payload: unknown) => taxWorkspace(options, payload),
    saveTaxConfigDraft: (payload: unknown) => saveTaxConfigDraft(options, payload),
    activateTaxConfig: (payload: unknown) => activateTaxConfig(options, payload),
    cloneTaxConfig: (payload: unknown) => cloneTaxConfig(options, payload),
    listVatWorkpapers: (payload: unknown) => listVatWorkpapers(options, payload),
    getVatWorkpaper: (payload: unknown) => getVatWorkpaper(options, payload),
    generateVatWorkpaper: (payload: unknown) => generateVatWorkpaper(options, payload),
    regenerateVatWorkpaper: (payload: unknown) => regenerateVatWorkpaper(options, payload),
    addVatAdjustment: (payload: unknown) => addVatAdjustment(options, payload),
    attachVatEvidence: (payload: unknown) => attachVatEvidence(options, payload),
    removeVatEvidence: (payload: unknown) => removeVatEvidence(options, payload),
    reviewVatWorkpaper: (payload: unknown) => reviewVatWorkpaper(options, payload),
    returnVatWorkpaperToDraft: (payload: unknown) => returnVatWorkpaperToDraft(options, payload),
    recordVatWorkpaperFiled: (payload: unknown) => recordVatWorkpaperFiled(options, payload),
    reopenVatWorkpaper: (payload: unknown) => reopenVatWorkpaper(options, payload),
    previewFiscalClose: (payload: unknown) => previewFiscalClose(options, payload),
    closeFiscalYear: (payload: unknown) => closeFiscalYear(options, payload),
    reopenFiscalYear: (payload: unknown) => reopenFiscalYear(options, payload),
    listFiscalCloseRuns: (payload: unknown) => listFiscalCloseRuns(options, payload),
    listAuditSeals: (payload: unknown) => listAuditSeals(options, payload),
    createAuditSeal: (payload: unknown) => createAuditSeal(options, payload),
    verifyAuditSeal: (payload: unknown) => verifyAuditSeal(options, payload),
  };
}

export function registerCompliance14Ipc(options: Compliance14RegistrationOptions) {
  const service = createCompliance14Service(options);
  const registrations: Array<[string, (payload: unknown) => Promise<unknown>]> = [
    [COMPLIANCE_14_IPC_CHANNELS.taxWorkspace, service.taxWorkspace],
    [COMPLIANCE_14_IPC_CHANNELS.taxConfigSaveDraft, service.saveTaxConfigDraft],
    [COMPLIANCE_14_IPC_CHANNELS.taxConfigActivate, service.activateTaxConfig],
    [COMPLIANCE_14_IPC_CHANNELS.taxConfigClone, service.cloneTaxConfig],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperList, service.listVatWorkpapers],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperGet, service.getVatWorkpaper],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperGenerate, service.generateVatWorkpaper],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperRegenerate, service.regenerateVatWorkpaper],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperAddAdjustment, service.addVatAdjustment],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperAttachEvidence, service.attachVatEvidence],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperRemoveEvidence, service.removeVatEvidence],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperReview, service.reviewVatWorkpaper],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperReturnToDraft, service.returnVatWorkpaperToDraft],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperRecordFiled, service.recordVatWorkpaperFiled],
    [COMPLIANCE_14_IPC_CHANNELS.vatWorkpaperReopen, service.reopenVatWorkpaper],
    [COMPLIANCE_14_IPC_CHANNELS.fiscalClosePreview, service.previewFiscalClose],
    [COMPLIANCE_14_IPC_CHANNELS.fiscalCloseClose, service.closeFiscalYear],
    [COMPLIANCE_14_IPC_CHANNELS.fiscalCloseReopen, service.reopenFiscalYear],
    [COMPLIANCE_14_IPC_CHANNELS.fiscalCloseRuns, service.listFiscalCloseRuns],
    [COMPLIANCE_14_IPC_CHANNELS.auditSealList, service.listAuditSeals],
    [COMPLIANCE_14_IPC_CHANNELS.auditSealCreate, service.createAuditSeal],
    [COMPLIANCE_14_IPC_CHANNELS.auditSealVerify, service.verifyAuditSeal],
  ];
  for (const [channel, handler] of registrations) {
    options.ipcMain.handle(channel, async (_event, payload) => handler(payload));
  }
  return service;
}
