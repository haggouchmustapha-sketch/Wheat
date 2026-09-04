/**
 * Turning a recognised document into an invoice draft.
 *
 * Two decisions used to be made badly here, both in `main.ts` and both
 * unreachable from a test: which side of the ledger the document belongs to,
 * and which of the values the recogniser read actually reach the draft. The
 * first was hard-coded to "purchase", which filed a dossier's own sales
 * invoices against itself as supplier. The second stopped at six fields, so a
 * due date, a currency, a payment term and every line the document printed were
 * read, stored, and then dropped on the floor.
 *
 * This module owns both decisions as a pure function of the stored extraction.
 * It reads nothing and writes nothing: `planInvoiceDraftFromDocument` returns a
 * plan, the caller executes it in the transaction that also links the document.
 * That keeps the hand-off atomic — the invariant `wheat-ocr-handoff-atomicity`
 * guards — while making the mapping itself testable against a recorded
 * extraction.
 *
 * The rule for populating a field is the one a reviewer would apply: a value
 * reaches the draft when the document actually carried it and the reading is
 * confident enough to be worth correcting rather than typing. Anything else is
 * left blank. Nothing is inferred to make the arithmetic work.
 */

import { reconstructTotals, type TotalsReconstruction } from "./ocrAmounts";
import {
  invoiceKindForSide,
  matchPartyIdentity,
  normalizeCompanyName,
  resolveDossierSide,
  type IdentityBasis,
  type PartyIdentity,
} from "./partyIdentity";

export type InvoiceKind = "SALE" | "PURCHASE";

/** Below this, a reading is worth showing for review but not worth filling in. */
const MINIMUM_FIELD_CONFIDENCE = 45;

/**
 * Which ledger role a line's account plays. The concrete account is chosen
 * against the dossier's own chart by `resolveInvoiceAccountRoles`, never fixed
 * here: two dossiers on the same PCGE routinely post services to different
 * subdivisions.
 */
export type AccountRole = "REVENUE_SERVICE" | "REVENUE_GOODS" | "EXPENSE_SERVICE" | "EXPENSE_GOODS" | "DISBURSEMENT";

export type PlannedLine = {
  position: number;
  description: string;
  quantity: string | null;
  unitPriceCents: string | null;
  /** Printed commercial discount allocated to this line, in exact centimes. */
  discountCents: string;
  htCents: string;
  vatCents: string;
  ttcCents: string;
  vatRateBps: number | null;
  accountRole: AccountRole;
  /** True for a disbursement line: advanced on the client's behalf, not turnover. */
  disbursement: boolean;
};

export type PlannedCounterparty = {
  kind: "CUSTOMER" | "SUPPLIER";
  displayName: string;
  ice: string | null;
  taxId: string | null;
  rc: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
};

/**
 * A third party the dossier already deals with, and on which side.
 *
 * Supplied by the caller because it comes from the dossier's records, which
 * this module deliberately never reads. It is evidence about the *dossier*, not
 * about the page: a company that has invoiced this dossier eleven times as a
 * supplier is overwhelmingly likely to be doing so again.
 */
export type KnownCounterparty = {
  kind: "CUSTOMER" | "SUPPLIER";
  displayName: string;
  legalName?: string | null;
  ice?: string | null;
  taxId?: string | null;
  rc?: string | null;
};

export type InvoiceDraftPlan = {
  kind: InvoiceKind;
  /**
   * `IMPLIED` means the direction was deduced rather than read: the document
   * named one party and no recipient, or one of its parties is already a third
   * party of this dossier on a side that settles the question. Weaker than
   * `RESOLVED`, and carried into the draft note so a reviewer knows to check it.
   */
  directionStatus: "RESOLVED" | "IMPLIED" | "UNMATCHED" | "AMBIGUOUS" | "NOT_APPLICABLE";
  directionBasis: "ICE" | "IF" | "RC" | "NAME" | null;
  /**
   * True when nothing on the page or in the dossier established the direction
   * and the caller asked for a plan anyway. Everything else in the plan was
   * read normally; only this one decision is Wheat's assumption, and a
   * provisional plan must never be executed without a person settling it.
   */
  directionProvisional: boolean;
  /** The other reading, so a reviewer can flip the plan in one action. */
  directionAlternative: { kind: InvoiceKind; counterpartyName: string | null } | null;
  counterparty: PlannedCounterparty;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  paymentMethod: string | null;
  htCents: string;
  vatCents: string;
  ttcCents: string;
  deboursCents: string;
  discountCents: string;
  vatRateBps: number | null;
  lines: PlannedLine[];
  controlRole: "RECEIVABLE" | "PAYABLE";
  vatRole: "VAT_COLLECTED" | "VAT_DEDUCTIBLE";
  /** Things a reviewer has to look at. Never a reason to refuse on its own. */
  warnings: string[];
  /** Values the document did not carry, so the draft leaves them blank. */
  absentFields: string[];
};

