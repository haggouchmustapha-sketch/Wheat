import type { WheatIssue } from "./wheatIssues";
import { issueSentences } from "./wheatIssues";

export const SAGE_TXT_SEPARATOR = ";";

export const SAGE_TXT_FIELDS = [
  { key: "journalCode", label: "Code journal", maximum: 6, required: true },
  { key: "date", label: "Date de pièce", maximum: 6, required: true },
  { key: "pieceNumber", label: "N° pièce", maximum: 13, required: true },
  { key: "accountNumber", label: "N° compte général", maximum: 13, required: true },
  { key: "thirdParty", label: "N° compte tiers", maximum: 17, required: false },
  { key: "label", label: "Libellé écriture", maximum: 35, required: true },
  { key: "debit", label: "Montant débit", maximum: 13, required: true },
  { key: "credit", label: "Montant crédit", maximum: 13, required: true },
  { key: "dueDate", label: "Date d'échéance", maximum: 6, required: false },
  { key: "reference", label: "Référence de pièce", maximum: 17, required: false },
] as const;

export type SageOutputKind = "TXT" | "CSV" | "PNM";

export type SageTxtProfile = {
  profileType: string;
  outputKind: SageOutputKind;
  encoding: "windows-1252" | "utf-8";
  includeHeader: boolean;
  accountLength: "VARIABLE" | string | number;
  journalMappings: Record<string, string>;
  accountMappings: Record<string, string>;
  /**
   * Counterparty id -> the third-party account code that already exists in the
   * target Sage dossier. Keyed by id, never by name: a name is not an identity,
   * and Sage's "N° compte tiers" is an account, not a label.
   */
  thirdPartyMappings: Record<string, string>;
  requireJournalMapping?: boolean;
};

export type SageEntryLineInput = {
  id?: string;
  position?: number;
  accountCodeSnapshot?: string | null;
  account?: { code?: string | null } | null;
  label?: string | null;
  debitCents?: unknown;
  creditCents?: unknown;
  debit?: unknown;
  credit?: unknown;
  /** Wheat's display name for the party carried on the line. Never exported. */
  thirdParty?: string | null;
  counterpartyId?: string | null;
};

export type SageEntryInput = {
  id?: string;
  number?: string | null;
  date?: string | Date | null;
  pieceNumber?: string | null;
  label?: string | null;
  journalCodeSnapshot?: string | null;
  journal?: { code?: string | null } | null;
  lines?: SageEntryLineInput[];
};

/**
 * How the Sage third-party account for a line was decided. Wheat never
 * substitutes a legal name for a missing account code, so a line either has a
 * mapped code, has nothing to map, or is reported.
 */
export type SageThirdPartyStatus =
  /** No party on the line — an ordinary general-account line. */
  | "NONE"
  /** The profile maps this counterparty to a Sage third-party account. */
  | "MAPPED"
  /** A known counterparty with no mapping yet. */
  | "UNMAPPED"
  /** A party name with no counterparty behind it — nothing stable to map. */
  | "UNIDENTIFIED";

export type SageTxtRow = {
  entryId: string;
  sourceJournalCode: string;
  rawPieceNumber: string;
  rawAccountNumber: string;
  journalCode: string;
  date: string;
  pieceNumber: string;
  accountNumber: string;
  /** The Sage third-party ACCOUNT CODE, or empty. Never a name. */
  thirdParty: string;
  /** The counterparty id this line's third-party account is keyed by. */
  thirdPartyKey: string;
  /** Wheat's name for the party, for the preview and the review list only. */
  thirdPartyName: string;
  thirdPartyStatus: SageThirdPartyStatus;
  label: string;
  /** The label before Sage's descriptive-field limit was applied. */
  rawLabel: string;
  labelTruncated: boolean;
  debitCents: string;
  creditCents: string;
  debit: string;
  credit: string;
  dueDate: string;
  reference: string;
};

export type SageTxtValidation = {
  issues: WheatIssue[];
  errors: string[];
  warnings: string[];
  totalDebitCents: string;
  totalCreditCents: string;
  differenceCents: string;
};

