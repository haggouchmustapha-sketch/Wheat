import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ENTRY_STATUS,
  madToCents,
  optionalText,
  parseAccountingDate,
  parseIsoDay,
  provisionalEntryNumber,
  rendererSerialize,
  requireId,
  requireText,
} from "./accounting";
import { appendActivityAndAudit, verifyAuditChain } from "./audit13";
import { createCustomSubaccount, normalizeAccountSearch } from "./chartOfAccounts21";
import { allocatePieceNumber, assertPieceNumberAvailable, validatePiecePattern } from "./pieceNumbering21";

export const OPERATIONS_13_IPC_CHANNELS = {
  settingsWorkspace: "wheat:settings:workspace",
  companyUpdate: "wheat:settings:company:update",
  fiscalYearSave: "wheat:settings:fiscal-year:save",
  accountSave: "wheat:settings:account:save",
  accountArchive: "wheat:settings:account:archive",
  journalSave: "wheat:settings:journal:save",
  journalArchive: "wheat:settings:journal:archive",
  bankAccountSave: "wheat:settings:bank-account:save",
  bankAccountArchive: "wheat:settings:bank-account:archive",
  draftEntryUpdate: "wheat:entry:update-draft",
  payrollRuns: "wheat:payroll:runs",
  payrollVoid: "wheat:payroll:void",
  importStage: "wheat:ledger-import:stage",
  importList: "wheat:ledger-import:list",
  importConfirm: "wheat:ledger-import:confirm",
  importCancel: "wheat:ledger-import:cancel",
  auditVerify: "wheat:audit:verify",
  auditEvents: "wheat:audit:events",
} as const;

type PrismaLike = Record<string, any> & {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type GetPrisma = () => PrismaLike | Promise<PrismaLike>;

export interface Operations13Options {
  getPrisma: GetPrisma;
  getActorUserId?: () => string | null | Promise<string | null>;
  serialize?: <T>(value: T) => T;
  persistImportSource?: (input: {
    companyId: string;
    sourceName: string;
    sourceSha256: string;
    bytes: Buffer;
  }) => string | Promise<string>;
  readImportSource?: (storedPath: string) => Buffer | Promise<Buffer>;
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): unknown;
}

export interface Operations13RegistrationOptions extends Operations13Options {
  ipcMain: IpcMainLike;
}

type NormalizedImportRow = {
  sourceRow: number;
  entryKey: string;
  date: string;
  journalCode: string;
  pieceNumber: string;
  entryLabel: string;
  accountCode: string;
  lineLabel: string;
  debitCents: string;
  creditCents: string;
  thirdParty: string | null;
};

const MAX_IMPORT_ROWS = 10_000;
const MAX_IMPORT_BYTES = 25_000_000;
const MAX_IMPORT_REVISIONS_PER_SCOPE = 1_000;
const MAX_SETTINGS_ROWS = 5_000;
const MAX_ENTRY_LINES = 500;
const CODE_PATTERN = /^[0-9A-Z][0-9A-Z._-]{1,19}$/;

function record(value: unknown, message = "Les données sont invalides."): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredVersion(value: unknown) {
  const version = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(version) || version < 1) throw new Error("La version attendue est invalide. Actualisez l'écran.");
  return version;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} doit être compris entre ${minimum} et ${maximum}.`);
  }
  return parsed;
}

function safeCode(value: unknown, label: string) {
  const code = requireText(value, label, 20).toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new Error(`${label} contient des caractères non autorisés.`);
  return code;
}

function exactCents(value: unknown, label: string) {
  const cents = madToCents(value, label);
  if (cents < 0n) throw new Error(`${label} ne peut pas être négatif.`);
  return cents;
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function stableJson(value: unknown): string {
  const normalize = (child: unknown): unknown => {
    if (child === null || child === undefined) return null;
    if (typeof child === "bigint") return child.toString();
    if (child instanceof Date) return child.toISOString();
    if (Array.isArray(child)) return child.map(normalize);
    if (typeof child === "object") {
      return Object.fromEntries(Object.keys(child as Record<string, unknown>).sort().map((key) => [key, normalize((child as Record<string, unknown>)[key])]));
    }
    return child;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function ledgerImportScopeSha256(mapping: Record<string, unknown>, rows: Array<{ sourceRow: number; raw: Record<string, unknown> }>) {
  return sha256(stableJson({
    mapping,
    rows: [...rows].sort((left, right) => left.sourceRow - right.sourceRow).map((row) => ({ sourceRow: row.sourceRow, raw: row.raw })),
  }));
}

async function persistedLedgerImportScopeSha256(prisma: PrismaLike, batch: any) {
  if (typeof batch.scopeSha256 === "string" && /^[a-f0-9]{64}$/.test(batch.scopeSha256)) return batch.scopeSha256;
  const retainedRows = await prisma.ledgerImportRow.findMany({
    where: { batchId: batch.id },
    orderBy: [{ sourceRow: "asc" }, { id: "asc" }],
    select: { sourceRow: true, rawJson: true },
    take: MAX_IMPORT_ROWS + 1,
  });
  if (retainedRows.length > MAX_IMPORT_ROWS) {
    throw new Error(`Le lot historique ${batch.id} dépasse la limite de sécurité. Wheat refuse de recalculer son périmètre.`);
  }
  let mapping: Record<string, unknown>;
  try {
    mapping = record(JSON.parse(batch.mappingJson), "Le mapping enregistré du lot est invalide.");
  } catch {
    throw new Error(`Le lot historique ${batch.id} contient un mapping illisible. Wheat refuse de le remplacer silencieusement.`);
  }
  const rows = retainedRows.map((row: any) => {
    try {
      return { sourceRow: boundedInteger(row.sourceRow, "Le numéro source enregistré", 1, 10_000_000), raw: record(JSON.parse(row.rawJson), "Une ligne source enregistrée est invalide.") };
    } catch {
      throw new Error(`Le lot historique ${batch.id} contient une ligne source illisible. Wheat refuse de le remplacer silencieusement.`);
    }
  });
  const scopeSha256 = ledgerImportScopeSha256(mapping, rows);
  await prisma.ledgerImportBatch.update({ where: { id: batch.id }, data: { scopeSha256 } });
  return scopeSha256;
}

async function actorId(options: Operations13Options) {
  return options.getActorUserId ? await options.getActorUserId() : null;
}

async function assertCompany(prisma: PrismaLike, companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("La société n'existe plus.");
  return company;
}

async function assertAccountingDateAllowed(tx: PrismaLike, companyId: string, date: Date) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { companyId, startsOn: { lte: date }, endsOn: { gte: date } },
    orderBy: { startsOn: "desc" },
  });
  if (!fiscalYear) throw new Error(`Aucun exercice ne couvre la date ${isoDay(date)}.`);
  if (fiscalYear.status !== "OPEN") throw new Error(`L'exercice ${fiscalYear.label} n'est pas ouvert.`);
  if (fiscalYear.lockedTo && date <= fiscalYear.lockedTo) {
    throw new Error(`La période est verrouillée jusqu'au ${isoDay(fiscalYear.lockedTo)}.`);
  }
  return fiscalYear;
}

async function allocatePostedNumber(tx: PrismaLike, journalId: string, companyId: string, date: Date) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const journal = await tx.journal.findFirst({ where: { id: journalId, companyId } });
    if (!journal) throw new Error("Le journal n'existe plus.");
    if (!journal.active || journal.locked) throw new Error("Le journal est archivé ou verrouillé.");
    const sequence = journal.nextNumber;
    await tx.journal.update({ where: { id: journal.id }, data: { nextNumber: { increment: 1 }, version: { increment: 1 } } });
    const number = `${journal.code}-${date.getUTCFullYear()}-${String(sequence).padStart(6, "0")}`;
    const occupied = await tx.entry.findFirst({ where: { companyId, number }, select: { id: true } });
    if (!occupied) return { number, journal };
  }
  throw new Error("Aucun numéro d'écriture libre n'a pu être attribué.");
}

