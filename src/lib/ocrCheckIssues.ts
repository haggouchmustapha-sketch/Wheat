import type { WheatIssue } from "./wheatIssues";

/**
 * A document whose own arithmetic does not hold, explained.
 *
 * The extraction pipeline already scores every reading it considered against
 * the arithmetic an invoice must satisfy, and records the verdict per rule.
 * Those verdicts were only ever shown inside a collapsed panel called
 * "Diagnostic d'extraction (avancé)", as a status word and a terse detail — so
 * the person correcting the document never saw that its totals did not add up,
 * and the person who did open the panel got no explanation of what to change.
 *
 * A failed check is exactly the moment an accountant needs the four things a
 * `WheatIssue` carries: what was checked, on which values, why it matters and
 * what to do next. The check itself is the only thing that knows, so the answer
 * is written here rather than generated.
 *
 * Two limits, as everywhere else in this family of modules:
 *
 *   - Only rules the pipeline really produces are listed. An unrecognised
 *     check id keeps its own label and detail and gains no explanation.
 *   - The check's own `detail` — which names the actual figures read off the
 *     page — is preserved as the technical disclosure, never paraphrased.
 *     Restating a number in different words is how a wrong number becomes
 *     believable.
 */

export type OcrAccountingCheck = {
  id?: string;
  label?: string;
  status?: string;
  detail?: string;
};

type Rule = Omit<WheatIssue, "code" | "severity" | "technical"> & { severity?: WheatIssue["severity"] };

