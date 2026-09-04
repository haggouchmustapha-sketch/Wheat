import { rendererSerialize, requireId } from "./accounting";
import { PCGE_SOURCE } from "./pcgeData";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const REPORTING_21_CHANNELS = {
  balanceFamily: "wheat:balance-family",
  bankTotal: "wheat:bank-total",
  bilan: "wheat:bilan",
} as const;

export const BALANCE_VIEWS = [
  "GENERAL", "CUMULATIVE", "OPENING", "PRE_INVENTORY", "POST_INVENTORY", "POST_CLOSING",
  "AUXILIARY_CUSTOMERS", "AUXILIARY_SUPPLIERS", "AGED_CUSTOMERS", "AGED_SUPPLIERS",
  "BY_JOURNAL", "BY_PERIOD", "COMPARATIVE", "ANALYTICAL",
] as const;

const MAX_REPORT_LINES = 100_000;

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Les filtres du rapport sont invalides.");
  return value as Record<string, any>;
}

function day(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} doit utiliser AAAA-MM-JJ.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} est invalide.`);
  return date;
}

function cents(value: unknown) {
  return BigInt(value as bigint | string | number);
}

function debitCredit(balance: bigint) {
  return { debitBalanceCents: balance > 0n ? balance : 0n, creditBalanceCents: balance < 0n ? -balance : 0n };
}

type ReportLine = {
  id: string;
  debitCents: bigint;
  creditCents: bigint;
  entry: { id: string; date: Date; status: string; source: string; journalId: string; journal: { code: string; label: string } };
  account: { id: string; code: string; label: string; classNo: number; type: string; category: string; parentCode: string | null; reportNature: string | null };
  counterparty?: { id: string; displayName: string; kind: string } | null;
  thirdParty?: string | null;
};

type BalanceGroup = {
  key: string;
  code: string;
  label: string;
  accountId: string;
  classNo: number;
  openingDebitCents: bigint;
  openingCreditCents: bigint;
  periodDebitCents: bigint;
  periodCreditCents: bigint;
  entryLineIds: string[];
};

type BilanGroup = {
  key: string;
  side: "ACTIF" | "PASSIF";
  code: string;
  label: string;
  amountCents: bigint;
  entryLineIds: string[];
};

async function reportLines(prisma: PrismaLike, companyId: string, to: Date, statuses: string[], journalIds?: string[]) {
  const lines = await prisma.entryLine.findMany({
    where: {
      entry: {
        companyId,
        date: { lte: to },
        status: { in: statuses },
        ...(journalIds?.length ? { journalId: { in: journalIds } } : {}),
      },
    },
    include: {
      entry: { include: { journal: true } },
      account: true,
      counterparty: true,
    },
    orderBy: [{ account: { code: "asc" } }, { entry: { date: "asc" } }, { position: "asc" }],
    take: MAX_REPORT_LINES + 1,
  });
  if (lines.length > MAX_REPORT_LINES) throw new Error(`Le rapport dépasse ${MAX_REPORT_LINES.toLocaleString("fr-FR")} lignes. Réduisez la période ou les journaux.`);
  return lines as ReportLine[];
}

function groupBalance(lines: ReportLine[], start: Date, view: string) {
  const groups = new Map<string, BalanceGroup>();
  for (const line of lines) {
    const date = new Date(line.entry.date);
    const inPeriod = date >= start;
    if (view === "OPENING" && inPeriod) continue;
    if (view === "PRE_INVENTORY" && /INVENTORY|INVENTAIRE|ADJUST/i.test(line.entry.source)) continue;
    if (view === "ANALYTICAL" && line.account.classNo !== 9) continue;
    if (view !== "ANALYTICAL" && line.account.classNo === 9) continue;

    let key = line.account.id;
    let code = line.account.code;
    let label = line.account.label;
    if (view === "BY_JOURNAL") {
      key = `${line.entry.journalId}:${line.account.id}`;
      code = `${line.entry.journal.code}/${line.account.code}`;
      label = `${line.entry.journal.label} · ${line.account.label}`;
    } else if (view === "BY_PERIOD") {
      const month = date.toISOString().slice(0, 7);
      key = `${month}:${line.account.id}`;
      code = `${month}/${line.account.code}`;
      label = `${month} · ${line.account.label}`;
    } else if (view === "AUXILIARY_CUSTOMERS" || view === "AUXILIARY_SUPPLIERS") {
      const expectedPrefix = view === "AUXILIARY_CUSTOMERS" ? "34" : "44";
      if (!line.account.code.startsWith(expectedPrefix)) continue;
      const party = line.counterparty?.displayName || line.thirdParty || "Tiers non renseigné";
      key = `${line.account.id}:${party}`;
      code = line.account.code;
      label = `${line.account.label} · ${party}`;
    }
    const current: BalanceGroup = groups.get(key) ?? {
      key, code, label, accountId: line.account.id, classNo: line.account.classNo,
      openingDebitCents: 0n, openingCreditCents: 0n, periodDebitCents: 0n, periodCreditCents: 0n,
      entryLineIds: [] as string[],
    };
    if (inPeriod) {
      current.periodDebitCents += cents(line.debitCents);
      current.periodCreditCents += cents(line.creditCents);
    } else {
      current.openingDebitCents += cents(line.debitCents);
      current.openingCreditCents += cents(line.creditCents);
    }
    current.entryLineIds.push(line.id);
    groups.set(key, current);
  }
  return [...groups.values()].map((row) => {
    const opening = row.openingDebitCents - row.openingCreditCents;
    const cumulative = opening + row.periodDebitCents - row.periodCreditCents;
    return {
      ...row,
      ...debitCredit(cumulative),
      openingBalanceCents: opening,
      cumulativeBalanceCents: cumulative,
      movementCount: row.entryLineIds.length,
    };
  }).sort((left, right) => left.code.localeCompare(right.code, "fr", { numeric: true }));
}

export async function buildBalanceFamily(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const view = String(payload.view ?? "GENERAL").toUpperCase();
  if (!(BALANCE_VIEWS as readonly string[]).includes(view)) throw new Error("Le type de balance est inconnu.");
  const to = day(payload.to, "La date de fin");
  const fiscalYear = await prisma.fiscalYear.findFirst({ where: { companyId, startsOn: { lte: to }, endsOn: { gte: to } }, orderBy: { startsOn: "desc" } });
  if (!fiscalYear) throw new Error("Aucun exercice ne couvre la date du rapport.");
  const start = payload.from ? day(payload.from, "La date de début") : fiscalYear.startsOn;
  if (start > to) throw new Error("La période du rapport est inversée.");
  const statuses = Array.isArray(payload.statuses) && payload.statuses.length ? payload.statuses.map(String) : ["POSTED", "REVERSED"];
  const journalIds = Array.isArray(payload.journalIds) ? payload.journalIds.map(String).slice(0, 100) : undefined;
  const lines = await reportLines(prisma, companyId, to, statuses, journalIds);
  let rows = groupBalance(lines, start, view === "AGED_CUSTOMERS" ? "AUXILIARY_CUSTOMERS" : view === "AGED_SUPPLIERS" ? "AUXILIARY_SUPPLIERS" : view);
  let comparative: Record<string, any> | null = null;
  if (view === "COMPARATIVE") {
    const previousFiscalYear = await prisma.fiscalYear.findFirst({ where: { companyId, endsOn: { lt: fiscalYear.startsOn } }, orderBy: { endsOn: "desc" } });
    if (previousFiscalYear) {
      const elapsedDays = Math.max(0, Math.floor((to.getTime() - start.getTime()) / 86_400_000));
      const previousTo = new Date(Math.min(previousFiscalYear.endsOn.getTime(), previousFiscalYear.startsOn.getTime() + elapsedDays * 86_400_000));
      const previousRows = groupBalance(await reportLines(prisma, companyId, previousTo, statuses, journalIds), previousFiscalYear.startsOn, "GENERAL");
      const currentByAccount = new Map(rows.map((row) => [row.accountId, row]));
      const previousByAccount = new Map(previousRows.map((row) => [row.accountId, row]));
      const accountIds = new Set([...currentByAccount.keys(), ...previousByAccount.keys()]);
      rows = [...accountIds].map((accountId) => {
        const current = currentByAccount.get(accountId);
        const previous = previousByAccount.get(accountId);
        const base = (current ?? previous)!;
        const currentBalance = current?.cumulativeBalanceCents ?? 0n;
        const previousBalance = previous?.cumulativeBalanceCents ?? 0n;
        return {
          ...base,
          openingDebitCents: current?.openingDebitCents ?? 0n,
          openingCreditCents: current?.openingCreditCents ?? 0n,
          periodDebitCents: current?.periodDebitCents ?? 0n,
          periodCreditCents: current?.periodCreditCents ?? 0n,
          openingBalanceCents: current?.openingBalanceCents ?? 0n,
          cumulativeBalanceCents: currentBalance,
          ...debitCredit(currentBalance),
          priorPeriodDebitCents: previous?.periodDebitCents ?? 0n,
          priorPeriodCreditCents: previous?.periodCreditCents ?? 0n,
          priorBalanceCents: previousBalance,
          varianceCents: currentBalance - previousBalance,
          entryLineIds: current?.entryLineIds ?? [],
          movementCount: current?.movementCount ?? 0,
        };
      }).sort((left, right) => left.code.localeCompare(right.code, "fr", { numeric: true }));
      comparative = { previousFiscalYear: { id: previousFiscalYear.id, label: previousFiscalYear.label }, from: previousFiscalYear.startsOn.toISOString().slice(0, 10), to: previousTo.toISOString().slice(0, 10) };
    } else comparative = { unavailable: true, reason: "Aucun exercice N−1 n'est disponible dans le dossier." };
  }
  if (payload.classNo !== undefined && payload.classNo !== "") rows = rows.filter((row) => row.classNo === Number(payload.classNo));
  if (payload.accountFrom) rows = rows.filter((row) => row.code >= String(payload.accountFrom));
  if (payload.accountTo) rows = rows.filter((row) => row.code <= String(payload.accountTo));
  if (payload.includeZero !== true) rows = rows.filter((row) => row.cumulativeBalanceCents !== 0n || row.periodDebitCents !== 0n || row.periodCreditCents !== 0n);
  const totals = rows.reduce((sum, row) => ({
    openingDebitCents: sum.openingDebitCents + row.openingDebitCents,
    openingCreditCents: sum.openingCreditCents + row.openingCreditCents,
    periodDebitCents: sum.periodDebitCents + row.periodDebitCents,
    periodCreditCents: sum.periodCreditCents + row.periodCreditCents,
    debitBalanceCents: sum.debitBalanceCents + row.debitBalanceCents,
    creditBalanceCents: sum.creditBalanceCents + row.creditBalanceCents,
  }), { openingDebitCents: 0n, openingCreditCents: 0n, periodDebitCents: 0n, periodCreditCents: 0n, debitBalanceCents: 0n, creditBalanceCents: 0n });
  if (view === "COMPARATIVE" && comparative) {
    const comparisonTotals = rows.reduce((sum, row: any) => ({ priorBalanceCents: sum.priorBalanceCents + (row.priorBalanceCents ?? 0n), varianceCents: sum.varianceCents + (row.varianceCents ?? 0n) }), { priorBalanceCents: 0n, varianceCents: 0n });
    comparative = { ...comparative, totals: comparisonTotals };
  }
  return {
    reportType: "BALANCE_FAMILY",
    view,
    fiscalYear: { id: fiscalYear.id, label: fiscalYear.label },
    filters: { from: start.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), statuses, journalIds: journalIds ?? [] },
    rows,
    totals,
    balanced: totals.periodDebitCents === totals.periodCreditCents,
    exactUnit: "CENTIME",
    comparative,
    generatedAt: new Date(),
    ...(view.startsWith("AGED_") ? { note: "Les échéances détaillées restent disponibles dans les rapports âgés du sous-livre." } : {}),
  };
}

export async function buildBankTotal(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const asOf = payload.asOf ? day(payload.asOf, "La date d'arrêté") : new Date();
  const accounts = await prisma.bankAccount.findMany({
    where: { companyId, active: true },
    include: {
      ledgerAccount: true,
      statements: { where: { status: "ACTIVE", endsOn: { lte: asOf } }, orderBy: [{ endsOn: "desc" }, { importedAt: "desc" }], take: 1 },
    },
    orderBy: { bankName: "asc" },
  });
  const rows = [];
  for (const bank of accounts) {
    const ledger = bank.ledgerAccountId ? await prisma.entryLine.aggregate({
      where: { accountId: bank.ledgerAccountId, entry: { companyId, status: { in: ["POSTED", "REVERSED"] }, date: { lte: asOf } } },
      _sum: { debitCents: true, creditCents: true },
    }) : null;
    const accountingCents = cents(ledger?._sum?.debitCents ?? 0) - cents(ledger?._sum?.creditCents ?? 0);
    const statement = bank.statements[0];
    const bankCents = statement?.closingBalanceCents === null || statement?.closingBalanceCents === undefined ? null : cents(statement.closingBalanceCents);
    rows.push({
      bankAccountId: bank.id,
      bankName: bank.bankName,
      currency: bank.currency,
      ledgerAccountCode: bank.ledgerAccount?.code ?? null,
      accountingCents,
      bankCents,
      differenceCents: bankCents === null ? null : bankCents - accountingCents,
      bankBalanceAsOf: statement?.endsOn ?? bank.balanceAsOf,
      source: statement ? "LATEST_IMPORTED_STATEMENT" : bank.balanceSource,
    });
  }
  const totalsByCurrency = Object.values(rows.reduce((groups: Record<string, any>, row) => {
    const current = groups[row.currency] ?? { currency: row.currency, accountingCents: 0n, bankCents: 0n, bankBalanceComplete: true };
    current.accountingCents += row.accountingCents;
    if (row.bankCents === null) current.bankBalanceComplete = false;
    else current.bankCents += row.bankCents;
    groups[row.currency] = current;
    return groups;
  }, {}));
  return { asOf, rows, totalsByCurrency, mixedCurrency: totalsByCurrency.length > 1, exactUnit: "CENTIME" };
}

function bilanRows(lines: ReportLine[], variant: "NORMAL" | "SIMPLIFIED") {
  const depth = variant === "NORMAL" ? 3 : 2;
  const groups = new Map<string, BilanGroup>();
  let resultFromSixSeven = 0n;
  let resultFromEight = 0n;
  for (const line of lines) {
    const netDebit = cents(line.debitCents) - cents(line.creditCents);
    if (line.account.classNo === 6 || line.account.classNo === 7) resultFromSixSeven -= netDebit;
    if (line.account.classNo === 8) resultFromEight -= netDebit;
    if (line.account.reportNature !== "BALANCE_SHEET") continue;
    const side = line.account.type === "ASSET" ? "ACTIF" : ["LIABILITY", "EQUITY"].includes(line.account.type) ? "PASSIF" : null;
    if (!side) continue;
    const code = line.account.code.slice(0, Math.min(depth, line.account.code.length));
    const key = `${side}:${code}`;
    const current: BilanGroup = groups.get(key) ?? { key, side, code, label: line.account.label, amountCents: 0n, entryLineIds: [] };
    current.amountCents += side === "ACTIF" ? netDebit : -netDebit;
    current.entryLineIds.push(line.id);
    groups.set(key, current);
  }
  const result = resultFromEight !== 0n ? resultFromEight : resultFromSixSeven;
  if (result !== 0n) {
    const side = result >= 0n ? "PASSIF" : "ACTIF";
    groups.set(`${side}:RESULT`, { key: `${side}:RESULT`, side, code: "RESULT", label: result >= 0n ? "Résultat net de l'exercice (bénéfice)" : "Résultat net de l'exercice (perte)", amountCents: result >= 0n ? result : -result, entryLineIds: [] });
  }
  return [...groups.values()].filter((row) => row.amountCents !== 0n).sort((left, right) => left.side.localeCompare(right.side) || left.code.localeCompare(right.code, "fr", { numeric: true }));
}

export async function buildBilan(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const asOf = day(payload.asOf, "La date d'arrêté");
  const variant = String(payload.variant ?? "NORMAL").toUpperCase() === "SIMPLIFIED" ? "SIMPLIFIED" : "NORMAL";
  const lines = await reportLines(prisma, companyId, asOf, ["POSTED", "REVERSED"]);
  let rows = bilanRows(lines, variant);
  let comparative: Record<string, any> | null = null;
  if (String(payload.view ?? "INTERIM").toUpperCase() === "COMPARATIVE") {
    const fiscalYear = await prisma.fiscalYear.findFirst({ where: { companyId, startsOn: { lte: asOf }, endsOn: { gte: asOf } }, orderBy: { startsOn: "desc" } });
    const previousFiscalYear = fiscalYear ? await prisma.fiscalYear.findFirst({ where: { companyId, endsOn: { lt: fiscalYear.startsOn } }, orderBy: { endsOn: "desc" } }) : null;
    if (fiscalYear && previousFiscalYear) {
      const elapsedDays = Math.max(0, Math.floor((asOf.getTime() - fiscalYear.startsOn.getTime()) / 86_400_000));
      const previousAsOf = new Date(Math.min(previousFiscalYear.endsOn.getTime(), previousFiscalYear.startsOn.getTime() + elapsedDays * 86_400_000));
      const priorRows = bilanRows(await reportLines(prisma, companyId, previousAsOf, ["POSTED", "REVERSED"]), variant);
      const currentByKey = new Map(rows.map((row) => [row.key, row]));
      const priorByKey = new Map(priorRows.map((row) => [row.key, row]));
      rows = [...new Set([...currentByKey.keys(), ...priorByKey.keys()])].map((key) => {
        const current = currentByKey.get(key);
        const prior = priorByKey.get(key);
        const amountCents = current?.amountCents ?? 0n;
        const priorAmountCents = prior?.amountCents ?? 0n;
        return { ...(current ?? prior)!, amountCents, priorAmountCents, varianceCents: amountCents - priorAmountCents, entryLineIds: current?.entryLineIds ?? [] };
      }).sort((left, right) => left.side.localeCompare(right.side) || left.code.localeCompare(right.code, "fr", { numeric: true }));
      comparative = { previousFiscalYear: { id: previousFiscalYear.id, label: previousFiscalYear.label }, asOf: previousAsOf.toISOString().slice(0, 10) };
    } else comparative = { unavailable: true, reason: "Aucun exercice N−1 comparable n'est disponible." };
  }
  const actif = rows.filter((row) => row.side === "ACTIF");
  const passif = rows.filter((row) => row.side === "PASSIF");
  const totalActifCents = actif.reduce((sum, row) => sum + row.amountCents, 0n);
  const totalPassifCents = passif.reduce((sum, row) => sum + row.amountCents, 0n);
  const differenceCents = totalActifCents - totalPassifCents;
  if (comparative) {
    comparative = {
      ...comparative,
      totals: {
        priorActifCents: actif.reduce((sum, row: any) => sum + (row.priorAmountCents ?? 0n), 0n),
        priorPassifCents: passif.reduce((sum, row: any) => sum + (row.priorAmountCents ?? 0n), 0n),
      },
    };
  }
  return {
    reportType: "BILAN",
    view: String(payload.view ?? "INTERIM").toUpperCase(),
    variant,
    asOf,
    actif,
    passif,
    totals: { totalActifCents, totalPassifCents, differenceCents },
    balanced: differenceCents === 0n,
    exactUnit: "CENTIME",
    templateVersion: "CGNC-1992-STRUCTURE-2.1.0",
    mappingVersion: "PCGE-PREFIX-INHERITANCE-1",
    comparative,
    verificationStatus: "STRUCTURE_VERIFIED_CALCULATION_REVIEW_REQUIRED",
    statutoryFinalizationAvailable: false,
    statutoryWarning: "La structure CGNC et les regroupements PCGE sont appliqués. La finalisation/déclaration statutaire reste bloquée tant que les cellules fiscales propres au dossier ne sont pas vérifiées par un professionnel.",
    source: PCGE_SOURCE,
    generatedAt: new Date(),
  };
}

export function registerReporting21Ipc(options: { ipcMain: IpcLike; getPrisma: GetPrisma; serialize?: <T>(value: T) => T }) {
  const serialize = options.serialize ?? rendererSerialize;
  options.ipcMain.handle(REPORTING_21_CHANNELS.balanceFamily, async (_event, payload) => serialize(await buildBalanceFamily(await options.getPrisma(), payload)));
  options.ipcMain.handle(REPORTING_21_CHANNELS.bankTotal, async (_event, payload) => serialize(await buildBankTotal(await options.getPrisma(), payload)));
  options.ipcMain.handle(REPORTING_21_CHANNELS.bilan, async (_event, payload) => serialize(await buildBilan(await options.getPrisma(), payload)));
  return REPORTING_21_CHANNELS;
}
