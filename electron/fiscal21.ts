import { createHash, randomUUID } from "node:crypto";
import { STORED_SCHEMA_VERSIONS } from "./legacyDomainValues";
import { ENTRY_STATUS, rendererSerialize, requireId, requireText } from "./accounting";
import { appendActivityAndAudit } from "./audit13";
import { allocatePieceNumber } from "./pieceNumbering21";
import { PCGE_SOURCE } from "./pcgeData";
import { buildBilan } from "./reporting21";
import {
  FISCAL_CATALOG_VERSION,
  FISCAL_SOURCE_CITATION,
  FISCAL_TABLE_CATALOG,
  fiscalCatalogForRenderer,
  fiscalTableDefinition,
  type FiscalColumn,
} from "./fiscalCatalog";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const FISCAL_21_CHANNELS = {
  openingPreview: "wheat:opening:preview",
  openingPost: "wheat:opening:post",
  fiscalGenerate: "wheat:fiscal-package:generate",
  fiscalValidate: "wheat:fiscal-package:validate",
  fiscalAdjustment: "wheat:fiscal-package:adjustment",
  fiscalAdjustmentVerify: "wheat:fiscal-package:adjustment:verify",
  fiscalCatalog: "wheat:fiscal-table:catalog",
  fiscalTables: "wheat:fiscal-table:list",
  fiscalTable: "wheat:fiscal-table:get",
  fiscalTableRefresh: "wheat:fiscal-table:refresh",
  fiscalTableSave: "wheat:fiscal-table:save",
  fiscalTableReview: "wheat:fiscal-table:review",
  fiscalTableReopen: "wheat:fiscal-table:reopen",
  fiscalTableNotApplicable: "wheat:fiscal-table:not-applicable",
  fiscalTableNotApplicableClear: "wheat:fiscal-table:not-applicable:clear",
  fiscalTableEvidenceAttach: "wheat:fiscal-table:evidence:attach",
  fiscalTableEvidenceRemove: "wheat:fiscal-table:evidence:remove",
  fiscalControl: "wheat:fiscal-table:control",
} as const;

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La demande est invalide.");
  return value as Record<string, any>;
}

function exact(value: unknown) {
  return BigInt(value as bigint | string | number);
}

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value ?? "")) as T; }
  catch { return fallback; }
}

function sha256(value: unknown) {
  return createHash("sha256").update(safeJson(value)).digest("hex");
}

type OpeningRow = {
  position: number;
  accountId: string;
  accountCode: string;
  accountLabel: string;
  sourceBalanceCents: bigint;
  debitCents: bigint;
  creditCents: bigint;
  carryForward: boolean;
  warning: string | null;
};

type OpeningBalance = { account: Record<string, any>; netCents: bigint };

async function priorFiscalYear(tx: PrismaLike, companyId: string, target: any, requestedId?: string) {
  if (requestedId) {
    const source = await tx.fiscalYear.findFirst({ where: { id: requestedId, companyId } });
    if (!source) throw new Error("L'exercice source n'existe pas dans ce dossier.");
    if (source.endsOn >= target.startsOn) throw new Error("L'exercice source doit précéder l'exercice d'ouverture.");
    return source;
  }
  const source = await tx.fiscalYear.findFirst({ where: { companyId, endsOn: { lt: target.startsOn } }, orderBy: { endsOn: "desc" } });
  if (!source) throw new Error("Aucun exercice antérieur n'est disponible pour préparer les à-nouveaux.");
  return source;
}

async function openingRows(tx: PrismaLike, companyId: string, source: any, retainedEarningsAccountCode?: string | null) {
  const lines = await tx.entryLine.findMany({
    where: { entry: { companyId, status: { in: [ENTRY_STATUS.posted, ENTRY_STATUS.reversed] }, date: { gte: source.startsOn, lte: source.endsOn } } },
    include: { account: true },
    take: 100_001,
  });
  if (lines.length > 100_000) throw new Error("La préparation des à-nouveaux dépasse 100 000 lignes. Réduisez ou archivez le dossier avec assistance.");
  const balances = new Map<string, OpeningBalance>();
  let profitLossCents = 0n;
  for (const line of lines) {
    const net = exact(line.debitCents) - exact(line.creditCents);
    if (line.account.reportNature === "PROFIT_AND_LOSS") {
      profitLossCents -= net;
      continue;
    }
    if (line.account.reportNature !== "BALANCE_SHEET") continue;
    const current: OpeningBalance = balances.get(line.accountId) ?? { account: line.account, netCents: 0n };
    current.netCents += net;
    balances.set(line.accountId, current);
  }
  const rows: OpeningRow[] = [...balances.values()].filter((item) => item.netCents !== 0n).map((item, index): OpeningRow => ({
    position: index + 1,
    accountId: item.account.id,
    accountCode: item.account.code,
    accountLabel: item.account.label,
    sourceBalanceCents: item.netCents,
    debitCents: item.netCents > 0n ? item.netCents : 0n,
    creditCents: item.netCents < 0n ? -item.netCents : 0n,
    carryForward: true,
    warning: null as string | null,
  }));
  const warnings: string[] = [];
  if (profitLossCents !== 0n) {
    if (!retainedEarningsAccountCode) {
      warnings.push(`Le résultat de l'exercice précédent (${profitLossCents.toString()} centimes) exige un compte d'affectation vérifié. Wheat ne l'invente pas.`);
    } else {
      const retained = await tx.account.findFirst({ where: { companyId, code: retainedEarningsAccountCode, active: true, classNo: 1 } });
      if (!retained) throw new Error("Le compte d'affectation du résultat doit être un compte actif de classe 1 du dossier.");
      const net = -profitLossCents;
      rows.push({
        position: rows.length + 1,
        accountId: retained.id,
        accountCode: retained.code,
        accountLabel: retained.label,
        sourceBalanceCents: net,
        debitCents: net > 0n ? net : 0n,
        creditCents: net < 0n ? -net : 0n,
        carryForward: true,
        warning: "Affectation du résultat à confirmer par le responsable comptable.",
      });
    }
  }
  const debitCents = rows.reduce((sum, row) => sum + row.debitCents, 0n);
  const creditCents = rows.reduce((sum, row) => sum + row.creditCents, 0n);
  return { rows, profitLossCents, debitCents, creditCents, differenceCents: debitCents - creditCents, warnings };
}

export async function previewOpeningBalance(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice d'ouverture");
  const target = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } });
  if (!target) throw new Error("L'exercice d'ouverture n'existe plus.");
  if (target.status !== "OPEN") throw new Error("Les à-nouveaux ne peuvent être créés que dans un exercice ouvert.");
  const source = await priorFiscalYear(tx, companyId, target, payload.sourceFiscalYearId ? requireId(payload.sourceFiscalYearId, "L'exercice source") : undefined);
  const calculated = await openingRows(tx, companyId, source, typeof payload.retainedEarningsAccountCode === "string" ? payload.retainedEarningsAccountCode.trim() : null);
  return {
    companyId,
    fiscalYear: target,
    sourceFiscalYear: source,
    sourceKind: "PREVIOUS_CLOSE",
    retainedEarningsAccountCode: payload.retainedEarningsAccountCode || null,
    ...calculated,
    canPost: calculated.rows.length > 0 && calculated.differenceCents === 0n && calculated.warnings.length === 0,
    rule: "Seuls les comptes de bilan sont reportés. Les classes de charges/produits ne sont jamais reportées aveuglément.",
    source: PCGE_SOURCE,
  };
}

