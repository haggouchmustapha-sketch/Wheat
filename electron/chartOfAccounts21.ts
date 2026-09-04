import { PCGE_ACCOUNTS, PCGE_CLASS_COUNTS, PCGE_SOURCE, type PcgeAccountDefinition } from "./pcgeData";

type PrismaLike = Record<string, any>;

export type AccountSearchFilters = {
  query?: string;
  classNo?: number;
  type?: string;
  active?: boolean;
  postableOnly?: boolean;
  limit?: number;
};

export const PCGE_STANDARD_VERSION = PCGE_SOURCE.version;
export const PCGE_STANDARD_ACCOUNT_COUNT = PCGE_ACCOUNTS.length;

export function normalizeAccountSearch(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function reportNature(account: PcgeAccountDefinition) {
  if (account.classNo === 0 || account.classNo === 9) return "OFF_BALANCE";
  if (account.classNo >= 1 && account.classNo <= 5) return "BALANCE_SHEET";
  return "PROFIT_AND_LOSS";
}

function reportingMappings(account: PcgeAccountDefinition) {
  const nature = reportNature(account);
  return JSON.stringify({
    source: "PCGE_PARENT_INHERITANCE",
    parentCode: account.parentCode,
    statement: nature === "BALANCE_SHEET" ? "BILAN" : nature === "PROFIT_AND_LOSS" ? "CPC" : null,
    side: account.type === "ASSET" || account.type === "EXPENSE" ? "DEBIT" : account.type === "LIABILITY" || account.type === "EQUITY" || account.type === "REVENUE" ? "CREDIT" : null,
  });
}

export function standardAccountData(companyId: string, account: PcgeAccountDefinition) {
  return {
    companyId,
    code: account.code,
    label: account.label,
    labelArabic: null,
    parentCode: account.parentCode,
    classNo: account.classNo,
    type: account.type,
    hierarchyDepth: account.depth,
    isStandard: true,
    active: true,
    category: account.category,
    reportNature: reportNature(account),
    auxiliaryEligible: account.auxiliaryEligible,
    expectedBalance: account.expectedBalance,
    reportingMappingsJson: reportingMappings(account),
    fiscalMappingsJson: "{}",
    standardVersion: PCGE_STANDARD_VERSION,
    postable: account.postable,
    searchText: account.searchText,
  };
}

function chunks<T>(rows: readonly T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size) as T[]);
  return result;
}

export async function seedPcgeForCompany(prisma: PrismaLike, companyId: string) {
  const existing = await prisma.account.findMany({
    where: { companyId },
    select: { id: true, code: true, label: true, isStandard: true },
  });
  const existingByCode = new Map(existing.map((account: any) => [account.code, account]));
  const missing = PCGE_ACCOUNTS.filter((definition) => !existingByCode.has(definition.code));

  for (const batch of chunks(missing.map((definition) => standardAccountData(companyId, definition)), 40)) {
    await prisma.account.createMany({ data: batch });
  }

  let promoted = 0;
  for (const definition of PCGE_ACCOUNTS) {
    const collided = existingByCode.get(definition.code) as any;
    if (!collided || collided.isStandard) continue;
    const data = standardAccountData(companyId, definition);
    // Preserve a company's historical display label while making the official
    // hierarchy and the authoritative French label searchable.
    await prisma.account.update({
      where: { id: collided.id },
      data: {
        ...data,
        companyId: undefined,
        code: undefined,
        label: collided.label,
        searchText: normalizeAccountSearch(`${definition.code} ${definition.label} ${collided.label}`),
      },
    });
    promoted += 1;
  }

  const standards = await prisma.account.findMany({
    where: { companyId, isStandard: true },
    select: { code: true, hierarchyDepth: true, category: true, reportNature: true, auxiliaryEligible: true, expectedBalance: true, reportingMappingsJson: true },
  });
  const standardByCode = new Map(standards.map((account: any) => [account.code, account]));
  const customAccounts = await prisma.account.findMany({
    where: { companyId, isStandard: false },
    select: { id: true, code: true, label: true, parentCode: true },
  });
  let linkedCustom = 0;
  for (const custom of customAccounts) {
    const parent = standards
      .filter((candidate: any) => candidate.code.length < custom.code.length && custom.code.startsWith(candidate.code))
      .sort((left: any, right: any) => right.code.length - left.code.length)[0] as any;
    if (!parent || custom.parentCode === parent.code) continue;
    const inherited = standardByCode.get(parent.code) as any;
    await prisma.account.update({
      where: { id: custom.id },
      data: {
        parentCode: parent.code,
        hierarchyDepth: parent.hierarchyDepth + 1,
        category: inherited.category,
        reportNature: inherited.reportNature,
        auxiliaryEligible: inherited.auxiliaryEligible,
        expectedBalance: inherited.expectedBalance,
        reportingMappingsJson: inherited.reportingMappingsJson,
        searchText: normalizeAccountSearch(`${custom.code} ${custom.label}`),
      },
    });
    linkedCustom += 1;
  }

  return { created: missing.length, promoted, linkedCustom, total: PCGE_STANDARD_ACCOUNT_COUNT, classCounts: PCGE_CLASS_COUNTS };
}