export type PlanInput = {
  extracted: Record<string, any>;
  documentTitle: string;
  company: { name?: string | null; ice?: string | null; taxId?: string | null; rc?: string | null; city?: string | null; baseCurrency?: string | null };
  /** Counterparty payment terms, used only when the document prints no due date. */
  paymentTermsDays?: number | null;
  /**
   * Set when a person has already settled the direction — the reclassification
   * workflow, or a reviewer answering the confirmation prompt. It overrides the
   * document's own attribution and is recorded as such.
   */
  forcedKind?: InvoiceKind | null;
  /**
   * The dossier's existing third parties, used only to settle the direction
   * when the page itself could not. Optional: a caller that has none passes
   * nothing and gets exactly the previous behaviour.
   */
  knownCounterparties?: readonly KnownCounterparty[];
  /**
   * Lets the caller receive a plan whose direction is an assumption instead of
   * an exception.
   *
   * This exists for *preparation*, which shows a person what a document says
   * and asks about the one thing Wheat could not settle. Refusing there costs
   * the whole reading — number, date, third party, lines and totals all
   * discarded because one field is unknown — and leaves an accountant retyping
   * an invoice Wheat had already read correctly.
   *
   * It is deliberately not the default. The draft-creation path leaves it unset
   * and still refuses, so no execution can ever pick a side on its own: a
   * provisional plan carries `directionProvisional` and the caller must obtain
   * a `forcedKind` from a person before writing anything.
   */
  allowProvisionalDirection?: boolean;
};

/**
 * A correction the document's own arithmetic determines, offered with the
 * refusal that produced it.
 *
 * A refusal that only says "these totals do not add up" leaves the reader to
 * work out which of three numbers is wrong. When the redundancy an invoice
 * carries makes that unique, saying so turns a re-keying job into a
 * confirmation. `fields` is in the extraction's own field names and units so a
 * caller can apply it through the ordinary correction path.
 */
export type PlanCorrectionSuggestion = {
  explanation: string;
  fields: Record<string, string | number>;
};

export class InvoiceDraftPlanError extends Error {
  /** What the caller must supply, in the extraction's own field names. */
  readonly missingFields: string[];
  readonly code: string;
  /** Present when Wheat can name the correction, not merely the problem. */
  readonly suggestion: PlanCorrectionSuggestion | null;

  constructor(code: string, message: string, missingFields: string[] = [], suggestion: PlanCorrectionSuggestion | null = null) {
    super(message);
    this.name = "InvoiceDraftPlanError";
    this.code = code;
    this.missingFields = missingFields;
    this.suggestion = suggestion;
  }
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

/**
 * A field's value, when the reading is worth filling in rather than typing.
 *
 * An extraction with no confidence map at all comes from an earlier Wheat,
 * which stored only the values it had already accepted. Scoring those as zero
 * would blank every field on a dossier's existing documents, so an absent map
 * means "as read", not "unreliable". A map that exists and scores this field
 * low still wins.
 */
function confidentText(fields: Record<string, any>, confidences: Record<string, any>, key: string, minimum = MINIMUM_FIELD_CONFIDENCE): string | null {
  const value = text(fields[key]);
  if (!value) return null;
  if (confidences[key] === undefined) return value;
  const confidence = Number(confidences[key]);
  return Number.isFinite(confidence) && confidence < minimum ? null : value;
}

/** Exact centimes from a document-unit number, without ever touching a float. */
export function documentAmountToCents(value: unknown): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "bigint") return value;
  const raw = String(value).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = raw.replace("-", "").split(".");
  // Two decimals is the unit of a Moroccan invoice; a third is a misread, and
  // rounding it here would be inventing precision. It is truncated and the
  // caller's arithmetic check decides whether the result still holds.
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
  return negative ? -cents : cents;
}

function centsText(value: bigint) {
  return value.toString();
}

function isoDay(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
  }
  return null;
}

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The invoice number a document prints, or the one its file name carries. */
function resolveInvoiceNumber(fields: Record<string, any>, confidences: Record<string, any>, documentTitle: string) {
  const printed = confidentText(fields, confidences, "invoiceNumber", 40) ?? confidentText(fields, confidences, "reference", 40);
  if (printed) return { value: printed, source: "document" as const };
  const fromTitle = /\b(?:FA|FAC|FACT|FR|INV)[-_ /]?\d[\w/-]*/i.exec(documentTitle)?.[0]?.replace(/\s+/g, "-");
  return fromTitle ? { value: fromTitle, source: "file-name" as const } : { value: null, source: "absent" as const };
}

type ExtractedParty = { name?: string | null; ice?: string | null; taxId?: string | null; rc?: string | null; address?: string | null; email?: string | null; phone?: string | null } | null;

/**
 * The two parties of a document, whichever Wheat version extracted it.
 *
 * The current pipeline stores a `parties` block with each side's name and
 * identifiers. Documents filed by earlier versions carry only flat fields —
 * `supplier`, `ice`, `if`, sometimes `client` — and a dossier that has been
 * using Wheat for a year is full of them. Reading both shapes here is what
 * keeps those documents usable after the upgrade; nothing else in the module
 * needs to know which era a document came from.
 */
