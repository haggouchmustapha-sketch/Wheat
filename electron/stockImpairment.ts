/**
 * Dépréciation de stock: what the goods are worth, when that is less than what
 * they cost.
 *
 * An impairment changes the accounts and nothing else. It writes no movement,
 * touches no balance and consumes no FIFO layer, because nothing physical
 * happened: the dossier still holds exactly what it held, and the register is a
 * record of what happened rather than of what it is now worth. The provision
 * lives in the ledger, against the article's stock, as a contra-asset.
 *
 * ## The decision is recorded, not just its result
 *
 * The row keeps the quantity held, the value it was carried at and the
 * recoverable value the accountant entered. `amount` is the difference, and
 * storing it alone would leave a figure nobody could audit back to a judgement.
 *
 * ## Corrections are new operations
 *
 * A provision is never edited. Raising, lowering or releasing one appends a
 * **reprise** — its own row, its own reference, its own balanced entry — and
 * marks the original reversed. What the dossier thought in March stays legible
 * after it changed its mind in September, which is the whole point of a
 * provision being an estimate.
 *
 * ## No account, no entry, no row
 *
 * Unlike a stock movement, an impairment has no existence outside the ledger:
 * it *is* an accounting statement. So a dossier that has not configured its
 * provision, charge and reprise accounts cannot record one at all, and the
 * refusal names the account that is missing. Wheat does not pick 3911 because
 * 3911 is common — the suggestions exist to be confirmed by an accountant, not
 * to be applied on their behalf.
 */

import { assertPostingPeriodOpen } from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { createStockDraftEntry, requireStockJournal, type StockAccountingLeg } from "./stockAccounting";
import { STOCK_IMPAIRMENT_SEQUENCE, StockError, allocateStockSequenceNumber } from "./stockDomain";
import { moneyToDisplay, qtyToDisplay } from "./stockUnits";

export const STOCK_IMPAIRMENT_STATUS = {
  active: "ACTIVE",
  reversed: "REVERSED",
  reversal: "REVERSAL",
} as const;

export type ImpairedPosition = {
  quantity: bigint;
  value: bigint;
};

/**
 * What the dossier held of one article, as the register said on a date.
 *
 * Replayed from the movements for the same reason the inventory snapshot is:
 * an impairment dated at a year end has to be measured against the position as
 * it stood then, not against what has happened since.
 */
export async function impairedPositionAt(
  tx: any,
  companyId: string,
  articleId: string,
  warehouseId: string | null,
  date: Date,
): Promise<ImpairedPosition> {
  const movements = await tx.stockMovement.findMany({
    where: {
      companyId,
      articleId,
      ...(warehouseId ? { warehouseId } : {}),
      documentDate: { lte: date },
    },
    select: { direction: true, quantity: true, value: true },
  });
  let quantity = 0n;
  let value = 0n;
  for (const movement of movements) {
    const sign = movement.direction === "IN" ? 1n : -1n;
    quantity += sign * movement.quantity;
    value += sign * movement.value;
  }
  return { quantity, value };
}

/** The three accounts and the journal an impairment cannot be written without. */
async function requireImpairmentAccounts(tx: any, companyId: string, need: "PROVISION" | "REVERSAL") {
  const settings = await tx.stockSettings.findUnique({ where: { companyId } });
  if (!settings) throw new StockError("Le paramétrage du stock est absent pour ce dossier.");
  const missing: string[] = [];
  if (!settings.impairmentAccountId) missing.push("le compte de provision pour dépréciation des stocks");
  if (need === "PROVISION" && !settings.impairmentChargeAccountId) missing.push("le compte de dotation aux provisions");
  if (need === "REVERSAL" && !settings.impairmentReversalAccountId) missing.push("le compte de reprise sur provisions");
  if (missing.length > 0) {
    const named = missing.length > 1
      ? `${missing.join(" et ")} ne sont pas paramétrés`
      : `${missing[0]} n'est pas paramétré`;
    throw new StockError(
      `La comptabilisation de cette dépréciation est bloquée : ${named}.\n`
      + "Renseignez-les dans le paramétrage comptable du stock. Wheat ne choisit aucun compte à votre place : "
      + "les codes CGNC proposés sont des suggestions à valider par votre comptable.",
    );
  }
  const journalId = await requireStockJournal(tx, companyId);
  return {
    journalId,
    provisionAccountId: settings.impairmentAccountId as string,
    chargeAccountId: settings.impairmentChargeAccountId as string | null,
    reversalAccountId: settings.impairmentReversalAccountId as string | null,
  };
}

