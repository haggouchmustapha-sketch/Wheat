/**
 * Inventaire physique: counting what is actually there, and reconciling it.
 *
 * A campaign is a freeze, a count, and an adjustment — in that order, and each
 * one is a state the dossier can be left in indefinitely. The thing it must
 * never become is a recalculation: an inventory that adjusted the ledger by
 * rewriting what the register said was in stock would leave nothing to audit
 * and no way to tell a counting error from a theft.
 *
 * ## The snapshot
 *
 * Freezing rebuilds the theoretical position **from the movements** up to and
 * including the campaign date, never from `StockBalance`. The balance cache is
 * today's position; a campaign dated at a year end has to see the position as
 * it was then, and reproducing it from the register is the only way that stays
 * true when the campaign is validated a week later.
 *
 * ## The basis cannot move underneath the count
 *
 * Validation recomputes the theoretical position and compares it against what
 * was frozen. If anything moved, validation **stops and names the article**
 * rather than adjusting against a basis nobody counted against. The correction
 * is to refresh the snapshot — which keeps every counted quantity — and look at
 * the variances again. Silently adjusting to the new basis would produce a
 * quantity that matches the count and a variance that explains nothing.
 *
 * ## The adjustment
 *
 * Variances become ordinary stock documents — an excédent d'inventaire for what
 * was found and a manquant d'inventaire for what was missing — validated
 * through the same path every other document takes. That is deliberate: the
 * movements, the FIFO layers, the numbering, the period check and the balanced
 * DRAFT accounting entry are then produced by the code that already does all of
 * that, rather than by a second implementation that would drift from it.
 */

import { appendActivityAndAudit } from "./audit13";
import {
  STOCK_INVENTORY_SEQUENCE,
  StockError,
  allocateStockSequenceNumber,
  lotKeyOf,
  positionKey,
} from "./stockDomain";
import { proportionalShare, qtyToDisplay, valueFromUnitPrice } from "./stockUnits";
import { validateStockDocumentInTransaction } from "./stockValidation";

/**
 * Draft → counting → reviewed → validated, with cancelled available until the
 * moment an adjustment exists.
 *
 * `DRAFT` is a campaign that has not frozen anything yet: it can still change
 * its date and its scope, because nothing has been measured against them.
 */
export const STOCK_CAMPAIGN_STATUS = {
  draft: "DRAFT",
  counting: "COUNTING",
  reviewed: "REVIEWED",
  validated: "VALIDATED",
  cancelled: "CANCELLED",
} as const;

export type StockCampaignStatus = (typeof STOCK_CAMPAIGN_STATUS)[keyof typeof STOCK_CAMPAIGN_STATUS];

const OPEN_FOR_COUNTING: string[] = [STOCK_CAMPAIGN_STATUS.counting, STOCK_CAMPAIGN_STATUS.reviewed];

export type TheoreticalPosition = {
  articleId: string;
  warehouseId: string;
  lotId: string | null;
  quantity: bigint;
  value: bigint;
};

/**
 * The position of every article, as the register says it stood on a date.
 *
 * Rebuilt by replaying movements rather than read from the balance cache, so a
 * campaign dated in the past sees the past. Positions that net to nothing are
 * kept: an article that was received and entirely sold is a position somebody
 * may still walk up to and find one of, and dropping it from the sheet would
 * make that finding impossible to record.
 */
export async function theoreticalPositionsAt(
  tx: any,
  companyId: string,
  date: Date,
  warehouseIds: string[] | null,
): Promise<TheoreticalPosition[]> {
  const movements = await tx.stockMovement.findMany({
    where: {
      companyId,
      documentDate: { lte: date },
      ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
    },
    orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
    select: { articleId: true, warehouseId: true, lotId: true, direction: true, quantity: true, value: true },
  });

  const positions = new Map<string, TheoreticalPosition>();
  for (const movement of movements) {
    const key = positionKey(movement.articleId, movement.warehouseId, movement.lotId);
    const held = positions.get(key) ?? {
      articleId: movement.articleId,
      warehouseId: movement.warehouseId,
      lotId: movement.lotId ?? null,
      quantity: 0n,
      value: 0n,
    };
    const sign = movement.direction === "IN" ? 1n : -1n;
    held.quantity += sign * movement.quantity;
    held.value += sign * movement.value;
    positions.set(key, held);
  }
  return [...positions.values()];
}

