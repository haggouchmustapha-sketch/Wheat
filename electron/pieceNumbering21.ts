import { normalizeAccountSearch } from "./chartOfAccounts21";

type PrismaLike = Record<string, any>;

export type PieceNumberConfiguration = {
  code: string;
  piecePrefix?: string | null;
  piecePattern?: string | null;
  pieceYearFormat?: string | null;
  piecePadding?: number | null;
  pieceSeparator?: string | null;
};

const ALLOWED_TOKENS = new Set(["journal", "prefix", "year", "sequence", "separator"]);

function yearToken(date: Date, format: string) {
  if (format === "NONE") return "";
  if (format === "YY") return String(date.getUTCFullYear()).slice(-2);
  return String(date.getUTCFullYear());
}

export function validatePiecePattern(pattern: string) {
  const tokens = [...pattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (!tokens.includes("sequence")) throw new Error("Le modèle de pièce doit contenir {sequence}.");
  const unknown = tokens.find((token) => !ALLOWED_TOKENS.has(token));
  if (unknown) throw new Error(`Le jeton {${unknown}} n'est pas pris en charge.`);
  if (pattern.length > 80 || /[\r\n]/.test(pattern)) throw new Error("Le modèle de pièce est invalide.");
  return pattern;
}

export function renderPieceNumber(journal: PieceNumberConfiguration, date: Date, sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("La séquence de pièce est invalide.");
  const padding = Math.min(Math.max(journal.piecePadding ?? 6, 1), 12);
  const separator = (journal.pieceSeparator ?? "-").slice(0, 3);
  const pattern = validatePiecePattern(journal.piecePattern ?? "{journal}-{year}-{sequence}");
  const prefix = journal.piecePrefix?.trim() || journal.code;
  const rendered = pattern.replace(/\{([^}]+)\}/g, (_match, token: string) => ({
    journal: journal.code,
    prefix,
    year: yearToken(date, journal.pieceYearFormat ?? "YYYY"),
    sequence: String(sequence).padStart(padding, "0"),
    separator,
  })[token] ?? "");
  const withConfiguredSeparator = separator === "-" ? rendered : rendered.replaceAll("-", separator);
  return withConfiguredSeparator.replace(new RegExp(`${escapeRegex(separator)}{2,}`, "g"), separator).replace(new RegExp(`^${escapeRegex(separator)}|${escapeRegex(separator)}$`, "g"), "");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractConfiguredSequence(journal: PieceNumberConfiguration, date: Date, value: string) {
  const marker = "__WHEAT_SEQUENCE__";
  const rendered = renderPieceNumber(journal, date, 1).replace(String(1).padStart(Math.min(Math.max(journal.piecePadding ?? 6, 1), 12), "0"), marker);
  const expression = `^${escapeRegex(rendered).replace(marker, "(\\d{1,12})")}$`;
  const match = new RegExp(expression, "i").exec(value.trim());
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

async function fiscalYearForDate(tx: PrismaLike, companyId: string, date: Date) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } },
    orderBy: { startsOn: "desc" },
  });
  if (!fiscalYear) throw new Error(`Aucun exercice ne couvre la date ${date.toISOString().slice(0, 10)}.`);
  return fiscalYear;
}

async function initialSequence(tx: PrismaLike, companyId: string, journal: any, fiscalYear: any) {
  const historical = await tx.entry.findMany({
    where: { companyId, journalId: journal.id, date: { gte: fiscalYear.startsOn, lte: fiscalYear.endsOn } },
    select: { pieceNumber: true, pieceSequenceNo: true },
  });
  let maximum = 0;
  for (const entry of historical) {
    const parsed = entry.pieceSequenceNo ?? extractConfiguredSequence(journal, fiscalYear.startsOn, entry.pieceNumber);
    if (parsed && parsed > maximum) maximum = parsed;
  }
  return maximum + 1;
}

export async function previewNextPieceNumber(tx: PrismaLike, companyId: string, journalId: string, date: Date) {
  const [journal, fiscalYear] = await Promise.all([
    tx.journal.findFirst({ where: { id: journalId, companyId } }),
    fiscalYearForDate(tx, companyId, date),
  ]);
  if (!journal) throw new Error("Le journal n'existe plus.");
  const state = await tx.journalPieceSequence.findUnique({
    where: { journalId_fiscalYearId: { journalId, fiscalYearId: fiscalYear.id } },
  });
  const sequence = state?.nextNumber ?? await initialSequence(tx, companyId, journal, fiscalYear);
  return { pieceNumber: renderPieceNumber(journal, date, sequence), sequence, fiscalYearId: fiscalYear.id, fiscalYearLabel: fiscalYear.label };
}

