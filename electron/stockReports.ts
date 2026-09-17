/**
 * The Stock reports an accountant asks for, and nothing an accountant would
 * have to take on faith.
 *
 * Every figure here is either read from the register or derived from it by the
 * same arithmetic the register itself uses. There is no estimate, no
 * classification and no prediction: "slow-moving" means "no movement since this
 * date", stated with the date, rather than a judgement about whether the goods
 * will sell. A report that guessed would be a report an accountant cannot sign.
 *
 * Valuation as at a date is **rebuilt from movements**, never read from
 * `StockBalance`. The balance cache answers "now"; a valuation dated at a year
 * end has to answer "then", and it has to give the same answer next year.
 *
 * Everything returns exact `BigInt`. Turning those into the `{ raw, display }`
 * pair the renderer reads is the service layer's job, in one place, so no
 * report can invent its own way of rounding.
 */

import { positionKey } from "./stockDomain";
import { allocateProportionally, derivedUnitCost } from "./stockUnits";
import { STOCK_IMPAIRMENT_STATUS } from "./stockImpairment";
import { varianceOf } from "./stockInventory";

export type ValuationFilters = {
  companyId: string;
  asOf: Date;
  warehouseId?: string | null;
  articleId?: string | null;
  familyId?: string | null;
  valuationMethod?: string | null;
  /** "ARTICLE" lists every position; the others total them up. */
  groupBy: "ARTICLE" | "WAREHOUSE" | "FAMILY" | "METHOD";
};

export type ValuationRow = {
  key: string;
  label: string;
  sublabel: string | null;
  quantity: bigint;
  value: bigint;
  unitCost: bigint | null;
  /** Active provisions against this line, which reduce what it is worth. */
  impairment: bigint;
  netValue: bigint;
};

/**
 * État de valorisation at a date, grouped the way the reader asked.
 *
 * The unit cost is derived for display and never fed back, exactly as it is
 * everywhere else: a grouped row's unit cost is its own value over its own
 * quantity, which is the only figure that is true of the group rather than of
 * whichever article happened to sort first.
 */
