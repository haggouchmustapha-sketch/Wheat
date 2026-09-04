import { createHash } from "node:crypto";
import { STORED_SCHEMA_VERSIONS } from "./legacyDomainValues";
import { createReadStream } from "node:fs";
import { appendActivityAndAudit } from "./audit13";
import { findEmbeddedDates, inferUniqueYear, normalizeFlexibleDate } from "./dateNormalization21";

const MAX_I64 = (2n ** 63n) - 1n;
const MIN_I64 = -(2n ** 63n);
const MAX_CONFIRM_ITEMS = 100;
const MAX_IMPORT_ROWS = 2_000;
const ACTIVE_RECONCILIATION = "ACTIVE";

export const RECONCILIATION_IPC_CHANNELS = {
  workspace: "wheat:bank:reconciliation:workspace",
  candidates: "wheat:bank:reconciliation:candidates",
  confirm: "wheat:bank:reconciliation:confirm",
  void: "wheat:bank:reconciliation:void",
  excludeMovement: "wheat:bank:movement:exclude",
  restoreMovement: "wheat:bank:movement:restore",
  reviewStatement: "wheat:bank:statement:review",
  importStatement: "wheat:bank:statement:import",
} as const;

export const RECONCILIATION_STATE = {
  unreconciled: "UNRECONCILED",
  partial: "PARTIAL",
  reconciled: "RECONCILED",
  excluded: "EXCLUDED",
  reviewRequired: "REVIEW_REQUIRED",
} as const;

export type ReconciliationState = typeof RECONCILIATION_STATE[keyof typeof RECONCILIATION_STATE];

export interface StatementColumnMapping {
  date: string;
  valueDate?: string;
  label: string;
  reference?: string;
  externalId?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  currency?: string;
}

export interface NormalizedStatementMovement {
  statementRow: number;
  date: Date;
  valueDate: Date | null;
  operationDateRaw: string;
  valueDateRaw: string | null;
  dateInferred: boolean;
  rowClass: "TRANSACTION";
  raw: Record<string, unknown>;
  label: string;
  reference: string;
  externalId: string | null;
  amountCents: bigint;
  fingerprint: string;
}

export interface ConfirmReconciliationInput {
  movementId: string;
  expectedRevision: number;
  allocations: Array<{ entryLineId: string; amountCents: string }>;
  paymentEvidence?: Array<{ paymentId: string; amountCents: string }>;
  note?: string;
  actorUserId?: string;
}

export interface VoidReconciliationInput {
  reconciliationId: string;
  expectedRevision: number;
  reason: string;
  actorUserId?: string;
}

export interface ExcludeMovementInput {
  movementId: string;
  expectedRevision: number;
  reason: string;
  actorUserId?: string;
}

export interface RestoreMovementInput {
  movementId: string;
  expectedRevision: number;
  actorUserId?: string;
}

export interface ImportStatementInput {
  bankAccountId: string;
  sourceName: string;
  sourceStoredPath?: string;
  sourceSha256: string;
  rows: Array<Record<string, unknown>>;
  mapping: StatementColumnMapping;
  sourceFormat?: string;
  sourceCurrency?: string | null;
  openingBalanceCents?: string | null;
  closingBalanceCents?: string | null;
  allowSuspectedDuplicates?: boolean;
  actorUserId?: string;
}

export interface ReviewStatementInput {
  bankAccountId: string;
  sourceSha256: string;
  rows: Array<Record<string, unknown>>;
  mapping: StatementColumnMapping;
  sourceCurrency?: string | null;
}

export interface ReconciliationServiceOptions {
  now?: () => Date;
  audit?: (event: {
    companyId: string;
    actorUserId: string | null;
    action: string;
    entity: string;
    entityId: string;
    description: string;
    details: Record<string, unknown>;
  }, tx: any) => Promise<void> | void;
}

type RegisterableIpc = {
  handle(channel: string, listener: (event: unknown, payload?: any) => any): unknown;
};

export interface ReconciliationIpcRegistrationOptions extends ReconciliationServiceOptions {
  ipcMain: RegisterableIpc;
  getPrisma: () => DbLike | Promise<DbLike>;
  serialize?: (value: any) => any;
  getActorUserId?: () => string | null | Promise<string | null>;
}

type DbLike = any;

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${label} is required and must be a valid identifier.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} is too long (maximum ${maxLength} characters).`);
  return normalized || null;
}

function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("The expected movement revision must be a non-negative safe integer.");
  }
  return Number(value);
}

/** Parse an IPC cent value without ever passing through an IEEE-754 number. */
export function parseExactCents(value: unknown, label = "Amount", options: { positive?: boolean; nonZero?: boolean } = {}): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be an exact integer-cent string.`);
  }
  const cents = BigInt(value);
  if (cents < MIN_I64 || cents > MAX_I64) throw new Error(`${label} is outside the supported 64-bit range.`);
  if (options.positive && cents <= 0n) throw new Error(`${label} must be a positive integer-cent string.`);
  if (options.nonZero && cents === 0n) throw new Error(`${label} must not be zero.`);
  return cents;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sameSign(left: bigint, right: bigint): boolean {
  return (left > 0n && right > 0n) || (left < 0n && right < 0n);
}

function stateInternal(input: {
  amountCents: bigint;
  allocatedCents: bigint;
  excludedAt?: Date | string | null;
  legacyMatchClaimed?: boolean;
}): { status: ReconciliationState; magnitude: bigint; allocated: bigint; remaining: bigint } {
  const movementMagnitude = magnitude(input.amountCents);
  const allocated = input.allocatedCents < 0n ? 0n : input.allocatedCents;
  const remaining = allocated >= movementMagnitude ? 0n : movementMagnitude - allocated;
  let status: ReconciliationState = RECONCILIATION_STATE.unreconciled;
  if (input.excludedAt) status = RECONCILIATION_STATE.excluded;
  else if (movementMagnitude > 0n && allocated === movementMagnitude) status = RECONCILIATION_STATE.reconciled;
  else if (allocated > 0n) status = RECONCILIATION_STATE.partial;
  else if (input.legacyMatchClaimed) status = RECONCILIATION_STATE.reviewRequired;
  return { status, magnitude: movementMagnitude, allocated, remaining };
}

export function deriveReconciliationState(input: {
  amountCents: bigint;
  allocatedCents: bigint;
  excludedAt?: Date | string | null;
  legacyMatchClaimed?: boolean;
}): {
  status: ReconciliationState;
  movementMagnitudeCents: string;
  allocatedCents: string;
  remainingCents: string;
} {
  const result = stateInternal(input);
  return {
    status: result.status,
    movementMagnitudeCents: result.magnitude.toString(),
    allocatedCents: result.allocated.toString(),
    remainingCents: result.remaining.toString(),
  };
}

function activeAllocatedCents(movement: any): bigint {
  return (movement.reconciliations ?? [])
    .filter((reconciliation: any) => reconciliation.status === ACTIVE_RECONCILIATION)
    .flatMap((reconciliation: any) => reconciliation.allocations ?? [])
    .reduce((sum: bigint, allocation: any) => sum + BigInt(allocation.amountCents), 0n);
}

function transport(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(transport);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transport(child)]));
}