async function allocateEntryNumber(tx: PrismaLike, journal: any, companyId: string, date: Date) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const updated = await tx.journal.update({ where: { id: journal.id }, data: { nextNumber: { increment: 1 }, version: { increment: 1 } } });
    const sequence = updated.nextNumber - 1;
    const number = `${updated.code}-${date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
    if (!await tx.entry.findFirst({ where: { companyId, number }, select: { id: true } })) return number;
  }
  throw new Error("Aucun numéro d'écriture d'ouverture libre n'a pu être attribué.");
}

export async function postOpeningBalance(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("La comptabilisation des à-nouveaux exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const preview = await previewOpeningBalance(tx, payload);
    if (!preview.canPost) throw new Error(`Les à-nouveaux ne sont pas comptabilisables : ${preview.warnings.join(" ") || `écart ${preview.differenceCents.toString()} centime(s)`}.`);
    const existing = await tx.openingBalanceRun.findFirst({ where: { companyId: preview.companyId, fiscalYearId: preview.fiscalYear.id, status: "POSTED" } });
    if (existing) throw new Error("Des à-nouveaux ont déjà été comptabilisés pour cet exercice.");
    const journal = await tx.journal.findFirst({ where: { companyId: preview.companyId, code: "OD", active: true, locked: false } });
    if (!journal) throw new Error("Le journal OD actif est requis pour comptabiliser les à-nouveaux.");
    const date = preview.fiscalYear.startsOn;
    const piece = await allocatePieceNumber(tx, { companyId: preview.companyId, journalId: journal.id, date, source: "OPENING_BALANCE_2_1" });
    const number = await allocateEntryNumber(tx, journal, preview.companyId, date);
    const run = await tx.openingBalanceRun.create({
      data: {
        companyId: preview.companyId,
        fiscalYearId: preview.fiscalYear.id,
        sourceFiscalYearId: preview.sourceFiscalYear.id,
        status: "VALIDATED",
        sourceKind: preview.sourceKind,
        retainedEarningsAccountCode: preview.retainedEarningsAccountCode,
        differenceCents: preview.differenceCents,
        warningsJson: JSON.stringify(preview.warnings),
        createdByUserId: options.actorUserId ?? null,
        validatedAt: new Date(),
        lines: {
          create: preview.rows.map((row) => ({
            accountId: row.accountId,
            accountCodeSnapshot: row.accountCode,
            accountLabelSnapshot: row.accountLabel,
            debitCents: row.debitCents,
            creditCents: row.creditCents,
            sourceBalanceCents: row.sourceBalanceCents,
            carryForward: row.carryForward,
            warning: row.warning,
            position: row.position,
          })),
        },
      },
    });
    const entry = await tx.entry.create({
      data: {
        companyId: preview.companyId,
        journalId: journal.id,
        journalCodeSnapshot: journal.code,
        number,
        date,
        ...piece,
        label: `À-nouveaux ${preview.fiscalYear.label}`,
        status: ENTRY_STATUS.posted,
        source: "OPENING_BALANCE_2_1",
        auditNote: `Généré depuis ${preview.sourceFiscalYear.label}; run ${run.id}`,
        postedAt: new Date(),
        lines: { create: preview.rows.map((row) => ({
          accountId: row.accountId,
          accountCodeSnapshot: row.accountCode,
          accountLabelSnapshot: row.accountLabel,
          label: `À-nouveau ${row.accountCode}`,
          debitCents: row.debitCents,
          creditCents: row.creditCents,
          position: row.position,
        })) },
      },
    });
    const postedRun = await tx.openingBalanceRun.update({ where: { id: run.id }, data: { status: "POSTED", postedEntryId: entry.id, postedAt: new Date() } });
    await appendActivityAndAudit(tx, {
      companyId: preview.companyId,
      actorUserId: options.actorUserId ?? null,
      action: "POST_OPENING_BALANCES",
      entityType: "OpeningBalanceRun",
      entityId: run.id,
      description: `${preview.rows.length} à-nouveaux comptabilisés dans ${number}`,
      payload: { entryId: entry.id, number, sourceFiscalYearId: preview.sourceFiscalYear.id, targetFiscalYearId: preview.fiscalYear.id },
    });
    return { run: postedRun, entry };
  });
}

async function accountingProfit(tx: PrismaLike, companyId: string, fiscalYear: any) {
  const rows = await tx.entryLine.findMany({
    where: { entry: { companyId, status: { in: [ENTRY_STATUS.posted, ENTRY_STATUS.reversed] }, date: { gte: fiscalYear.startsOn, lte: fiscalYear.endsOn } }, account: { classNo: { in: [6, 7, 8] } } },
    include: { account: true },
    take: 100_001,
  });
  if (rows.length > 100_000) throw new Error("Le calcul fiscal dépasse la limite de sécurité de 100 000 lignes.");
  const classEight = rows.filter((row: any) => row.account.classNo === 8).reduce((sum: bigint, row: any) => sum + exact(row.creditCents) - exact(row.debitCents), 0n);
  return classEight !== 0n ? classEight : rows.filter((row: any) => row.account.classNo !== 8).reduce((sum: bigint, row: any) => sum + exact(row.creditCents) - exact(row.debitCents), 0n);
}

type FiscalSourceContext = {
  companyId: string;
  fiscalYear: any;
  priorFiscalYear: any | null;
  currentLines: any[];
  priorLines: any[];
  vatWorkpapers: any[];
  adjustments: any[];
  sourceHash: string;
};

const computedColumns = [
  { key: "code", label: "Code", type: "TEXT" },
  { key: "label", label: "Rubrique", type: "TEXT" },
  { key: "amountCents", label: "Exercice", type: "MONEY" },
  { key: "priorAmountCents", label: "Exercice précédent", type: "MONEY" },
] as const;

export const CPC_MAPPING_VERSION = "PCGE-CPC-ESG-1";
export const CPC_FORMULA_MAPPINGS = Object.freeze({
  groupByPrefixDigits: 3,
  expenseClasses: [6],
  revenueClasses: [7],
  resultClasses: [8],
  esg: {
    operatingProducts: ["71"],
    operatingCharges: ["61"],
    financialProducts: ["73"],
    financialCharges: ["63"],
    nonCurrentProducts: ["75"],
    nonCurrentCharges: ["65"],
  },
});

async function fiscalYearForPayload(tx: PrismaLike, companyId: string, fiscalYearId?: string) {
  const fiscalYear = fiscalYearId
    ? await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } })
    : await tx.fiscalYear.findFirst({ where: { companyId, status: "OPEN" }, orderBy: { endsOn: "desc" } })
      ?? await tx.fiscalYear.findFirst({ where: { companyId }, orderBy: { endsOn: "desc" } });
  if (!fiscalYear) throw new Error("Aucun exercice fiscal n'est disponible pour ce dossier.");
  return fiscalYear;
}

async function loadFiscalSourceContext(tx: PrismaLike, companyId: string, fiscalYearId: string, fiscalPackageId?: string): Promise<FiscalSourceContext> {
  const fiscalYear = await fiscalYearForPayload(tx, companyId, fiscalYearId);
  const priorFiscalYear = await tx.fiscalYear.findFirst({ where: { companyId, endsOn: { lt: fiscalYear.startsOn } }, orderBy: { endsOn: "desc" } });
  const lineQuery = (year: any) => tx.entryLine.findMany({
    where: { entry: { companyId, status: { in: [ENTRY_STATUS.posted, ENTRY_STATUS.reversed] }, date: { gte: year.startsOn, lte: year.endsOn } } },
    include: { account: true, entry: { select: { id: true, date: true, status: true, source: true, updatedAt: true } } },
    orderBy: [{ account: { code: "asc" } }, { entry: { date: "asc" } }, { position: "asc" }],
    take: 100_001,
  });
  const [currentLines, priorLines, vatWorkpapers, adjustments] = await Promise.all([
    lineQuery(fiscalYear),
    priorFiscalYear ? lineQuery(priorFiscalYear) : Promise.resolve([]),
    tx.vatWorkpaper.findMany({
      where: { companyId, periodStart: { lte: fiscalYear.endsOn }, periodEnd: { gte: fiscalYear.startsOn }, status: { in: ["REVIEWED", "FILED"] } },
      select: { id: true, revision: true, periodStart: true, periodEnd: true, status: true, sourceSha256: true, collectedVatCents: true, deductibleVatCents: true, adjustmentVatCents: true, netVatDueCents: true, updatedAt: true },
      orderBy: [{ periodStart: "asc" }, { revision: "desc" }],
    }),
    fiscalPackageId ? tx.fiscalAdjustment.findMany({ where: { fiscalPackageId }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
  ]);
  if (currentLines.length > 100_000 || priorLines.length > 100_000) throw new Error("Le calcul fiscal dépasse la limite de sécurité de 100 000 lignes par exercice.");
  const sourceHash = sha256({
    fiscalYear: { id: fiscalYear.id, startsOn: fiscalYear.startsOn, endsOn: fiscalYear.endsOn, version: fiscalYear.version },
    priorFiscalYear: priorFiscalYear ? { id: priorFiscalYear.id, startsOn: priorFiscalYear.startsOn, endsOn: priorFiscalYear.endsOn, version: priorFiscalYear.version } : null,
    lines: [...priorLines, ...currentLines].map((line: any) => [line.id, line.accountCodeSnapshot, String(line.debitCents), String(line.creditCents), line.entry.updatedAt]),
    vat: vatWorkpapers.map((item: any) => [item.id, item.revision, item.status, item.sourceSha256, item.updatedAt]),
    adjustments: adjustments.map((item: any) => [item.id, item.kind, String(item.amountCents), item.legalReference, item.verified, item.updatedAt]),
  });
  return { companyId, fiscalYear, priorFiscalYear, currentLines, priorLines, vatWorkpapers, adjustments, sourceHash };
}

function groupedCpc(lines: any[]) {
  const groups = new Map<string, any>();
  for (const line of lines) {
    if (![...CPC_FORMULA_MAPPINGS.expenseClasses, ...CPC_FORMULA_MAPPINGS.revenueClasses, ...CPC_FORMULA_MAPPINGS.resultClasses].includes(line.account.classNo)) continue;
    const code = line.account.code.slice(0, Math.min(CPC_FORMULA_MAPPINGS.groupByPrefixDigits, line.account.code.length));
    const nature = CPC_FORMULA_MAPPINGS.expenseClasses.includes(line.account.classNo) ? "CHARGE" : CPC_FORMULA_MAPPINGS.revenueClasses.includes(line.account.classNo) ? "PRODUIT" : "RESULTAT";
    const signed = nature === "CHARGE" ? exact(line.debitCents) - exact(line.creditCents) : exact(line.creditCents) - exact(line.debitCents);
    const current = groups.get(code) ?? { code, label: line.account.label, nature, amountCents: 0n, entryLineIds: [] as string[] };
    current.amountCents += signed;
    current.entryLineIds.push(line.id);
    groups.set(code, current);
  }
  return [...groups.values()].sort((left, right) => left.code.localeCompare(right.code, "fr", { numeric: true }));
}

function comparativeRows(currentRows: any[], priorRows: any[]) {
  const current = new Map(currentRows.map((row) => [row.code, row]));
  const prior = new Map(priorRows.map((row) => [row.code, row]));
  return [...new Set([...current.keys(), ...prior.keys()])].map((code) => {
    const row = current.get(code) ?? prior.get(code);
    return { ...row, amountCents: current.get(code)?.amountCents ?? 0n, priorAmountCents: prior.get(code)?.amountCents ?? 0n, entryLineIds: current.get(code)?.entryLineIds ?? [] };
  }).sort((left, right) => left.code.localeCompare(right.code, "fr", { numeric: true }));
}

function cpcFromContext(context: FiscalSourceContext) {
  const rows = comparativeRows(groupedCpc(context.currentLines), groupedCpc(context.priorLines));
  const accountingProfitCents = rows.reduce((sum, row) => sum + (row.nature === "CHARGE" ? -exact(row.amountCents) : exact(row.amountCents)), 0n);
  const priorAccountingProfitCents = rows.reduce((sum, row) => sum + (row.nature === "CHARGE" ? -exact(row.priorAmountCents) : exact(row.priorAmountCents)), 0n);
  return {
    rows,
    accountingProfitCents,
    priorAccountingProfitCents,
    fiscalYear: context.fiscalYear,
    priorFiscalYear: context.priorFiscalYear,
    exactUnit: "CENTIME",
    templateVersion: FISCAL_CATALOG_VERSION,
    mappingVersion: CPC_MAPPING_VERSION,
    statutoryFinalizationAvailable: false,
  };
}

export async function buildComparativeCpc(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const fiscalYear = await fiscalYearForPayload(tx, companyId, payload.fiscalYearId ? requireId(payload.fiscalYearId, "L'exercice") : undefined);
  return cpcFromContext(await loadFiscalSourceContext(tx, companyId, fiscalYear.id));
}

function sumCpc(rows: any[], prefixes: readonly string[], nature?: string) {
  return rows.filter((row) => prefixes.some((prefix) => row.code.startsWith(prefix)) && (!nature || row.nature === nature)).reduce((sum, row) => sum + exact(row.amountCents), 0n);
}

function esgRows(cpc: ReturnType<typeof cpcFromContext>) {
  const forPeriod = (rows: any[]) => {
    const productsOperating = sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.operatingProducts, "PRODUIT");
    const chargesOperating = sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.operatingCharges, "CHARGE");
    const financial = sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.financialProducts, "PRODUIT") - sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.financialCharges, "CHARGE");
    const nonCurrent = sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.nonCurrentProducts, "PRODUIT") - sumCpc(rows, CPC_FORMULA_MAPPINGS.esg.nonCurrentCharges, "CHARGE");
    const operating = productsOperating - chargesOperating;
    const net = rows.reduce((sum, row) => sum + (row.nature === "CHARGE" ? -exact(row.amountCents) : exact(row.amountCents)), 0n);
    return { productsOperating, chargesOperating, operating, financial, nonCurrent, net };
  };
  const current = forPeriod(cpc.rows);
  const prior = forPeriod(cpc.rows.map((row: any) => ({ ...row, amountCents: row.priorAmountCents })));
  return [
    ["ESG-01", "Produits d'exploitation", current.productsOperating, prior.productsOperating],
    ["ESG-02", "Charges d'exploitation", current.chargesOperating, prior.chargesOperating],
    ["ESG-03", "Résultat d'exploitation", current.operating, prior.operating],
    ["ESG-04", "Résultat financier", current.financial, prior.financial],
    ["ESG-05", "Résultat non courant", current.nonCurrent, prior.nonCurrent],
    ["ESG-06", "Résultat net comptable", current.net, prior.net],
  ].map(([code, label, amountCents, priorAmountCents]) => ({ code, label, amountCents, priorAmountCents, entryLineIds: cpc.rows.flatMap((row: any) => row.entryLineIds ?? []) }));
}

function aggregateByAccount(context: FiscalSourceContext, prefixes: string[]) {
  const current = new Map<string, any>();
  const prior = new Map<string, any>();
  const collect = (lines: any[], target: Map<string, any>) => {
    for (const line of lines) {
      if (!prefixes.some((prefix) => line.account.code.startsWith(prefix))) continue;
      const row = target.get(line.account.id) ?? { code: line.account.code, label: line.account.label, amountCents: 0n, entryLineIds: [] as string[] };
      row.amountCents += exact(line.debitCents) - exact(line.creditCents);
      row.entryLineIds.push(line.id);
      target.set(line.account.id, row);
    }
  };
  collect(context.currentLines, current); collect(context.priorLines, prior);
  const ids = new Set([...current.keys(), ...prior.keys()]);
  return [...ids].map((id) => {
    const now = current.get(id); const before = prior.get(id); const base = now ?? before;
    return { code: base.code, label: base.label, amountCents: now?.amountCents ?? 0n, priorAmountCents: before?.amountCents ?? 0n, entryLineIds: now?.entryLineIds ?? [] };
  }).filter((row) => row.amountCents !== 0n || row.priorAmountCents !== 0n).sort((a, b) => a.code.localeCompare(b.code, "fr", { numeric: true }));
}

async function computedTable(tx: PrismaLike, context: FiscalSourceContext, tableId: string) {
  const definition = fiscalTableDefinition(tableId);
  if (!definition) throw new Error("Le tableau fiscal demandé n'existe pas.");
  const cpc = cpcFromContext(context);
  if (tableId === "T01") {
    const bilan = await buildBilan(tx, { companyId: context.companyId, asOf: context.fiscalYear.endsOn.toISOString().slice(0, 10), variant: "NORMAL", view: "COMPARATIVE" });
    return { sections: [
      { id: "ACTIF", label: "1 - Bilan Actif", columns: computedColumns, rows: bilan.actif },
      { id: "PASSIF", label: "1 - Bilan Passif", columns: computedColumns, rows: bilan.passif },
    ], totals: bilan.totals, balanced: bilan.balanced };
  }
  if (tableId === "T02") return { sections: [
    { id: "CPC", label: "2 - CPC", columns: computedColumns, rows: cpc.rows.filter((row: any) => row.nature !== "RESULTAT") },
    { id: "SUITE", label: "2 - CPC (Suite)", columns: computedColumns, rows: [...cpc.rows.filter((row: any) => row.nature === "RESULTAT"), { code: "RESULT", label: "Résultat net comptable", amountCents: cpc.accountingProfitCents, priorAmountCents: cpc.priorAccountingProfitCents }] },
  ], accountingProfitCents: cpc.accountingProfitCents };
  if (tableId === "T03") {
    const reintegrations = context.adjustments.filter((item) => item.kind === "REINTEGRATION").reduce((sum, item) => sum + exact(item.amountCents), 0n);
    const deductions = context.adjustments.filter((item) => item.kind === "DEDUCTION").reduce((sum, item) => sum + exact(item.amountCents), 0n);
    return { sections: [{ id: "RESULT", label: definition.label, columns: computedColumns, rows: [
      { code: "RC", label: "Résultat net comptable", amountCents: cpc.accountingProfitCents, priorAmountCents: cpc.priorAccountingProfitCents, entryLineIds: cpc.rows.flatMap((row: any) => row.entryLineIds ?? []) },
      ...context.adjustments.map((item) => ({ code: item.kind, label: item.label, amountCents: item.kind === "DEDUCTION" ? -exact(item.amountCents) : exact(item.amountCents), priorAmountCents: 0n, legalReference: item.legalReference, verified: item.verified })),
      { code: "RF", label: "Résultat net fiscal calculé", amountCents: cpc.accountingProfitCents + reintegrations - deductions, priorAmountCents: cpc.priorAccountingProfitCents, entryLineIds: cpc.rows.flatMap((row: any) => row.entryLineIds ?? []) },
    ] }] };
  }
  if (tableId === "T05") return { sections: [{ id: "ESG", label: definition.label, columns: computedColumns, rows: esgRows(cpc) }] };
  if (tableId === "T06") return { sections: [{ id: "DETAIL", label: definition.label, columns: computedColumns, rows: cpc.rows }] };
  if (tableId === "T12") return { sections: [{
    id: "TVA", label: definition.label,
    columns: [
      { key: "period", label: "Période", type: "TEXT" }, { key: "status", label: "Statut", type: "TEXT" },
      { key: "collectedVatCents", label: "Collectée", type: "MONEY" }, { key: "deductibleVatCents", label: "Déductible", type: "MONEY" },
      { key: "adjustmentVatCents", label: "Ajustements", type: "MONEY" }, { key: "netVatDueCents", label: "TVA nette", type: "MONEY" },
    ],
    rows: context.vatWorkpapers.map((item) => ({ ...item, period: `${item.periodStart.toISOString().slice(0, 10)} — ${item.periodEnd.toISOString().slice(0, 10)}` })),
  }] };
  const prefixes = definition.accountPrefixes ?? [];
  if (tableId === "T24") {
    const rows = aggregateByAccount(context, prefixes).map((row) => ({ ...row, flowCents: exact(row.amountCents) - exact(row.priorAmountCents) }));
    return { sections: [{ id: "FINANCEMENT", label: definition.label, columns: [...computedColumns, { key: "flowCents", label: "Variation", type: "MONEY" }], rows }] };
  }
  if (prefixes.length) return { sections: [{ id: "LEDGER", label: `${definition.label} · agrégats comptables`, columns: computedColumns, rows: aggregateByAccount(context, prefixes) }] };
  return { sections: [], note: "Ce tableau dépend d'informations qui ne figurent pas dans le grand livre. Complétez les lignes documentées ci-dessous." };
}

function workpaperSummary(workpaper: any, currentSourceHash?: string) {
  const definition = fiscalTableDefinition(workpaper.tableId);
  return {
    id: workpaper.id,
    tableId: workpaper.tableId,
    number: definition?.number,
    label: definition?.label ?? workpaper.tableId,
    mode: definition?.mode,
    status: workpaper.status,
    revision: workpaper.revision,
    evidenceCount: workpaper._count?.evidence ?? workpaper.evidence?.length ?? 0,
    sourceHash: workpaper.sourceHash,
    stale: Boolean(workpaper.sourceHash && currentSourceHash && workpaper.sourceHash !== currentSourceHash),
    reviewedAt: workpaper.reviewedAt,
    notApplicableReason: workpaper.notApplicableReason,
  };
}

async function ensureNormalWorkpapers(tx: PrismaLike, fiscalPackage: any, refreshDrafts = false) {
  if (fiscalPackage.regime !== "NORMAL") return [];
  const context = await loadFiscalSourceContext(tx, fiscalPackage.companyId, fiscalPackage.fiscalYearId, fiscalPackage.id);
  const existing = await tx.fiscalTableWorkpaper.findMany({ where: { fiscalPackageId: fiscalPackage.id } });
  const byTable = new Map<string, any>(existing.map((item: any) => [item.tableId, item]));
  for (const definition of FISCAL_TABLE_CATALOG) {
    const current = byTable.get(definition.id);
    if (!current) {
      const computedJson = safeJson(await computedTable(tx, context, definition.id));
      const validationJson = safeJson(validateWorkpaper({ manualJson: "[]", computedJson, evidence: [], sourceHash: context.sourceHash }, definition, context.sourceHash));
      await tx.fiscalTableWorkpaper.create({ data: {
        fiscalPackageId: fiscalPackage.id,
        tableId: definition.id,
        templateVersion: FISCAL_CATALOG_VERSION,
        computedJson,
        sourceHash: context.sourceHash,
        sourceSummaryJson: safeJson({ fiscalYearId: context.fiscalYear.id, priorFiscalYearId: context.priorFiscalYear?.id ?? null, ledgerLineCount: context.currentLines.length, vatWorkpaperCount: context.vatWorkpapers.length, generatedAt: new Date() }),
        validationJson,
      } });
    } else if (refreshDrafts && current.status === "DRAFT") {
      const computedJson = safeJson(await computedTable(tx, context, definition.id));
      await tx.fiscalTableWorkpaper.update({ where: { id: current.id }, data: {
        templateVersion: FISCAL_CATALOG_VERSION,
        computedJson,
        sourceHash: context.sourceHash,
        sourceSummaryJson: safeJson({ fiscalYearId: context.fiscalYear.id, priorFiscalYearId: context.priorFiscalYear?.id ?? null, ledgerLineCount: context.currentLines.length, vatWorkpaperCount: context.vatWorkpapers.length, generatedAt: new Date() }),
        validationJson: safeJson(validateWorkpaper({ ...current, computedJson, sourceHash: context.sourceHash }, definition, context.sourceHash)),
        revision: { increment: 1 },
      } });
    }
  }
  return tx.fiscalTableWorkpaper.findMany({ where: { fiscalPackageId: fiscalPackage.id }, include: { _count: { select: { evidence: true } } }, orderBy: { tableId: "asc" } });
}

async function scopedWorkpaper(tx: PrismaLike, payload: Record<string, any>) {
  const companyId = requireId(payload.companyId, "La société");
  const fiscalPackageId = requireId(payload.fiscalPackageId, "La liasse");
  const tableId = requireText(payload.tableId, "Le tableau", 10).toUpperCase();
  if (!fiscalTableDefinition(tableId)) throw new Error("Le tableau fiscal demandé n'existe pas.");
  const workpaper = await tx.fiscalTableWorkpaper.findFirst({
    where: { fiscalPackageId, tableId, fiscalPackage: { companyId, regime: "NORMAL" } },
    include: { evidence: { include: { document: { select: { id: true, title: true, status: true, contentSha256: true } } }, orderBy: { attachedAt: "asc" } }, fiscalPackage: { include: { fiscalYear: true } } },
  });
  if (!workpaper) throw new Error("Le tableau fiscal n'existe pas dans cette liasse normale.");
  return { companyId, fiscalPackageId, tableId, workpaper };
}

function expectedRevision(payload: Record<string, any>, workpaper: any) {
  const expected = Number(payload.expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) throw new Error("La révision attendue est invalide.");
  if (expected !== workpaper.revision) throw new Error("Ce tableau a été modifié ailleurs. Rechargez-le avant de continuer.");
  return expected;
}

function cleanField(column: FiscalColumn, value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (column.type === "DATE" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`La colonne « ${column.label} » exige une date AAAA-MM-JJ.`);
  if ((column.type === "MONEY" || column.type === "RATE" || column.type === "INTEGER") && !/^-?\d+$/.test(raw)) throw new Error(`La colonne « ${column.label} » exige une valeur entière${column.type === "MONEY" ? " en centimes" : ""}.`);
  return raw.slice(0, column.type === "TEXT" ? 2_000 : 100);
}

function cleanManualRows(tableId: string, value: unknown) {
  const definition = fiscalTableDefinition(tableId)!;
  if (!Array.isArray(value)) throw new Error("Les lignes manuelles du tableau sont invalides.");
  if (value.length > 500) throw new Error("Un tableau fiscal ne peut pas dépasser 500 lignes manuelles.");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`La ligne ${index + 1} est invalide.`);
    const input = raw as Record<string, unknown>;
    const row: Record<string, string> = { rowId: String(input.rowId ?? randomUUID()).slice(0, 100) };
    for (const column of definition.manualColumns) row[column.key] = cleanField(column, input[column.key]);
    return row;
  });
}

function validateWorkpaper(workpaper: any, definition: NonNullable<ReturnType<typeof fiscalTableDefinition>>, currentSourceHash: string) {
  const issues: Array<{ severity: "BLOCKING" | "INFO"; code: string; message: string }> = [];
  const rows = parseJson<Array<Record<string, string>>>(workpaper.manualJson, []);
  const evidenceCount = workpaper.evidence?.length ?? 0;
  if (workpaper.sourceHash !== currentSourceHash) issues.push({ severity: "BLOCKING", code: "STALE_SOURCE", message: "Les écritures, ajustements ou feuilles TVA ont changé depuis le dernier calcul." });
  if (definition.mode === "MANUAL" && rows.length === 0) issues.push({ severity: "BLOCKING", code: "MISSING_MANUAL_ROWS", message: "Ajoutez au moins une ligne documentée ou marquez le tableau non applicable." });
  if (definition.mode === "HYBRID" && rows.length === 0) issues.push({ severity: "BLOCKING", code: "MISSING_HYBRID_DETAILS", message: "Complétez les détails métier manquants ou marquez le tableau non applicable avec un motif." });
  rows.forEach((row, rowIndex) => {
    for (const column of definition.manualColumns) {
      if (!column.required || row[column.key]) continue;
      if (column.key === "sourceRef" && evidenceCount > 0) continue;
      issues.push({ severity: "BLOCKING", code: "MISSING_REQUIRED_VALUE", message: `Ligne ${rowIndex + 1} : « ${column.label} » est requis.` });
    }
    const hasAmount = definition.manualColumns.some((column) => column.type === "MONEY" && row[column.key] && row[column.key] !== "0");
    if (hasAmount && !row.sourceRef && evidenceCount === 0) issues.push({ severity: "BLOCKING", code: "MISSING_EVIDENCE", message: `Ligne ${rowIndex + 1} : indiquez une source ou rattachez une pièce hashée.` });
  });
  if (definition.id === "T03") {
    const computed = parseJson<any>(workpaper.computedJson, {});
    const unverified = (computed.sections?.[0]?.rows ?? []).filter((row: any) => row.code === "REINTEGRATION" || row.code === "DEDUCTION").some((row: any) => row.verified !== true);
    if (unverified) issues.push({ severity: "BLOCKING", code: "UNVERIFIED_ADJUSTMENT", message: "Chaque réintégration ou déduction doit être vérifiée avant revue du tableau." });
  }
  if (!issues.length) issues.push({ severity: "INFO", code: "READY_FOR_REVIEW", message: "Les contrôles de préparation de ce tableau sont satisfaits." });
  return issues;
}

async function serializeWorkpaper(tx: PrismaLike, workpaper: any) {
  const context = await loadFiscalSourceContext(tx, workpaper.fiscalPackage.companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
  const definition = fiscalTableDefinition(workpaper.tableId)!;
  const issues = validateWorkpaper(workpaper, definition, context.sourceHash);
  return {
    ...workpaper,
    definition,
    computed: parseJson(workpaper.computedJson, {}),
    manualRows: parseJson(workpaper.manualJson, []),
    validation: issues,
    sourceSummary: parseJson(workpaper.sourceSummaryJson, {}),
    stale: workpaper.sourceHash !== context.sourceHash,
    currentSourceHash: context.sourceHash,
    preparationOnly: true,
    statutoryExportAvailable: false,
  };
}

export async function generateFiscalPackage(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
  const regime = requireText(payload.regime ?? "NORMAL", "Le régime", 30).toUpperCase();
  if (!new Set(["NORMAL", "SIMPLIFIED"]).has(regime)) throw new Error("Le régime fiscal doit être NORMAL ou SIMPLIFIED.");
  const fiscalYear = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId } });
  if (!fiscalYear) throw new Error("L'exercice fiscal n'existe plus.");
  const accountingProfitCents = await accountingProfit(tx, companyId, fiscalYear);
  const validation = [
    { severity: "BLOCKING", code: "STATUTORY_TEMPLATE_UNVERIFIED", message: "La télédéclaration et l'export fiscal statutaire restent indisponibles tant que le millésime de formulaire n'est pas vérifié." },
    { severity: "INFO", code: "NO_SILENT_ADJUSTMENTS", message: "Aucune réintégration ou déduction fiscale n'est inventée par Wheat." },
  ];
  const fiscalPackage = await tx.fiscalPackage.upsert({
    where: { companyId_fiscalYearId_regime_templateVersion: { companyId, fiscalYearId, regime, templateVersion: "FOUNDATION-2.1.0" } },
    create: {
      companyId, fiscalYearId, regime, templateVersion: "FOUNDATION-2.1.0", schemaVersion: STORED_SCHEMA_VERSIONS.fiscal.current, status: "DRAFT",
      accountingProfitCents, taxableProfitCents: accountingProfitCents, validationJson: JSON.stringify(validation),
      sourceJson: JSON.stringify({ pcge: PCGE_SOURCE, generatedFrom: "POSTED_LEDGER" }), generatedAt: new Date(),
    },
    update: { accountingProfitCents, taxableProfitCents: accountingProfitCents, validationJson: JSON.stringify(validation), sourceJson: JSON.stringify({ pcge: PCGE_SOURCE, generatedFrom: "POSTED_LEDGER" }), generatedAt: new Date() },
    include: { adjustments: true, fiscalYear: true },
  });
  const tables = await ensureNormalWorkpapers(tx, fiscalPackage);
  return { ...fiscalPackage, tables: tables.map((item: any) => workpaperSummary(item)) };
}

export async function validateFiscalPackage(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = requireId(payload.id, "La liasse");
  const fiscalPackage = await tx.fiscalPackage.findFirst({ where: { id, companyId }, include: { adjustments: true, fiscalYear: true, tables: { include: { _count: { select: { evidence: true } } }, orderBy: { tableId: "asc" } } } });
  if (!fiscalPackage) throw new Error("La liasse fiscale n'existe plus.");
  const issues = JSON.parse(fiscalPackage.validationJson) as any[];
  for (const adjustment of fiscalPackage.adjustments) {
    if (!adjustment.verified) issues.push({ severity: "BLOCKING", code: "UNVERIFIED_ADJUSTMENT", adjustmentId: adjustment.id, message: `L'ajustement « ${adjustment.label} » n'est pas vérifié.` });
    if (!adjustment.legalReference) issues.push({ severity: "BLOCKING", code: "MISSING_LEGAL_REFERENCE", adjustmentId: adjustment.id, message: `La référence légale de « ${adjustment.label} » manque.` });
  }
  const reintegrations = fiscalPackage.adjustments.filter((item: any) => item.kind === "REINTEGRATION").reduce((sum: bigint, item: any) => sum + exact(item.amountCents), 0n);
  const deductions = fiscalPackage.adjustments.filter((item: any) => item.kind === "DEDUCTION").reduce((sum: bigint, item: any) => sum + exact(item.amountCents), 0n);
  let preparationComplete = fiscalPackage.regime !== "NORMAL";
  let tableSummaries: any[] = [];
  if (fiscalPackage.regime === "NORMAL") {
    const context = await loadFiscalSourceContext(tx, companyId, fiscalPackage.fiscalYearId, fiscalPackage.id);
    tableSummaries = fiscalPackage.tables.map((item: any) => workpaperSummary(item, context.sourceHash));
    preparationComplete = tableSummaries.length === FISCAL_TABLE_CATALOG.length && tableSummaries.every((item) => ["REVIEWED", "NOT_APPLICABLE"].includes(item.status) && !item.stale);
    if (!preparationComplete) issues.push({ severity: "BLOCKING", code: "FISCAL_TABLES_INCOMPLETE", message: "Les 25 tableaux de préparation doivent être revus ou documentés comme non applicables." });
  }
  return { fiscalPackage, issues, tableSummaries, preparationComplete, taxableProfitCents: exact(fiscalPackage.accountingProfitCents) + reintegrations - deductions, canFinalize: false, statutoryExportAvailable: false };
}

export async function verifyFiscalAdjustment(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("La vérification de l'ajustement fiscal exige une confirmation explicite.");
  const companyId = requireId(payload.companyId, "La société");
  const fiscalPackageId = requireId(payload.fiscalPackageId, "La liasse");
  const adjustmentId = requireId(payload.adjustmentId, "L'ajustement");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const adjustment = await tx.fiscalAdjustment.findFirst({ where: { id: adjustmentId, fiscalPackageId, fiscalPackage: { companyId, status: "DRAFT" } } });
    if (!adjustment) throw new Error("L'ajustement fiscal n'existe plus ou sa liasse est verrouillée.");
    if (adjustment.verified) return adjustment;
    const updated = await tx.fiscalAdjustment.update({ where: { id: adjustment.id }, data: { verified: true } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "VERIFY_FISCAL_ADJUSTMENT", entityType: "FiscalAdjustment", entityId: updated.id, description: `Ajustement fiscal « ${updated.label} » vérifié`, payload: { fiscalPackageId, kind: updated.kind, amountCents: updated.amountCents, legalReference: updated.legalReference } });
    return updated;
  });
}

export async function addFiscalAdjustment(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("L'ajustement fiscal exige une confirmation explicite.");
  const companyId = requireId(payload.companyId, "La société");
  const fiscalPackageId = requireId(payload.fiscalPackageId, "La liasse");
  const kind = requireText(payload.kind, "Le type d'ajustement", 20).toUpperCase();
  if (!new Set(["REINTEGRATION", "DEDUCTION"]).has(kind)) throw new Error("Le type d'ajustement fiscal est invalide.");
  const amountCents = BigInt(requireText(payload.amountCents, "Le montant en centimes", 30));
  if (amountCents <= 0n) throw new Error("Le montant de l'ajustement doit être positif.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const fiscalPackage = await tx.fiscalPackage.findFirst({ where: { id: fiscalPackageId, companyId, status: "DRAFT" } });
    if (!fiscalPackage) throw new Error("La liasse fiscale n'est plus modifiable.");
    const adjustment = await tx.fiscalAdjustment.create({ data: {
      fiscalPackageId, kind, label: requireText(payload.label, "Le libellé", 250), amountCents,
      legalReference: requireText(payload.legalReference, "La référence légale", 500), evidenceJson: JSON.stringify(Array.isArray(payload.evidence) ? payload.evidence : []), verified: false,
    } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "ADD_FISCAL_ADJUSTMENT", entityType: "FiscalAdjustment", entityId: adjustment.id, description: `Ajustement fiscal « ${adjustment.label} » ajouté au brouillon`, payload: { fiscalPackageId, kind, amountCents, legalReference: adjustment.legalReference } });
    return adjustment;
  });
}

export async function listFiscalTables(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const fiscalPackageId = requireId(payload.fiscalPackageId, "La liasse");
  const fiscalPackage = await tx.fiscalPackage.findFirst({ where: { id: fiscalPackageId, companyId }, include: { fiscalYear: true } });
  if (!fiscalPackage) throw new Error("La liasse fiscale n'existe plus.");
  if (fiscalPackage.regime !== "NORMAL") return { regime: fiscalPackage.regime, tables: [], catalogAvailable: false };
  await ensureNormalWorkpapers(tx, fiscalPackage, false);
  const context = await loadFiscalSourceContext(tx, companyId, fiscalPackage.fiscalYearId, fiscalPackage.id);
  const tables = await tx.fiscalTableWorkpaper.findMany({ where: { fiscalPackageId }, include: { _count: { select: { evidence: true } } }, orderBy: { tableId: "asc" } });
  return { regime: fiscalPackage.regime, catalogAvailable: true, catalog: fiscalCatalogForRenderer(), tables: tables.map((item: any) => workpaperSummary(item, context.sourceHash)) };
}

export async function getFiscalTable(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const { workpaper } = await scopedWorkpaper(tx, payload);
  return serializeWorkpaper(tx, workpaper);
}

export async function refreshFiscalTable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("Le recalcul du tableau exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status === "REVIEWED") throw new Error("Rouvrez le tableau revu avant de recalculer ses sources.");
    if (workpaper.status === "NOT_APPLICABLE") throw new Error("Réactivez le tableau non applicable avant de le recalculer.");
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const computedJson = safeJson(await computedTable(tx, context, tableId));
    const validationJson = safeJson(validateWorkpaper({ ...workpaper, computedJson, sourceHash: context.sourceHash }, fiscalTableDefinition(tableId)!, context.sourceHash));
    const updated = await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: {
      computedJson,
      sourceHash: context.sourceHash,
      sourceSummaryJson: safeJson({ fiscalYearId: context.fiscalYear.id, priorFiscalYearId: context.priorFiscalYear?.id ?? null, ledgerLineCount: context.currentLines.length, vatWorkpaperCount: context.vatWorkpapers.length, generatedAt: new Date() }),
      validationJson,
      revision: { increment: 1 },
    }, include: { evidence: { include: { document: true } }, fiscalPackage: { include: { fiscalYear: true } } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "REFRESH_FISCAL_TABLE", entityType: "FiscalTableWorkpaper", entityId: updated.id, description: `Tableau ${tableId} recalculé depuis les sources comptables`, payload: { tableId, sourceHash: context.sourceHash, revision: updated.revision } });
    return serializeWorkpaper(tx, updated);
  });
}

export async function saveFiscalTable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("L'enregistrement du tableau exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status !== "DRAFT") throw new Error("Seul un tableau en brouillon peut être modifié.");
    const manualRows = cleanManualRows(tableId, payload.manualRows);
    const manualJson = safeJson(manualRows);
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const validationJson = safeJson(validateWorkpaper({ ...workpaper, manualJson }, fiscalTableDefinition(tableId)!, context.sourceHash));
    const updated = await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { manualJson, validationJson, revision: { increment: 1 } }, include: { evidence: { include: { document: true } }, fiscalPackage: { include: { fiscalYear: true } } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "SAVE_FISCAL_TABLE", entityType: "FiscalTableWorkpaper", entityId: updated.id, description: `Brouillon du tableau ${tableId} enregistré`, payload: { tableId, manualRowCount: manualRows.length, revision: updated.revision } });
    return serializeWorkpaper(tx, updated);
  });
}

export async function reviewFiscalTable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("La revue du tableau exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status !== "DRAFT") throw new Error("Seul un tableau en brouillon peut être marqué revu.");
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const definition = fiscalTableDefinition(tableId)!;
    const issues = validateWorkpaper(workpaper, definition, context.sourceHash);
    if (issues.some((issue) => issue.severity === "BLOCKING")) throw new Error(issues.filter((issue) => issue.severity === "BLOCKING").map((issue) => issue.message).join(" "));
    const updated = await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { status: "REVIEWED", reviewedAt: new Date(), reviewedByUserId: options.actorUserId ?? null, validationJson: safeJson(issues), revision: { increment: 1 } }, include: { evidence: { include: { document: true } }, fiscalPackage: { include: { fiscalYear: true } } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "REVIEW_FISCAL_TABLE", entityType: "FiscalTableWorkpaper", entityId: updated.id, description: `Tableau ${tableId} revu et verrouillé`, payload: { tableId, sourceHash: updated.sourceHash, revision: updated.revision } });
    return serializeWorkpaper(tx, updated);
  });
}

export async function reopenFiscalTable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("La réouverture du tableau exige une confirmation explicite.");
  const reason = requireText(payload.reason, "Le motif de réouverture", 500);
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status === "DRAFT") throw new Error("Ce tableau est déjà en brouillon.");
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const validationJson = safeJson(validateWorkpaper(workpaper, fiscalTableDefinition(tableId)!, context.sourceHash));
    const updated = await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { status: "DRAFT", reviewedAt: null, reviewedByUserId: null, notApplicableReason: null, validationJson, revision: { increment: 1 } }, include: { evidence: { include: { document: true } }, fiscalPackage: { include: { fiscalYear: true } } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "REOPEN_FISCAL_TABLE", entityType: "FiscalTableWorkpaper", entityId: updated.id, description: `Tableau ${tableId} rouvert avec motif`, payload: { tableId, reason, revision: updated.revision } });
    return serializeWorkpaper(tx, updated);
  });
}

export async function markFiscalTableNotApplicable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("Le classement non applicable exige une confirmation explicite.");
  const reason = requireText(payload.reason, "Le motif de non-applicabilité", 500);
  if (reason.length < 5) throw new Error("Le motif de non-applicabilité doit être suffisamment précis.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status !== "DRAFT") throw new Error("Seul un tableau en brouillon peut être déclaré non applicable.");
    const updated = await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { status: "NOT_APPLICABLE", notApplicableReason: reason, reviewedAt: new Date(), reviewedByUserId: options.actorUserId ?? null, validationJson: safeJson([{ severity: "INFO", code: "NOT_APPLICABLE_DOCUMENTED", message: reason }]), revision: { increment: 1 } }, include: { evidence: { include: { document: true } }, fiscalPackage: { include: { fiscalYear: true } } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "MARK_FISCAL_TABLE_NOT_APPLICABLE", entityType: "FiscalTableWorkpaper", entityId: updated.id, description: `Tableau ${tableId} documenté comme non applicable`, payload: { tableId, reason, revision: updated.revision } });
    return serializeWorkpaper(tx, updated);
  });
}

export async function clearFiscalTableNotApplicable(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  const scoped = await scopedWorkpaper(options.prisma, payload);
  if (scoped.workpaper.status !== "NOT_APPLICABLE") throw new Error("Ce tableau n'est pas marqué non applicable.");
  return reopenFiscalTable(options, payload);
}

export async function attachFiscalTableEvidence(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("Le rattachement de la pièce exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status !== "DRAFT") throw new Error("Les pièces d'un tableau verrouillé ne peuvent pas être modifiées.");
    const documentId = requireId(payload.documentId, "Le document");
    const document = await tx.document.findFirst({ where: { id: documentId, companyId } });
    if (!document?.contentSha256) throw new Error("La pièce doit appartenir au dossier et posséder une empreinte SHA-256.");
    const role = requireText(payload.role ?? "SUPPORT", "Le rôle de la pièce", 40).toUpperCase();
    if (!new Set(["SUPPORT", "RECONCILIATION", "CALCULATION"]).has(role)) throw new Error("Le rôle de la pièce est invalide.");
    const evidence = await tx.fiscalTableEvidence.create({ data: { workpaperId: workpaper.id, documentId, role, note: typeof payload.note === "string" ? payload.note.trim().slice(0, 500) || null : null, documentTitleSnapshot: document.title, contentSha256Snapshot: document.contentSha256 } });
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const validationJson = safeJson(validateWorkpaper({ ...workpaper, evidence: [...workpaper.evidence, evidence] }, fiscalTableDefinition(tableId)!, context.sourceHash));
    await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { validationJson, revision: { increment: 1 } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "ATTACH_FISCAL_TABLE_EVIDENCE", entityType: "FiscalTableWorkpaper", entityId: workpaper.id, description: `Pièce hashée rattachée au tableau ${tableId}`, payload: { tableId, evidenceId: evidence.id, documentId, contentSha256: document.contentSha256, role } });
    const refreshed = await scopedWorkpaper(tx, payload);
    return serializeWorkpaper(tx, refreshed.workpaper);
  });
}

export async function removeFiscalTableEvidence(options: { prisma: PrismaLike; actorUserId?: string | null }, payloadValue: unknown) {
  const payload = record(payloadValue);
  if (payload.confirmed !== true) throw new Error("Le retrait de la pièce exige une confirmation explicite.");
  return options.prisma.$transaction(async (tx: PrismaLike) => {
    const { companyId, tableId, workpaper } = await scopedWorkpaper(tx, payload);
    expectedRevision(payload, workpaper);
    if (workpaper.status !== "DRAFT") throw new Error("Les pièces d'un tableau verrouillé ne peuvent pas être modifiées.");
    const evidenceId = requireId(payload.evidenceId, "La pièce");
    const evidence = await tx.fiscalTableEvidence.findFirst({ where: { id: evidenceId, workpaperId: workpaper.id } });
    if (!evidence) throw new Error("La pièce n'est plus rattachée à ce tableau.");
    await tx.fiscalTableEvidence.delete({ where: { id: evidence.id } });
    const context = await loadFiscalSourceContext(tx, companyId, workpaper.fiscalPackage.fiscalYearId, workpaper.fiscalPackageId);
    const validationJson = safeJson(validateWorkpaper({ ...workpaper, evidence: workpaper.evidence.filter((item: any) => item.id !== evidence.id) }, fiscalTableDefinition(tableId)!, context.sourceHash));
    await tx.fiscalTableWorkpaper.update({ where: { id: workpaper.id }, data: { validationJson, revision: { increment: 1 } } });
    await appendActivityAndAudit(tx, { companyId, actorUserId: options.actorUserId ?? null, action: "REMOVE_FISCAL_TABLE_EVIDENCE", entityType: "FiscalTableWorkpaper", entityId: workpaper.id, description: `Pièce retirée du tableau ${tableId}`, payload: { tableId, evidenceId } });
    const refreshed = await scopedWorkpaper(tx, payload);
    return serializeWorkpaper(tx, refreshed.workpaper);
  });
}

export async function buildFiscalControl(tx: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const fiscalPackageId = requireId(payload.fiscalPackageId, "La liasse");
  const fiscalPackage = await tx.fiscalPackage.findFirst({ where: { id: fiscalPackageId, companyId, regime: "NORMAL" }, include: { fiscalYear: true, adjustments: true } });
  if (!fiscalPackage) throw new Error("Le contrôle des 25 tableaux est réservé à une liasse normale.");
  await ensureNormalWorkpapers(tx, fiscalPackage, false);
  const context = await loadFiscalSourceContext(tx, companyId, fiscalPackage.fiscalYearId, fiscalPackage.id);
  const workpapers = await tx.fiscalTableWorkpaper.findMany({ where: { fiscalPackageId }, include: { _count: { select: { evidence: true } } }, orderBy: { tableId: "asc" } });
  const tables: any[] = workpapers.map((item: any) => workpaperSummary(item, context.sourceHash));
  const cpc = cpcFromContext(context);
  const t01 = workpapers.find((item: any) => item.tableId === "T01");
  const bilan = parseJson<any>(t01?.computedJson, {});
  const bilanDifference = exact(bilan?.totals?.differenceCents ?? 0);
  const bilanResult = [...(bilan?.sections?.[0]?.rows ?? []), ...(bilan?.sections?.[1]?.rows ?? [])].find((row: any) => row.code === "RESULT");
  const reintegrations = context.adjustments.filter((item) => item.kind === "REINTEGRATION").reduce((sum, item) => sum + exact(item.amountCents), 0n);
  const deductions = context.adjustments.filter((item) => item.kind === "DEDUCTION").reduce((sum, item) => sum + exact(item.amountCents), 0n);
  const completed = tables.filter((item) => ["REVIEWED", "NOT_APPLICABLE"].includes(item.status) && !item.stale).length;
  const missingEvidence = workpapers.filter((workpaper: any) => {
    const rows = parseJson<Array<Record<string, string>>>(workpaper.manualJson, []);
    return rows.some((row) => Object.keys(row).some((key) => key.endsWith("Cents") && row[key] && row[key] !== "0") && !row.sourceRef) && (workpaper._count?.evidence ?? 0) === 0;
  }).length;
  const vatReconciled = context.vatWorkpapers.length > 0 && context.vatWorkpapers.every((item: any) => exact(item.collectedVatCents) - exact(item.deductibleVatCents) + exact(item.adjustmentVatCents) === exact(item.netVatDueCents));
  return {
    fiscalPackageId,
    fiscalYear: fiscalPackage.fiscalYear,
    tables,
    completed,
    total: FISCAL_TABLE_CATALOG.length,
    preparationComplete: completed === FISCAL_TABLE_CATALOG.length,
    checks: [
      { code: "BALANCE_EQUAL", ok: bilanDifference === 0n, label: "Total Actif = Total Passif", detail: `${bilanDifference.toString()} centime(s) d'écart` },
      { code: "RESULT_RECONCILIATION", ok: !bilanResult || exact(bilanResult.amountCents) === (cpc.accountingProfitCents < 0n ? -cpc.accountingProfitCents : cpc.accountingProfitCents), label: "Résultat Bilan = résultat CPC", detail: cpc.accountingProfitCents.toString() },
      { code: "TAXABLE_BRIDGE", ok: context.adjustments.every((item) => item.verified && item.legalReference), label: "Passage au résultat fiscal documenté", detail: (cpc.accountingProfitCents + reintegrations - deductions).toString() },
      { code: "VAT_REVIEWED", ok: vatReconciled, label: "TVA rapprochée depuis des feuilles revues", detail: `${context.vatWorkpapers.length} feuille(s)` },
      { code: "SOURCES_CURRENT", ok: tables.every((item) => !item.stale), label: "Sources comptables à jour", detail: `${tables.filter((item) => item.stale).length} tableau(x) à recalculer` },
      { code: "EVIDENCE_COMPLETE", ok: missingEvidence === 0, label: "Lignes monétaires documentées", detail: `${missingEvidence} tableau(x) sans source ni pièce` },
    ],
    statutoryExportAvailable: false,
    sourceCitation: FISCAL_SOURCE_CITATION,
  };
}