async function listSettingsWorkspace(prisma: PrismaLike, companyIdValue: unknown) {
  const companyId = requireId(companyIdValue, "La société");
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      fiscalYears: { orderBy: { startsOn: "desc" }, take: 100 },
      accounts: { orderBy: { code: "asc" }, take: MAX_SETTINGS_ROWS },
      journals: { orderBy: { code: "asc" }, take: 500 },
      bankAccounts: { include: { ledgerAccount: true }, orderBy: { bankName: "asc" }, take: 500 },
      entries: {
        where: { status: ENTRY_STATUS.draft },
        include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } },
        orderBy: [{ date: "desc" }, { id: "desc" }],
        take: 500,
      },
    },
  });
  if (!company) throw new Error("La société n'existe plus.");
  return company;
}

async function updateCompany(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const name = requireText(payload.name, "La raison sociale", 180);
  const legalForm = requireText(payload.legalForm, "La forme juridique", 80);
  const ice = optionalText(payload.ice, 40) ?? "";
  if (ice && !/^\d{15}$/.test(ice)) throw new Error("L'ICE doit contenir exactement 15 chiffres.");
  const taxId = optionalText(payload.taxId, 40) ?? "";
  const city = requireText(payload.city, "La ville", 120);
  const vatFrequency = payload.vatFrequency === "QUARTERLY" ? "QUARTERLY" : payload.vatFrequency === "MONTHLY" ? "MONTHLY" : null;
  if (!vatFrequency) throw new Error("La fréquence TVA est invalide.");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const current = await tx.company.findUnique({ where: { id: companyId } });
    if (!current) throw new Error("La société n'existe plus.");
    const result = await tx.company.updateMany({
      where: { id: companyId, version: expectedVersion },
      data: { name, legalForm, ice, taxId, city, vatFrequency, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error("Cette société a été modifiée ailleurs. Actualisez avant de réessayer.");
    const updated = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "UPDATE_COMPANY_SETTINGS",
      entityType: "Company",
      entityId: companyId,
      description: `Paramètres de ${name} mis à jour`,
      payload: { beforeVersion: current.version, afterVersion: updated.version, name, legalForm, ice, taxId, city, vatFrequency },
    });
    return updated;
  });
}

async function saveFiscalYear(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = optionalText(payload.id, 200);
  const label = requireText(payload.label, "Le libellé", 160);
  const startsOn = parseIsoDay(payload.startsOn, "Le début d'exercice");
  const endsOn = parseIsoDay(payload.endsOn, "La fin d'exercice");
  if (startsOn >= endsOn) throw new Error("La fin d'exercice doit être postérieure au début.");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    await assertCompany(tx, companyId);
    const overlap = await tx.fiscalYear.findFirst({
      where: { companyId, id: id ? { not: id } : undefined, startsOn: { lte: endsOn }, endsOn: { gte: startsOn } },
    });
    if (overlap) throw new Error(`Les dates chevauchent ${overlap.label}.`);
    let fiscalYear;
    if (id) {
      const expectedVersion = requiredVersion(payload.expectedVersion);
      const current = await tx.fiscalYear.findFirst({ where: { id, companyId } });
      if (!current) throw new Error("L'exercice n'existe plus.");
      const entry = await tx.entry.findFirst({ where: { companyId, date: { gte: current.startsOn, lte: current.endsOn } }, select: { id: true } });
      if (entry && (current.startsOn.getTime() !== startsOn.getTime() || current.endsOn.getTime() !== endsOn.getTime())) {
        throw new Error("Les dates d'un exercice qui contient des écritures ne peuvent plus être modifiées.");
      }
      const result = await tx.fiscalYear.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: { label, startsOn, endsOn, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new Error("L'exercice a été modifié ailleurs. Actualisez l'écran.");
      fiscalYear = await tx.fiscalYear.findUniqueOrThrow({ where: { id } });
    } else {
      fiscalYear = await tx.fiscalYear.create({ data: { companyId, label, startsOn, endsOn, status: "OPEN" } });
    }
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: id ? "UPDATE_FISCAL_YEAR" : "CREATE_FISCAL_YEAR",
      entityType: "FiscalYear",
      entityId: fiscalYear.id,
      description: `${id ? "Exercice modifié" : "Exercice créé"} : ${label}`,
      payload: { label, startsOn, endsOn },
    });
    return fiscalYear;
  });
}

async function saveAccount(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = optionalText(payload.id, 200);
  const code = safeCode(payload.code, "Le numéro de compte");
  const label = requireText(payload.label, "Le libellé du compte", 180);
  const classNo = boundedInteger(payload.classNo ?? Number(code[0]), "La classe", 0, 9);
  if (Number(code[0]) !== classNo) throw new Error("La classe doit correspondre au premier chiffre du compte.");
  const type = requireText(payload.type, "Le type de compte", 40).toUpperCase();
  if (!new Set(["ASSET", "LIABILITY", "EQUITY", "EXPENSE", "REVENUE", "MEMO"]).has(type)) {
    throw new Error("Le type de compte est invalide.");
  }
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    await assertCompany(tx, companyId);
    let account;
    if (id) {
      const expectedVersion = requiredVersion(payload.expectedVersion);
      const current = await tx.account.findFirst({ where: { id, companyId } });
      if (!current) throw new Error("Le compte n'existe plus.");
      if (current.isStandard) throw new Error("Un compte officiel PCGE ne peut pas être modifié. Vous pouvez le désactiver ou créer une subdivision.");
      if (current.code !== code) {
        const used = await tx.entryLine.findFirst({ where: { accountId: id }, select: { id: true } });
        if (used) throw new Error("Le numéro d'un compte déjà utilisé ne peut plus être modifié. Créez un nouveau compte.");
      }
      const candidateParents = await tx.account.findMany({ where: { companyId, isStandard: true } });
      candidateParents.sort((left: any, right: any) => right.code.length - left.code.length);
      const inheritedParent = candidateParents.find((candidate: any) => code.startsWith(candidate.code) && code.length > candidate.code.length);
      if (!inheritedParent) throw new Error("Le compte personnalisé doit prolonger un compte officiel PCGE.");
      const result = await tx.account.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: {
          code,
          label,
          classNo,
          type,
          parentCode: inheritedParent.code,
          hierarchyDepth: inheritedParent.hierarchyDepth + 1,
          category: inheritedParent.category,
          reportNature: inheritedParent.reportNature,
          auxiliaryEligible: inheritedParent.auxiliaryEligible,
          expectedBalance: inheritedParent.expectedBalance,
          reportingMappingsJson: inheritedParent.reportingMappingsJson,
          fiscalMappingsJson: inheritedParent.fiscalMappingsJson,
          searchText: normalizeAccountSearch(`${code} ${label}`),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw new Error("Le compte a été modifié ailleurs. Actualisez l'écran.");
      account = await tx.account.findUniqueOrThrow({ where: { id } });
      await tx.entryLine.updateMany({
        where: { accountId: id, entry: { status: ENTRY_STATUS.draft } },
        data: { accountCodeSnapshot: code, accountLabelSnapshot: label },
      });
    } else {
      const candidateParents = await tx.account.findMany({ where: { companyId } });
      candidateParents.sort((left: any, right: any) => right.code.length - left.code.length);
      const requestedParent = optionalText(payload.parentCode, 20);
      const parentCode = requestedParent ?? candidateParents.find((candidate: any) => code.startsWith(candidate.code) && code.length > candidate.code.length)?.code;
      if (!parentCode) throw new Error("Choisissez un compte parent PCGE pour cette subdivision.");
      account = await createCustomSubaccount(tx, { companyId, code, label, parentCode });
    }
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: id ? "UPDATE_ACCOUNT" : "CREATE_ACCOUNT",
      entityType: "Account",
      entityId: account.id,
      description: `${id ? "Compte modifié" : "Compte créé"} : ${code} ${label}`,
      payload: { code, label, classNo, type, active: account.active },
    });
    return account;
  });
}

