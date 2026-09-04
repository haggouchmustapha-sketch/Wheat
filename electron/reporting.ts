import { createHash } from "node:crypto";
import { rendererSerialize, requireId, requireText } from "./accounting";

export const REPORTING_IPC_CHANNELS = {
  entryQuery: "wheat:reporting:entries",
  entryDetail: "wheat:reporting:entry-detail",
  trialBalance: "wheat:reporting:trial-balance",
  generalLedger: "wheat:reporting:general-ledger",
  journal: "wheat:reporting:journal",
  agedReceivables: "wheat:reporting:aged-receivables",
  agedPayables: "wheat:reporting:aged-payables",
  counterpartyStatement: "wheat:reporting:counterparty-statement",
  integrityChecks: "wheat:reporting:integrity-checks",
} as const;

/**
 * REVERSED entries remain accounting evidence. Their posted reversal is a
 * separate entry with opposite lines; excluding the original would invert the
 * ledger instead of cancelling it.
 */
export const LEDGER_ENTRY_STATUSES = ["POSTED", "REVERSED"] as const;

type DbLike = Record<string, any> & {
  $transaction?<T>(callback: (tx: any) => Promise<T>, options?: Record<string, unknown>): Promise<T>;
};

type GetPrisma = () => DbLike | Promise<DbLike>;

type RegisterableIpc = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown;
};

export type ReportingServiceOptions = {
  getPrisma: GetPrisma;
  now?: () => Date;
};

export type ReportingRegistrationOptions = ReportingServiceOptions & {
  ipcMain: RegisterableIpc;
  serialize?: (value: unknown) => unknown;
};

type DateRange = {
  from: Date | null;
  to: Date | null;
  toExclusive: Date | null;
};

type CursorDirection = "asc" | "desc";

type EntryCursor = {
  v: 1;
  scope: string;
  direction: CursorDirection;
  date: string;
  id: string;
};

type ExactSums = {
  debitCents: bigint;
  creditCents: bigint;
};

type IntegritySeverity = "ERROR" | "WARNING";

type IntegrityIssue = {
  code: string;
  severity: IntegritySeverity;
  entityType: string;
  entityId: string | null;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_ISSUES = 1_000;
const DAY_MS = 86_400_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === "" ? null : requireId(value, label);
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, label, maxLength);
}

function exactInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function pageSize(value: unknown): number {
  return value === undefined ? DEFAULT_PAGE_SIZE : exactInteger(value, "La taille de page", 1, MAX_PAGE_SIZE);
}

function strictIsoDay(value: unknown, label: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} doit être au format AAAA-MM-JJ.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} est invalide.`);
  return date;
}

function optionalIsoDay(value: unknown, label: string): Date | null {
  return value === undefined || value === null || value === "" ? null : strictIsoDay(value, label);
}

function nextUtcDay(date: Date): Date {
  return new Date(date.getTime() + DAY_MS);
}

function parseRange(input: Record<string, unknown>): DateRange {
  const from = optionalIsoDay(input.from, "La date de début");
  const to = optionalIsoDay(input.to, "La date de fin");
  if (from && to && from > to) throw new Error("La date de début doit précéder la date de fin.");
  return { from, to, toExclusive: to ? nextUtcDay(to) : null };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Une date comptable enregistrée est invalide.");
  return date.toISOString();
}

function cents(value: unknown, label = "Le montant enregistré"): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} n'est pas un entier exact en centimes.`);
}

function centsString(value: bigint): string {
  return value.toString();
}

function sumLines(lines: Array<{ debitCents: unknown; creditCents: unknown }>): ExactSums {
  return lines.reduce<ExactSums>((total, line) => ({
    debitCents: total.debitCents + cents(line.debitCents),
    creditCents: total.creditCents + cents(line.creditCents),
  }), { debitCents: 0n, creditCents: 0n });
}

function signedBalance(sums: ExactSums): bigint {
  return sums.debitCents - sums.creditCents;
}

function stableScope(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function encodeReportingCursor(input: Omit<EntryCursor, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...input } satisfies EntryCursor), "utf8").toString("base64url");
}

export function decodeReportingCursor(value: unknown, scope: string, direction: CursorDirection): EntryCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) throw new Error("Le curseur de pagination est invalide.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Le curseur de pagination est invalide.");
  }
  const cursor = record(parsed, "Le curseur de pagination");
  if (cursor.v !== 1 || cursor.scope !== scope || cursor.direction !== direction) {
    throw new Error("Ce curseur ne correspond pas aux filtres actuels.");
  }
  const date = typeof cursor.date === "string" ? new Date(cursor.date) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== cursor.date) throw new Error("La date du curseur est invalide.");
  const id = requireId(cursor.id, "L'identifiant du curseur");
  return { v: 1, scope, direction, date: date.toISOString(), id };
}

function cursorWhere(cursor: EntryCursor | null, direction: CursorDirection): Record<string, unknown> | null {
  if (!cursor) return null;
  const date = new Date(cursor.date);
  const comparison = direction === "asc" ? "gt" : "lt";
  return {
    OR: [
      { date: { [comparison]: date } },
      { date, id: { [comparison]: cursor.id } },
    ],
  };
}

function rangeWhere(range: DateRange): Record<string, unknown> | null {
  const date: Record<string, Date> = {};
  if (range.from) date.gte = range.from;
  if (range.toExclusive) date.lt = range.toExclusive;
  return Object.keys(date).length ? { date } : null;
}

function combineWhere(...parts: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const present = parts.filter((part): part is Record<string, unknown> => Boolean(part));
  if (present.length === 0) return {};
  if (present.length === 1) return present[0];
  return { AND: present };
}

function reportableEntryWhere(companyId: string, range: DateRange): Record<string, unknown> {
  return combineWhere(
    { companyId, status: { in: [...LEDGER_ENTRY_STATUSES] } },
    rangeWhere(range),
  );
}

function mapEntrySummary(entry: any) {
  const totals = sumLines(entry.lines ?? []);
  return {
    id: entry.id,
    number: entry.number,
    date: iso(entry.date),
    pieceNumber: entry.pieceNumber,
    label: entry.label,
    status: entry.status,
    source: entry.source,
    journal: entry.journal ? {
      id: entry.journal.id,
      code: entry.journalCodeSnapshot,
      label: entry.journal.label,
      currentCode: entry.journal.code,
    } : null,
    debitCents: centsString(totals.debitCents),
    creditCents: centsString(totals.creditCents),
    differenceCents: centsString(totals.debitCents - totals.creditCents),
    lineCount: entry.lines?.length ?? 0,
    postedAt: iso(entry.postedAt),
    reversedAt: iso(entry.reversedAt),
    reversalOfId: entry.reversalOfId ?? null,
    ledgerEvidence: entry.reversalOfId ? "REVERSAL" : entry.status === "REVERSED" ? "REVERSED_ORIGINAL" : "POSTED",
  };
}

async function readSnapshot<T>(prisma: DbLike, callback: (tx: any) => Promise<T>): Promise<T> {
  if (typeof prisma.$transaction !== "function") return callback(prisma);
  return prisma.$transaction(callback, { maxWait: 5_000, timeout: 30_000 });
}

async function requireCompany(tx: any, companyId: string) {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, baseCurrency: true },
  });
  if (!company) throw new Error("La société n'existe plus.");
  return company;
}

async function requireJournal(tx: any, companyId: string, journalId: string) {
  const journal = await tx.journal.findFirst({ where: { id: journalId, companyId }, select: { id: true, code: true, label: true } });
  if (!journal) throw new Error("Le journal n'existe pas dans cette société.");
  return journal;
}

async function requireAccount(tx: any, companyId: string, accountId: string) {
  const account = await tx.account.findFirst({ where: { id: accountId, companyId }, select: { id: true, code: true, label: true, classNo: true, type: true } });
  if (!account) throw new Error("Le compte n'existe pas dans cette société.");
  return account;
}