async function loadCampaign(tx: any, companyId: string, campaignId: string) {
  const campaign = await tx.stockInventoryCampaign.findFirst({
    where: { id: campaignId, companyId },
    include: { warehouse: { select: { id: true, code: true, name: true } } },
  });
  if (!campaign) throw new StockError("Cette campagne d'inventaire n'existe plus ou n'appartient pas à ce dossier.");
  return campaign;
}

/** The dépôts a campaign covers: the one it named, or every active dépôt. */
async function campaignWarehouseIds(tx: any, campaign: any): Promise<string[]> {
  if (campaign.warehouseId) return [campaign.warehouseId];
  const warehouses = await tx.stockWarehouse.findMany({
    where: { companyId: campaign.companyId, active: true },
    select: { id: true },
  });
  return warehouses.map((warehouse: any) => warehouse.id);
}

export type CreateCampaignInput = {
  companyId: string;
  warehouseId: string | null;
  countDate: Date;
  note: string | null;
  actorUserId: string | null;
};

export async function createCampaignInTransaction(tx: any, input: CreateCampaignInput) {
  if (input.warehouseId) {
    const warehouse = await tx.stockWarehouse.findFirst({ where: { id: input.warehouseId, companyId: input.companyId } });
    if (!warehouse) throw new StockError("Ce dépôt n'appartient pas à ce dossier.");
  }
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { companyId: input.companyId, startsOn: { lte: input.countDate }, endsOn: { gte: input.countDate } },
    orderBy: { startsOn: "desc" },
  });
  if (!fiscalYear) throw new StockError("La date d'inventaire ne correspond à aucun exercice comptable.");

  const reference = await allocateStockSequenceNumber(tx, {
    companyId: input.companyId,
    fiscalYearId: fiscalYear.id,
    type: STOCK_INVENTORY_SEQUENCE.type,
    prefix: STOCK_INVENTORY_SEQUENCE.prefix,
    date: input.countDate,
  });
  const campaign = await tx.stockInventoryCampaign.create({
    data: {
      companyId: input.companyId,
      reference,
      warehouseId: input.warehouseId,
      countDate: input.countDate,
      status: STOCK_CAMPAIGN_STATUS.draft,
      note: input.note,
      createdByUserId: input.actorUserId,
    },
  });
  await appendActivityAndAudit(tx, {
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_INVENTORY_CREATED",
    entityType: "StockInventoryCampaign",
    entityId: campaign.id,
    description: `Campagne d'inventaire ${reference} créée`,
    payload: { reference, warehouseId: input.warehouseId, countDate: input.countDate.toISOString() },
  });
  return campaign;
}

/**
 * Freezes — or refreshes — the theoretical position the count is measured
 * against.
 *
 * A refresh keeps every counted quantity. That is the whole point of offering
 * it: when validation reports that the basis moved, the person needs to see the
 * new variances for the counts they already took, not to count the warehouse
 * again. Positions that no longer exist keep their row with a theoretical of
 * zero, so a count taken against them still reads as the surplus it now is.
 */
