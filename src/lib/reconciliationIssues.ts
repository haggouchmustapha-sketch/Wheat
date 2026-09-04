import type { WheatIssue } from "./wheatIssues";

/**
 * What a refused reconciliation actually means, from what the refusal already
 * knew.
 *
 * The reconciliation service states its refusals as one short sentence, in
 * English, thrown from the main process — accurate for a developer reading a
 * log and close to useless for an accountant looking at a bank movement they
 * cannot settle. The rule that refused is nonetheless a real rule with a real
 * reason and a real way forward, and none of that has to be guessed: it is
 * written down here, beside the sentence it explains.
 *
 * Two deliberate limits, both borrowed from `bankImportIssues`:
 *
 *   - Every entry below is a rule the service really enforces. A message this
 *     module does not recognise keeps its own sentence and gains no
 *     explanation. An invented rationale beside a real refusal is worse than
 *     no rationale, because it will be believed.
 *   - The service's own wording is never displayed as the headline where a
 *     recognised rule can state it in the language of the person reading it.
 *     The English original is kept as the technical detail, so a support
 *     conversation can still name the exact refusal.
 *
 * Nothing here reaches a model, and nothing is generated at display time.
 */

type Rule = { match: RegExp } & Omit<WheatIssue, "code" | "severity"> & {
  code: string;
  severity?: WheatIssue["severity"];
};