function resolveExtractedParties(extracted: Record<string, any>, fields: Record<string, any>): { issuer: ExtractedParty; recipient: ExtractedParty } {
  const stored = (extracted.parties ?? {}) as { issuer?: ExtractedParty; recipient?: ExtractedParty };
  if (stored.issuer || stored.recipient) return { issuer: stored.issuer ?? null, recipient: stored.recipient ?? null };

  const issuerName = text(fields.supplier) ?? text(fields.counterparty);
  const recipientName = text(fields.client);
  return {
    issuer: issuerName || text(fields.ice) ? { name: issuerName, ice: text(fields.ice), taxId: text(fields.if ?? fields.taxId), rc: text(fields.rc) } : null,
    recipient: recipientName || text(fields.clientIce) ? { name: recipientName, ice: text(fields.clientIce), taxId: text(fields.clientIf) } : null,
  };
}

function plannedCounterparty(party: ExtractedParty, kind: "CUSTOMER" | "SUPPLIER", fallbackName: string | null): PlannedCounterparty | null {
  const displayName = text(party?.name) ?? fallbackName;
  if (!displayName) return null;
  return {
    kind,
    displayName: displayName.slice(0, 200),
    ice: text(party?.ice),
    taxId: text(party?.taxId),
    rc: text(party?.rc),
    address: text(party?.address),
    email: text(party?.email),
    phone: text(party?.phone),
  };
}

/**
 * The direction the dossier's own third parties imply, when the page did not.
 *
 * A fiduciaire importing a supplier's eleventh invoice should not be asked
 * again which side of the ledger it belongs to. The dossier already answered
 * that: the issuer is one of its suppliers, so the dossier is the customer, so
 * this is a purchase. Nothing about the page changed — what changed is that
 * Wheat now consults what it already knows before giving up.
 *
 * The rule stays deliberately narrow, because the cost of being wrong here is a
 * document filed against the wrong side of the ledger:
 *
 *  - exactly one of the two parties may be a known third party. If both are,
 *    the page is between two of the dossier's own contacts and says nothing
 *    about which side the dossier is on;
 *  - the side and the role must agree. A known *supplier* named as the issuer
 *    implies a purchase; a known *customer* named as the recipient implies a
 *    sale. A supplier appearing as the recipient is a company the dossier both
 *    buys from and sells to, which settles nothing;
 *  - identity is decided by `matchPartyIdentity`, so an ICE or an IF carries
 *    the verdict and a look-alike name never overrules one.
 *
 * The result is always `IMPLIED`, never `RESOLVED`: it is an inference from the
 * dossier's history, not something the document states.
 */
function directionFromKnownCounterparties(
  known: readonly KnownCounterparty[],
  issuer: ExtractedParty,
  recipient: ExtractedParty,
): { kind: InvoiceKind; basis: IdentityBasis | null; matched: KnownCounterparty; side: "ISSUER" | "RECIPIENT" } | null {
  const best = (party: ExtractedParty) => {
    if (!party) return null;
    const target: PartyIdentity = { name: party.name, ice: party.ice, taxId: party.taxId, rc: party.rc };
    const matches = known
      .flatMap((candidate) => [candidate.displayName, candidate.legalName]
        .filter((name): name is string => Boolean(name))
        .map((name) => ({
          candidate,
          match: matchPartyIdentity({ name, ice: candidate.ice, taxId: candidate.taxId, rc: candidate.rc }, target),
        })))
      .filter((item) => item.match.verdict === "SAME")
      .sort((left, right) => right.match.confidence - left.match.confidence);
    return matches[0] ?? null;
  };

  const issuerMatch = best(issuer);
  const recipientMatch = best(recipient);
  // Both sides known: the document is between two of the dossier's contacts, or
  // the same company on both sides. Neither tells us where the dossier stands.
  if (issuerMatch && recipientMatch) return null;

  if (issuerMatch && issuerMatch.candidate.kind === "SUPPLIER") {
    return { kind: "PURCHASE", basis: issuerMatch.match.basis, matched: issuerMatch.candidate, side: "ISSUER" };
  }
  if (recipientMatch && recipientMatch.candidate.kind === "CUSTOMER") {
    return { kind: "SALE", basis: recipientMatch.match.basis, matched: recipientMatch.candidate, side: "RECIPIENT" };
  }
  return null;
}

/**
 * Splits the document's own lines into what they represent.
 *
 * A disbursement — "débours à l'identique" — is money advanced on the client's
 * behalf and re-invoiced unchanged. It is neither turnover nor a VAT base, and
 * treating it as revenue is the error the assistant made when it proposed a
 * sales account for the whole of an IFCOF invoice. Lines are matched by what
 * the document calls them, and the totals block confirms the amount.
 */
const DISBURSEMENT_TERMS = /\b(debours|debour|deboursement|frais avances|avances pour compte|pour le compte du client|refacturation a l identique)\b/;