export async function stockValuationReport(client: any, filters: ValuationFilters) {
  const articles = await client.stockArticle.findMany({
    where: {
      companyId: filters.companyId,
      ...(filters.articleId ? { id: filters.articleId } : {}),
      ...(filters.familyId ? { familyId: filters.familyId } : {}),
      ...(filters.valuationMethod ? { valuationMethod: filters.valuationMethod } : {}),
    },
    select: {
      id: true, sku: true, designation: true, valuationMethod: true, familyId: true,
      family: { select: { id: true, code: true, designation: true } },
      unit: { select: { code: true } },
    },
  });
  const articleById = new Map<string, any>(articles.map((article: any) => [article.id, article]));
  if (articleById.size === 0) return { rows: [] as ValuationRow[], totals: { quantity: 0n, value: 0n, impairment: 0n, netValue: 0n } };

  const movements = await client.stockMovement.findMany({
    where: {
      companyId: filters.companyId,
      documentDate: { lte: filters.asOf },
      articleId: { in: [...articleById.keys()] },
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    },
    select: { articleId: true, warehouseId: true, direction: true, quantity: true, value: true },
  });

  const warehouses = await client.stockWarehouse.findMany({
    where: { companyId: filters.companyId },
    select: { id: true, code: true, name: true },
  });
  const warehouseById = new Map<string, any>(warehouses.map((warehouse: any) => [warehouse.id, warehouse]));

  // Provisions are read as they stand, not as at the date: a provision is an
  // opinion held now about goods held then, and dating it back would report a
  // net value the dossier never stated.
  const impairments = await client.stockImpairment.findMany({
    where: { companyId: filters.companyId, status: STOCK_IMPAIRMENT_STATUS.active },
    select: { articleId: true, warehouseId: true, amount: true },
  });

  const keyOf = (articleId: string, warehouseId: string) => {
    const article = articleById.get(articleId);
    if (filters.groupBy === "WAREHOUSE") {
      const warehouse = warehouseById.get(warehouseId);
      return { key: warehouseId, label: warehouse?.name ?? warehouseId, sublabel: warehouse?.code ?? null };
    }
    if (filters.groupBy === "FAMILY") {
      return {
        key: article.familyId ?? "",
        label: article.family?.designation ?? "Sans famille",
        sublabel: article.family?.code ?? null,
      };
    }
    if (filters.groupBy === "METHOD") {
      return { key: article.valuationMethod, label: article.valuationMethod, sublabel: null };
    }
    const warehouse = warehouseById.get(warehouseId);
    return {
      key: positionKey(articleId, warehouseId, null),
      label: article.designation,
      sublabel: `${article.sku}${warehouse ? ` · ${warehouse.name}` : ""}`,
    };
  };

  // Positions first, groups second. A provision taken over the whole dossier
  // names no dépôt, so it can only be attributed once the positions it applies
  // to are known — and it has to be attributed before they are summed, or a
  // report grouped by dépôt would drop it without saying so.
  type Position = { articleId: string; warehouseId: string; quantity: bigint; value: bigint; impairment: bigint };
  const positions = new Map<string, Position>();
  for (const movement of movements) {
    if (!articleById.has(movement.articleId)) continue;
    const key = positionKey(movement.articleId, movement.warehouseId, null);
    const held = positions.get(key)
      ?? { articleId: movement.articleId, warehouseId: movement.warehouseId, quantity: 0n, value: 0n, impairment: 0n };
    const sign = movement.direction === "IN" ? 1n : -1n;
    held.quantity += sign * movement.quantity;
    held.value += sign * movement.value;
    positions.set(key, held);
  }

  const byArticle = new Map<string, Position[]>();
  for (const position of positions.values()) {
    const held = byArticle.get(position.articleId) ?? [];
    held.push(position);
    byArticle.set(position.articleId, held);
  }

  for (const impairment of impairments) {
    if (!articleById.has(impairment.articleId)) continue;
    if (impairment.warehouseId) {
      if (filters.warehouseId && impairment.warehouseId !== filters.warehouseId) continue;
      const position = positions.get(positionKey(impairment.articleId, impairment.warehouseId, null));
      if (position) position.impairment += impairment.amount;
      continue;
    }
    // Dossier-wide: split across that article's positions in proportion to what
    // each is worth, by the one allocation rule that sums back to the total.
    const held = byArticle.get(impairment.articleId) ?? [];
    if (held.length === 0) continue;
    const parts = held.every((position) => position.value === 0n)
      ? held.map((_position, index) => (index === held.length - 1 ? impairment.amount : 0n))
      : allocateProportionally(impairment.amount, held.map((position) => position.value));
    held.forEach((position, index) => { position.impairment += parts[index]; });
  }

  type Bucket = { quantity: bigint; value: bigint; impairment: bigint; label: string; sublabel: string | null };
  const buckets = new Map<string, Bucket>();
  for (const position of positions.values()) {
    const identity = keyOf(position.articleId, position.warehouseId);
    const bucket = buckets.get(identity.key)
      ?? { quantity: 0n, value: 0n, impairment: 0n, label: identity.label, sublabel: identity.sublabel };
    bucket.quantity += position.quantity;
    bucket.value += position.value;
    bucket.impairment += position.impairment;
    buckets.set(identity.key, bucket);
  }


  const rows: ValuationRow[] = [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      sublabel: bucket.sublabel,
      quantity: bucket.quantity,
      value: bucket.value,
      unitCost: derivedUnitCost(bucket.value, bucket.quantity),
      impairment: bucket.impairment,
      netValue: bucket.value - bucket.impairment,
    }))
    .filter((row) => row.quantity !== 0n || row.value !== 0n || row.impairment !== 0n)
    .sort((left, right) => left.label.localeCompare(right.label, "fr"));

  return {
    rows,
    totals: {
      quantity: rows.reduce((sum, row) => sum + row.quantity, 0n),
      value: rows.reduce((sum, row) => sum + row.value, 0n),
      impairment: rows.reduce((sum, row) => sum + row.impairment, 0n),
      netValue: rows.reduce((sum, row) => sum + row.netValue, 0n),
    },
  };
}

