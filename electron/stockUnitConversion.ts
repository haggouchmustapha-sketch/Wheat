/**
 * Commercial units, and the exact arithmetic that resolves them to stock.
 *
 * An article is counted in exactly one unit — its base unit — and the register
 * only ever holds that. A user who buys by the carton and sells by the unit is
 * describing the same goods twice, so the module lets a document line state its
 * own unit and converts it once, at the point the line is written, into the
 * quantity the register will move.
 *
 * ## What is and is not automatic
 *
 * Nothing. A conversion exists only because somebody configured it: `1 carton =
 * 12 unité` is a fact about a dossier's packaging, not about the words "carton"
 * and "unité", and a module that assumed a kilogram is a thousand grams for a
 * dossier that never said so would be inventing quantities. The only factor
 * this file knows without being told is the one from a unit to itself.
 *
 * ## Exactness
 *
 * A factor is scaled by `QTY_SCALE`, like every other quantity, so `1 carton =
 * 12 unité` is stored as 12 000 000 and never as a float that might be
 * 11,999999. A chain is resolved as a rational — the product of the factors
 * followed on the way, over the product of those followed backwards — and only
 * divided at the end, once, against the quantity itself. If that division
 * leaves a remainder the conversion is **refused**, naming the quantity that
 * would not survive it. Rounding here would put a quantity into the register
 * that the user never entered, and repeated rounding is exactly the drift the
 * whole module is built to avoid.
 *
 * ## Configuration that cannot be resolved
 *
 * A factor of zero or less has no meaning and is refused. A conversion from a
 * unit to itself is refused unless it is the identity. A conversion that would
 * close a cycle whose factors disagree — `1 A = 2 B`, `1 B = 2 C`, `1 C = 2 A`
 * — is refused when it is saved, because the graph would then answer the same
 * question with two different numbers depending on which way it was walked.
 */

import { QTY_SCALE, assertStoredRange, mulDivHalfUp, qtyToDisplay } from "./stockUnits";

export class StockUnitConversionError extends Error {}

/** One configured edge: `1 fromUnitId = factor toUnitId`, factor scaled 1e6. */
export type UnitConversionEdge = {
  fromUnitId: string;
  toUnitId: string;
  factor: bigint;
};

/**
 * The exact factor between two units, as a fraction of scaled factors.
 *
 * `1 from = numerator / denominator × to`, both sides already carrying
 * `QTY_SCALE` where the path used a forward edge and its inverse where it used
 * a backward one. Kept as a fraction until the very last multiplication so no
 * intermediate step rounds.
 */
export type UnitConversionPath = {
  numerator: bigint;
  denominator: bigint;
  /** The units walked through, from source to target, for the error messages. */
  route: string[];
};

export const IDENTITY_FACTOR = QTY_SCALE;

export function requireConversionFactor(value: bigint, label = "Le facteur de conversion"): bigint {
  if (value <= 0n) throw new StockUnitConversionError(`${label} doit être strictement positif.`);
  return assertStoredRange(value, label);
}

/**
 * Finds the exact factor from one unit to another, walking configured edges.
 *
 * Breadth-first, so the shortest chain wins and the route named in an error is
 * the one a person would have drawn themselves. Edges are followed in both
 * directions: configuring `1 carton = 12 unité` also states what a unité is
 * worth in cartons, and requiring the accountant to enter the same fact twice
 * would be two rows that can disagree.
 *
 * Returns `null` when no chain connects the two units, which the caller turns
 * into a message naming both — an unconfigured pair is a normal state, not a
 * failure of this function.
 */
