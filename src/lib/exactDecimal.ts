export function parseExactDecimalCents(value: unknown, label = "Le montant"): bigint {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return 0n;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${label} doit être un montant positif avec au plus deux décimales.`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export function tryParseExactDecimalCents(value: unknown): bigint | null {
  try {
    return parseExactDecimalCents(value);
  } catch {
    return null;
  }
}

export function exactDecimalFromCents(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

export function formatExactCentsForUi(value: bigint, currency = "MAD"): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const groupedWhole = String(magnitude / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "-" : ""}${groupedWhole},${String(magnitude % 100n).padStart(2, "0")} ${currency}`;
}