export type MovementReportFilters = {
  companyId: string;
  from?: Date | null;
  to?: Date | null;
  articleId?: string | null;
  warehouseId?: string | null;
  documentType?: string | null;
  direction?: "IN" | "OUT" | null;
  reference?: string | null;
  limit?: number;
};

/**
 * Journal des mouvements: the register itself, filtered.
 *
 * Ordered by `(documentDate, sequence)` — the same order FIFO consumes in and
 * the stock card runs its balance in — so two reports of the same period list
 * the same movements in the same order however they were filtered.
 */
export async function stockMovementReport(client: any, filters: MovementReportFilters) {
  const movements = await client.stockMovement.findMany({
    where: {
      companyId: filters.companyId,
      ...(filters.articleId ? { articleId: filters.articleId } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.documentType ? { documentType: filters.documentType } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
      ...(filters.from || filters.to
        ? { documentDate: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
      ...(filters.reference ? { document: { reference: { contains: filters.reference } } } : {}),
    },
    orderBy: [{ documentDate: "asc" }, { sequence: "asc" }],
    take: Math.min(Math.max(filters.limit ?? 2000, 1), 10_000),
    include: {
      article: { select: { id: true, sku: true, designation: true } },
      warehouse: { select: { id: true, code: true, name: true } },
      lot: { select: { id: true, code: true } },
      document: {
        select: {
          id: true, reference: true, type: true, status: true, accountingEntryId: true,
          counterparty: { select: { id: true, displayName: true } },
        },
      },
    },
  });

  const totals = { inQuantity: 0n, outQuantity: 0n, inValue: 0n, outValue: 0n };
  for (const movement of movements) {
    if (movement.direction === "IN") {
      totals.inQuantity += movement.quantity as bigint;
      totals.inValue += movement.value as bigint;
    } else {
      totals.outQuantity += movement.quantity as bigint;
      totals.outValue += movement.value as bigint;
    }
  }

  return { movements, totals };
}

/**
 * Écarts d'inventaire for one campaign.
 *
 * Reads the frozen theoretical figures and the counted ones, and derives the
 * variance with `varianceOf` — the same function validation uses, so the report
 * and the adjustment cannot disagree about what the écart is.
 */
export async function inventoryVarianceReport(client: any, input: { companyId: string; campaignId: string }) {
  const campaign = await client.stockInventoryCampaign.findFirst({
    where: { id: input.campaignId, companyId: input.companyId },
    include: {
      warehouse: { select: { id: true, code: true, name: true } },
      documents: {
        select: { id: true, reference: true, type: true, status: true, accountingEntryId: true },
        orderBy: { type: "asc" },
      },
    },
  });
  if (!campaign) return null;

  const counts = await client.stockInventoryCount.findMany({
    where: { campaignId: campaign.id },
    include: {
      article: { select: { id: true, sku: true, designation: true, valuationMethod: true, unit: { select: { code: true } } } },
      warehouse: { select: { id: true, code: true, name: true } },
      lot: { select: { id: true, code: true } },
    },
    orderBy: [{ warehouseId: "asc" }, { articleId: "asc" }],
  });

  const rows = counts.map((count: any) => {
    const variance = varianceOf(count);
    return {
      count,
      expectedQuantity: variance.expectedQuantity,
      expectedValue: variance.expectedValue,
      countedQuantity: variance.countedQuantity,
      varianceQuantity: variance.varianceQuantity,
      varianceValue: variance.varianceValue,
    };
  });

  const counted = rows.filter((row: any) => row.countedQuantity !== null);
  return {
    campaign,
    rows,
    summary: {
      positions: rows.length,
      counted: counted.length,
      uncounted: rows.length - counted.length,
      surplus: counted.filter((row: any) => row.varianceQuantity > 0n).length,
      shortage: counted.filter((row: any) => row.varianceQuantity < 0n).length,
      expectedValue: rows.reduce((sum: bigint, row: any) => sum + row.expectedValue, 0n),
      varianceValue: counted.reduce((sum: bigint, row: any) => sum + (row.varianceValue ?? 0n), 0n),
      /** Rows whose surplus has no cost to enter it at; validation names them. */
      unvalued: counted.filter((row: any) => row.varianceValue === null).length,
    },
  };
}

export type StockAnomaly = {
  kind: "NEGATIVE_QUANTITY" | "VALUE_WITHOUT_QUANTITY" | "QUANTITY_WITHOUT_VALUE" | "NEGATIVE_VALUE" | "LAYERS_DISAGREE";
  articleId: string;
  sku: string;
  designation: string;
  warehouseId: string;
  warehouseName: string;
  quantity: bigint;
  value: bigint;
  detail: bigint | null;
  message: string;
};

/**
 * Positions the engine can prove are wrong, or that no sequence of real events
 * produces.
 *
 * Deterministic and complete rather than heuristic: each of these is a
 * statement about arithmetic, not a suspicion. Quantity without value is the
 * one that matters most — it is stock an issue cannot be costed against — and
 * value without quantity is the residue the whole module exists to prevent, so
 * finding one is a bug report rather than a business problem.
 */
export async function stockAnomalyReport(client: any, input: { companyId: string; warehouseId?: string | null }) {
  const balances = await client.stockBalance.findMany({
    where: { companyId: input.companyId, ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}) },
    include: {
      article: { select: { id: true, sku: true, designation: true, valuationMethod: true } },
      warehouse: { select: { id: true, name: true } },
    },
  });

  const anomalies: StockAnomaly[] = [];
  const base = (balance: any) => ({
    articleId: balance.articleId,
    sku: balance.article.sku,
    designation: balance.article.designation,
    warehouseId: balance.warehouseId,
    warehouseName: balance.warehouse.name,
    quantity: balance.quantity as bigint,
    value: balance.value as bigint,
  });

  const fifoArticles = balances.filter((balance: any) => balance.article.valuationMethod === "FIFO");
  const layerTotals = new Map<string, { quantity: bigint; value: bigint }>();
  if (fifoArticles.length > 0) {
    const layers = await client.stockFifoLayer.findMany({
      where: {
        companyId: input.companyId,
        articleId: { in: [...new Set(fifoArticles.map((balance: any) => balance.articleId))] },
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      },
      select: { articleId: true, warehouseId: true, quantityRemaining: true, valueRemaining: true },
    });
    for (const layer of layers) {
      const key = positionKey(layer.articleId, layer.warehouseId, null);
      const held = layerTotals.get(key) ?? { quantity: 0n, value: 0n };
      held.quantity += layer.quantityRemaining;
      held.value += layer.valueRemaining;
      layerTotals.set(key, held);
    }
  }

  for (const balance of balances) {
    const row = base(balance);
    if (balance.quantity < 0n) {
      anomalies.push({
        ...row, kind: "NEGATIVE_QUANTITY", detail: null,
        message: "Quantité négative : le dossier a laissé sortir plus que ce qu'il détenait.",
      });
    }
    if (balance.value < 0n) {
      anomalies.push({
        ...row, kind: "NEGATIVE_VALUE", detail: null,
        message: "Valeur négative : aucune suite d'opérations réelles ne produit une position qui vaut moins que rien.",
      });
    }
    if (balance.quantity === 0n && balance.value !== 0n) {
      anomalies.push({
        ...row, kind: "VALUE_WITHOUT_QUANTITY", detail: null,
        message: "Quantité nulle mais valeur résiduelle : la position aurait dû se vider exactement.",
      });
    }
    if (balance.quantity > 0n && balance.value <= 0n) {
      anomalies.push({
        ...row, kind: "QUANTITY_WITHOUT_VALUE", detail: null,
        message: "Stock détenu sans valeur : une sortie ne pourrait être valorisée contre cette position.",
      });
    }
    if (balance.article.valuationMethod === "FIFO") {
      const totals = layerTotals.get(positionKey(balance.articleId, balance.warehouseId, null)) ?? { quantity: 0n, value: 0n };
      if (totals.quantity !== balance.quantity || totals.value !== balance.value) {
        anomalies.push({
          ...row, kind: "LAYERS_DISAGREE", detail: totals.value,
          message: `Les couches FIFO totalisent ${totals.quantity} en quantité et ${totals.value} en valeur, `
            + "ce que la position ne confirme pas.",
        });
      }
    }
  }
  return { anomalies };
}

export type AgeingBucket = { label: string; fromDays: number; toDays: number | null };

/**
 * Buckets stated in days, because "dormant" is not a fact and a date is.
 *
 * A dossier that wants different thresholds changes these; nothing here infers
 * that a slow article is a dead one.
 */
export const STOCK_AGEING_BUCKETS: AgeingBucket[] = [
  { label: "0–30 jours", fromDays: 0, toDays: 30 },
  { label: "31–90 jours", fromDays: 31, toDays: 90 },
  { label: "91–180 jours", fromDays: 91, toDays: 180 },
  { label: "181–365 jours", fromDays: 181, toDays: 365 },
  { label: "Plus d'un an", fromDays: 366, toDays: null },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rotation lente: how long each held position has gone without moving.
 *
 * "Last movement" means the last movement of any kind, including a receipt: a
 * position that was last touched when it was bought two years ago is exactly
 * the case this report exists to surface. A position that never moved at all
 * cannot be held, so every row here has a date.
 */
export async function stockAgeingReport(client: any, input: {
  companyId: string;
  asOf: Date;
  warehouseId?: string | null;
  minimumDays?: number | null;
}) {
  const balances = await client.stockBalance.findMany({
    where: {
      companyId: input.companyId,
      quantity: { gt: 0n },
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    },
    include: {
      article: { select: { id: true, sku: true, designation: true, family: { select: { code: true, designation: true } } } },
      warehouse: { select: { id: true, code: true, name: true } },
    },
  });
  if (balances.length === 0) return { rows: [], buckets: STOCK_AGEING_BUCKETS.map((bucket) => ({ ...bucket, positions: 0, value: 0n })) };

  const lastMovements = await client.stockMovement.groupBy({
    by: ["articleId", "warehouseId"],
    where: {
      companyId: input.companyId,
      documentDate: { lte: input.asOf },
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    },
    _max: { documentDate: true },
  });
  const lastByPosition = new Map<string, Date>(
    lastMovements.map((row: any) => [positionKey(row.articleId, row.warehouseId, null), row._max.documentDate]),
  );
  const lastOutbound = await client.stockMovement.groupBy({
    by: ["articleId", "warehouseId"],
    where: {
      companyId: input.companyId,
      direction: "OUT",
      documentDate: { lte: input.asOf },
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    },
    _max: { documentDate: true },
  });
  const lastOutByPosition = new Map<string, Date>(
    lastOutbound.map((row: any) => [positionKey(row.articleId, row.warehouseId, null), row._max.documentDate]),
  );

  const asOfMs = input.asOf.getTime();
  const rows = balances
    .map((balance: any) => {
      const key = positionKey(balance.articleId, balance.warehouseId, null);
      const last = lastByPosition.get(key) ?? null;
      const lastOut = lastOutByPosition.get(key) ?? null;
      const days = last ? Math.max(0, Math.floor((asOfMs - new Date(last).getTime()) / DAY_MS)) : null;
      const daysWithoutIssue = lastOut ? Math.max(0, Math.floor((asOfMs - new Date(lastOut).getTime()) / DAY_MS)) : null;
      return {
        articleId: balance.articleId,
        sku: balance.article.sku,
        designation: balance.article.designation,
        family: balance.article.family,
        warehouse: balance.warehouse,
        quantity: balance.quantity as bigint,
        value: balance.value as bigint,
        lastMovementDate: last,
        lastIssueDate: lastOut,
        days,
        /** Null means the position has never had an issue at all. */
        daysWithoutIssue,
      };
    })
    .filter((row: any) => (input.minimumDays ? (row.days ?? Number.MAX_SAFE_INTEGER) >= input.minimumDays : true))
    .sort((left: any, right: any) => (right.days ?? 0) - (left.days ?? 0));

  const buckets = STOCK_AGEING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row: any) => {
      const days = row.days ?? Number.MAX_SAFE_INTEGER;
      return days >= bucket.fromDays && (bucket.toDays === null || days <= bucket.toDays);
    });
    return {
      ...bucket,
      positions: inBucket.length,
      value: inBucket.reduce((sum: bigint, row: any) => sum + row.value, 0n),
    };
  });

  return { rows, buckets };
}
