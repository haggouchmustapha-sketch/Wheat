/**
 * How a stock position changes, and what a movement is worth.
 *
 * Pure arithmetic over plain values: no Prisma, no transaction, no company.
 * The caller reads the position and the layers, asks this module what the
 * movement does, and writes the answer back. Keeping it free of the database
 * is what makes the reference cases in the specification testable as
 * arithmetic — and what stops a valuation rule from quietly depending on how a
 * query happened to be ordered.
 *
 * Two methods, chosen per article:
 *
 *  - **CMP** — moving weighted average. The position is the whole story; a
 *    receipt adds quantity and value, an issue removes the proportional share.
 *  - **FIFO** — every receipt is a layer, and an issue consumes the oldest
 *    layers first. Each layer touched produces a consumption record, because
 *    "which cost did this sale actually carry" is a question the module has to
 *    be able to answer years later, and because a reversal has to give the
 *    value back to the layers it came from rather than to an average.
 *
 * Both obey the same invariant: a position is `(quantity, value)`, and when
 * quantity reaches zero, value reaches zero exactly.
 */

import { proportionalShare } from "./stockUnits";

export const VALUATION_METHODS = ["CMP", "FIFO"] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export function isValuationMethod(value: unknown): value is ValuationMethod {
  return typeof value === "string" && (VALUATION_METHODS as readonly string[]).includes(value);
}

/** A quantity and the value that belongs to it. Never a rounded unit cost. */
export type StockPosition = {
  quantity: bigint;
  value: bigint;
};

export const EMPTY_POSITION: StockPosition = { quantity: 0n, value: 0n };

/**
 * An acquisition layer with what is left of it.
 *
 * `id` is opaque here — the caller decides whether it is a database id or a
 * test fixture label — so the consumption plan can be applied to whatever the
 * caller is actually holding.
 */
export type FifoLayer = {
  id: string;
  quantityRemaining: bigint;
  valueRemaining: bigint;
};

/** One layer's share of one issue. */
export type FifoConsumption = {
  layerId: string;
  quantity: bigint;
  value: bigint;
  /** True when this consumption emptied the layer, which reversal checks. */
  exhausted: boolean;
};

export type FifoPlan = {
  consumptions: FifoConsumption[];
  totalValue: bigint;
};

export class StockValuationError extends Error {}

/**
 * A receipt: quantity and value both go up, and nothing is recomputed.
 *
 * The same for CMP and FIFO — under FIFO the caller additionally opens a layer
 * carrying exactly `incomingValue`, so the layers always sum to the position.
 */
export function applyReceipt(position: StockPosition, incomingQuantity: bigint, incomingValue: bigint): StockPosition {
  if (incomingQuantity <= 0n) throw new StockValuationError("Une entrée en stock doit porter une quantité positive.");
  if (incomingValue < 0n) throw new StockValuationError("Une entrée en stock ne peut pas porter une valeur négative.");
  return {
    quantity: position.quantity + incomingQuantity,
    value: position.value + incomingValue,
  };
}

export type IssueOutcome = {
  position: StockPosition;
  valueRemoved: bigint;
};

/**
 * A CMP issue.
 *
 * The value removed is the position's own value in proportion to the quantity
 * leaving it, which is the definition of a moving average and is also why an
 * issue that empties the position empties its value with it.
 *
 * `allowNegative` is the company setting from the specification, and it is
 * deliberately not enough on its own: going negative needs an existing cost
 * ratio to extrapolate from. A position that is empty and worth nothing offers
 * no basis, and inventing a cost there would put a number into the accounts
 * that nothing in the dossier supports.
 */
export function applyIssueCmp(
  position: StockPosition,
  outgoingQuantity: bigint,
  options: { allowNegative?: boolean } = {},
): IssueOutcome {
  if (outgoingQuantity <= 0n) throw new StockValuationError("Une sortie de stock doit porter une quantité positive.");
  if (outgoingQuantity > position.quantity) {
    if (!options.allowNegative) throw new StockValuationError("INSUFFICIENT_STOCK");
    if (position.quantity <= 0n || position.value === 0n) {
      throw new StockValuationError("NO_COST_BASIS");
    }
  }
  const valueRemoved = proportionalShare(position.value, outgoingQuantity, position.quantity);
  return {
    position: {
      quantity: position.quantity - outgoingQuantity,
      value: position.value - valueRemoved,
    },
    valueRemoved,
  };
}

/**
 * Plans a FIFO issue against the open layers, oldest first.
 *
 * The caller supplies the layers already ordered by `(documentDate, sequence)`;
 * this module does not re-sort them, because the ordering rule belongs to the
 * query that also has to agree with the movement register.
 *
 * A layer consumed entirely releases exactly what is left in it — not a
 * recomputed share — so a sequence of partial consumptions followed by a final
 * one cannot leave a centime stranded in an empty layer.
 *
 * FIFO never goes negative: there is no layer to consume, and therefore no cost
 * that could be attributed to the movement without inventing one.
 */
export function planFifoIssue(layers: FifoLayer[], outgoingQuantity: bigint): FifoPlan {
  if (outgoingQuantity <= 0n) throw new StockValuationError("Une sortie de stock doit porter une quantité positive.");
  const consumptions: FifoConsumption[] = [];
  let remaining = outgoingQuantity;
  let totalValue = 0n;

  for (const layer of layers) {
    if (remaining === 0n) break;
    if (layer.quantityRemaining <= 0n) continue;
    const taken = layer.quantityRemaining <= remaining ? layer.quantityRemaining : remaining;
    const exhausted = taken === layer.quantityRemaining;
    const value = exhausted
      ? layer.valueRemaining
      : proportionalShare(layer.valueRemaining, taken, layer.quantityRemaining);
    consumptions.push({ layerId: layer.id, quantity: taken, value, exhausted });
    totalValue += value;
    remaining -= taken;
  }

  if (remaining > 0n) throw new StockValuationError("INSUFFICIENT_STOCK");
  return { consumptions, totalValue };
}

/**
 * What a layer looks like after a consumption is applied to it.
 *
 * Exhausting a layer sets both fields to zero rather than subtracting, so the
 * layer cannot retain a residue that no quantity backs.
 */
export function applyConsumptionToLayer(layer: FifoLayer, consumption: FifoConsumption): FifoLayer {
  if (consumption.exhausted) {
    return { ...layer, quantityRemaining: 0n, valueRemaining: 0n };
  }
  return {
    ...layer,
    quantityRemaining: layer.quantityRemaining - consumption.quantity,
    valueRemaining: layer.valueRemaining - consumption.value,
  };
}

/**
 * Returns a consumption to the layer it came from, for a reversal.
 *
 * The exact quantity and the exact value go back where they were taken from,
 * which is the whole reason consumption records are written: an average
 * computed at reversal time would be a different number, and the difference
 * would land in the accounts with nothing to explain it.
 */
export function restoreConsumptionToLayer(layer: FifoLayer, consumption: FifoConsumption): FifoLayer {
  return {
    ...layer,
    quantityRemaining: layer.quantityRemaining + consumption.quantity,
    valueRemaining: layer.valueRemaining + consumption.value,
  };
}