async function archiveAccount(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = requireId(payload.id, "Le compte");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const active = payload.active === true;
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const account = await tx.account.findFirst({ where: { id, companyId } });
    if (!account) throw new Error("Le compte n'existe plus.");
    if (!active) {
      const [draftLine, bankAccount, receivableParty, payableParty] = await Promise.all([
        tx.entryLine.findFirst({ where: { accountId: id, entry: { status: ENTRY_STATUS.draft } }, select: { id: true } }),
        tx.bankAccount.findFirst({ where: { ledgerAccountId: id, active: true }, select: { id: true } }),
        tx.counterparty.findFirst({ where: { defaultReceivableAccountId: id, active: true }, select: { id: true } }),
        tx.counterparty.findFirst({ where: { defaultPayableAccountId: id, active: true }, select: { id: true } }),
      ]);
      if (draftLine) throw new Error("Ce compte est encore utilisé par une écriture brouillon.");
      if (bankAccount) throw new Error("Ce compte est encore rattaché à un compte bancaire actif.");
      if (receivableParty || payableParty) throw new Error("Ce compte est encore utilisé comme compte par défaut d'un tiers actif.");
    }
    const result = await tx.account.updateMany({ where: { id, companyId, version: expectedVersion }, data: { active, version: { increment: 1 } } });
    if (result.count !== 1) throw new Error("Le compte a été modifié ailleurs. Actualisez l'écran.");
    const updated = await tx.account.findUniqueOrThrow({ where: { id } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: active ? "RESTORE_ACCOUNT" : "ARCHIVE_ACCOUNT",
      entityType: "Account",
      entityId: id,
      description: `${active ? "Compte restauré" : "Compte archivé"} : ${account.code}`,
      payload: { code: account.code, active },
    });
    return updated;
  });
}

async function saveJournal(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = optionalText(payload.id, 200);
  const code = safeCode(payload.code, "Le code journal");
  const label = requireText(payload.label, "Le libellé du journal", 180);
  const locked = payload.locked === true;
  const piecePrefix = optionalText(payload.piecePrefix, 20) ?? code;
  const piecePattern = validatePiecePattern(optionalText(payload.piecePattern, 80) ?? "{journal}-{year}-{sequence}");
  const pieceYearFormat = requireText(payload.pieceYearFormat ?? "YYYY", "Le format d'année", 4).toUpperCase();
  if (!new Set(["YYYY", "YY", "NONE"]).has(pieceYearFormat)) throw new Error("Le format d'année doit être YYYY, YY ou NONE.");
  const piecePadding = boundedInteger(payload.piecePadding ?? 6, "Le nombre de chiffres", 1, 12);
  const pieceSeparator = optionalText(payload.pieceSeparator, 3) ?? "-";
  if (/\s|[{}]/.test(pieceSeparator)) throw new Error("Le séparateur de pièce est invalide.");
  const allowManualPieceOverride = payload.allowManualPieceOverride === true;
  const pieceConfiguration = { piecePrefix, piecePattern, pieceYearFormat, piecePadding, pieceSeparator, allowManualPieceOverride };
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    await assertCompany(tx, companyId);
    let journal;
    if (id) {
      const expectedVersion = requiredVersion(payload.expectedVersion);
      const current = await tx.journal.findFirst({ where: { id, companyId } });
      if (!current) throw new Error("Le journal n'existe plus.");
      if (current.code !== code) {
        const used = await tx.entry.findFirst({ where: { journalId: id }, select: { id: true } });
        if (used) throw new Error("Le code d'un journal déjà utilisé ne peut plus être modifié.");
      }
      const result = await tx.journal.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: { code, label, locked, ...pieceConfiguration, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new Error("Le journal a été modifié ailleurs. Actualisez l'écran.");
      journal = await tx.journal.findUniqueOrThrow({ where: { id } });
      await tx.entry.updateMany({ where: { journalId: id, status: ENTRY_STATUS.draft }, data: { journalCodeSnapshot: code } });
    } else {
      journal = await tx.journal.create({ data: { companyId, code, label, locked, active: true, nextNumber: 1, ...pieceConfiguration } });
    }
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: id ? "UPDATE_JOURNAL" : "CREATE_JOURNAL",
      entityType: "Journal",
      entityId: journal.id,
      description: `${id ? "Journal modifié" : "Journal créé"} : ${code}`,
      payload: { code, label, locked, active: journal.active },
    });
    return journal;
  });
}

async function archiveJournal(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = requireId(payload.id, "Le journal");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const active = payload.active === true;
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const journal = await tx.journal.findFirst({ where: { id, companyId } });
    if (!journal) throw new Error("Le journal n'existe plus.");
    if (!active) {
      const draft = await tx.entry.findFirst({ where: { journalId: id, status: ENTRY_STATUS.draft }, select: { id: true } });
      if (draft) throw new Error("Ce journal contient encore des écritures brouillon.");
    }
    const result = await tx.journal.updateMany({ where: { id, companyId, version: expectedVersion }, data: { active, version: { increment: 1 } } });
    if (result.count !== 1) throw new Error("Le journal a été modifié ailleurs. Actualisez l'écran.");
    const updated = await tx.journal.findUniqueOrThrow({ where: { id } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: active ? "RESTORE_JOURNAL" : "ARCHIVE_JOURNAL",
      entityType: "Journal",
      entityId: id,
      description: `${active ? "Journal restauré" : "Journal archivé"} : ${journal.code}`,
      payload: { code: journal.code, active },
    });
    return updated;
  });
}

async function saveBankAccount(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = optionalText(payload.id, 200);
  const bankName = requireText(payload.bankName, "Le nom de la banque", 160);
  const iban = requireText(payload.iban, "L'IBAN ou identifiant", 100).replace(/\s+/g, " ");
  const ledgerAccountId = requireId(payload.ledgerAccountId, "Le compte comptable bancaire");
  const currency = requireText(payload.currency ?? "MAD", "La devise", 3).toUpperCase();
  if (currency !== "MAD") throw new Error("Wheat prend en charge les comptes bancaires en MAD uniquement.");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const ledgerAccount = await tx.account.findFirst({ where: { id: ledgerAccountId, companyId, active: true } });
    if (!ledgerAccount || ledgerAccount.classNo !== 5) throw new Error("Choisissez un compte actif de classe 5 de cette société.");
    let bankAccount;
    if (id) {
      const expectedVersion = requiredVersion(payload.expectedVersion);
      const result = await tx.bankAccount.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: { bankName, iban, currency, ledgerAccountId, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new Error("Le compte bancaire a été modifié ailleurs. Actualisez l'écran.");
      bankAccount = await tx.bankAccount.findUniqueOrThrow({ where: { id } });
    } else {
      bankAccount = await tx.bankAccount.create({
        data: { companyId, bankName, iban, currency, ledgerAccountId, balanceCents: 0n, balanceSource: "OPENING_BALANCE", active: true },
      });
    }
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: id ? "UPDATE_BANK_ACCOUNT" : "CREATE_BANK_ACCOUNT",
      entityType: "BankAccount",
      entityId: bankAccount.id,
      description: `${id ? "Compte bancaire modifié" : "Compte bancaire créé"} : ${bankName}`,
      payload: { bankName, iban, currency, ledgerAccountId },
    });
    return bankAccount;
  });
}

