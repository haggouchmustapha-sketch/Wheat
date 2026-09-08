import {
  ENTRY_STATUS,
  assertPostingPeriodOpen,
  formatCentsAsMad,
  madToCents,
  optionalText,
  parseAccountingDate,
  provisionalEntryNumber,
  requireId,
  requireText,
} from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { WHEAT_AI_ORIGIN, WHEAT_UI_ORIGIN, isWheatAiOrigin } from "./legacyDomainValues";
import { allocatePieceNumber } from "./pieceNumbering21";

type PrismaLike = Record<string, any> & {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

export type EntryCommandOptions = {
  getPrisma: () => PrismaLike | Promise<PrismaLike>;
  getActorUserId?: () => string | null | Promise<string | null>;
};

type EntryLinePayload = {
  accountId: string;
  label: string;
  debitCents: bigint;
  creditCents: bigint;
  thirdParty: string | null;
  counterpartyId: string | null;
};

type EntryPayload = {
  companyId: string;
  journalId: string;
  date: Date;
  pieceNumber: string | null;
  label: string;
  source: string;
  status: "DRAFT" | "POSTED";
  lines: EntryLinePayload[];
};

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  return value as Record<string, any>;
}

function exactCents(value: unknown, fallback: unknown, label: string) {
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`${label} doit être transmis sous forme de texte entier exact.`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      throw new Error(`${label} doit être exprimé en centimes entiers.`);
    }
    const raw = String(value).trim();
    if (!/^-?\d+$/.test(raw)) throw new Error(`${label} doit être exprimé en centimes entiers.`);
    const cents = BigInt(raw);
    if (cents < -(2n ** 63n) || cents > 2n ** 63n - 1n) throw new Error(`${label} est hors limites.`);
    return cents;
  }
  return madToCents(fallback ?? "0", label);
}

export function normalizeEntryCommandPayload(payloadValue: unknown): EntryPayload {
  const input = record(payloadValue, "Les données de l'écriture");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 500) {
    throw new Error("Une écriture doit contenir entre 1 et 500 lignes.");
  }
  const lines = input.lines.map((rawLine: unknown, index: number) => {
    const line = record(rawLine, `La ligne ${index + 1}`);
    const debitCents = exactCents(line.debitCents, line.debit, `Le débit de la ligne ${index + 1}`);
    const creditCents = exactCents(line.creditCents, line.credit, `Le crédit de la ligne ${index + 1}`);
    if (debitCents < 0n || creditCents < 0n) throw new Error(`Les montants de la ligne ${index + 1} ne peuvent pas être négatifs.`);
    if (debitCents > 0n && creditCents > 0n) throw new Error(`La ligne ${index + 1} ne peut pas être à la fois débitrice et créditrice.`);
    if (debitCents === 0n && creditCents === 0n) throw new Error(`La ligne ${index + 1} doit comporter un montant.`);
    return {
      accountId: requireId(line.accountId, `Le compte de la ligne ${index + 1}`),
      label: requireText(line.label, `Le libellé de la ligne ${index + 1}`, 250),
      debitCents,
      creditCents,
      thirdParty: optionalText(line.thirdParty, 200),
      counterpartyId: optionalText(line.counterpartyId, 200),
    };
  });
  const requestedStatus = input.status ?? ENTRY_STATUS.draft;
  if (requestedStatus !== ENTRY_STATUS.draft && requestedStatus !== ENTRY_STATUS.posted) throw new Error("Le statut demandé pour l'écriture est invalide.");
  return {
    companyId: requireId(input.companyId, "La société"),
    journalId: requireId(input.journalId, "Le journal"),
    date: parseAccountingDate(input.date, "La date de l'écriture"),
    pieceNumber: optionalText(input.pieceNumber, 80),
    label: requireText(input.label, "Le libellé de l'écriture", 300),
    source: optionalText(input.source, 40) ?? "MANUAL",
    status: requestedStatus,
    lines,
  };
}

