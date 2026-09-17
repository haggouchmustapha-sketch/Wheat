/**
 * Exact arithmetic for stock quantities and stock value.
 *
 * Wheat's accounting amounts are exact integer centimes and never floating
 * point. Stock needs the same guarantee at a finer resolution: a quantity of
 * 0,333333 tonne is a real quantity, and a unit cost of 333,333333 DH is a real
 * cost, so rounding either one to two decimals before the value reaches an
 * accounting line quietly manufactures the discrepancy this module exists to
 * prevent.
 *
 * Three scales, and they never mix implicitly:
 *
 *  - `QTY_SCALE` (1e6) — quantities, six decimals.
 *  - `MONEY_SCALE` (1e6) — stock value, micro-dirham. Internal to stock.
 *  - `CENT_SCALE` (1e2) — centimes, what `EntryLine` already stores.
 *
 * Stock value is carried at micro-dirham precision for the whole of its life
 * inside the stock module and is converted to centimes exactly once, at the
 * boundary where a movement becomes an accounting line (`moneyMicroToCents`).
 * Rounding on the way in, or repeatedly on the way through, is what turns
 * "quantity is zero" into "quantity is zero but value is 0,01".
 *
 * ## The invariant the whole module serves
 *
 * A stock position is `(quantity, value)` — never `(quantity, rounded unit
 * cost)`. Unit cost is derived for display. `proportionalShare` is the single
 * place a value is split, and when a caller asks for the whole of a position it
 * returns the whole of it rather than a rounded reconstruction, so a position
 * that reaches quantity zero reaches value zero exactly.
 */

/** Quantities carry six decimals. */
export const QTY_SCALE = 1_000_000n;
/** Stock value is carried in micro-dirham. */
export const MONEY_SCALE = 1_000_000n;
/** Centimes, the scale `EntryLine.debitCents` already uses. */
export const CENT_SCALE = 100n;

const QTY_DECIMALS = 6;
const MONEY_DECIMALS = 6;

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

/**
 * Refuses a value SQLite cannot store in a signed 64-bit column.
 *
 * BigInt arithmetic is unbounded, so an overflow never announces itself as an
 * exception: it announces itself months later as a balance Prisma could not
 * read back. Every value that is about to be persisted passes through here.
 */
export function assertStoredRange(value: bigint, label: string): bigint {
  if (value > INT64_MAX || value < INT64_MIN) {
    throw new Error(`${label} dépasse la capacité de stockage de Wheat.`);
  }
  return value;
}

function parseFixedDecimal(value: unknown, decimals: number, label: string): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") {
    throw new Error(`${label} doit être transmis comme nombre décimal, pas comme valeur déjà mise à l'échelle.`);
  }
  let text: string;
  if (typeof value === "number") {
    // A non-integer JavaScript number has already lost the exactness this
    // module promises, so it is refused rather than silently accepted.
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} doit être transmis sous forme de texte décimal exact.`);
    }
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    throw new Error(`${label} est invalide.`);
  }

  const compact = text.trim().replace(/\s/g, "").replace(/MAD|DH/gi, "");
  if (!compact) return 0n;
  const decimalSeparator = compact.includes(",") && compact.lastIndexOf(",") > compact.lastIndexOf(".") ? "," : ".";
  const normalized = decimalSeparator === ","
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`${label} est invalide.`);
  const [wholeWithSign, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${label} ne peut pas comporter plus de ${decimals} décimales.`);
  }
  const negative = wholeWithSign.startsWith("-");
  const digits = wholeWithSign.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  const scaled = BigInt(`${digits}${fraction.padEnd(decimals, "0")}`) * (negative ? -1n : 1n);
  return assertStoredRange(scaled, label);
}

function formatFixedDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = String(absolute % scale).padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Reads a user-entered quantity ("12,5", "0.333333") as scaled units. */
export function qtyFromDecimal(value: unknown, label = "La quantité"): bigint {
  return parseFixedDecimal(value, QTY_DECIMALS, label);
}

/** Renders a scaled quantity as an exact decimal string for display and IPC. */
export function qtyToDisplay(value: bigint): string {
  return formatFixedDecimal(value, QTY_DECIMALS);
}

/** Reads a user-entered amount in dirham as micro-dirham. */
export function moneyFromDecimal(value: unknown, label = "Le montant"): bigint {
  return parseFixedDecimal(value, MONEY_DECIMALS, label);
}