async function archiveBankAccount(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const id = requireId(payload.id, "Le compte bancaire");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const active = payload.active === true;
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const bankAccount = await tx.bankAccount.findFirst({ where: { id, companyId } });
    if (!bankAccount) throw new Error("Le compte bancaire n'existe plus.");
    const result = await tx.bankAccount.updateMany({ where: { id, companyId, version: expectedVersion }, data: { active, version: { increment: 1 } } });
    if (result.count !== 1) throw new Error("Le compte bancaire a été modifié ailleurs. Actualisez l'écran.");
    const updated = await tx.bankAccount.findUniqueOrThrow({ where: { id } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: active ? "RESTORE_BANK_ACCOUNT" : "ARCHIVE_BANK_ACCOUNT",
      entityType: "BankAccount",
      entityId: id,
      description: `${active ? "Compte bancaire restauré" : "Compte bancaire archivé"} : ${bankAccount.bankName}`,
      payload: { bankName: bankAccount.bankName, active },
    });
    return updated;
  });
}

function canonicalCents(value: unknown, fallbackMad: unknown, label: string) {
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`${label} doit être transmis sous forme de texte entier exact.`);
    }
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") || !/^-?\d+$/.test(String(value))) {
      throw new Error(`${label} en centimes est invalide.`);
    }
    const cents = BigInt(value as string | number | bigint);
    if (cents < -(2n ** 63n) || cents > (2n ** 63n) - 1n) throw new Error(`${label} est hors limites.`);
    return cents;
  }
  return madToCents(fallbackMad, label);
}

async function updateDraftEntry(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const entryId = requireId(payload.entryId, "L'écriture");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const journalId = requireId(payload.journalId, "Le journal");
  const date = parseAccountingDate(payload.date, "La date de l'écriture");
  const pieceNumber = optionalText(payload.pieceNumber, 80);
  const label = requireText(payload.label, "Le libellé", 250);
  const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!rawLines.length || rawLines.length > MAX_ENTRY_LINES) throw new Error(`Une écriture doit contenir entre 1 et ${MAX_ENTRY_LINES} lignes.`);
  const parsedLines = rawLines.map((value, index) => {
    const line = record(value, `La ligne ${index + 1} est invalide.`);
    const debitCents = canonicalCents(line.debitCents, line.debit, `Le débit de la ligne ${index + 1}`);
    const creditCents = canonicalCents(line.creditCents, line.credit, `Le crédit de la ligne ${index + 1}`);
    if (debitCents < 0n || creditCents < 0n) throw new Error(`La ligne ${index + 1} contient un montant négatif.`);
    if ((debitCents === 0n && creditCents === 0n) || (debitCents > 0n && creditCents > 0n)) {
      throw new Error(`La ligne ${index + 1} doit porter un débit ou un crédit, exclusivement.`);
    }
    return {
      position: index + 1,
      accountId: requireId(line.accountId, `Le compte de la ligne ${index + 1}`),
      label: requireText(line.label, `Le libellé de la ligne ${index + 1}`, 250),
      debitCents,
      creditCents,
      thirdParty: optionalText(line.thirdParty, 180),
      counterpartyId: optionalText(line.counterpartyId, 200),
    };
  });
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const entry = await tx.entry.findFirst({ where: { id: entryId, companyId }, include: { lines: true } });
    if (!entry) throw new Error("L'écriture n'existe plus.");
    if (entry.status !== ENTRY_STATUS.draft) throw new Error("Seule une écriture brouillon peut être modifiée.");
    if (entry.version !== expectedVersion) throw new Error("Cette écriture a été modifiée ailleurs. Actualisez l'écran.");
    await assertAccountingDateAllowed(tx, companyId, date);
    const journal = await tx.journal.findFirst({ where: { id: journalId, companyId, active: true } });
    if (!journal || journal.locked) throw new Error("Le journal est archivé, verrouillé ou appartient à une autre société.");
    const accountIds = [...new Set(parsedLines.map((line) => line.accountId))];
    const accounts = await tx.account.findMany({ where: { companyId, id: { in: accountIds }, active: true } });
    if (accounts.length !== accountIds.length) throw new Error("Une ligne utilise un compte archivé ou d'une autre société.");
    const accountById = new Map<string, any>(accounts.map((account: any) => [account.id, account]));
    for (const line of parsedLines) {
      if (line.counterpartyId) {
        const counterparty = await tx.counterparty.findFirst({ where: { id: line.counterpartyId, companyId, active: true }, select: { id: true } });
        if (!counterparty) throw new Error("Une ligne utilise un tiers archivé ou d'une autre société.");
      }
    }
    const piece = pieceNumber === entry.pieceNumber && journalId === entry.journalId
      ? {
          pieceNumber: entry.pieceNumber,
          pieceNumberRaw: entry.pieceNumberRaw,
          pieceNumberSearch: entry.pieceNumberSearch ?? normalizeAccountSearch(entry.pieceNumber),
          pieceSequenceNo: entry.pieceSequenceNo,
          pieceFiscalYearId: entry.pieceFiscalYearId,
        }
      : await allocatePieceNumber(tx, { companyId, journalId, date, requestedPieceNumber: pieceNumber, source: entry.source, excludeEntryId: entry.id });
    await assertPieceNumberAvailable(tx, { companyId, journalId, pieceNumber: piece.pieceNumber, excludeEntryId: entry.id });
    await tx.entryLine.deleteMany({ where: { entryId } });
    await tx.entry.update({
      where: { id: entryId },
      data: {
        journalId,
        journalCodeSnapshot: journal.code,
        date,
        ...piece,
        label,
        version: { increment: 1 },
        lines: {
          create: parsedLines.map((line) => ({
            ...line,
            accountCodeSnapshot: accountById.get(line.accountId)!.code,
            accountLabelSnapshot: accountById.get(line.accountId)!.label,
          })),
        },
      },
    });
    const updated = await tx.entry.findUniqueOrThrow({ where: { id: entryId }, include: { journal: true, lines: { include: { account: true }, orderBy: { position: "asc" } } } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "UPDATE_ENTRY_DRAFT",
      entityType: "Entry",
      entityId: entryId,
      description: `Brouillon ${entry.number} modifié`,
      payload: {
        versionBefore: expectedVersion,
        versionAfter: updated.version,
        journalId,
        date,
        pieceNumber: piece.pieceNumber,
        label,
        lineCount: parsedLines.length,
        debitCents: parsedLines.reduce((sum, line) => sum + line.debitCents, 0n),
        creditCents: parsedLines.reduce((sum, line) => sum + line.creditCents, 0n),
      },
    });
    return updated;
  });
}

async function listPayrollRuns(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const take = boundedInteger(payload.take ?? 100, "La limite", 1, 250);
  await assertCompany(prisma, companyId);
  return prisma.payrollRun.findMany({
    where: { companyId },
    include: { postedEntry: true, voidEntry: true, lines: { orderBy: { employeeName: "asc" } } },
    orderBy: [{ period: "desc" }, { id: "desc" }],
    take,
  });
}