export async function validateEntryCommandReferences(tx: any, payload: EntryPayload) {
  const [company, journal, accounts] = await Promise.all([
    tx.company.findUnique({ where: { id: payload.companyId }, select: { id: true } }),
    tx.journal.findUnique({ where: { id: payload.journalId }, select: { id: true, companyId: true, code: true, active: true, locked: true } }),
    tx.account.findMany({
      where: { id: { in: [...new Set(payload.lines.map((line) => line.accountId))] } },
      select: { id: true, companyId: true, active: true, code: true, label: true },
    }),
  ]);
  if (!company) throw new Error("La société sélectionnée n'existe plus.");
  if (!journal || journal.companyId !== payload.companyId) throw new Error("Le journal n'appartient pas à la société sélectionnée.");
  if (!journal.active || journal.locked) throw new Error("Le journal sélectionné est archivé ou verrouillé.");
  const accountById = new Map<string, any>(accounts.map((account: any) => [account.id, account]));
  for (const line of payload.lines) {
    const account = accountById.get(line.accountId);
    if (!account || account.companyId !== payload.companyId) throw new Error("Une ligne utilise un compte d'une autre société ou un compte inexistant.");
    if (!account.active) throw new Error("Une ligne utilise un compte désactivé.");
    if (line.counterpartyId) {
      const counterparty = await tx.counterparty.findFirst({ where: { id: line.counterpartyId, companyId: payload.companyId, active: true }, select: { id: true } });
      if (!counterparty) throw new Error("Une ligne utilise un tiers archivé ou d'une autre société.");
    }
  }
  return { journal, accountById };
}

export async function validateDraftEntryForPosting(tx: any, entryId: string, companyId?: string) {
  const entry = await tx.entry.findFirst({
    where: { id: entryId, ...(companyId ? { companyId } : {}) },
    include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } },
  });
  if (!entry) throw new Error("L'écriture demandée n'existe plus ou n'appartient pas à ce dossier.");
  if (entry.status !== ENTRY_STATUS.draft) {
    throw new Error(entry.status === ENTRY_STATUS.reversed
      ? "Une écriture extournée ne peut pas être comptabilisée à nouveau."
      : "Cette écriture est déjà comptabilisée et ne peut plus être modifiée.");
  }
  if (entry.journal.companyId !== entry.companyId) throw new Error("Le journal de l'écriture n'appartient pas à sa société.");
  if (!entry.journal.active || entry.journal.locked) throw new Error(`Le journal ${entry.journal.code} est archivé ou verrouillé.`);
  if (entry.lines.length < 2) throw new Error("La comptabilisation exige au moins deux lignes non nulles.");
  let debitCents = 0n;
  let creditCents = 0n;
  for (const [index, line] of entry.lines.entries()) {
    if (line.account.companyId !== entry.companyId) throw new Error(`Le compte de la ligne ${index + 1} n'appartient pas à la société.`);
    if (!line.account.active) throw new Error(`Le compte de la ligne ${index + 1} est désactivé.`);
    if (line.debitCents < 0n || line.creditCents < 0n || (line.debitCents > 0n && line.creditCents > 0n)) throw new Error(`Les montants de la ligne ${index + 1} sont invalides.`);
    if (line.debitCents === 0n && line.creditCents === 0n) throw new Error(`La ligne ${index + 1} est nulle.`);
    debitCents += line.debitCents;
    creditCents += line.creditCents;
  }
  if (debitCents !== creditCents) {
    const difference = debitCents > creditCents ? debitCents - creditCents : creditCents - debitCents;
    throw new Error(`L'écriture est déséquilibrée de ${formatCentsAsMad(difference)} MAD.`);
  }
  await assertPostingPeriodOpen(tx, entry.companyId, entry.date, "La date de l'écriture");
  return entry;
}