function movementView(movement: any): any {
  const allocated = activeAllocatedCents(movement);
  return {
    ...transport(movement),
    reconciliation: deriveReconciliationState({
      amountCents: BigInt(movement.amountCents),
      allocatedCents: allocated,
      excludedAt: movement.excludedAt,
      legacyMatchClaimed: movement.legacyMatchClaimed,
    }),
  };
}

function normalizedFingerprintText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("fr");
}

export function statementBytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function statementFileSha256(filePath: string): Promise<string> {
  const sourcePath = requiredId(filePath, "Statement file path");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(sourcePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export function bankMovementFingerprint(input: {
  bankAccountId: string;
  date: Date | string;
  amountCents: bigint | string;
  label: string;
  reference?: string | null;
  externalId?: string | null;
}): string {
  const bankAccountId = requiredId(input.bankAccountId, "Bank account");
  const date = input.date instanceof Date ? input.date : new Date(input.date);
  if (Number.isNaN(date.getTime())) throw new Error("Movement date is invalid.");
  const cents = typeof input.amountCents === "bigint"
    ? input.amountCents
    : parseExactCents(input.amountCents, "Movement amount", { nonZero: true });
  const canonical = [
    "wheat-bank-fingerprint-v1",
    bankAccountId,
    date.toISOString().slice(0, 10),
    cents.toString(),
    normalizedFingerprintText(input.externalId),
    normalizedFingerprintText(input.reference),
    normalizedFingerprintText(input.label),
  ].join("\u001f");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizedHeader(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isBalanceHeader(value: string): boolean {
  const header = normalizedHeader(value);
  return header.includes("solde")
    || header.includes("balance")
    || header.includes("availableamount")
    || header.includes("montantdisponible")
    || header.includes("encours");
}

export function assertStatementAmountMapping(mapping: StatementColumnMapping): void {
  if (!mapping || typeof mapping !== "object") throw new Error("A statement column mapping is required.");
  requiredId(mapping.date, "Date column");
  requiredId(mapping.label, "Label column");
  const amountColumns = [mapping.amount, mapping.debit, mapping.credit].filter((value): value is string => Boolean(value));
  if (mapping.amount && (mapping.debit || mapping.credit)) {
    throw new Error("Map either one signed amount column or debit/credit columns, not both.");
  }
  if (!mapping.amount && !mapping.debit && !mapping.credit) {
    throw new Error("Map a signed amount column or at least one debit/credit column.");
  }
  for (const column of amountColumns) {
    if (isBalanceHeader(column)) {
      throw new Error(`The balance column '${column}' cannot be used as a movement amount.`);
    }
  }
}

/** Parse a statement money cell exactly; callers must pass the source cell text, never a JS number. */
export function parseStatementMoney(value: unknown, label = "Statement amount", allowNegative = true): bigint {
  if (typeof value !== "string") throw new Error(`${label} must be imported as text to preserve every cent exactly.`);
  let compact = value.trim().replace(/[\u00a0\u202f\s']/g, "").replace(/(?:MAD|DHS?|DH)$/i, "");
  if (!compact) return 0n;
  let parenthesizedNegative = false;
  if (/^\(.*\)$/.test(compact)) {
    parenthesizedNegative = true;
    compact = compact.slice(1, -1);
  }
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let separator = "";
  if (lastComma >= 0 || lastDot >= 0) {
    const candidate = lastComma > lastDot ? "," : ".";
    const fractionLength = compact.length - Math.max(lastComma, lastDot) - 1;
    if (fractionLength > 0 && fractionLength <= 2) separator = candidate;
  }
  if (separator) {
    const thousands = separator === "," ? /\./g : /,/g;
    compact = compact.replace(thousands, "").replace(separator, ".");
  } else {
    compact = compact.replace(/[.,]/g, "");
  }
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(compact)) throw new Error(`${label} is not a valid monetary value.`);
  const explicitNegative = compact.startsWith("-");
  if (parenthesizedNegative && /^[+-]/.test(compact)) throw new Error(`${label} has conflicting signs.`);
  const unsigned = compact.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  let result = BigInt(`${whole}${fraction.padEnd(2, "0")}`);
  if (parenthesizedNegative || explicitNegative) result = -result;
  if (!allowNegative && result < 0n) throw new Error(`${label} cannot be negative.`);
  if (result < MIN_I64 || result > MAX_I64) throw new Error(`${label} is outside the supported 64-bit range.`);
  return result;
}

function statementDate(value: unknown, label: string, year: number | null) {
  try {
    return normalizeFlexibleDate(value, { year });
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Whether a cell holds an amount at all.
 *
 * Deliberately not "is this a valid amount": a cell that is empty or contains
 * no digit carries no money, and that is all this needs to decide. A cell that
 * looks like money but parses badly is a transaction with a problem, which is a
 * different thing from a line that is not a transaction.
 */
/**
 * Whether a cell holds a money amount, as opposed to text that contains digits.
 *
 * The distinction is not pedantic. Every bank prints a block of registration
 * text at the foot of the statement — share capital, RC, ICE, a decree number —
 * and it is full of digits. Treating "any digit" as an amount made that block
 * look like a movement carrying a credit of "ce Benguerir (0814 AiWaIA", which
 * is not a number and is not a transaction.
 *
 * What it accepts stays deliberately loose about separators, because a scan
 * puts stray dots and spaces inside a figure — "8.998.,00", "18 334,42" — and
 * those are still the amount the statement printed. What it refuses is a cell
 * containing anything that is not a digit, a separator or a sign: letters,
 * brackets and words are prose, and prose is never an amount.
 */
export function looksLikeStatementAmount(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const text = value.replace(/\s/g, "").replace(/(?:mad|dh|dhs|eur|usd|€|\$)/gi, "");
  if (!text || !/\d/.test(text)) return false;
  return /^[+-]?[\d.,']+$/.test(text);
}

function carriesAmount(row: Record<string, unknown>, column: string | undefined): boolean {
  if (!column) return false;
  return looksLikeStatementAmount(row[column]);
}

/**
 * What kind of line this is on the statement.
 *
 * The named rules come first, because a balance or a total is recognisable by
 * what it says and does carry an amount. What they never caught is the block of
 * registration text every bank prints at the foot of the page — company form,
 * share capital, RC, IF, ICE — which says nothing a rule was looking for and
 * was therefore read as a transaction, then rejected for having no date, then
 * reported as a failure that blocked the statement.
 *
 * The structural rule that catches it is not about that text. A transaction
 * moves money; a line carrying no amount in any amount column did not move any,
 * whatever it says. That covers footers, legal blocks, addresses, page
 * furniture and blank rows in one rule, without Wheat having to recognise any
 * particular bank's boilerplate — which is the point, since the next statement
 * will be from a different bank.
 *
 * A row that does carry an amount stays a TRANSACTION even when its date is
 * unreadable. That is deliberate: such a row is a real movement Wheat could not
 * fully read, and it has to reach the review as a problem to settle rather than
 * disappear into the metadata pile.
 */
export function classifyStatementRow(
  row: Record<string, unknown>,
  options: { mapping?: Partial<StatementColumnMapping> } = {},
): string {
  const text = Object.values(row).map((value) => String(value ?? "")).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\bsolde\s+(initial|precedent|d[' ]?ouverture)|opening\s+balance/.test(text)) return "OPENING_BALANCE";
  if (/\bsolde\s+(final|nouveau|de\s+cloture)|closing\s+balance/.test(text)) return "CLOSING_BALANCE";
  if (/\btotal\s+(des\s+)?mouvements?\b/.test(text)) return "TOTAL";
  if (/\bsous[- ]?total\b|\bsubtotal\b/.test(text)) return "SUBTOTAL";
  if (/\breport\s+a\s+nouveau\b|\bcarry\s+forward\b/.test(text)) return "CARRY_FORWARD";
  if (/^\s*page\s+\d+/i.test(text)) return "PAGE_NUMBER";

  const mapping = options.mapping;
  if (mapping && (mapping.amount || mapping.debit || mapping.credit)) {
    const moved = carriesAmount(row, mapping.amount) || carriesAmount(row, mapping.debit) || carriesAmount(row, mapping.credit);
    if (!moved) return "FOOTER";
  }
  return "TRANSACTION";
}

/**
 * The year a statement is written in, when its operation dates do not say.
 *
 * Moroccan statements routinely print the operation date as a bare day and
 * month — "25 06" — and state the year once, elsewhere on the same page: in the
 * value-date column, or in the closing-balance line ("SOLDE FINAL AU 30 06
 * 2026"). Wheat used to look for the year only in the operation-date column,
 * which on such a statement is exactly the one place it is never written, so
 * every date failed and the whole import was refused.
 *
 * The sources read here are the ones the statement itself makes authoritative:
 * fully-written dates in either date column, and full dates embedded in the
 * balance and total lines. Transaction descriptions are not read — a cheque
 * number or an amount in prose is not a date, and guessing from one is how a
 * statement acquires a year nobody printed.
 *
 * A statement that names two years returns null rather than choosing. That is
 * the December-to-January case, and no rule here can tell which side of the
 * boundary a bare "03 01" falls on; those rows reach the review as unreadable
 * dates, which is honest, instead of confidently landing in the wrong year.
 */
export function inferStatementYear(
  rows: Array<Record<string, unknown>>,
  mapping: Partial<StatementColumnMapping>,
): number | null {
  const candidates: unknown[] = [];
  for (const row of rows) {
    if (mapping.date) candidates.push(mappedCell(row, mapping.date));
    if (mapping.valueDate) candidates.push(mappedCell(row, mapping.valueDate));
    const rowClass = classifyStatementRow(row, { mapping });
    if (rowClass === "OPENING_BALANCE" || rowClass === "CLOSING_BALANCE" || rowClass === "TOTAL" || rowClass === "CARRY_FORWARD" || rowClass === "HEADER") {
      for (const value of Object.values(row)) candidates.push(...findEmbeddedDates(value));
    }
  }
  return inferUniqueYear(candidates);
}

function mappedCell(row: Record<string, unknown>, column: string | undefined): unknown {
  if (!column) return "";
  return row[column];
}

function statementText(value: unknown, label: string, maxLength: number, required = false): string {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw new Error(`${label} must be imported as text.`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function normalizeStatementRow(input: {
  bankAccountId: string;
  row: Record<string, unknown>;
  mapping: StatementColumnMapping;
  statementRow: number;
  statementYear?: number | null;
}): NormalizedStatementMovement | null {
  const { bankAccountId, row, mapping, statementRow, statementYear = null } = input;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Statement row ${statementRow} is invalid.`);
  const mappedValues = Object.values(mapping).map((column) => mappedCell(row, column));
  if (mappedValues.every((value) => value === null || value === undefined || String(value).trim() === "")) return null;
  if (classifyStatementRow(row, { mapping }) !== "TRANSACTION") return null;
  const normalizedDate = statementDate(mappedCell(row, mapping.date), `Date de la ligne ${statementRow}`, statementYear);
  const valueDateRaw = mappedCell(row, mapping.valueDate);
  // The value date is secondary evidence: it decides interest, never the
  // posting. A movement whose operation date reads perfectly must not be
  // rejected because the scanner mangled the column beside it — the raw text is
  // kept either way, and the row is flagged for review rather than refused.
  let normalizedValueDate: ReturnType<typeof statementDate> | null = null;
  let valueDateUnreadable = false;
  if (!(valueDateRaw === "" || valueDateRaw === null || valueDateRaw === undefined)) {
    try {
      normalizedValueDate = statementDate(valueDateRaw, `Date de valeur de la ligne ${statementRow}`, statementYear);
    } catch {
      valueDateUnreadable = true;
    }
  }
  const label = statementText(mappedCell(row, mapping.label), `Label on statement row ${statementRow}`, 500, true);
  const externalId = statementText(mappedCell(row, mapping.externalId), `External ID on statement row ${statementRow}`, 200) || null;
  const reference = statementText(mappedCell(row, mapping.reference), `Reference on statement row ${statementRow}`, 250)
    || externalId
    || `STATEMENT-${statementRow}`;
  let amountCents: bigint;
  if (mapping.amount) {
    amountCents = parseStatementMoney(mappedCell(row, mapping.amount), `Amount on statement row ${statementRow}`);
  } else {
    const debit = mapping.debit
      ? parseStatementMoney(mappedCell(row, mapping.debit), `Debit on statement row ${statementRow}`, false)
      : 0n;
    const credit = mapping.credit
      ? parseStatementMoney(mappedCell(row, mapping.credit), `Credit on statement row ${statementRow}`, false)
      : 0n;
    if (debit > 0n && credit > 0n) throw new Error(`Statement row ${statementRow} contains both a debit and a credit amount.`);
    amountCents = credit - debit;
  }
  if (amountCents === 0n) throw new Error(`Statement row ${statementRow} has a zero movement amount.`);
  return {
    statementRow,
    date: normalizedDate.date,
    valueDate: normalizedValueDate?.date ?? null,
    operationDateRaw: normalizedDate.raw,
    valueDateRaw: normalizedValueDate?.raw ?? (valueDateUnreadable ? String(valueDateRaw) : null),
    // "Not taken verbatim from the page" — an inferred year, a repaired
    // separator, or a value date that could not be read. Every one of these is
    // a reading a person should confirm, and they surface together in the
    // review's list of rows to look at.
    dateInferred: normalizedDate.inferred
      || normalizedDate.repaired
      || Boolean(normalizedValueDate?.inferred)
      || Boolean(normalizedValueDate?.repaired)
      || valueDateUnreadable,
    rowClass: "TRANSACTION",
    raw: row,
    label,
    reference,
    externalId,
    amountCents,
    fingerprint: bankMovementFingerprint({ bankAccountId, date: normalizedDate.date, amountCents, label, reference, externalId }),
  };
}

export function normalizeStatementRows(input: {
  bankAccountId: string;
  rows: Array<Record<string, unknown>>;
  mapping: StatementColumnMapping;
}): NormalizedStatementMovement[] {
  const bankAccountId = requiredId(input.bankAccountId, "Bank account");
  assertStatementAmountMapping(input.mapping);
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`A statement import must contain between 1 and ${MAX_IMPORT_ROWS} rows.`);
  }
  const movements: NormalizedStatementMovement[] = [];
  const inferredYear = inferStatementYear(input.rows, input.mapping);
  for (let index = 0; index < input.rows.length; index += 1) {
    const movement = normalizeStatementRow({
      bankAccountId,
      row: input.rows[index],
      mapping: input.mapping,
      statementRow: index + 1,
      statementYear: inferredYear,
    });
    if (movement) movements.push(movement);
  }
  if (!movements.length) throw new Error("The statement does not contain any non-empty movement rows.");
  return movements;
}

function allocationInputs<T extends { amountCents: string }>(values: T[] | undefined, idKey: keyof T, label: string): Array<T & { parsedAmountCents: bigint }> {
  const items = values ?? [];
  if (!Array.isArray(items) || items.length > MAX_CONFIRM_ITEMS) throw new Error(`A reconciliation supports at most ${MAX_CONFIRM_ITEMS} ${label}.`);
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${label} ${index + 1} is invalid.`);
    const id = requiredId(item[idKey], `${label} ${index + 1} identifier`);
    if (seen.has(id)) throw new Error(`Duplicate ${label} identifier: ${id}.`);
    seen.add(id);
    return { ...item, [idKey]: id, parsedAmountCents: parseExactCents(item.amountCents, `${label} ${index + 1} amount`, { positive: true }) };
  });
}

function lineNetCents(line: any): bigint {
  const debit = BigInt(line.debitCents);
  const credit = BigInt(line.creditCents);
  if (debit < 0n || credit < 0n || (debit > 0n && credit > 0n)) throw new Error(`Accounting line ${line.id} has an invalid debit/credit shape.`);
  return debit - credit;
}

async function appendAudit(tx: DbLike, options: ReconciliationServiceOptions, event: {
  companyId: string;
  actorUserId?: string;
  action: string;
  entity: string;
  entityId: string;
  description: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const actorUserId = event.actorUserId ? requiredId(event.actorUserId, "Actor user") : null;
  if (options.audit) {
    await options.audit({ ...event, actorUserId }, tx);
    return;
  }
  if (!tx.activityLog?.create || !tx.auditEvent?.create) return;
  await appendActivityAndAudit(tx, {
    companyId: event.companyId,
    actorUserId,
    action: event.action,
    entityType: event.entity,
    entityId: event.entityId,
    description: event.description,
    payload: transport(event.details),
  });
}

function movementInclude(): Record<string, unknown> {
  return {
    bankAccount: { include: { ledgerAccount: true } },
    statement: true,
    reconciliations: {
      orderBy: { confirmedAt: "desc" },
      include: {
        allocations: { include: { entryLine: { include: { entry: true, account: true } } } },
        paymentEvidence: { include: { payment: { include: { counterparty: true } } } },
      },
    },
  };
}

async function findMovement(tx: DbLike, movementId: unknown): Promise<any> {
  const id = requiredId(movementId, "Bank movement");
  const movement = await tx.bankMovement.findUnique({ where: { id }, include: movementInclude() });
  if (!movement) throw new Error("Bank movement not found.");
  return movement;
}

function requireMappedBankAccount(movement: any): string {
  if (movement.bankAccount?.active === false) throw new Error("Restore this archived bank account before reconciling it.");
  if (movement.bankAccount?.ledgerAccount?.active === false) throw new Error("Restore the mapped general-ledger account before reconciling this movement.");
  const ledgerAccountId = movement.bankAccount?.ledgerAccountId;
  if (!ledgerAccountId) throw new Error("Map this bank account to a general-ledger bank account before reconciling it.");
  return ledgerAccountId;
}

async function claimMovementRevision(tx: DbLike, movement: any, revision: number, extraData: Record<string, unknown> = {}): Promise<void> {
  if (movement.revision !== revision) throw new Error("This bank movement changed in another window. Refresh and try again.");
  const result = await tx.bankMovement.updateMany({
    where: { id: movement.id, revision },
    data: { revision: { increment: 1 }, ...extraData },
  });
  if (result.count !== 1) throw new Error("This bank movement changed in another window. Refresh and try again.");
}

function paymentDirection(kind: unknown): 1 | -1 | 0 {
  const normalized = String(kind ?? "").trim().toUpperCase();
  if (["RECEIPT", "CUSTOMER_RECEIPT", "COLLECTION", "INBOUND", "ENCAISSEMENT"].includes(normalized)) return 1;
  if (["DISBURSEMENT", "SUPPLIER_PAYMENT", "PAYMENT_SENT", "OUTBOUND", "DECAISSEMENT"].includes(normalized)) return -1;
  return 0;
}

/**
 * Why a suggestion is a suggestion.
 *
 * A bare "85 %" is a number the accountant is asked to trust. These are the
 * facts the number is computed from, so a suggestion can be judged instead of
 * believed. They are produced by the same pass that produces the score, which
 * is what stops the shown reasons and the ranking from ever disagreeing.
 *
 * Codes, not sentences: the wording belongs to the screen that shows them.
 */
export type CandidateMatchReason =
  | "AMOUNT_EXACT"
  | "AMOUNT_COVERS"
  | "DATE_SAME_DAY"
  | "DATE_WITHIN_3_DAYS"
  | "DATE_WITHIN_10_DAYS"
  | "REFERENCE_MATCH";

function scoreCandidate(movement: any, line: any, remaining: bigint): { score: number; reasons: CandidateMatchReason[] } {
  let score = 0;
  const reasons: CandidateMatchReason[] = [];
  const movementMagnitude = magnitude(BigInt(movement.amountCents));
  if (remaining === movementMagnitude) {
    score += 60;
    reasons.push("AMOUNT_EXACT");
  } else if (remaining >= movementMagnitude) {
    score += 25;
    reasons.push("AMOUNT_COVERS");
  }
  const movementDay = new Date(movement.date).getTime();
  const entryDay = new Date(line.entry.date).getTime();
  const dayDifference = Math.abs(Math.round((movementDay - entryDay) / 86_400_000));
  if (dayDifference === 0) {
    score += 25;
    reasons.push("DATE_SAME_DAY");
  } else if (dayDifference <= 3) {
    score += 15;
    reasons.push("DATE_WITHIN_3_DAYS");
  } else if (dayDifference <= 10) {
    score += 5;
    reasons.push("DATE_WITHIN_10_DAYS");
  }
  const haystack = normalizedFingerprintText(`${line.entry.pieceNumber} ${line.entry.label} ${line.label}`);
  const reference = normalizedFingerprintText(movement.reference);
  if (reference && haystack.includes(reference)) {
    score += 15;
    reasons.push("REFERENCE_MATCH");
  }
  return { score: Math.min(score, 100), reasons };
}

export function createReconciliationService(prisma: DbLike, options: ReconciliationServiceOptions = {}) {
  if (!prisma || typeof prisma.$transaction !== "function") throw new Error("A Prisma-compatible transaction client is required.");
  const now = options.now ?? (() => new Date());

  async function workspace(input: { companyId: string; bankAccountId?: string; includeExcluded?: boolean }) {
    const companyId = requiredId(input?.companyId, "Company");
    const bankAccountId = input.bankAccountId ? requiredId(input.bankAccountId, "Bank account") : undefined;
    const accounts = await prisma.bankAccount.findMany({
      where: { companyId, ...(bankAccountId ? { id: bankAccountId } : {}) },
      include: { ledgerAccount: true, statements: { orderBy: { importedAt: "desc" }, take: 20 } },
      orderBy: { bankName: "asc" },
    });
    if (bankAccountId && !accounts.length) throw new Error("Bank account does not belong to the selected company.");
    const movements = await prisma.bankMovement.findMany({
      where: {
        bankAccount: { companyId },
        ...(bankAccountId ? { bankAccountId } : {}),
        ...(input.includeExcluded ? {} : { excludedAt: null }),
      },
      include: movementInclude(),
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    return { companyId, accounts: transport(accounts), movements: movements.map(movementView), generatedAt: now().toISOString() };
  }

  async function candidates(input: { movementId: string }) {
    const movement = await findMovement(prisma, input?.movementId);
    const ledgerAccountId = requireMappedBankAccount(movement);
    const activeState = stateInternal({
      amountCents: BigInt(movement.amountCents),
      allocatedCents: activeAllocatedCents(movement),
      excludedAt: movement.excludedAt,
      legacyMatchClaimed: movement.legacyMatchClaimed,
    });
    if (activeState.status === RECONCILIATION_STATE.excluded) throw new Error("Restore this excluded movement before reconciling it.");
    const lines = await prisma.entryLine.findMany({
      where: { accountId: ledgerAccountId, entry: { companyId: movement.bankAccount.companyId, status: "POSTED" } },
      include: {
        entry: true,
        account: true,
        bankReconciliationAllocations: {
          where: { reconciliation: { status: ACTIVE_RECONCILIATION } },
          select: { amountCents: true },
        },
      },
      orderBy: { entry: { date: "desc" } },
      take: 250,
    });
    const entryLines = lines.flatMap((line: any) => {
      const net = lineNetCents(line);
      if (!sameSign(BigInt(movement.amountCents), net)) return [];
      const used = (line.bankReconciliationAllocations ?? []).reduce((sum: bigint, item: any) => sum + BigInt(item.amountCents), 0n);
      const remaining = magnitude(net) > used ? magnitude(net) - used : 0n;
      if (remaining <= 0n) return [];
      const match = scoreCandidate(movement, line, remaining);
      return [{
        ...transport(line),
        signedLineCents: net.toString(),
        availableCents: remaining.toString(),
        suggestedCents: (remaining < activeState.remaining ? remaining : activeState.remaining).toString(),
        score: match.score,
        matchReasons: match.reasons,
      }];
    }).sort((left: any, right: any) => right.score - left.score);

    const payments = await prisma.payment.findMany({
      where: { companyId: movement.bankAccount.companyId, lifecycleStatus: "POSTED" },
      include: {
        counterparty: true,
        postedEntry: true,
        bankEvidence: { where: { reconciliation: { status: ACTIVE_RECONCILIATION } }, select: { amountCents: true } },
      },
      orderBy: { paymentDate: "desc" },
      take: 250,
    });
    const paymentEvidence = payments.flatMap((payment: any) => {
      if (payment.bankAccountId && payment.bankAccountId !== movement.bankAccountId) return [];
      if (payment.settlementAccountId !== ledgerAccountId || payment.postedEntry?.status !== "POSTED") return [];
      const direction = paymentDirection(payment.kind);
      if (!direction || direction !== (BigInt(movement.amountCents) > 0n ? 1 : -1)) return [];
      const used = (payment.bankEvidence ?? []).reduce((sum: bigint, item: any) => sum + BigInt(item.amountCents), 0n);
      const remaining = BigInt(payment.amountCents) > used ? BigInt(payment.amountCents) - used : 0n;
      return remaining > 0n ? [{ ...transport(payment), availableEvidenceCents: remaining.toString() }] : [];
    });
    return { movement: movementView(movement), entryLines, paymentEvidence };
  }

  async function confirm(input: ConfirmReconciliationInput) {
    const revision = expectedRevision(input?.expectedRevision);
    const allocations = allocationInputs(input?.allocations, "entryLineId", "accounting allocation");
    const evidence = allocationInputs(input?.paymentEvidence, "paymentId", "payment evidence");
    if (!allocations.length) throw new Error("At least one accounting-line allocation is required.");
    const note = optionalText(input.note, "Reconciliation note", 1_000);
    return prisma.$transaction(async (tx: DbLike) => {
      const movement = await findMovement(tx, input.movementId);
      if (movement.excludedAt) throw new Error("Restore this excluded movement before reconciling it.");
      const ledgerAccountId = requireMappedBankAccount(movement);
      const movementAmount = BigInt(movement.amountCents);
      if (movementAmount === 0n) throw new Error("A zero-value bank movement cannot be reconciled.");
      const currentAllocated = activeAllocatedCents(movement);
      const movementCapacity = magnitude(movementAmount) - currentAllocated;
      const batchAmount = allocations.reduce((sum, allocation) => sum + allocation.parsedAmountCents, 0n);
      if (movementCapacity <= 0n) throw new Error("This movement is already fully reconciled.");
      if (batchAmount > movementCapacity) throw new Error("Accounting allocations exceed the movement's remaining amount.");

      await claimMovementRevision(tx, movement, revision);
      const lines = await tx.entryLine.findMany({
        where: { id: { in: allocations.map((allocation) => allocation.entryLineId) } },
        include: { entry: true, account: true },
      });
      if (lines.length !== allocations.length) throw new Error("One or more accounting lines no longer exist.");
      const lineById = new Map(lines.map((line: any) => [line.id, line]));
      for (const allocation of allocations) {
        const line: any = lineById.get(allocation.entryLineId);
        if (line.accountId !== ledgerAccountId) throw new Error(`Accounting line ${line.id} is not on the bank account mapped to this statement.`);
        if (line.entry.companyId !== movement.bankAccount.companyId) throw new Error(`Accounting line ${line.id} belongs to another company.`);
        if (line.entry.status !== "POSTED") throw new Error(`Accounting line ${line.id} is not part of a posted entry.`);
        const net = lineNetCents(line);
        if (!sameSign(movementAmount, net)) throw new Error(`Accounting line ${line.id} has the opposite bank direction.`);
        const prior = await tx.bankReconciliationAllocation.findMany({
          where: { entryLineId: line.id, reconciliation: { status: ACTIVE_RECONCILIATION } },
          select: { amountCents: true },
        });
        const alreadyAllocated = prior.reduce((sum: bigint, item: any) => sum + BigInt(item.amountCents), 0n);
        if (alreadyAllocated + allocation.parsedAmountCents > magnitude(net)) {
          throw new Error(`Allocation exceeds the remaining capacity of accounting line ${line.id}.`);
        }
      }

      const evidenceTotal = evidence.reduce((sum, item) => sum + item.parsedAmountCents, 0n);
      if (evidenceTotal > batchAmount) throw new Error("Payment evidence cannot exceed this accounting allocation batch.");
      if (evidence.length) {
        const payments: any[] = await tx.payment.findMany({
          where: { id: { in: evidence.map((item) => item.paymentId) } },
          include: { postedEntry: true },
        });
        if (payments.length !== evidence.length) throw new Error("One or more payment records no longer exist.");
        const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
        for (const item of evidence) {
          const payment: any = paymentById.get(item.paymentId);
          if (payment.companyId !== movement.bankAccount.companyId) throw new Error(`Payment ${payment.id} belongs to another company.`);
          if (payment.lifecycleStatus !== "POSTED" || payment.postedEntry?.status !== "POSTED") throw new Error(`Payment ${payment.id} is not posted.`);
          if (payment.bankAccountId && payment.bankAccountId !== movement.bankAccountId) throw new Error(`Payment ${payment.id} belongs to another bank account.`);
          if (payment.settlementAccountId !== ledgerAccountId) throw new Error(`Payment ${payment.id} is not posted to this bank ledger account.`);
          const direction = paymentDirection(payment.kind);
          if (!direction || direction !== (movementAmount > 0n ? 1 : -1)) throw new Error(`Payment ${payment.id} has the wrong direction.`);
          const prior = await tx.bankReconciliationPaymentEvidence.findMany({
            where: { paymentId: payment.id, reconciliation: { status: ACTIVE_RECONCILIATION } },
            select: { amountCents: true },
          });
          const alreadyUsed = prior.reduce((sum: bigint, record: any) => sum + BigInt(record.amountCents), 0n);
          if (alreadyUsed + item.parsedAmountCents > BigInt(payment.amountCents)) throw new Error(`Payment evidence exceeds payment ${payment.id}.`);
        }
      }

      const snapshot = JSON.stringify({
        id: movement.id,
        bankAccountId: movement.bankAccountId,
        companyId: movement.bankAccount.companyId,
        date: new Date(movement.date).toISOString(),
        label: movement.label,
        reference: movement.reference,
        amountCents: movementAmount.toString(),
        fingerprint: movement.fingerprint,
        revision,
      });
      const reconciliation = await tx.bankReconciliation.create({
        data: {
          companyId: movement.bankAccount.companyId,
          bankMovementId: movement.id,
          status: ACTIVE_RECONCILIATION,
          note,
          movementSnapshot: snapshot,
          confirmedAt: now(),
          confirmedByUserId: input.actorUserId ? requiredId(input.actorUserId, "Actor user") : null,
          allocations: {
            create: allocations.map((allocation) => ({ entryLineId: allocation.entryLineId, amountCents: allocation.parsedAmountCents })),
          },
          paymentEvidence: {
            create: evidence.map((item) => ({ paymentId: item.paymentId, amountCents: item.parsedAmountCents })),
          },
        },
        include: { allocations: true, paymentEvidence: true },
      });
      await appendAudit(tx, options, {
        companyId: movement.bankAccount.companyId,
        actorUserId: input.actorUserId,
        action: "BANK_RECONCILIATION_CONFIRMED",
        entity: "BankReconciliation",
        entityId: reconciliation.id,
        description: `Bank movement ${movement.reference} allocated to posted accounting lines`,
        details: { movementId: movement.id, revisionBefore: revision, batchAmountCents: batchAmount.toString(), allocationCount: allocations.length },
      });
      return {
        reconciliation: transport(reconciliation),
        movement: {
          id: movement.id,
          revision: revision + 1,
          reconciliation: deriveReconciliationState({ amountCents: movementAmount, allocatedCents: currentAllocated + batchAmount }),
        },
      };
    });
  }

  async function voidReconciliation(input: VoidReconciliationInput) {
    const revision = expectedRevision(input?.expectedRevision);
    const reconciliationId = requiredId(input?.reconciliationId, "Reconciliation");
    const reason = optionalText(input?.reason, "Void reason", 1_000);
    if (!reason) throw new Error("A void reason is required.");
    return prisma.$transaction(async (tx: DbLike) => {
      const reconciliation = await tx.bankReconciliation.findUnique({
        where: { id: reconciliationId },
        include: { movement: { include: movementInclude() }, allocations: true, paymentEvidence: true },
      });
      if (!reconciliation) throw new Error("Reconciliation not found.");
      if (reconciliation.status !== ACTIVE_RECONCILIATION) throw new Error("This reconciliation is already void.");
      const movement = reconciliation.movement;
      await claimMovementRevision(tx, movement, revision);
      const updated = await tx.bankReconciliation.updateMany({
        where: { id: reconciliationId, status: ACTIVE_RECONCILIATION },
        data: {
          status: "VOIDED",
          voidedAt: now(),
          voidedByUserId: input.actorUserId ? requiredId(input.actorUserId, "Actor user") : null,
          voidReason: reason,
        },
      });
      if (updated.count !== 1) throw new Error("This reconciliation changed in another window. Refresh and try again.");
      const removedAmount = reconciliation.allocations.reduce((sum: bigint, item: any) => sum + BigInt(item.amountCents), 0n);
      const allocatedAfter = activeAllocatedCents(movement) - removedAmount;
      await appendAudit(tx, options, {
        companyId: reconciliation.companyId,
        actorUserId: input.actorUserId,
        action: "BANK_RECONCILIATION_VOIDED",
        entity: "BankReconciliation",
        entityId: reconciliation.id,
        description: `Bank reconciliation voided: ${reason}`,
        details: { movementId: movement.id, revisionBefore: revision, preservedAllocationCount: reconciliation.allocations.length },
      });
      return {
        reconciliationId,
        status: "VOIDED",
        movement: {
          id: movement.id,
          revision: revision + 1,
          reconciliation: deriveReconciliationState({
            amountCents: BigInt(movement.amountCents),
            allocatedCents: allocatedAfter > 0n ? allocatedAfter : 0n,
            legacyMatchClaimed: movement.legacyMatchClaimed,
          }),
        },
      };
    });
  }

  async function exclude(input: ExcludeMovementInput) {
    const revision = expectedRevision(input?.expectedRevision);
    const reason = optionalText(input?.reason, "Exclusion reason", 1_000);
    if (!reason) throw new Error("An exclusion reason is required.");
    return prisma.$transaction(async (tx: DbLike) => {
      const movement = await findMovement(tx, input.movementId);
      if (movement.excludedAt) throw new Error("This bank movement is already excluded.");
      if ((movement.reconciliations ?? []).some((item: any) => item.status === ACTIVE_RECONCILIATION)) {
        throw new Error("Void all active reconciliation batches before excluding this movement.");
      }
      const excludedAt = now();
      await claimMovementRevision(tx, movement, revision, { excludedAt, exclusionReason: reason });
      await appendAudit(tx, options, {
        companyId: movement.bankAccount.companyId,
        actorUserId: input.actorUserId,
        action: "BANK_MOVEMENT_EXCLUDED",
        entity: "BankMovement",
        entityId: movement.id,
        description: `Bank movement excluded: ${reason}`,
        details: { revisionBefore: revision, amountCents: BigInt(movement.amountCents).toString() },
      });
      return {
        movementId: movement.id,
        revision: revision + 1,
        excludedAt: excludedAt.toISOString(),
        reconciliation: deriveReconciliationState({ amountCents: BigInt(movement.amountCents), allocatedCents: 0n, excludedAt }),
      };
    });
  }

  async function restore(input: RestoreMovementInput) {
    const revision = expectedRevision(input?.expectedRevision);
    return prisma.$transaction(async (tx: DbLike) => {
      const movement = await findMovement(tx, input.movementId);
      if (!movement.excludedAt) throw new Error("This bank movement is not excluded.");
      await claimMovementRevision(tx, movement, revision, { excludedAt: null, exclusionReason: null });
      await appendAudit(tx, options, {
        companyId: movement.bankAccount.companyId,
        actorUserId: input.actorUserId,
        action: "BANK_MOVEMENT_RESTORED",
        entity: "BankMovement",
        entityId: movement.id,
        description: "Excluded bank movement restored for review",
        details: { revisionBefore: revision },
      });
      return {
        movementId: movement.id,
        revision: revision + 1,
        reconciliation: deriveReconciliationState({
          amountCents: BigInt(movement.amountCents),
          allocatedCents: 0n,
          legacyMatchClaimed: movement.legacyMatchClaimed,
        }),
      };
    });
  }

  async function reviewStatement(input: ReviewStatementInput) {
    const bankAccountId = requiredId(input?.bankAccountId, "Bank account");
    if (typeof input?.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
      throw new Error("Statement SHA-256 must be a lowercase 64-character hexadecimal value.");
    }
    assertStatementAmountMapping(input.mapping);
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_IMPORT_ROWS) {
      throw new Error(`A statement review must contain between 1 and ${MAX_IMPORT_ROWS} rows.`);
    }
    const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
    if (!bankAccount) throw new Error("Bank account not found.");
    if (bankAccount.active === false) throw new Error("Restore this archived bank account before importing a statement.");

    const errors: Array<{ row: number; reason: string; original: Record<string, unknown> }> = [];
    const validRows: NormalizedStatementMovement[] = [];
    const inferredYear = inferStatementYear(input.rows, input.mapping);
    for (let index = 0; index < input.rows.length; index += 1) {
      try {
        const movement = normalizeStatementRow({ bankAccountId, row: input.rows[index], mapping: input.mapping, statementRow: index + 1, statementYear: inferredYear });
        if (movement) validRows.push(movement);
      } catch (error) {
        errors.push({
          row: index + 1,
          reason: error instanceof Error ? error.message : String(error),
          original: input.rows[index],
        });
      }
    }

    const warnings: string[] = [];
    const currencies = new Set<string>();
    const declaredCurrency = optionalText(input.sourceCurrency, "Statement currency", 3)?.toUpperCase();
    if (declaredCurrency) currencies.add(declaredCurrency);
    if (input.mapping.currency) {
      for (const row of input.rows) {
        const value = mappedCell(row, input.mapping.currency);
        if (typeof value === "string" && value.trim()) currencies.add(value.trim().toUpperCase());
      }
    }
    if (currencies.size > 1) warnings.push(`Plusieurs devises sont présentes dans le relevé: ${[...currencies].join(", ")}.`);
    const incompatibleCurrencies = [...currencies].filter((currency) => !/^[A-Z]{3}$/.test(currency) || currency !== String(bankAccount.currency).toUpperCase());
    if (incompatibleCurrencies.length) {
      errors.push({
        row: 0,
        reason: `La devise du relevé (${incompatibleCurrencies.join(", ")}) ne correspond pas au compte bancaire (${bankAccount.currency}).`,
        original: {},
      });
    }

    const duplicateRows = new Set<number>();
    const fingerprintRows = new Map<string, number>();
    for (const row of validRows) {
      const firstRow = fingerprintRows.get(row.fingerprint);
      if (firstRow !== undefined) {
        duplicateRows.add(firstRow);
        duplicateRows.add(row.statementRow);
      } else fingerprintRows.set(row.fingerprint, row.statementRow);
    }
    const fingerprints = [...fingerprintRows.keys()];
    for (let start = 0; start < fingerprints.length; start += 400) {
      const existing = await prisma.bankMovement.findMany({
        where: { bankAccountId, fingerprint: { in: fingerprints.slice(start, start + 400) } },
        select: { fingerprint: true },
      });
      const existingFingerprints = new Set(existing.map((item: any) => item.fingerprint));
      for (const row of validRows) if (existingFingerprints.has(row.fingerprint)) duplicateRows.add(row.statementRow);
    }
    const priorStatement = await prisma.bankStatementImport.findUnique({
      where: { bankAccountId_sourceSha256: { bankAccountId, sourceSha256: input.sourceSha256 } },
    });
    const duplicates = [...duplicateRows].sort((left, right) => left - right);
    return {
      rowCount: input.rows.length,
      validCount: validRows.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      duplicateCount: duplicates.length,
      readyCount: Math.max(0, validRows.length - duplicates.length),
      exactFileDuplicate: Boolean(priorStatement),
      priorStatement: priorStatement ? transport(priorStatement) : null,
      duplicateRows: duplicates,
      errors,
      warnings,
      normalizedPreview: transport(validRows.slice(0, 20)),
      canImport: errors.length === 0 && validRows.length > 0 && !priorStatement,
    };
  }

  async function importStatement(input: ImportStatementInput) {
    const bankAccountId = requiredId(input?.bankAccountId, "Bank account");
    const sourceName = optionalText(input?.sourceName, "Statement source name", 250);
    if (!sourceName) throw new Error("Statement source name is required.");
    if (typeof input.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
      throw new Error("Statement SHA-256 must be a lowercase 64-character hexadecimal value.");
    }
    const sourceStoredPath = optionalText(input.sourceStoredPath, "Statement stored path", 2_000);
    const sourceFormat = optionalText(input.sourceFormat, "Statement source format", 40)?.toUpperCase() ?? "UNKNOWN";
    const rows = normalizeStatementRows({ bankAccountId, rows: input.rows, mapping: input.mapping });
    const openingBalanceCents = input.openingBalanceCents === undefined || input.openingBalanceCents === null
      ? null
      : parseExactCents(input.openingBalanceCents, "Opening balance");
    const closingBalanceCents = input.closingBalanceCents === undefined || input.closingBalanceCents === null
      ? null
      : parseExactCents(input.closingBalanceCents, "Closing balance");
    const movementNetCents = rows.reduce((sum, row) => sum + row.amountCents, 0n);
    const expectedClosingBalanceCents = openingBalanceCents === null ? null : openingBalanceCents + movementNetCents;
    const closingDifferenceCents = expectedClosingBalanceCents === null || closingBalanceCents === null
      ? null
      : closingBalanceCents - expectedClosingBalanceCents;
    if (closingDifferenceCents !== null && closingDifferenceCents !== 0n) {
      throw new Error(`Le relevé est incohérent : solde initial + mouvements diffère du solde final de ${closingDifferenceCents.toString()} centime(s). Corrigez les lignes ou relancez l'analyse avant import.`);
    }
    const validation = {
      equationChecked: closingDifferenceCents !== null,
      movementNetCents: movementNetCents.toString(),
      expectedClosingBalanceCents: expectedClosingBalanceCents?.toString() ?? null,
      statedClosingBalanceCents: closingBalanceCents?.toString() ?? null,
      differenceCents: closingDifferenceCents?.toString() ?? null,
      inferredDateRows: rows.filter((row) => row.dateInferred).map((row) => row.statementRow),
    };
    try {
      return await prisma.$transaction(async (tx: DbLike) => {
      const bankAccount = await tx.bankAccount.findUnique({ where: { id: bankAccountId } });
      if (!bankAccount) throw new Error("Bank account not found.");
      if (bankAccount.active === false) throw new Error("Restore this archived bank account before importing a statement.");
      const priorStatement = await tx.bankStatementImport.findUnique({
        where: { bankAccountId_sourceSha256: { bankAccountId, sourceSha256: input.sourceSha256 } },
      });
      if (priorStatement) throw new Error("This exact statement file was already imported into this bank account.");

      const duplicateRows = new Set<number>();
      const fingerprintRows = new Map<string, number>();
      for (const row of rows) {
        const firstRow = fingerprintRows.get(row.fingerprint);
        if (firstRow !== undefined) {
          duplicateRows.add(firstRow);
          duplicateRows.add(row.statementRow);
        } else fingerprintRows.set(row.fingerprint, row.statementRow);
      }
      const fingerprints = [...fingerprintRows.keys()];
      for (let start = 0; start < fingerprints.length; start += 400) {
        const existing = await tx.bankMovement.findMany({
          where: { bankAccountId, fingerprint: { in: fingerprints.slice(start, start + 400) } },
          select: { fingerprint: true },
        });
        const existingFingerprints = new Set(existing.map((item: any) => item.fingerprint));
        for (const row of rows) if (existingFingerprints.has(row.fingerprint)) duplicateRows.add(row.statementRow);
      }
      if (duplicateRows.size && !input.allowSuspectedDuplicates) {
        throw new Error(`Suspected duplicate bank movement rows require explicit review: ${[...duplicateRows].sort((a, b) => a - b).join(", ")}.`);
      }

      const sortedDates = rows.map((row) => row.date.getTime()).sort((left, right) => left - right);
      const statement = await tx.bankStatementImport.create({
        data: {
          bankAccountId,
          sourceName,
          sourceStoredPath,
          sourceSha256: input.sourceSha256,
          startsOn: new Date(sortedDates[0]),
          endsOn: new Date(sortedDates[sortedDates.length - 1]),
          openingBalanceCents,
          closingBalanceCents,
          rowCount: rows.length,
          sourceFormat,
          importedCount: rows.length,
          skippedCount: 0,
          errorCount: 0,
          duplicateCount: duplicateRows.size,
          canonicalSchemaVersion: STORED_SCHEMA_VERSIONS.bank.current,
          validationJson: JSON.stringify(validation),
          status: "ACTIVE",
          importedAt: now(),
        },
      });
      await tx.bankMovement.createMany({
        data: rows.map((row) => ({
          bankAccountId,
          date: row.date,
          valueDate: row.valueDate,
          operationDateRaw: row.operationDateRaw,
          valueDateRaw: row.valueDateRaw,
          dateInferred: row.dateInferred,
          rowClass: row.rowClass,
          rawJson: JSON.stringify(row.raw),
          confidenceJson: JSON.stringify({ textRecognition: null, layout: null, rowReconstruction: null, fieldMapping: null, accountingConsistency: closingDifferenceCents === null ? null : 100, finalDocument: null }),
          label: row.label,
          amountCents: row.amountCents,
          reference: row.reference,
          status: "TO_REVIEW",
          confidence: 0,
          statementId: statement.id,
          statementRow: row.statementRow,
          externalId: row.externalId,
          fingerprint: row.fingerprint,
          revision: 0,
        })),
      });
      const createdMovements = await tx.bankMovement.findMany({ where: { statementId: statement.id }, orderBy: { statementRow: "asc" } });
      await appendAudit(tx, options, {
        companyId: bankAccount.companyId,
        actorUserId: input.actorUserId,
        action: "BANK_STATEMENT_IMPORTED",
        entity: "BankStatementImport",
        entityId: statement.id,
        description: `${rows.length} bank statement movement(s) imported from ${sourceName}`,
        details: { sourceSha256: input.sourceSha256, sourceFormat, rowCount: rows.length, importedCount: rows.length, suspectedDuplicateRows: [...duplicateRows] },
      });
        return { statement: transport(statement), movements: transport(createdMovements), suspectedDuplicateRows: [...duplicateRows].sort((a, b) => a - b) };
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2002") {
        throw new Error("This exact statement file was already imported into this bank account.", { cause: error });
      }
      throw error;
    }
  }

  return {
    workspace,
    candidates,
    confirm,
    void: voidReconciliation,
    exclude,
    restore,
    reviewStatement,
    importStatement,
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;

/**
 * Registers the complete reconciliation boundary. Mutating actor identity can
 * be supplied by trusted main-process session state and then overrides any
 * renderer-provided actor value.
 */
export function registerReconciliationIpc(options: ReconciliationIpcRegistrationOptions) {
  if (!options?.ipcMain || typeof options.ipcMain.handle !== "function") throw new Error("A registerable ipcMain instance is required.");
  if (typeof options.getPrisma !== "function") throw new Error("getPrisma is required to register reconciliation IPC.");
  const serialize = options.serialize ?? ((value: any) => value);
  const serviceOptions: ReconciliationServiceOptions = { now: options.now, audit: options.audit };
  const invoke = async (method: keyof ReconciliationService, payload: any, mutating = false) => {
    const prisma = await options.getPrisma();
    const service = createReconciliationService(prisma, serviceOptions);
    let trustedPayload = payload;
    if (mutating && options.getActorUserId) {
      const actorUserId = await options.getActorUserId();
      trustedPayload = { ...(payload && typeof payload === "object" ? payload : {}), actorUserId };
    }
    return service[method](trustedPayload);
  };
  const facade = {
    workspace: (payload: any) => invoke("workspace", payload),
    candidates: (payload: any) => invoke("candidates", payload),
    confirm: (payload: any) => invoke("confirm", payload, true),
    void: (payload: any) => invoke("void", payload, true),
    exclude: (payload: any) => invoke("exclude", payload, true),
    restore: (payload: any) => invoke("restore", payload, true),
    reviewStatement: (payload: any) => invoke("reviewStatement", payload),
    importStatement: (payload: any) => invoke("importStatement", payload, true),
  };
  const bind = (channel: string, handler: (payload: any) => Promise<any>) => {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  };
  bind(RECONCILIATION_IPC_CHANNELS.workspace, facade.workspace);
  bind(RECONCILIATION_IPC_CHANNELS.candidates, facade.candidates);
  bind(RECONCILIATION_IPC_CHANNELS.confirm, facade.confirm);
  bind(RECONCILIATION_IPC_CHANNELS.void, facade.void);
  bind(RECONCILIATION_IPC_CHANNELS.excludeMovement, facade.exclude);
  bind(RECONCILIATION_IPC_CHANNELS.restoreMovement, facade.restore);
  bind(RECONCILIATION_IPC_CHANNELS.reviewStatement, facade.reviewStatement);
  bind(RECONCILIATION_IPC_CHANNELS.importStatement, facade.importStatement);
  return facade;
}