export type CreateImpairmentInput = {
  companyId: string;
  articleId: string;
  warehouseId: string | null;
  impairmentDate: Date;
  recoverableValue: bigint;
  reason: string;
  note: string | null;
  supportingDocumentId: string | null;
  actorUserId: string | null;
};

/**
 * Records a provision and the balanced DRAFT entry that carries it.
 *
 * `amount = valeur comptable − valeur recouvrable`, and an amount that is not
 * strictly positive is refused rather than written as a zero provision: stock
 * worth at least what it cost is not impaired, and saying so with a row would
 * put a decision in the ledger that was never taken.
 */
export async function createImpairmentInTransaction(tx: any, input: CreateImpairmentInput) {
  const article = await tx.stockArticle.findFirst({
    where: { id: input.articleId, companyId: input.companyId },
    select: { id: true, sku: true, designation: true, companyId: true },
  });
  if (!article) throw new StockError("Cet article n'existe plus ou n'appartient pas à ce dossier.");
  if (input.warehouseId) {
    const warehouse = await tx.stockWarehouse.findFirst({ where: { id: input.warehouseId, companyId: input.companyId } });
    if (!warehouse) throw new StockError("Ce dépôt n'appartient pas à ce dossier.");
  }
  if (input.supportingDocumentId) {
    const document = await tx.document.findFirst({ where: { id: input.supportingDocumentId, companyId: input.companyId } });
    if (!document) throw new StockError("Cette pièce justificative n'appartient pas à ce dossier.");
  }
  if (input.recoverableValue < 0n) throw new StockError("La valeur recouvrable ne peut pas être négative.");

  const fiscalYear = await assertPostingPeriodOpen(tx, input.companyId, input.impairmentDate, "La date de la dépréciation");
  const accounts = await requireImpairmentAccounts(tx, input.companyId, "PROVISION");

  // One active provision per position. Raising or lowering one is a reprise
  // followed by a new provision, so the ledger shows the change rather than a
  // row that quietly became a different number.
  const active = await tx.stockImpairment.findFirst({
    where: {
      companyId: input.companyId,
      articleId: input.articleId,
      warehouseId: input.warehouseId,
      status: STOCK_IMPAIRMENT_STATUS.active,
    },
  });
  if (active) {
    throw new StockError(
      `Une dépréciation est déjà active pour « ${article.designation} » (${active.reference}, ${moneyToDisplay(active.amount)} MAD).\n`
      + "Reprenez-la d'abord : Wheat corrige une provision par une reprise datée, jamais en réécrivant la précédente.",
    );
  }

  const position = await impairedPositionAt(tx, input.companyId, input.articleId, input.warehouseId, input.impairmentDate);
  if (position.quantity <= 0n) {
    throw new StockError(
      `« ${article.designation} » n'était pas en stock au ${input.impairmentDate.toISOString().slice(0, 10)} : il n'y a rien à déprécier.`,
    );
  }
  const amount = position.value - input.recoverableValue;
  if (amount <= 0n) {
    throw new StockError(
      `La valeur recouvrable (${moneyToDisplay(input.recoverableValue)} MAD) n'est pas inférieure à la valeur comptable `
      + `(${moneyToDisplay(position.value)} MAD) : il n'y a pas de dépréciation à constater.`,
    );
  }

  const reference = await allocateStockSequenceNumber(tx, {
    companyId: input.companyId,
    fiscalYearId: fiscalYear.id,
    type: STOCK_IMPAIRMENT_SEQUENCE.type,
    prefix: STOCK_IMPAIRMENT_SEQUENCE.prefix,
    date: input.impairmentDate,
  });

  // Dotation: the charge is debited and the provision credited.
  const leg: StockAccountingLeg = {
    debitAccountId: accounts.chargeAccountId!,
    creditAccountId: accounts.provisionAccountId,
    label: `Dépréciation ${reference} — ${article.designation}`.slice(0, 250),
    valueMicro: amount,
  };
  const entry = await createStockDraftEntry(tx, {
    companyId: input.companyId,
    journalId: accounts.journalId,
    date: input.impairmentDate,
    label: `Dépréciation de stock ${reference}`.slice(0, 300),
    reference,
    legs: [leg],
  });
  if (!entry) {
    throw new StockError(
      `La dépréciation de « ${article.designation} » vaut moins d'un centime une fois convertie : elle ne peut pas être comptabilisée.`,
    );
  }

  const impairment = await tx.stockImpairment.create({
    data: {
      companyId: input.companyId,
      reference,
      articleId: input.articleId,
      warehouseId: input.warehouseId,
      impairmentDate: input.impairmentDate,
      quantity: position.quantity,
      valueBefore: position.value,
      recoverableValue: input.recoverableValue,
      amount,
      reason: input.reason,
      note: input.note,
      status: STOCK_IMPAIRMENT_STATUS.active,
      accountingEntryId: entry.id,
      supportingDocumentId: input.supportingDocumentId,
      createdByUserId: input.actorUserId,
    },
  });

  await appendActivityAndAudit(tx, {
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_IMPAIRMENT_CREATED",
    entityType: "StockImpairment",
    entityId: impairment.id,
    description: `Dépréciation ${reference} de ${moneyToDisplay(amount)} MAD sur ${article.sku}`,
    payload: {
      reference,
      articleId: input.articleId,
      quantity: qtyToDisplay(position.quantity),
      valueBefore: moneyToDisplay(position.value),
      recoverableValue: moneyToDisplay(input.recoverableValue),
      amount: moneyToDisplay(amount),
      entryId: entry.id,
    },
  });
  return impairment;
}