export async function postDraftEntryInTransaction(tx: any, entryId: string, companyId?: string) {
  const entry = await validateDraftEntryForPosting(tx, entryId, companyId);
  let journal = await tx.journal.update({ where: { id: entry.journalId }, data: { nextNumber: { increment: 1 } }, select: { code: true, nextNumber: true } });
  let sequence = journal.nextNumber - 1;
  let number = `${journal.code}-${entry.date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const occupied = await tx.entry.findUnique({ where: { companyId_number: { companyId: entry.companyId, number } }, select: { id: true } });
    if (!occupied || occupied.id === entry.id) break;
    journal = await tx.journal.update({ where: { id: entry.journalId }, data: { nextNumber: { increment: 1 } }, select: { code: true, nextNumber: true } });
    sequence = journal.nextNumber - 1;
    number = `${journal.code}-${entry.date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
    if (attempts === 9_999) throw new Error("Wheat n'a pas pu attribuer un numéro d'écriture libre à ce journal.");
  }
  const postedAt = new Date();
  const claimed = await tx.entry.updateMany({
    where: { id: entry.id, status: ENTRY_STATUS.draft, version: entry.version },
    data: { number, status: ENTRY_STATUS.posted, postedAt, journalCodeSnapshot: entry.journal.code, version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new Error("Cette écriture a déjà été traitée dans une autre opération.");
  for (const line of entry.lines) {
    const snapshotted = await tx.entryLine.updateMany({
      where: { id: line.id, entryId: entry.id },
      data: { accountCodeSnapshot: line.account.code, accountLabelSnapshot: line.account.label },
    });
    if (snapshotted.count !== 1) throw new Error("Une ligne de l'écriture a changé pendant la comptabilisation.");
  }
  return tx.entry.findUniqueOrThrow({ where: { id: entry.id }, include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } });
}

async function actorId(options: EntryCommandOptions) {
  return await options.getActorUserId?.() ?? null;
}

export function createEntryCommandService(options: EntryCommandOptions) {
  return {
    async getEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "La consultation de l'écriture");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const prisma = await options.getPrisma();
      const entry = await prisma.entry.findFirst({
        where: { id: entryId, companyId },
        include: {
          journal: { select: { id: true, code: true, label: true } },
          lines: { include: { account: { select: { id: true, code: true, label: true } }, counterparty: { select: { id: true, displayName: true, kind: true } } }, orderBy: { position: "asc" } },
          documents: { select: { id: true, title: true, type: true, status: true, createdAt: true }, orderBy: { createdAt: "asc" } },
          reversalOf: { select: { id: true, number: true, status: true } },
          reversals: { select: { id: true, number: true, status: true }, orderBy: { createdAt: "asc" } },
        },
      });
      if (!entry) throw new Error("L'écriture n'existe plus ou n'appartient pas à ce dossier.");
      return entry;
    },

    async previewCreateEntry(payloadValue: unknown) {
      const normalized = normalizeEntryCommandPayload(payloadValue);
      if (normalized.status !== ENTRY_STATUS.draft) throw new Error("La prévisualisation Wheat AI prépare uniquement un brouillon; la comptabilisation est une action séparée.");
      const prisma = await options.getPrisma();
      const references = await validateEntryCommandReferences(prisma, normalized);
      await assertPostingPeriodOpen(prisma, normalized.companyId, normalized.date, "La date du brouillon");
      const debitCents = normalized.lines.reduce((sum, line) => sum + line.debitCents, 0n);
      const creditCents = normalized.lines.reduce((sum, line) => sum + line.creditCents, 0n);
      if (debitCents !== creditCents) throw new Error(`Le brouillon proposé est déséquilibré de ${formatCentsAsMad(debitCents > creditCents ? debitCents - creditCents : creditCents - debitCents)} MAD.`);
      return {
        companyId: normalized.companyId,
        journal: { id: normalized.journalId, code: references.journal.code },
        date: normalized.date,
        label: normalized.label,
        lineCount: normalized.lines.length,
        debitCents,
        creditCents,
        accounts: [...references.accountById.values()].map((account: any) => ({ id: account.id, code: account.code, label: account.label })),
      };
    },

    async previewPostEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "La prévisualisation de comptabilisation");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const prisma = await options.getPrisma();
      const entry = await validateDraftEntryForPosting(prisma, entryId, companyId);
      return {
        entryId: entry.id,
        version: entry.version,
        number: entry.number,
        journal: entry.journal.code,
        date: entry.date,
        label: entry.label,
        lineCount: entry.lines.length,
        debitCents: entry.lines.reduce((sum: bigint, line: any) => sum + line.debitCents, 0n),
        warning: "La comptabilisation verrouillera cette version du brouillon; toute correction ultérieure exigera une extourne.",
      };
    },

    async createEntry(payloadValue: unknown) {
      const normalized = normalizeEntryCommandPayload(payloadValue);
      const prisma = await options.getPrisma();
      const trustedActor = await actorId(options);
      return prisma.$transaction(async (tx: any) => {
        const references = await validateEntryCommandReferences(tx, normalized);
        const piece = await allocatePieceNumber(tx, { companyId: normalized.companyId, journalId: normalized.journalId, date: normalized.date, requestedPieceNumber: normalized.pieceNumber, source: normalized.source });
        const created = await tx.entry.create({
          data: {
            companyId: normalized.companyId,
            journalId: normalized.journalId,
            journalCodeSnapshot: references.journal.code,
            number: provisionalEntryNumber(),
            date: normalized.date,
            ...piece,
            label: normalized.label,
            status: ENTRY_STATUS.draft,
            source: normalized.source,
            auditNote: isWheatAiOrigin(normalized.source) ? "Brouillon créé par Wheat AI à la demande de l'utilisateur" : "Brouillon créé depuis Wheat Desktop",
            lines: { create: normalized.lines.map((line, index) => ({
              position: index + 1,
              accountId: line.accountId,
              accountCodeSnapshot: references.accountById.get(line.accountId)!.code,
              accountLabelSnapshot: references.accountById.get(line.accountId)!.label,
              label: line.label,
              debitCents: line.debitCents,
              creditCents: line.creditCents,
              thirdParty: line.thirdParty,
              counterpartyId: line.counterpartyId,
            })) },
          },
        });
        const result = normalized.status === ENTRY_STATUS.posted
          ? await postDraftEntryInTransaction(tx, created.id, normalized.companyId)
          : await tx.entry.findUniqueOrThrow({ where: { id: created.id }, include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } });
        await appendActivityAndAudit(tx, {
          companyId: normalized.companyId,
          actorUserId: trustedActor,
          action: normalized.status === ENTRY_STATUS.posted ? "CREATE_AND_POST_ENTRY" : "CREATE_DRAFT_ENTRY",
          entityType: "Entry",
          entityId: created.id,
          description: normalized.status === ENTRY_STATUS.posted ? `${result.number} comptabilisée avec ${normalized.lines.length} lignes` : `${created.number} créé avec ${normalized.lines.length} lignes`,
          payload: { origin: isWheatAiOrigin(normalized.source) ? WHEAT_AI_ORIGIN : WHEAT_UI_ORIGIN, source: normalized.source, status: result.status, lineCount: normalized.lines.length },
        });
        return result;
      });
    },

    async postEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "La comptabilisation");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const prisma = await options.getPrisma();
      const trustedActor = await actorId(options);
      return prisma.$transaction(async (tx: any) => {
        const result = await postDraftEntryInTransaction(tx, entryId, companyId);
        await appendActivityAndAudit(tx, { companyId, actorUserId: trustedActor, action: "POST_ENTRY", entityType: "Entry", entityId: result.id, description: `${result.number} comptabilisée définitivement`, payload: { origin: payload.origin ?? WHEAT_UI_ORIGIN, number: result.number, postedAt: result.postedAt } });
        return result;
      });
    },

    async duplicateEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "La duplication");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const date = payload.date ? parseAccountingDate(payload.date, "La date du duplicata") : null;
      const prisma = await options.getPrisma();
      const trustedActor = await actorId(options);
      return prisma.$transaction(async (tx: any) => {
        const source = await tx.entry.findFirst({ where: { id: entryId, companyId }, include: { lines: { orderBy: { position: "asc" } } } });
        if (!source) throw new Error("L'écriture à dupliquer n'existe plus ou n'appartient pas à ce dossier.");
        const duplicateDate = date ?? source.date;
        const piece = await allocatePieceNumber(tx, { companyId, journalId: source.journalId, date: duplicateDate, source: "DUPLICATE" });
        const created = await tx.entry.create({
          data: {
            companyId,
            journalId: source.journalId,
            journalCodeSnapshot: source.journalCodeSnapshot,
            number: provisionalEntryNumber(),
            date: duplicateDate,
            ...piece,
            label: `Duplicata - ${source.label}`.slice(0, 300),
            status: ENTRY_STATUS.draft,
            source: isWheatAiOrigin(payload.origin) ? WHEAT_AI_ORIGIN : "DUPLICATE",
            auditNote: `Brouillon dupliqué depuis ${source.number}`,
            lines: { create: source.lines.map((line: any, index: number) => ({ position: index + 1, accountId: line.accountId, accountCodeSnapshot: line.accountCodeSnapshot, accountLabelSnapshot: line.accountLabelSnapshot, label: line.label, debitCents: line.debitCents, creditCents: line.creditCents, thirdParty: line.thirdParty, counterpartyId: line.counterpartyId })) },
          },
          include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } },
        });
        await appendActivityAndAudit(tx, { companyId, actorUserId: trustedActor, action: "DUPLICATE_ENTRY_AS_DRAFT", entityType: "Entry", entityId: created.id, description: `${source.number} dupliquée dans le brouillon ${created.number}`, payload: { origin: payload.origin ?? WHEAT_UI_ORIGIN, sourceEntryId: source.id } });
        return created;
      });
    },

    async reverseEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "L'extourne");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const reversalDate = parseAccountingDate(payload.date ?? new Date(), "La date d'extourne");
      const prisma = await options.getPrisma();
      const trustedActor = await actorId(options);
      return prisma.$transaction(async (tx: any) => {
        const source = await tx.entry.findFirst({ where: { id: entryId, companyId }, include: { lines: { orderBy: { position: "asc" } } } });
        if (!source) throw new Error("L'écriture à extourner n'existe plus ou n'appartient pas à ce dossier.");
        if (source.status !== ENTRY_STATUS.posted) throw new Error(source.status === ENTRY_STATUS.reversed ? "Cette écriture a déjà été extournée." : "Seule une écriture comptabilisée peut être extournée.");
        const [linkedInvoice, linkedPayment, linkedPayrollRun, linkedPostedDocument, activeBankAllocation] = await Promise.all([
          tx.invoice.findFirst({ where: { companyId, OR: [{ postedEntryId: source.id }, { voidEntryId: source.id }] }, select: { id: true } }),
          tx.payment.findFirst({ where: { companyId, OR: [{ postedEntryId: source.id }, { voidEntryId: source.id }] }, select: { id: true } }),
          tx.payrollRun.findFirst({ where: { companyId, postedEntryId: source.id, status: "POSTED" }, select: { id: true } }),
          tx.document.findFirst({ where: { companyId, entryId: source.id, status: "POSTED" }, select: { id: true } }),
          tx.bankReconciliationAllocation.findFirst({ where: { entryLine: { entryId: source.id }, reconciliation: { companyId, status: "ACTIVE" } }, select: { id: true } }),
        ]);
        if (linkedInvoice) throw new Error("Cette écriture appartient à une facture. Annulez la facture depuis le sous-livre.");
        if (linkedPayment) throw new Error("Cette écriture appartient à un paiement. Annulez le paiement depuis le sous-livre.");
        if (linkedPayrollRun) throw new Error("Cette écriture appartient à une paie comptabilisée et ne peut pas être extournée sans le workflow de paie.");
        if (linkedPostedDocument) throw new Error("Cette écriture appartient à un document comptabilisé. Utilisez son workflow métier.");
        if (activeBankAllocation) throw new Error("Annulez d'abord le rapprochement bancaire actif lié à cette écriture.");
        const existing = await tx.entry.findFirst({ where: { reversalOfId: source.id }, select: { number: true } });
        if (existing) throw new Error(`Cette écriture a déjà été extournée par ${existing.number}.`);
        const piece = await allocatePieceNumber(tx, { companyId, journalId: source.journalId, date: reversalDate, source: "REVERSAL" });
        const draft = await tx.entry.create({ data: {
          companyId,
          journalId: source.journalId,
          journalCodeSnapshot: source.journalCodeSnapshot,
          number: provisionalEntryNumber(),
          date: reversalDate,
          ...piece,
          label: `Extourne - ${source.label}`.slice(0, 300),
          status: ENTRY_STATUS.draft,
          source: "REVERSAL",
          reversalOfId: source.id,
          auditNote: `Extourne générée depuis ${source.number}`,
          lines: { create: source.lines.map((line: any, index: number) => ({ position: index + 1, accountId: line.accountId, accountCodeSnapshot: line.accountCodeSnapshot, accountLabelSnapshot: line.accountLabelSnapshot, label: line.label, debitCents: line.creditCents, creditCents: line.debitCents, thirdParty: line.thirdParty, counterpartyId: line.counterpartyId })) },
        } });
        const posted = await postDraftEntryInTransaction(tx, draft.id, companyId);
        const changed = await tx.entry.updateMany({ where: { id: source.id, companyId, status: ENTRY_STATUS.posted, version: source.version }, data: { status: ENTRY_STATUS.reversed, reversedAt: new Date(), version: { increment: 1 } } });
        if (changed.count !== 1) throw new Error("L'écriture a déjà été modifiée ou extournée dans une autre opération.");
        await appendActivityAndAudit(tx, { companyId, actorUserId: trustedActor, action: "REVERSE_ENTRY", entityType: "Entry", entityId: source.id, description: `${source.number} extournée par ${posted.number}`, payload: { origin: payload.origin ?? WHEAT_UI_ORIGIN, reversalEntryId: posted.id, reversalNumber: posted.number } });
        return posted;
      });
    },

    async deleteDraftEntry(payloadValue: unknown) {
      const payload = record(payloadValue, "La suppression du brouillon");
      const companyId = requireId(payload.companyId, "La société");
      const entryId = requireId(payload.entryId, "L'écriture");
      const prisma = await options.getPrisma();
      const trustedActor = await actorId(options);
      return prisma.$transaction(async (tx: any) => {
        const target = await tx.entry.findFirst({ where: { id: entryId, companyId }, include: { documents: true } });
        if (!target) throw new Error("L'écriture à supprimer n'existe plus ou n'appartient pas à ce dossier.");
        if (target.status !== ENTRY_STATUS.draft) throw new Error("Une écriture comptabilisée ou extournée ne peut jamais être supprimée.");
        await tx.document.updateMany({ where: { companyId, entryId }, data: { entryId: null, status: "EXTRACTED" } });
        const removed = await tx.entry.deleteMany({ where: { id: entryId, companyId, status: ENTRY_STATUS.draft, version: target.version } });
        if (removed.count !== 1) throw new Error("L'écriture a été traitée dans une autre opération et ne peut plus être supprimée.");
        await appendActivityAndAudit(tx, { companyId, actorUserId: trustedActor, action: "DELETE_DRAFT_ENTRY", entityType: "Entry", entityId: target.id, description: `${target.number} supprimé ; ${target.documents.length} document(s) lié(s) conservé(s)`, payload: { origin: payload.origin ?? WHEAT_UI_ORIGIN, number: target.number, documentCount: target.documents.length } });
        return { ok: true, id: entryId, number: target.number };
      });
    },
  };
}