async function voidPayrollRun(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const payrollRunId = requireId(payload.payrollRunId, "La paie");
  const expectedVersion = requiredVersion(payload.expectedVersion);
  const reason = requireText(payload.reason, "Le motif", 500);
  const date = parseAccountingDate(payload.date, "La date d'extourne");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const payroll = await tx.payrollRun.findFirst({
      where: { id: payrollRunId, companyId },
      include: { postedEntry: { include: { journal: true, lines: { orderBy: { position: "asc" } } } } },
    });
    if (!payroll) throw new Error("La paie n'existe plus.");
    if (payroll.version !== expectedVersion) throw new Error("Cette paie a été modifiée ailleurs. Actualisez l'écran.");
    if (payroll.status !== "POSTED" || !payroll.postedEntry) throw new Error("Seule une paie comptabilisée peut être annulée.");
    if (payroll.voidEntryId) throw new Error("Cette paie possède déjà une écriture d'annulation.");
    await assertAccountingDateAllowed(tx, companyId, date);
    const activeAllocation = await tx.bankReconciliationAllocation.findFirst({
      where: { entryLine: { entryId: payroll.postedEntry.id }, reconciliation: { status: "ACTIVE" } },
      select: { id: true },
    });
    if (activeAllocation) throw new Error("Annulez d'abord le rapprochement bancaire lié à cette paie.");
    const { number, journal } = await allocatePostedNumber(tx, payroll.postedEntry.journalId, companyId, date);
    const piece = await allocatePieceNumber(tx, { companyId, journalId: payroll.postedEntry.journalId, date, source: "PAYROLL_VOID" });
    const reversal = await tx.entry.create({
      data: {
        companyId,
        journalId: payroll.postedEntry.journalId,
        journalCodeSnapshot: journal.code,
        number,
        date,
        ...piece,
        label: `Annulation paie ${payroll.period} — ${reason}`.slice(0, 250),
        status: ENTRY_STATUS.posted,
        source: "PAYROLL_VOID",
        auditNote: reason,
        postedAt: new Date(),
        reversalOfId: payroll.postedEntry.id,
        lines: {
          create: payroll.postedEntry.lines.map((line: any, index: number) => ({
            position: index + 1,
            accountId: line.accountId,
            accountCodeSnapshot: line.accountCodeSnapshot,
            accountLabelSnapshot: line.accountLabelSnapshot,
            label: `Extourne — ${line.label}`.slice(0, 250),
            debitCents: line.creditCents,
            creditCents: line.debitCents,
            thirdParty: line.thirdParty,
            counterpartyId: line.counterpartyId,
          })),
        },
      },
      include: { lines: true, journal: true },
    });
    await tx.entry.update({ where: { id: payroll.postedEntry.id }, data: { status: ENTRY_STATUS.reversed, reversedAt: new Date(), version: { increment: 1 } } });
    const result = await tx.payrollRun.updateMany({
      where: { id: payrollRunId, companyId, version: expectedVersion, status: "POSTED" },
      data: { status: "VOIDED", voidEntryId: reversal.id, voidedAt: new Date(), voidReason: reason, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error("La paie a été modifiée pendant l'annulation.");
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "VOID_PAYROLL_RUN",
      entityType: "PayrollRun",
      entityId: payrollRunId,
      description: `Paie ${payroll.period} annulée par ${reversal.number}`,
      payload: { period: payroll.period, postedEntryId: payroll.postedEntry.id, voidEntryId: reversal.id, date, reason },
    });
    return { payrollRun: await tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId }, include: { lines: true } }), voidEntry: reversal };
  });
}

function normalizeImportRow(value: unknown, index: number): NormalizedImportRow {
  const row = record(value, `La ligne source ${index + 1} est invalide.`);
  const sourceRow = boundedInteger(row.sourceRow ?? index + 2, `Le numéro source de la ligne ${index + 1}`, 1, 10_000_000);
  const entryKey = requireText(row.entryKey, `La clé d'écriture de la ligne ${sourceRow}`, 160);
  const date = isoDay(parseIsoDay(row.date, `La date de la ligne ${sourceRow}`));
  const journalCode = safeCode(row.journalCode, `Le journal de la ligne ${sourceRow}`);
  const pieceNumber = requireText(row.pieceNumber, `La pièce de la ligne ${sourceRow}`, 80);
  const entryLabel = requireText(row.entryLabel, `Le libellé d'écriture de la ligne ${sourceRow}`, 250);
  const accountCode = safeCode(row.accountCode, `Le compte de la ligne ${sourceRow}`);
  const lineLabel = requireText(row.lineLabel ?? row.entryLabel, `Le libellé de ligne ${sourceRow}`, 250);
  const debitCents = row.debitCents !== undefined
    ? canonicalCents(row.debitCents, undefined, `Le débit de la ligne ${sourceRow}`)
    : exactCents(row.debit, `Le débit de la ligne ${sourceRow}`);
  const creditCents = row.creditCents !== undefined
    ? canonicalCents(row.creditCents, undefined, `Le crédit de la ligne ${sourceRow}`)
    : exactCents(row.credit, `Le crédit de la ligne ${sourceRow}`);
  if ((debitCents === 0n && creditCents === 0n) || (debitCents > 0n && creditCents > 0n)) {
    throw new Error(`La ligne source ${sourceRow} doit porter un débit ou un crédit, exclusivement.`);
  }
  return {
    sourceRow,
    entryKey,
    date,
    journalCode,
    pieceNumber,
    entryLabel,
    accountCode,
    lineLabel,
    debitCents: debitCents.toString(),
    creditCents: creditCents.toString(),
    thirdParty: optionalText(row.thirdParty, 180),
  };
}

