import type { WheatIssue } from "./wheatIssues";

/**
 * What a rejected statement row actually means, from what the check already
 * knew.
 *
 * The importer refuses a row with one sentence — "Date de la ligne 3 : le
 * format de date « 06 2026 » n'est pas reconnu" — which is accurate and leaves
 * the person to work out what to do about it. The row it refused is right
 * there, so the value that caused the refusal, the rule, and the remedy can all
 * be stated rather than left to be inferred.
 *
 * Every recognised case below is a rule the importer really has. A reason this
 * does not recognise keeps its own sentence and gains no explanation: an
 * invented rationale beside a real refusal is worse than none, because it will
 * be believed.
 */

export type BankImportRowError = { row?: number | null; reason?: string | null };

const RULES: Array<{
  match: RegExp;
  build: (reason: string, row: Record<string, unknown> | null) => Partial<WheatIssue>;
}> = [
  {
    // A date the statement never wrote in full, on a statement whose year
    // cannot be established from anywhere reliable.
    match: /pas d'ann[ée]e|aucun contexte de relev[ée]/i,
    build: () => ({
      what: "La date de cette ligne ne comporte que le jour et le mois, et le relevé n'établit son année nulle part de façon fiable.",
      reason: "Wheat lit l'année dans les dates complètes du relevé, sa période, ou sa ligne de solde final. Elle n'est jamais déduite du libellé d'une opération : un numéro de chèque n'est pas une année.",
      expected: "Une date complète, ou un relevé dont l'année figure ailleurs sur la page.",
      remedy: "Corrigez la date dans le fichier, ou importez un relevé couvrant une seule année et portant sa date complète.",
    }),
  },
  {
    match: /format de date .* n'est pas reconnu|n'existe pas dans le calendrier|est invalide/i,
    build: () => ({
      what: "La valeur de la colonne de date n'a pas pu être lue comme une date.",
      reason: "Une date importée doit correspondre à l'un des formats acceptés ; Wheat ne devine pas ce qu'une valeur illisible voulait dire.",
      expected: "290526, 29/05/26, 29/05/2026, 29-05-2026, 29.05.2026 ou 2026-05-29.",
      remedy: "Vérifiez que la colonne « Date » du mapping désigne bien la colonne des dates d'opération, puis corrigez la valeur dans le fichier si nécessaire.",
    }),
  },
  {
    match: /both a debit and a credit|d[ée]bit et un cr[ée]dit/i,
    build: () => ({
      what: "Cette ligne porte un montant des deux côtés à la fois.",
      reason: "Un mouvement bancaire est soit un débit, soit un crédit. Une ligne portant les deux ne décrit aucun mouvement réel et vient presque toujours d'un décalage de colonnes.",
      expected: "Un seul des deux montants renseigné par ligne.",
      remedy: "Contrôlez la correspondance des colonnes Débit et Crédit : sur un relevé scanné, l'intitulé peut se trouver au-dessus d'une colonne voisine.",
    }),
  },
  {
    match: /zero movement amount|montant.*z[ée]ro|mouvement nul/i,
    build: () => ({
      what: "Cette ligne ne porte aucun montant.",
      reason: "Une ligne sans montant n'est pas un mouvement : c'est un en-tête, un total, ou une ligne dont la colonne des montants n'a pas été lue.",
      expected: "Un montant non nul sur l'un des deux côtés.",
      remedy: "Si la ligne est bien un mouvement, vérifiez le mapping des colonnes de montant ; sinon elle sera exclue de l'import.",
    }),
  },
  {
    match: /not a valid monetary value|montant.*invalide/i,
    build: (_reason, row) => ({
      what: "La valeur de la colonne de montant n'a pas pu être lue comme un montant.",
      value: row ? Object.values(row).map((value) => String(value ?? "")).find((value) => /\d/.test(value) && /[a-zA-Z]/.test(value)) : undefined,
      reason: "Wheat conserve les centimes exactement et refuse d'arrondir ou d'interpréter une valeur ambiguë.",
      expected: "Un nombre, avec ou sans séparateurs de milliers, à deux décimales au plus.",
      remedy: "Vérifiez la colonne choisie pour les montants : du texte de bas de page contient souvent des chiffres sans être un montant.",
    }),
  },
  {
    match: /label is required|libell[ée].*obligatoire/i,
    build: () => ({
      what: "Cette ligne n'a pas de libellé.",
      reason: "Le libellé est ce qui permet ensuite de rapprocher le mouvement d'une écriture ; Wheat n'en fabrique pas.",
      expected: "Une colonne de libellé renseignée sur chaque mouvement.",
      remedy: "Vérifiez que la correspondance « Libellé » désigne la bonne colonne du fichier.",
    }),
  },
];

/**
 * One structured issue per rejected row, in the order the importer produced
 * them. `rows` is the parsed file, used only to quote back the offending line.
 */
export function bankImportIssues(
  errors: BankImportRowError[] | undefined,
  rows: Array<Record<string, unknown>> | undefined,
): WheatIssue[] {
  return (errors ?? []).map((error) => {
    const reason = String(error?.reason ?? "").trim() || "Ligne refusée par les contrôles d'import.";
    const rowNumber = Number(error?.row);
    const row = Number.isInteger(rowNumber) && rowNumber > 0 ? (rows ?? [])[rowNumber - 1] ?? null : null;
    const rule = RULES.find((candidate) => candidate.match.test(reason));
    const extra = rule ? rule.build(reason, row) : {};
    return {
      code: "BANK_IMPORT_ROW_REJECTED",
      severity: "BLOCKER",
      blocking: true,
      context: Number.isInteger(rowNumber) && rowNumber > 0 ? `Ligne ${rowNumber}` : "Relevé",
      message: reason,
      // The line as the file actually contains it, so the person can see what
      // Wheat was looking at rather than guessing.
      value: row ? Object.entries(row).filter(([key]) => !key.startsWith("__")).map(([key, cell]) => `${key} = ${String(cell ?? "")}`).join(" · ").slice(0, 400) : undefined,
      ...extra,
    };
  });
}
