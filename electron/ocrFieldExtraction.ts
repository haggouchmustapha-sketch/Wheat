/**
 * Semantic layer of Wheat's document pipeline: what the recognised page means.
 *
 * Recognition answers "what characters are on this page". Layout answers "what
 * sits next to what". Neither answers the questions an accountant asks — which
 * of the two companies printed here issued the invoice, which of the two ICE
 * numbers belongs to which, what the invoice number is when the header only
 * says "FACT°", and which of four numbers in the totals column is the VAT.
 *
 * The rules here are deliberately generic. Nothing keys off a supplier name, a
 * file name or a page size: a rule either describes something true of Moroccan
 * accounting documents in general (only the issuer prints its RC, TP and CNSS;
 * VAT is the rate applied to the taxable base) or it does not belong here.
 *
 * Every field carries where it came from and how sure the pipeline is. When two
 * readings compete, both are kept in the trace with the reason one won, so a
 * later mis-extraction can be diagnosed as "the recogniser misread it" or "the
 * recogniser was right and Wheat mapped it wrong" without guesswork.
 */

import {
  buildDocumentLayout,
  centerY,
  compactLabel,
  growCompetingBlocks,
  horizontalOverlap,
  normalizeLabel,
  pageOf,
  unionBox,
  valueCandidates,
  zoneOf,
  type DocumentLayout,
  type LayoutBox,
  type LayoutElement,
  type RecognizedPage,
} from "./ocrLayout";
import {
  evaluateTotals,
  impliedStatutoryRateBps,
  isAmountLike,
  parseDocumentAmount,
  parsePercentBps,
  trailingAmount,
  withoutTrailingAmount,
  type TotalKind,
  type TotalsAssignment,
  type TotalsEvaluation,
} from "./ocrAmounts";
import {
  invoiceKindForSide,
  matchPartyIdentity,
  resolveDossierSide,
  type IdentityMatch,
  type PartyIdentity,
} from "./partyIdentity";

export type FieldEvidence = { page: number; text: string; box: LayoutBox | null; elementIds: string[] };

export type ExtractedField = {
  value: string | number | null;
  /** 0-100. Blends recognition confidence with how the value was identified. */
  confidence: number;
  raw: string | null;
  /** Short machine-readable provenance, e.g. "label:facture/same-row". */
  source: string;
  evidence: FieldEvidence[];
};

export type CandidateTrace = {
  field: string;
  value: string;
  source: string;
  score: number;
  accepted: boolean;
  reason: string;
};

export type PartyRole = "ISSUER" | "RECIPIENT" | "UNKNOWN";

export type DetectedParty = {
  role: PartyRole;
  name: string | null;
  nameConfidence: number;
  nameSource: string;
  ice: string | null;
  taxId: string | null;
  rc: string | null;
  tp: string | null;
  cnss: string | null;
  address: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
  /** True when this party is the dossier currently open in Wheat. */
  isCurrentCompany: boolean;
  /** How that was decided: which attribute matched, and how strongly. */
  dossierMatch: IdentityMatch | null;
  evidence: FieldEvidence[];
  reasons: string[];
  issuerScore: number;
  recipientScore: number;
  /** Carries an ICE but none of the registry identifiers an issuer prints. */
  iceOnly: boolean;
};

export type DocumentClassification = {
  type: string;
  /**
   * Which side of the ledger, once the parties are known.
   *
   * `null` means Wheat could not attribute the document to the dossier. It is
   * never a synonym for "purchase": a document that cannot be attributed has to
   * be settled by a person, and `directionStatus` says why.
   */
  direction: "PURCHASE" | "SALE" | null;
  /**
   * `RESOLVED` when one side of the document is the dossier and the other is
   * not. `UNMATCHED` when neither side could be tied to the dossier.
   * `AMBIGUOUS` when the evidence conflicts or both sides matched.
   * `NOT_APPLICABLE` for documents that have no ledger side at all.
   */
  directionStatus: "RESOLVED" | "UNMATCHED" | "AMBIGUOUS" | "NOT_APPLICABLE";
  /** Which attribute settled it: ICE, IF, RC or NAME. */
  directionBasis: "ICE" | "IF" | "RC" | "NAME" | null;
  confidence: number;
  scores: Record<string, number>;
  reasons: string[];
};

export type ExtractionContext = {
  fileName?: string;
  company?: { name?: string | null; ice?: string | null; taxId?: string | null; rc?: string | null; city?: string | null } | null;
};

export type TotalsResolution = {
  assignment: TotalsAssignment;
  evaluation: TotalsEvaluation;
  strategy: string;
  vatRateBps: number | null;
  vatRateSource: string;
  /** Every assignment considered, with its score, for diagnosis. */
  alternatives: Array<{ strategy: string; assignment: TotalsAssignment; score: number; consistent: boolean }>;
  evidence: Partial<Record<TotalKind, FieldEvidence>>;
};

export type ExtractionResult = {
  classification: DocumentClassification;
  parties: { issuer: DetectedParty | null; recipient: DetectedParty | null; all: DetectedParty[] };
  totals: TotalsResolution;
  fields: Record<string, ExtractedField>;
  trace: { candidates: CandidateTrace[]; notes: string[] };
};

/* ------------------------------------------------------------------ */
/* Vocabularies                                                        */
/* ------------------------------------------------------------------ */

/**
 * Moroccan statutory identifiers.
 *
 * They matter far beyond their own value: RC, TP, IF and CNSS are printed by
 * the party that issued the document and by nobody else, which is what lets
 * Wheat tell an invoice's supplier from its customer when both print an ICE.
 */