export async function freezeCampaignInTransaction(tx: any, input: {
  companyId: string;
  campaignId: string;
  actorUserId: string | null;
}) {
  const campaign = await loadCampaign(tx, input.companyId, input.campaignId);
  if (campaign.status === STOCK_CAMPAIGN_STATUS.validated || campaign.status === STOCK_CAMPAIGN_STATUS.cancelled) {
    throw new StockError("Cette campagne est close : son inventaire théorique ne peut plus être regelé.");
  }

  const warehouseIds = await campaignWarehouseIds(tx, campaign);
  if (warehouseIds.length === 0) throw new StockError("Ce dossier n'a aucun dépôt actif à inventorier.");
  const positions = await theoreticalPositionsAt(tx, campaign.companyId, campaign.countDate, warehouseIds);

  const existing = await tx.stockInventoryCount.findMany({ where: { campaignId: campaign.id } });
  const existingByKey = new Map<string, any>(
    existing.map((row: any) => [positionKey(row.articleId, row.warehouseId, row.lotId), row]),
  );

  const seen = new Set<string>();
  for (const position of positions) {
    const key = positionKey(position.articleId, position.warehouseId, position.lotId);
    seen.add(key);
    const held = existingByKey.get(key);
    if (held) {
      await tx.stockInventoryCount.update({
        where: { id: held.id },
        data: { expectedQuantity: position.quantity, expectedValue: position.value },
      });
      continue;
    }
    await tx.stockInventoryCount.create({
      data: {
        campaignId: campaign.id,
        articleId: position.articleId,
        warehouseId: position.warehouseId,
        lotId: position.lotId,
        lotKey: lotKeyOf(position.lotId),
        expectedQuantity: position.quantity,
        expectedValue: position.value,
      },
    });
  }
  // A row the snapshot no longer produces is a position that has emptied since
  // the last freeze. It keeps its counted quantity and drops to a theoretical
  // of nothing, which is exactly what it is.
  for (const [key, row] of existingByKey) {
    if (seen.has(key)) continue;
    await tx.stockInventoryCount.update({
      where: { id: row.id },
      data: { expectedQuantity: 0n, expectedValue: 0n },
    });
  }

  const frozenAt = new Date();
  await tx.stockInventoryCampaign.update({
    where: { id: campaign.id },
    data: {
      status: campaign.status === STOCK_CAMPAIGN_STATUS.draft ? STOCK_CAMPAIGN_STATUS.counting : campaign.status,
      frozenAt,
      version: { increment: 1 },
    },
  });
  await appendActivityAndAudit(tx, {
    companyId: campaign.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_INVENTORY_FROZEN",
    entityType: "StockInventoryCampaign",
    entityId: campaign.id,
    description: `Inventaire théorique figé pour ${campaign.reference} (${positions.length} position(s))`,
    payload: { positions: positions.length, countDate: campaign.countDate.toISOString() },
  });
  return { campaignId: campaign.id, positions: positions.length, frozenAt };
}

export type CountEntry = {
  articleId: string;
  warehouseId: string;
  lotId: string | null;
  countedQuantity: bigint | null;
  unitValue: bigint | null;
  note: string | null;
};

/**
 * Records counted quantities.
 *
 * A row for a position the snapshot did not produce is created rather than
 * refused: finding goods the register knows nothing about is the ordinary
 * reason an inventory is taken, and the campaign has to be able to say so.
 */
export async function saveCountsInTransaction(tx: any, input: {
  companyId: string;
  campaignId: string;
  entries: CountEntry[];
  actorUserId: string | null;
}) {
  const campaign = await loadCampaign(tx, input.companyId, input.campaignId);
  if (!OPEN_FOR_COUNTING.includes(campaign.status)) {
    throw new StockError(campaign.status === STOCK_CAMPAIGN_STATUS.draft
      ? "Figez d'abord l'inventaire théorique de cette campagne avant de saisir des quantités."
      : "Cette campagne est close : ses quantités comptées ne peuvent plus changer.");
  }
  const warehouseIds = new Set(await campaignWarehouseIds(tx, campaign));

  const articleIds = [...new Set(input.entries.map((entry) => entry.articleId))];
  const articles = await tx.stockArticle.findMany({
    where: { id: { in: articleIds }, companyId: campaign.companyId },
    select: { id: true, designation: true, lotTracking: true },
  });
  const articleById = new Map<string, any>(articles.map((article: any) => [article.id, article]));

  const countedAt = new Date();
  let written = 0;
  for (const entry of input.entries) {
    const article = articleById.get(entry.articleId);
    if (!article) throw new StockError("Une ligne d'inventaire référence un article d'un autre dossier.");
    if (!warehouseIds.has(entry.warehouseId)) {
      throw new StockError("Une ligne d'inventaire référence un dépôt que cette campagne ne couvre pas.");
    }
    if (article.lotTracking && !entry.lotId) {
      throw new StockError(`L'article « ${article.designation} » est suivi par lot : indiquez le lot compté.`);
    }
    if (entry.countedQuantity !== null && entry.countedQuantity < 0n) {
      throw new StockError(`La quantité comptée de « ${article.designation} » ne peut pas être négative.`);
    }
    await tx.stockInventoryCount.upsert({
      where: {
        campaignId_warehouseId_articleId_lotKey: {
          campaignId: campaign.id,
          warehouseId: entry.warehouseId,
          articleId: entry.articleId,
          lotKey: lotKeyOf(entry.lotId),
        },
      },
      create: {
        campaignId: campaign.id,
        articleId: entry.articleId,
        warehouseId: entry.warehouseId,
        lotId: entry.lotId,
        lotKey: lotKeyOf(entry.lotId),
        expectedQuantity: 0n,
        expectedValue: 0n,
        countedQuantity: entry.countedQuantity,
        countedAt: entry.countedQuantity === null ? null : countedAt,
        unitValue: entry.unitValue,
        note: entry.note,
      },
      update: {
        countedQuantity: entry.countedQuantity,
        countedAt: entry.countedQuantity === null ? null : countedAt,
        unitValue: entry.unitValue,
        note: entry.note,
      },
    });
    written += 1;
  }

  await tx.stockInventoryCampaign.update({ where: { id: campaign.id }, data: { version: { increment: 1 } } });
  await appendActivityAndAudit(tx, {
    companyId: campaign.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_INVENTORY_COUNTED",
    entityType: "StockInventoryCampaign",
    entityId: campaign.id,
    description: `${written} quantité(s) comptée(s) enregistrée(s) sur ${campaign.reference}`,
    payload: { entries: written },
  });
  return { campaignId: campaign.id, written };
}