export function registerFiscal21Ipc(options: { ipcMain: IpcLike; getPrisma: GetPrisma; getActorUserId?: () => string | null | Promise<string | null>; serialize?: <T>(value: T) => T }) {
  const serialize = options.serialize ?? rendererSerialize;
  options.ipcMain.handle(FISCAL_21_CHANNELS.openingPreview, async (_event, payload) => serialize(await previewOpeningBalance(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.openingPost, async (_event, payload) => serialize(await postOpeningBalance({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalGenerate, async (_event, payload) => serialize(await generateFiscalPackage(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalValidate, async (_event, payload) => serialize(await validateFiscalPackage(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalCatalog, () => fiscalCatalogForRenderer());
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTables, async (_event, payload) => serialize(await listFiscalTables(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTable, async (_event, payload) => serialize(await getFiscalTable(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableRefresh, async (_event, payload) => serialize(await refreshFiscalTable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableSave, async (_event, payload) => serialize(await saveFiscalTable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableReview, async (_event, payload) => serialize(await reviewFiscalTable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableReopen, async (_event, payload) => serialize(await reopenFiscalTable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableNotApplicable, async (_event, payload) => serialize(await markFiscalTableNotApplicable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableNotApplicableClear, async (_event, payload) => serialize(await clearFiscalTableNotApplicable({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableEvidenceAttach, async (_event, payload) => serialize(await attachFiscalTableEvidence({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalTableEvidenceRemove, async (_event, payload) => serialize(await removeFiscalTableEvidence({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalControl, async (_event, payload) => serialize(await buildFiscalControl(await options.getPrisma(), payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalAdjustmentVerify, async (_event, payload) => serialize(await verifyFiscalAdjustment({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  options.ipcMain.handle(FISCAL_21_CHANNELS.fiscalAdjustment, async (_event, payload) => serialize(await addFiscalAdjustment({ prisma: await options.getPrisma(), actorUserId: await options.getActorUserId?.() }, payload)));
  return FISCAL_21_CHANNELS;
}