function normalizedLabel(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isDisbursementDescription(description: string) {
  return DISBURSEMENT_TERMS.test(normalizedLabel(description));
}

const GOODS_TERMS = /\b(marchandise|marchandises|produit|produits|article|articles|fourniture|fournitures|materiel|equipement|livraison de biens)\b/;

function accountRoleFor(kind: InvoiceKind, description: string, disbursement: boolean): AccountRole {
  if (disbursement) return "DISBURSEMENT";
  const goods = GOODS_TERMS.test(normalizedLabel(description));
  if (kind === "SALE") return goods ? "REVENUE_GOODS" : "REVENUE_SERVICE";
  return goods ? "EXPENSE_GOODS" : "EXPENSE_SERVICE";
}

/**
 * Reads the document's printed lines, and falls back to a single line only when
 * it printed none that could be reconstructed.
 */
function planLines(input: {
  kind: InvoiceKind;
  lineItems: any[];
  htCents: bigint;
  vatCents: bigint;
  ttcCents: bigint;
  deboursCents: bigint;
  discountCents: bigint;
  vatRateBps: number | null;
  counterpartyName: string;
  warnings: string[];
}): PlannedLine[] {
  const printed = Array.isArray(input.lineItems) ? input.lineItems : [];
  const usable = printed
    .map((item, index) => {
      const description = text(item?.description);
      const lineTotal = item?.lineTotalCents === null || item?.lineTotalCents === undefined ? null : BigInt(String(item.lineTotalCents));
      if (!description || lineTotal === null) return null;
      return { index, description, lineTotal, item };
    })
    .filter((item): item is { index: number; description: string; lineTotal: bigint; item: any } => item !== null);

  const printedTotal = usable.reduce((sum, line) => sum + line.lineTotal, 0n);
  // The printed lines are used only when they reconstruct the document's own
  // taxable base. When they do not, the totals block is the more reliable of
  // the two readings and the difference is reported rather than absorbed.
  const linesMatchHt = usable.length > 0 && printedTotal === input.htCents;
  const linesMatchHtWithDebours = usable.length > 0 && printedTotal === input.htCents + input.deboursCents;

  if (!linesMatchHt && !linesMatchHtWithDebours) {
    if (usable.length) input.warnings.push(`Les ${usable.length} ligne(s) lues totalisent ${centsText(printedTotal)} centimes, pas le total HT de la pièce : une seule ligne récapitulative a été créée.`);
    const disbursementLine: PlannedLine[] = input.deboursCents > 0n
      ? [{
        position: 2,
        description: "Débours à l'identique",
        quantity: null,
        unitPriceCents: null,
        discountCents: "0",
        htCents: centsText(input.deboursCents),
        vatCents: "0",
        ttcCents: centsText(input.deboursCents),
        vatRateBps: 0,
        accountRole: "DISBURSEMENT",
        disbursement: true,
      }]
      : [];
    const baseHt = input.htCents - input.discountCents;
    return [
      {
        position: 1,
        description: `${input.kind === "SALE" ? "Prestation" : "Achat"} — ${input.counterpartyName}`.slice(0, 250),
        quantity: null,
        unitPriceCents: null,
        discountCents: centsText(input.discountCents),
        htCents: centsText(baseHt),
        vatCents: centsText(input.vatCents),
        ttcCents: centsText(baseHt + input.vatCents),
        vatRateBps: input.vatRateBps,
        accountRole: accountRoleFor(input.kind, "", false),
        disbursement: false,
      },
      ...disbursementLine,
    ];
  }

  // The lines add up. Each keeps its own description, quantity and unit price;
  // VAT is apportioned across the taxable lines in exact centimes, with the
  // rounding remainder landing on the last of them so the total is preserved.
  const taxable = usable.filter((line) => !isDisbursementDescription(line.description));
  const taxableBase = taxable.reduce((sum, line) => sum + line.lineTotal, 0n);
  let vatRemaining = input.vatCents;
  let discountRemaining = input.discountCents;
  return usable.map((line, position) => {
    const disbursement = isDisbursementDescription(line.description);
    const isLastTaxable = !disbursement && taxable[taxable.length - 1]?.index === line.index;
    const discount = disbursement || taxableBase === 0n
      ? 0n
      : isLastTaxable
        ? discountRemaining
        : (input.discountCents * line.lineTotal) / taxableBase;
    if (!disbursement) discountRemaining -= discount;
    const vat = disbursement || taxableBase === 0n
      ? 0n
      : isLastTaxable
        ? vatRemaining
        : (input.vatCents * line.lineTotal) / taxableBase;
    if (!disbursement) vatRemaining -= vat;
    const itemRate = Number(line.item?.vatRateBps);
    return {
      position: position + 1,
      description: line.description.slice(0, 250),
      quantity: text(line.item?.quantity),
      unitPriceCents: line.item?.unitPriceCents === null || line.item?.unitPriceCents === undefined ? null : String(line.item.unitPriceCents),
      discountCents: centsText(discount),
      htCents: centsText(line.lineTotal - discount),
      vatCents: centsText(vat),
      ttcCents: centsText(line.lineTotal - discount + vat),
      vatRateBps: disbursement ? 0 : Number.isInteger(itemRate) ? itemRate : input.vatRateBps,
      accountRole: accountRoleFor(input.kind, line.description, disbursement),
      disbursement,
    };
  });
}

/**
 * Turns a recoverable totals mismatch into the correction it implies.
 *
 * The arithmetic lives in `ocrAmounts.ts`; this only translates its answer into
 * the extraction's own field names and units, which is what a caller needs to
 * offer the fix through the ordinary OCR-correction path. It returns `null`
 * whenever the reading is not uniquely determined — an ambiguous document gets
 * the plain refusal, never a guess dressed as a proposal.
 */
function totalsSuggestion(input: {
  base: bigint;
  vat: bigint;
  ttc: bigint;
  debours: bigint;
  discount: bigint;
  statedRateBps: number | null;
}): PlanCorrectionSuggestion | null {
  const units = (value: bigint) => Number(value) / 100;
  const recovered: TotalsReconstruction | null = reconstructTotals({
    ht: units(input.base),
    tva: units(input.vat),
    ttc: units(input.ttc),
    debours: units(input.debours),
    discount: units(input.discount),
    statedRateBps: input.statedRateBps,
  });
  if (!recovered) return null;

  const money = (value: number) => value.toFixed(2);
  const changes = recovered.corrected
    .map((item) => `${item.field} lu ${money(item.read)} au lieu de ${money(item.implied)}`)
    .join(" ; ");
  return {
    explanation:
      `Le total TTC ${money(recovered.ttc)} et le taux de ${recovered.vatRateBps / 100} % ne laissent qu'une lecture possible : ` +
      `HT ${money(recovered.ht)} et TVA ${money(recovered.tva)}. ` +
      `${changes} — un seul chiffre diffère à chaque fois, ce qui est une erreur de reconnaissance et non un autre montant. ` +
      `Wheat propose cette lecture ; elle n'est appliquée que si vous l'acceptez.`,
    fields: { ht: recovered.ht, tva: recovered.tva, ttc: recovered.ttc, vatRate: recovered.vatRateBps },
  };
}

/**
 * Plans the invoice draft a recognised document should become.
 *
 * Throws only when the draft could not be created at all — no direction, no
 * third party, no number, or totals that do not add up. Every message names
 * what is missing so the caller (a review screen, or the assistant) can ask for
 * that one thing rather than reporting a failure.
 */
export function planInvoiceDraftFromDocument(input: PlanInput): InvoiceDraftPlan {
  const extracted = input.extracted ?? {};
  const fields = (extracted.fields ?? extracted) as Record<string, any>;
  const confidences = (extracted.fieldConfidence ?? {}) as Record<string, any>;
  const parties = resolveExtractedParties(extracted, fields);
  const warnings: string[] = [];
  const absentFields: string[] = [];

  // --- 1. Which side of the ledger -----------------------------------------
  const dossier: PartyIdentity = { name: input.company.name, ice: input.company.ice, taxId: input.company.taxId, rc: input.company.rc, city: input.company.city };
  const resolution = resolveDossierSide(dossier, parties.issuer, parties.recipient);
  let documentKind = invoiceKindForSide(resolution.side);
  let directionStatus: InvoiceDraftPlan["directionStatus"] = resolution.status;

  let directionBasis: IdentityBasis | null = resolution.side === "ISSUER"
    ? resolution.issuerMatch.basis
    : resolution.side === "RECIPIENT"
      ? resolution.recipientMatch.basis
      : null;

  // The dossier's own third parties, consulted before Wheat gives up. A
  // supplier that has invoiced this dossier before is invoicing it again.
  if (!documentKind && input.knownCounterparties?.length) {
    const known = directionFromKnownCounterparties(input.knownCounterparties, parties.issuer, parties.recipient);
    if (known) {
      documentKind = known.kind;
      directionStatus = "IMPLIED";
      directionBasis = known.basis;
      warnings.push(
        known.side === "ISSUER"
          ? `Le sens est déduit du dossier : « ${known.matched.displayName} » y est déjà enregistré comme fournisseur, la pièce est donc un achat. À confirmer.`
          : `Le sens est déduit du dossier : « ${known.matched.displayName} » y est déjà enregistré comme client, la pièce est donc une vente. À confirmer.`,
      );
    }
  }

  // A document that identifies exactly one party, names it as the issuer, and
  // names no recipient at all leaves the dossier as the only other party to the
  // transaction: that is a purchase, and saying so is not the old "treat
  // anything unattributable as an achat" fallback. The distinction that matters
  // is a *named* recipient — when the document says who it was addressed to and
  // that is not the dossier, nothing may be inferred and Wheat asks. This also
  // keeps documents extracted by earlier Wheat versions usable: their stored
  // extraction records a supplier and no party blocks at all.
  if (!documentKind && parties.issuer && !parties.recipient && matchPartyIdentity(dossier, parties.issuer).verdict !== "SAME") {
    documentKind = "PURCHASE";
    directionStatus = "IMPLIED";
    warnings.push(`La pièce ne nomme qu'une partie (« ${parties.issuer.name ?? "émetteur"} ») et aucun destinataire : elle est traitée comme un achat du dossier, à confirmer.`);
  }

  // Nothing settled it. Preparation may still describe the document — refusing
  // there discards a complete, correct reading over a single unknown field —
  // but the assumption is recorded as one and execution still requires a person.
  let directionProvisional = false;
  if (!documentKind && !input.forcedKind && input.allowProvisionalDirection) {
    documentKind = "PURCHASE";
    directionProvisional = true;
    directionBasis = null;
    warnings.push(
      `Wheat n'a pas pu établir si cette pièce est un achat ou une vente pour « ${input.company.name ?? "le dossier actif"} » : ${resolution.reasons.join(" ")} Elle est présentée comme un achat, à confirmer avant toute écriture.`,
    );
  }

  const kind = input.forcedKind ?? documentKind;
  if (!kind) {
    throw new InvoiceDraftPlanError(
      "DIRECTION_UNRESOLVED",
      `Wheat n'a pas pu déterminer si cette pièce est une vente ou un achat pour le dossier « ${input.company.name ?? "actif"} ». ${resolution.reasons.join(" ")} Indiquez le sens à retenir, ou complétez l'ICE du dossier.`,
      ["kind"],
    );
  }
  if (input.forcedKind) directionProvisional = false;
  if (input.forcedKind && documentKind && input.forcedKind !== documentKind) {
    warnings.push(`Le sens retenu (${input.forcedKind === "SALE" ? "vente" : "achat"}) contredit la lecture de la pièce (${documentKind === "SALE" ? "vente" : "achat"}) : choix humain conservé.`);
  }
  if (!documentKind && input.forcedKind) warnings.push("Le sens de la pièce a été indiqué manuellement : la pièce ne permettait pas de l'établir.");

  // --- 2. The third party — never the dossier itself ------------------------
  const counterpartySide = kind === "SALE" ? parties.recipient : parties.issuer;
  const counterparty = plannedCounterparty(
    counterpartySide,
    kind === "SALE" ? "CUSTOMER" : "SUPPLIER",
    confidentText(fields, confidences, kind === "SALE" ? "client" : "supplier"),
  );
  if (!counterparty) {
    throw new InvoiceDraftPlanError(
      "COUNTERPARTY_UNRESOLVED",
      `Le ${kind === "SALE" ? "client" : "fournisseur"} n'a pas pu être lu sur la pièce. Corrigez le champ correspondant dans la revue OCR avant de créer le brouillon.`,
      [kind === "SALE" ? "client" : "supplier"],
    );
  }
  // The last line of defence for the regression this module exists to prevent:
  // whatever the classifier decided, the dossier is never its own third party.
  const selfMatch = matchPartyIdentity(
    { name: input.company.name, ice: input.company.ice, taxId: input.company.taxId, rc: input.company.rc },
    { name: counterparty.displayName, ice: counterparty.ice, taxId: counterparty.taxId, rc: counterparty.rc } satisfies PartyIdentity,
  );
  if (selfMatch.verdict === "SAME") {
    throw new InvoiceDraftPlanError(
      "COUNTERPARTY_IS_DOSSIER",
      `Le tiers lu sur la pièce (« ${counterparty.displayName} ») est le dossier actif lui-même. Wheat refuse de créer un dossier comme son propre ${kind === "SALE" ? "client" : "fournisseur"} : vérifiez le sens de la pièce et les parties extraites.`,
      ["counterparty"],
    );
  }

  // --- 3. Number, dates, currency ------------------------------------------
  const number = resolveInvoiceNumber(fields, confidences, input.documentTitle);
  if (!number.value) {
    throw new InvoiceDraftPlanError(
      "INVOICE_NUMBER_ABSENT",
      "Le numéro de la pièce est introuvable. Corrigez le champ « numéro » dans la revue OCR avant de créer le brouillon.",
      ["invoiceNumber"],
    );
  }
  if (number.source === "file-name") warnings.push("Le numéro de pièce a été repris du nom de fichier, faute d'être lisible sur le document.");

  const invoiceDate = isoDay(confidentText(fields, confidences, "date", 40));
  if (!invoiceDate) {
    throw new InvoiceDraftPlanError(
      "INVOICE_DATE_ABSENT",
      "La date de la pièce est introuvable ou illisible. Corrigez le champ « date » dans la revue OCR avant de créer le brouillon.",
      ["date"],
    );
  }
  const printedDueDate = isoDay(confidentText(fields, confidences, "dueDate", 40));
  const dueDate = printedDueDate
    ?? (Number.isInteger(input.paymentTermsDays) && (input.paymentTermsDays as number) > 0 ? addDays(invoiceDate, input.paymentTermsDays as number) : null);
  if (!printedDueDate) absentFields.push("dueDate");
  if (!printedDueDate && dueDate) warnings.push(`La pièce n'imprime pas d'échéance : elle a été calculée à ${input.paymentTermsDays} jour(s) selon les conditions du tiers.`);

  const printedCurrency = confidentText(fields, confidences, "currency", 40);
  const dossierCurrency = text(input.company.baseCurrency)?.toUpperCase().slice(0, 3) ?? null;
  const currency = (printedCurrency ?? dossierCurrency)?.toUpperCase().slice(0, 3) ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new InvoiceDraftPlanError("CURRENCY_ABSENT", "La devise n'est indiquée ni sur la pièce ni dans le dossier actif. Complétez la devise avant de créer le brouillon.", ["currency"]);
  }
  if (!printedCurrency) {
    absentFields.push("currency");
    warnings.push(`La pièce n'imprime pas de devise : la devise de base ${currency} du dossier a été utilisée.`);
  }
  const paymentMethod = confidentText(fields, confidences, "paymentTerms", 55);
  if (!paymentMethod) absentFields.push("paymentTerms");

  // --- 4. Amounts, in exact centimes, never repaired ------------------------
  // `Number(null)` is 0, so reading the rate with a bare cast turned "the
  // document printed no rate" into "the document printed 0 %" — an absent rate
  // became a genuine exemption on every line, and the arithmetic that could
  // have recovered a misread total was pinned to the one rate that cannot.
  const rawRate = fields.vatRate === null || fields.vatRate === undefined || fields.vatRate === ""
    ? Number.NaN
    : Number(fields.vatRate);
  const ht = documentAmountToCents(fields.ht);
  const vat = documentAmountToCents(fields.tva ?? fields.vat) ?? 0n;
  const debours = documentAmountToCents(fields.debours) ?? 0n;
  const discount = documentAmountToCents(fields.discount) ?? 0n;
  let ttc = documentAmountToCents(fields.ttc);
  let base = ht;
  // Completing one missing total from the two that were read is arithmetic the
  // document itself states, not a correction: it is only done when exactly one
  // is absent, and never to reconcile three values that disagree.
  if (base === null && ttc !== null) base = ttc - vat - debours + discount;
  if (ttc === null && base !== null) ttc = base + vat + debours - discount;
  if (base === null || ttc === null) {
    throw new InvoiceDraftPlanError(
      "TOTALS_ABSENT",
      "Les totaux de la pièce (HT, TVA, TTC) n'ont pas pu être lus. Corrigez-les dans la revue OCR avant de créer le brouillon.",
      ["ht", "tva", "ttc"],
    );
  }
  if (base < 0n || vat < 0n || debours < 0n || discount < 0n || discount > base || ttc <= 0n) {
    throw new InvoiceDraftPlanError("TOTALS_INVALID", "Les totaux lus sur la pièce sont négatifs ou nuls. Corrigez-les avant de créer le brouillon.", ["ht", "tva", "ttc"]);
  }
  if (base + vat + debours - discount !== ttc) {
    throw new InvoiceDraftPlanError(
      "TOTALS_INCONSISTENT",
      `Les totaux lus ne s'équilibrent pas : HT ${centsText(base)} + TVA ${centsText(vat)}${debours > 0n ? ` + débours ${centsText(debours)}` : ""}${discount > 0n ? ` - remise ${centsText(discount)}` : ""} ≠ TTC ${centsText(ttc)} (en centimes). Wheat ne corrige pas une pièce pour la faire tomber juste : corrigez la lecture dans la revue OCR.`,
      ["ht", "tva", "ttc"],
      // When the document's own redundancy makes the intended reading unique,
      // naming it is the difference between retyping an invoice and confirming
      // one. It stays a proposal: nothing here applies it.
      totalsSuggestion({ base, vat, ttc, debours, discount, statedRateBps: Number.isInteger(rawRate) ? rawRate : null }),
    );
  }

  const vatRateBps = Number.isInteger(rawRate) ? rawRate : null;
  if (vatRateBps === null) absentFields.push("vatRate");
  if (discount > 0n) warnings.push(`La pièce porte une remise de ${centsText(discount)} centimes, conservée séparément sur les lignes ; le HT du brouillon est net de remise.`);

  const lineItems = extracted.invoiceSchema?.lineItems ?? [];
  const lines = planLines({ kind, lineItems, htCents: base, vatCents: vat, ttcCents: ttc, deboursCents: debours, discountCents: discount, vatRateBps, counterpartyName: counterparty.displayName, warnings });
  if (debours > 0n) warnings.push("Des débours à l'identique ont été isolés sur leur propre ligne : ils ne constituent ni du chiffre d'affaires ni une base de TVA.");

  // The lines carry the disbursements, so the invoice's own HT is the whole of
  // what is billed. The taxable base stays visible through the lines' roles.
  const invoiceHt = lines.reduce((sum, line) => sum + BigInt(line.htCents), 0n);
  const invoiceVat = lines.reduce((sum, line) => sum + BigInt(line.vatCents), 0n);

  return {
    kind,
    directionStatus,
    directionBasis,
    directionProvisional,
    // The party the other reading would post against, so a reviewer flipping
    // the direction can see who they would be filing this against.
    directionAlternative: directionStatus === "RESOLVED"
      ? null
      : {
        kind: kind === "SALE" ? "PURCHASE" : "SALE",
        counterpartyName: text((kind === "SALE" ? parties.issuer : parties.recipient)?.name),
      },
    counterparty,
    invoiceNo: number.value,
    invoiceDate,
    dueDate,
    currency,
    paymentMethod,
    htCents: centsText(invoiceHt),
    vatCents: centsText(invoiceVat),
    ttcCents: centsText(invoiceHt + invoiceVat),
    deboursCents: centsText(debours),
    discountCents: centsText(lines.reduce((sum, line) => sum + BigInt(line.discountCents), 0n)),
    vatRateBps,
    lines,
    controlRole: kind === "SALE" ? "RECEIVABLE" : "PAYABLE",
    vatRole: kind === "SALE" ? "VAT_COLLECTED" : "VAT_DEDUCTIBLE",
    warnings: [...warnings, ...(resolution.side ? [] : ["Le sens de la pièce n'a pas été établi automatiquement."])],
    absentFields,
  };
}