const RULES: Rule[] = [
  {
    code: "BANK_ACCOUNT_NOT_MAPPED",
    match: /map this bank account to a general-ledger bank account/i,
    message: "Ce compte bancaire n'est rattaché à aucun compte du plan comptable.",
    what: "Wheat ne sait pas dans quel compte général les mouvements de ce compte bancaire sont enregistrés.",
    reason: "Un rapprochement associe un mouvement du relevé à une ligne d'écriture portée sur le compte général de la banque. Sans ce rattachement, il n'y a aucune ligne à proposer.",
    expected: "Un compte de trésorerie (classe 5) associé au compte bancaire.",
    remedy: "Ouvrez Paramètres › Comptes bancaires, puis renseignez le compte général de ce compte bancaire.",
  },
  {
    code: "BANK_ACCOUNT_ARCHIVED",
    match: /restore this archived bank account/i,
    message: "Ce compte bancaire est archivé.",
    what: "Le compte bancaire de ce mouvement a été archivé.",
    reason: "Un compte archivé est conservé pour l'historique mais n'accepte plus d'opération nouvelle ; l'archivage serait sans effet si l'on pouvait continuer à écrire dessus.",
    remedy: "Réactivez le compte bancaire dans Paramètres › Comptes bancaires, ou traitez ce mouvement depuis le compte qui l'a remplacé.",
  },
  {
    code: "LEDGER_ACCOUNT_ARCHIVED",
    match: /restore the mapped general-ledger account/i,
    message: "Le compte général associé à cette banque est archivé.",
    what: "Le compte du plan comptable sur lequel ce compte bancaire est rattaché a été archivé.",
    reason: "Rapprocher écrirait sur un compte que le dossier a mis hors service.",
    remedy: "Réactivez ce compte dans le plan comptable, ou rattachez le compte bancaire à un compte de trésorerie actif.",
  },
  {
    code: "MOVEMENT_CHANGED_ELSEWHERE",
    match: /changed in another window/i,
    severity: "REVIEW",
    message: "Ce mouvement a changé depuis son affichage.",
    what: "Le mouvement — ou son lot de rapprochement — a été modifié ailleurs pendant que cet écran était ouvert.",
    reason: "Wheat n'applique une opération que sur la version exacte qui a été montrée. Appliquer sur une version plus ancienne écraserait un travail que quelqu'un vient de faire, sans que personne le voie.",
    remedy: "Rechargez l'écran, vérifiez l'état actuel du mouvement, puis recommencez si l'opération est toujours nécessaire.",
    autoFix: "rien — la décision appartient à la personne qui voit les deux états.",
  },
  {
    code: "ALLOCATION_REQUIRED",
    match: /at least one accounting-line allocation is required/i,
    message: "Sélectionnez la ligne comptable que ce mouvement règle.",
    what: "La confirmation a été demandée sans qu'aucune ligne d'écriture ne soit affectée au mouvement.",
    reason: "Un rapprochement est le lien entre un mouvement du relevé et l'écriture qui le justifie. Un règlement rattaché comme preuve accompagne ce lien : il ne le remplace pas.",
    expected: "Au moins une ligne comptable candidate, avec le montant à lui affecter.",
    remedy: "Choisissez une ligne dans « Lignes comptables candidates ». Si aucune ne convient, utilisez la recherche, ou comptabilisez d'abord l'écriture manquante.",
  },
  {
    code: "MOVEMENT_ZERO",
    match: /zero-value bank movement cannot be reconciled/i,
    message: "Un mouvement d'un montant nul ne peut pas être rapproché.",
    what: "Ce mouvement porte un montant de 0.",
    reason: "Il n'y a rien à affecter : un mouvement nul ne règle aucune écriture. Une ligne à zéro vient presque toujours d'une colonne de montant mal reconnue à l'import.",
    remedy: "Vérifiez la ligne dans le relevé d'origine. Si elle n'est pas un mouvement, excluez-la avec un motif ; si son montant a été mal lu, réimportez le relevé avec la bonne correspondance de colonnes.",
  },
  {
    code: "MOVEMENT_FULLY_RECONCILED",
    match: /already fully reconciled/i,
    message: "Ce mouvement est déjà entièrement rapproché.",
    what: "La totalité du montant du mouvement est déjà affectée à des écritures.",
    reason: "Affecter davantage ferait porter au mouvement plus que ce que la banque a réellement débité ou crédité.",
    remedy: "Pour changer cette affectation, annulez le lot de rapprochement concerné — l'historique et les montants d'origine sont conservés — puis refaites-la.",
  },
  {
    code: "ALLOCATION_EXCEEDS_REMAINING",
    match: /allocations exceed the movement's remaining amount/i,
    message: "Le montant affecté dépasse ce qu'il reste à rapprocher sur ce mouvement.",
    what: "Le total demandé est supérieur au montant du mouvement encore non affecté.",
    reason: "La somme des affectations d'un mouvement ne peut jamais dépasser son montant : ce serait rapprocher de l'argent que la banque n'a pas fait circuler.",
    expected: "Un montant inférieur ou égal au « reste à rapprocher » affiché dans l'inspecteur.",
    remedy: "Réduisez le montant, ou affectez le solde à une seconde écriture en une seconde opération.",
  },
  {
    code: "EVIDENCE_EXCEEDS_ALLOCATION",
    match: /payment evidence cannot exceed/i,
    message: "Les règlements rattachés dépassent le montant affecté à l'écriture.",
    what: "Le total des règlements cochés comme preuve est supérieur à l'allocation comptable de ce lot.",
    reason: "Un règlement est la preuve de ce qui a été affecté, pas une affectation supplémentaire. Un chèque ne peut pas prouver plus que le montant rapproché.",
    remedy: "Décochez un règlement, ou augmentez le montant affecté à la ligne comptable si le mouvement le permet.",
  },
  {
    code: "MOVEMENT_EXCLUDED",
    match: /restore this excluded movement/i,
    message: "Ce mouvement a été exclu du rapprochement.",
    what: "Quelqu'un a écarté ce mouvement, avec un motif, de la file à rapprocher.",
    reason: "Un mouvement exclu reste dans l'historique mais n'est plus traité. Le restaurer est une décision explicite, pour que la sortie de la file reste traçable.",
    remedy: "Utilisez « Examiner la restauration » dans l'inspecteur pour le remettre dans la file, puis rapprochez-le.",
  },
  {
    code: "VOID_BATCHES_FIRST",
    match: /void all active reconciliation batches before excluding/i,
    message: "Annulez d'abord les lots de rapprochement actifs de ce mouvement.",
    what: "Ce mouvement porte encore au moins un lot de rapprochement actif.",
    reason: "Exclure un mouvement encore rapproché laisserait des écritures rattachées à un mouvement retiré de la file — un lien que plus aucun écran ne montrerait.",
    remedy: "Annulez chaque lot actif avec son motif dans « Lots actifs », puis excluez le mouvement.",
  },
  {
    code: "MOVEMENT_NOT_EXCLUDED",
    match: /this bank movement is not excluded/i,
    message: "Ce mouvement n'est pas exclu : il n'y a rien à restaurer.",
    what: "Une restauration a été demandée sur un mouvement qui figure déjà dans la file à rapprocher.",
    reason: "Son état a probablement changé depuis l'affichage de cet écran.",
    remedy: "Rechargez l'écran pour voir l'état actuel du mouvement.",
  },
  {
    code: "REASON_REQUIRED",
    match: /(a void reason|an exclusion reason) is required/i,
    message: "Indiquez le motif de cette opération.",
    what: "L'annulation d'un lot et l'exclusion d'un mouvement demandent toutes deux un motif écrit.",
    reason: "Rien n'est supprimé dans Wheat : une annulation et une exclusion sont conservées dans la piste d'audit. Le motif est ce qui rendra la décision compréhensible plus tard, par quelqu'un d'autre.",
    expected: "Une phrase courte disant pourquoi.",
    remedy: "Écrivez le motif dans le champ prévu, puis confirmez.",
  },
  {
    code: "RECONCILIATION_ALREADY_VOID",
    match: /this reconciliation is already void/i,
    message: "Ce lot de rapprochement a déjà été annulé.",
    what: "Le lot visé porte déjà le statut annulé.",
    reason: "Un lot annulé reste consultable dans l'historique, mais ne peut pas être annulé une seconde fois.",
    remedy: "Rechargez l'écran ; l'affichage date d'avant l'annulation.",
  },
  {
    code: "RECORD_DISAPPEARED",
    match: /(accounting lines|payment records) no longer exist/i,
    message: "Une des pièces sélectionnées n'existe plus.",
    what: "Une écriture ou un règlement choisi dans cet écran a disparu avant la confirmation.",
    reason: "Wheat vérifie l'existence de chaque pièce au moment d'écrire, dans la même transaction, plutôt que de se fier à ce qui était affiché.",
    remedy: "Rechargez l'écran et refaites la sélection à partir de ce qui existe réellement.",
  },
];

/**
 * The structured explanation for a refusal, or `null` when the rule behind it
 * is not one this module knows about.
 */
export function reconciliationIssue(message: unknown): WheatIssue | null {
  const original = String(message ?? "").trim();
  if (!original) return null;
  const rule = RULES.find((candidate) => candidate.match.test(original));
  if (!rule) return null;
  const { match, severity, ...issue } = rule;
  void match;
  return {
    ...issue,
    severity: severity ?? "BLOCKER",
    blocking: (severity ?? "BLOCKER") === "BLOCKER",
    // Kept so a support conversation can still name the exact refusal.
    technical: original,
  };
}