async function stageLedgerImport(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const sourceName = requireText(payload.sourceName, "Le nom du fichier", 250);
  const sourceBytesBase64 = requireText(payload.sourceBytesBase64, "Le contenu du fichier", Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 16);
  const bytes = Buffer.from(sourceBytesBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw new Error("Le fichier d'import est vide ou dépasse 25 Mo.");
  const sourceSha256 = sha256(bytes);
  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rawRows.length || rawRows.length > MAX_IMPORT_ROWS) throw new Error(`L'import doit contenir entre 1 et ${MAX_IMPORT_ROWS} lignes.`);
  const mapping = record(payload.mapping, "Le mapping des colonnes est obligatoire.");
  const rows: Array<{ raw: Record<string, unknown>; normalized?: NormalizedImportRow; error?: string }> = rawRows.map((raw, index) => {
    try {
      return { raw: record(raw), normalized: normalizeImportRow(raw, index) };
    } catch (error) {
      return { raw: record(raw), error: error instanceof Error ? error.message : String(error) };
    }
  });
  const sourceRows = rows.map((row, index) => row.normalized?.sourceRow ?? boundedInteger(row.raw.sourceRow ?? index + 2, "Le numéro source", 1, 10_000_000));
  if (new Set(sourceRows).size !== sourceRows.length) throw new Error("Deux lignes portent le même numéro de ligne source.");
  const scopeSha256 = ledgerImportScopeSha256(mapping, rows.map((row, index) => ({ sourceRow: sourceRows[index], raw: row.raw })));
  const validGroups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    if (!row.normalized || row.error) continue;
    const group = validGroups.get(row.normalized.entryKey) ?? [];
    group.push(row);
    validGroups.set(row.normalized.entryKey, group);
  }
  for (const [entryKey, group] of validGroups) {
    const first = group[0].normalized!;
    const inconsistent = group.some((row) => {
      const normalized = row.normalized!;
      return normalized.date !== first.date || normalized.journalCode !== first.journalCode || normalized.pieceNumber !== first.pieceNumber || normalized.entryLabel !== first.entryLabel;
    });
    const debitCents = group.reduce((sum, row) => sum + BigInt(row.normalized!.debitCents), 0n);
    const creditCents = group.reduce((sum, row) => sum + BigInt(row.normalized!.creditCents), 0n);
    const groupError = inconsistent
      ? `Les lignes de l'écriture ${entryKey} ne partagent pas les mêmes en-têtes.`
      : debitCents !== creditCents
        ? `L'écriture ${entryKey} est déséquilibrée de ${(debitCents - creditCents).toString()} centime(s).`
        : null;
    if (groupError) {
      for (const row of group) row.error = groupError;
    }
  }
  const prisma = await options.getPrisma();
  await assertCompany(prisma, companyId);
  const requestedSupersedesBatchId = payload.supersedesBatchId === undefined || payload.supersedesBatchId === null
    ? null
    : requireId(payload.supersedesBatchId, "Le lot à reprendre");
  const sameSourceBatches = await prisma.ledgerImportBatch.findMany({
    where: { companyId, sourceSha256, OR: [{ scopeSha256 }, { scopeSha256: "" }] },
    orderBy: [{ revision: "desc" }, { importedAt: "desc" }, { id: "desc" }],
    take: MAX_IMPORT_REVISIONS_PER_SCOPE + 1,
  });
  if (sameSourceBatches.length > MAX_IMPORT_REVISIONS_PER_SCOPE) {
    throw new Error("Ce périmètre possède trop de révisions pour être repris automatiquement. Exportez l'audit et créez un nouveau périmètre contrôlé.");
  }
  const sameScopeBatches: any[] = [];
  for (const batch of sameSourceBatches) {
    const persistedScope = await persistedLedgerImportScopeSha256(prisma, batch);
    if (persistedScope === scopeSha256) sameScopeBatches.push({ ...batch, scopeSha256: persistedScope });
  }
  const importedDuplicate = sameScopeBatches.find((batch) => batch.status === "IMPORTED");
  if (importedDuplicate) {
    throw new Error(`Ces preuves ont déjà été importées dans le lot ${importedDuplicate.id}. Wheat bloque toute double comptabilisation du même périmètre.`);
  }
  const latestScopeBatch = sameScopeBatches[0] ?? null;
  if (latestScopeBatch && !new Set(["VOIDED", "REVIEW_REQUIRED"]).has(latestScopeBatch.status)) {
    throw new Error(`Ces preuves sont déjà préparées dans le lot ${latestScopeBatch.id}. Confirmez ou annulez ce lot avant de créer une révision.`);
  }
  if (latestScopeBatch && requestedSupersedesBatchId !== latestScopeBatch.id) {
    throw new Error(`Ces preuves existent déjà dans le lot ${latestScopeBatch.id}. Utilisez « Reprendre cet import » pour créer explicitement la révision suivante.`);
  }
  if (!latestScopeBatch && requestedSupersedesBatchId) {
    throw new Error("Le fichier, la feuille, le mapping ou les lignes ne correspondent pas au lot choisi. Wheat refuse de relier des preuves différentes comme une révision.");
  }
  const revision = latestScopeBatch ? Number(latestScopeBatch.revision ?? 1) + 1 : 1;
  const supersedesBatchId = latestScopeBatch?.id ?? null;
  const actorUserId = await actorId(options);
  const sourceStoredPath = options.persistImportSource
    ? await options.persistImportSource({ companyId, sourceName, sourceSha256, bytes })
    : null;
  return prisma.$transaction(async (tx: PrismaLike) => {
    const batch = await tx.ledgerImportBatch.create({
      data: {
        companyId,
        sourceName,
        sourceStoredPath,
        sourceSha256,
        scopeSha256,
        revision,
        supersedesBatchId,
        mappingJson: stableJson(mapping),
        status: rows.some((row) => row.error) ? "REVIEW_REQUIRED" : "STAGED",
        actorUserId,
        rows: {
          create: rows.map((row, index) => ({
            sourceRow: sourceRows[index],
            rawJson: stableJson(row.raw),
            normalizedJson: row.normalized ? stableJson(row.normalized) : null,
            fingerprint: sha256(stableJson(row.normalized ?? row.raw)),
            validationStatus: row.error ? "INVALID" : "VALID",
            validationError: row.error ?? null,
          })),
        },
      },
      include: { rows: { orderBy: { sourceRow: "asc" } } },
    });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "STAGE_LEDGER_IMPORT",
      entityType: "LedgerImportBatch",
      entityId: batch.id,
      description: `Import ${sourceName} préparé (révision ${revision}) : ${rows.length} ligne(s), ${rows.filter((row) => row.error).length} rejet(s)`,
      payload: { sourceName, sourceSha256, scopeSha256, revision, supersedesBatchId, rowCount: rows.length, validCount: rows.filter((row) => !row.error).length, invalidCount: rows.filter((row) => row.error).length },
    });
    return batch;
  });
}

const LEDGER_IMPORT_LIST_DEFAULT = 50;
const LEDGER_IMPORT_LIST_MAX = 100;
const LEDGER_IMPORT_CURSOR_MAX_LENGTH = 2_048;

function encodeLedgerImportCursor(mode: "summary" | "detail", scopeId: string, values: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ v: 1, mode, scopeId, ...values }), "utf8").toString("base64url");
}

function decodeLedgerImportCursor(value: unknown, mode: "summary" | "detail", scopeId: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > LEDGER_IMPORT_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Le curseur d'import est invalide.");
  }
  try {
    const cursor = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.v !== 1 || cursor.mode !== mode || cursor.scopeId !== scopeId) throw new Error("scope");
    return cursor;
  } catch {
    throw new Error("Le curseur d'import est invalide ou ne correspond plus à cette liste.");
  }
}

function importCursorText(value: unknown, label: string, maximum = 500) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Le curseur d'import (${label}) est invalide.`);
  return value;
}

function importCursorDate(value: unknown) {
  const raw = importCursorText(value, "date", 40);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== raw) throw new Error("Le curseur d'import (date) est invalide.");
  return date;
}

async function summarizeLedgerImportBatches(prisma: PrismaLike, batches: any[]) {
  if (!batches.length) return [];
  const batchIds = batches.map((batch) => batch.id);
  const grouped = await prisma.ledgerImportRow.groupBy({
    by: ["batchId", "validationStatus"],
    where: { batchId: { in: batchIds } },
    _count: { _all: true, draftEntryId: true },
  });
  const counts = new Map<string, { valid: number; invalid: number; pending: number; other: number; drafted: number }>();
  for (const group of grouped) {
    const current = counts.get(group.batchId) ?? { valid: 0, invalid: 0, pending: 0, other: 0, drafted: 0 };
    const count = Number(group._count?._all ?? 0);
    if (group.validationStatus === "VALID") current.valid += count;
    else if (group.validationStatus === "INVALID") current.invalid += count;
    else if (group.validationStatus === "PENDING") current.pending += count;
    else current.other += count;
    current.drafted += Number(group._count?.draftEntryId ?? 0);
    counts.set(group.batchId, current);
  }
  return batches.map((batch) => {
    const { _count, ...scalars } = batch;
    const count = counts.get(batch.id) ?? { valid: 0, invalid: 0, pending: 0, other: 0, drafted: 0 };
    return {
      ...scalars,
      rowCount: Number(_count?.rows ?? 0),
      validRowCount: count.valid,
      invalidRowCount: count.invalid,
      pendingRowCount: count.pending,
      otherValidationRowCount: count.other,
      draftedRowCount: count.drafted,
    };
  });
}