/** Moves a campaign between the states that do not write anything. */
export async function setCampaignStatusInTransaction(tx: any, input: {
  companyId: string;
  campaignId: string;
  status: string;
  actorUserId: string | null;
}) {
  const campaign = await loadCampaign(tx, input.companyId, input.campaignId);
  const allowed: Record<string, string[]> = {
    [STOCK_CAMPAIGN_STATUS.counting]: [STOCK_CAMPAIGN_STATUS.reviewed, STOCK_CAMPAIGN_STATUS.cancelled],
    [STOCK_CAMPAIGN_STATUS.reviewed]: [STOCK_CAMPAIGN_STATUS.counting, STOCK_CAMPAIGN_STATUS.cancelled],
    [STOCK_CAMPAIGN_STATUS.draft]: [STOCK_CAMPAIGN_STATUS.cancelled],
  };
  if (!(allowed[campaign.status] ?? []).includes(input.status)) {
    throw new StockError(campaign.status === STOCK_CAMPAIGN_STATUS.validated
      ? "Une campagne validée ne change plus d'état ; corrigez-la en contrepassant son document d'ajustement."
      : `Une campagne ${campaign.status} ne peut pas passer à ${input.status}.`);
  }
  const closing = input.status === STOCK_CAMPAIGN_STATUS.cancelled;
  const updated = await tx.stockInventoryCampaign.updateMany({
    where: { id: campaign.id, status: campaign.status, version: campaign.version },
    data: {
      status: input.status,
      ...(closing ? { closedAt: new Date(), closedByUserId: input.actorUserId } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) throw new StockError("Cette campagne a changé depuis son affichage. Rechargez-la.");
  await appendActivityAndAudit(tx, {
    companyId: campaign.companyId,
    actorUserId: input.actorUserId,
    action: closing ? "STOCK_INVENTORY_CANCELLED" : "STOCK_INVENTORY_STATUS_CHANGED",
    entityType: "StockInventoryCampaign",
    entityId: campaign.id,
    description: `${campaign.reference} : ${campaign.status} → ${input.status}`,
    payload: { from: campaign.status, to: input.status },
  });
  return { campaignId: campaign.id, status: input.status };
}

export type CampaignVariance = {
  count: any;
  expectedQuantity: bigint;
  expectedValue: bigint;
  countedQuantity: bigint | null;
  varianceQuantity: bigint;
  /**
   * What the écart is worth against the frozen theoretical position.
   *
   * Negative for a manquant, positive for an excédent, and `null` for an
   * excédent on a position the dossier holds nothing of and for which no unit
   * value was entered — the case validation refuses by name.
   *
   * Under CMP this is exactly what validation will post, because both take the
   * proportional share of the same position. Under **FIFO it is the theoretical
   * figure, not the posted one**: a manquant consumes the oldest layers, and
   * what those layers cost is not in general the average the position carries.
   * The variance report shows this figure before validation and the movement's
   * own value after it, which is the honest pair — the first is what the count
   * implies, the second is what the goods actually cost.
   */
  varianceValue: bigint | null;
};

/**
 * What each counted position implies, without writing anything.
 *
 * The value of a shortage is derived here exactly as `planOutbound` will derive
 * it during validation, so the variance report and the entry that follows it
 * agree to the centime. A position that was not counted produces no variance at
 * all — "nobody counted this" is not "there were none".
 */
export function varianceOf(count: any): CampaignVariance {
  const expectedQuantity: bigint = count.expectedQuantity;
  const expectedValue: bigint = count.expectedValue;
  const countedQuantity: bigint | null = count.countedQuantity;
  if (countedQuantity === null || countedQuantity === undefined) {
    return { count, expectedQuantity, expectedValue, countedQuantity: null, varianceQuantity: 0n, varianceValue: 0n };
  }
  const varianceQuantity = countedQuantity - expectedQuantity;
  if (varianceQuantity === 0n) {
    return { count, expectedQuantity, expectedValue, countedQuantity, varianceQuantity: 0n, varianceValue: 0n };
  }
  if (varianceQuantity < 0n) {
    const leaving = -varianceQuantity;
    // Proportional share of the theoretical value, and the whole of it when the
    // count says nothing is left — so a position counted to zero is valued to
    // zero rather than to a remainder nothing backs.
    const value = expectedQuantity === 0n ? 0n : proportionalShare(expectedValue, leaving, expectedQuantity);
    return { count, expectedQuantity, expectedValue, countedQuantity, varianceQuantity, varianceValue: -value };
  }
  if (expectedQuantity > 0n) {
    return {
      count, expectedQuantity, expectedValue, countedQuantity, varianceQuantity,
      varianceValue: proportionalShare(expectedValue, varianceQuantity, expectedQuantity),
    };
  }
  if (count.unitValue !== null && count.unitValue !== undefined) {
    return {
      count, expectedQuantity, expectedValue, countedQuantity, varianceQuantity,
      varianceValue: valueFromUnitPrice(varianceQuantity, count.unitValue),
    };
  }
  return { count, expectedQuantity, expectedValue, countedQuantity, varianceQuantity, varianceValue: null };
}

/**
 * Turns the counted variances into validated stock documents.
 *
 * Two documents at most — one for what was found, one for what was missing —
 * both carrying `inventoryCampaignId`, and both validated through
 * `validateStockDocumentInTransaction`. Everything that makes a stock movement
 * trustworthy therefore applies unchanged: the period check, the numbering, the
 * immutable register, the FIFO layers and the balanced DRAFT entry.
 */
export async function validateCampaignInTransaction(tx: any, input: {
  companyId: string;
  campaignId: string;
  actorUserId: string | null;
  expectedVersion?: number;
}) {
  const campaign = await loadCampaign(tx, input.companyId, input.campaignId);
  if (!OPEN_FOR_COUNTING.includes(campaign.status)) {
    throw new StockError(campaign.status === STOCK_CAMPAIGN_STATUS.validated
      ? "Cette campagne d'inventaire est déjà validée."
      : "Seule une campagne en cours de comptage ou revue peut être validée.");
  }
  if (input.expectedVersion !== undefined && campaign.version !== input.expectedVersion) {
    throw new StockError("Cette campagne a changé depuis son affichage. Rechargez-la avant de la valider.");
  }

  const counts = await tx.stockInventoryCount.findMany({
    where: { campaignId: campaign.id },
    include: {
      article: { select: { id: true, sku: true, designation: true, unitId: true, active: true, companyId: true } },
      warehouse: { select: { id: true, code: true, name: true, companyId: true } },
    },
    orderBy: [{ warehouseId: "asc" }, { articleId: "asc" }],
  });
  const counted = counts.filter((row: any) => row.countedQuantity !== null && row.countedQuantity !== undefined);
  if (counted.length === 0) throw new StockError("Aucune quantité n'a été comptée : il n'y a rien à ajuster.");

  // The basis may not move underneath the count. Recomputing it here and
  // comparing against what was frozen is what keeps the variance an accountant
  // signed off on and the movement Wheat is about to write the same statement.
  const warehouseIds = await campaignWarehouseIds(tx, campaign);
  const current = await theoreticalPositionsAt(tx, campaign.companyId, campaign.countDate, warehouseIds);
  const currentByKey = new Map<string, TheoreticalPosition>(
    current.map((position) => [positionKey(position.articleId, position.warehouseId, position.lotId), position]),
  );
  for (const row of counted) {
    const key = positionKey(row.articleId, row.warehouseId, row.lotId);
    const now = currentByKey.get(key) ?? { quantity: 0n, value: 0n };
    if (now.quantity !== row.expectedQuantity || now.value !== row.expectedValue) {
      throw new StockError(
        `Le stock théorique de « ${row.article.designation} » au dépôt ${row.warehouse.name} a changé depuis le gel de l'inventaire `
        + `(${qtyToDisplay(row.expectedQuantity)} figé, ${qtyToDisplay(now.quantity)} aujourd'hui).\n`
        + "Rafraîchissez l'inventaire théorique — les quantités comptées sont conservées — puis vérifiez les écarts avant de valider.",
      );
    }
    if (!row.article.active) throw new StockError(`L'article « ${row.article.designation} » est désactivé.`);
    if (row.article.companyId !== campaign.companyId || row.warehouse.companyId !== campaign.companyId) {
      throw new StockError("Une ligne d'inventaire référence un article ou un dépôt d'un autre dossier.");
    }
  }

  const variances: CampaignVariance[] = counted
    .map((row: any) => varianceOf(row))
    .filter((variance: CampaignVariance) => variance.varianceQuantity !== 0n);
  const missingValue = variances.find((variance) => variance.varianceValue === null);
  if (missingValue) {
    throw new StockError(
      `« ${missingValue.count.article.designation} » a été trouvé au dépôt ${missingValue.count.warehouse.name} `
      + "alors que le dossier n'en détenait aucun : indiquez la valeur d'acquisition unitaire de cet excédent.\n"
      + "Wheat n'invente pas un coût pour une marchandise dont il n'a aucune trace.",
    );
  }

  const surplus = variances.filter((variance) => variance.varianceQuantity > 0n);
  const shortage = variances.filter((variance) => variance.varianceQuantity < 0n);
  const documentIds: string[] = [];
  const fiscalYear = await requireFiscalYear(tx, campaign.companyId, campaign.countDate);

  for (const [type, group] of [["INVENTORY_SURPLUS", surplus], ["INVENTORY_SHORTAGE", shortage]] as const) {
    if (group.length === 0) continue;
    const document = await tx.stockDocument.create({
      data: {
        companyId: campaign.companyId,
        fiscalYearId: fiscalYear.id,
        type,
        reference: `BROUILLON-${campaign.reference}-${type}`,
        documentDate: campaign.countDate,
        warehouseId: campaign.warehouseId ?? group[0].count.warehouseId,
        note: `Inventaire physique ${campaign.reference}`,
        createdByUserId: input.actorUserId,
        inventoryCampaignId: campaign.id,
        lines: {
          create: group.map((variance, index) => {
            const quantity = variance.varianceQuantity < 0n ? -variance.varianceQuantity : variance.varianceQuantity;
            return {
              position: index + 1,
              articleId: variance.count.articleId,
              quantity,
              // Counts are taken in the article's own unit: a counting sheet
              // that mixed units would make the variance unreadable.
              unitId: variance.count.article.unitId,
              unitFactor: 1_000_000n,
              baseQuantity: quantity,
              warehouseId: variance.count.warehouseId,
              locationId: variance.count.locationId,
              lotId: variance.count.lotId,
              // A surplus landing on an empty position carries the value the
              // accountant entered; one landing on an existing position takes
              // that position's own value, which is what leaving unitValue null
              // asks the valuation to do.
              unitValue: variance.varianceQuantity > 0n && variance.expectedQuantity === 0n
                ? variance.count.unitValue
                : null,
              description: `Écart d'inventaire ${campaign.reference}`,
            };
          }),
        },
      },
    });
    await validateStockDocumentInTransaction(tx, {
      companyId: campaign.companyId,
      documentId: document.id,
      actorUserId: input.actorUserId,
    });
    documentIds.push(document.id);
  }

  const claimed = await tx.stockInventoryCampaign.updateMany({
    where: { id: campaign.id, status: campaign.status, version: campaign.version },
    data: {
      status: STOCK_CAMPAIGN_STATUS.validated,
      closedAt: new Date(),
      closedByUserId: input.actorUserId,
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) throw new StockError("Cette campagne a déjà été validée par une autre opération.");

  await appendActivityAndAudit(tx, {
    companyId: campaign.companyId,
    actorUserId: input.actorUserId,
    action: "STOCK_INVENTORY_VALIDATED",
    entityType: "StockInventoryCampaign",
    entityId: campaign.id,
    description: `${campaign.reference} validé : ${variances.length} écart(s), ${documentIds.length} document(s) d'ajustement`,
    payload: {
      reference: campaign.reference,
      surplus: surplus.length,
      shortage: shortage.length,
      documents: documentIds,
    },
  });

  return { campaignId: campaign.id, documentIds, surplus: surplus.length, shortage: shortage.length };
}

async function requireFiscalYear(tx: any, companyId: string, date: Date) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } },
    orderBy: { startsOn: "desc" },
  });
  if (!fiscalYear) throw new StockError("La date d'inventaire ne correspond à aucun exercice comptable.");
  return fiscalYear;
}