/**
 * Reprise: releases an active provision, wholly, by appending its opposite.
 *
 * The original keeps every field it was written with and gains only the fact
 * that it was reversed and when. The new row is the reprise, with its own
 * reference and its own entry, so the two read as the sequence of judgements
 * they were.
 */
export async function reverseImpairmentInTransaction(tx: any, input: {
  companyId: string;
  impairmentId: string;
  date: Date | null;
  reason: string | null;
  actorUserId: string | null;
}) {
  const original = await tx.stockImpairment.findFirst({
    where: { id: input.impairmentId, companyId: input.companyId },
    include: { article: { select: { id: true, sku: true, designation: true } } },
  });
  if (!original) throw new StockError("Cette dépréciation n'existe plus ou n'appartient pas à ce dossier.");
  if (original.status !== STOCK_IMPAIRMENT_STATUS.active) {
    throw new StockError(original.status === STOCK_IMPAIRMENT_STATUS.reversed
      ? "Cette dépréciation a déjà été reprise."
      : "Une reprise ne se reprend pas ; constatez une nouvelle dépréciation si la situation l'exige.");
  }

  const date = input.date ?? original.impairmentDate;
  const fiscalYear = await assertPostingPeriodOpen(tx, input.companyId, date, "La date de la reprise");
  const accounts = await requireImpairmentAccounts(tx, input.companyId, "REVERSAL");

  const reference = await allocateStockSequenceNumber(tx, {
    companyId: input.companyId,
    fiscalYearId: fiscalYear.id,
    type: STOCK_IMPAIRMENT_SEQUENCE.type,
    prefix: STOCK_IMPAIRMENT_SEQUENCE.prefix,
    date,
  });

  // Reprise: the provision is debited and the reprise account credited.
  const entry = await createStockDraftEntry(tx, {
    companyId: input.companyId,
    journalId: accounts.journalId,
    date,
    label: `Reprise de dépréciation ${reference}`.slice(0, 300),
    reference,
    legs: [{
      debitAccountId: accounts.provisionAccountId,
      creditAccountId: accounts.reversalAccountId!,
      label: `Reprise ${original.reference} — ${original.article.designation}`.slice(0, 250),
      valueMicro: original.amount,
    }],
  });
  if (!entry) throw new StockError("Cette reprise vaut moins d'un centime une fois convertie : elle ne peut pas être comptabilisée.");

  const reversal = await tx.stockImpairment.create({
    data: {
      companyId: input.companyId,
      reference,
      articleId: original.articleId,
      warehouseId: original.warehouseId,
      impairmentDate: date,
      quantity: original.quantity,
      valueBefore: original.valueBefore,
      recoverableValue: original.recoverableValue,
      amount: original.amount,
      reason: input.reason ?? `Reprise de ${original.reference}`,
      status: STOCK_IMPAIRMENT_STATUS.reversal,
      accountingEntryId: entry.id,
      reversalOfId: original.id,
      createdByUserId: input.actorUserId,
    },
  });

  const claimed = await tx.stockImpairment.updateMany({
    where: { id: original.id, status: STOCK_IMPAIRMENT_STATUS.active, version: original.version },
    data: { status: STOCK_IMPAIRMENT_STATUS.reversed, reversedAt: new Date(), version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new StockError("Cette dépréciation a déjà été reprise par une autre opération.");

  await appendActivityAndAudit(tx, {
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_IMPAIRMENT_REVERSED",
    entityType: "StockImpairment",
    entityId: original.id,
    description: `Dépréciation ${original.reference} reprise par ${reference}`,
    payload: { reversalId: reversal.id, reference, amount: moneyToDisplay(original.amount), entryId: entry.id },
  });
  return reversal;
}