function exactCents(value: unknown, decimalFallback: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();

  const text = String(decimalFallback ?? "0").trim().replace(",", ".");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${label} n'est pas un montant décimal exact à deux chiffres.`);
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return `${match[1] === "-" ? "-" : ""}${cents}`;
}

export function formatSageDate(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) return "";
  const year = String(parsed.getUTCFullYear()).slice(-2);
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${day}${month}${year}`;
}

export function formatSageAmountFromCents(value: unknown): string {
  const cents = typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}${magnitude / 100n},${String(magnitude % 100n).padStart(2, "0")}`;
}

export function sanitizeSagePieceNumber(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

export function normalizeSagePhysicalText(value: unknown): string {
  const withoutControls = Array.from(String(value ?? ""), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return withoutControls
    .replace(/;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mappedValue(mappings: Record<string, string> | undefined, source: string) {
  if (!mappings || !Object.prototype.hasOwnProperty.call(mappings, source)) return source;
  return String(mappings[source] ?? "").trim();
}

function sageFieldMaximum(key: (typeof SAGE_TXT_FIELDS)[number]["key"]): number {
  return SAGE_TXT_FIELDS.find((field) => field.key === key)!.maximum;
}

/**
 * Sage's "N° compte tiers" is an account number in the target dossier. Only
 * surrounding whitespace is removed: an identifier is never silently reshaped
 * to fit, so a code that is too long or carries impossible characters is
 * reported as itself rather than trimmed into a different account.
 */
export function resolveSageThirdParty(
  line: Pick<SageEntryLineInput, "thirdParty" | "counterpartyId">,
  mappings: Record<string, string> | undefined,
): { code: string; key: string; name: string; status: SageThirdPartyStatus } {
  const name = normalizeSagePhysicalText(line.thirdParty);
  const key = String(line.counterpartyId ?? "").trim();
  if (!key) return { code: "", key: "", name, status: name ? "UNIDENTIFIED" : "NONE" };
  const code = String(mappings?.[key] ?? "").trim();
  return code
    ? { code, key, name, status: "MAPPED" }
    : { code: "", key, name, status: "UNMAPPED" };
}

/**
 * "Libellé écriture" is descriptive, so a label longer than the Sage field is
 * shortened deterministically rather than blocking an otherwise sound export.
 * Identifiers — piece number, account, reference — are never shortened here.
 */
export function fitSageLabel(value: string): { label: string; truncated: boolean } {
  const maximum = sageFieldMaximum("label");
  if (value.length <= maximum) return { label: value, truncated: false };
  return { label: value.slice(0, maximum).trimEnd(), truncated: true };
}

export function buildSageTxtRows(entries: SageEntryInput[], profile: SageTxtProfile): SageTxtRow[] {
  return entries.flatMap((entry, entryIndex) => {
    const sourceJournalCode = String(entry.journalCodeSnapshot ?? entry.journal?.code ?? "").trim();
    const rawPieceNumber = String(entry.pieceNumber ?? entry.number ?? "").trim();
    const entryId = String(entry.id ?? `entry-${entryIndex + 1}`);

    return (entry.lines ?? []).map((line, lineIndex) => {
      const rawAccountNumber = String(line.accountCodeSnapshot ?? line.account?.code ?? "").trim();
      const debitCents = exactCents(line.debitCents, line.debit, `Le débit de la ligne ${lineIndex + 1}`);
      const creditCents = exactCents(line.creditCents, line.credit, `Le crédit de la ligne ${lineIndex + 1}`);
      const thirdParty = resolveSageThirdParty(line, profile.thirdPartyMappings);
      const label = fitSageLabel(normalizeSagePhysicalText(line.label || entry.label));
      return {
        entryId,
        sourceJournalCode,
        rawPieceNumber,
        rawAccountNumber,
        journalCode: mappedValue(profile.journalMappings, sourceJournalCode),
        date: formatSageDate(entry.date),
        pieceNumber: sanitizeSagePieceNumber(rawPieceNumber),
        accountNumber: mappedValue(profile.accountMappings, rawAccountNumber),
        thirdParty: thirdParty.code,
        thirdPartyKey: thirdParty.key,
        thirdPartyName: thirdParty.name,
        thirdPartyStatus: thirdParty.status,
        label: label.label,
        rawLabel: normalizeSagePhysicalText(line.label || entry.label),
        labelTruncated: label.truncated,
        debitCents,
        creditCents,
        debit: formatSageAmountFromCents(debitCents),
        credit: formatSageAmountFromCents(creditCents),
        dueDate: "",
        reference: normalizeSagePhysicalText(entry.number ?? entry.pieceNumber),
      };
    });
  });
}

function configuredAccountLength(value: SageTxtProfile["accountLength"]): number | null {
  if (value === "VARIABLE" || value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 13 ? parsed : null;
}

function rowFields(row: SageTxtRow): string[] {
  return [
    row.journalCode,
    row.date,
    row.pieceNumber,
    row.accountNumber,
    row.thirdParty,
    row.label,
    row.debit,
    row.credit,
    row.dueDate,
    row.reference,
  ];
}

export function buildSageTxtLine(row: SageTxtRow): string {
  return rowFields(row).join(SAGE_TXT_SEPARATOR);
}

export function buildSageTxtLines(rows: SageTxtRow[], includeHeader = false): string[] {
  const body = rows.map(buildSageTxtLine);
  if (!includeHeader) return body;
  return [SAGE_TXT_FIELDS.map((field) => field.label).join(SAGE_TXT_SEPARATOR), ...body];
}

export function validateSageTxtExport(
  entries: SageEntryInput[],
  rows: SageTxtRow[],
  profile: SageTxtProfile,
): SageTxtValidation {
  const issues: WheatIssue[] = [];
  const accountLength = configuredAccountLength(profile.accountLength);
  const blocker = (issue: Omit<WheatIssue, "severity" | "blocking">) => issues.push({ ...issue, severity: "BLOCKER", blocking: true });

  if (profile.outputKind === "PNM") {
    blocker({
      code: "SAGE_PNM_UNVERIFIED",
      message: "Export PNM bloqu\u00e9 : Wheat ne poss\u00e8de pas encore de sch\u00e9ma de positions PNM v\u00e9rifi\u00e9.",
      reason: "Le format PNM est un fichier \u00e0 positions fixes dont Wheat n'a pas de sp\u00e9cification v\u00e9rifi\u00e9e ; produire un fichier approximatif ferait entrer des \u00e9critures fausses dans Sage.",
      remedy: "Choisissez le format TXT ou CSV, tous deux contr\u00f4l\u00e9s champ par champ.",
    });
  }
  if (!entries.length || !rows.length) {
    blocker({
      code: "SAGE_NO_ENTRIES",
      message: "Aucune \u00e9criture comptabilis\u00e9e \u00e0 exporter pour cette soci\u00e9t\u00e9.",
      reason: "Seules les \u00e9critures comptabilis\u00e9es ou extourn\u00e9es sont exportables ; les brouillons ne sont pas de l'historique comptable.",
      remedy: "Comptabilisez au moins une \u00e9criture, puis revenez sur cet \u00e9cran.",
    });
  }

  const entryTotals = new Map<string, { debit: bigint; credit: bigint; label: string }>();
  const pieceSources = new Map<string, string>();
  const unmappedParties = new Map<string, { name: string; lines: number[] }>();
  const unidentifiedParties = new Map<string, number[]>();
  const truncatedLabels: number[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const context = `Ligne ${rowNumber}`;
    const debit = BigInt(row.debitCents);
    const credit = BigInt(row.creditCents);
    totalDebit += debit;
    totalCredit += credit;

    const entryTotal = entryTotals.get(row.entryId) ?? { debit: 0n, credit: 0n, label: row.rawPieceNumber || row.entryId };
    entryTotal.debit += debit;
    entryTotal.credit += credit;
    entryTotals.set(row.entryId, entryTotal);

    if (profile.requireJournalMapping !== false && !Object.prototype.hasOwnProperty.call(profile.journalMappings ?? {}, row.sourceJournalCode)) {
      blocker({
        code: "SAGE_JOURNAL_UNMAPPED",
        context,
        message: `Journal ${row.sourceJournalCode || "vide"} non mapp\u00e9 dans le profil Sage.`,
        value: row.sourceJournalCode || "(vide)",
        reason: "Sage n'accepte que des codes journaux qui existent d\u00e9j\u00e0 dans le dossier cible ; Wheat n'en cr\u00e9e jamais.",
        expected: "Un code journal cible pour chaque journal Wheat utilis\u00e9, dans la section Correspondances.",
        remedy: `Indiquez le code Sage correspondant au journal ${row.sourceJournalCode || "concern\u00e9"}.`,
      });
    }

    // Third-party account: an identifier, decided from the counterparty mapping
    // alone. A missing code leaves the field empty and is reported once per
    // party below - the legal name is never written into it.
    if (row.thirdPartyStatus === "UNMAPPED") {
      const existing = unmappedParties.get(row.thirdPartyKey) ?? { name: row.thirdPartyName, lines: [] };
      existing.lines.push(rowNumber);
      unmappedParties.set(row.thirdPartyKey, existing);
    } else if (row.thirdPartyStatus === "UNIDENTIFIED") {
      unidentifiedParties.set(row.thirdPartyName, [...(unidentifiedParties.get(row.thirdPartyName) ?? []), rowNumber]);
    }
    if (row.labelTruncated) truncatedLabels.push(rowNumber);

    SAGE_TXT_FIELDS.forEach((field, fieldIndex) => {
      const value = rowFields(row)[fieldIndex];
      if (field.required && !value) {
        blocker({
          code: `SAGE_FIELD_REQUIRED_${field.key.toUpperCase()}`,
          context,
          message: `${field.label} est obligatoire.`,
          reason: `Sage refuse une ligne dont le champ \u00ab ${field.label} \u00bb est vide.`,
          expected: `${field.label} renseign\u00e9 sur chaque ligne.`,
        });
      }
      if (value.length > field.maximum) {
        blocker({
          code: `SAGE_FIELD_TOO_LONG_${field.key.toUpperCase()}`,
          context,
          message: `${field.label} trop long. Valeur : ${value}. Longueur : ${value.length}. Maximum Sage : ${field.maximum}.`,
          value,
          reason: field.key === "thirdParty"
            ? "Le champ \u00ab N\u00b0 compte tiers \u00bb attend un num\u00e9ro de compte tiers du dossier Sage, pas une raison sociale."
            : `Le champ \u00ab ${field.label} \u00bb du format Sage est limit\u00e9 \u00e0 ${field.maximum} caract\u00e8res.`,
          expected: `${field.maximum} caract\u00e8res au maximum.`,
          remedy: field.key === "thirdParty"
            ? "Corrigez le compte tiers associ\u00e9 \u00e0 ce tiers dans les correspondances Sage."
            : `Raccourcissez la valeur \u00e0 ${field.maximum} caract\u00e8res au maximum.`,
        });
      }
    });

    if (row.thirdParty && !/^[A-Za-z0-9]+$/.test(row.thirdParty)) {
      blocker({
        code: "SAGE_THIRD_PARTY_CODE_INVALID",
        context,
        message: `N\u00b0 compte tiers incompatible : ${row.thirdParty}.`,
        value: row.thirdParty,
        reason: "Un num\u00e9ro de compte tiers Sage ne contient que des lettres et des chiffres. Wheat ne modifie jamais un identifiant pour le faire passer.",
        expected: "Lettres et chiffres uniquement.",
        remedy: `Corrigez le compte tiers de \u00ab ${row.thirdPartyName || "ce tiers"} \u00bb dans les correspondances Sage.`,
      });
    }

    if (!/^\d{6}$/.test(row.date)) {
      blocker({
        code: "SAGE_DATE_INVALID",
        context,
        message: `Date de pi\u00e8ce invalide : ${row.date || "vide"}. Format attendu : DDMMYY.`,
        value: row.date || "(vide)",
        reason: "La date de l'\u00e9criture n'a pas pu \u00eatre convertie au format Sage.",
        expected: "Six chiffres, jour, mois puis ann\u00e9e sur deux chiffres.",
        remedy: "V\u00e9rifiez la date de l'\u00e9criture d'origine dans les livres.",
      });
    }
    if (row.dueDate && !/^\d{6}$/.test(row.dueDate)) {
      blocker({
        code: "SAGE_DUE_DATE_INVALID",
        context,
        message: `Date d'\u00e9ch\u00e9ance invalide : ${row.dueDate}. Format attendu : DDMMYY.`,
        value: row.dueDate,
        expected: "Six chiffres, jour, mois puis ann\u00e9e sur deux chiffres.",
      });
    }
    if (!/^[A-Za-z0-9]+$/.test(row.pieceNumber)) {
      blocker({
        code: "SAGE_PIECE_INVALID",
        context,
        message: `N\u00b0 pi\u00e8ce incompatible apr\u00e8s normalisation : ${row.pieceNumber || "vide"}.`,
        value: row.rawPieceNumber || "(vide)",
        reason: "Sage n'accepte que des lettres et des chiffres dans le num\u00e9ro de pi\u00e8ce.",
        expected: "Un num\u00e9ro de pi\u00e8ce contenant au moins une lettre ou un chiffre.",
        remedy: "Corrigez le num\u00e9ro de pi\u00e8ce de l'\u00e9criture d'origine.",
      });
    }
    if (!/^\d+(?:,\d{2})$/.test(row.debit) || !/^\d+(?:,\d{2})$/.test(row.credit)) {
      blocker({
        code: "SAGE_AMOUNT_FORMAT",
        context,
        message: "D\u00e9bit/cr\u00e9dit doivent utiliser une virgule et exactement deux d\u00e9cimales.",
        value: `${row.debit} / ${row.credit}`,
        expected: "Un montant positif au format 1234,56.",
      });
    }
    if (debit < 0n || credit < 0n || (debit === 0n && credit === 0n) || (debit > 0n && credit > 0n)) {
      blocker({
        code: "SAGE_LINE_SIDE",
        context,
        message: "Une ligne ordinaire doit porter un montant positif sur un seul c\u00f4t\u00e9.",
        value: `d\u00e9bit ${row.debit} / cr\u00e9dit ${row.credit}`,
        reason: "Une ligne portant les deux c\u00f4t\u00e9s, aucun c\u00f4t\u00e9, ou un montant n\u00e9gatif ne repr\u00e9sente pas un mouvement comptable exploitable par Sage.",
        expected: "Un seul c\u00f4t\u00e9 renseign\u00e9, avec un montant strictement positif.",
      });
    }
    if (accountLength !== null && row.accountNumber.length !== accountLength) {
      blocker({
        code: "SAGE_ACCOUNT_LENGTH",
        context,
        message: `Compte ${row.accountNumber || "vide"} incompatible. Longueur attendue : ${accountLength}. Longueur actuelle : ${row.accountNumber.length}.`,
        value: row.accountNumber || "(vide)",
        reason: "Le dossier Sage cible est param\u00e9tr\u00e9 avec des num\u00e9ros de compte de longueur fixe.",
        expected: `Exactement ${accountLength} caract\u00e8res.`,
        remedy: `Indiquez le compte Sage correspondant \u00e0 ${row.rawAccountNumber || "ce compte"} dans les correspondances, ou repassez la longueur des comptes sur Variable.`,
      });
    }

    const existingRawPiece = pieceSources.get(row.pieceNumber);
    if (existingRawPiece && existingRawPiece !== row.rawPieceNumber) {
      blocker({
        code: "SAGE_PIECE_COLLISION",
        context,
        message: `Collision N\u00b0 pi\u00e8ce apr\u00e8s normalisation : ${existingRawPiece} et ${row.rawPieceNumber} deviennent ${row.pieceNumber}.`,
        value: `${existingRawPiece} / ${row.rawPieceNumber}`,
        reason: "Sage n'accepte pas la ponctuation dans un num\u00e9ro de pi\u00e8ce ; une fois retir\u00e9e, deux pi\u00e8ces distinctes portent le m\u00eame num\u00e9ro et seraient confondues.",
        expected: "Des num\u00e9ros de pi\u00e8ce qui restent distincts sans ponctuation.",
        remedy: "Renum\u00e9rotez l'une des deux pi\u00e8ces dans les livres Wheat.",
      });
    } else if (row.pieceNumber) {
      pieceSources.set(row.pieceNumber, row.rawPieceNumber);
    }

    const physicalLine = buildSageTxtLine(row);
    if (physicalLine.split(SAGE_TXT_SEPARATOR).length !== 10 || (physicalLine.match(/;/g) ?? []).length !== 9) {
      blocker({
        code: "SAGE_PHYSICAL_SHAPE",
        context,
        message: "La ligne Sage doit contenir exactement 10 champs et 9 points-virgules.",
        expected: "Dix champs s\u00e9par\u00e9s par neuf points-virgules.",
      });
    }
    if (/[\r\n\t]/.test(physicalLine)) {
      blocker({
        code: "SAGE_CONTROL_CHARACTER",
        context,
        message: "La ligne contient un caract\u00e8re de contr\u00f4le incompatible.",
        expected: "Aucun retour \u00e0 la ligne ni tabulation \u00e0 l'int\u00e9rieur d'une ligne.",
      });
    }
  });

  for (const [key, party] of unmappedParties) {
    issues.push({
      code: "SAGE_THIRD_PARTY_ACCOUNT_MISSING",
      severity: "REVIEW",
      message: `Compte tiers Sage manquant pour ${party.name || "un tiers"} \u2014 ${party.lines.length} ligne(s) export\u00e9e(s) sans compte tiers.`,
      value: party.name || key,
      what: `Wheat conna\u00eet ce tiers mais n'a pas de num\u00e9ro de compte tiers Sage pour lui. Le champ \u00ab N\u00b0 compte tiers \u00bb est donc laiss\u00e9 vide sur ${party.lines.length === 1 ? "la ligne" : "les lignes"} ${party.lines.join(", ")}.`,
      reason: "Le champ Sage \u00ab N\u00b0 compte tiers \u00bb attend un num\u00e9ro de compte du dossier Sage cible (17 caract\u00e8res au maximum). Wheat n'y \u00e9crit jamais la raison sociale et n'invente pas de num\u00e9ro, car un compte inexistant serait refus\u00e9 par Sage.",
      expected: "Un compte tiers existant dans le dossier Sage, renseign\u00e9 dans les correspondances.",
      remedy: `Renseignez le compte tiers de \u00ab ${party.name || "ce tiers"} \u00bb dans la section Correspondances, ou confirmez avec la personne qui tient le dossier Sage que ces lignes doivent rester sans compte auxiliaire.`,
      blocking: false,
    });
  }
  for (const [name, lineNumbers] of unidentifiedParties) {
    issues.push({
      code: "SAGE_THIRD_PARTY_NOT_LINKED",
      severity: "REVIEW",
      message: `\u00ab ${name} \u00bb est saisi en texte libre sur ${lineNumbers.length} ligne(s) : aucun compte tiers Sage ne peut lui \u00eatre associ\u00e9.`,
      value: name,
      what: `Ces lignes portent un nom de tiers saisi \u00e0 la main, sans fiche tiers derri\u00e8re lui. Lignes concern\u00e9es : ${lineNumbers.join(", ")}.`,
      reason: "Une correspondance de compte tiers s'appuie sur la fiche du tiers, pas sur un nom saisi : deux orthographes du m\u00eame nom ne sont pas le m\u00eame tiers.",
      expected: "Une \u00e9criture dont les lignes de tiers sont rattach\u00e9es \u00e0 une fiche tiers.",
      remedy: "Rattachez ces lignes \u00e0 la fiche du tiers concern\u00e9 dans les livres, puis revenez sur cet \u00e9cran.",
      blocking: false,
    });
  }
  if (truncatedLabels.length) {
    issues.push({
      code: "SAGE_LABEL_TRUNCATED",
      severity: "WARNING",
      message: `${truncatedLabels.length} libell\u00e9(s) raccourci(s) \u00e0 ${sageFieldMaximum("label")} caract\u00e8res pour Sage.`,
      what: `Le libell\u00e9 d'\u00e9criture est un texte descriptif ; Wheat l'a raccourci pour tenir dans le champ Sage. Lignes concern\u00e9es : ${truncatedLabels.slice(0, 20).join(", ")}${truncatedLabels.length > 20 ? "\u2026" : ""}.`,
      reason: "Le champ Sage \u00ab Libell\u00e9 \u00e9criture \u00bb est limit\u00e9 et le libell\u00e9 ne porte aucune identit\u00e9 comptable : le raccourcir ne change ni compte, ni montant, ni r\u00e9f\u00e9rence.",
      expected: `${sageFieldMaximum("label")} caract\u00e8res au maximum.`,
      autoFix: "le raccourcissement du libell\u00e9, visible tel quel dans l'aper\u00e7u ci-dessous.",
      remedy: "V\u00e9rifiez dans l'aper\u00e7u que le libell\u00e9 raccourci reste compr\u00e9hensible.",
      blocking: false,
    });
  }

  for (const total of entryTotals.values()) {
    if (total.debit !== total.credit) {
      blocker({
        code: "SAGE_ENTRY_UNBALANCED",
        context: total.label,
        message: `\u00e9criture d\u00e9s\u00e9quilibr\u00e9e de ${formatSageAmountFromCents(total.debit - total.credit)}.`,
        value: formatSageAmountFromCents(total.debit - total.credit),
        reason: "Une \u00e9criture dont le d\u00e9bit et le cr\u00e9dit diff\u00e8rent n'est pas une \u00e9criture comptable valide et serait refus\u00e9e par Sage.",
        expected: "D\u00e9bit \u00e9gal au cr\u00e9dit, au centime.",
        remedy: "Corrigez l'\u00e9criture dans les livres avant l'export.",
      });
    }
  }
  if (totalDebit !== totalCredit) {
    blocker({
      code: "SAGE_TOTAL_UNBALANCED",
      message: `Export Sage impossible \u2014 total d\u00e9bit ${formatSageAmountFromCents(totalDebit)}, total cr\u00e9dit ${formatSageAmountFromCents(totalCredit)}, \u00e9cart ${formatSageAmountFromCents(totalDebit - totalCredit)}.`,
      value: formatSageAmountFromCents(totalDebit - totalCredit),
      expected: "Total d\u00e9bit \u00e9gal au total cr\u00e9dit, au centime.",
    });
  }
  if (rows.some((row) => !row.thirdParty)) {
    issues.push({
      code: "SAGE_THIRD_PARTY_EMPTY",
      severity: "WARNING",
      message: "Certaines lignes n'ont pas de compte tiers. V\u00e9rifiez que ces comptes sont bien g\u00e9n\u00e9raux dans le dossier Sage cible.",
      reason: "Un compte collectif du dossier Sage peut exiger un compte auxiliaire ; Wheat ne conna\u00eet pas ce param\u00e9trage.",
      remedy: "V\u00e9rifiez avec la personne qui tient le dossier Sage quels comptes exigent un tiers.",
      blocking: false,
    });
  }
  issues.push({
    code: "SAGE_CODES_MUST_EXIST",
    severity: "WARNING",
    message: "Les codes journaux et comptes doivent exister dans le dossier Sage cible ; Wheat ne les cr\u00e9e jamais automatiquement.",
    reason: "Sage refuse une \u00e9criture qui r\u00e9f\u00e9rence un journal ou un compte inconnu de son dossier.",
    remedy: "Faites valider les codes cibles par la personne qui tient le dossier Sage.",
    blocking: false,
  });

  return {
    issues,
    errors: issueSentences(issues, "BLOCKER"),
    warnings: [...issueSentences(issues, "REVIEW"), ...issueSentences(issues, "WARNING")],
    totalDebitCents: totalDebit.toString(),
    totalCreditCents: totalCredit.toString(),
    differenceCents: (totalDebit - totalCredit).toString(),
  };
}

export function encodeSageWindows1252(text: string): Uint8Array {
  const extensionMap: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  return Uint8Array.from(Array.from(text).map((character) => {
    const code = character.charCodeAt(0);
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) return code;
    return extensionMap[code] ?? 0x3f;
  }));
}