export async function searchCompanyAccounts(prisma: PrismaLike, companyId: string, filters: AccountSearchFilters = {}) {
  const query = normalizeAccountSearch(filters.query);
  const take = Math.min(Math.max(filters.limit ?? 200, 1), 2_000);
  const accounts = await prisma.account.findMany({
    where: {
      companyId,
      ...(filters.classNo === undefined ? {} : { classNo: filters.classNo }),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.active === undefined ? {} : { active: filters.active }),
      ...(filters.postableOnly ? { postable: true } : {}),
    },
    orderBy: { code: "asc" },
    take: 5_000,
  });
  const filtered = query
    ? accounts.filter((account: any) => normalizeAccountSearch(`${account.code} ${account.label} ${account.labelArabic ?? ""} ${account.searchText}`).includes(query))
    : accounts;
  return filtered.slice(0, take);
}

export async function createCustomSubaccount(prisma: PrismaLike, input: {
  companyId: string;
  parentCode: string;
  code: string;
  label: string;
  labelArabic?: string | null;
}) {
  const code = input.code.trim().toUpperCase();
  const label = input.label.trim();
  if (!/^[0-9][0-9A-Z._-]{1,19}$/.test(code)) throw new Error("Le code du sous-compte est invalide.");
  if (!label || label.length > 180) throw new Error("Le libellé du sous-compte est invalide.");
  const parent = await prisma.account.findFirst({ where: { companyId: input.companyId, code: input.parentCode } });
  if (!parent) throw new Error("Le compte parent n'existe pas dans ce dossier.");
  if (!code.startsWith(parent.code) || code.length <= parent.code.length) {
    throw new Error(`Le sous-compte doit prolonger le code parent ${parent.code}.`);
  }
  const duplicate = await prisma.account.findFirst({ where: { companyId: input.companyId, code }, select: { id: true } });
  if (duplicate) throw new Error(`Le compte ${code} existe déjà dans ce dossier.`);
  return prisma.account.create({
    data: {
      companyId: input.companyId,
      code,
      label,
      labelArabic: input.labelArabic?.trim() || null,
      parentCode: parent.code,
      classNo: parent.classNo,
      type: parent.type,
      hierarchyDepth: parent.hierarchyDepth + 1,
      isStandard: false,
      active: true,
      category: parent.category,
      reportNature: parent.reportNature,
      auxiliaryEligible: parent.auxiliaryEligible,
      expectedBalance: parent.expectedBalance,
      reportingMappingsJson: parent.reportingMappingsJson,
      fiscalMappingsJson: parent.fiscalMappingsJson,
      postable: true,
      searchText: normalizeAccountSearch(`${code} ${label} ${input.labelArabic ?? ""}`),
    },
  });
}

export async function setAccountActive(prisma: PrismaLike, companyId: string, accountId: string, active: boolean) {
  const account = await prisma.account.findFirst({ where: { id: accountId, companyId } });
  if (!account) throw new Error("Le compte n'existe plus.");
  return prisma.account.update({ where: { id: account.id }, data: { active, version: { increment: 1 } } });
}
