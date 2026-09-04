import { randomUUID } from "node:crypto";

export const ENTRY_STATUS = {
  draft: "DRAFT",
  posted: "POSTED",
  reversed: "REVERSED",
} as const;

const CENT_FIELD_TO_MAD_FIELD: Record<string, string> = {
  debitCents: "debit",
  creditCents: "credit",
  htCents: "ht",
  vatCents: "vat",
  ttcCents: "ttc",
  balanceCents: "balance",
  amountCents: "amount",
  collectedVatCents: "collectedVat",
  deductibleVatCents: "deductibleVat",
  dueVatCents: "dueVat",
  creditVatCents: "creditVat",
  grossSalaryCents: "grossSalary",
  cnssEmployeeCents: "cnssEmployee",
  amoEmployeeCents: "amoEmployee",
  irCents: "ir",
  netSalaryCents: "netSalary",
};

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} est obligatoire.`);
  }
  if (value.length > 200) {
    throw new Error(`${label} est invalide.`);
  }
  return value.trim();
}

export function requireText(value: unknown, label: string, maxLength = 250): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} est obligatoire.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${label} ne doit pas dépasser ${maxLength} caractères.`);
  }
  return text;
}

export function optionalText(value: unknown, maxLength = 250): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("La valeur de texte est invalide.");
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`Le texte ne doit pas dépasser ${maxLength} caractères.`);
  return text || null;
}

export function parseAccountingDate(value: unknown, label = "La date"): Date {
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new Error(`${label} est obligatoire.`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} est invalide.`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function parseIsoDay(value: unknown, label: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} doit être au format AAAA-MM-JJ.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} est invalide.`);
  }
  return date;
}

export function parsePayrollPeriod(value: unknown): { period: string; endDate: Date } {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("La période de paie doit être au format AAAA-MM.");
  }
  const [year, month] = value.split("-").map(Number);
  return { period: value, endDate: new Date(Date.UTC(year, month, 0)) };
}

export function currentPayrollPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseMadString(value: string, label: string): bigint {
  const compact = value.trim().replace(/\s/g, "").replace(/MAD/gi, "");
  if (!compact) return 0n;
  const decimalSeparator = compact.includes(",") && compact.lastIndexOf(",") > compact.lastIndexOf(".") ? "," : ".";
  const normalized = decimalSeparator === "," ? compact.replace(/\./g, "").replace(",", ".") : compact.replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`${label} est invalide.`);
  const [wholeWithSign, fraction = ""] = normalized.split(".");
  if (fraction.length > 2) throw new Error(`${label} ne peut pas contenir plus de deux décimales.`);
  const negative = wholeWithSign.startsWith("-");
  const digits = wholeWithSign.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  const cents = BigInt(`${digits}${fraction.padEnd(2, "0")}`) * (negative ? -1n : 1n);
  if (cents < -(2n ** 63n) || cents > 2n ** 63n - 1n) throw new Error(`${label} est hors limites.`);
  return cents;
}

export function madToCents(value: unknown, label = "Le montant"): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return parseMadString(value, label);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} est invalide.`);
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error(`${label} est trop grand pour être transmis comme nombre ; utilisez une valeur décimale sous forme de texte.`);
  }
  return parseMadString(String(value), label);
}

export function centsToMad(value: bigint): number | string {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value) / 100;
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function formatCentsAsMad(value: bigint): string {
  return String(centsToMad(value));
}

export function provisionalEntryNumber(): string {
  return `BROUILLON-${randomUUID()}`;
}

export function rendererSerialize<T>(value: T): T {
  return convertObjectToMad(value) as T;
}

function convertObjectToMad(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(convertObjectToMad);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const madField = CENT_FIELD_TO_MAD_FIELD[key];
    if (madField && typeof child === "bigint") {
      // Keep the canonical integer-cent field for exact 1.2 workflows. The
      // decimal MAD alias remains for compatibility with the 1.1 renderer.
      result[key] = child.toString();
      result[madField] = centsToMad(child);
      continue;
    }
    if (typeof child === "bigint") {
      result[key] = child.toString();
      continue;
    }
    if (child instanceof Date) {
      result[key] = child.toISOString();
      continue;
    }
    result[key] = convertObjectToMad(child);
  }
  return result;
}