async function requireCounterparty(tx: any, companyId: string, counterpartyId: string) {
  const counterparty = await tx.counterparty.findFirst({
    where: { id: counterpartyId, companyId },
    select: { id: true, kind: true, displayName: true, legalName: true, ice: true, taxId: true },
  });
  if (!counterparty) throw new Error("Le tiers n'existe pas dans cette société.");
  return counterparty;
}

function normalizeEntryQuery(payload: unknown) {
  const input = record(payload, "La demande de consultation des écritures");
  const range = parseRange(input);
  const normalized = {
    companyId: requireId(input.companyId, "La société"),
    journalId: optionalId(input.journalId, "Le journal"),
    accountId: optionalId(input.accountId, "Le compte"),
    source: optionalText(input.source, "La source", 80),
    search: optionalText(input.search, "La recherche", 120),
    from: range.from?.toISOString().slice(0, 10) ?? null,
    to: range.to?.toISOString().slice(0, 10) ?? null,
  };
  const scope = stableScope({ report: "entries", ...normalized });
  return { ...normalized, range, limit: pageSize(input.pageSize), cursor: decodeReportingCursor(input.cursor, scope, "desc"), scope };
}

function normalizePagedRange(payload: unknown, report: string, extra: (input: Record<string, unknown>) => Record<string, unknown>) {
  const input = record(payload, `La demande du rapport ${report}`);
  const range = parseRange(input);
  const companyId = requireId(input.companyId, "La société");
  const filters = extra(input);
  const scope = stableScope({ report, companyId, from: range.from?.toISOString() ?? null, to: range.to?.toISOString() ?? null, ...filters });
  return { input, companyId, range, filters, scope, limit: pageSize(input.pageSize), cursor: decodeReportingCursor(input.cursor, scope, "asc") };
}

function currencyCode(value: unknown, fallback: string): string {
  const currency = value === undefined || value === null || value === "" ? fallback : requireText(value, "La devise", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("La devise doit être un code ISO de trois lettres.");
  return currency;
}

async function groupedLineSums(tx: any, where: Record<string, unknown>): Promise<Map<string, ExactSums>> {
  const rows = await tx.entryLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debitCents: true, creditCents: true },
  });
  return new Map(rows.map((row: any) => [row.accountId, {
    debitCents: cents(row._sum?.debitCents ?? 0n),
    creditCents: cents(row._sum?.creditCents ?? 0n),
  }]));
}

async function accountLineSums(tx: any, accountId: string, entryWhere: Record<string, unknown>): Promise<ExactSums> {
  const aggregate = await tx.entryLine.aggregate({
    where: { accountId, entry: entryWhere },
    _sum: { debitCents: true, creditCents: true },
  });
  return {
    debitCents: cents(aggregate._sum?.debitCents ?? 0n),
    creditCents: cents(aggregate._sum?.creditCents ?? 0n),
  };
}

function mapEntryDetail(entry: any) {
  const summary = mapEntrySummary(entry);
  return {
    ...summary,
    auditNote: entry.auditNote ?? null,
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt),
    reversalOf: entry.reversalOf ? {
      id: entry.reversalOf.id,
      number: entry.reversalOf.number,
      date: iso(entry.reversalOf.date),
      status: entry.reversalOf.status,
    } : null,
    reversals: (entry.reversals ?? []).map((row: any) => ({ id: row.id, number: row.number, date: iso(row.date), status: row.status })),
    lines: (entry.lines ?? []).map((line: any) => ({
      id: line.id,
      label: line.label,
      debitCents: centsString(cents(line.debitCents)),
      creditCents: centsString(cents(line.creditCents)),
      thirdParty: line.thirdParty ?? null,
      counterpartyId: line.counterpartyId ?? null,
      counterparty: line.counterparty ? { id: line.counterparty.id, displayName: line.counterparty.displayName, kind: line.counterparty.kind } : null,
      position: line.position,
      account: line.account ? {
        id: line.account.id,
        code: line.accountCodeSnapshot,
        label: line.accountLabelSnapshot,
        currentCode: line.account.code,
        currentLabel: line.account.label,
        classNo: line.account.classNo,
        type: line.account.type,
      } : null,
    })),
    documents: (entry.documents ?? []).map((document: any) => ({
      id: document.id,
      title: document.title,
      type: document.type,
      status: document.status,
      createdAt: iso(document.createdAt),
    })),
  };
}

function mapJournalEntry(entry: any) {
  const totals = sumLines(entry.lines ?? []);
  return {
    id: entry.id,
    number: entry.number,
    date: iso(entry.date),
    pieceNumber: entry.pieceNumber,
    label: entry.label,
    source: entry.source,
    status: entry.status,
    reversalOfId: entry.reversalOfId ?? null,
    debitCents: centsString(totals.debitCents),
    creditCents: centsString(totals.creditCents),
    lines: (entry.lines ?? []).map((line: any) => ({
      id: line.id,
      accountId: line.accountId,
      position: line.position,
      accountCode: line.accountCodeSnapshot,
      accountLabel: line.accountLabelSnapshot,
      currentAccountCode: line.account?.code ?? null,
      currentAccountLabel: line.account?.label ?? null,
      label: line.label,
      debitCents: centsString(cents(line.debitCents)),
      creditCents: centsString(cents(line.creditCents)),
      counterpartyId: line.counterpartyId ?? null,
      thirdParty: line.thirdParty ?? null,
    })),
  };
}

function createNextCursor(rows: any[], limit: number, scope: string, direction: CursorDirection): { page: any[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    page,
    nextCursor: hasMore && last ? encodeReportingCursor({ scope, direction, date: new Date(last.date).toISOString(), id: last.id }) : null,
  };
}