export async function assertPieceNumberAvailable(tx: PrismaLike, input: {
  companyId: string;
  journalId: string;
  pieceNumber: string;
  excludeEntryId?: string;
}) {
  const duplicate = await tx.entry.findFirst({
    where: {
      companyId: input.companyId,
      journalId: input.journalId,
      pieceNumber: input.pieceNumber,
      ...(input.excludeEntryId ? { id: { not: input.excludeEntryId } } : {}),
    },
    select: { id: true, number: true },
  });
  if (duplicate) throw new Error(`Le numéro de pièce ${input.pieceNumber} existe déjà dans ce journal (${duplicate.number}).`);
}

export async function allocatePieceNumber(tx: PrismaLike, input: {
  companyId: string;
  journalId: string;
  date: Date;
  requestedPieceNumber?: string | null;
  source?: string;
  excludeEntryId?: string;
}) {
  const [journal, fiscalYear] = await Promise.all([
    tx.journal.findFirst({ where: { id: input.journalId, companyId: input.companyId } }),
    fiscalYearForDate(tx, input.companyId, input.date),
  ]);
  if (!journal) throw new Error("Le journal n'existe plus.");
  if (!journal.active || journal.locked) throw new Error("Le journal est archivé ou verrouillé.");

  const requested = input.requestedPieceNumber?.trim();
  if (requested) {
    const historicalImport = input.source?.includes("IMPORT") || input.source === "SEED";
    if (!journal.allowManualPieceOverride && !historicalImport) {
      throw new Error("Ce journal n'autorise pas le remplacement manuel du numéro de pièce.");
    }
    await assertPieceNumberAvailable(tx, { ...input, pieceNumber: requested });
    const parsed = extractConfiguredSequence(journal, input.date, requested);
    if (parsed) await advanceSequencePast(tx, input.companyId, journal, fiscalYear, parsed);
    return {
      pieceNumber: requested,
      pieceNumberRaw: requested,
      pieceNumberSearch: normalizeAccountSearch(requested),
      pieceSequenceNo: parsed,
      pieceFiscalYearId: fiscalYear.id,
    };
  }

  const seed = await initialSequence(tx, input.companyId, journal, fiscalYear);
  await tx.journalPieceSequence.upsert({
    where: { journalId_fiscalYearId: { journalId: journal.id, fiscalYearId: fiscalYear.id } },
    create: {
      companyId: input.companyId,
      journalId: journal.id,
      fiscalYearId: fiscalYear.id,
      nextNumber: seed,
      lastIssued: seed - 1,
    },
    update: {},
  });

  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const sequenceState = await tx.journalPieceSequence.update({
      where: { journalId_fiscalYearId: { journalId: journal.id, fiscalYearId: fiscalYear.id } },
      data: { nextNumber: { increment: 1 }, version: { increment: 1 } },
    });
    const sequence = sequenceState.nextNumber - 1;
    const pieceNumber = renderPieceNumber(journal, input.date, sequence);
    const duplicate = await tx.entry.findFirst({ where: { companyId: input.companyId, journalId: journal.id, pieceNumber }, select: { id: true } });
    await tx.journalPieceSequence.update({
      where: { id: sequenceState.id },
      data: { lastIssued: sequence },
    });
    if (duplicate) continue;
    return {
      pieceNumber,
      pieceNumberRaw: null,
      pieceNumberSearch: normalizeAccountSearch(pieceNumber),
      pieceSequenceNo: sequence,
      pieceFiscalYearId: fiscalYear.id,
    };
  }
  throw new Error("Aucun numéro de pièce libre n'a pu être attribué.");
}

async function advanceSequencePast(tx: PrismaLike, companyId: string, journal: any, fiscalYear: any, issued: number) {
  const seed = Math.max(await initialSequence(tx, companyId, journal, fiscalYear), issued + 1);
  const existing = await tx.journalPieceSequence.findUnique({
    where: { journalId_fiscalYearId: { journalId: journal.id, fiscalYearId: fiscalYear.id } },
  });
  if (!existing) {
    await tx.journalPieceSequence.create({
      data: { companyId, journalId: journal.id, fiscalYearId: fiscalYear.id, nextNumber: seed, lastIssued: issued },
    });
  } else if (existing.nextNumber <= issued) {
    await tx.journalPieceSequence.update({
      where: { id: existing.id },
      data: { nextNumber: issued + 1, lastIssued: Math.max(existing.lastIssued, issued), version: { increment: 1 } },
    });
  }
}
