import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

type PrismaLike = Record<string, any>;

export interface AuditEventInput {
  companyId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: unknown;
  occurredAt?: Date;
}

export interface ActivityAndAuditInput extends AuditEventInput {
  description: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  companyId: string;
  algorithm: "SHA256";
  eventCount: number;
  importedUnsealedCount: number;
  chainedCount: number;
  firstChainedSequence: string | null;
  lastSequence: string;
  lastEventHash: string | null;
  problems: string[];
}

const MAX_TEXT_LENGTH = 20_000;

function normalizedText(value: unknown, field: string, maximum = 160) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} est requis.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${field} est trop long.`);
  return normalized;
}

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Une valeur numérique non finie ne peut pas être auditée.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Une date invalide ne peut pas être auditée.");
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalValue(child);
    }
    return result;
  }
  throw new Error(`Le type ${typeof value} ne peut pas être audité.`);
}

export function canonicalAuditJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function computeAuditEventHash(input: {
  chainId: string;
  sequence: bigint | string | number;
  occurredAt: Date | string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payloadJson: string;
  previousHash?: string | null;
}) {
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : new Date(input.occurredAt).toISOString();
  const envelope = canonicalAuditJson({
    action: input.action,
    actorUserId: input.actorUserId ?? null,
    chainId: input.chainId,
    entityId: input.entityId ?? null,
    entityType: input.entityType,
    occurredAt,
    payloadJson: input.payloadJson,
    previousHash: input.previousHash ?? null,
    sequence: BigInt(input.sequence).toString(),
  });
  return createHash("sha256").update(envelope, "utf8").digest("hex");
}

async function ensureAuditChain(tx: PrismaLike, companyId: string) {
  const existing = await tx.auditChain.findUnique({ where: { companyId } });
  if (existing) return existing;
  try {
    return await tx.auditChain.create({ data: { companyId, algorithm: "SHA256" } });
  } catch (error) {
    const raced = await tx.auditChain.findUnique({ where: { companyId } });
    if (raced) return raced;
    throw error;
  }
}

export async function appendAuditEvent(tx: PrismaLike, input: AuditEventInput) {
  const companyId = normalizedText(input.companyId, "La société", 191);
  const action = normalizedText(input.action, "L'action", 120);
  const entityType = normalizedText(input.entityType, "Le type d'entité", 120);
  const entityId = input.entityId ? normalizedText(input.entityId, "L'identifiant d'entité", 191) : null;
  const actorUserId = input.actorUserId ? normalizedText(input.actorUserId, "L'acteur", 191) : null;
  const occurredAt = input.occurredAt ?? new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new Error("La date de l'événement d'audit est invalide.");

  const payloadJson = canonicalAuditJson(input.payload ?? {});
  if (payloadJson.length > MAX_TEXT_LENGTH) throw new Error("Le détail d'audit dépasse la taille autorisée.");
  await ensureAuditChain(tx, companyId);

  const rows = await tx.$queryRawUnsafe(
    'UPDATE "AuditChain" SET "lastSequence" = "lastSequence" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "companyId" = ? RETURNING "id", "lastSequence", "lastEventHash"',
    companyId,
  ) as Array<{ id: string; lastSequence: bigint | number; lastEventHash: string | null }>;
  const reserved = rows[0];
  if (!reserved) throw new Error("La séquence d'audit n'a pas pu être réservée.");

  const sequence = BigInt(reserved.lastSequence);
  const previousHash = reserved.lastEventHash ?? null;
  const eventHash = computeAuditEventHash({
    chainId: reserved.id,
    sequence,
    occurredAt,
    actorUserId,
    action,
    entityType,
    entityId,
    payloadJson,
    previousHash,
  });

  const event = await tx.auditEvent.create({
    data: {
      chainId: reserved.id,
      sequence,
      occurredAt,
      actorUserId,
      action,
      entityType,
      entityId,
      payloadJson,
      previousHash,
      eventHash,
      integrityStatus: "CHAINED",
    },
  });

  await tx.auditChain.update({
    where: { id: reserved.id },
    data: { lastEventHash: eventHash },
  });
  return event;
}

export async function appendActivityAndAudit(tx: PrismaLike, input: ActivityAndAuditInput) {
  const detailsJson = canonicalAuditJson(input.payload ?? {});
  const actorSnapshot = input.actorUserId
    ? await tx.user.findUnique({ where: { id: input.actorUserId }, select: { id: true, name: true, email: true, role: true } })
    : null;
  const activity = await tx.activityLog.create({
    data: {
      companyId: input.companyId,
      userId: input.actorUserId ?? null,
      action: input.action,
      entity: input.entityType,
      entityId: input.entityId ?? null,
      description: normalizedText(input.description, "La description", 500),
      detailsJson,
    },
  });
  const auditEvent = await appendAuditEvent(tx, {
    ...input,
    payload: {
      activityLogId: activity.id,
      description: input.description,
      actorSnapshot,
      details: input.payload ?? {},
    },
  });
  return { activity, auditEvent };
}

export async function verifyAuditChain(prisma: PrismaLike, companyIdValue: unknown): Promise<AuditVerificationResult> {
  const companyId = normalizedText(companyIdValue, "La société", 191);
  const chain = await prisma.auditChain.findUnique({ where: { companyId } });
  if (!chain) {
    return {
      valid: true,
      companyId,
      algorithm: "SHA256",
      eventCount: 0,
      importedUnsealedCount: 0,
      chainedCount: 0,
      firstChainedSequence: null,
      lastSequence: "0",
      lastEventHash: null,
      problems: [],
    };
  }

  const events = await prisma.auditEvent.findMany({
    where: { chainId: chain.id },
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });
  const problems: string[] = [];
  let expectedSequence = 1n;
  let previousChainedHash: string | null = null;
  let chainedSegmentStarted = false;
  let importedUnsealedCount = 0;
  let chainedCount = 0;
  let firstChainedSequence: string | null = null;

  for (const event of events) {
    const sequence = BigInt(event.sequence);
    if (sequence !== expectedSequence) {
      problems.push(`Séquence attendue ${expectedSequence.toString()}, trouvée ${sequence.toString()}.`);
      expectedSequence = sequence;
    }
    expectedSequence += 1n;

    if (event.integrityStatus === "IMPORTED_UNSEALED") {
      importedUnsealedCount += 1;
      if (chainedSegmentStarted) problems.push(`L'événement importé ${sequence.toString()} apparaît après le début de la chaîne vérifiable.`);
      if (event.eventHash || event.previousHash) problems.push(`L'événement importé ${sequence.toString()} ne doit pas revendiquer de hash historique.`);
      continue;
    }

    chainedSegmentStarted = true;
    chainedCount += 1;
    firstChainedSequence ??= sequence.toString();
    if (chainedCount === 1) previousChainedHash = event.previousHash ?? null;
    if (event.previousHash !== previousChainedHash) {
      problems.push(`Le lien précédent de l'événement ${sequence.toString()} est invalide.`);
    }
    const expectedHash = computeAuditEventHash({
      chainId: chain.id,
      sequence,
      occurredAt: event.occurredAt,
      actorUserId: event.actorUserId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      payloadJson: event.payloadJson,
      previousHash: event.previousHash,
    });
    if (event.integrityStatus !== "CHAINED") problems.push(`L'événement ${sequence.toString()} a un statut d'intégrité inconnu.`);
    if (event.eventHash !== expectedHash) problems.push(`Le hash de l'événement ${sequence.toString()} est invalide.`);
    previousChainedHash = event.eventHash;
  }

  const lastSequence = BigInt(chain.lastSequence);
  if (lastSequence !== BigInt(events.length)) problems.push("Le compteur de la chaîne ne correspond pas au nombre d'événements.");
  if (chain.lastEventHash !== previousChainedHash) problems.push("Le hash terminal de la chaîne ne correspond pas au dernier événement vérifiable.");

  return {
    valid: problems.length === 0,
    companyId,
    algorithm: "SHA256",
    eventCount: events.length,
    importedUnsealedCount,
    chainedCount,
    firstChainedSequence,
    lastSequence: lastSequence.toString(),
    lastEventHash: chain.lastEventHash,
    problems,
  };
}