/* ------------------------------------------------------------------ */
/* Account selection against the dossier's own chart                   */
/* ------------------------------------------------------------------ */

/**
 * Candidate accounts per role, most specific first.
 *
 * These are PCGE codes, not a Wheat convention: a dossier seeded from the
 * official plan has the six-digit subdivisions, one migrated from an older
 * Wheat has the four-digit collective accounts, and a fiduciaire's own chart
 * may carry its custom subdivision of either. All three are tried before the
 * search falls back to matching the account's label.
 */
const ROLE_CANDIDATES: Record<AccountRole | "RECEIVABLE" | "PAYABLE" | "VAT_COLLECTED" | "VAT_DEDUCTIBLE", { codes: readonly string[]; labels: RegExp; description: string }> = {
  RECEIVABLE: { codes: ["342100", "34211", "3421", "3425"], labels: /client/i, description: "compte collectif clients" },
  PAYABLE: { codes: ["441100", "44111", "4411"], labels: /fournisseur/i, description: "compte collectif fournisseurs" },
  VAT_COLLECTED: { codes: ["445500", "44551", "4455"], labels: /tva\s+factur/i, description: "compte de TVA facturée" },
  VAT_DEDUCTIBLE: { codes: ["345520", "34552", "3455"], labels: /tva\s+r[ée]cup/i, description: "compte de TVA récupérable" },
  REVENUE_SERVICE: { codes: ["712400", "71243", "71253", "7124"], labels: /prestation|service|honoraire/i, description: "compte de ventes de services" },
  REVENUE_GOODS: { codes: ["711100", "71111", "7111"], labels: /vente.*marchandise/i, description: "compte de ventes de marchandises" },
  EXPENSE_SERVICE: { codes: ["613600", "61365", "6136", "612500"], labels: /honoraire|service ext|autres charges externes/i, description: "compte de charges externes" },
  EXPENSE_GOODS: { codes: ["611100", "61111", "6111"], labels: /achat.*marchandise/i, description: "compte d'achats de marchandises" },
  // Money advanced for a client and re-invoiced unchanged: a third-party
  // balance, never a profit-and-loss account.
  DISBURSEMENT: { codes: ["348800", "3488", "448800", "4488"], labels: /divers d[ée]biteur|divers cr[ée]ancier|d[ée]bours/i, description: "compte de tiers pour les débours" },
};