async function listLedgerImports(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const limit = boundedInteger(payload.limit ?? payload.take ?? LEDGER_IMPORT_LIST_DEFAULT, "La limite", 1, LEDGER_IMPORT_LIST_MAX);
  await assertCompany(prisma, companyId);

  if (payload.batchId !== undefined && payload.batchId !== null && payload.batchId !== "") {
    const batchId = requireId(payload.batchId, "Le lot d'import");
    const batch = await prisma.ledgerImportBatch.findFirst({
      where: { id: batchId, companyId },
      include: { _count: { select: { rows: true } } },
    });
    if (!batch) throw new Error("Le lot d'import n'existe plus dans cette société.");
    const cursor = decodeLedgerImportCursor(payload.cursor, "detail", batchId);
    let afterWhere: Record<string, unknown> | undefined;
    if (cursor) {
      const sourceRow = boundedInteger(cursor.sourceRow, "La ligne du curseur", 1, Number.MAX_SAFE_INTEGER);
      const id = requireId(cursor.id, "La ligne du curseur");
      afterWhere = { OR: [{ sourceRow: { gt: sourceRow } }, { sourceRow, id: { gt: id } }] };
    }
    const [rows, totalCount, summaries] = await Promise.all([
      prisma.ledgerImportRow.findMany({
        where: afterWhere ? { AND: [{ batchId }, afterWhere] } : { batchId },
        orderBy: [{ sourceRow: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.ledgerImportRow.count({ where: { batchId } }),
      summarizeLedgerImportBatches(prisma, [batch]),
    ]);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      mode: "detail" as const,
      batch: summaries[0],
      items,
      nextCursor: hasMore && last ? encodeLedgerImportCursor("detail", batchId, { sourceRow: last.sourceRow, id: last.id }) : null,
      hasMore,
      limit,
      totalCount,
    };
  }

  const cursor = decodeLedgerImportCursor(payload.cursor, "summary", companyId);
  let afterWhere: Record<string, unknown> | undefined;
  if (cursor) {
    const importedAt = importCursorDate(cursor.importedAt);
    const id = requireId(cursor.id, "Le lot du curseur");
    afterWhere = { OR: [{ importedAt: { lt: importedAt } }, { importedAt, id: { lt: id } }] };
  }
  const baseWhere = { companyId };
  const [rows, totalCount] = await Promise.all([
    prisma.ledgerImportBatch.findMany({
      where: afterWhere ? { AND: [baseWhere, afterWhere] } : baseWhere,
      include: { _count: { select: { rows: true } } },
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.ledgerImportBatch.count({ where: baseWhere }),
  ]);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await summarizeLedgerImportBatches(prisma, pageRows);
  const last = pageRows[pageRows.length - 1];
  return {
    mode: "summary" as const,
    items,
    nextCursor: hasMore && last ? encodeLedgerImportCursor("summary", companyId, { importedAt: last.importedAt.toISOString(), id: last.id }) : null,
    hasMore,
    limit,
    totalCount,
  };
}

async function confirmLedgerImport(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const batchId = requireId(payload.batchId, "Le lot d'import");
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const batch = await tx.ledgerImportBatch.findFirst({ where: { id: batchId, companyId }, include: { rows: { orderBy: { sourceRow: "asc" } } } });
    if (!batch) throw new Error("Le lot d'import n'existe plus.");
    if (batch.status !== "STAGED") throw new Error("Seul un lot entièrement valide et préparé peut être confirmé.");
    if (!batch.rows.length || batch.rows.some((row: any) => row.validationStatus !== "VALID" || !row.normalizedJson)) {
      throw new Error("Le lot contient des lignes invalides. Corrigez le fichier et créez un nouveau lot.");
    }
    if (options.persistImportSource || options.readImportSource) {
      if (!batch.sourceStoredPath) throw new Error("Le fichier source géré du lot est manquant. Wheat refuse de confirmer un import sans preuve source.");
      let storedBytes: Buffer;
      try {
        storedBytes = options.readImportSource
          ? await options.readImportSource(batch.sourceStoredPath)
          : await readFile(batch.sourceStoredPath);
      } catch {
        throw new Error("Le fichier source géré du lot est introuvable. Aucun brouillon n'a été créé.");
      }
      if (sha256(storedBytes) !== batch.sourceSha256) {
        throw new Error("Le fichier source géré a changé depuis la préparation. Aucun brouillon n'a été créé.");
      }
    }
    type ParsedImportRow = { databaseRow: any; normalized: NormalizedImportRow };
    const parsed: ParsedImportRow[] = batch.rows.map((row: any) => ({ databaseRow: row, normalized: JSON.parse(row.normalizedJson) as NormalizedImportRow }));
    const journalCodes: string[] = [...new Set(parsed.map((row) => row.normalized.journalCode))];
    const accountCodes: string[] = [...new Set(parsed.map((row) => row.normalized.accountCode))];
    const [journals, accounts] = await Promise.all([
      tx.journal.findMany({ where: { companyId, code: { in: journalCodes }, active: true } }),
      tx.account.findMany({ where: { companyId, code: { in: accountCodes }, active: true } }),
    ]);
    const journalByCode = new Map<string, any>(journals.map((journal: any) => [journal.code, journal]));
    const accountByCode = new Map<string, any>(accounts.map((account: any) => [account.code, account]));
    const missingJournals = journalCodes.filter((code) => !journalByCode.has(code));
    const missingAccounts = accountCodes.filter((code) => !accountByCode.has(code));
    if (missingJournals.length) throw new Error(`Journaux actifs introuvables : ${missingJournals.join(", ")}.`);
    if (missingAccounts.length) throw new Error(`Comptes actifs introuvables : ${missingAccounts.join(", ")}.`);
    const groups = new Map<string, ParsedImportRow[]>();
    for (const row of parsed) {
      const group = groups.get(row.normalized.entryKey) ?? [];
      group.push(row);
      groups.set(row.normalized.entryKey, group);
    }
    const createdEntries = [];
    for (const [entryKey, rows] of groups) {
      const first = rows[0].normalized;
      if (rows.some((row: ParsedImportRow) => row.normalized.date !== first.date || row.normalized.journalCode !== first.journalCode || row.normalized.pieceNumber !== first.pieceNumber || row.normalized.entryLabel !== first.entryLabel)) {
        throw new Error(`Les lignes de l'écriture ${entryKey} ne partagent pas les mêmes en-têtes.`);
      }
      const debitCents = rows.reduce((sum: bigint, row: ParsedImportRow) => sum + BigInt(row.normalized.debitCents), 0n);
      const creditCents = rows.reduce((sum: bigint, row: ParsedImportRow) => sum + BigInt(row.normalized.creditCents), 0n);
      if (debitCents !== creditCents) throw new Error(`L'écriture ${entryKey} est déséquilibrée de ${(debitCents - creditCents).toString()} centime(s).`);
      const date = parseIsoDay(first.date, `La date de ${entryKey}`);
      await assertAccountingDateAllowed(tx, companyId, date);
      const journal = journalByCode.get(first.journalCode);
      if (!journal || journal.locked) throw new Error(`Le journal ${first.journalCode} est verrouillé.`);
      const piece = await allocatePieceNumber(tx, {
        companyId,
        journalId: journal.id,
        date,
        requestedPieceNumber: first.pieceNumber,
        source: "LEDGER_IMPORT_1_3",
      });
      const entry = await tx.entry.create({
        data: {
          companyId,
          journalId: journal.id,
          journalCodeSnapshot: journal.code,
          number: provisionalEntryNumber(),
          date,
          ...piece,
          label: first.entryLabel,
          status: ENTRY_STATUS.draft,
          source: "LEDGER_IMPORT_1_3",
          auditNote: `Lot ${batch.id}, clé ${entryKey}`,
          lines: {
            create: rows.map((row: ParsedImportRow, index: number) => {
              const account = accountByCode.get(row.normalized.accountCode);
              if (!account) throw new Error(`Le compte ${row.normalized.accountCode} n'existe plus.`);
              return {
                position: index + 1,
                accountId: account.id,
                accountCodeSnapshot: account.code,
                accountLabelSnapshot: account.label,
                label: row.normalized.lineLabel,
                debitCents: BigInt(row.normalized.debitCents),
                creditCents: BigInt(row.normalized.creditCents),
                thirdParty: row.normalized.thirdParty,
              };
            }),
          },
        },
        include: { lines: true },
      });
      await tx.ledgerImportRow.updateMany({ where: { id: { in: rows.map((row: ParsedImportRow) => row.databaseRow.id) } }, data: { draftEntryId: entry.id, validationStatus: "IMPORTED" } });
      createdEntries.push(entry);
    }
    await tx.ledgerImportBatch.update({ where: { id: batch.id }, data: { status: "IMPORTED" } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "CONFIRM_LEDGER_IMPORT",
      entityType: "LedgerImportBatch",
      entityId: batch.id,
      description: `Import ${batch.sourceName} confirmé : ${createdEntries.length} brouillon(s) créé(s)`,
      payload: { sourceSha256: batch.sourceSha256, rowCount: batch.rows.length, entryIds: createdEntries.map((entry) => entry.id) },
    });
    return { batchId: batch.id, status: "IMPORTED", rowCount: batch.rows.length, entries: createdEntries };
  });
}

async function cancelLedgerImport(options: Operations13Options, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const batchId = requireId(payload.batchId, "Le lot d'import");
  const reason = requireText(payload.reason, "Le motif", 500);
  const prisma = await options.getPrisma();
  const actorUserId = await actorId(options);
  return prisma.$transaction(async (tx: PrismaLike) => {
    const batch = await tx.ledgerImportBatch.findFirst({ where: { id: batchId, companyId }, include: { rows: true } });
    if (!batch) throw new Error("Le lot d'import n'existe plus.");
    if (!new Set(["STAGED", "REVIEW_REQUIRED"]).has(batch.status)) throw new Error("Un lot déjà importé ne peut pas être annulé.");
    const updated = await tx.ledgerImportBatch.update({ where: { id: batch.id }, data: { status: "VOIDED", voidedAt: new Date(), voidReason: reason } });
    await appendActivityAndAudit(tx, {
      companyId,
      actorUserId,
      action: "CANCEL_LEDGER_IMPORT",
      entityType: "LedgerImportBatch",
      entityId: batch.id,
      description: `Import ${batch.sourceName} annulé avant comptabilisation`,
      payload: { sourceSha256: batch.sourceSha256, rowCount: batch.rows.length, reason },
    });
    return updated;
  });
}

async function listAuditEvents(prisma: PrismaLike, payloadValue: unknown) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const take = boundedInteger(payload.take ?? 100, "La limite", 1, 250);
  const chain = await prisma.auditChain.findUnique({ where: { companyId } });
  if (!chain) return [];
  const events = await prisma.auditEvent.findMany({
    where: { chainId: chain.id },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
    take,
  });
  return events.map((event: any) => {
    let actorSnapshot = null;
    try {
      actorSnapshot = JSON.parse(event.payloadJson)?.actorSnapshot ?? null;
    } catch {
      // Legacy and independently imported payloads can be non-JSON.
    }
    return { ...event, actorSnapshot };
  });
}

export function createOperations13Service(options: Operations13Options) {
  return {
    getSettingsWorkspace: async (payload: unknown) => listSettingsWorkspace(await options.getPrisma(), record(payload).companyId),
    updateCompanySettings: (payload: unknown) => updateCompany(options, payload),
    saveFiscalYear: (payload: unknown) => saveFiscalYear(options, payload),
    saveAccount: (payload: unknown) => saveAccount(options, payload),
    setAccountActive: (payload: unknown) => archiveAccount(options, payload),
    saveJournal: (payload: unknown) => saveJournal(options, payload),
    setJournalActive: (payload: unknown) => archiveJournal(options, payload),
    saveBankAccount: (payload: unknown) => saveBankAccount(options, payload),
    setBankAccountActive: (payload: unknown) => archiveBankAccount(options, payload),
    updateEntryDraft: (payload: unknown) => updateDraftEntry(options, payload),
    listPayrollRuns: async (payload: unknown) => listPayrollRuns(await options.getPrisma(), payload),
    voidPayrollRun: (payload: unknown) => voidPayrollRun(options, payload),
    stageLedgerImport: (payload: unknown) => stageLedgerImport(options, payload),
    listLedgerImports: async (payload: unknown) => listLedgerImports(await options.getPrisma(), payload),
    confirmLedgerImport: (payload: unknown) => confirmLedgerImport(options, payload),
    cancelLedgerImport: (payload: unknown) => cancelLedgerImport(options, payload),
    verifyAuditChain: async (payload: unknown) => verifyAuditChain(await options.getPrisma(), record(payload).companyId),
    listAuditEvents: async (payload: unknown) => listAuditEvents(await options.getPrisma(), payload),
  };
}

export function registerOperations13Ipc(options: Operations13RegistrationOptions) {
  const service = createOperations13Service(options);
  const serialize = options.serialize ?? rendererSerialize;
  const registrations: Array<[string, (payload: unknown) => Promise<unknown>]> = [
    [OPERATIONS_13_IPC_CHANNELS.settingsWorkspace, service.getSettingsWorkspace],
    [OPERATIONS_13_IPC_CHANNELS.companyUpdate, service.updateCompanySettings],
    [OPERATIONS_13_IPC_CHANNELS.fiscalYearSave, service.saveFiscalYear],
    [OPERATIONS_13_IPC_CHANNELS.accountSave, service.saveAccount],
    [OPERATIONS_13_IPC_CHANNELS.accountArchive, service.setAccountActive],
    [OPERATIONS_13_IPC_CHANNELS.journalSave, service.saveJournal],
    [OPERATIONS_13_IPC_CHANNELS.journalArchive, service.setJournalActive],
    [OPERATIONS_13_IPC_CHANNELS.bankAccountSave, service.saveBankAccount],
    [OPERATIONS_13_IPC_CHANNELS.bankAccountArchive, service.setBankAccountActive],
    [OPERATIONS_13_IPC_CHANNELS.draftEntryUpdate, service.updateEntryDraft],
    [OPERATIONS_13_IPC_CHANNELS.payrollRuns, service.listPayrollRuns],
    [OPERATIONS_13_IPC_CHANNELS.payrollVoid, service.voidPayrollRun],
    [OPERATIONS_13_IPC_CHANNELS.importStage, service.stageLedgerImport],
    [OPERATIONS_13_IPC_CHANNELS.importList, service.listLedgerImports],
    [OPERATIONS_13_IPC_CHANNELS.importConfirm, service.confirmLedgerImport],
    [OPERATIONS_13_IPC_CHANNELS.importCancel, service.cancelLedgerImport],
    [OPERATIONS_13_IPC_CHANNELS.auditVerify, service.verifyAuditChain],
    [OPERATIONS_13_IPC_CHANNELS.auditEvents, service.listAuditEvents],
  ];
  for (const [channel, handler] of registrations) {
    options.ipcMain.handle(channel, async (_event, payload) => serialize(await handler(payload)));
  }
  return service;
}
