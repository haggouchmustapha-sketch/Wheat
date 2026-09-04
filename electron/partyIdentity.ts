/**
 * Deciding whether two named parties are the same legal entity.
 *
 * Wheat asks this question in three places that used to answer it differently:
 * the OCR classifier deciding whether the dossier issued or received a
 * document, the invoice builder deciding which third party to post against, and
 * the assistant resolving a name a user typed. One wrong answer in the first of
 * those produced the regression this module exists to remove — a sales invoice
 * the dossier had issued was filed as a purchase, and the dossier was recorded
 * as its own supplier.
 *
 * The rules, in the order they are applied:
 *
 *   1. ICE. A Moroccan ICE identifies one entity and nothing else. Two ICEs
 *      that differ mean two entities, whatever the names say.
 *   2. IF (identifiant fiscal). Same reasoning, slightly weaker in practice
 *      because it is reprinted less consistently.
 *   3. RC, but only paired with a matching city or a matching name: an RC
 *      number is unique per commercial court, not nationally.
 *   4. Normalized legal name, once punctuation, accents, case, whitespace and
 *      legal-form suffixes are removed.
 *
 * A name may confirm an identifier. It may never overrule one: a document whose
 * ICE belongs to somebody else is not the dossier because the letterhead
 * happens to read alike.
 */

export type PartyIdentity = {
  name?: string | null;
  ice?: string | null;
  taxId?: string | null;
  rc?: string | null;
  city?: string | null;
};

export type IdentityBasis = "ICE" | "IF" | "RC" | "NAME";

export type IdentityMatch = {
  /**
   * `SAME` and `DIFFERENT` are assertions Wheat is willing to act on.
   * `UNKNOWN` means the two parties share no comparable attribute — it is not
   * a weak `DIFFERENT`, and nothing may be defaulted from it.
   */
  verdict: "SAME" | "DIFFERENT" | "UNKNOWN";
  /** The strongest attribute that produced the verdict. */
  basis: IdentityBasis | null;
  /** 0-100. An identifier match scores far above a name match. */
  confidence: number;
  /**
   * True when the attributes disagree among themselves — a matching name with a
   * contradicting ICE, most often a letterhead reused by a sister company. The
   * verdict is then `DIFFERENT`, and the caller is expected to ask rather than
   * proceed silently.
   */
  conflict: boolean;
  reasons: string[];
};

/** Suffixes that name a legal form rather than the entity itself. */
const LEGAL_SUFFIXES = [
  "S A R L AU", "S A R L A U", "SARL AU", "S A R L", "SARLAU", "SARL",
  "S A S U", "S A S", "SASU", "SAS", "SNC", "SCS", "SCA", "SCI", "SPA",
  "S A", "SA", "GIE", "STE", "SOCIETE", "COOPERATIVE", "COOP", "GROUPE", "GROUP", "HOLDING",
  "COMPANY", "CO", "LTD", "LIMITED", "LLC", "INC", "EURL", "AUTO ENTREPRENEUR",
];

/**
 * Reduces a company name to the part that identifies it.
 *
 * Accents, case, punctuation and repeated whitespace go first — a scanner and a
 * keyboard disagree about all four. Legal-form words are then removed from both
 * ends, so that "Sté IFCOF S.A.R.L. AU" and "IFCOF" compare equal, while
 * "IFCOF CONSEIL" stays distinct from "IFCOF".
 */
export function normalizeCompanyName(value: unknown): string {
  const base = String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!base) return "";

  let tokens = base.split(" ");
  const isSuffix = (from: number, length: number) => LEGAL_SUFFIXES.includes(tokens.slice(from, from + length).join(" "));
  // Strip from both ends: Moroccan practice puts "Sté" in front and "SARL AU"
  // behind. Longest first, because removing punctuation has already exploded
  // "S.A.R.L. AU" into five tokens, and the one-word "S" would otherwise be
  // tried against a phrase it is only the head of.
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    for (const length of [5, 4, 3, 2, 1]) {
      if (tokens.length > length && isSuffix(0, length)) { tokens = tokens.slice(length); changed = true; break; }
      if (tokens.length > length && isSuffix(tokens.length - length, length)) { tokens = tokens.slice(0, tokens.length - length); changed = true; break; }
    }
  }
  return tokens.join(" ");
}