const IDENTIFIER_PATTERNS: Array<{ kind: "ICE" | "IF" | "RC" | "TP" | "CNSS"; pattern: RegExp; minDigits: number; maxDigits: number }> = [
  { kind: "ICE", pattern: /(?:\bi\s*\.?\s*c\s*\.?\s*e\b|identifiant\s+commun\s+de\s+l['’ ]?entreprise)[^0-9a-z]{0,6}([0-9][0-9\s]{11,20})/gi, minDigits: 12, maxDigits: 18 },
  { kind: "IF", pattern: /(?:\bi\s*\.?\s*f\b|identifiant\s+fiscal|id\s*\.?\s*fiscal)[^0-9a-z]{0,6}([0-9][0-9\s]{3,12})/gi, minDigits: 4, maxDigits: 12 },
  { kind: "RC", pattern: /(?:\br\s*\.?\s*c\b|registre\s+de?\s*commerce)[^0-9a-z]{0,6}([0-9][0-9\s]{1,12})/gi, minDigits: 2, maxDigits: 12 },
  { kind: "TP", pattern: /(?:\bt\s*\.?\s*p\b|taxe\s+professionnelle|patente)[^0-9a-z]{0,6}([0-9][0-9\s]{3,12})/gi, minDigits: 4, maxDigits: 12 },
  { kind: "CNSS", pattern: /(?:\bc\s*\.?\s*n\s*\.?\s*s\s*\.?\s*s\b)[^0-9a-z]{0,6}([0-9][0-9\s]{3,12})/gi, minDigits: 4, maxDigits: 12 },
];

/** Labels that introduce the party being billed. */
const RECIPIENT_KEYWORDS = ["client", "clients", "facture a", "facturer a", "factured a", "destinataire", "adresse a", "adresse de facturation", "doit", "livre a", "bill to", "sold to", "customer", "code client"];

/** Labels that introduce the party that issued the document. */
const ISSUER_KEYWORDS = ["fournisseur", "supplier", "emetteur", "vendeur", "prestataire", "cachet et signature", "seller"];

const INVOICE_NUMBER_LABELS = ["facture", "fact", "fac", "fre", "fa", "invoice", "inv", "bill", "avoir", "note de credit", "credit note", "piece", "no facture", "num facture", "numero facture"];

const DATE_LABELS = ["date", "date facture", "date de facture", "date facturation", "date d emission", "date d edition", "invoice date", "emis le", "fait le", "le", "du"];

const DUE_DATE_LABELS = ["echeance", "date echeance", "date d echeance", "date de echeance", "due date", "date limite", "date limite de paiement", "payable le", "a payer avant", "a regler avant"];

const ADDRESS_HINTS = /\b(rue|route|bd|boulevard|avenue|av|lot|lotissement|imm|immeuble|appt|apt|etage|etg|quartier|hay|km|residence|angle|zone industrielle|zi|bp|casablanca|rabat|marrakech|tanger|fes|agadir|meknes|oujda|kenitra|safi|tetouan|el jadida|mohammedia|settat|beni mellal|nador|berrechid|khouribga)\b/;

const LEGAL_FORMS = /\b(sarl|sarl au|s a r l|sa|s a|sas|sasu|snc|scs|sca|gie|ste|societe|cooperative|coop|groupe|group|holding|company|co|ltd|llc|inc)\b/;

const NON_NAME_TOKENS = /\b(facture|invoice|devis|bon de livraison|designation|designantion|description|quantite|qte|montant|total|sous total|tva|ttc|ht|prix|p u|date|echeance|reference|ref|objet|intitule|tel|telephone|fax|gsm|email|e mail|site|internet|www|http|ice|if|rc|tp|cnss|patente|rib|iban|swift|banque|bank|page|arrete|arretee|somme|cachet|signature|conditions|reglement|paiement|mode|capital|responsabilite|associe|unique|limitee)\b/;

/**
 * The amount spelled out in words, which every Moroccan invoice prints just
 * under its total and which reads exactly like a company name to a naive rule.
 */
const AMOUNT_IN_WORDS = /\b(dirhams?|dhs?|centimes?|cts|mille|cent|cents|million|millions|zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|trente|quarante|cinquante|soixante)\b/;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function evidenceOf(layout: DocumentLayout, elements: LayoutElement[]): FieldEvidence[] {
  const used = elements.filter(Boolean).slice(0, 8);
  if (!used.length) return [];
  return [{
    page: used[0].page,
    text: used.map((element) => element.text).join(" ").slice(0, 300),
    box: unionBox(used),
    elementIds: used.map((element) => element.id),
  }];
}

function emptyField(): ExtractedField {
  return { value: null, confidence: 0, raw: null, source: "not-found", evidence: [] };
}

function field(value: string | number | null, confidence: number, raw: string | null, source: string, evidence: FieldEvidence[]): ExtractedField {
  if (value === null || value === "") return emptyField();
  return { value, confidence: Math.max(0, Math.min(100, Math.round(confidence))), raw, source, evidence };
}

/** Blends recognition confidence with how well the value was identified. */
function blendConfidence(ocrConfidence: number, structural: number) {
  const ocr = Math.max(0, Math.min(100, ocrConfidence || 0));
  return Math.round(ocr * 0.35 + structural * 0.65);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function labelMatches(element: LayoutElement, labels: string[]) {
  const compact = compactLabel(element.text);
  const normalized = element.normalized;
  return labels.some((label) => {
    const target = compactLabel(label);
    if (!target) return false;
    return compact === target || compact.startsWith(target) || normalized.startsWith(`${normalizeLabel(label)} `) || normalized === normalizeLabel(label);
  });
}

/** Text of an element after the label that introduces it has been removed. */
function textAfterLabel(text: string) {
  const cut = text.replace(/^[^:#=]*[:#=]\s*/, "");
  return cut === text ? text.replace(/^\s*[A-Za-zÀ-ÿ°.' ]{2,28}?\s+(?=[0-9])/, "") : cut;
}

const DATE_TOKEN = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/;

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

function normalizeDate(value: string): string | null {
  const numeric = value.match(DATE_TOKEN);
  if (numeric) {
    const parts = numeric[1].split(/[./-]/).map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return null;
    let [day, month, year] = parts;
    if (String(parts[0]).length === 4) [year, month, day] = parts;
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const written = normalizeLabel(value).match(/\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/);
  if (!written) return null;
  return `${written[3]}-${String(FRENCH_MONTHS[written[2]]).padStart(2, "0")}-${written[1].padStart(2, "0")}`;
}

function isDateToken(text: string) {
  return normalizeDate(text) !== null;
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

type IdentifierHit = { kind: "ICE" | "IF" | "RC" | "TP" | "CNSS"; value: string; element: LayoutElement };

/**
 * Identifiers are read off whole rows, not single elements.
 *
 * "ICE : 003983471000077" reaches Wheat as one element from a scanner and as
 * two — the label and the number — from a PDF text layer. Matching the row puts
 * both cases on the same footing, and a footer that packs ICE, RC, TP, IF and
 * CNSS onto one line still yields all five. The hit is attributed to the element
 * that actually carries the digits, so the block it anchors is the right one.
 */
function findIdentifiers(layout: DocumentLayout): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  for (const row of layout.rows) {
    const rowText = row.elements.map((element) => element.text).join(" ");
    for (const { kind, pattern, minDigits, maxDigits } of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(rowText)) !== null) {
        const value = digitsOnly(match[1]);
        if (value.length < minDigits || value.length > maxDigits) continue;
        // "Radiation de la TP    5 000,00" is a line item, not a professional
        // tax number: an identifier never carries centimes.
        if (/^\s*[.,]\d{2}\b/.test(rowText.slice(match.index + match[0].length))) continue;
        const element = row.elements.find((candidate) => digitsOnly(candidate.text).includes(value)) ?? row.elements[0];
        // An identifier already claimed by a longer, more specific pattern on
        // the same row is not claimed twice.
        if (hits.some((hit) => hit.element === element && hit.value === value)) continue;
        hits.push({ kind, value, element });
      }
    }
  }

  // A footer that reads "CE: 000187958000077 - RC: 193109 - IF: 1110375" lost
  // the I of ICE to the scanner. The fifteen-digit number sitting among the
  // registry identifiers is still unambiguously the ICE — it is the only
  // Moroccan identifier of that length — so it is recovered rather than lost,
  // and the caller can see it came from this rule.
  for (const element of layout.elements) {
    const onElement = hits.filter((hit) => hit.element === element);
    if (!onElement.length || onElement.some((hit) => hit.kind === "ICE")) continue;
    const claimed = new Set(onElement.map((hit) => hit.value));
    const fifteen = [...element.text.matchAll(/\b(\d{15})\b/g)].map((match) => match[1]).filter((value) => !claimed.has(value));
    if (fifteen.length === 1) hits.push({ kind: "ICE", value: fifteen[0], element });
  }

  return hits;
}

/* ------------------------------------------------------------------ */
/* Parties                                                             */
/* ------------------------------------------------------------------ */

type PartyBlock = {
  /** The identifier line the block was grown from. */
  anchor: LayoutElement;
  elements: LayoutElement[];
  identifiers: IdentifierHit[];
};

/**
 * Whether a line can be a company name.
 *
 * The rejections matter more than the acceptance. A party block also contains
 * the street, the postcode, the phone line and — right under the total — the
 * amount written out in words, and every one of them reads as "some words" to a
 * length check. Naming a supplier "Bd Mohammed" or "Six mille deux cent
 * quarante dirhams" is worse than naming it nothing at all, because a wrong
 * name is posted without a second look while a missing one is asked about.
 */
function looksLikeName(text: string) {
  const normalized = normalizeLabel(text);
  if (normalized.length < 4 || text.length > 90) return false;
  if (isAmountLike(text) || isDateToken(text)) return false;
  if (NON_NAME_TOKENS.test(normalized)) return false;
  if (ADDRESS_HINTS.test(normalized)) return false;
  if (AMOUNT_IN_WORDS.test(normalized)) return false;
  // A line that is mostly digits is an identifier or a reference, not a name.
  if (digitsOnly(text).length > text.length / 3) return false;
  // One isolated word is a fragment far more often than a trading name; a legal
  // form is the exception, since "SARL" alone never stands on its own line.
  const words = normalized.split(" ").filter((word) => /[a-z]{3,}/.test(word));
  return words.length >= 2 || LEGAL_FORMS.test(normalized);
}

/** Drops the separators a letterhead leaves around a trading name. */
function cleanPartyName(text: string) {
  return text.replace(/\s+/g, " ").replace(/^[\s•·|,:;.-]+/, "").replace(/[\s•·|,:;-]+$/, "").trim();
}

/** Strips a leading "Client :" style introducer and returns what follows. */
function nameFromLabelledLine(text: string) {
  const match = text.match(/^\s*([A-Za-zÀ-ÿ'’ .]{3,30})\s*[:-]\s*(.+)$/);
  if (!match) return null;
  const introducer = compactLabel(match[1]);
  const known = [...RECIPIENT_KEYWORDS, ...ISSUER_KEYWORDS].map(compactLabel);
  return known.some((keyword) => keyword && introducer.startsWith(keyword)) ? match[2].trim() : null;
}

/**
 * Whether a line can be the value of an explicit "Émetteur:" or "Client:" label.
 *
 * Looser than `looksLikeName`, deliberately. That rule has to be strict because
 * it picks a name out of a block with no label to vouch for it, and rejects a
 * single word for good reason. Here the document has said in words whose name
 * follows, so "E-solution" — one word, no legal form — is exactly what it looks
 * like. Amounts, dates, identifiers and pure numbers are still refused.
 */
function looksLikeLabelledName(text: string) {
  const normalized = normalizeLabel(text);
  if (normalized.length < 3 || text.length > 90) return false;
  if (!/[a-z]{2,}/.test(normalized)) return false;
  if (isAmountLike(text) || isDateToken(text)) return false;
  if (AMOUNT_IN_WORDS.test(normalized) && /\d/.test(text)) return false;
  return !/^(ice|if|rc|tp|cnss|tel|telephone|fax|email|www)\b/.test(normalized);
}

type LabelledParty = {
  name: string;
  /** The element that carries the name — what decides which block is meant. */
  value: LayoutElement;
  elements: LayoutElement[];
  confidence: number;
};

/**
 * Names a party the document introduces by label rather than by address block.
 *
 * Many Moroccan layouts print "Emetteur:" or "Adresse a :" on one line and the
 * company on the next, far from any ICE. No amount of clustering finds that —
 * the two lines are only related because the document says so.
 */
function findLabelledParties(layout: DocumentLayout): { issuer: LabelledParty | null; recipient: LabelledParty | null } {
  const find = (keywords: string[]): LabelledParty | null => {
    for (const label of layout.elements.filter((element) => labelMatches(element, keywords))) {
      const inline = nameFromLabelledLine(label.text) ?? (textAfterLabel(label.text) !== label.text ? textAfterLabel(label.text) : "");
      if (inline && looksLikeLabelledName(inline)) {
        return { name: cleanPartyName(inline), value: label, elements: [label], confidence: blendConfidence(label.confidence, 90) };
      }
      const [next] = valueCandidates(layout, label, (element) => looksLikeLabelledName(element.text), { maxVertical: 1.2, includeBelow: true, maxBelow: 1.6 });
      if (next) {
        return { name: cleanPartyName(next.element.text), value: next.element, elements: [label, next.element], confidence: blendConfidence(Math.min(label.confidence, next.element.confidence), 88) };
      }
    }
    return null;
  };
  return { issuer: find(ISSUER_KEYWORDS), recipient: find(RECIPIENT_KEYWORDS) };
}

function buildPartyBlocks(layout: DocumentLayout, identifiers: IdentifierHit[]): PartyBlock[] {
  const anchors: LayoutElement[] = [];
  // ICE lines anchor first: an ICE is the one identifier both parties print, so
  // two ICE numbers mean two parties even when nothing else distinguishes them.
  for (const hit of identifiers) if (hit.kind === "ICE" && !anchors.includes(hit.element)) anchors.push(hit.element);
  // A document may print RC/IF/CNSS without an ICE; those lines anchor a block
  // too, otherwise the issuer would go unnoticed entirely.
  for (const hit of identifiers) if (!anchors.includes(hit.element)) anchors.push(hit.element);

  const grown = growCompetingBlocks(layout, anchors, { maxGap: 5, minOverlap: 0.25, maxElements: 14 });

  const blocks: PartyBlock[] = [];
  for (const [anchor, elements] of grown) {
    // A footer prints "ICE … RC …" on one line and "TP … CNSS …" on the next:
    // two anchors, one party. They are folded together when their own lines are
    // adjacent and in the same column — unless each carries a different ICE, in
    // which case the page really is showing two companies.
    const host = blocks.find((block) => {
      // Two different ICE numbers are two different companies, whatever else
      // the blocks happen to share.
      const hostIce = identifiers.find((hit) => hit.kind === "ICE" && block.elements.includes(hit.element))?.value;
      const ownIce = identifiers.find((hit) => hit.kind === "ICE" && elements.includes(hit.element))?.value;
      if (hostIce && ownIce && hostIce !== ownIce) return false;
      if (block.elements.includes(anchor) || elements.some((element) => block.elements.includes(element))) return true;
      // "ICE : … — RC : … — IF : …" printed across one line reaches Wheat as
      // several elements side by side. They are one footer, so one party,
      // even though neither sits above the other.
      if (block.anchor.page === anchor.page && block.anchor.row >= 0 && block.anchor.row === anchor.row) return true;
      if (!block.anchor.box || !anchor.box) return false;
      const unit = pageOf(layout, anchor)?.lineHeight || 1;
      const gap = Math.max(block.anchor.box.y0 - anchor.box.y1, anchor.box.y0 - block.anchor.box.y1, 0);
      return gap <= unit * 2 && horizontalOverlap(block.anchor.box, anchor.box) >= 0.25;
    });
    if (host) {
      for (const element of elements) if (!host.elements.includes(element)) host.elements.push(element);
      continue;
    }
    blocks.push({ anchor, elements: [...elements], identifiers: [] });
  }

  for (const block of blocks) {
    block.elements.sort((left, right) => (left.box?.y0 ?? left.order) - (right.box?.y0 ?? right.order));
    block.identifiers = identifiers.filter((hit) => block.elements.includes(hit.element));
  }
  // A single identifier is enough: plenty of letterheads print only "I.F :"
  // beside the address. What is not enough is an identifier read out of a line
  // of prose — "Radiation de la TP 5 000,00" — and that is refused where the
  // identifiers are found, by rejecting any whose digits carry centimes.
  return blocks.filter((block) => block.identifiers.length > 0);
}

function firstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match ? match[0].trim() : null;
}

/**
 * Describes one identity block: its name, its identifiers, and how strongly it
 * reads as the issuer or the recipient. Whether it is the open dossier is not
 * decided here — that comparison needs the final names, and is made once in
 * `extractDocumentFields` after every block has been described.
 */
function describeParty(layout: DocumentLayout, block: PartyBlock): DetectedParty {
  const joined = block.elements.map((element) => element.text).join(" ");
  const normalized = normalizeLabel(joined);
  const pick = (kind: IdentifierHit["kind"]) => block.identifiers.find((hit) => hit.kind === kind)?.value ?? null;

  const reasons: string[] = [];
  let issuerScore = 0;
  let recipientScore = 0;

  const registryIdentifiers = (["IF", "RC", "TP", "CNSS"] as const).filter((kind) => pick(kind));
  if (registryIdentifiers.length) {
    issuerScore += 3 * registryIdentifiers.length;
    reasons.push(`Identifiants d'immatriculation presents (${registryIdentifiers.join(", ")}) : seul l'emetteur les imprime.`);
  }

  const email = firstMatch(joined, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const website = firstMatch(joined, /\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i);
  // A Moroccan ICE starts with a zero and runs fifteen digits: without removing
  // the identifiers first, every ICE on the page reads as a phone number and
  // every party looks like it printed a letterhead.
  const withoutIdentifiers = block.identifiers.reduce((text, hit) => text.split(hit.value).join(" "), joined);
  const phone = firstMatch(withoutIdentifiers, /(?:\+212|0)\s?\d(?:[\s.-]?\d){7,}/);
  if (email || website) { issuerScore += 2; reasons.push("Coordonnees de contact (e-mail ou site) : marque d'un papier a en-tete."); }
  if (phone) issuerScore += 1;

  if (RECIPIENT_KEYWORDS.some((keyword) => normalized.includes(normalizeLabel(keyword)))) {
    recipientScore += 5;
    reasons.push("Le bloc est introduit par une mention destinataire (client, facture a, ...).");
  }
  if (ISSUER_KEYWORDS.some((keyword) => normalized.includes(normalizeLabel(keyword)))) {
    issuerScore += 4;
    reasons.push("Le bloc est introduit par une mention emetteur (fournisseur, prestataire, ...).");
  }
  // "An ICE and nothing else" only means anything next to a block that does
  // carry registry identifiers. On a document with a single identity block it
  // would turn the issuer into the customer, so it is recorded and weighed in
  // `assignRoles`, not counted here.
  const iceOnly = Boolean(pick("ICE")) && registryIdentifiers.length === 0;

  const zone = block.elements.length ? zoneOf(layout, block.elements[0]) : "BODY";
  if (zone === "FOOTER") { issuerScore += 2; reasons.push("Bloc situe en pied de page."); }

  // Candidates are ranked by distance to the identifier the block was grown
  // from: on a letterhead the trading name is the line nearest its own ICE, and
  // whatever the recogniser happened to emit first is not.
  const anchorY = block.anchor.box ? centerY(block.anchor.box) : block.anchor.order;
  const distance = (element: LayoutElement) => Math.abs((element.box ? centerY(element.box) : element.order) - anchorY);
  const nameCandidates = block.elements
    .map((element) => ({ element, text: nameFromLabelledLine(element.text) ?? element.text }))
    .filter((candidate) => looksLikeName(candidate.text))
    .sort((left, right) => distance(left.element) - distance(right.element));
  const legal = nameCandidates.find((candidate) => LEGAL_FORMS.test(normalizeLabel(candidate.text)));
  const introduced = block.elements
    .map((element) => ({ element, text: nameFromLabelledLine(element.text) }))
    .find((candidate) => candidate.text && looksLikeName(candidate.text));
  const chosen = introduced ?? legal ?? nameCandidates[0] ?? null;

  const address = block.elements.find((element) => ADDRESS_HINTS.test(normalizeLabel(element.text)) && element !== chosen?.element);
  // A text-layer row such as "252 ROUTE L OASIS" is split into a numeric
  // element and a text element so amounts can be mapped elsewhere. An address
  // belongs to the complete printed row: persisting only the text element drops
  // the street number even though recognition read it correctly.
  const addressRow = address ? layout.rows.find((row) => row.elements.includes(address)) : null;
  const partyName = chosen ? cleanPartyName(chosen.text as string) : null;

  return {
    role: "UNKNOWN",
    name: partyName,
    nameConfidence: chosen ? blendConfidence(chosen.element.confidence, introduced ? 88 : legal ? 82 : 70) : 0,
    nameSource: chosen ? (introduced ? "party-block/labelled-line" : legal ? "party-block/legal-form" : "party-block/first-name-line") : "not-found",
    ice: pick("ICE"),
    taxId: pick("IF"),
    rc: pick("RC"),
    tp: pick("TP"),
    cnss: pick("CNSS"),
    address: addressRow?.text ?? address?.text ?? null,
    email,
    website,
    phone,
    isCurrentCompany: false,
    dossierMatch: null,
    evidence: evidenceOf(layout, block.elements),
    reasons,
    issuerScore,
    recipientScore,
    iceOnly,
  };
}

/**
 * Assigns the issuer and recipient roles.
 *
 * The dossier open in Wheat is the strongest evidence available: if one party's
 * ICE is the company's own, that party is the company, and the other is the
 * counterparty. It is used as evidence, not as the only rule, because a
 * fiduciaire regularly captures a document for a dossier whose identifiers are
 * not yet filled in.
 */
function assignRoles(parties: DetectedParty[]): { issuer: DetectedParty | null; recipient: DetectedParty | null } {
  if (!parties.length) return { issuer: null, recipient: null };
  if (parties.length === 1) {
    // One identity block on a document is the party that produced it, unless it
    // is explicitly introduced as the customer. Reading a lone letterhead as
    // the recipient would post the invoice against the wrong side entirely.
    const only = parties[0];
    only.role = only.recipientScore > only.issuerScore ? "RECIPIENT" : "ISSUER";
    return only.role === "ISSUER" ? { issuer: only, recipient: null } : { issuer: null, recipient: only };
  }

  // With several blocks, carrying only an ICE is meaningful: the other block
  // prints the registry identifiers, so this one is the party being billed.
  for (const party of parties) {
    if (!party.iceOnly) continue;
    party.recipientScore += 2;
    party.reasons.push("ICE seul, alors qu'un autre bloc porte les identifiants d'immatriculation : profil du tiers facture.");
  }

  const ranked = [...parties].sort((left, right) =>
    (right.issuerScore - right.recipientScore) - (left.issuerScore - left.recipientScore));
  const issuer = ranked[0];
  const recipient = ranked.slice(1).sort((left, right) => right.recipientScore - left.recipientScore)[0] ?? null;
  issuer.role = "ISSUER";
  if (recipient) recipient.role = "RECIPIENT";
  return { issuer, recipient };
}

/**
 * Recovers an issuer name the identifier block does not carry.
 *
 * A letterhead prints the trading name at the top and the statutory
 * identifiers at the bottom, too far apart to be one block. Four independent
 * signals are tried in decreasing order of reliability, and each records how it
 * was found so a weak one is visibly weak in review.
 */
function resolveIssuerName(
  layout: DocumentLayout,
  issuer: DetectedParty | null,
  recipient: DetectedParty | null,
  trace: CandidateTrace[],
): { name: string | null; confidence: number; source: string; evidence: FieldEvidence[] } {
  if (issuer?.name) return { name: issuer.name, confidence: issuer.nameConfidence, source: issuer.nameSource, evidence: issuer.evidence };

  const excluded = new Set(recipient?.evidence.flatMap((item) => item.elementIds) ?? []);
  const named = layout.elements.filter((element) => !excluded.has(element.id) && looksLikeName(element.text));

  // A trading name is printed more than once: letterhead and signature, or
  // letterhead and footer. Nothing else on an invoice repeats like that.
  const byKey = new Map<string, LayoutElement[]>();
  for (const element of named) {
    const key = compactLabel(element.text);
    if (key.length < 5) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), element]);
  }
  const repeated = [...byKey.entries()].filter(([, group]) => group.length >= 2)
    .sort((left, right) => right[1].length - left[1].length)[0];
  if (repeated) {
    trace.push({ field: "supplier", value: repeated[1][0].text, source: "repeated-on-page", score: 84, accepted: true, reason: `Nom repete ${repeated[1].length} fois sur la piece.` });
    return { name: repeated[1][0].text, confidence: blendConfidence(repeated[1][0].confidence, 84), source: "issuer/repeated-on-page", evidence: evidenceOf(layout, repeated[1].slice(0, 2)) };
  }

  const domain = (issuer?.website ?? issuer?.email ?? "").toLowerCase().replace(/^www\./, "").replace(/^[^@]*@/, "");
  const domainLabel = domain.split(".")[0]?.replace(/[^a-z0-9]/g, "") ?? "";

  // The trading name in the header often is the domain, spelled out.
  if (domainLabel.length >= 4) {
    const matching = named.find((element) => zoneOf(layout, element) !== "FOOTER" && compactLabel(element.text).includes(domainLabel));
    if (matching) {
      trace.push({ field: "supplier", value: matching.text, source: "header-matches-domain", score: 78, accepted: true, reason: `Le nom d'en-tete contient le domaine « ${domainLabel} ».` });
      return { name: matching.text, confidence: blendConfidence(matching.confidence, 78), source: "issuer/header-matches-domain", evidence: evidenceOf(layout, [matching]) };
    }
  }

  const legal = named.find((element) => zoneOf(layout, element) === "HEADER" && LEGAL_FORMS.test(normalizeLabel(element.text)));
  if (legal) {
    trace.push({ field: "supplier", value: legal.text, source: "header-legal-form", score: 74, accepted: true, reason: "Forme juridique reconnue dans l'en-tete." });
    return { name: legal.text, confidence: blendConfidence(legal.confidence, 74), source: "issuer/header-legal-form", evidence: evidenceOf(layout, [legal]) };
  }

  if (domainLabel.length >= 4) {
    const name = domainLabel.toUpperCase();
    trace.push({ field: "supplier", value: name, source: "derived-from-domain", score: 58, accepted: true, reason: "Aucun nom lisible : deduit du domaine de contact, a confirmer." });
    return { name, confidence: 58, source: "issuer/derived-from-domain", evidence: issuer?.evidence ?? [] };
  }

  return { name: null, confidence: 0, source: "not-found", evidence: [] };
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

type TotalLabelHit = { element: LayoutElement; kind: TotalKind; rateBps: number | null };

const TOTAL_LABEL_RULES: Array<{ kind: TotalKind; test: (compact: string, normalized: string) => boolean }> = [
  { kind: "DEBOURS", test: (compact) => compact.includes("debours") || compact.includes("deboursement") },
  { kind: "DISCOUNT", test: (compact) => /^(?:total|montant)?(?:remise|rabais|ristourne|reduction|escompte)/.test(compact) },
  { kind: "STAMP", test: (compact) => compact.includes("timbre") },
  { kind: "NET_PAID", test: (compact) => /^(?:montant)?(?:regle|paye|verse|avance|acompte)/.test(compact) || compact.startsWith("montantregle") },
  { kind: "TTC", test: (compact) => /^(?:total|montant|net)?(?:ttc|toutestaxescomprises)/.test(compact) || /^(?:net|total|montant)apayer/.test(compact) || compact === "totalgeneral" || compact === "totalapayer" },
  { kind: "TVA", test: (compact) => /^(?:total|montant)?tva\d*$/.test(compact) || /^(?:total|montant)?tva\b/.test(compact) || /^(?:total|montant)?(?:vat|taxe)/.test(compact) },
  { kind: "HT", test: (compact) => /^(?:sous)?(?:total|montant|base|net)?(?:ht|horstaxe|horstaxes)/.test(compact) },
];

function totalLabelKind(element: LayoutElement): { kind: TotalKind; rateBps: number | null } | null {
  const compact = compactLabel(element.text);
  const normalized = element.normalized;
  if (!compact) return null;
  // A label that already carries its own amount ("Total HT 4 500,00") is
  // matched on the part before the number.
  const head = compactLabel(withoutTrailingAmount(element.text));
  for (const rule of TOTAL_LABEL_RULES) {
    if (rule.test(compact, normalized) || (head && head !== compact && rule.test(head, normalized))) {
      return { kind: rule.kind, rateBps: rule.kind === "TVA" ? parsePercentBps(element.text) : null };
    }
  }
  return null;
}

function amountElements(layout: DocumentLayout) {
  return layout.elements.filter((element) => isAmountLike(element.text));
}

/** Groups totals labels that sit close together into one block. */
function totalsBlocks(layout: DocumentLayout, labels: TotalLabelHit[]): TotalLabelHit[][] {
  const blocks: TotalLabelHit[][] = [];
  const sorted = [...labels].sort((left, right) =>
    left.element.page - right.element.page
    || (left.element.box ? centerY(left.element.box) : left.element.order) - (right.element.box ? centerY(right.element.box) : right.element.order));
  for (const hit of sorted) {
    const current = blocks.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || previous.element.page !== hit.element.page) { blocks.push([hit]); continue; }
    const unit = pageOf(layout, hit.element)?.lineHeight || 1;
    const gap = previous.element.box && hit.element.box
      ? (hit.element.box.y0 - previous.element.box.y1) / unit
      : hit.element.order - previous.element.order - 1;
    if (gap <= 4) current.push(hit);
    else blocks.push([hit]);
  }
  return blocks;
}

/**
 * Reads the totals of a document.
 *
 * Proximity alone cannot settle a two-column totals block: on one invoice the
 * value sits on its label's row, on the next the whole value column is printed
 * one row lower, and both readings look equally close. So several complete
 * readings are built — one per alignment offset, plus the nearest-neighbour
 * one — and each is scored against the arithmetic the document has to satisfy.
 * The reading that balances wins; when none balances, the least bad one is
 * returned together with the checks it failed, so the fields are flagged
 * instead of being presented as certain.
 */
function resolveTotals(layout: DocumentLayout, trace: CandidateTrace[]): TotalsResolution {
  const labels: TotalLabelHit[] = [];
  for (const element of layout.elements) {
    const hit = totalLabelKind(element);
    if (hit) labels.push({ element, kind: hit.kind, rateBps: hit.rateBps });
  }

  const blocks = totalsBlocks(layout, labels);
  const distinct = (block: TotalLabelHit[]) => new Set(block.map((hit) => hit.kind)).size;
  const block = blocks.sort((left, right) => distinct(right) - distinct(left) || right[0].element.order - left[0].element.order)[0] ?? [];

  const statedRate = block.find((hit) => hit.kind === "TVA" && hit.rateBps !== null)?.rateBps
    ?? labels.find((hit) => hit.kind === "TVA" && hit.rateBps !== null)?.rateBps
    ?? null;

  const candidates: Array<{ strategy: string; assignment: TotalsAssignment; pairs: Map<TotalKind, LayoutElement> }> = [];

  // Strategy A — the label already carries its amount.
  const inlineAssignment: TotalsAssignment = {};
  const inlinePairs = new Map<TotalKind, LayoutElement>();
  for (const hit of block) {
    const tail = trailingAmount(hit.element.text);
    if (tail && inlineAssignment[hit.kind] === undefined) {
      inlineAssignment[hit.kind] = tail.amount.value;
      inlinePairs.set(hit.kind, hit.element);
    }
  }
  if (Object.keys(inlineAssignment).length >= 2) candidates.push({ strategy: "inline-label-value", assignment: inlineAssignment, pairs: inlinePairs });

  // Strategy B — nearest value to the right of each label, one value used once.
  const nearest: Array<{ hit: TotalLabelHit; element: LayoutElement; distance: number }> = [];
  for (const hit of block) {
    for (const candidate of valueCandidates(layout, hit.element, (element) => isAmountLike(element.text), { maxVertical: 1.3, includeBelow: false })) {
      nearest.push({ hit, element: candidate.element, distance: candidate.verticalDistance + candidate.horizontalDistance / 20 });
    }
  }
  nearest.sort((left, right) => left.distance - right.distance);
  const nearestAssignment: TotalsAssignment = {};
  const nearestPairs = new Map<TotalKind, LayoutElement>();
  const usedValues = new Set<LayoutElement>();
  for (const entry of nearest) {
    if (nearestAssignment[entry.hit.kind] !== undefined || usedValues.has(entry.element)) continue;
    const parsed = parseDocumentAmount(entry.element.text);
    if (!parsed) continue;
    nearestAssignment[entry.hit.kind] = parsed.value;
    nearestPairs.set(entry.hit.kind, entry.element);
    usedValues.add(entry.element);
  }
  if (Object.keys(nearestAssignment).length) candidates.push({ strategy: "nearest-value", assignment: nearestAssignment, pairs: nearestPairs });

  // Strategy C — align the label column with the value column, allowing the
  // whole value column to be printed one or two rows off its labels.
  const page = block.length ? pageOf(layout, block[0].element) : null;
  if (page?.hasGeometry && block.length >= 2) {
    const unit = page.lineHeight || 1;
    const boxes = block.map((hit) => hit.element.box).filter(Boolean) as LayoutBox[];
    const top = Math.min(...boxes.map((box) => box.y0)) - unit * 1.2;
    const bottom = Math.max(...boxes.map((box) => box.y1)) + unit * 3;
    const rightEdge = Math.max(...boxes.map((box) => box.x1));
    const column = amountElements(layout)
      .filter((element) => element.page === page.page && element.box
        && element.box.x0 >= rightEdge - unit
        && centerY(element.box) >= top && centerY(element.box) <= bottom)
      .sort((left, right) => centerY(left.box!) - centerY(right.box!));

    const orderedLabels = [...block].sort((left, right) => centerY(left.element.box!) - centerY(right.element.box!));
    for (const offset of [0, 1, -1, 2, -2]) {
      const assignment: TotalsAssignment = {};
      const pairs = new Map<TotalKind, LayoutElement>();
      let paired = 0;
      for (const [index, hit] of orderedLabels.entries()) {
        const value = column[index + offset];
        if (!value) continue;
        const distance = Math.abs(centerY(value.box!) - centerY(hit.element.box!)) / unit;
        if (distance > 3) continue;
        const parsed = parseDocumentAmount(value.text);
        if (!parsed || assignment[hit.kind] !== undefined) continue;
        assignment[hit.kind] = parsed.value;
        pairs.set(hit.kind, value);
        paired += 1;
      }
      if (paired >= 2) candidates.push({ strategy: `column-offset:${offset}`, assignment, pairs });
    }
  }

  const scored = candidates.map((candidate) => {
    const rate = candidate.assignment.TVA !== undefined && candidate.assignment.HT !== undefined
      ? statedRate ?? impliedStatutoryRateBps(candidate.assignment.HT, candidate.assignment.TVA)
      : statedRate;
    const evaluation = evaluateTotals(candidate.assignment, rate ?? null);
    return { ...candidate, evaluation, rate: rate ?? null };
  });

  const best = scored.sort((left, right) =>
    Number(right.evaluation.consistent) - Number(left.evaluation.consistent)
    || right.evaluation.score - left.evaluation.score
    || Object.keys(right.assignment).length - Object.keys(left.assignment).length)[0];

  for (const candidate of scored) {
    trace.push({
      field: "totals",
      value: JSON.stringify(candidate.assignment),
      source: candidate.strategy,
      score: Math.round(candidate.evaluation.score * 100),
      accepted: candidate === best,
      reason: candidate === best
        ? candidate.evaluation.consistent ? "Lecture retenue : toute l'arithmetique du document est verifiee." : "Lecture la moins incoherente ; les champs concernes sont signales."
        : candidate.evaluation.checks.find((check) => check.status === "FAILED")?.detail ?? "Lecture moins coherente que celle retenue.",
    });
  }

  if (!best) {
    return {
      assignment: {},
      evaluation: evaluateTotals({}, statedRate),
      strategy: "none",
      vatRateBps: statedRate,
      vatRateSource: statedRate === null ? "not-found" : "vat-label",
      alternatives: [],
      evidence: {},
    };
  }

  const evidence: Partial<Record<TotalKind, FieldEvidence>> = {};
  for (const [kind, element] of best.pairs.entries()) evidence[kind] = evidenceOf(layout, [element])[0];

  const impliedRate = impliedStatutoryRateBps(best.assignment.HT ?? null, best.assignment.TVA ?? null);
  return {
    assignment: best.assignment,
    evaluation: best.evaluation,
    strategy: best.strategy,
    vatRateBps: statedRate ?? impliedRate,
    vatRateSource: statedRate !== null ? "vat-label" : impliedRate !== null ? "derived-from-ht-and-tva" : "not-found",
    alternatives: scored.map((candidate) => ({
      strategy: candidate.strategy,
      assignment: candidate.assignment,
      score: Math.round(candidate.evaluation.score * 100),
      consistent: candidate.evaluation.consistent,
    })),
    evidence,
  };
}

/* ------------------------------------------------------------------ */
/* References and dates                                                */
/* ------------------------------------------------------------------ */

/** A token that can be a document number, and demonstrably is not something else. */
function isReferenceToken(text: string, identifiers: Set<string>) {
  const trimmed = text.trim().replace(/^[:#°.\s-]+/, "");
  if (trimmed.length < 2 || trimmed.length > 24) return false;
  if (!/\d/.test(trimmed)) return false;
  if (isDateToken(trimmed)) return false;
  if (identifiers.has(digitsOnly(trimmed))) return false;
  // A phone number, an ICE or a long identifier is never an invoice number.
  if (digitsOnly(trimmed).length >= 10 && !/[-/]/.test(trimmed)) return false;
  if (/^[0-9]{1,2}[.,][0-9]{2}$/.test(trimmed)) return false;
  if ((trimmed.match(/ /g)?.length ?? 0) > 2) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/ -]{1,23}$/.test(trimmed);
}

/**
 * The invoice number introduced by a label, with the label removed.
 *
 * Handles the two forms a document uses interchangeably: with a separator
 * ("Facture N° : 39/2026") and without one ("FACTURE N FACT-ATOMIC-2026-0814").
 * The second is why the label vocabulary has to be stripped explicitly — there
 * is no punctuation to cut at, and taking the whole line leaves the word
 * "FACTURE" inside the number.
 */
const INVOICE_NUMBER_PREFIX = /^\s*(?:facture|fact|fac|fre|invoice|inv|bill|avoir|piece)\b[°.\s]*(?:n[o°s.]*|num(?:ero)?)?\s*[:#-]?\s*/i;

function invoiceNumberFrom(text: string) {
  const plain = text.normalize("NFKD").replace(new RegExp("[̀-ͯ]", "g"), "");
  const afterSeparator = textAfterLabel(text);
  const afterLabel = plain.replace(INVOICE_NUMBER_PREFIX, "");
  const candidates = [
    afterSeparator !== text ? afterSeparator : "",
    afterLabel !== plain ? afterLabel : "",
    text,
  ];
  for (const candidate of candidates) {
    const cleaned = cleanReference(candidate);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanReference(text: string) {
  return text.trim().replace(/^[:#°.\s-]+/, "").replace(/[.,;:\s]+$/, "").replace(/\s+/g, " ");
}

function findLabelledValue(
  layout: DocumentLayout,
  labels: string[],
  accept: (text: string) => boolean,
  extract: (text: string) => string | null,
  fieldName: string,
  trace: CandidateTrace[],
  /** Labels that look like `labels` but mean something else, such as a due date. */
  exclude: string[] = [],
): ExtractedField {
  const matches = layout.elements
    .filter((element) => labelMatches(element, labels))
    .filter((element) => !exclude.length || !labelMatches(element, exclude));
  for (const label of matches) {
    // The value may already sit inside the label's own element, or be spread
    // over the rest of its line: "Date d'emission : 27 mai 2016" arrives as one
    // element from a scanner and as four from a text layer, and the value only
    // exists when the line is read whole.
    const row = layout.rows.find((candidate) => candidate.elements.includes(label));
    const sources = [label.text, ...(row && row.elements.length > 1 ? [row.text] : [])];
    for (const source of sources) {
      // The whole line is handed to `extract`, which knows how to strip its own
      // label. Stripping here first meant a value was passed through the same
      // removal twice, and "Mode de reglement : Cheque" came back empty.
      const value = extract(source);
      if (!value || !accept(value)) continue;
      trace.push({ field: fieldName, value, source: `label:${compactLabel(label.text)}/inline`, score: 92, accepted: true, reason: "Valeur lue sur la meme ligne que son libelle." });
      return field(value, blendConfidence(label.confidence, 92), source, "label/inline", evidenceOf(layout, row?.elements ?? [label]));
    }
    for (const candidate of valueCandidates(layout, label, (element) => {
      const value = extract(element.text);
      return Boolean(value && accept(value));
    }, { maxVertical: 1.2, includeBelow: true, maxBelow: 2 })) {
      const value = extract(candidate.element.text);
      if (!value) continue;
      const structural = candidate.relation === "SAME_ROW" ? 90 : candidate.relation === "RIGHT_OF" ? 82 : 72;
      trace.push({ field: fieldName, value, source: `label:${compactLabel(label.text)}/${candidate.relation}`, score: structural, accepted: true, reason: `Valeur associee au libelle « ${label.text} » par ${candidate.relation === "SAME_ROW" ? "alignement sur la meme ligne" : candidate.relation === "RIGHT_OF" ? "position a droite du libelle" : "position sous le libelle"}.` });
      return field(value, blendConfidence(Math.min(label.confidence, candidate.element.confidence), structural), candidate.element.text, `label/${candidate.relation}`, evidenceOf(layout, [label, candidate.element]));
    }
    trace.push({ field: fieldName, value: "", source: `label:${compactLabel(label.text)}`, score: 0, accepted: false, reason: "Libelle trouve, mais aucune valeur exploitable a cote." });
  }
  return emptyField();
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const TYPE_TERMS: Record<string, Array<[string, number]>> = {
  INVOICE: [["facture", 5], ["invoice", 4], ["total ttc", 5], ["montant ht", 4], ["hors taxe", 4], ["tva", 2], ["doit", 1]],
  CREDIT_NOTE: [["avoir", 6], ["note de credit", 6], ["credit note", 5], ["facture d avoir", 7]],
  BANK_STATEMENT: [["releve de compte", 6], ["releve bancaire", 6], ["bank statement", 5], ["solde", 3], ["capitaux", 3], ["debit", 2], ["credit", 2], ["libelle", 2], ["iban", 3], ["rib", 2], ["releve d identite bancaire", 4], ["total mouvements", 5]],
  RECEIPT: [["recu", 4], ["receipt", 4], ["ticket", 3], ["caisse", 3], ["bon de livraison", 5], ["espece", 2], ["piece de caisse", 6]],
  CONTRACT: [["contrat", 5], ["convention", 4], ["bail", 4], ["conditions generales", 3]],
  PAYROLL: [["bulletin de paie", 7], ["salaire brut", 4], ["net a payer", 2], ["cnss", 2], ["amo", 3], ["ir salarial", 4], ["bulletin de salaire", 7]],
  IDENTITY: [["carte nationale", 5], ["cnie", 5], ["passeport", 4], ["date de naissance", 3]],
  TAX: [["releve de deduction", 8], ["declaration tva", 6], ["direction generale des impots", 6], ["dgi", 4], ["simpl", 3], ["accuse de depot", 6], ["teledeclaration", 5]],
  LETTER: [["objet", 2], ["monsieur", 2], ["madame", 2], ["courrier", 3]],
};

function classifyDocument(
  layout: DocumentLayout,
  context: ExtractionContext,
  parties: { issuer: DetectedParty | null; recipient: DetectedParty | null },
): DocumentClassification {
  const haystack = ` ${normalizeLabel(`${context.fileName ?? ""} ${layout.text}`)} `;
  const scores: Record<string, number> = {};
  for (const [type, terms] of Object.entries(TYPE_TERMS)) {
    scores[type] = terms.reduce((sum, [term, weight]) => sum + (haystack.includes(` ${normalizeLabel(term)} `) || haystack.includes(normalizeLabel(term)) ? weight : 0), 0);
  }
  scores.UNKNOWN = 1;

  const reasons: string[] = [];
  const [type, score] = Object.entries(scores).sort((left, right) => right[1] - left[1])[0];
  const resolved = score < 4 ? "UNKNOWN" : type;
  if (resolved !== "UNKNOWN") reasons.push(`Vocabulaire caracteristique du type ${resolved} (score ${score}).`);

  // Which side of the ledger a document belongs to is a question about
  // identity, not about vocabulary: it is settled by comparing the dossier with
  // the two parties, and by nothing else. Wheat used to answer "achat" whenever
  // the comparison failed, which silently filed a fiduciaire's own sales
  // invoices against itself. An unattributable document now stays unclassified
  // and says why.
  const hasLedgerSide = resolved === "INVOICE" || resolved === "CREDIT_NOTE" || resolved === "RECEIPT";
  let direction: "PURCHASE" | "SALE" | null = null;
  let directionStatus: DocumentClassification["directionStatus"] = "NOT_APPLICABLE";
  let directionBasis: DocumentClassification["directionBasis"] = null;

  if (hasLedgerSide) {
    const resolution = resolveDossierSide(
      context.company ? { name: context.company.name, ice: context.company.ice, taxId: context.company.taxId, rc: context.company.rc, city: context.company.city } : null,
      parties.issuer,
      parties.recipient,
    );
    direction = invoiceKindForSide(resolution.side);
    directionBasis = resolution.side === "ISSUER" ? resolution.issuerMatch.basis : resolution.side === "RECIPIENT" ? resolution.recipientMatch.basis : null;
    directionStatus = resolution.status;
    reasons.push(...resolution.reasons);
    if (!direction) reasons.push("Le sens de la piece (achat ou vente) reste a confirmer par un utilisateur.");
  }

  // Confidence in the *type*, raised only by a direction that an identifier —
  // not a name — settled. A name-only attribution is a working assumption.
  const directionBonus = directionStatus === "RESOLVED" ? (directionBasis === "NAME" ? 4 : 8) : 0;
  return {
    type: resolved,
    direction,
    directionStatus,
    directionBasis,
    confidence: Math.max(18, Math.min(97, 30 + score * 7 + directionBonus)),
    scores,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Reads one recognised document into Wheat's accounting fields.
 *
 * The result is intentionally verbose: alongside each value it carries the
 * confidence, the evidence box, and a trace of the readings that were
 * considered and rejected. The posting workbench shows the values; the trace is
 * what makes a future mis-read diagnosable.
 */
export function extractDocumentFields(pages: RecognizedPage[], context: ExtractionContext = {}): ExtractionResult {
  const layout = buildDocumentLayout(pages);
  const trace: CandidateTrace[] = [];
  const notes: string[] = [];

  const identifiers = findIdentifiers(layout);
  const identifierValues = new Set(identifiers.map((hit) => hit.value));
  const blocks = buildPartyBlocks(layout, identifiers);
  const parties = blocks.map((block) => describeParty(layout, block));
  const labelled = findLabelledParties(layout);

  // A document that names its parties in words is telling Wheat something no
  // amount of clustering can: which of the blocks — or which line with no block
  // at all — is the issuer. Where a label exists it settles the role, and where
  // there is no identity block behind it the party still gets a name.
  const claimed = new Set<DetectedParty>();
  for (const [role, found] of [["ISSUER", labelled.issuer], ["RECIPIENT", labelled.recipient]] as const) {
    if (!found) continue;
    // The block that owns the label is the one holding the *name*, not the one
    // that happens to contain the word "Client" printed in its own column.
    const direct = parties.find((party) => party.evidence.some((item) => item.elementIds.includes(found.value.id)));
    // A letterhead often prints its name near the top and its ICE, bank and RIB
    // at the very bottom, too far apart to be one block. When a labelled name
    // has no block of its own, the remaining identity block is the same party —
    // the identifiers and the account details on an invoice belong to whoever
    // issued it, and a block introduced as the customer is excluded.
    const fallback = direct ?? parties.find((party) => !claimed.has(party)
      && (role === "ISSUER" ? party.recipientScore === 0 : party.issuerScore === 0));
    const owner = direct ?? fallback;
    if (owner) {
      claimed.add(owner);
      if (role === "ISSUER") owner.issuerScore += 5; else owner.recipientScore += 5;
      if (!direct) {
        owner.name = found.name;
        owner.nameConfidence = found.confidence;
        owner.nameSource = "labelled-party";
      }
      owner.reasons.push(`La piece designe ce bloc par un libelle ${role === "ISSUER" ? "emetteur" : "destinataire"}.`);
      continue;
    }
    parties.push({
      role: "UNKNOWN",
      name: found.name,
      nameConfidence: found.confidence,
      nameSource: "labelled-party",
      ice: null, taxId: null, rc: null, tp: null, cnss: null,
      address: null, email: null, website: null, phone: null,
      isCurrentCompany: context.company ? matchPartyIdentity({ name: context.company.name, ice: context.company.ice, taxId: context.company.taxId }, { name: found.name }).verdict === "SAME" : false,
      dossierMatch: context.company ? matchPartyIdentity({ name: context.company.name, ice: context.company.ice, taxId: context.company.taxId }, { name: found.name }) : null,
      evidence: evidenceOf(layout, found.elements),
      reasons: [`Nom introduit par un libelle ${role === "ISSUER" ? "emetteur" : "destinataire"} sur la piece.`],
      issuerScore: role === "ISSUER" ? 6 : 0,
      recipientScore: role === "RECIPIENT" ? 6 : 0,
      iceOnly: false,
    });
  }

  const { issuer, recipient } = assignRoles(parties);
  // A block found by its identifiers still takes the name the document printed
  // above it, when there is one and the block itself yielded none.
  if (issuer && labelled.issuer && (!issuer.name || issuer.nameConfidence < labelled.issuer.confidence)) {
    issuer.name = labelled.issuer.name;
    issuer.nameConfidence = labelled.issuer.confidence;
    issuer.nameSource = "labelled-party";
  }
  if (recipient && labelled.recipient && (!recipient.name || recipient.nameConfidence < labelled.recipient.confidence)) {
    recipient.name = labelled.recipient.name;
    recipient.nameConfidence = labelled.recipient.confidence;
    recipient.nameSource = "labelled-party";
  }
  // The issuer's name is settled *before* the document is attributed to the
  // dossier. A dossier that records no ICE is matched by name, and the name a
  // letterhead block yields on its own is regularly empty until this runs — so
  // classifying first meant a name-only dossier never matched anything.
  const issuerName = resolveIssuerName(layout, issuer, recipient, trace);
  if (issuer && !issuer.name && issuerName.name) {
    issuer.name = issuerName.name;
    issuer.nameConfidence = issuerName.confidence;
    issuer.nameSource = issuerName.source;
  }

  // Attribution to the dossier is decided once, here, on final names and
  // identifiers — not per block while the names are still being assembled.
  if (context.company) {
    const dossier: PartyIdentity = { name: context.company.name, ice: context.company.ice, taxId: context.company.taxId, rc: context.company.rc, city: context.company.city };
    for (const party of parties) {
      const match = matchPartyIdentity(dossier, { name: party.name, ice: party.ice, taxId: party.taxId, rc: party.rc });
      party.dossierMatch = match;
      party.isCurrentCompany = match.verdict === "SAME";
      if (party.isCurrentCompany) party.reasons.push(`Ce bloc correspond au dossier ouvert dans Wheat (${match.basis}).`);
      else if (match.conflict) party.reasons.push("Nom identique au dossier ouvert mais identifiant different : rapprochement refuse.");
    }
  }

  const classification = classifyDocument(layout, context, { issuer, recipient });
  const totals = resolveTotals(layout, trace);

  const invoiceNumber = findLabelledValue(
    layout,
    INVOICE_NUMBER_LABELS,
    (value) => isReferenceToken(value, identifierValues),
    (text) => {
      const cleaned = invoiceNumberFrom(text);
      return cleaned && isReferenceToken(cleaned, identifierValues) ? cleaned : null;
    },
    "invoiceNumber",
    trace,
  );

  const date = findLabelledValue(layout, DATE_LABELS, () => true, (text) => normalizeDate(text), "date", trace, DUE_DATE_LABELS);
  const dueDate = findLabelledValue(layout, DUE_DATE_LABELS, () => true, (text) => normalizeDate(text), "dueDate", trace);

  let resolvedDate = date;
  if (!resolvedDate.value) {
    // No labelled date: the first date on the page is the document's own far
    // more often than not, but it is worth much less confidence.
    const first = layout.elements.find((element) => normalizeDate(element.text) !== null);
    if (first) {
      resolvedDate = field(normalizeDate(first.text), blendConfidence(first.confidence, 62), first.text, "first-date-on-page", evidenceOf(layout, [first]));
      trace.push({ field: "date", value: String(resolvedDate.value), source: "first-date-on-page", score: 62, accepted: true, reason: "Aucun libelle de date : premiere date lue sur la piece." });
    }
  }

  const currencyText = normalizeLabel(layout.text);
  const currency = /\b(mad|dhs|dh|dirham|dirhams)\b/.test(currencyText)
    ? field("MAD", 92, "MAD", "currency-keyword", [])
    : /\beur\b|€/.test(currencyText)
      ? field("EUR", 92, "EUR", "currency-keyword", [])
      : /\busd\b/.test(currencyText)
        ? field("USD", 92, "USD", "currency-keyword", [])
        : emptyField();

  const paymentTerms = findLabelledValue(layout, ["conditions de paiement", "mode de paiement", "mode de reglement", "payment terms", "reglement"], (value) => value.length > 1, (text) => {
    const value = textAfterLabel(text);
    return value && value !== text ? value.slice(0, 80) : null;
  }, "paymentTerms", trace);
  const paymentFallback = /virement/i.test(layout.text) ? "Virement" : /ch[eè]que/i.test(layout.text) ? "Cheque" : /esp[eè]ce|cash/i.test(layout.text) ? "Espece" : null;

  const amountField = (kind: TotalKind): ExtractedField => {
    const value = totals.assignment[kind];
    if (value === undefined) return emptyField();
    const failed = totals.evaluation.failedFields.includes(kind);
    const structural = totals.evaluation.consistent ? 94 : failed ? 45 : 70;
    const evidence = totals.evidence[kind];
    return field(value, blendConfidence(evidence ? 92 : 70, structural), evidence?.text ?? null, `totals/${totals.strategy}`, evidence ? [evidence] : []);
  };

  const fields: Record<string, ExtractedField> = {
    date: resolvedDate,
    invoiceNumber,
    reference: invoiceNumber.value ? invoiceNumber : emptyField(),
    counterparty: emptyField(),
    supplier: emptyField(),
    client: emptyField(),
    ice: emptyField(),
    if: emptyField(),
    ht: amountField("HT"),
    tva: amountField("TVA"),
    ttc: amountField("TTC"),
    debours: amountField("DEBOURS"),
    discount: amountField("DISCOUNT"),
    netPaid: amountField("NET_PAID"),
    paymentTerms: paymentTerms.value ? paymentTerms : paymentFallback ? field(paymentFallback, 66, paymentFallback, "keyword", []) : emptyField(),
    dueDate,
    currency,
    vatRate: totals.vatRateBps === null
      ? emptyField()
      : field(totals.vatRateBps, totals.vatRateSource === "vat-label" ? 88 : 66, `${(totals.vatRateBps / 100).toFixed(2)} %`, totals.vatRateSource, []),
  };

  if (issuer) {
    fields.supplier = field(issuer.name, issuer.nameConfidence, issuer.name, issuer.nameSource, issuer.evidence);
    fields.ice = field(issuer.ice, issuer.ice ? 94 : 0, issuer.ice, "issuer/ICE", issuer.evidence);
    fields.if = field(issuer.taxId, issuer.taxId ? 90 : 0, issuer.taxId, "issuer/IF", issuer.evidence);
    fields.supplierRc = field(issuer.rc, issuer.rc ? 88 : 0, issuer.rc, "issuer/RC", issuer.evidence);
    fields.supplierTp = field(issuer.tp, issuer.tp ? 88 : 0, issuer.tp, "issuer/TP", issuer.evidence);
    fields.supplierCnss = field(issuer.cnss, issuer.cnss ? 88 : 0, issuer.cnss, "issuer/CNSS", issuer.evidence);
  }
  if (recipient) {
    fields.client = field(recipient.name, recipient.nameConfidence, recipient.name, recipient.nameSource, recipient.evidence);
    fields.clientIce = field(recipient.ice, recipient.ice ? 94 : 0, recipient.ice, "recipient/ICE", recipient.evidence);
    fields.clientIf = field(recipient.taxId, recipient.taxId ? 90 : 0, recipient.taxId, "recipient/IF", recipient.evidence);
  }

  // The "tiers" a Moroccan bookkeeper posts against is the *other* party: the
  // supplier on a purchase, the customer on a sale. Whichever way the fallback
  // goes, it may never name the dossier itself — a dossier recorded as its own
  // supplier is the bug this whole path exists to prevent.
  // A party is excluded from the fallback when it is the dossier, and also when
  // its name matches the dossier while an identifier contradicts it: that is
  // precisely the case a person has to settle, and offering it as the "tiers"
  // is how the dossier ended up recorded against itself.
  const isDossierSide = (party: DetectedParty | null) => Boolean(party?.isCurrentCompany || party?.dossierMatch?.conflict);
  const dossierIsIssuer = isDossierSide(issuer);
  const dossierIsRecipient = isDossierSide(recipient);
  const preferred = classification.direction === "SALE" || dossierIsIssuer
    ? fields.client
    : classification.direction === "PURCHASE" || dossierIsRecipient
      ? fields.supplier
      : emptyField();
  const fallbacks = [
    preferred,
    dossierIsIssuer ? emptyField() : fields.supplier,
    dossierIsRecipient ? emptyField() : fields.client,
  ];
  fields.counterparty = fallbacks.find((candidate) => candidate.value) ?? emptyField();

  if (!parties.length) notes.push("Aucun bloc d'identification (ICE, IF, RC, TP, CNSS) n'a ete trouve : les tiers restent a saisir.");
  if (totals.evaluation.deboursAdditive) notes.push("Le total TTC n'est atteint qu'en ajoutant les debours a l'identique : ils sont hors base taxable.");
  if (!totals.evaluation.consistent && Object.keys(totals.assignment).length >= 2) {
    notes.push("Les montants lus ne verifient pas l'arithmetique de la piece ; ils sont signales pour controle.");
  }

  return { classification, parties: { issuer, recipient, all: parties }, totals, fields, trace: { candidates: trace.slice(0, 200), notes } };
}