export function createReportingService(options: ReportingServiceOptions) {
  const now = options.now ?? (() => new Date());

  async function agedInvoices(payload: unknown, kind: "SALE" | "PURCHASE") {
    const input = record(payload, kind === "SALE" ? "La demande d'ancienneté clients" : "La demande d'ancienneté fournisseurs");
    const companyId = requireId(input.companyId, "La société");
    const today = now();
    const defaultDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const asOf = input.asOf === undefined || input.asOf === null || input.asOf === "" ? defaultDay : strictIsoDay(input.asOf, "La date d'arrêté");
    const prisma = await options.getPrisma();
    return readSnapshot(prisma, async (tx) => {
      const company = await requireCompany(tx, companyId);
      const currency = currencyCode(input.currency, company.baseCurrency);
      const invoices = await tx.invoice.findMany({
        where: {
          companyId,
          kind,
          currency,
          documentType: "INVOICE",
          lifecycleStatus: { in: ["POSTED", "VOIDED", "LEGACY"] },
        },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        include: {
          counterpartyModel: { select: { id: true, displayName: true, kind: true, ice: true, taxId: true } },
          postedEntry: { select: { id: true, companyId: true, date: true, status: true } },
          voidEntry: { select: { id: true, companyId: true, date: true, status: true, reversalOfId: true } },
          allocations: {
            include: {
              payment: {
                include: {
                  postedEntry: { select: { id: true, companyId: true, date: true, status: true } },
                  voidEntry: { select: { id: true, companyId: true, date: true, status: true, reversalOfId: true } },
                },
              },
            },
          },
          creditNotes: {
            include: {
              postedEntry: { select: { id: true, companyId: true, date: true, status: true } },
              voidEntry: { select: { id: true, companyId: true, date: true, status: true, reversalOfId: true } },
            },
          },
        },
      });
      return {
        company: { id: company.id, name: company.name, currency },
        ...deriveAgingReport(invoices, { companyId, kind, currency, asOf }),
      };
    });
  }

  return {
    async queryEntries(payload: unknown) {
      const query = normalizeEntryQuery(payload);
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, query.companyId);
        if (query.journalId) await requireJournal(tx, query.companyId, query.journalId);
        if (query.accountId) await requireAccount(tx, query.companyId, query.accountId);
        const filters: Record<string, unknown>[] = [];
        if (query.journalId) filters.push({ journalId: query.journalId });
        if (query.accountId) filters.push({ lines: { some: { accountId: query.accountId } } });
        if (query.source) filters.push({ source: query.source });
        if (query.search) {
          filters.push({ OR: [
            { number: { contains: query.search } },
            { pieceNumber: { contains: query.search } },
            { label: { contains: query.search } },
          ] });
        }
        const where = combineWhere(
          reportableEntryWhere(query.companyId, query.range),
          ...filters,
          cursorWhere(query.cursor, "desc"),
        );
        const rows = await tx.entry.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: query.limit + 1,
          include: {
            journal: { select: { id: true, code: true, label: true } },
            lines: { select: { debitCents: true, creditCents: true } },
          },
        });
        const paged = createNextCursor(rows, query.limit, query.scope, "desc");
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          filters: { from: query.from, to: query.to, journalId: query.journalId, accountId: query.accountId, source: query.source, search: query.search },
          items: paged.page.map(mapEntrySummary),
          nextCursor: paged.nextCursor,
          pageSize: query.limit,
          ledgerStatuses: [...LEDGER_ENTRY_STATUSES],
          draftEntriesExcluded: true,
        };
      });
    },

    async getEntryDetail(payload: unknown) {
      const input = record(payload, "La demande de détail d'écriture");
      const companyId = requireId(input.companyId, "La société");
      const entryId = requireId(input.entryId, "L'écriture");
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        await requireCompany(tx, companyId);
        const entry = await tx.entry.findFirst({
          where: { id: entryId, companyId, status: { in: [...LEDGER_ENTRY_STATUSES] } },
          include: {
            journal: { select: { id: true, code: true, label: true } },
            lines: {
              orderBy: { position: "asc" },
              include: {
                account: { select: { id: true, code: true, label: true, classNo: true, type: true } },
                counterparty: { select: { id: true, displayName: true, kind: true } },
              },
            },
            reversalOf: { select: { id: true, number: true, date: true, status: true } },
            reversals: { select: { id: true, number: true, date: true, status: true }, orderBy: [{ date: "asc" }, { id: "asc" }] },
            documents: { select: { id: true, title: true, type: true, status: true, createdAt: true }, orderBy: { createdAt: "asc" } },
          },
        });
        if (!entry) throw new Error("L'écriture comptabilisée n'existe pas dans cette société.");
        return mapEntryDetail(entry);
      });
    },

    async trialBalance(payload: unknown) {
      const input = record(payload, "La demande de balance");
      const companyId = requireId(input.companyId, "La société");
      const range = parseRange(input);
      const includeZero = input.includeZero === undefined ? false : input.includeZero;
      if (typeof includeZero !== "boolean") throw new Error("L'option d'affichage des comptes à zéro est invalide.");
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, companyId);
        const accounts = await tx.account.findMany({
          where: { companyId },
          orderBy: [{ code: "asc" }, { id: "asc" }],
          select: { id: true, code: true, label: true, classNo: true, type: true, active: true },
        });
        const statusWhere = { companyId, status: { in: [...LEDGER_ENTRY_STATUSES] } };
        const openingEntryWhere = range.from
          ? combineWhere(statusWhere, { date: { lt: range.from } })
          : combineWhere(statusWhere, { id: { equals: "__NO_OPENING__" } });
        const periodEntryWhere = combineWhere(statusWhere, rangeWhere(range));
        const opening = await groupedLineSums(tx, { entry: openingEntryWhere });
        const period = await groupedLineSums(tx, { entry: periodEntryWhere });
        const accountIds = new Set(accounts.map((account: any) => account.id));
        let unmappedOpeningTurnoverDebit = 0n;
        let unmappedOpeningTurnoverCredit = 0n;
        let unmappedOpeningDebit = 0n;
        let unmappedOpeningCredit = 0n;
        let unmappedPeriodDebit = 0n;
        let unmappedPeriodCredit = 0n;
        for (const [accountId, sums] of opening) {
          if (!accountIds.has(accountId)) {
            unmappedOpeningTurnoverDebit += sums.debitCents;
            unmappedOpeningTurnoverCredit += sums.creditCents;
            const balance = signedBalance(sums);
            if (balance > 0n) unmappedOpeningDebit += balance;
            else unmappedOpeningCredit += -balance;
          }
        }
        for (const [accountId, sums] of period) {
          if (!accountIds.has(accountId)) {
            unmappedPeriodDebit += sums.debitCents;
            unmappedPeriodCredit += sums.creditCents;
          }
        }
        let totalOpeningDebit = 0n;
        let totalOpeningCredit = 0n;
        let totalOpeningTurnoverDebit = 0n;
        let totalOpeningTurnoverCredit = 0n;
        let totalPeriodDebit = 0n;
        let totalPeriodCredit = 0n;
        let totalClosingDebit = 0n;
        let totalClosingCredit = 0n;
        const rows = accounts.map((account: any) => {
          const openingSums = opening.get(account.id) ?? { debitCents: 0n, creditCents: 0n };
          const periodSums = period.get(account.id) ?? { debitCents: 0n, creditCents: 0n };
          const openingBalance = signedBalance(openingSums);
          const openingDebit = openingBalance > 0n ? openingBalance : 0n;
          const openingCredit = openingBalance < 0n ? -openingBalance : 0n;
          const closingBalance = openingBalance + signedBalance(periodSums);
          const closingDebit = closingBalance > 0n ? closingBalance : 0n;
          const closingCredit = closingBalance < 0n ? -closingBalance : 0n;
          totalOpeningDebit += openingDebit;
          totalOpeningCredit += openingCredit;
          totalOpeningTurnoverDebit += openingSums.debitCents;
          totalOpeningTurnoverCredit += openingSums.creditCents;
          totalPeriodDebit += periodSums.debitCents;
          totalPeriodCredit += periodSums.creditCents;
          totalClosingDebit += closingDebit;
          totalClosingCredit += closingCredit;
          return {
            accountId: account.id,
            code: account.code,
            label: account.label,
            classNo: account.classNo,
            type: account.type,
            active: account.active,
            openingDebitCents: centsString(openingDebit),
            openingCreditCents: centsString(openingCredit),
            openingTurnoverDebitCents: centsString(openingSums.debitCents),
            openingTurnoverCreditCents: centsString(openingSums.creditCents),
            openingBalanceCents: centsString(openingBalance),
            periodDebitCents: centsString(periodSums.debitCents),
            periodCreditCents: centsString(periodSums.creditCents),
            closingBalanceCents: centsString(closingBalance),
            closingDebitCents: centsString(closingDebit),
            closingCreditCents: centsString(closingCredit),
          };
        }).filter((row: any) => includeZero || row.openingBalanceCents !== "0" || row.periodDebitCents !== "0" || row.periodCreditCents !== "0");
        const allOpeningTurnoverDebit = totalOpeningTurnoverDebit + unmappedOpeningTurnoverDebit;
        const allOpeningTurnoverCredit = totalOpeningTurnoverCredit + unmappedOpeningTurnoverCredit;
        const allPeriodDebit = totalPeriodDebit + unmappedPeriodDebit;
        const allPeriodCredit = totalPeriodCredit + unmappedPeriodCredit;
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          period: { from: iso(range.from), to: iso(range.to) },
          accounts: rows,
          totals: {
            openingDebitCents: centsString(totalOpeningDebit),
            openingCreditCents: centsString(totalOpeningCredit),
            openingTurnoverDebitCents: centsString(totalOpeningTurnoverDebit),
            openingTurnoverCreditCents: centsString(totalOpeningTurnoverCredit),
            periodDebitCents: centsString(totalPeriodDebit),
            periodCreditCents: centsString(totalPeriodCredit),
            closingDebitCents: centsString(totalClosingDebit),
            closingCreditCents: centsString(totalClosingCredit),
            unmappedOpeningDebitCents: centsString(unmappedOpeningDebit),
            unmappedOpeningCreditCents: centsString(unmappedOpeningCredit),
            unmappedOpeningTurnoverDebitCents: centsString(unmappedOpeningTurnoverDebit),
            unmappedOpeningTurnoverCreditCents: centsString(unmappedOpeningTurnoverCredit),
            unmappedPeriodDebitCents: centsString(unmappedPeriodDebit),
            unmappedPeriodCreditCents: centsString(unmappedPeriodCredit),
            openingDifferenceCents: centsString(allOpeningTurnoverDebit - allOpeningTurnoverCredit),
            periodDifferenceCents: centsString(allPeriodDebit - allPeriodCredit),
          },
          balanced: allOpeningTurnoverDebit === allOpeningTurnoverCredit && allPeriodDebit === allPeriodCredit,
          draftEntriesExcluded: true,
          generatedAt: now().toISOString(),
        };
      });
    },

    async generalLedger(payload: unknown) {
      const query = normalizePagedRange(payload, "general-ledger", (input) => ({
        accountId: requireId(input.accountId, "Le compte"),
      }));
      const accountId = query.filters.accountId as string;
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, query.companyId);
        const account = await requireAccount(tx, query.companyId, accountId);
        const base = reportableEntryWhere(query.companyId, query.range);
        const pageWhere = combineWhere(
          base,
          { lines: { some: { accountId } } },
          cursorWhere(query.cursor, "asc"),
        );
        const rows = await tx.entry.findMany({
          where: pageWhere,
          orderBy: [{ date: "asc" }, { id: "asc" }],
          take: query.limit + 1,
          include: {
            journal: { select: { id: true, code: true, label: true } },
            lines: {
              where: { accountId },
              orderBy: { position: "asc" },
              select: { id: true, position: true, accountCodeSnapshot: true, accountLabelSnapshot: true, label: true, debitCents: true, creditCents: true, thirdParty: true, counterpartyId: true },
            },
          },
        });
        const paged = createNextCursor(rows, query.limit, query.scope, "asc");
        const beforeRange = query.range.from
          ? await accountLineSums(tx, accountId, combineWhere(
            { companyId: query.companyId, status: { in: [...LEDGER_ENTRY_STATUSES] } },
            { date: { lt: query.range.from } },
          ))
          : { debitCents: 0n, creditCents: 0n };
        let carried = signedBalance(beforeRange);
        if (query.cursor) {
          const cursorDate = new Date(query.cursor.date);
          const priorOnPageRange = combineWhere(
            base,
            { OR: [{ date: { lt: cursorDate } }, { date: cursorDate, id: { lte: query.cursor.id } }] },
          );
          const prior = await accountLineSums(tx, accountId, priorOnPageRange);
          carried += signedBalance(prior);
        }
        let running = carried;
        const items = paged.page.map((entry: any) => {
          const totals = sumLines(entry.lines);
          running += signedBalance(totals);
          return {
            entryId: entry.id,
            entryNumber: entry.number,
            date: iso(entry.date),
            pieceNumber: entry.pieceNumber,
            label: entry.label,
            status: entry.status,
            source: entry.source,
            reversalOfId: entry.reversalOfId ?? null,
            journal: entry.journal,
            debitCents: centsString(totals.debitCents),
            creditCents: centsString(totals.creditCents),
            movementCents: centsString(signedBalance(totals)),
            runningBalanceCents: centsString(running),
            lines: entry.lines.map((line: any) => ({
              id: line.id,
              position: line.position,
              accountCode: line.accountCodeSnapshot,
              accountLabel: line.accountLabelSnapshot,
              label: line.label,
              debitCents: centsString(cents(line.debitCents)),
              creditCents: centsString(cents(line.creditCents)),
              counterpartyId: line.counterpartyId ?? null,
              thirdParty: line.thirdParty ?? null,
            })),
          };
        });
        const periodTotals = await accountLineSums(tx, accountId, base);
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          account,
          period: { from: iso(query.range.from), to: iso(query.range.to) },
          openingBalanceCents: centsString(signedBalance(beforeRange)),
          carriedBalanceCents: centsString(carried),
          periodDebitCents: centsString(periodTotals.debitCents),
          periodCreditCents: centsString(periodTotals.creditCents),
          closingBalanceCents: centsString(signedBalance(beforeRange) + signedBalance(periodTotals)),
          items,
          nextCursor: paged.nextCursor,
          pageSize: query.limit,
          draftEntriesExcluded: true,
        };
      });
    },

    async journal(payload: unknown) {
      const query = normalizePagedRange(payload, "journal", (input) => ({
        journalId: requireId(input.journalId, "Le journal"),
      }));
      const journalId = query.filters.journalId as string;
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, query.companyId);
        const journal = await requireJournal(tx, query.companyId, journalId);
        const base = combineWhere(reportableEntryWhere(query.companyId, query.range), { journalId });
        const rows = await tx.entry.findMany({
          where: combineWhere(base, cursorWhere(query.cursor, "asc")),
          orderBy: [{ date: "asc" }, { id: "asc" }],
          take: query.limit + 1,
          include: {
            lines: {
              orderBy: { position: "asc" },
              include: { account: { select: { id: true, code: true, label: true } } },
            },
          },
        });
        const paged = createNextCursor(rows, query.limit, query.scope, "asc");
        const grand = await tx.entryLine.aggregate({
          where: { entry: base },
          _sum: { debitCents: true, creditCents: true },
        });
        const totals = {
          debitCents: cents(grand._sum?.debitCents ?? 0n),
          creditCents: cents(grand._sum?.creditCents ?? 0n),
        };
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          journal,
          period: { from: iso(query.range.from), to: iso(query.range.to) },
          items: paged.page.map(mapJournalEntry),
          totals: {
            debitCents: centsString(totals.debitCents),
            creditCents: centsString(totals.creditCents),
            differenceCents: centsString(totals.debitCents - totals.creditCents),
          },
          balanced: totals.debitCents === totals.creditCents,
          nextCursor: paged.nextCursor,
          pageSize: query.limit,
          draftEntriesExcluded: true,
        };
      });
    },

    async counterpartyStatement(payload: unknown) {
      const query = normalizePagedRange(payload, "counterparty-statement", (input) => ({
        counterpartyId: requireId(input.counterpartyId, "Le tiers"),
      }));
      const counterpartyId = query.filters.counterpartyId as string;
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, query.companyId);
        const counterparty = await requireCounterparty(tx, query.companyId, counterpartyId);
        const base = reportableEntryWhere(query.companyId, query.range);
        const rows = await tx.entry.findMany({
          where: combineWhere(base, { lines: { some: { counterpartyId } } }, cursorWhere(query.cursor, "asc")),
          orderBy: [{ date: "asc" }, { id: "asc" }],
          take: query.limit + 1,
          include: {
            journal: { select: { id: true, code: true, label: true } },
            lines: {
              where: { counterpartyId },
              orderBy: { position: "asc" },
              include: { account: { select: { id: true, code: true, label: true } } },
            },
          },
        });
        const paged = createNextCursor(rows, query.limit, query.scope, "asc");
        const beforeRange = query.range.from
          ? await tx.entryLine.aggregate({
            where: {
              counterpartyId,
              entry: combineWhere(
                { companyId: query.companyId, status: { in: [...LEDGER_ENTRY_STATUSES] } },
                { date: { lt: query.range.from } },
              ),
            },
            _sum: { debitCents: true, creditCents: true },
          })
          : { _sum: { debitCents: 0n, creditCents: 0n } };
        const openingSums = {
          debitCents: cents(beforeRange._sum?.debitCents ?? 0n),
          creditCents: cents(beforeRange._sum?.creditCents ?? 0n),
        };
        let carried = signedBalance(openingSums);
        if (query.cursor) {
          const cursorDate = new Date(query.cursor.date);
          const prior = await tx.entryLine.aggregate({
            where: {
              counterpartyId,
              entry: combineWhere(base, { OR: [{ date: { lt: cursorDate } }, { date: cursorDate, id: { lte: query.cursor.id } }] }),
            },
            _sum: { debitCents: true, creditCents: true },
          });
          carried += cents(prior._sum?.debitCents ?? 0n) - cents(prior._sum?.creditCents ?? 0n);
        }
        let running = carried;
        const items = paged.page.map((entry: any) => {
          const totals = sumLines(entry.lines);
          const movement = signedBalance(totals);
          running += movement;
          return {
            entryId: entry.id,
            entryNumber: entry.number,
            date: iso(entry.date),
            pieceNumber: entry.pieceNumber,
            label: entry.label,
            journal: entry.journal,
            status: entry.status,
            reversalOfId: entry.reversalOfId ?? null,
            debitCents: centsString(totals.debitCents),
            creditCents: centsString(totals.creditCents),
            movementCents: centsString(movement),
            runningBalanceCents: centsString(running),
            lines: entry.lines.map((line: any) => ({
              id: line.id,
              position: line.position,
              label: line.label,
              account: {
                id: line.account.id,
                code: line.accountCodeSnapshot,
                label: line.accountLabelSnapshot,
                currentCode: line.account.code,
                currentLabel: line.account.label,
              },
              debitCents: centsString(cents(line.debitCents)),
              creditCents: centsString(cents(line.creditCents)),
            })),
          };
        });
        const period = await tx.entryLine.aggregate({
          where: { counterpartyId, entry: base },
          _sum: { debitCents: true, creditCents: true },
        });
        const periodSums = { debitCents: cents(period._sum?.debitCents ?? 0n), creditCents: cents(period._sum?.creditCents ?? 0n) };
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          counterparty,
          period: { from: iso(query.range.from), to: iso(query.range.to) },
          openingBalanceCents: centsString(signedBalance(openingSums)),
          carriedBalanceCents: centsString(carried),
          periodDebitCents: centsString(periodSums.debitCents),
          periodCreditCents: centsString(periodSums.creditCents),
          closingBalanceCents: centsString(signedBalance(openingSums) + signedBalance(periodSums)),
          balanceConvention: "DEBIT_MINUS_CREDIT",
          items,
          nextCursor: paged.nextCursor,
          pageSize: query.limit,
          draftEntriesExcluded: true,
        };
      });
    },

    async agedReceivables(payload: unknown) {
      return agedInvoices(payload, "SALE");
    },

    async agedPayables(payload: unknown) {
      return agedInvoices(payload, "PURCHASE");
    },

    async integrityChecks(payload: unknown) {
      const input = record(payload, "La demande de contrôle d'intégrité");
      const companyId = requireId(input.companyId, "La société");
      const requestedMax = input.maxIssues === undefined ? 250 : exactInteger(input.maxIssues, "Le nombre maximal d'anomalies", 1, MAX_ISSUES);
      const prisma = await options.getPrisma();
      return readSnapshot(prisma, async (tx) => {
        const company = await requireCompany(tx, companyId);
        const [entries, invoices, payments, allocations] = await Promise.all([
          tx.entry.findMany({
            where: { companyId },
            orderBy: [{ date: "asc" }, { id: "asc" }],
            include: {
              journal: { select: { id: true, companyId: true, code: true } },
              lines: {
                orderBy: { position: "asc" },
                include: {
                  account: { select: { id: true, companyId: true, code: true } },
                  counterparty: { select: { id: true, companyId: true } },
                },
              },
              reversalOf: { select: { id: true, companyId: true, number: true, date: true, status: true } },
              reversals: { select: { id: true, companyId: true, number: true, date: true, status: true } },
            },
          }),
          tx.invoice.findMany({
            where: { companyId },
            select: {
              id: true, invoiceNo: true, documentType: true, creditedInvoiceId: true,
              lifecycleStatus: true, ttcCents: true, postedEntryId: true, voidEntryId: true,
              artifactRequired: true,
              postedEntry: { select: { id: true, companyId: true, status: true } },
              voidEntry: { select: { id: true, companyId: true, status: true, reversalOfId: true } },
              artifacts: {
                select: { id: true, kind: true, immutable: true, payloadSha256: true, contentSha256: true, byteSize: true },
              },
            },
          }),
          tx.payment.findMany({
            where: { companyId },
            select: {
              id: true, lifecycleStatus: true, amountCents: true, postedEntryId: true, voidEntryId: true,
              postedEntry: { select: { id: true, companyId: true, status: true } },
              voidEntry: { select: { id: true, companyId: true, status: true, reversalOfId: true } },
            },
          }),
          tx.paymentAllocation.findMany({
            where: { payment: { companyId } },
            include: {
              payment: { select: { id: true, companyId: true, amountCents: true, lifecycleStatus: true } },
              invoice: { select: { id: true, companyId: true, documentType: true, ttcCents: true, lifecycleStatus: true } },
            },
          }),
        ]);

        const issues: IntegrityIssue[] = [];
        let errorCount = 0;
        let warningCount = 0;
        const addIssue = (issue: IntegrityIssue) => {
          if (issue.severity === "ERROR") errorCount += 1;
          else warningCount += 1;
          if (issues.length < requestedMax) issues.push(issue);
        };
        const entryMap = new Map<string, any>(entries.map((entry: any) => [entry.id, entry]));
        let ledgerDebit = 0n;
        let ledgerCredit = 0n;
        let draftCount = 0;
        let postedEvidenceCount = 0;

        for (const entry of entries) {
          const sums = sumLines(entry.lines);
          const reportable = (LEDGER_ENTRY_STATUSES as readonly string[]).includes(entry.status);
          if (reportable) {
            postedEvidenceCount += 1;
            ledgerDebit += sums.debitCents;
            ledgerCredit += sums.creditCents;
          } else if (entry.status === "DRAFT") {
            draftCount += 1;
          } else {
            addIssue({ code: "ENTRY_UNKNOWN_STATUS", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'écriture ${entry.number} possède un statut inconnu.` });
          }
          if (entry.journal?.companyId !== companyId) {
            addIssue({ code: "ENTRY_CROSS_COMPANY_JOURNAL", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `Le journal de ${entry.number} appartient à une autre société.` });
          }
          if (entry.lines.length < 2) {
            addIssue({ code: "ENTRY_TOO_FEW_LINES", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'écriture ${entry.number} contient moins de deux lignes.` });
          }
          if (sums.debitCents !== sums.creditCents || (reportable && sums.debitCents === 0n)) {
            addIssue({
              code: "ENTRY_UNBALANCED",
              severity: "ERROR",
              entityType: "Entry",
              entityId: entry.id,
              message: `L'écriture ${entry.number} n'est pas équilibrée.`,
              details: { debitCents: centsString(sums.debitCents), creditCents: centsString(sums.creditCents), differenceCents: centsString(sums.debitCents - sums.creditCents) },
            });
          }
          if (reportable && !entry.postedAt) {
            addIssue({ code: "ENTRY_MISSING_POSTED_AT", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'écriture ${entry.number} est comptabilisée sans horodatage.` });
          }
          if (entry.status === "DRAFT" && entry.postedAt) {
            addIssue({ code: "DRAFT_HAS_POSTED_AT", severity: "WARNING", entityType: "Entry", entityId: entry.id, message: `Le brouillon ${entry.number} possède un horodatage de comptabilisation.` });
          }
          for (const line of entry.lines) {
            const debit = cents(line.debitCents);
            const credit = cents(line.creditCents);
            if (debit < 0n || credit < 0n || (debit > 0n && credit > 0n) || (debit === 0n && credit === 0n)) {
              addIssue({ code: "ENTRY_LINE_INVALID_AMOUNT", severity: "ERROR", entityType: "EntryLine", entityId: line.id, message: `Une ligne de ${entry.number} contient des montants invalides.` });
            }
            if (line.account?.companyId !== companyId) {
              addIssue({ code: "ENTRY_LINE_CROSS_COMPANY_ACCOUNT", severity: "ERROR", entityType: "EntryLine", entityId: line.id, message: `Une ligne de ${entry.number} utilise un compte d'une autre société.` });
            }
            if (line.counterpartyId && line.counterparty?.companyId !== companyId) {
              addIssue({ code: "ENTRY_LINE_CROSS_COMPANY_COUNTERPARTY", severity: "ERROR", entityType: "EntryLine", entityId: line.id, message: `Une ligne de ${entry.number} utilise un tiers d'une autre société.` });
            }
          }
          if (entry.reversalOfId) {
            const original = entryMap.get(entry.reversalOfId) ?? entry.reversalOf;
            if (!original || original.companyId !== companyId) {
              addIssue({ code: "REVERSAL_CROSS_COMPANY_OR_MISSING", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'extourne ${entry.number} ne référence pas une écriture valide de cette société.` });
            } else {
              if (entry.status !== "POSTED") {
                addIssue({ code: "REVERSAL_NOT_POSTED", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'extourne ${entry.number} n'est pas comptabilisée.` });
              }
              if (original.status !== "REVERSED") {
                addIssue({ code: "REVERSAL_ORIGINAL_NOT_REVERSED", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'origine de l'extourne ${entry.number} n'est pas marquée extournée.` });
              }
              if (new Date(entry.date) < new Date(original.date)) {
                addIssue({ code: "REVERSAL_PREDATES_ORIGINAL", severity: "WARNING", entityType: "Entry", entityId: entry.id, message: `L'extourne ${entry.number} est datée avant son écriture d'origine.` });
              }
              const completeOriginal = entryMap.get(original.id);
              if (completeOriginal && !entriesAreExactOpposites(completeOriginal.lines, entry.lines)) {
                addIssue({ code: "REVERSAL_LINES_NOT_OPPOSITE", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `Les lignes de l'extourne ${entry.number} ne compensent pas exactement l'origine.` });
              }
            }
          }
          if (entry.status === "REVERSED") {
            const activeReversals = entry.reversals.filter((row: any) => row.companyId === companyId && row.status === "POSTED");
            if (activeReversals.length !== 1) {
              addIssue({ code: "REVERSED_ENTRY_REVERSAL_COUNT", severity: "ERROR", entityType: "Entry", entityId: entry.id, message: `L'écriture extournée ${entry.number} possède ${activeReversals.length} extourne comptabilisée au lieu d'une.` });
            }
          }
        }

        let legacyInvoiceCount = 0;
        const invoiceMap = new Map<string, any>(invoices.map((invoice: any) => [invoice.id, invoice]));
        const postedCreditsByInvoice = new Map<string, bigint>();
        for (const invoice of invoices) {
          if (invoice.lifecycleStatus === "LEGACY") {
            legacyInvoiceCount += 1;
            continue;
          }
          checkPostedEntityEvidence(addIssue, "Invoice", invoice, companyId);
          if (cents(invoice.ttcCents) < 0n) {
            addIssue({ code: "INVOICE_NEGATIVE_TOTAL", severity: "ERROR", entityType: "Invoice", entityId: invoice.id, message: "Une facture possède un total TTC négatif." });
          }
          if (invoice.documentType === "CREDIT_NOTE") {
            const original = invoice.creditedInvoiceId ? invoiceMap.get(invoice.creditedInvoiceId) : null;
            if (!original || original.documentType !== "INVOICE") {
              addIssue({ code: "CREDIT_NOTE_ORIGINAL_INVALID", severity: "ERROR", entityType: "Invoice", entityId: invoice.id, message: `L'avoir ${invoice.invoiceNo} ne référence pas une facture d'origine valide.` });
            } else if (invoice.lifecycleStatus === "POSTED") {
              postedCreditsByInvoice.set(original.id, (postedCreditsByInvoice.get(original.id) ?? 0n) + cents(invoice.ttcCents));
            }
          } else if (invoice.documentType !== "INVOICE") {
            addIssue({ code: "INVOICE_UNKNOWN_DOCUMENT_TYPE", severity: "ERROR", entityType: "Invoice", entityId: invoice.id, message: `Le document ${invoice.invoiceNo} possède un type inconnu.` });
          }
          if (invoice.lifecycleStatus === "POSTED" && invoice.artifactRequired) {
            const validArtifacts = invoice.artifacts.filter((artifact: any) =>
              artifact.immutable && artifact.payloadSha256 && artifact.contentSha256 && cents(artifact.byteSize) > 0n,
            );
            if (validArtifacts.length === 0) {
              addIssue({ code: "POSTED_INVOICE_ARTIFACT_MISSING", severity: "ERROR", entityType: "Invoice", entityId: invoice.id, message: `Le document comptabilisé ${invoice.invoiceNo} ne conserve aucun artefact PDF immuable complet.` });
            }
          }
        }
        for (const payment of payments) {
          checkPostedEntityEvidence(addIssue, "Payment", payment, companyId);
          if (cents(payment.amountCents) <= 0n) {
            addIssue({ code: "PAYMENT_NON_POSITIVE_AMOUNT", severity: "ERROR", entityType: "Payment", entityId: payment.id, message: "Un paiement possède un montant nul ou négatif." });
          }
        }

        const activeByPayment = new Map<string, bigint>();
        const activeByInvoice = new Map<string, bigint>();
        for (const allocation of allocations) {
          const amount = cents(allocation.amountCents);
          if (allocation.payment.companyId !== companyId || allocation.invoice.companyId !== companyId) {
            addIssue({ code: "ALLOCATION_CROSS_COMPANY", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation relie des données de sociétés différentes." });
          }
          if (amount <= 0n) {
            addIssue({ code: "ALLOCATION_NON_POSITIVE_AMOUNT", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation possède un montant nul ou négatif." });
          }
          if (allocation.status === "ACTIVE") {
            activeByPayment.set(allocation.paymentId, (activeByPayment.get(allocation.paymentId) ?? 0n) + amount);
            activeByInvoice.set(allocation.invoiceId, (activeByInvoice.get(allocation.invoiceId) ?? 0n) + amount);
            if (!["POSTED", "LEGACY"].includes(allocation.payment.lifecycleStatus)) {
              addIssue({ code: "ACTIVE_ALLOCATION_PAYMENT_NOT_POSTED", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation active dépend d'un paiement non comptabilisé." });
            }
            if (!["POSTED", "LEGACY"].includes(allocation.invoice.lifecycleStatus)) {
              addIssue({ code: "ACTIVE_ALLOCATION_INVOICE_NOT_POSTED", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation active dépend d'une facture non comptabilisée." });
            }
            if (allocation.invoice.documentType !== "INVOICE") {
              addIssue({ code: "ACTIVE_ALLOCATION_CREDIT_NOTE", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation active cible un avoir au lieu d'une facture." });
            }
          } else if (allocation.status === "REVERSED" && (!allocation.reversedAt || !allocation.reversalReason)) {
            addIssue({ code: "REVERSED_ALLOCATION_MISSING_EVIDENCE", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation annulée ne conserve pas tout son motif et horodatage." });
          } else if (allocation.status !== "REVERSED") {
            addIssue({ code: "ALLOCATION_UNKNOWN_STATUS", severity: "ERROR", entityType: "PaymentAllocation", entityId: allocation.id, message: "Une imputation possède un statut inconnu." });
          }
        }
        const paymentMap = new Map<string, any>(payments.map((payment: any) => [payment.id, payment]));
        for (const [paymentId, allocated] of activeByPayment) {
          const payment = paymentMap.get(paymentId);
          if (payment && allocated > cents(payment.amountCents)) {
            addIssue({ code: "PAYMENT_OVERALLOCATED", severity: "ERROR", entityType: "Payment", entityId: paymentId, message: "Les imputations actives dépassent le montant du paiement.", details: { allocatedCents: centsString(allocated), amountCents: centsString(cents(payment.amountCents)) } });
          }
        }
        const settlementInvoiceIds = new Set([...activeByInvoice.keys(), ...postedCreditsByInvoice.keys()]);
        for (const invoiceId of settlementInvoiceIds) {
          const allocated = activeByInvoice.get(invoiceId) ?? 0n;
          const credited = postedCreditsByInvoice.get(invoiceId) ?? 0n;
          const invoice = invoiceMap.get(invoiceId);
          if (invoice?.documentType === "INVOICE" && allocated + credited > cents(invoice.ttcCents)) {
            addIssue({ code: "INVOICE_OVERSETTLED", severity: "ERROR", entityType: "Invoice", entityId: invoiceId, message: "Les paiements actifs et avoirs comptabilisés dépassent le total TTC de la facture.", details: { allocatedCents: centsString(allocated), creditedCents: centsString(credited), settledCents: centsString(allocated + credited), ttcCents: centsString(cents(invoice.ttcCents)) } });
          }
        }

        if (ledgerDebit !== ledgerCredit) {
          addIssue({
            code: "COMPANY_LEDGER_UNBALANCED",
            severity: "ERROR",
            entityType: "Company",
            entityId: companyId,
            message: "Le grand livre comptabilisé de la société n'est pas équilibré.",
            details: { debitCents: centsString(ledgerDebit), creditCents: centsString(ledgerCredit), differenceCents: centsString(ledgerDebit - ledgerCredit) },
          });
        }
        return {
          company: { id: company.id, name: company.name, currency: company.baseCurrency },
          checkedAt: now().toISOString(),
          status: errorCount > 0 ? "ERRORS" : warningCount > 0 ? "WARNINGS" : "OK",
          summary: {
            errorCount,
            warningCount,
            entryCount: entries.length,
            postedEvidenceCount,
            draftCount,
            invoiceCount: invoices.length,
            legacyInvoiceCount,
            paymentCount: payments.length,
            allocationCount: allocations.length,
            ledgerDebitCents: centsString(ledgerDebit),
            ledgerCreditCents: centsString(ledgerCredit),
            ledgerDifferenceCents: centsString(ledgerDebit - ledgerCredit),
          },
          issues,
          issuesTruncated: errorCount + warningCount > issues.length,
          maxIssues: requestedMax,
        };
      });
    },
  };
}

function aggregateLineSignatures(lines: any[]): Map<string, ExactSums> {
  const result = new Map<string, ExactSums>();
  for (const line of lines) {
    const key = JSON.stringify([line.accountId, line.counterpartyId ?? null, line.thirdParty ?? null]);
    const current = result.get(key) ?? { debitCents: 0n, creditCents: 0n };
    current.debitCents += cents(line.debitCents);
    current.creditCents += cents(line.creditCents);
    result.set(key, current);
  }
  return result;
}

export function entriesAreExactOpposites(originalLines: any[], reversalLines: any[]): boolean {
  const original = aggregateLineSignatures(originalLines);
  const reversal = aggregateLineSignatures(reversalLines);
  if (original.size !== reversal.size) return false;
  for (const [key, source] of original) {
    const opposite = reversal.get(key);
    if (!opposite || source.debitCents !== opposite.creditCents || source.creditCents !== opposite.debitCents) return false;
  }
  return true;
}

function checkPostedEntityEvidence(
  addIssue: (issue: IntegrityIssue) => void,
  entityType: "Invoice" | "Payment",
  entity: any,
  companyId: string,
) {
  const prefix = entityType.toUpperCase();
  if (entity.lifecycleStatus === "LEGACY") return;
  if (entity.lifecycleStatus === "DRAFT") {
    if (entity.postedEntryId || entity.voidEntryId) {
      addIssue({ code: `${prefix}_DRAFT_HAS_LEDGER_LINK`, severity: "ERROR", entityType, entityId: entity.id, message: `Un brouillon ${entityType === "Invoice" ? "de facture" : "de paiement"} possède un lien comptable.` });
    }
    return;
  }
  if (!entity.postedEntry || entity.postedEntry.companyId !== companyId || !(LEDGER_ENTRY_STATUSES as readonly string[]).includes(entity.postedEntry.status)) {
    addIssue({ code: `${prefix}_MISSING_POSTED_EVIDENCE`, severity: "ERROR", entityType, entityId: entity.id, message: `Un ${entityType === "Invoice" ? "facture" : "paiement"} comptabilisé ne possède pas d'écriture d'origine valide.` });
  }
  if (entity.lifecycleStatus === "POSTED") {
    if (entity.voidEntryId) {
      addIssue({ code: `${prefix}_POSTED_HAS_VOID_LINK`, severity: "ERROR", entityType, entityId: entity.id, message: `Un ${entityType === "Invoice" ? "facture" : "paiement"} actif possède déjà une écriture d'annulation.` });
    }
    return;
  }
  if (entity.lifecycleStatus === "VOIDED") {
    if (!entity.voidEntry || entity.voidEntry.companyId !== companyId || entity.voidEntry.status !== "POSTED" || entity.voidEntry.reversalOfId !== entity.postedEntryId) {
      addIssue({ code: `${prefix}_INVALID_VOID_EVIDENCE`, severity: "ERROR", entityType, entityId: entity.id, message: `L'annulation d'un ${entityType === "Invoice" ? "facture" : "paiement"} ne possède pas une extourne valide.` });
    }
    return;
  }
  addIssue({ code: `${prefix}_UNKNOWN_LIFECYCLE`, severity: "ERROR", entityType, entityId: entity.id, message: `Un ${entityType === "Invoice" ? "facture" : "paiement"} possède un état de cycle de vie inconnu.` });
}

type AgingKind = "SALE" | "PURCHASE";

type AgingOptions = {
  companyId: string;
  kind: AgingKind;
  currency: string;
  asOf: Date;
};

type AgingBucket = "currentCents" | "days1To30Cents" | "days31To60Cents" | "days61To90Cents" | "over90DaysCents";

function validEntryAtCutoff(entry: any, companyId: string, cutoffExclusive: Date): boolean {
  if (!entry || entry.companyId !== companyId || !(LEDGER_ENTRY_STATUSES as readonly string[]).includes(entry.status)) return false;
  const date = new Date(entry.date);
  return !Number.isNaN(date.getTime()) && date < cutoffExclusive;
}

function bucketFor(dueDate: Date, asOf: Date): AgingBucket {
  const dueDay = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const asOfDay = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const days = Math.floor((asOfDay - dueDay) / DAY_MS);
  if (days <= 0) return "currentCents";
  if (days <= 30) return "days1To30Cents";
  if (days <= 60) return "days31To60Cents";
  if (days <= 90) return "days61To90Cents";
  return "over90DaysCents";
}

function blankAgingBuckets(): Record<AgingBucket, bigint> {
  return { currentCents: 0n, days1To30Cents: 0n, days31To60Cents: 0n, days61To90Cents: 0n, over90DaysCents: 0n };
}

function stringifyAgingBuckets(buckets: Record<AgingBucket, bigint>) {
  return {
    currentCents: centsString(buckets.currentCents),
    days1To30Cents: centsString(buckets.days1To30Cents),
    days31To60Cents: centsString(buckets.days31To60Cents),
    days61To90Cents: centsString(buckets.days61To90Cents),
    over90DaysCents: centsString(buckets.over90DaysCents),
  };
}

/**
 * Derives aging from immutable posting/reversal evidence. Allocation creation
 * Allocation creation uses its recorded timestamp; 1.4 reversal events use
 * their explicit accounting date. Linked posted credit notes reduce the open
 * balance at their own ledger posting date.
 */
export function deriveAgingReport(invoices: any[], options: AgingOptions) {
  const cutoffExclusive = nextUtcDay(options.asOf);
  const rows: any[] = [];
  const totals = blankAgingBuckets();
  const counterparties = new Map<string, {
    counterpartyId: string;
    displayName: string;
    buckets: Record<AgingBucket, bigint>;
    outstandingCents: bigint;
    invoiceCount: number;
  }>();
  let originalCents = 0n;
  let allocatedCents = 0n;
  let outstandingCents = 0n;
  let overpaidCents = 0n;
  let legacyExcludedCount = 0;
  let invalidEvidenceExcludedCount = 0;
  let missingDueDateExcludedCount = 0;
  let missingDueDateOutstandingCents = 0n;
  let voidedAtCutoffCount = 0;

  for (const invoice of invoices) {
    if (invoice.lifecycleStatus === "LEGACY") {
      legacyExcludedCount += 1;
      continue;
    }
    if (invoice.companyId !== options.companyId || invoice.kind !== options.kind || invoice.currency !== options.currency) {
      invalidEvidenceExcludedCount += 1;
      continue;
    }
    if (!invoice.counterpartyId || !invoice.counterpartyModel || invoice.counterpartyModel.id !== invoice.counterpartyId) {
      invalidEvidenceExcludedCount += 1;
      continue;
    }
    if (!validEntryAtCutoff(invoice.postedEntry, options.companyId, cutoffExclusive)) continue;
    const invoiceHasVoid = Boolean(invoice.voidEntry);
    const invoiceVoidValid = invoiceHasVoid
      && invoice.voidEntry.companyId === options.companyId
      && invoice.voidEntry.status === "POSTED"
      && invoice.voidEntry.reversalOfId === invoice.postedEntry.id;
    if ((invoice.lifecycleStatus === "VOIDED" && !invoiceVoidValid) || (invoice.lifecycleStatus === "POSTED" && invoiceHasVoid)) {
      invalidEvidenceExcludedCount += 1;
      continue;
    }
    if (invoiceVoidValid && validEntryAtCutoff(invoice.voidEntry, options.companyId, cutoffExclusive)) {
      voidedAtCutoffCount += 1;
      continue;
    }
    const total = cents(invoice.ttcCents, "Le total TTC de facture");
    if (total < 0n) {
      invalidEvidenceExcludedCount += 1;
      continue;
    }
    let allocated = 0n;
    for (const allocation of invoice.allocations ?? []) {
      const createdAt = new Date(allocation.createdAt);
      const reversalAtValue = allocation.reversalAccountingDate ?? allocation.reversedAt;
      const reversedAt = reversalAtValue ? new Date(reversalAtValue) : null;
      if (Number.isNaN(createdAt.getTime()) || createdAt >= cutoffExclusive) continue;
      if (reversedAt && Number.isNaN(reversedAt.getTime())) continue;
      if (reversedAt && reversedAt < cutoffExclusive) continue;
      const payment = allocation.payment;
      if (!payment || payment.companyId !== options.companyId || payment.currency !== options.currency) continue;
      if (!validEntryAtCutoff(payment.postedEntry, options.companyId, cutoffExclusive)) continue;
      const paymentHasVoid = Boolean(payment.voidEntry);
      const paymentVoidValid = paymentHasVoid
        && payment.voidEntry.companyId === options.companyId
        && payment.voidEntry.status === "POSTED"
        && payment.voidEntry.reversalOfId === payment.postedEntry.id;
      if ((payment.lifecycleStatus === "VOIDED" && !paymentVoidValid) || (payment.lifecycleStatus === "POSTED" && paymentHasVoid)) continue;
      if (paymentVoidValid && validEntryAtCutoff(payment.voidEntry, options.companyId, cutoffExclusive)) continue;
      const amount = cents(allocation.amountCents, "Le montant d'imputation");
      if (amount > 0n) allocated += amount;
    }
    for (const creditNote of invoice.creditNotes ?? []) {
      if (creditNote.companyId !== options.companyId
        || creditNote.creditedInvoiceId !== invoice.id
        || creditNote.documentType !== "CREDIT_NOTE"
        || creditNote.kind !== invoice.kind
        || creditNote.currency !== options.currency
        || creditNote.lifecycleStatus !== "POSTED") continue;
      if (!validEntryAtCutoff(creditNote.postedEntry, options.companyId, cutoffExclusive)) continue;
      const creditHasVoid = Boolean(creditNote.voidEntry);
      const creditVoidValid = creditHasVoid
        && creditNote.voidEntry.companyId === options.companyId
        && creditNote.voidEntry.status === "POSTED"
        && creditNote.voidEntry.reversalOfId === creditNote.postedEntry.id;
      if (creditHasVoid && !creditVoidValid) continue;
      if (creditVoidValid && validEntryAtCutoff(creditNote.voidEntry, options.companyId, cutoffExclusive)) continue;
      const amount = cents(creditNote.ttcCents, "Le montant TTC de l'avoir");
      if (amount > 0n) allocated += amount;
    }
    const rawOutstanding = total - allocated;
    originalCents += total;
    allocatedCents += allocated;
    if (rawOutstanding <= 0n) {
      if (rawOutstanding < 0n) overpaidCents += -rawOutstanding;
      continue;
    }
    if (!invoice.dueDate) {
      missingDueDateExcludedCount += 1;
      missingDueDateOutstandingCents += rawOutstanding;
      continue;
    }
    const dueDate = new Date(invoice.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      invalidEvidenceExcludedCount += 1;
      continue;
    }
    const bucket = bucketFor(dueDate, options.asOf);
    totals[bucket] += rawOutstanding;
    outstandingCents += rawOutstanding;
    const daysPastDue = Math.max(0, Math.floor((Date.UTC(options.asOf.getUTCFullYear(), options.asOf.getUTCMonth(), options.asOf.getUTCDate()) - Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate())) / DAY_MS));
    rows.push({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      counterpartyId: invoice.counterpartyId,
      counterpartyName: invoice.counterpartyModel.displayName,
      invoiceDate: iso(invoice.invoiceDate),
      dueDate: iso(dueDate),
      daysPastDue,
      bucket: bucket.replace(/Cents$/, ""),
      originalCents: centsString(total),
      allocatedCents: centsString(allocated),
      outstandingCents: centsString(rawOutstanding),
    });
    const counterparty = counterparties.get(invoice.counterpartyId) ?? {
      counterpartyId: invoice.counterpartyId,
      displayName: invoice.counterpartyModel.displayName,
      buckets: blankAgingBuckets(),
      outstandingCents: 0n,
      invoiceCount: 0,
    };
    counterparty.buckets[bucket] += rawOutstanding;
    counterparty.outstandingCents += rawOutstanding;
    counterparty.invoiceCount += 1;
    counterparties.set(invoice.counterpartyId, counterparty);
  }

  rows.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.invoiceId.localeCompare(right.invoiceId));
  return {
    reportType: options.kind === "SALE" ? "AGED_RECEIVABLES" : "AGED_PAYABLES",
    asOf: options.asOf.toISOString().slice(0, 10),
    currency: options.currency,
    rows,
    counterparties: [...counterparties.values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.counterpartyId.localeCompare(right.counterpartyId))
      .map((row) => ({
        counterpartyId: row.counterpartyId,
        displayName: row.displayName,
        invoiceCount: row.invoiceCount,
        outstandingCents: centsString(row.outstandingCents),
        ...stringifyAgingBuckets(row.buckets),
      })),
    totals: {
      originalCents: centsString(originalCents),
      allocatedCents: centsString(allocatedCents),
      outstandingCents: centsString(outstandingCents),
      overpaidCents: centsString(overpaidCents),
      ...stringifyAgingBuckets(totals),
    },
    exclusions: { legacyExcludedCount, invalidEvidenceExcludedCount, missingDueDateExcludedCount, missingDueDateOutstandingCents: centsString(missingDueDateOutstandingCents), voidedAtCutoffCount },
    cutoffSemantics: {
      ledgerEvidenceByAccountingDate: true,
      allocationCreationByRecordedTimestamp: true,
      allocationReversalByAccountingDateWhenAvailable: true,
      linkedCreditNotesByPostedEntryDate: true,
      cutoffDayInclusive: true,
      draftsExcluded: true,
    },
  };
}

export function registerReportingIpc(options: ReportingRegistrationOptions) {
  const service = createReportingService(options);
  const serialize = options.serialize ?? rendererSerialize;
  const bind = (channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  };
  bind(REPORTING_IPC_CHANNELS.entryQuery, service.queryEntries);
  bind(REPORTING_IPC_CHANNELS.entryDetail, service.getEntryDetail);
  bind(REPORTING_IPC_CHANNELS.trialBalance, service.trialBalance);
  bind(REPORTING_IPC_CHANNELS.generalLedger, service.generalLedger);
  bind(REPORTING_IPC_CHANNELS.journal, service.journal);
  bind(REPORTING_IPC_CHANNELS.agedReceivables, service.agedReceivables);
  bind(REPORTING_IPC_CHANNELS.agedPayables, service.agedPayables);
  bind(REPORTING_IPC_CHANNELS.counterpartyStatement, service.counterpartyStatement);
  bind(REPORTING_IPC_CHANNELS.integrityChecks, service.integrityChecks);
  return service;
}

export type ReportingService = ReturnType<typeof createReportingService>;