/** Keeps only the digits: an ICE is printed with spaces as often as without. */
export function normalizeIdentifier(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** A Moroccan ICE is fifteen digits. Anything else is a misread, not an ICE. */
export function isPlausibleIce(value: unknown): boolean {
  return /^\d{15}$/.test(normalizeIdentifier(value));
}

function comparable(left: string, right: string) {
  return Boolean(left && right);
}

/**
 * Compares two parties and says whether they are the same entity.
 *
 * Both arguments are symmetrical; neither is privileged. The caller decides
 * what a `SAME` means — for the OCR classifier, that the dossier is that side
 * of the document.
 */
export function matchPartyIdentity(left: PartyIdentity, right: PartyIdentity): IdentityMatch {
  const reasons: string[] = [];
  const leftIce = normalizeIdentifier(left.ice);
  const rightIce = normalizeIdentifier(right.ice);
  const leftIf = normalizeIdentifier(left.taxId);
  const rightIf = normalizeIdentifier(right.taxId);
  const leftRc = normalizeIdentifier(left.rc);
  const rightRc = normalizeIdentifier(right.rc);
  const leftName = normalizeCompanyName(left.name);
  const rightName = normalizeCompanyName(right.name);

  const iceComparable = comparable(leftIce, rightIce);
  const ifComparable = comparable(leftIf, rightIf);
  const rcComparable = comparable(leftRc, rightRc);
  const nameComparable = comparable(leftName, rightName);
  const nameAgrees = nameComparable && leftName === rightName;

  // 1. ICE decides on its own, in both directions.
  if (iceComparable) {
    if (leftIce === rightIce) {
      reasons.push("Les deux parties portent le même ICE.");
      return { verdict: "SAME", basis: "ICE", confidence: 99, conflict: false, reasons };
    }
    reasons.push("Les ICE des deux parties diffèrent.");
    if (nameAgrees) {
      reasons.push("La raison sociale correspond malgré un ICE différent : l'ICE fait foi, le rapprochement est signalé.");
      return { verdict: "DIFFERENT", basis: "ICE", confidence: 90, conflict: true, reasons };
    }
    return { verdict: "DIFFERENT", basis: "ICE", confidence: 97, conflict: false, reasons };
  }

  // 2. IF, when no ICE was available on both sides.
  if (ifComparable) {
    if (leftIf === rightIf) {
      reasons.push("Les deux parties portent le même identifiant fiscal.");
      return { verdict: "SAME", basis: "IF", confidence: 95, conflict: false, reasons };
    }
    reasons.push("Les identifiants fiscaux des deux parties diffèrent.");
    if (nameAgrees) {
      reasons.push("La raison sociale correspond malgré un identifiant fiscal différent : à confirmer.");
      return { verdict: "DIFFERENT", basis: "IF", confidence: 80, conflict: true, reasons };
    }
    return { verdict: "DIFFERENT", basis: "IF", confidence: 92, conflict: false, reasons };
  }

  // 3. RC, which is unique only within its commercial court: it may confirm an
  //    agreeing name, and it is never enough on its own.
  if (rcComparable && leftRc === rightRc && nameAgrees) {
    reasons.push("Le registre de commerce et la raison sociale correspondent.");
    return { verdict: "SAME", basis: "RC", confidence: 90, conflict: false, reasons };
  }
  if (rcComparable && leftRc === rightRc && !nameComparable) {
    reasons.push("Le registre de commerce correspond, mais aucun nom comparable ne le confirme.");
    return { verdict: "UNKNOWN", basis: "RC", confidence: 45, conflict: false, reasons };
  }

  // 4. Name alone. Enough to act on, weak enough to be worth saying so.
  if (nameComparable) {
    if (nameAgrees) {
      reasons.push("Les raisons sociales normalisées sont identiques ; aucun identifiant commun n'était disponible.");
      return { verdict: "SAME", basis: "NAME", confidence: 74, conflict: false, reasons };
    }
    reasons.push("Les raisons sociales normalisées diffèrent et aucun identifiant commun n'était disponible.");
    return { verdict: "DIFFERENT", basis: "NAME", confidence: 60, conflict: false, reasons };
  }

  reasons.push("Aucun attribut comparable entre les deux parties.");
  return { verdict: "UNKNOWN", basis: null, confidence: 0, conflict: false, reasons };
}

/**
 * Which side of a document the dossier is on.
 *
 * `null` is a real answer and the important one: it says the document could not
 * be attributed, which is what a person has to settle. Wheat used to answer
 * "purchase" here, and a fiduciaire's own sales invoices were filed against
 * itself as supplier.
 */
export type DocumentSide = "ISSUER" | "RECIPIENT" | null;

export type SideResolution = {
  side: DocumentSide;
  issuerMatch: IdentityMatch;
  recipientMatch: IdentityMatch;
  /**
   * `UNMATCHED` and `AMBIGUOUS` are different problems and get different
   * answers: nothing on the page ties the document to this dossier, versus the
   * page says two contradictory things. Only the second is worth showing a
   * conflict warning for; both leave `side` null.
   */
  status: "RESOLVED" | "UNMATCHED" | "AMBIGUOUS";
  /** True when both sides claim to be the dossier, or the evidence disagrees. */
  ambiguous: boolean;
  reasons: string[];
};

export function resolveDossierSide(
  dossier: PartyIdentity | null | undefined,
  issuer: PartyIdentity | null | undefined,
  recipient: PartyIdentity | null | undefined,
): SideResolution {
  const none: IdentityMatch = { verdict: "UNKNOWN", basis: null, confidence: 0, conflict: false, reasons: [] };
  if (!dossier || (!dossier.ice && !dossier.taxId && !dossier.name)) {
    return { side: null, issuerMatch: none, recipientMatch: none, status: "UNMATCHED", ambiguous: true, reasons: ["Le dossier actif ne porte aucun identifiant ni raison sociale exploitable."] };
  }
  const issuerMatch = issuer ? matchPartyIdentity(dossier, issuer) : none;
  const recipientMatch = recipient ? matchPartyIdentity(dossier, recipient) : none;
  const reasons: string[] = [];

  const issuerIsDossier = issuerMatch.verdict === "SAME";
  const recipientIsDossier = recipientMatch.verdict === "SAME";

  if (issuerIsDossier && recipientIsDossier) {
    reasons.push("Les deux parties de la pièce correspondent au dossier actif : classement impossible sans contrôle humain.");
    return { side: null, issuerMatch, recipientMatch, status: "AMBIGUOUS", ambiguous: true, reasons };
  }
  if (issuerIsDossier) {
    reasons.push(`Le dossier actif est l'émetteur de la pièce (${issuerMatch.basis}).`, ...issuerMatch.reasons);
    // A name-only match on one side is worth much less when the other side was
    // never even comparable; it is still a match, and it is reported as such.
    return { side: "ISSUER", issuerMatch, recipientMatch, status: "RESOLVED", ambiguous: issuerMatch.conflict, reasons };
  }
  if (recipientIsDossier) {
    reasons.push(`Le dossier actif est le destinataire de la pièce (${recipientMatch.basis}).`, ...recipientMatch.reasons);
    return { side: "RECIPIENT", issuerMatch, recipientMatch, status: "RESOLVED", ambiguous: recipientMatch.conflict, reasons };
  }

  reasons.push("Aucune des deux parties de la pièce ne correspond au dossier actif.");
  const conflicting = issuerMatch.conflict || recipientMatch.conflict;
  if (conflicting) reasons.push("Des informations contradictoires (nom identique, identifiant différent) ont été relevées.");
  // A page that says two contradictory things is a different problem from a
  // page that simply does not mention this dossier, and only the first is worth
  // warning about.
  return { side: null, issuerMatch, recipientMatch, status: conflicting ? "AMBIGUOUS" : "UNMATCHED", ambiguous: conflicting, reasons };
}

/** The ledger side a document belongs to, once the dossier's role is known. */
export function invoiceKindForSide(side: DocumentSide): "SALE" | "PURCHASE" | null {
  return side === "ISSUER" ? "SALE" : side === "RECIPIENT" ? "PURCHASE" : null;
}
