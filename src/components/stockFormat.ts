/**
 * The pieces every Stock screen shares.
 *
 * Numbers arrive from the main process as exact decimal strings (`display`)
 * beside their scaled integer (`raw`). Everything here formats the *string*.
 * Parsing one into a JavaScript number would reintroduce, at the last possible
 * moment, exactly the error the whole module is built to avoid — so no function
 * in this file calls `Number()` on a value, and none of them rounds: what they
 * receive is what the register holds.
 *
 * Extracted from `StockWorkspace.tsx` when the inventory, impairment, import and
 * report panels needed the same formatting. A second copy would be a second way
 * for a quantity to be displayed, and two screens showing the same position
 * differently is the bug this module exists to make impossible.
 *
 * Plain `.ts`: these are functions, and keeping them out of a file that exports
 * components is what lets Fast Refresh keep working for the screens that use
 * them.
 */

export type Money = { raw: string; display: string } | null | undefined;

/**
 * Formats an exact decimal string for a Moroccan French reader.
 *
 * Splits the string rather than converting it: trailing zeroes beyond the
 * meaningful decimals are dropped for quantities, and thousands are grouped
 * with a space.
 */
export function formatDecimal(value: Money, options: { decimals?: number; trim?: boolean } = {}): string {
  if (!value) return "—";
  const text = value.display;
  const negative = text.startsWith("-");
  const [wholeRaw, fractionRaw = ""] = (negative ? text.slice(1) : text).split(".");
  const decimals = options.decimals ?? 2;
  let fraction = fractionRaw.slice(0, decimals).padEnd(decimals, "0");
  if (options.trim) fraction = fraction.replace(/0+$/, "");
  const whole = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "-" : ""}${whole}${fraction ? `,${fraction}` : ""}`;
}

export const formatQuantity = (value: Money) => formatDecimal(value, { decimals: 6, trim: true });
export const formatValue = (value: Money) => formatDecimal(value, { decimals: 2 });

/** A signed quantity, for a column where the direction is the point. */
export const formatSignedQuantity = (value: Money) => {
  if (!value) return "—";
  const text = formatQuantity(value);
  return text.startsWith("-") ? text : `+${text}`;
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-MA", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });
}

/** True when an exact decimal string means zero, without parsing it. */
export function isZero(value: Money): boolean {
  if (!value) return true;
  return /^-?0*(\.0*)?$/.test(value.display);
}

export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  // Electron prefixes an IPC rejection with the channel; the user needs the
  // sentence the domain wrote, not the plumbing in front of it.
  return text.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
}

/**
 * Downloads what is on screen as CSV.
 *
 * Writes the exact decimal the register holds rather than the grouped display
 * string, because a spreadsheet that receives "1 650,00" with a space in it
 * reads it as text. The byte-order mark is what stops Excel from rendering
 * every accented désignation as mojibake.
 */
export function downloadCsv(fileName: string, header: string[], rows: string[][]) {
  const escape = (value: string) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map((line) => line.map(escape).join(";")).join("\r\n");
  const byteOrderMark = String.fromCharCode(0xfeff);
  const blob = new Blob([byteOrderMark + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