const RULES: Record<string, Rule> = {
  "ht-plus-tva-equals-ttc": {
    message: "Le total TTC ne correspond pas à HT + TVA.",
    what: "Les trois montants ont été lus, mais ils ne s'additionnent pas.",
    reason: "Sur une facture, le TTC est la somme du HT et de la TVA. Quand l'égalité tombe à côté, l'un des trois a été mal lu — le plus souvent un chiffre collé à un séparateur, ou un sous-total pris pour le total.",
    expected: "HT + TVA = TTC, au centime près.",
    remedy: "Comparez les trois montants à la facture et corrigez celui qui est faux. Wheat ne recalcule aucun des trois à votre place.",
  },
  "total-is-sum-of-parts": {
    message: "Le total ne correspond pas à la somme de ses composantes.",
    what: "Le TTC lu ne s'obtient pas à partir du HT, de la TVA, des débours et de la remise lus sur la même page.",
    reason: "Une facture marocaine peut porter des débours et une remise, qui entrent dans le total sans être de la TVA. Un écart signale soit un montant mal lu, soit une ligne annexe attribuée au mauvais poste.",
    expected: "TTC = HT + TVA (+ débours − remise).",
    remedy: "Vérifiez les débours et la remise avant les trois montants principaux : c'est là que l'écart vient le plus souvent.",
  },
  "vat-matches-rate": {
    message: "La TVA ne correspond pas au taux indiqué.",
    what: "Le montant de TVA lu n'est pas celui que produirait le taux imprimé appliqué à la base HT.",
    reason: "Le taux et la base déterminent la TVA. Un désaccord vient d'un taux mal lu, d'une base qui n'est pas celle à laquelle il s'applique, ou d'une facture à plusieurs taux dont un seul a été retenu.",
    expected: "TVA = HT × taux.",
    remedy: "Si la facture porte plusieurs taux, corrigez la ventilation plutôt que le total ; sinon corrigez le taux ou la base.",
  },
  "vat-rate-consistent": {
    message: "Le taux de TVA imprimé et le taux calculé ne concordent pas.",
    what: "Le taux indiqué sur la facture n'est pas celui qui ressort du rapport entre la TVA et le HT lus.",
    reason: "Les deux devraient donner le même taux. Un écart indique qu'au moins un des deux montants n'appartient pas à la même base que le taux imprimé.",
    expected: "Le taux imprimé et le taux implicite se rejoignent.",
    remedy: "Reprenez la ventilation par taux telle qu'elle figure sur la facture.",
  },
  "vat-rate-statutory": {
    message: "Le taux de TVA lu n'est pas un taux marocain en vigueur.",
    what: "Le taux retenu ne figure pas parmi les taux applicables au Maroc.",
    reason: "Les taux sont fixés par la loi. Un taux hors barème vient presque toujours d'une lecture abîmée — un 7 lu pour un 1, un séparateur avalé.",
    expected: "L'un des taux marocains en vigueur (0 %, 7 %, 10 %, 14 %, 20 %).",
    remedy: "Corrigez le taux d'après la facture. Si la facture porte réellement un taux inhabituel, la pièce demande l'avis d'un comptable avant d'être comptabilisée.",
  },
  "stated-rate-statutory": {
    message: "Le taux imprimé sur la facture n'est pas un taux marocain en vigueur.",
    what: "Le taux tel qu'il est écrit sur la pièce ne figure pas au barème.",
    reason: "Soit le taux a été mal reconnu, soit la facture elle-même porte un taux qui n'existe pas.",
    expected: "L'un des taux marocains en vigueur (0 %, 7 %, 10 %, 14 %, 20 %).",
    remedy: "Vérifiez le taux sur la pièce d'origine avant de corriger.",
  },
  "implied-rate-statutory": {
    message: "Le taux qui découle des montants n'est pas un taux marocain en vigueur.",
    what: "Le rapport entre la TVA et le HT lus ne donne aucun taux du barème.",
    reason: "Quand les montants impliquent un taux qui n'existe pas, c'est l'un des montants qui est faux, pas le barème.",
    expected: "Un rapport TVA / HT correspondant à un taux en vigueur.",
    remedy: "Corrigez le HT ou la TVA ; le taux se recalculera à partir des montants exacts.",
  },
  "vat-not-above-base": {
    message: "La TVA lue dépasse la base HT.",
    what: "Le montant de TVA est supérieur au montant hors taxe auquel il s'applique.",
    reason: "Aucun taux marocain ne dépasse 20 %, donc la TVA ne peut pas excéder la base. Cet écart vient presque toujours de deux colonnes interverties.",
    expected: "TVA nettement inférieure au HT.",
    remedy: "Vérifiez que les colonnes HT et TVA n'ont pas été inversées à la lecture.",
  },
  "total-not-below-base": {
    message: "Le total TTC est inférieur à la base HT.",
    what: "Le TTC lu est plus petit que le HT lu.",
    reason: "Le TTC comprend le HT ; il ne peut lui être inférieur. C'est le signe qu'un sous-total, un acompte ou un montant d'une autre colonne a été pris pour le total.",
    expected: "TTC supérieur ou égal au HT.",
    remedy: "Cherchez le total réel en bas de la facture — le montant lu est probablement une ligne intermédiaire.",
  },
  "ttc-sign": {
    message: "Le sens du montant ne correspond pas au type de pièce.",
    what: "Le signe du total ne va pas avec un document de ce type.",
    reason: "Une facture porte un montant positif, un avoir un montant négatif. Un signe qui ne colle pas indique que la pièce a été classée dans le mauvais sens, et une pièce comptabilisée à l'envers fausse le résultat comme la TVA.",
    expected: "Une facture positive, un avoir négatif.",
    remedy: "Corrigez le type du document avant ses montants : c'est le type qui décide du sens.",
  },
  "line-items-sum-to-ht": {
    severity: "REVIEW",
    message: "Le détail des lignes ne totalise pas le HT.",
    what: "La somme des lignes reconnues dans le tableau ne donne pas le montant hors taxe retenu.",
    reason: "Le tableau d'une facture scannée est ce qui se lit le plus mal : une ligne peut manquer, ou deux lignes fusionner. Le HT global reste souvent juste même quand le détail ne l'est pas.",
    expected: "La somme des lignes égale le HT.",
    remedy: "Si le HT global est correct, la pièce est comptabilisable ; corrigez le détail seulement si vous en avez besoin ligne à ligne.",
  },
};

/**
 * The failed and skipped-but-notable checks, as issues. Checks that passed are
 * not issues, and an unrecognised id is left to the diagnostics panel.
 */
export function ocrCheckIssues(checks: OcrAccountingCheck[] | undefined): WheatIssue[] {
  return (checks ?? [])
    .filter((check) => String(check?.status ?? "").toUpperCase() === "FAILED")
    .flatMap((check) => {
      const rule = RULES[String(check?.id ?? "")];
      if (!rule) return [];
      const { severity, ...rest } = rule;
      return [{
        ...rest,
        code: String(check.id),
        severity: severity ?? "REVIEW",
        // A failed arithmetic check never blocks: the accountant decides
        // whether the page or the reading is wrong, and Wheat cannot.
        blocking: false,
        context: check.label ? String(check.label) : undefined,
        // The figures the check actually compared, in its own words.
        technical: check.detail ? String(check.detail) : undefined,
      }];
    });
}