export function findConversionPath(
  edges: readonly UnitConversionEdge[],
  fromUnitId: string,
  toUnitId: string,
): UnitConversionPath | null {
  if (fromUnitId === toUnitId) return { numerator: IDENTITY_FACTOR, denominator: IDENTITY_FACTOR, route: [fromUnitId] };

  const neighbours = new Map<string, Array<{ unitId: string; numerator: bigint; denominator: bigint }>>();
  const link = (a: string, b: string, numerator: bigint, denominator: bigint) => {
    const held = neighbours.get(a) ?? [];
    held.push({ unitId: b, numerator, denominator });
    neighbours.set(a, held);
  };
  for (const edge of edges) {
    requireConversionFactor(edge.factor);
    // Forward: 1 from = factor/QTY_SCALE × to. Backward: the reciprocal.
    link(edge.fromUnitId, edge.toUnitId, edge.factor, QTY_SCALE);
    link(edge.toUnitId, edge.fromUnitId, QTY_SCALE, edge.factor);
  }

  const seen = new Set<string>([fromUnitId]);
  const queue: Array<{ unitId: string; numerator: bigint; denominator: bigint; route: string[] }> = [
    { unitId: fromUnitId, numerator: IDENTITY_FACTOR, denominator: IDENTITY_FACTOR, route: [fromUnitId] },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of neighbours.get(current.unitId) ?? []) {
      if (seen.has(step.unitId)) continue;
      seen.add(step.unitId);
      const next = {
        unitId: step.unitId,
        numerator: current.numerator * step.numerator,
        denominator: current.denominator * step.denominator,
        route: [...current.route, step.unitId],
      };
      if (step.unitId === toUnitId) {
        return { numerator: next.numerator, denominator: next.denominator, route: next.route };
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * The single factor a document line freezes: `1 enteredUnit = factor baseUnit`.
 *
 * Stored on the line so that changing the conversion afterwards changes what
 * new lines resolve to and leaves every movement already written alone. A chain
 * whose combined factor is not itself expressible at `QTY_SCALE` is refused
 * here rather than silently rounded, because the line would then carry a factor
 * that does not reproduce the quantity it was used to compute.
 */
export function resolveUnitFactor(
  edges: readonly UnitConversionEdge[],
  enteredUnitId: string,
  baseUnitId: string,
  describe: (unitId: string) => string,
): bigint {
  const path = findConversionPath(edges, enteredUnitId, baseUnitId);
  if (!path) {
    throw new StockUnitConversionError(
      `Aucune conversion n'est paramétrée entre « ${describe(enteredUnitId)} » et l'unité de stock « ${describe(baseUnitId)} ».\n`
      + "Renseignez-la dans les unités du stock, ou saisissez la ligne dans l'unité de stock de l'article.",
    );
  }
  const scaled = path.numerator * QTY_SCALE;
  if (scaled % path.denominator !== 0n) {
    throw new StockUnitConversionError(
      `La conversion ${path.route.map(describe).join(" → ")} ne tombe pas juste à six décimales.\n`
      + "Wheat n'arrondit pas une quantité de stock : ajustez le paramétrage des unités ou saisissez la ligne dans l'unité de stock de l'article.",
    );
  }
  return assertStoredRange(scaled / path.denominator, "Le facteur de conversion");
}

/**
 * Applies a frozen factor to a quantity, exactly.
 *
 * `quantity × factor / QTY_SCALE`, refused rather than rounded when it does not
 * divide. The message names the quantity and the unit, because the correction —
 * enter 12 unités rather than 1, or 0,5 carton rather than 6 unités — is one the
 * person entering the line can make immediately.
 */
export function convertQuantity(quantity: bigint, factor: bigint, label = "La quantité"): bigint {
  requireConversionFactor(factor);
  const product = quantity * factor;
  if (product % QTY_SCALE !== 0n) {
    const exact = mulDivHalfUp(quantity, factor, QTY_SCALE);
    throw new StockUnitConversionError(
      `${label} ne se convertit pas exactement dans l'unité de stock de l'article `
      + `(${qtyToDisplay(quantity)} donnerait ${qtyToDisplay(exact)} après arrondi).\n`
      + "Wheat refuse d'arrondir une quantité de stock : saisissez une quantité que la conversion convertit exactement.",
    );
  }
  return assertStoredRange(product / QTY_SCALE, label);
}

/**
 * Checks a conversion before it is saved.
 *
 * Two configurations are refused. A unit converted to itself by anything other
 * than 1 is a contradiction on its face. A conversion that closes a cycle whose
 * factors disagree is a graph that answers "how many unités in a palette" with
 * two different numbers depending on the route taken — so the new edge is
 * compared against whatever the existing graph already implies, and refused
 * when they differ.
 *
 * `existing` must already exclude the row being edited, so re-saving a
 * conversion with the same factor is not refused for contradicting itself.
 */
export function assertConversionIsConsistent(
  existing: readonly UnitConversionEdge[],
  candidate: UnitConversionEdge,
  describe: (unitId: string) => string,
): void {
  requireConversionFactor(candidate.factor);
  if (candidate.fromUnitId === candidate.toUnitId) {
    if (candidate.factor !== IDENTITY_FACTOR) {
      throw new StockUnitConversionError(`Une unité ne peut pas valoir ${qtyToDisplay(candidate.factor)} fois elle-même.`);
    }
    return;
  }
  const implied = findConversionPath(existing, candidate.fromUnitId, candidate.toUnitId);
  if (!implied) return;
  // `candidate.factor / QTY_SCALE` against `implied.numerator / implied.denominator`,
  // cross-multiplied so the comparison itself never divides.
  if (candidate.factor * implied.denominator !== implied.numerator * QTY_SCALE) {
    throw new StockUnitConversionError(
      `Ce paramétrage contredit les conversions déjà enregistrées : ${implied.route.map(describe).join(" → ")} `
      + `donne déjà un autre rapport entre « ${describe(candidate.fromUnitId)} » et « ${describe(candidate.toUnitId)} ».\n`
      + "Corrigez d'abord la conversion existante ; Wheat refuse un graphe qui répond deux nombres différents à la même question.",
    );
  }
}