/** Renders micro-dirham as an exact decimal string for display and IPC. */
export function moneyToDisplay(value: bigint): string {
  return formatFixedDecimal(value, MONEY_DECIMALS);
}

/** Reads an exact centime amount coming from Wheat's accounting side. */
export function moneyFromCents(cents: bigint): bigint {
  return assertStoredRange(cents * (MONEY_SCALE / CENT_SCALE), "Le montant");
}

/**
 * The one conversion from stock value to accounting value.
 *
 * Half-up away from zero, applied once, at the boundary where a stock movement
 * becomes an `EntryLine`. Callers that round earlier — to show a unit cost, to
 * make a subtotal look tidy — must not feed the rounded figure back into stock.
 */
export function moneyMicroToCents(value: bigint, label = "Le montant"): bigint {
  const divisor = MONEY_SCALE / CENT_SCALE;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return assertStoredRange(negative ? -rounded : rounded, label);
}

/**
 * `value × multiplier / divisor`, rounded half-up away from zero.
 *
 * The product is formed before the division so no intermediate rounding
 * happens, which is what makes the result independent of the order the caller
 * happened to write the operands in.
 */
export function mulDivHalfUp(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new Error("Division par zéro dans le calcul de valorisation.");
  const product = value * multiplier;
  const negative = (product < 0n) !== (divisor < 0n);
  const absoluteProduct = product < 0n ? -product : product;
  const absoluteDivisor = divisor < 0n ? -divisor : divisor;
  const quotient = absoluteProduct / absoluteDivisor;
  const remainder = absoluteProduct % absoluteDivisor;
  const rounded = remainder * 2n >= absoluteDivisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * The share of `positionValue` that leaves with `quantityTaken`.
 *
 * Taking the whole position returns the whole value rather than a computed
 * approximation of it. The general formula already gives that answer exactly,
 * but stating it explicitly means the guarantee survives any future change to
 * how the remainder is rounded: when quantity reaches zero, value reaches zero.
 */
export function proportionalShare(positionValue: bigint, quantityTaken: bigint, positionQuantity: bigint): bigint {
  if (positionQuantity === 0n) {
    if (quantityTaken === 0n) return 0n;
    throw new Error("Une position sans quantité ne peut pas fournir de valeur.");
  }
  if (quantityTaken === positionQuantity) return positionValue;
  return mulDivHalfUp(positionValue, quantityTaken, positionQuantity);
}

/**
 * The derived unit cost of a position, for display only.
 *
 * Never fed back into a position: `(quantity, value)` is authoritative and
 * `roundedUnitCost × quantity` is the reconstruction that drifts.
 */
export function derivedUnitCost(value: bigint, quantity: bigint): bigint | null {
  if (quantity === 0n) return null;
  return mulDivHalfUp(value, QTY_SCALE, quantity);
}

/**
 * Multiplies a quantity by a unit price, both scaled, giving scaled value.
 *
 * Used where a user enters "10 units at 120,50": the quantity carries
 * `QTY_SCALE` and the price `MONEY_SCALE`, so the product carries both and one
 * of them has to come back out.
 */
export function valueFromUnitPrice(quantity: bigint, unitPrice: bigint): bigint {
  return mulDivHalfUp(quantity, unitPrice, QTY_SCALE);
}

/**
 * Splits `total` across `weights` so the parts sum to `total` exactly.
 *
 * Every allocation in stock — landed costs over lines, a charge over
 * quantities — is this operation. Each part is rounded half-up on its own and
 * the accumulated rounding difference is applied to the last part with a
 * non-zero weight, so "the pieces sum to the charge" is arithmetic rather than
 * a hope. A total spread over weights that are all zero is refused: there is no
 * defensible answer, and silently dropping the charge loses money.
 */
export function allocateProportionally(total: bigint, weights: bigint[]): bigint[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new Error("Une répartition sans base de répartition est impossible.");
  }
  const parts = weights.map((weight) => mulDivHalfUp(total, weight, totalWeight));
  const allocated = parts.reduce((sum, part) => sum + part, 0n);
  const difference = total - allocated;
  if (difference !== 0n) {
    let lastIndex = -1;
    for (let index = weights.length - 1; index >= 0; index -= 1) {
      if (weights[index] !== 0n) { lastIndex = index; break; }
    }
    if (lastIndex < 0) throw new Error("Une répartition sans base de répartition est impossible.");
    parts[lastIndex] += difference;
  }
  return parts;
}