export type ChartAccount = { id: string; code: string; label: string; active: boolean; postable?: boolean };

export type ResolvedRole = { role: string; account: ChartAccount | null; basis: "CODE" | "LABEL" | null; description: string };

/**
 * Chooses the dossier's own account for a role.
 *
 * Returns `null` rather than inventing one: a missing account is a
 * configuration question for the person keeping the books, and the caller turns
 * it into a message that names the role and the codes that were looked for.
 */
export function resolveAccountRole(role: keyof typeof ROLE_CANDIDATES, accounts: readonly ChartAccount[]): ResolvedRole {
  const candidate = ROLE_CANDIDATES[role];
  const usable = accounts.filter((account) => account.active && account.postable !== false);
  for (const code of candidate.codes) {
    const found = usable.find((account) => account.code === code);
    if (found) return { role, account: found, basis: "CODE", description: candidate.description };
  }
  // A dossier that subdivided the account keeps the parent's prefix: 7124001
  // is still a services-revenue account, and is preferred over a label match.
  for (const code of candidate.codes) {
    const found = usable.find((account) => account.code.startsWith(code));
    if (found) return { role, account: found, basis: "CODE", description: candidate.description };
  }
  const byLabel = usable.find((account) => candidate.labels.test(account.label));
  if (byLabel) return { role, account: byLabel, basis: "LABEL", description: candidate.description };
  return { role, account: null, basis: null, description: candidate.description };
}

export function missingAccountMessage(unresolved: readonly ResolvedRole[]) {
  const parts = unresolved.map((item) => `${item.description} (codes attendus : ${ROLE_CANDIDATES[item.role as keyof typeof ROLE_CANDIDATES].codes.join(", ")})`);
  return `Le plan comptable du dossier ne contient pas ${parts.join(", ni ")}. Créez ou activez ${unresolved.length > 1 ? "ces comptes" : "ce compte"} avant de créer le brouillon.`;
}

/** Every role a plan needs resolved before it can be written. */
export function requiredRolesForPlan(plan: InvoiceDraftPlan): string[] {
  return [...new Set<string>([plan.controlRole, plan.vatRole, ...plan.lines.map((line) => line.accountRole)])];
}

export { normalizeCompanyName };
