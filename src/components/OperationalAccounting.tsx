import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FileClock,
  FileDown,
  FileMinus2,
  FilePlus2,
  Landmark,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRoundPlus,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { reconciliationIssue } from "../lib/reconciliationIssues";
import { useAccessibleDialog } from "../lib/useAccessibleDialog";
import { useDraftedForm } from "../lib/useFormDraft";
import type { WheatIssue } from "../lib/wheatIssues";
import "./OperationalAccounting.css";
import { IssueInfo } from "./ui";
import { WheatSelect, type WheatSelectOption } from "./ui/WheatSelect";

export type OperationalNoticeTone = "success" | "warning" | "error" | "info";

export interface OperationalAccountOption {
  id: string;
  code: string;
  label: string;
  active?: boolean;
  classNo?: number;
}

export interface OperationalBankAccountOption {
  id: string;
  bankName: string;
  iban?: string;
  currency?: string;
  ledgerAccountId?: string | null;
}

export interface OperationalAccountingProps {
  companyId: string;
  companyName?: string;
  currency?: string;
  accounts?: OperationalAccountOption[];
  bankAccounts?: OperationalBankAccountOption[];
  initialTab?: OperationalAccountingTab;
  onChanged?: () => void | Promise<void>;
  onNotify?: (message: string, tone: OperationalNoticeTone) => void;
}

export interface ReconciliationWorkbenchProps {
  companyId: string;
  initialBankAccountId?: string;
  initialMovementId?: string;
  /**
   * The statement a person has just asked to reconcile.
   *
   * Reconciling is done a batch at a time. Landing on every movement the
   * account has ever held makes the reader find the ones that arrived a
   * moment ago; the desk opens on that file instead, and says which file it
   * is showing so the whole account is one click away.
   */
  openBatch?: { bankAccountId: string; statementId: string };
  onImportStatement?: (bankAccountId: string) => Promise<void>;
  onChanged?: () => void | Promise<void>;
  onNotify?: (message: string, tone: OperationalNoticeTone) => void;
}

export type OperationalAccountingTab = "sales" | "purchases" | "payments" | "counterparties";

type LooseRecord = Record<string, any>;

type CounterpartyRecord = LooseRecord & {
  id: string;
  kind: "CUSTOMER" | "SUPPLIER" | "BOTH" | string;
  displayName: string;
  ice?: string | null;
  taxId?: string | null;
  active: boolean;
  version: number;
};

type InvoiceRecord = LooseRecord & {
  id: string;
  kind: "SALE" | "PURCHASE" | string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  lifecycleStatus: string;
  status?: string;
  counterparty?: string;
  counterpartyNameSnapshot?: string | null;
  counterpartyId?: string | null;
  currency?: string;
  needsReview?: boolean;
  version: number;
  settlement?: LooseRecord;
  documentType?: "INVOICE" | "CREDIT_NOTE" | string;
  creditedInvoiceId?: string | null;
  artifactRequired?: boolean;
  artifacts?: LooseRecord[];
};

type PaymentRecord = LooseRecord & {
  id: string;
  kind: "RECEIPT" | "DISBURSEMENT" | string;
  paymentDate: string;
  lifecycleStatus: string;
  reference?: string | null;
  method?: string;
  currency?: string;
  version: number;
  counterparty?: CounterpartyRecord;
  allocations?: LooseRecord[];
};

type OperationalPageMeta = {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  totalCount: number;
};

type OperationalPageEnvelope<T> = OperationalPageMeta & { items: T[] };

const OPERATIONAL_PAGE_LIMIT = 50;

function emptyOperationalPage(): OperationalPageMeta {
  return { nextCursor: null, hasMore: false, limit: OPERATIONAL_PAGE_LIMIT, totalCount: 0 };
}

function normalizeOperationalPage<T>(value: unknown): OperationalPageEnvelope<T> {
  if (Array.isArray(value)) {
    return { items: value as T[], nextCursor: null, hasMore: false, limit: value.length, totalCount: value.length };
  }
  if (!value || typeof value !== "object") return { items: [], ...emptyOperationalPage() };
  const source = value as LooseRecord;
  const items = Array.isArray(source.items) ? source.items as T[] : [];
  const nextCursor = typeof source.nextCursor === "string" && source.nextCursor ? source.nextCursor : null;
  const totalCount = typeof source.totalCount === "number" && Number.isSafeInteger(source.totalCount) && source.totalCount >= 0
    ? source.totalCount
    : items.length;
  const limit = typeof source.limit === "number" && Number.isSafeInteger(source.limit) && source.limit > 0
    ? source.limit
    : OPERATIONAL_PAGE_LIMIT;
  return { items, nextCursor, hasMore: source.hasMore === true && nextCursor !== null, limit, totalCount };
}

function appendUniqueRecords<T extends { id: string }>(current: T[], additions: T[]): T[] {
  const existing = new Set(current.map((item) => item.id));
  return [...current, ...additions.filter((item) => !existing.has(item.id))];
}

type ReconciliationState = {
  status: "UNRECONCILED" | "PARTIAL" | "RECONCILED" | "EXCLUDED" | "REVIEW_REQUIRED" | string;
  movementMagnitudeCents: string;
  allocatedCents: string;
  remainingCents: string;
};

type ReconciliationMovement = LooseRecord & {
  id: string;
  bankAccountId: string;
  date: string;
  valueDate?: string | null;
  label: string;
  reference: string;
  amountCents: string;
  revision: number;
  excludedAt?: string | null;
  exclusionReason?: string | null;
  legacyMatchClaimed?: boolean;
  reconciliation: ReconciliationState;
  reconciliations?: LooseRecord[];
};

type ReconciliationAccount = LooseRecord & {
  id: string;
  bankName: string;
  iban?: string;
  currency?: string;
  ledgerAccountId?: string | null;
  ledgerAccount?: LooseRecord | null;
  statements?: Array<LooseRecord & {
    id: string;
    sourceName: string;
    sourceFormat?: string;
    rowCount: number;
    importedCount?: number;
    skippedCount?: number;
    errorCount?: number;
    duplicateCount?: number;
    importedAt: string;
  }>;
};

type ReconciliationWorkspace = {
  companyId: string;
  accounts: ReconciliationAccount[];
  movements: ReconciliationMovement[];
  generatedAt?: string;
};

type CandidateLine = LooseRecord & {
  id: string;
  label: string;
  availableCents: string;
  suggestedCents: string;
  signedLineCents: string;
  score: number;
  /** Codes from `scoreCandidate` in `electron/reconciliation.ts`. */
  matchReasons?: string[];
  entry: LooseRecord;
  account: LooseRecord;
};

/**
 * The score in words.
 *
 * The percentage says how confident Wheat is; these say what that confidence
 * rests on, which is what an accountant needs in order to disagree with it.
 * An unrecognised code is dropped rather than shown raw — a suggestion is
 * never explained by a word only a developer understands.
 */
const CANDIDATE_REASON_LABELS: Record<string, string> = {
  AMOUNT_EXACT: "même montant",
  AMOUNT_COVERS: "montant suffisant",
  DATE_SAME_DAY: "même jour",
  DATE_WITHIN_3_DAYS: "à 3 jours près",
  DATE_WITHIN_10_DAYS: "à 10 jours près",
  REFERENCE_MATCH: "référence trouvée",
};

function candidateReasonText(line: CandidateLine): string {
  return (line.matchReasons ?? [])
    .map((code) => CANDIDATE_REASON_LABELS[code])
    .filter((label): label is string => Boolean(label))
    .join(" · ");
}

type CandidateResponse = {
  movement: ReconciliationMovement;
  entryLines: CandidateLine[];
  paymentEvidence: LooseRecord[];
};

const tabs: Array<{ id: OperationalAccountingTab; label: string; shortLabel: string }> = [
  { id: "sales", label: "Ventes", shortLabel: "Ventes" },
  { id: "purchases", label: "Achats", shortLabel: "Achats" },
  { id: "payments", label: "Paiements", shortLabel: "Paiements" },
  { id: "counterparties", label: "Tiers", shortLabel: "Tiers" },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

function futureIso(days: number): string {
  const date = new Date(`${todayIso()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/*
 * The sentence a person should read, without the transport it arrived over.
 *
 * Electron wraps anything a handler throws as "Error invoking remote method
 * 'wheat:bank:movement:restore': Error: …". The channel name is plumbing: it
 * belongs in the main-process log, not in front of an accountant, where it
 * pushes the actual reason off the end of a one-line notice.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)*/;

function textError(error: unknown): string {
  if (!(error instanceof Error)) return "Une erreur inattendue est survenue.";
  return error.message.replace(IPC_WRAPPER, "").trim() || error.message;
}

function normalizeIntegerCents(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function decimalToCents(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const text = String(value).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return `${negative ? "-" : ""}${cents}`;
}

function centsToDecimal(centsValue: string): string {
  const cents = BigInt(centsValue);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function editableMoney(record: LooseRecord | null | undefined, centsKey: string, decimalKey: string, fallback = "0.00"): string {
  if (!record) return fallback;
  const cents = normalizeIntegerCents(record[centsKey]);
  if (cents !== null) return centsToDecimal(cents);
  const converted = decimalToCents(record[decimalKey]);
  return converted === null ? fallback : centsToDecimal(converted);
}

function dateInputValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return todayIso();
}

function milliToDecimal(value: unknown): string | undefined {
  const normalized = normalizeIntegerCents(value);
  if (normalized === null) return undefined;
  const milli = BigInt(normalized);
  const negative = milli < 0n;
  const absolute = negative ? -milli : milli;
  const fraction = String(absolute % 1_000n).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / 1_000n}${fraction ? `.${fraction}` : ""}`;
}

/** Formats integer cents without converting through Number, including values beyond 2^53. */
function formatExactCents(value: unknown, currency = "MAD"): string {
  const normalized = normalizeIntegerCents(value);
  if (normalized === null) return "—";
  const cents = BigInt(normalized);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const grouped = String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return `${negative ? "−" : ""}${grouped},${String(absolute % 100n).padStart(2, "0")} ${currency}`;
}

/**
 * The two money columns of a bank statement, restored from the one signed
 * figure Wheat stores.
 *
 * A relevé has a Débit column and a Crédit column, and an accountant reads the
 * one the amount sits in. Storing the movement as a single signed amount is the
 * faithful record of which column the import read it from, but showing it that
 * way asks the person to decode a minus sign to answer a question the source
 * document already answered plainly.
 *
 * The sense is the statement's own — débit is money leaving the account, crédit
 * money arriving. It is deliberately not the sense of the 514 ledger line facing
 * it across the reconciliation, which is why the column header says whose sense
 * it is rather than leaving the reader to assume.
 */
type StatementSide = "DEBIT" | "CREDIT";

function statementSide(value: unknown): StatementSide | null {
  const normalized = normalizeIntegerCents(value);
  if (normalized === null) return null;
  const cents = BigInt(normalized);
  if (cents === 0n) return null;
  return cents < 0n ? "DEBIT" : "CREDIT";
}

/** The amount as the statement prints it: a magnitude under a named column. */
function statementColumnAmount(value: unknown, side: StatementSide, currency: string): string {
  if (statementSide(value) !== side) return "—";
  const cents = BigInt(normalizeIntegerCents(value) as string);
  return formatExactCents((cents < 0n ? -cents : cents).toString(), currency);
}

function moneyFrom(record: LooseRecord | null | undefined, centsKey: string, decimalKey: string, currency = "MAD"): string {
  if (!record) return formatExactCents("0", currency);
  const exactCents = normalizeIntegerCents(record[centsKey]);
  if (exactCents !== null) return formatExactCents(exactCents, currency);
  const converted = decimalToCents(record[decimalKey]);
  return converted === null ? "—" : formatExactCents(converted, currency);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
}

function statusLabel(status: string): string {
  return ({
    DRAFT: "Brouillon",
    POSTED: "Comptabilisé",
    VOIDED: "Annulé",
    REVERSED: "Annulée",
    LEGACY: "À reprendre",
    UNPAID: "Non réglée",
    OVERDUE: "Échue",
    PARTIALLY_PAID: "Partiellement réglée",
    PARTIALLY_PAID_OVERDUE: "Partielle · échue",
    PAID: "Réglée",
    PAID_LATE: "Réglée en retard",
    OVERPAID: "Trop-perçu",
    ACTIVE: "Actif",
    ARCHIVED: "Archivé",
    UNRECONCILED: "À rapprocher",
    PARTIAL: "Partiel",
    RECONCILED: "Rapproché",
    EXCLUDED: "Exclu",
    REVIEW_REQUIRED: "Contrôle requis",
  } as Record<string, string>)[status] ?? status.replaceAll("_", " ").toLocaleLowerCase("fr");
}

function statusTone(status: string): string {
  if (["POSTED", "PAID", "RECONCILED", "ACTIVE"].includes(status)) return "positive";
  if (["OVERDUE", "VOIDED"].includes(status)) return "negative";
  if (["PARTIAL", "PARTIALLY_PAID", "PARTIALLY_PAID_OVERDUE", "REVIEW_REQUIRED", "LEGACY", "PAID_LATE"].includes(status)) return "warning";
  if (["EXCLUDED", "ARCHIVED", "REVERSED"].includes(status)) return "muted";
  return "neutral";
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`op-status op-status--${statusTone(status)}`}>{statusLabel(status)}</span>;
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="op-empty">
      <span className="op-empty__icon">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function BusyButtonContent({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? <><LoaderCircle className="op-spin" size={15} /> Traitement…</> : <>{children}</>;
}

type OperationalNotice = { message: string; tone: OperationalNoticeTone; issue?: WheatIssue };

/*
 * A refusal, and the reason behind it.
 *
 * The domain services state a refusal in one short English sentence. Where the
 * rule behind it is one Wheat can name, the notice carries the structured
 * explanation with it, so the accountant gets the same information affordance
 * here as on every checked list — what the rule is, why it exists and what to
 * do — rather than a sentence to interpret. Unrecognised messages are shown
 * exactly as before and explain nothing.
 */
function useOperationalNotice(onNotify?: OperationalAccountingProps["onNotify"]) {
  const [notice, setNotice] = useState<OperationalNotice | null>(null);
  const notify = useCallback((message: string, tone: OperationalNoticeTone) => {
    const issue = tone === "error" || tone === "warning" ? reconciliationIssue(message) ?? undefined : undefined;
    setNotice({ message: issue?.message ?? message, tone, issue });
    onNotify?.(issue?.message ?? message, tone);
  }, [onNotify]);
  return { notice, notify, clearNotice: () => setNotice(null) };
}

function OperationNotice({ notice, onClose }: { notice: OperationalNotice | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          className={`op-notice op-notice--${notice.tone}`}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          {notice.issue && <IssueInfo issue={notice.issue} />}
          <button type="button" onClick={onClose} aria-label="Fermer le message"><X size={15} /></button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function rowMatchesSearch(values: unknown[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase("fr");
  return !normalized || values.some((value) => String(value ?? "").toLocaleLowerCase("fr").includes(normalized));
}

type InvoiceLineDraft = {
  key: string;
  description: string;
  accountId: string;
  ht: string;
  vat: string;
  quantity?: string;
  unitPrice?: string;
  discount?: string;
  vatRateBps?: number;
  taxRateDefinitionId?: string;
};

type InvoiceDraft = {
  taxConfigurationVersionId: string;
  counterpartyId: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  lines: InvoiceLineDraft[];
};

type CreditLineDraft = {
  key: string;
  creditedInvoiceLineId: string;
  description: string;
  originalHtCents: string;
  originalVatCents: string;
  ht: string;
  vat: string;
};

type CreditDraft = {
  creditedInvoiceId: string;
  invoiceNo: string;
  invoiceDate: string;
  creditReason: string;
  lines: CreditLineDraft[];
};

const blankCreditDraft = (): CreditDraft => ({ creditedInvoiceId: "", invoiceNo: "", invoiceDate: todayIso(), creditReason: "", lines: [] });

let draftKeySequence = 0;

function draftKey(prefix: string): string {
  draftKeySequence += 1;
  return `${prefix}-${draftKeySequence}`;
}

function newInvoiceLineDraft(): InvoiceLineDraft {
  return { key: draftKey("invoice-line"), description: "", accountId: "", ht: "", vat: "0.00" };
}

function newInvoiceDraft(): InvoiceDraft {
  return {
    taxConfigurationVersionId: "",
    counterpartyId: "",
    invoiceNo: "",
    invoiceDate: todayIso(),
    dueDate: futureIso(30),
    lines: [newInvoiceLineDraft()],
  };
}

function vatDecimalForRate(ht: string, rateBps: number): string {
  const htCents = decimalToCents(ht);
  if (htCents === null) return "0.00";
  const vatCents = (BigInt(htCents) * BigInt(rateBps) + 5_000n) / 10_000n;
  return centsToDecimal(vatCents.toString());
}

type PaymentAllocationDraft = {
  key: string;
  invoiceId: string;
  amount: string;
};

type PaymentDraft = {
  kind: "RECEIPT" | "DISBURSEMENT";
  counterpartyId: string;
  paymentDate: string;
  reference: string;
  method: string;
  amount: string;
  bankAccountId: string;
  allocations: PaymentAllocationDraft[];
};

function newPaymentDraft(): PaymentDraft {
  return {
    kind: "RECEIPT",
    counterpartyId: "",
    paymentDate: todayIso(),
    reference: "",
    method: "Virement",
    amount: "",
    bankAccountId: "",
    allocations: [],
  };
}

type CounterpartyDraft = {
  kind: "CUSTOMER" | "SUPPLIER" | "BOTH";
  displayName: string;
  legalName: string;
  ice: string;
  taxId: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  defaultReceivableAccountId: string;
  defaultPayableAccountId: string;
  paymentTermsDays: string;
};

const newCounterpartyDraft = (): CounterpartyDraft => ({
  kind: "CUSTOMER",
  displayName: "",
  legalName: "",
  ice: "",
  taxId: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  defaultReceivableAccountId: "",
  defaultPayableAccountId: "",
  paymentTermsDays: "30",
});

type OperationalConfirmation =
  | { type: "post-invoice" | "post-credit" | "post-payment" | "delete-invoice" | "delete-payment" | "archive-counterparty" | "restore-counterparty" | "void-invoice" | "void-payment"; record: LooseRecord }
  | { type: "reverse-allocation"; record: PaymentRecord; allocation: LooseRecord };

function confirmationCopy(action: OperationalConfirmation): { title: string; detail: string; confirmLabel: string; danger: boolean } {
  switch (action.type) {
    case "post-invoice": return { title: "Comptabiliser cette facture ?", detail: "Une écriture comptable sera créée. Toute correction ultérieure passera par une annulation traçable.", confirmLabel: "Comptabiliser", danger: false };
    case "post-credit": return { title: "Comptabiliser cet avoir ?", detail: "Wheat revérifiera les plafonds de la facture d'origine, créera l'écriture en sens opposé et figera un PDF hashé.", confirmLabel: "Comptabiliser l'avoir", danger: false };
    case "post-payment": return { title: "Comptabiliser ce paiement ?", detail: "Une écriture comptable sera créée et les imputations deviendront actives.", confirmLabel: "Comptabiliser", danger: false };
    case "delete-invoice": return { title: action.record.documentType === "CREDIT_NOTE" ? "Supprimer ce brouillon d'avoir ?" : "Supprimer ce brouillon de facture ?", detail: "Le brouillon sera supprimé définitivement. Les documents qui lui sont liés resteront conservés.", confirmLabel: "Supprimer", danger: true };
    case "delete-payment": return { title: "Supprimer ce brouillon de paiement ?", detail: "Le brouillon et son plan d’imputation seront supprimés. Les documents liés resteront conservés.", confirmLabel: "Supprimer", danger: true };
    case "void-invoice": return { title: "Annuler cette facture comptabilisée ?", detail: "Wheat créera une écriture de contrepassation à la date indiquée. L’original restera consultable.", confirmLabel: "Annuler la facture", danger: true };
    case "void-payment": return { title: "Annuler ce paiement comptabilisé ?", detail: "Wheat créera une contrepassation et annulera ses imputations actives sans supprimer l’historique.", confirmLabel: "Annuler le paiement", danger: true };
    case "reverse-allocation": return { title: "Annuler cette imputation ?", detail: "Le paiement et la facture resteront comptabilisés. L’imputation restera visible comme annulée.", confirmLabel: "Annuler l’imputation", danger: true };
    case "restore-counterparty": return { title: "Restaurer ce tiers ?", detail: "Le tiers redeviendra disponible pour les nouvelles factures et les nouveaux paiements.", confirmLabel: "Restaurer", danger: false };
    default: return { title: "Archiver ce tiers ?", detail: "L’historique reste conservé. Le tiers ne sera plus proposé sur les nouveaux documents.", confirmLabel: "Archiver", danger: false };
  }
}

export function OperationalAccounting({
  companyId,
  companyName,
  currency = "MAD",
  accounts = [],
  bankAccounts = [],
  initialTab = "sales",
  onChanged,
  onNotify,
}: OperationalAccountingProps) {
  const [tab, setTab] = useState<OperationalAccountingTab>(initialTab);
  const [counterparties, setCounterparties] = useState<CounterpartyRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [taxConfigurations, setTaxConfigurations] = useState<LooseRecord[]>([]);
  const [pages, setPages] = useState<Record<OperationalAccountingTab, OperationalPageMeta>>(() => ({
    sales: emptyOperationalPage(),
    purchases: emptyOperationalPage(),
    payments: emptyOperationalPage(),
    counterparties: emptyOperationalPage(),
  }));
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<OperationalAccountingTab | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [composer, setComposer] = useState<"invoice" | "credit" | "payment" | "counterparty" | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(newInvoiceDraft);
  const [creditDraft, setCreditDraft] = useState<CreditDraft>(blankCreditDraft);
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(newPaymentDraft);
  const [counterpartyDraft, setCounterpartyDraft] = useState<CounterpartyDraft>(newCounterpartyDraft);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceRecord | null>(null);
  const [editingCredit, setEditingCredit] = useState<InvoiceRecord | null>(null);
  const [editingPayment, setEditingPayment] = useState<PaymentRecord | null>(null);
  const [editingCounterparty, setEditingCounterparty] = useState<CounterpartyRecord | null>(null);
  const [expandedPaymentId, setExpandedPaymentId] = useState("");
  const [confirmAction, setConfirmAction] = useState<OperationalConfirmation | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [actionDate, setActionDate] = useState(todayIso);
  const dataRequestId = useRef(0);
  const { notice, notify, clearNotice } = useOperationalNotice(onNotify);

  /* ------------------------------------------------------ unfinished work */
  /**
   * Each composer keeps what has been typed into it until the person submits
   * it or throws it away. Closing the panel, switching tab, leaving the screen
   * and coming back are none of them a decision to discard anything.
   *
   * The identities are deliberate. A new sales invoice and a new purchase
   * invoice are separate drafts, so starting one does not overwrite the other;
   * an edit is keyed by the record it edits and carries that record's version,
   * so a draft left over from before somebody else changed the record comes
   * back marked stale rather than silently overwriting the newer values.
   */
  const invoiceDraftStore = useDraftedForm<InvoiceDraft>({
    companyId,
    entity: "invoice",
    draftKey: editingInvoice ? editingInvoice.id : `new-${tab}`,
    currentVersion: editingInvoice?.version ?? null,
    open: composer === "invoice",
    value: invoiceDraft,
    onRestore: (payload) => setInvoiceDraft(payload),
    onStale: () => notify("Cette facture a changé depuis votre brouillon : les valeurs affichées sont celles enregistrées. Votre saisie non terminée n'a pas été appliquée.", "warning"),
  });

  const creditDraftStore = useDraftedForm<CreditDraft>({
    companyId,
    entity: "credit_note",
    draftKey: editingCredit ? editingCredit.id : `new-${creditDraft.creditedInvoiceId || "unlinked"}`,
    currentVersion: editingCredit?.version ?? null,
    open: composer === "credit",
    value: creditDraft,
    onRestore: (payload) => setCreditDraft(payload),
    onStale: () => notify("Cet avoir a changé depuis votre brouillon : votre saisie non terminée n'a pas été appliquée.", "warning"),
  });

  const paymentDraftStore = useDraftedForm<PaymentDraft>({
    companyId,
    entity: "payment",
    draftKey: editingPayment ? editingPayment.id : "new",
    currentVersion: editingPayment?.version ?? null,
    open: composer === "payment",
    value: paymentDraft,
    onRestore: (payload) => setPaymentDraft(payload),
    onStale: () => notify("Ce règlement a changé depuis votre brouillon : votre saisie non terminée n'a pas été appliquée.", "warning"),
  });

  const counterpartyDraftStore = useDraftedForm<CounterpartyDraft>({
    companyId,
    entity: "counterparty",
    draftKey: editingCounterparty ? editingCounterparty.id : "new",
    currentVersion: editingCounterparty?.version ?? null,
    open: composer === "counterparty",
    value: counterpartyDraft,
    onRestore: (payload) => setCounterpartyDraft(payload),
    onStale: () => notify("Ce tiers a changé depuis votre brouillon : votre saisie non terminée n'a pas été appliquée.", "warning"),
  });

  /** What the composer header says about the work it is holding. */
  const activeDraftStore = composer === "invoice"
    ? invoiceDraftStore
    : composer === "credit"
      ? creditDraftStore
      : composer === "payment"
        ? paymentDraftStore
        : composer === "counterparty"
          ? counterpartyDraftStore
          : null;

  const closeConfirmation = useCallback(() => {
    setConfirmAction(null);
    setActionReason("");
    setActionDate(todayIso());
  }, []);
  const confirmationDialogRef = useAccessibleDialog<HTMLDivElement>(closeConfirmation, Boolean(confirmAction));

  const load = useCallback(async (quiet = false) => {
    const requestId = ++dataRequestId.current;
    const bridge = window.wheat;
    if (!bridge?.listCounterparties || !bridge?.listInvoices || !bridge?.listPayments) {
      if (requestId === dataRequestId.current) setLoading(false);
      notify("Les services de sous-livre nécessitent l’application desktop Wheat.", "warning");
      return;
    }
    setLoadingMore(null);
    if (!quiet) setLoading(true);
    try {
      const [counterpartyResult, salesResult, purchaseResult, paymentResult, taxWorkspace] = await Promise.all([
        bridge?.listCounterparties({ companyId, includeArchived: true, limit: OPERATIONAL_PAGE_LIMIT }),
        bridge?.listInvoices({ companyId, kind: "SALE", limit: OPERATIONAL_PAGE_LIMIT }),
        bridge?.listInvoices({ companyId, kind: "PURCHASE", limit: OPERATIONAL_PAGE_LIMIT }),
        bridge?.listPayments({ companyId, limit: OPERATIONAL_PAGE_LIMIT }),
        bridge?.getTaxWorkspace ? bridge?.getTaxWorkspace({ companyId }) : Promise.resolve({ configurations: [] }),
      ]);
      const counterpartyPage = normalizeOperationalPage<CounterpartyRecord>(counterpartyResult);
      const salesPage = normalizeOperationalPage<InvoiceRecord>(salesResult);
      const purchasePage = normalizeOperationalPage<InvoiceRecord>(purchaseResult);
      const paymentPage = normalizeOperationalPage<PaymentRecord>(paymentResult);
      if (requestId !== dataRequestId.current) return;
      setTaxConfigurations(Array.isArray(taxWorkspace?.configurations) ? taxWorkspace.configurations : []);
      setCounterparties(counterpartyPage.items);
      setInvoices([...salesPage.items, ...purchasePage.items]);
      setPayments(paymentPage.items);
      setPages({
        sales: salesPage,
        purchases: purchasePage,
        payments: paymentPage,
        counterparties: counterpartyPage,
      });
    } catch (error) {
      if (requestId === dataRequestId.current) notify(textError(error), "error");
    } finally {
      if (requestId === dataRequestId.current) setLoading(false);
    }
  }, [companyId, notify]);

  useEffect(() => {
    setComposer(null);
    setEditingInvoice(null);
    setEditingPayment(null);
    setEditingCounterparty(null);
    setConfirmAction(null);
    setExpandedPaymentId("");
    void load();
  }, [load]);

  const activeInvoices = useMemo(() => invoices.filter((invoice) => invoice.kind === (tab === "sales" ? "SALE" : "PURCHASE")), [invoices, tab]);
  const displayedInvoices = useMemo(() => activeInvoices.filter((invoice) => rowMatchesSearch([
    invoice.invoiceNo,
    invoice.counterparty,
    invoice.counterpartyNameSnapshot,
    invoice.status,
    invoice.lifecycleStatus,
  ], query)), [activeInvoices, query]);
  const displayedPayments = useMemo(() => payments.filter((payment) => rowMatchesSearch([
    payment.reference,
    payment.method,
    payment.kind,
    payment.lifecycleStatus,
    payment.counterparty?.displayName,
  ], query)), [payments, query]);
  const displayedCounterparties = useMemo(() => counterparties.filter((counterparty) => rowMatchesSearch([
    counterparty.displayName,
    counterparty.ice,
    counterparty.taxId,
    counterparty.kind,
  ], query)), [counterparties, query]);
  const activePage = pages[tab];
  const activeLoadedCount = tab === "payments"
    ? payments.length
    : tab === "counterparties"
      ? counterparties.length
      : activeInvoices.length;
  const activeDisplayedCount = tab === "payments"
    ? displayedPayments.length
    : tab === "counterparties"
      ? displayedCounterparties.length
      : displayedInvoices.length;

  const loadMoreForActiveTab = useCallback(async () => {
    const bridge = window.wheat;
    const target = tab;
    const page = pages[target];
    if (!page.hasMore || !page.nextCursor || loadingMore) return;
    const requestId = ++dataRequestId.current;
    setLoadingMore(target);
    try {
      if (target === "counterparties") {
        if (!bridge?.listCounterparties) throw new Error("Chargement des tiers indisponible.");
        const next = normalizeOperationalPage<CounterpartyRecord>(await bridge?.listCounterparties({
          companyId,
          includeArchived: true,
          limit: page.limit,
          cursor: page.nextCursor,
        }));
        const { items, ...meta } = next;
        if (requestId !== dataRequestId.current) return;
        setCounterparties((current) => appendUniqueRecords(current, items));
        setPages((current) => ({ ...current, counterparties: meta }));
      } else if (target === "payments") {
        if (!bridge?.listPayments) throw new Error("Chargement des paiements indisponible.");
        const next = normalizeOperationalPage<PaymentRecord>(await bridge?.listPayments({
          companyId,
          limit: page.limit,
          cursor: page.nextCursor,
        }));
        const { items, ...meta } = next;
        if (requestId !== dataRequestId.current) return;
        setPayments((current) => appendUniqueRecords(current, items));
        setPages((current) => ({ ...current, payments: meta }));
      } else {
        if (!bridge?.listInvoices) throw new Error("Chargement des factures indisponible.");
        const next = normalizeOperationalPage<InvoiceRecord>(await bridge?.listInvoices({
          companyId,
          kind: target === "sales" ? "SALE" : "PURCHASE",
          limit: page.limit,
          cursor: page.nextCursor,
        }));
        const { items, ...meta } = next;
        if (requestId !== dataRequestId.current) return;
        setInvoices((current) => appendUniqueRecords(current, items));
        setPages((current) => ({ ...current, [target]: meta }));
      }
    } catch (error) {
      if (requestId === dataRequestId.current) notify(textError(error), "error");
    } finally {
      if (requestId === dataRequestId.current) setLoadingMore(null);
    }
  }, [companyId, loadingMore, notify, pages, tab]);

  const legacyInvoices = invoices.filter((invoice) => invoice.lifecycleStatus === "LEGACY" || invoice.needsReview);
  const activeCounterparties = counterparties.filter((counterparty) => counterparty.active);
  const eligibleInvoiceCounterparties = activeCounterparties.filter((counterparty) => {
    const kind = tab === "sales" ? "CUSTOMER" : "SUPPLIER";
    return counterparty.kind === kind || counterparty.kind === "BOTH";
  });
  const activeAccounts = accounts.filter((account) => account.active !== false);
  const activeTaxConfigurations = taxConfigurations.filter((configuration) => configuration.status === "ACTIVE");
  const selectedTaxConfiguration = activeTaxConfigurations.find((configuration) => configuration.id === invoiceDraft.taxConfigurationVersionId) ?? null;
  const applicableTaxRates = (Array.isArray(selectedTaxConfiguration?.rates) ? selectedTaxConfiguration.rates : []).filter((rate: LooseRecord) => (
    rate.active !== false && (rate.direction === "BOTH" || rate.direction === (tab === "sales" ? "COLLECTED" : "DEDUCTIBLE"))
  ));
  const receivableAccounts = activeAccounts.filter((account) => account.code.startsWith("342"));
  const payableAccounts = activeAccounts.filter((account) => account.code.startsWith("441"));
  const receivableAccountOptions = receivableAccounts.length ? receivableAccounts : activeAccounts;
  const payableAccountOptions = payableAccounts.length ? payableAccounts : activeAccounts;
  const purposeAccounts = activeAccounts.filter((account) => account.classNo === (tab === "sales" ? 7 : 6));
  const entryAccounts = purposeAccounts.length ? purposeAccounts : activeAccounts;
  const eligiblePaymentInvoices = invoices.filter((invoice) => (
    invoice.counterpartyId === paymentDraft.counterpartyId
    && invoice.lifecycleStatus === "POSTED"
    && (invoice.documentType ?? "INVOICE") === "INVOICE"
    && (paymentDraft.kind === "RECEIPT" ? invoice.kind === "SALE" : invoice.kind === "PURCHASE")
    && normalizeIntegerCents(invoice.settlement?.balanceCents ?? invoice.settlement?.balance) !== "0"
  ));
  const invoiceDraftTotalCents = useMemo(() => {
    let total = 0n;
    for (const line of invoiceDraft.lines) {
      const ht = decimalToCents(line.ht);
      const vat = decimalToCents(line.vat);
      if (ht === null || vat === null) return null;
      total += BigInt(ht) + BigInt(vat);
    }
    return total.toString();
  }, [invoiceDraft.lines]);

  const refreshAfterMutation = useCallback(async (message: string) => {
    await load(true);
    await onChanged?.();
    notify(message, "success");
  }, [load, notify, onChanged]);

  const closeComposer = () => {
    setComposer(null);
    setEditingInvoice(null);
    setEditingCredit(null);
    setEditingPayment(null);
    setEditingCounterparty(null);
  };

  const requestConfirmation = (action: OperationalConfirmation) => {
    setActionReason("");
    setActionDate(todayIso());
    setConfirmAction(action);
  };

  const openInvoiceComposer = (invoice?: InvoiceRecord) => {
    if (!invoice) {
      setEditingInvoice(null);
      setEditingCounterparty(null);
      const draft = newInvoiceDraft();
      const configuration = activeTaxConfigurations.find((item) => {
        const from = dateInputValue(item.effectiveFrom);
        const to = item.effectiveTo ? dateInputValue(item.effectiveTo) : "9999-12-31";
        return from <= draft.invoiceDate && to >= draft.invoiceDate;
      });
      setInvoiceDraft({ ...draft, taxConfigurationVersionId: configuration?.id ?? "" });
      setComposer("invoice");
      return;
    }
    const lines = Array.isArray(invoice.lines) && invoice.lines.length
      ? invoice.lines.map((line: LooseRecord) => ({
        key: line.id || draftKey("invoice-line"),
        description: String(line.description ?? ""),
        accountId: String(line.accountId ?? ""),
        ht: editableMoney(line, "htCents", "ht", ""),
        vat: editableMoney(line, "vatCents", "vat"),
        quantity: milliToDecimal(line.quantityMilli),
        unitPrice: line.unitPriceCents === null || line.unitPriceCents === undefined ? undefined : editableMoney(line, "unitPriceCents", "unitPrice"),
        discount: line.discountCents === null || line.discountCents === undefined ? undefined : editableMoney(line, "discountCents", "discount"),
        vatRateBps: typeof line.vatRateBps === "number" ? line.vatRateBps : undefined,
        taxRateDefinitionId: line.taxRateDefinitionId ?? undefined,
      }))
      : [newInvoiceLineDraft()];
    setTab(invoice.kind === "PURCHASE" ? "purchases" : "sales");
    setEditingPayment(null);
    setEditingCounterparty(null);
    setEditingInvoice(invoice);
    setInvoiceDraft({
      taxConfigurationVersionId: String(invoice.taxConfigurationVersionId ?? ""),
      counterpartyId: invoice.counterpartyId ?? "",
      invoiceNo: String(invoice.numberKey ?? "").startsWith("DRAFT:") ? "" : invoice.invoiceNo,
      invoiceDate: dateInputValue(invoice.invoiceDate),
      dueDate: dateInputValue(invoice.dueDate),
      lines,
    });
    setComposer("invoice");
  };

  const openCreditComposer = (original: InvoiceRecord, credit?: InvoiceRecord) => {
    const originalLines = Array.isArray(original.lines) ? original.lines : [];
    const creditLines = Array.isArray(credit?.lines) ? credit!.lines : [];
    if (!originalLines.length) {
      notify("Les lignes de la facture d'origine doivent être chargées avant de créer un avoir.", "warning");
      return;
    }
    setTab(original.kind === "PURCHASE" ? "purchases" : "sales");
    setEditingInvoice(null);
    setEditingPayment(null);
    setEditingCounterparty(null);
    setEditingCredit(credit ?? null);
    setCreditDraft({
      creditedInvoiceId: original.id,
      invoiceNo: credit?.invoiceNo && !String(credit.numberKey ?? "").startsWith("DRAFT:") ? credit.invoiceNo : "",
      invoiceDate: dateInputValue(credit?.invoiceDate ?? todayIso()),
      creditReason: String(credit?.creditReason ?? ""),
      lines: originalLines.map((line: LooseRecord) => {
        const existing = creditLines.find((item: LooseRecord) => item.creditedInvoiceLineId === line.id);
        return {
          key: existing?.id ?? draftKey("credit-line"),
          creditedInvoiceLineId: line.id,
          description: String(line.description ?? "Ligne d'origine"),
          originalHtCents: normalizeIntegerCents(line.htCents ?? line.ht) ?? "0",
          originalVatCents: normalizeIntegerCents(line.vatCents ?? line.vat) ?? "0",
          ht: existing ? editableMoney(existing, "htCents", "ht", "") : "",
          vat: existing ? editableMoney(existing, "vatCents", "vat", "") : "",
        };
      }),
    });
    setComposer("credit");
  };

  const openPaymentComposer = (payment?: PaymentRecord) => {
    if (!payment) {
      setEditingPayment(null);
      setEditingCounterparty(null);
      setPaymentDraft(newPaymentDraft());
      setComposer("payment");
      return;
    }
    setTab("payments");
    setEditingInvoice(null);
    setEditingCounterparty(null);
    setEditingPayment(payment);
    setPaymentDraft({
      kind: payment.kind === "DISBURSEMENT" ? "DISBURSEMENT" : "RECEIPT",
      counterpartyId: String(payment.counterpartyId ?? payment.counterparty?.id ?? ""),
      paymentDate: dateInputValue(payment.paymentDate),
      reference: String(payment.reference ?? ""),
      method: String(payment.method ?? "Virement"),
      amount: editableMoney(payment, "amountCents", "amount", ""),
      bankAccountId: String(payment.bankAccountId ?? payment.bankAccount?.id ?? ""),
      allocations: (payment.allocations ?? []).filter((allocation) => allocation.status === "ACTIVE").map((allocation) => ({
        key: allocation.id || draftKey("payment-allocation"),
        invoiceId: String(allocation.invoiceId ?? allocation.invoice?.id ?? ""),
        amount: editableMoney(allocation, "amountCents", "amount", ""),
      })),
    });
    setComposer("payment");
  };

  const openCounterpartyComposer = (counterparty?: CounterpartyRecord) => {
    setTab("counterparties");
    setEditingInvoice(null);
    setEditingPayment(null);
    if (!counterparty) {
      setEditingCounterparty(null);
      setCounterpartyDraft(newCounterpartyDraft());
      setComposer("counterparty");
      return;
    }
    setEditingCounterparty(counterparty);
    setCounterpartyDraft({
      kind: counterparty.kind === "SUPPLIER" || counterparty.kind === "BOTH" ? counterparty.kind : "CUSTOMER",
      displayName: String(counterparty.displayName ?? ""),
      legalName: String(counterparty.legalName ?? ""),
      ice: String(counterparty.ice ?? ""),
      taxId: String(counterparty.taxId ?? ""),
      email: String(counterparty.email ?? ""),
      phone: String(counterparty.phone ?? ""),
      address: String(counterparty.address ?? ""),
      city: String(counterparty.city ?? ""),
      defaultReceivableAccountId: String(counterparty.defaultReceivableAccountId ?? counterparty.defaultReceivableAccount?.id ?? ""),
      defaultPayableAccountId: String(counterparty.defaultPayableAccountId ?? counterparty.defaultPayableAccount?.id ?? ""),
      paymentTermsDays: String(counterparty.paymentTermsDays ?? 30),
    });
    setComposer("counterparty");
  };

  const submitInvoice = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = window.wheat;
    const action = editingInvoice ? bridge?.updateInvoiceDraft : bridge?.createInvoiceDraft;
    if (!action) return notify(`${editingInvoice ? "Modification" : "Création"} indisponible hors de l’application desktop.`, "warning");
    const invalidLine = invoiceDraft.lines.some((line) => decimalToCents(line.ht) === null || decimalToCents(line.vat) === null);
    if (invalidLine) return notify("Les montants HT et TVA doivent avoir au plus deux décimales.", "error");
    const lines = invoiceDraft.lines.map((line) => {
      const htCents = decimalToCents(line.ht);
      const vatCents = decimalToCents(line.vat);
      if (htCents === null || vatCents === null) throw new Error("Montant de ligne invalide.");
      return {
        description: line.description,
        accountId: line.accountId,
        ht: line.ht,
        vat: line.vat || "0.00",
        ttc: centsToDecimal((BigInt(htCents) + BigInt(vatCents)).toString()),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        vatRateBps: line.vatRateBps,
        taxRateDefinitionId: line.taxRateDefinitionId,
      };
    });
    const operationKey = `${editingInvoice ? "update" : "create"}-invoice`;
    setBusyKey(operationKey);
    try {
      await action({
        ...(editingInvoice ? { id: editingInvoice.id, expectedVersion: editingInvoice.version } : {}),
        companyId,
        kind: tab === "sales" ? "SALE" : "PURCHASE",
        counterpartyId: invoiceDraft.counterpartyId,
        invoiceNo: invoiceDraft.invoiceNo || undefined,
        invoiceDate: invoiceDraft.invoiceDate,
        dueDate: invoiceDraft.dueDate,
        currency,
        taxConfigurationVersionId: invoiceDraft.taxConfigurationVersionId || undefined,
        lines,
      });
      const wasEditing = Boolean(editingInvoice);
      // The draft is released only now, after the service confirmed the write.
      // A submission that threw leaves it exactly where it was.
      await invoiceDraftStore.clear();
      closeComposer();
      setInvoiceDraft(newInvoiceDraft());
      await refreshAfterMutation(wasEditing ? "Brouillon de facture mis à jour." : "Brouillon de facture créé. Vérifiez-le avant comptabilisation.");
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const submitCredit = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = window.wheat;
    const action = editingCredit ? bridge?.updateCreditNoteDraft : bridge?.createCreditNoteDraft;
    if (!action) return notify("Le moteur d'avoirs Wheat n'est pas disponible.", "warning");
    const selectedLines = creditDraft.lines.filter((line) => line.ht.trim() || line.vat.trim());
    if (!selectedLines.length) return notify("Saisissez au moins une ligne d'avoir.", "warning");
    const lines = selectedLines.map((line) => {
      const htCents = decimalToCents(line.ht || "0");
      const vatCents = decimalToCents(line.vat || "0");
      if (htCents === null || vatCents === null || BigInt(htCents) < 0n || BigInt(vatCents) < 0n || BigInt(htCents) + BigInt(vatCents) <= 0n) {
        throw new Error("Chaque ligne d'avoir doit contenir un montant positif avec deux décimales au maximum.");
      }
      return {
        creditedInvoiceLineId: line.creditedInvoiceLineId,
        htCents,
        vatCents,
        ttcCents: (BigInt(htCents) + BigInt(vatCents)).toString(),
      };
    });
    setBusyKey(editingCredit ? "update-credit" : "create-credit");
    try {
      await action({
        ...(editingCredit ? { id: editingCredit.id, expectedVersion: editingCredit.version } : {}),
        companyId,
        creditedInvoiceId: creditDraft.creditedInvoiceId,
        invoiceDate: creditDraft.invoiceDate,
        invoiceNo: creditDraft.invoiceNo || undefined,
        creditReason: creditDraft.creditReason,
        lines,
      });
      // The draft is released only now, after the service confirmed the write.
      // A submission that threw leaves it exactly where it was.
      await creditDraftStore.clear();
      closeComposer();
      setCreditDraft(blankCreditDraft());
      await refreshAfterMutation(editingCredit ? "Brouillon d'avoir mis à jour." : "Brouillon d'avoir créé et plafonné à la facture d'origine.");
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const exportVerifiedArtifact = async (invoice: InvoiceRecord) => {
    const bridge = window.wheat;
    if (!bridge?.listInvoiceArtifacts || !bridge?.verifyInvoiceArtifact || !bridge?.exportInvoiceArtifact || !bridge?.exportFile) {
      return notify("L'export d'artefact vérifié n'est pas disponible.", "warning");
    }
    setBusyKey(`artifact-${invoice.id}`);
    try {
      const listed = await bridge?.listInvoiceArtifacts({ companyId, invoiceId: invoice.id });
      const artifact = (Array.isArray(listed) ? listed : listed?.items ?? [])[0];
      if (!artifact) throw new Error("Aucun PDF immuable n'est associé à ce document.");
      const vérification = await bridge?.verifyInvoiceArtifact({ companyId, artifactId: artifact.id });
      if (!vérification?.valid) throw new Error(`L'artefact n'est plus intègre : ${(vérification?.problems ?? []).join(" ")}`);
      const exported = await bridge?.exportInvoiceArtifact({ companyId, artifactId: artifact.id });
      const saved = await bridge?.exportFile({
        suggestedName: exported?.artifact?.suggestedName ?? `${invoice.documentType === "CREDIT_NOTE" ? "avoir" : "facture"}-${invoice.invoiceNo}.pdf`,
        bytesBase64: exported.bytesBase64,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (saved) notify("PDF vérifié et exporté.", "success");
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const submitPayment = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = window.wheat;
    const action = editingPayment ? bridge?.updatePaymentDraft : bridge?.createPaymentDraft;
    if (!action) return notify(`${editingPayment ? "Modification" : "Création"} indisponible hors de l’application desktop.`, "warning");
    const operationKey = `${editingPayment ? "update" : "create"}-payment`;
    setBusyKey(operationKey);
    try {
      await action({
        ...(editingPayment ? { id: editingPayment.id, expectedVersion: editingPayment.version } : {}),
        companyId,
        counterpartyId: paymentDraft.counterpartyId,
        kind: paymentDraft.kind,
        paymentDate: paymentDraft.paymentDate,
        reference: paymentDraft.reference || undefined,
        method: paymentDraft.method,
        currency,
        amount: paymentDraft.amount,
        bankAccountId: paymentDraft.bankAccountId || undefined,
        allocations: paymentDraft.allocations.map((allocation) => ({ invoiceId: allocation.invoiceId, amount: allocation.amount })),
      });
      const wasEditing = Boolean(editingPayment);
      // The draft is released only now, after the service confirmed the write.
      // A submission that threw leaves it exactly where it was.
      await paymentDraftStore.clear();
      closeComposer();
      setPaymentDraft(newPaymentDraft());
      await refreshAfterMutation(wasEditing ? "Brouillon de paiement mis à jour." : "Brouillon de paiement créé. Il reste sans effet comptable jusqu’à sa validation.");
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const submitCounterparty = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = window.wheat;
    const action = editingCounterparty ? bridge?.updateCounterparty : bridge?.createCounterparty;
    if (!action) return notify(`${editingCounterparty ? "Modification" : "Création"} indisponible hors de l’application desktop.`, "warning");
    if (!/^\d{1,4}$/.test(counterpartyDraft.paymentTermsDays) || Number(counterpartyDraft.paymentTermsDays) > 3650) {
      return notify("Le délai de paiement doit être compris entre 0 et 3 650 jours.", "error");
    }
    const operationKey = `${editingCounterparty ? "update" : "create"}-counterparty`;
    setBusyKey(operationKey);
    try {
      await action({
        ...(editingCounterparty ? { id: editingCounterparty.id, expectedVersion: editingCounterparty.version } : {}),
        companyId,
        ...counterpartyDraft,
        paymentTermsDays: Number(counterpartyDraft.paymentTermsDays),
        defaultReceivableAccountId: counterpartyDraft.defaultReceivableAccountId || undefined,
        defaultPayableAccountId: counterpartyDraft.defaultPayableAccountId || undefined,
      });
      const wasEditing = Boolean(editingCounterparty);
      // The draft is released only now, after the service confirmed the write.
      // A submission that threw leaves it exactly where it was.
      await counterpartyDraftStore.clear();
      closeComposer();
      setCounterpartyDraft(newCounterpartyDraft());
      await refreshAfterMutation(wasEditing ? "Tiers mis à jour." : "Tiers créé.");
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const executeConfirmedAction = async () => {
    if (!confirmAction) return;
    const bridge = window.wheat;
    const { type, record } = confirmAction;
    const allocation = type === "reverse-allocation" ? confirmAction.allocation : null;
    setBusyKey(`${type}-${record.id}`);
    try {
      if (type === "post-invoice") {
        if (!bridge?.postInvoice) throw new Error("Comptabilisation de facture indisponible.");
        await bridge?.postInvoice({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Facture comptabilisée et écriture générée.");
      } else if (type === "post-credit") {
        if (!bridge?.postCreditNote) throw new Error("Comptabilisation d'avoir indisponible.");
        await bridge?.postCreditNote({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Avoir comptabilisé en sens opposé et PDF immuable généré.");
      } else if (type === "post-payment") {
        if (!bridge?.postPayment) throw new Error("Comptabilisation de paiement indisponible.");
        await bridge?.postPayment({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Paiement comptabilisé et imputation mise à jour.");
      } else if (type === "delete-invoice") {
        if (!bridge?.deleteInvoiceDraft) throw new Error("Suppression du brouillon de facture indisponible.");
        await bridge?.deleteInvoiceDraft({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Brouillon de facture supprimé. Les documents liés sont conservés.");
      } else if (type === "delete-payment") {
        if (!bridge?.deletePaymentDraft) throw new Error("Suppression du brouillon de paiement indisponible.");
        await bridge?.deletePaymentDraft({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Brouillon de paiement supprimé. Les documents liés sont conservés.");
      } else if (type === "void-invoice") {
        if (!bridge?.voidInvoice) throw new Error("Annulation de facture indisponible.");
        await bridge?.voidInvoice({ id: record.id, companyId, expectedVersion: record.version, reason: actionReason, date: actionDate });
        await refreshAfterMutation("Facture annulée par une écriture de contrepassation traçable.");
      } else if (type === "void-payment") {
        if (!bridge?.voidPayment) throw new Error("Annulation de paiement indisponible.");
        await bridge?.voidPayment({ id: record.id, companyId, expectedVersion: record.version, reason: actionReason, date: actionDate });
        await refreshAfterMutation("Paiement annulé par une écriture de contrepassation traçable.");
      } else if (type === "reverse-allocation") {
        if (!bridge?.reversePaymentAllocation) throw new Error("Annulation d’imputation indisponible.");
        await bridge?.reversePaymentAllocation({ allocationId: allocation?.id, companyId, expectedPaymentVersion: record.version, reason: actionReason, date: actionDate });
        await refreshAfterMutation("Imputation annulée sans supprimer son historique.");
      } else if (type === "restore-counterparty") {
        if (!bridge?.restoreCounterparty) throw new Error("Restauration du tiers indisponible.");
        await bridge?.restoreCounterparty({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Tiers restauré et disponible sur les nouveaux documents.");
      } else {
        if (!bridge?.archiveCounterparty) throw new Error("Archivage du tiers indisponible.");
        await bridge?.archiveCounterparty({ id: record.id, companyId, expectedVersion: record.version });
        await refreshAfterMutation("Tiers archivé sans suppression de son historique.");
      }
      closeConfirmation();
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const tabCount = (id: OperationalAccountingTab) => {
    return pages[id].totalCount;
  };

  const openComposerForTab = () => {
    if (tab === "payments") {
      openPaymentComposer();
    } else if (tab === "counterparties") {
      openCounterpartyComposer();
    } else openInvoiceComposer();
  };

  return (
    <section className="op-shell" aria-label="Factures et paiements">
      <header className="op-page-head">
        <div>
          <p className="op-kicker">Sous-livre · {companyName || "Société active"}</p>
          <h1>Factures & paiements</h1>
          <p>Les brouillons restent sans effet comptable. La comptabilisation crée une écriture traçable.</p>
        </div>
        <div className="op-page-actions">
          <button type="button" className="op-button op-button--quiet" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "op-spin" : ""} /> Actualiser
          </button>
          <button type="button" className="op-button op-button--primary" onClick={openComposerForTab}>
            <Plus size={16} /> {tab === "counterparties" ? "Nouveau tiers" : tab === "payments" ? "Nouveau paiement" : "Nouvelle facture"}
          </button>
        </div>
      </header>

      <OperationNotice notice={notice} onClose={clearNotice} />

      {legacyInvoices.length > 0 && (
        <div className="op-legacy-banner" role="status">
          <FileClock size={18} />
          <div>
            <strong>{legacyInvoices.length} facture{legacyInvoices.length > 1 ? "s" : ""} à contrôler</strong>
            <span>Ce décompte porte sur les pages chargées. Ces factures restent conservées sans écriture automatique ni règlement supposé.</span>
          </div>
        </div>
      )}

      <div className="op-tabbar" role="tablist" aria-label="Sous-livres">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-disabled={Boolean(composer) && tab !== item.id}
            disabled={Boolean(composer) && tab !== item.id}
            className={tab === item.id ? "is-active" : ""}
            onClick={() => { setTab(item.id); closeComposer(); setQuery(""); }}
          >
            <span>{item.shortLabel}</span><small>{tabCount(item.id)}</small>
          </button>
        ))}
      </div>

      <div className="op-toolbar">
        <label className="op-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans les éléments chargés…" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Effacer la recherche"><X size={14} /></button>}
        </label>
        <span className="op-result-count">
          <strong>{query ? `${activeDisplayedCount} correspondance(s) parmi ${activeLoadedCount} ligne(s) chargée(s)` : `${activeLoadedCount} ligne(s) chargée(s) sur ${activePage.totalCount}`}</strong>
          {activePage.hasMore && <small>La recherche ne couvre pas encore toute la liste.</small>}
        </span>
      </div>

      <AnimatePresence mode="wait">
        {composer && (
          <motion.div
            className="op-composer"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="op-composer__head">
              <div>
                <strong>{composer === "invoice" ? `${editingInvoice ? "Modifier" : "Brouillon de"} facture ${tab === "sales" ? "client" : "fournisseur"}` : composer === "credit" ? `${editingCredit ? "Modifier" : "Brouillon d'"}avoir lié` : composer === "payment" ? `${editingPayment ? "Modifier le" : "Brouillon de"} paiement` : editingCounterparty ? "Modifier le tiers" : "Nouveau tiers"}</strong>
                <span>{editingCounterparty ? "Les nouvelles coordonnées et valeurs par défaut s’appliqueront aux prochains documents." : editingInvoice || editingCredit || editingPayment ? "Les changements restent sans effet comptable jusqu’à la comptabilisation." : "Enregistrez d’abord, puis vérifiez avant toute comptabilisation."}</span>
              </div>
              {activeDraftStore && (activeDraftStore.status === "saved" || activeDraftStore.status === "saving" || activeDraftStore.status === "error") && (
                // Quiet confidence, not a notification per keystroke: the point
                // is that a person can leave the form without wondering.
                <span className="op-draft-state" data-state={activeDraftStore.status} role="status" aria-live="polite">
                  {activeDraftStore.status === "saving"
                    ? "Enregistrement…"
                    : activeDraftStore.status === "error"
                      ? "Brouillon non enregistré"
                      : "Brouillon conservé"}
                </span>
              )}
              <button type="button" className="op-icon-button" onClick={closeComposer} aria-label="Fermer le formulaire"><X size={17} /></button>
            </div>

            {composer === "invoice" && (
              <form className="op-form-grid" onSubmit={submitInvoice}>
                <label className="op-field op-field--wide"><span>Tiers</span>
                  <WheatSelect
                    required
                    ariaLabel="Tiers de la facture"
                    placeholder="Sélectionner un tiers"
                    searchPlaceholder="Nom, ICE ou ville…"
                    noOptionsLabel="Aucun tiers enregistré dans ce dossier"
                    value={invoiceDraft.counterpartyId}
                    onChange={(value) => setInvoiceDraft((current) => ({ ...current, counterpartyId: value }))}
                    options={eligibleInvoiceCounterparties.map((counterparty): WheatSelectOption => ({
                      value: String(counterparty.id),
                      label: String(counterparty.displayName ?? ""),
                      note: [counterparty.ice, counterparty.city].filter(Boolean).join(" · ") || undefined,
                      keywords: `${counterparty.ice ?? ""} ${counterparty.legalName ?? ""}`,
                    }))}
                  />
                </label>
                <label className="op-field"><span>N° de facture {tab === "sales" && <em>auto si vide</em>}</span>
                  <input required={tab === "purchases"} value={invoiceDraft.invoiceNo} onChange={(event) => setInvoiceDraft((current) => ({ ...current, invoiceNo: event.target.value }))} placeholder={tab === "sales" ? "Attribué à la comptabilisation" : "FR-2026-…"} />
                </label>
                <label className="op-field"><span>Date</span><input type="date" required value={invoiceDraft.invoiceDate} onChange={(event) => setInvoiceDraft((current) => ({ ...current, invoiceDate: event.target.value }))} /></label>
                <label className="op-field"><span>Échéance</span><input type="date" required value={invoiceDraft.dueDate} onChange={(event) => setInvoiceDraft((current) => ({ ...current, dueDate: event.target.value }))} /></label>
                <label className="op-field op-field--wide"><span>Configuration TVA versionnée <em>requise si TVA</em></span><WheatSelect
                  ariaLabel="Configuration TVA versionnée"
                  placeholder="Aucune TVA / règle non applicable"
                  searchPlaceholder="Nom ou révision…"
                  allowClear
                  noOptionsLabel="Aucune configuration TVA active"
                  value={invoiceDraft.taxConfigurationVersionId}
                  onChange={(value) => setInvoiceDraft((current) => ({ ...current, taxConfigurationVersionId: value, lines: current.lines.map((line) => ({ ...line, taxRateDefinitionId: undefined, vatRateBps: undefined, vat: "0.00" })) }))}
                  options={activeTaxConfigurations.map((configuration): WheatSelectOption => ({
                    value: String(configuration.id),
                    label: `${configuration.name} · révision ${configuration.revision}`,
                    note: `${formatDate(configuration.effectiveFrom)} → ${configuration.effectiveTo ? formatDate(configuration.effectiveTo) : "sans fin"}`,
                  }))}
                /></label>
                <div className="op-line-editor">
                  <div className="op-line-editor__head"><div><strong>Lignes de facture</strong><span>Chaque ligne conserve son montant exact en centimes.</span></div><button type="button" className="op-text-action" onClick={() => setInvoiceDraft((current) => ({ ...current, lines: [...current.lines, newInvoiceLineDraft()] }))}><Plus size={14} /> Ajouter une ligne</button></div>
                  {invoiceDraft.lines.map((line, index) => (
                    <div className="op-line-editor__row" key={line.key}>
                      <span className="op-line-index">{index + 1}</span>
                      <label className="op-field op-field--line-description"><span>Libellé</span><input required value={line.description} onChange={(event) => setInvoiceDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, description: event.target.value } : item) }))} placeholder="Produit ou service facturé" /></label>
                      <label className="op-field op-field--line-account"><span>Compte de produit / charge</span><WheatSelect
                        required
                        ariaLabel="Compte de produit ou de charge"
                        placeholder="Sélectionner un compte"
                        searchPlaceholder="Numéro ou libellé du compte…"
                        noOptionsLabel="Aucun compte disponible"
                        value={line.accountId}
                        onChange={(value) => setInvoiceDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, accountId: value } : item) }))}
                        options={entryAccounts.map((account): WheatSelectOption => ({
                          value: String(account.id),
                          label: `${account.code} — ${account.label}`,
                          note: `Classe ${account.classNo}`,
                          keywords: String(account.label ?? ""),
                          group: `Classe ${account.classNo}`,
                        }))}
                      /></label>
                      <label className="op-field"><span>Règle TVA</span><WheatSelect
                        ariaLabel="Règle de TVA de la ligne"
                        placeholder="Exonérée / hors champ"
                        searchPlaceholder="Code ou taux…"
                        allowClear
                        disabled={!invoiceDraft.taxConfigurationVersionId}
                        noOptionsLabel="Aucun taux applicable"
                        value={line.taxRateDefinitionId ?? ""}
                        onChange={(value) => {
                          const rate = applicableTaxRates.find((item: LooseRecord) => item.id === value);
                          setInvoiceDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, taxRateDefinitionId: rate?.id, vatRateBps: rate?.rateBps, vat: rate ? vatDecimalForRate(item.ht || "0", rate.rateBps) : "0.00" } : item) }));
                        }}
                        options={applicableTaxRates.map((rate: LooseRecord): WheatSelectOption => ({
                          value: String(rate.id),
                          label: `${rate.code} — ${(rate.rateBps / 100).toLocaleString("fr-MA", { maximumFractionDigits: 2 })} %`,
                          note: rate.label ? String(rate.label) : undefined,
                        }))}
                      /></label>
                      <label className="op-field"><span>HT ({currency})</span><input required inputMode="decimal" value={line.ht} onChange={(event) => setInvoiceDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, ht: event.target.value, vat: item.vatRateBps === undefined ? item.vat : vatDecimalForRate(event.target.value, item.vatRateBps) } : item) }))} placeholder="0.00" /></label>
                      <label className="op-field"><span>TVA ({currency})</span><input required inputMode="decimal" readOnly={line.vatRateBps !== undefined} value={line.vat} onChange={(event) => setInvoiceDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, vat: event.target.value } : item) }))} placeholder="0.00" /></label>
                      <button type="button" className="op-icon-button op-icon-button--danger" disabled={invoiceDraft.lines.length === 1} onClick={() => setInvoiceDraft((current) => ({ ...current, lines: current.lines.filter((item) => item.key !== line.key) }))} aria-label={`Supprimer la ligne ${index + 1}`} title="Supprimer la ligne"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="op-form-total"><span>Total TTC</span><strong>{invoiceDraftTotalCents === null ? "—" : formatExactCents(invoiceDraftTotalCents, currency)}</strong></div>
                <div className="op-form-actions"><button type="button" className="op-button op-button--quiet" onClick={closeComposer}>Annuler</button><button type="submit" className="op-button op-button--primary" disabled={Boolean(busyKey?.endsWith("-invoice")) || entryAccounts.length === 0}><BusyButtonContent busy={Boolean(busyKey?.endsWith("-invoice"))}><FilePlus2 size={15} /> {editingInvoice ? "Enregistrer les modifications" : "Enregistrer le brouillon"}</BusyButtonContent></button></div>
                {entryAccounts.length === 0 && <p className="op-form-warning"><AlertTriangle size={14} /> Aucun compte de produit ou charge transmis par la page parente.</p>}
                {activeTaxConfigurations.length === 0 && <p className="op-form-warning"><AlertTriangle size={14} /> Aucune configuration TVA active. Créez et activez une version dans la page TVA avant de facturer avec taxe.</p>}
              </form>
            )}

            {composer === "credit" && (
              <form className="op-credit-form" onSubmit={submitCredit}>
                <div className="op-form-grid">
                  <label className="op-field"><span>Date de l'avoir</span><input type="date" required value={creditDraft.invoiceDate} onChange={(event) => setCreditDraft((current) => ({ ...current, invoiceDate: event.target.value }))} /></label>
                  <label className="op-field"><span>Référence {tab === "purchases" ? "fournisseur obligatoire" : "facultative"}</span><input required={tab === "purchases"} value={creditDraft.invoiceNo} onChange={(event) => setCreditDraft((current) => ({ ...current, invoiceNo: event.target.value }))} placeholder={tab === "purchases" ? "AV-FR-…" : "Attribuée à la comptabilisation"} /></label>
                  <label className="op-field op-field--wide"><span>Motif précis</span><input required maxLength={500} value={creditDraft.creditReason} onChange={(event) => setCreditDraft((current) => ({ ...current, creditReason: event.target.value }))} placeholder="Retour, remise, correction de prix…" /></label>
                </div>
                <div className="op-credit-lines">
                  <div className="op-line-editor__head"><div><strong>Lignes de la facture d'origine</strong><span>Laissez une ligne vide pour ne pas la créditer. Les plafonds sont revérifiés lors de la comptabilisation.</span></div></div>
                  {creditDraft.lines.map((line, index) => (
                    <div className="op-credit-line" key={line.key}>
                      <span className="op-line-index">{index + 1}</span>
                      <div><strong>{line.description}</strong><small>Original : {moneyFrom({ htCents: line.originalHtCents }, "htCents", "ht", currency)} HT · {moneyFrom({ vatCents: line.originalVatCents }, "vatCents", "vat", currency)} TVA</small></div>
                      <label className="op-field"><span>HT à créditer</span><input inputMode="decimal" value={line.ht} onChange={(event) => setCreditDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, ht: event.target.value } : item) }))} placeholder="0.00" /></label>
                      <label className="op-field"><span>TVA à créditer</span><input inputMode="decimal" value={line.vat} onChange={(event) => setCreditDraft((current) => ({ ...current, lines: current.lines.map((item) => item.key === line.key ? { ...item, vat: event.target.value } : item) }))} placeholder="0.00" /></label>
                    </div>
                  ))}
                </div>
                <div className="op-form-actions"><button type="button" className="op-button op-button--quiet" onClick={closeComposer}>Annuler</button><button type="submit" className="op-button op-button--primary" disabled={Boolean(busyKey?.endsWith("-credit"))}><BusyButtonContent busy={Boolean(busyKey?.endsWith("-credit"))}><FileMinus2 size={15} /> {editingCredit ? "Enregistrer les modifications" : "Enregistrer l'avoir"}</BusyButtonContent></button></div>
              </form>
            )}

            {composer === "payment" && (
              <form className="op-form-grid" onSubmit={submitPayment}>
                <label className="op-field"><span>Sens</span><select value={paymentDraft.kind} onChange={(event) => setPaymentDraft((current) => ({ ...current, kind: event.target.value as PaymentDraft["kind"], counterpartyId: "", allocations: [] }))}><option value="RECEIPT">Encaissement client</option><option value="DISBURSEMENT">Décaissement fournisseur</option></select></label>
                <label className="op-field op-field--wide"><span>Tiers</span><WheatSelect
                  required
                  ariaLabel="Tiers du règlement"
                  placeholder="Sélectionner un tiers"
                  searchPlaceholder="Nom, ICE ou ville…"
                  noOptionsLabel="Aucun tiers correspondant"
                  value={paymentDraft.counterpartyId}
                  onChange={(value) => setPaymentDraft((current) => ({ ...current, counterpartyId: value, allocations: [] }))}
                  options={activeCounterparties
                    .filter((counterparty) => counterparty.kind === "BOTH" || counterparty.kind === (paymentDraft.kind === "RECEIPT" ? "CUSTOMER" : "SUPPLIER"))
                    .map((counterparty): WheatSelectOption => ({
                      value: String(counterparty.id),
                      label: String(counterparty.displayName ?? ""),
                      note: [counterparty.ice, counterparty.city].filter(Boolean).join(" · ") || undefined,
                      keywords: String(counterparty.ice ?? ""),
                    }))}
                /></label>
                <label className="op-field"><span>Date</span><input type="date" required value={paymentDraft.paymentDate} onChange={(event) => setPaymentDraft((current) => ({ ...current, paymentDate: event.target.value }))} /></label>
                <label className="op-field"><span>Montant ({currency})</span><input required inputMode="decimal" value={paymentDraft.amount} onChange={(event) => setPaymentDraft((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" /></label>
                <label className="op-field"><span>Mode</span><select value={paymentDraft.method} onChange={(event) => setPaymentDraft((current) => ({ ...current, method: event.target.value }))}><option>Virement</option><option>Chèque</option><option>Prélèvement</option><option>Espèces</option><option>Carte</option></select></label>
                <label className="op-field"><span>Référence</span><input value={paymentDraft.reference} onChange={(event) => setPaymentDraft((current) => ({ ...current, reference: event.target.value }))} placeholder="VIR-…" /></label>
                <label className="op-field op-field--wide"><span>Compte bancaire</span><WheatSelect
                  ariaLabel="Compte bancaire du règlement"
                  placeholder="Autre compte de règlement"
                  searchPlaceholder="Banque ou IBAN…"
                  allowClear
                  noOptionsLabel="Aucun compte bancaire configuré"
                  value={paymentDraft.bankAccountId}
                  onChange={(value) => setPaymentDraft((current) => ({ ...current, bankAccountId: value }))}
                  options={bankAccounts.map((bank): WheatSelectOption => ({
                    value: String(bank.id),
                    label: String(bank.bankName ?? ""),
                    note: bank.iban ? String(bank.iban) : undefined,
                    keywords: String(bank.iban ?? ""),
                  }))}
                /></label>
                <div className="op-allocation-editor">
                  <div className="op-line-editor__head"><div><strong>Imputations</strong><span>Facultatif · le total ne peut pas dépasser le paiement.</span></div><button type="button" className="op-text-action" disabled={!paymentDraft.counterpartyId || eligiblePaymentInvoices.length === 0} onClick={() => setPaymentDraft((current) => ({ ...current, allocations: [...current.allocations, { key: draftKey("payment-allocation"), invoiceId: "", amount: current.allocations.length ? "" : current.amount }] }))}><Plus size={14} /> Ajouter</button></div>
                  {paymentDraft.allocations.length ? paymentDraft.allocations.map((allocation, index) => (
                    <div className="op-allocation-editor__row" key={allocation.key}>
                      <span className="op-line-index">{index + 1}</span>
                      <label className="op-field"><span>Facture</span><WheatSelect
                        required
                        ariaLabel="Facture à solder"
                        placeholder="Sélectionner une facture"
                        searchPlaceholder="Numéro de facture…"
                        noOptionsLabel="Aucune facture à solder pour ce tiers"
                        value={allocation.invoiceId}
                        onChange={(value) => setPaymentDraft((current) => ({ ...current, allocations: current.allocations.map((item) => item.key === allocation.key ? { ...item, invoiceId: value } : item) }))}
                        options={eligiblePaymentInvoices
                          .filter((invoice) => invoice.id === allocation.invoiceId || !paymentDraft.allocations.some((item) => item.invoiceId === invoice.id))
                          .map((invoice): WheatSelectOption => ({
                            value: String(invoice.id),
                            label: String(invoice.invoiceNo ?? ""),
                            note: `Reste dû ${moneyFrom(invoice.settlement, "balanceCents", "balance", invoice.currency ?? currency)}`,
                          }))}
                      /></label>
                      <label className="op-field"><span>Montant imputé ({currency})</span><input required inputMode="decimal" value={allocation.amount} onChange={(event) => setPaymentDraft((current) => ({ ...current, allocations: current.allocations.map((item) => item.key === allocation.key ? { ...item, amount: event.target.value } : item) }))} placeholder="0.00" /></label>
                      <button type="button" className="op-icon-button op-icon-button--danger" onClick={() => setPaymentDraft((current) => ({ ...current, allocations: current.allocations.filter((item) => item.key !== allocation.key) }))} aria-label={`Supprimer l’imputation ${index + 1}`} title="Supprimer l’imputation"><Trash2 size={14} /></button>
                    </div>
                  )) : <p className="op-allocation-editor__empty">Ce paiement restera non imputé tant qu’aucune facture n’est ajoutée.</p>}
                </div>
                <div className="op-form-actions"><button type="button" className="op-button op-button--quiet" onClick={closeComposer}>Annuler</button><button type="submit" className="op-button op-button--primary" disabled={Boolean(busyKey?.endsWith("-payment"))}><BusyButtonContent busy={Boolean(busyKey?.endsWith("-payment"))}><Banknote size={15} /> {editingPayment ? "Enregistrer les modifications" : "Enregistrer le brouillon"}</BusyButtonContent></button></div>
              </form>
            )}

            {composer === "counterparty" && (
              <form className="op-form-grid" onSubmit={submitCounterparty}>
                <label className="op-field"><span>Type</span><select value={counterpartyDraft.kind} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, kind: event.target.value as CounterpartyDraft["kind"] }))}><option value="CUSTOMER">Client</option><option value="SUPPLIER">Fournisseur</option><option value="BOTH">Client & fournisseur</option></select></label>
                <label className="op-field op-field--wide"><span>Nom affiché</span><input required value={counterpartyDraft.displayName} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="Raison sociale ou nom" /></label>
                <label className="op-field"><span>Raison sociale <em>facultatif</em></span><input value={counterpartyDraft.legalName} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, legalName: event.target.value }))} /></label>
                <label className="op-field"><span>ICE</span><input value={counterpartyDraft.ice} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, ice: event.target.value }))} /></label>
                <label className="op-field"><span>Identifiant fiscal</span><input value={counterpartyDraft.taxId} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, taxId: event.target.value }))} /></label>
                <label className="op-field"><span>E-mail</span><input type="email" value={counterpartyDraft.email} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, email: event.target.value }))} /></label>
                <label className="op-field"><span>Téléphone</span><input type="tel" value={counterpartyDraft.phone} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, phone: event.target.value }))} /></label>
                <label className="op-field op-field--wide"><span>Adresse</span><input value={counterpartyDraft.address} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, address: event.target.value }))} /></label>
                <label className="op-field"><span>Ville</span><input value={counterpartyDraft.city} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, city: event.target.value }))} /></label>
                <label className="op-field"><span>Délai de paiement</span><input type="number" required min="0" max="3650" step="1" value={counterpartyDraft.paymentTermsDays} onChange={(event) => setCounterpartyDraft((current) => ({ ...current, paymentTermsDays: event.target.value }))} /></label>
                {(counterpartyDraft.kind === "CUSTOMER" || counterpartyDraft.kind === "BOTH") && <label className="op-field op-field--wide"><span>Compte client par défaut <em>facultatif</em></span><WheatSelect
                  ariaLabel="Compte client par défaut"
                  placeholder="Utiliser 342100"
                  searchPlaceholder="Numéro ou libellé du compte…"
                  allowClear
                  noOptionsLabel="Aucun compte client disponible"
                  value={counterpartyDraft.defaultReceivableAccountId}
                  onChange={(value) => setCounterpartyDraft((current) => ({ ...current, defaultReceivableAccountId: value }))}
                  options={receivableAccountOptions.map((account): WheatSelectOption => ({
                    value: String(account.id),
                    label: `${account.code} — ${account.label}`,
                    keywords: String(account.label ?? ""),
                  }))}
                /></label>}
                {(counterpartyDraft.kind === "SUPPLIER" || counterpartyDraft.kind === "BOTH") && <label className="op-field op-field--wide"><span>Compte fournisseur par défaut <em>facultatif</em></span><WheatSelect
                  ariaLabel="Compte fournisseur par défaut"
                  placeholder="Utiliser 441100"
                  searchPlaceholder="Numéro ou libellé du compte…"
                  allowClear
                  noOptionsLabel="Aucun compte fournisseur disponible"
                  value={counterpartyDraft.defaultPayableAccountId}
                  onChange={(value) => setCounterpartyDraft((current) => ({ ...current, defaultPayableAccountId: value }))}
                  options={payableAccountOptions.map((account): WheatSelectOption => ({
                    value: String(account.id),
                    label: `${account.code} — ${account.label}`,
                    keywords: String(account.label ?? ""),
                  }))}
                /></label>}
                <div className="op-form-actions"><button type="button" className="op-button op-button--quiet" onClick={closeComposer}>Annuler</button><button type="submit" className="op-button op-button--primary" disabled={Boolean(busyKey?.endsWith("-counterparty"))}><BusyButtonContent busy={Boolean(busyKey?.endsWith("-counterparty"))}>{editingCounterparty ? <Pencil size={15} /> : <UserRoundPlus size={15} />} {editingCounterparty ? "Enregistrer les modifications" : "Créer le tiers"}</BusyButtonContent></button></div>
              </form>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="op-table-wrap">
        {loading ? (
          <div className="op-loading"><LoaderCircle className="op-spin" size={20} /> Chargement du sous-livre…</div>
        ) : (tab === "sales" || tab === "purchases") ? (
          displayedInvoices.length ? (
            <table className="op-table">
              <thead><tr><th>Facture</th><th>Tiers</th><th>Date</th><th>Échéance</th><th className="op-number">TTC</th><th className="op-number">Solde</th><th>État</th><th aria-label="Actions" /></tr></thead>
              <tbody>{displayedInvoices.map((invoice) => {
                const lifecycle = invoice.lifecycleStatus;
                const isCredit = invoice.documentType === "CREDIT_NOTE";
                const settlementStatus = invoice.settlement?.settlementStatus ?? invoice.status ?? lifecycle;
                return (
                  <tr key={invoice.id} className={lifecycle === "LEGACY" || invoice.needsReview ? "is-review" : ""}>
                    <td><strong className="op-primary-cell">{isCredit ? "Avoir " : ""}{invoice.invoiceNo}</strong>{invoice.postedEntry?.number && <small>{invoice.postedEntry.number}</small>}</td>
                    <td>{invoice.counterpartyNameSnapshot || invoice.counterparty || "Tiers non rapproché"}{invoice.iceSnapshot && <small>ICE {invoice.iceSnapshot}</small>}</td>
                    <td>{formatDate(invoice.invoiceDate)}</td><td>{formatDate(invoice.dueDate)}</td>
                    <td className="op-number"><strong>{moneyFrom(invoice, "ttcCents", "ttc", invoice.currency ?? currency)}</strong></td>
                    <td className="op-number">{moneyFrom(invoice.settlement, "balanceCents", "balance", invoice.currency ?? currency)}</td>
                    <td><StatusBadge status={lifecycle === "LEGACY" ? "LEGACY" : settlementStatus} /></td>
                    <td className="op-row-actions">
                      {lifecycle === "DRAFT" ? <div className="op-row-action-group">
                        {!isCredit && <button type="button" className="op-icon-button" disabled={Boolean(busyKey)} onClick={() => openInvoiceComposer(invoice)} title="Modifier le brouillon" aria-label={`Modifier la facture ${invoice.invoiceNo}`}><Pencil size={14} /></button>}
                        {isCredit && <button type="button" className="op-icon-button" disabled={Boolean(busyKey)} onClick={() => {
                          const loadedOriginal = invoices.find((item) => item.id === invoice.creditedInvoiceId);
                          const projectedLines = (invoice.lines ?? []).map((line: LooseRecord) => line.creditedInvoiceLine).filter(Boolean);
                          const projectedOriginal = invoice.creditedInvoice && projectedLines.length ? { ...invoice.creditedInvoice, kind: invoice.kind, lines: projectedLines } as InvoiceRecord : null;
                          const original = loadedOriginal ?? projectedOriginal;
                          if (original) openCreditComposer(original, invoice);
                          else notify("Chargez la facture d'origine pour modifier cet avoir.", "warning");
                        }} title="Modifier l'avoir"><Pencil size={14} /></button>}
                        <button type="button" className="op-icon-button op-icon-button--danger" disabled={Boolean(busyKey)} onClick={() => requestConfirmation({ type: "delete-invoice", record: invoice })} title="Supprimer le brouillon" aria-label={`Supprimer le document ${invoice.invoiceNo}`}><Trash2 size={14} /></button>
                        <button type="button" className="op-text-action" disabled={Boolean(busyKey)} onClick={() => requestConfirmation({ type: isCredit ? "post-credit" : "post-invoice", record: invoice })}>Comptabiliser <ChevronRight size={14} /></button>
                      </div> : lifecycle === "POSTED" ? <div className="op-row-action-group">
                        {invoice.artifactRequired && <button type="button" className="op-icon-button" disabled={busyKey === `artifact-${invoice.id}`} onClick={() => void exportVerifiedArtifact(invoice)} title="Vérifier et exporter le PDF"><FileDown size={14} /></button>}
                        {!isCredit && <button type="button" className="op-text-action" onClick={() => openCreditComposer(invoice)}><FileMinus2 size={14} /> Créer un avoir</button>}
                        {!isCredit && !invoice.artifactRequired && <button type="button" className="op-text-action op-text-action--danger" onClick={() => requestConfirmation({ type: "void-invoice", record: invoice })}><RotateCcw size={14} /> Annuler</button>}
                        {isCredit && <span className="op-row-no-action">Correction liée requise</span>}
                      </div> : <span className="op-row-no-action">Historique</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          ) : <EmptyState icon={<FilePlus2 size={22} />} title="Aucune facture dans cette vue" detail={query && activePage.hasMore ? "Aucune correspondance dans les pages chargées. Chargez la suite pour poursuivre la recherche." : "Créez un brouillon ou modifiez votre recherche."} />
        ) : tab === "payments" ? (
          displayedPayments.length ? (
            <table className="op-table">
              <thead><tr><th>Référence</th><th>Tiers</th><th>Date</th><th>Sens</th><th className="op-number">Montant</th><th>Imputation</th><th>État</th><th aria-label="Actions" /></tr></thead>
              <tbody>{displayedPayments.map((payment) => {
                const activeAllocations = (payment.allocations ?? []).filter((allocation) => allocation.status === "ACTIVE");
                const showAllocations = expandedPaymentId === payment.id && (payment.allocations?.length ?? 0) > 0;
                return <Fragment key={payment.id}>
                  <tr>
                    <td><strong className="op-primary-cell">{payment.reference || `PAY-${payment.id.slice(0, 8)}`}</strong>{payment.postedEntry?.number && <small>{payment.postedEntry.number}</small>}</td>
                    <td>{payment.counterparty?.displayName ?? "—"}</td><td>{formatDate(payment.paymentDate)}</td>
                    <td><span className="op-direction">{payment.kind === "RECEIPT" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{payment.kind === "RECEIPT" ? "Encaissement" : "Décaissement"}</span></td>
                    <td className="op-number"><strong>{moneyFrom(payment, "amountCents", "amount", payment.currency ?? currency)}</strong></td>
                    <td>{activeAllocations.length} facture(s)</td>
                    <td><StatusBadge status={payment.lifecycleStatus} /></td>
                    <td className="op-row-actions">
                      {payment.lifecycleStatus === "DRAFT" ? <div className="op-row-action-group">
                        <button type="button" className="op-icon-button" disabled={Boolean(busyKey)} onClick={() => openPaymentComposer(payment)} title="Modifier le brouillon" aria-label={`Modifier le paiement ${payment.reference || payment.id}`}><Pencil size={14} /></button>
                        <button type="button" className="op-icon-button op-icon-button--danger" disabled={Boolean(busyKey)} onClick={() => requestConfirmation({ type: "delete-payment", record: payment })} title="Supprimer le brouillon" aria-label={`Supprimer le paiement ${payment.reference || payment.id}`}><Trash2 size={14} /></button>
                        <button type="button" className="op-text-action" disabled={Boolean(busyKey)} onClick={() => requestConfirmation({ type: "post-payment", record: payment })}>Comptabiliser <ChevronRight size={14} /></button>
                      </div> : payment.lifecycleStatus === "POSTED" ? <div className="op-row-action-group">
                        {(payment.allocations?.length ?? 0) > 0 && <button type="button" className={`op-text-action ${showAllocations ? "is-active" : ""}`} onClick={() => setExpandedPaymentId(showAllocations ? "" : payment.id)}>{showAllocations ? "Masquer" : "Imputations"}</button>}
                        <button type="button" className="op-text-action op-text-action--danger" onClick={() => requestConfirmation({ type: "void-payment", record: payment })}><RotateCcw size={14} /> Annuler</button>
                      </div> : <span className="op-row-no-action">Historique</span>}
                    </td>
                  </tr>
                  {showAllocations && <tr className="op-allocation-history-row"><td colSpan={8}><div className="op-allocation-history"><div className="op-allocation-history__head"><strong>Historique des imputations</strong><span>Une annulation conserve le montant et la facture d’origine.</span></div>{payment.allocations?.map((allocation) => <div className="op-allocation-history__item" key={allocation.id}><span><strong>{allocation.invoice?.invoiceNo ?? "Facture"}</strong><small>{formatDate(allocation.createdAt)} · {moneyFrom(allocation, "amountCents", "amount", payment.currency ?? currency)}</small></span><StatusBadge status={allocation.status} />{allocation.status === "ACTIVE" && <button type="button" className="op-text-action op-text-action--danger" onClick={() => requestConfirmation({ type: "reverse-allocation", record: payment, allocation })}><RotateCcw size={13} /> Annuler l’imputation</button>}</div>)}</div></td></tr>}
                </Fragment>;
              })}</tbody>
            </table>
          ) : <EmptyState icon={<CircleDollarSign size={22} />} title="Aucun paiement dans cette vue" detail={query && activePage.hasMore ? "Aucune correspondance dans les pages chargées. Chargez la suite pour poursuivre la recherche." : "Créez un brouillon de paiement pour suivre son imputation."} />
        ) : displayedCounterparties.length ? (
          <table className="op-table">
            <thead><tr><th>Tiers</th><th>Type</th><th>ICE / IF</th><th>Ville</th><th className="op-number">Factures</th><th className="op-number">Paiements</th><th>État</th><th aria-label="Actions" /></tr></thead>
            <tbody>{displayedCounterparties.map((counterparty) => (
              <tr key={counterparty.id} className={!counterparty.active ? "is-muted" : ""}>
                <td><strong className="op-primary-cell">{counterparty.displayName}</strong>{counterparty.email && <small>{counterparty.email}</small>}</td>
                <td>{counterparty.kind === "BOTH" ? "Client & fournisseur" : counterparty.kind === "CUSTOMER" ? "Client" : "Fournisseur"}</td>
                <td>{counterparty.ice || counterparty.taxId || "—"}</td><td>{counterparty.city || "—"}</td>
                <td className="op-number">{counterparty._count?.invoices ?? 0}</td><td className="op-number">{counterparty._count?.payments ?? 0}</td>
                <td><StatusBadge status={counterparty.active ? "ACTIVE" : "ARCHIVED"} /></td>
                <td className="op-row-actions">{counterparty.active ? <div className="op-row-action-group"><button type="button" className="op-icon-button" onClick={() => openCounterpartyComposer(counterparty)} title="Modifier le tiers" aria-label={`Modifier ${counterparty.displayName}`}><Pencil size={14} /></button><button type="button" className="op-icon-button" onClick={() => requestConfirmation({ type: "archive-counterparty", record: counterparty })} title="Archiver le tiers" aria-label={`Archiver ${counterparty.displayName}`}><Archive size={15} /></button></div> : <button type="button" className="op-text-action" onClick={() => requestConfirmation({ type: "restore-counterparty", record: counterparty })}><RotateCcw size={14} /> Restaurer</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <EmptyState icon={<UsersRound size={22} />} title="Aucun tiers dans cette vue" detail={query && activePage.hasMore ? "Aucune correspondance dans les pages chargées. Chargez la suite pour poursuivre la recherche." : "Créez un client, un fournisseur ou un tiers mixte."} />}
      </div>

      {!loading && (
        <div className="op-pagination" aria-live="polite">
          <div className="op-pagination__copy">
            <strong>{activeLoadedCount} élément{activeLoadedCount > 1 ? "s" : ""} chargé{activeLoadedCount > 1 ? "s" : ""} sur {activePage.totalCount}</strong>
            <span>{activePage.hasMore ? "La liste continue. Chargez une page pour étendre aussi la recherche et les choix des formulaires." : activePage.totalCount > 0 ? "Fin de la liste — toutes les lignes sont chargées." : "La liste est vide."}</span>
          </div>
          {activePage.hasMore && (
            <button type="button" className="op-button op-button--quiet op-pagination__button" onClick={() => void loadMoreForActiveTab()} disabled={loadingMore !== null}>
              {loadingMore === tab ? <LoaderCircle size={14} className="op-spin" /> : <ChevronRight size={14} />}
              Charger {Math.min(activePage.limit, Math.max(activePage.totalCount - activeLoadedCount, 1))} de plus
            </button>
          )}
        </div>
      )}

      <AnimatePresence>
        {confirmAction && (() => {
          const copy = confirmationCopy(confirmAction);
          const needsReason = ["void-invoice", "void-payment", "reverse-allocation"].includes(confirmAction.type);
          const needsDate = ["void-invoice", "void-payment", "reverse-allocation"].includes(confirmAction.type);
          const confirmDisabled = Boolean(busyKey) || (needsReason && !actionReason.trim()) || (needsDate && !actionDate);
          return <motion.div className="op-confirm-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busyKey) closeConfirmation(); }}>
            <motion.div ref={confirmationDialogRef} className={`op-confirm-strip ${copy.danger ? "op-confirm-strip--danger" : ""} ${needsReason ? "op-confirm-strip--form" : ""}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} role="alertdialog" aria-modal="true" aria-labelledby="operational-confirm-title" tabIndex={-1}>
              <div className="op-confirm-strip__icon">{copy.danger ? (confirmAction.type.startsWith("delete") ? <Trash2 size={18} /> : <RotateCcw size={18} />) : confirmAction.type === "archive-counterparty" ? <Archive size={18} /> : <ShieldCheck size={18} />}</div>
              <div className="op-confirm-strip__copy">
                <strong id="operational-confirm-title">{copy.title}</strong>
                <span>{copy.detail}</span>
                {needsReason && <div className="op-confirm-strip__fields">
                  <label className="op-field"><span>Motif obligatoire</span><input data-autofocus value={actionReason} onChange={(event) => setActionReason(event.target.value)} maxLength={500} placeholder="Décrivez la raison de l’annulation" /></label>
                  {needsDate && <label className="op-field"><span>Date de contrepassation</span><input type="date" required value={actionDate} onChange={(event) => setActionDate(event.target.value)} /></label>}
                </div>}
              </div>
              <div className="op-confirm-strip__actions">
                <button type="button" className="op-button op-button--quiet" onClick={closeConfirmation} disabled={Boolean(busyKey)}>Retour</button>
                <button type="button" className={`op-button ${copy.danger ? "op-button--danger" : "op-button--primary"}`} onClick={() => void executeConfirmedAction()} disabled={confirmDisabled}><BusyButtonContent busy={Boolean(busyKey)}>{copy.danger ? <RotateCcw size={15} /> : <Check size={15} />} {copy.confirmLabel}</BusyButtonContent></button>
              </div>
            </motion.div>
          </motion.div>;
        })()}
      </AnimatePresence>
    </section>
  );
}

type InspectorIntent =
  | { type: "confirm"; line: CandidateLine; amountCents: string; paymentEvidence: Array<{ paymentId: string; amountCents: string }>; note: string }
  | { type: "void"; reconciliationId: string; reason: string }
  | { type: "exclude"; reason: string }
  | { type: "restore" }
  | null;

export function ReconciliationWorkbench({ companyId, initialBankAccountId, initialMovementId, openBatch, onImportStatement, onChanged, onNotify }: ReconciliationWorkbenchProps) {
  const [workspace, setWorkspace] = useState<ReconciliationWorkspace | null>(null);
  const [bankAccountId, setBankAccountId] = useState(openBatch?.bankAccountId ?? initialBankAccountId ?? "");
  const [statementId, setStatementId] = useState(openBatch?.statementId ?? "");
  const [selectedMovementId, setSelectedMovementId] = useState(initialMovementId ?? "");
  const [candidates, setCandidates] = useState<CandidateResponse | null>(null);
  const [selectedLineId, setSelectedLineId] = useState("");
  const [allocationAmount, setAllocationAmount] = useState("");
  /*
   * Payments the accountant recognises as the reason this movement exists.
   *
   * A cheque or a transfer is normally recorded when it is written, days before
   * the bank shows it. Attaching the payment to the movement is what closes that
   * gap: the reconciliation then carries both the accounting line it allocated
   * and the settlement it is evidence of, which is what makes a cheque
   * "encaissé" rather than merely "saisi".
   */
  const [evidencePaymentIds, setEvidencePaymentIds] = useState<string[]>([]);
  /*
   * Suggestions the accountant has already looked at and ruled out.
   *
   * Ranking is a guess, and a wrong guess that keeps coming back on top costs
   * more attention every time the movement is reopened. A rejection is a
   * decision about one accounting line, not an accounting fact: nothing is
   * posted from it and it is not audit-chained, so it belongs in this
   * movement's review draft alongside the note and the chosen amount — which
   * already persists per movement, per dossier, and across restarts.
   *
   * Nothing is hidden irreversibly: the count and a "Réafficher" control are
   * always on screen while any rejection is in force.
   */
  const [rejectedLineIds, setRejectedLineIds] = useState<string[]>([]);
  /** Reaches a correct line that scored badly; searches only what was loaded. */
  const [candidateQuery, setCandidateQuery] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("OPEN");
  const [loading, setLoading] = useState(true);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<InspectorIntent>(null);
  const workspaceRequestId = useRef(0);
  const candidateRequestId = useRef(0);
  const { notice, notify, clearNotice } = useOperationalNotice(onNotify);

  const loadWorkspace = useCallback(async (preferredMovementId?: string) => {
    const requestId = ++workspaceRequestId.current;
    candidateRequestId.current += 1;
    setCandidateLoading(false);
    const bridge = window.wheat;
    if (!bridge?.getReconciliationWorkspace) {
      if (requestId === workspaceRequestId.current) setLoading(false);
      notify("Le rapprochement bancaire nécessite l’application desktop.", "warning");
      return;
    }
    setLoading(true);
    try {
      const next = await bridge?.getReconciliationWorkspace({ companyId, includeExcluded: true });
      const normalized: ReconciliationWorkspace = {
        companyId,
        accounts: Array.isArray(next?.accounts) ? next.accounts : [],
        movements: Array.isArray(next?.movements) ? next.movements : [],
        generatedAt: next?.generatedAt,
      };
      if (requestId !== workspaceRequestId.current) return undefined;
      setWorkspace(normalized);
      setBankAccountId((current) => {
        if (current && normalized.accounts.some((account) => account.id === current)) return current;
        if (initialBankAccountId && normalized.accounts.some((account) => account.id === initialBankAccountId)) return initialBankAccountId;
        return normalized.accounts[0]?.id ?? "";
      });
      const target = preferredMovementId;
      if (target && !normalized.movements.some((movement) => movement.id === target)) {
        setSelectedMovementId("");
        setCandidates(null);
      }
      return normalized;
    } catch (error) {
      if (requestId === workspaceRequestId.current) notify(textError(error), "error");
      return undefined;
    } finally {
      if (requestId === workspaceRequestId.current) setLoading(false);
    }
  }, [companyId, initialBankAccountId, notify]);

  useEffect(() => { void loadWorkspace(initialMovementId); }, [initialMovementId, loadWorkspace]);

  /*
   * A statement import is started from this screen, so the desk is already
   * open when the person chooses to reconcile what they imported. The batch
   * is applied when it arrives rather than only at mount, which is the
   * difference between the filter working and the request being ignored.
   */
  useEffect(() => {
    if (!openBatch) return;
    setBankAccountId(openBatch.bankAccountId);
    setStatementId(openBatch.statementId);
    setStatusFilter("OPEN");
  }, [openBatch]);

  const selectedMovement = workspace?.movements.find((movement) => movement.id === selectedMovementId) ?? null;

  /*
   * The reading of one bank movement, kept until it is settled.
   *
   * Reconciling is interrupted work by nature: the amount to allocate is often
   * found by opening the invoice, and the reason for excluding a movement is
   * usually written after checking something else. The chosen line, the amount,
   * the note and the reason were held in component state, so any of that
   * checking discarded them.
   *
   * The draft is keyed by the movement, so unfinished thinking about one
   * movement can never appear against another.
   */
  const reviewDraft = useDraftedForm({
    companyId,
    entity: "reconciliation.review",
    draftKey: selectedMovementId || "none",
    open: Boolean(selectedMovementId),
    value: { selectedLineId, allocationAmount, evidencePaymentIds, rejectedLineIds, note, reason },
    onRestore: (payload) => {
      if (typeof payload.selectedLineId === "string") setSelectedLineId(payload.selectedLineId);
      if (typeof payload.allocationAmount === "string") setAllocationAmount(payload.allocationAmount);
      if (Array.isArray(payload.evidencePaymentIds)) setEvidencePaymentIds(payload.evidencePaymentIds.filter((item): item is string => typeof item === "string"));
      if (Array.isArray(payload.rejectedLineIds)) setRejectedLineIds(payload.rejectedLineIds.filter((item): item is string => typeof item === "string"));
      if (typeof payload.note === "string") setNote(payload.note);
      if (typeof payload.reason === "string") setReason(payload.reason);
    },
  });

  const loadCandidates = useCallback(async (movement: ReconciliationMovement) => {
    const requestId = ++candidateRequestId.current;
    setSelectedMovementId(movement.id);
    setSelectedLineId("");
    setAllocationAmount("");
    setEvidencePaymentIds([]);
    setRejectedLineIds([]);
    setCandidateQuery("");
    setNote("");
    setReason("");
    setIntent(null);
    if (movement.reconciliation.status === "EXCLUDED") {
      setCandidates({ movement, entryLines: [], paymentEvidence: [] });
      setCandidateLoading(false);
      return;
    }
    const bridge = window.wheat;
    if (!bridge?.getReconciliationCandidates) return;
    setCandidateLoading(true);
    try {
      const result = await bridge?.getReconciliationCandidates({ movementId: movement.id });
      if (requestId !== candidateRequestId.current) return;
      setCandidates(result);
      if (result?.entryLines?.length) {
        setSelectedLineId(result.entryLines[0].id);
        setAllocationAmount(result.entryLines[0].suggestedCents ? centsToDecimal(result.entryLines[0].suggestedCents) : "");
      }
    } catch (error) {
      if (requestId === candidateRequestId.current) {
        setCandidates(null);
        notify(textError(error), "error");
      }
    } finally {
      if (requestId === candidateRequestId.current) setCandidateLoading(false);
    }
  }, [notify]);

  const filteredMovements = useMemo(() => (workspace?.movements ?? []).filter((movement) => {
    if (bankAccountId && movement.bankAccountId !== bankAccountId) return false;
    if (statementId && String(movement.statementId ?? "") !== statementId) return false;
    if (statusFilter === "OPEN" && !["UNRECONCILED", "PARTIAL", "REVIEW_REQUIRED"].includes(movement.reconciliation.status)) return false;
    if (statusFilter !== "ALL" && statusFilter !== "OPEN" && movement.reconciliation.status !== statusFilter) return false;
    return rowMatchesSearch([movement.reference, movement.label, movement.amountCents, movement.date], query);
  }), [bankAccountId, query, statementId, statusFilter, workspace]);

  /*
   * A ruled-out line is not a selection, however it came to be selected —
   * including a restored draft landing after the candidate list has already
   * defaulted to the top-scoring row. Deriving it here means the allocation
   * form can never offer a line the list is hiding.
   */
  const selectedLine = candidates?.entryLines.find((line) => line.id === selectedLineId && !rejectedLineIds.includes(line.id)) ?? null;
  /*
   * What the list actually offers: everything loaded, minus what was ruled
   * out, minus what the search excludes. The selection is deliberately not
   * bound to this list — filtering the list is a way of looking, not a way of
   * changing one's mind, so typing a query never silently drops the line
   * somebody already chose. Rejecting one does, because that is a decision.
   */
  const allCandidates = candidates?.entryLines ?? [];
  const rejectedCount = allCandidates.filter((line) => rejectedLineIds.includes(line.id)).length;
  const visibleCandidates = useMemo(() => allCandidates.filter((line) => {
    if (rejectedLineIds.includes(line.id)) return false;
    return rowMatchesSearch([line.entry.number, line.entry.pieceNumber, line.entry.label, line.label, line.account.code, line.availableCents], candidateQuery);
  }), [allCandidates, candidateQuery, rejectedLineIds]);

  const rejectCandidate = (lineId: string) => {
    setRejectedLineIds((current) => (current.includes(lineId) ? current : [...current, lineId]));
    setIntent(null);
    if (lineId !== selectedLineId) return;
    // The chosen line is the one being ruled out, so the choice goes with it.
    const next = visibleCandidates.find((line) => line.id !== lineId) ?? null;
    setSelectedLineId(next?.id ?? "");
    setAllocationAmount(next ? centsToDecimal(next.suggestedCents) : "");
  };

  const evidenceCandidates = candidates?.paymentEvidence ?? [];
  /*
   * Evidence never exceeds the allocation it evidences — the domain refuses a
   * batch where it does, so the amounts are capped here rather than letting the
   * person compose a batch that will be rejected on confirmation. Each ticked
   * payment takes what is left of the batch, up to what the payment still has
   * available.
   */
  const evidenceAllocations = useMemo(() => {
    const batch = decimalToCents(allocationAmount);
    if (batch === null) return [] as Array<{ paymentId: string; amountCents: string }>;
    let remaining = BigInt(batch);
    const chosen: Array<{ paymentId: string; amountCents: string }> = [];
    for (const paymentId of evidencePaymentIds) {
      if (remaining <= 0n) break;
      const payment = evidenceCandidates.find((item) => String(item.id) === paymentId);
      const available = normalizeIntegerCents(payment?.availableEvidenceCents);
      if (!payment || available === null) continue;
      const take = BigInt(available) < remaining ? BigInt(available) : remaining;
      if (take <= 0n) continue;
      chosen.push({ paymentId, amountCents: take.toString() });
      remaining -= take;
    }
    return chosen;
  }, [allocationAmount, evidenceCandidates, evidencePaymentIds]);
  const selectedAccount = workspace?.accounts.find((account) => account.id === bankAccountId);
  const activeStatement = statementId
    ? (selectedAccount?.statements ?? []).find((statement: LooseRecord) => String(statement.id) === statementId) ?? null
    : null;
  const currency = selectedAccount?.currency ?? "MAD";
  /* A row belongs to its own account: the filter may be "all accounts". */
  const movementCurrency = (movement: ReconciliationMovement) =>
    workspace?.accounts.find((account) => account.id === movement.bankAccountId)?.currency ?? "MAD";
  const activeReconciliations = (selectedMovement?.reconciliations ?? []).filter((reconciliation) => reconciliation.status === "ACTIVE");

  const refreshAfterAction = async (message: string) => {
    const movementId = selectedMovementId;
    const nextWorkspace = await loadWorkspace(movementId);
    const current = nextWorkspace?.movements.find((movement) => movement.id === movementId);
    if (current && current.reconciliation.status !== "EXCLUDED") await loadCandidates(current);
    setIntent(null);
    setReason("");
    await onChanged?.();
    notify(message, "success");
  };

  const reviewConfirm = () => {
    if (!selectedMovement || !selectedLine) return notify("Sélectionnez une ligne comptable candidate.", "warning");
    const amountCents = decimalToCents(allocationAmount);
    if (amountCents === null || BigInt(amountCents) <= 0n) return notify(`Saisissez un montant positif en ${currency}, avec au plus deux décimales.`, "warning");
    if (BigInt(amountCents) > BigInt(selectedLine.availableCents) || BigInt(amountCents) > BigInt(selectedMovement.reconciliation.remainingCents)) {
      return notify("Le montant dépasse la capacité disponible de la ligne ou du mouvement.", "error");
    }
    setIntent({ type: "confirm", line: selectedLine, amountCents, paymentEvidence: evidenceAllocations, note });
  };

  const executeIntent = async () => {
    if (!intent || !selectedMovement) return;
    const bridge = window.wheat;
    setBusy(true);
    try {
      if (intent.type === "confirm") {
        if (!bridge?.confirmReconciliation) throw new Error("Confirmation de rapprochement indisponible.");
        await bridge?.confirmReconciliation({
          movementId: selectedMovement.id,
          expectedRevision: selectedMovement.revision,
          allocations: [{ entryLineId: intent.line.id, amountCents: intent.amountCents }],
          paymentEvidence: intent.paymentEvidence.length ? intent.paymentEvidence : undefined,
          note: intent.note || undefined,
        });
        await refreshAfterAction("Allocation confirmée. Le statut du mouvement a été recalculé.");
      } else if (intent.type === "void") {
        if (!bridge?.voidReconciliation) throw new Error("Annulation de rapprochement indisponible.");
        await bridge?.voidReconciliation({ reconciliationId: intent.reconciliationId, expectedRevision: selectedMovement.revision, reason: intent.reason });
        await refreshAfterAction("Lot de rapprochement annulé sans suppression de l’historique.");
      } else if (intent.type === "exclude") {
        if (!bridge?.excludeBankMovement) throw new Error("Exclusion de mouvement indisponible.");
        await bridge?.excludeBankMovement({ movementId: selectedMovement.id, expectedRevision: selectedMovement.revision, reason: intent.reason });
        await refreshAfterAction("Mouvement exclu avec motif d’audit.");
      } else {
        if (!bridge?.restoreBankMovement) throw new Error("Restauration de mouvement indisponible.");
        await bridge?.restoreBankMovement({ movementId: selectedMovement.id, expectedRevision: selectedMovement.revision });
        await refreshAfterAction("Mouvement restauré dans la file de rapprochement.");
      }
      // The movement is settled, so the working notes about it are finished
      // with. Reached only after the service confirmed the action.
      await reviewDraft.clear();
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const closeInspector = () => {
    candidateRequestId.current += 1;
    setSelectedMovementId("");
    setCandidates(null);
    setCandidateLoading(false);
    setIntent(null);
  };

  const importStatement = async () => {
    if (!bankAccountId) {
      notify("Sélectionnez un compte bancaire avant d’importer un relevé.", "warning");
      return;
    }
    if (!onImportStatement) {
      notify("L’import de relevé n’est pas disponible dans cette version de l’application.", "warning");
      return;
    }
    setImporting(true);
    try {
      await onImportStatement(bankAccountId);
      await loadWorkspace();
    } catch (error) {
      notify(textError(error), "error");
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className={`op-shell op-reconciliation ${selectedMovement ? "has-inspector" : ""}`} aria-label="Rapprochement bancaire">
      <header className="op-page-head">
        <div>
          <p className="op-kicker">Banque · rapprochement auditable</p>
          <h1>Rapprochement bancaire</h1>
          <p>Allouez chaque mouvement à une ligne bancaire comptabilisée. Les rapprochements partiels restent visibles.</p>
        </div>
        <div className="op-page-actions">
          <button type="button" className="op-button op-button--quiet" onClick={() => void loadWorkspace(selectedMovementId)} disabled={loading || importing}><RefreshCw size={15} className={loading ? "op-spin" : ""} /> Actualiser</button>
          <button type="button" className="op-button op-button--primary" onClick={() => void importStatement()} disabled={!bankAccountId || loading || importing}>
            <Upload size={15} /> {importing ? "Import…" : "Importer un relevé"}
          </button>
        </div>
      </header>

      <OperationNotice notice={notice} onClose={clearNotice} />

      {(workspace?.movements ?? []).some((movement) => movement.reconciliation.status === "REVIEW_REQUIRED") && (
        <div className="op-legacy-banner" role="status"><AlertTriangle size={18} /><div><strong>Ancien lettrage à contrôler</strong><span>Les statuts « rapproché » des versions anterieures a Wheat 2.0 n’ont pas été convertis en preuve comptable. Ouvrez chaque mouvement et confirmez une allocation réelle.</span></div></div>
      )}

      <div className="op-recon-toolbar">
        <label className="op-field op-field--bank"><span>Compte bancaire</span><WheatSelect
          ariaLabel="Compte bancaire"
          placeholder="Tous les comptes"
          searchPlaceholder="Banque ou IBAN…"
          noOptionsLabel="Aucun compte bancaire"
          value={bankAccountId}
          onChange={(value) => { setBankAccountId(value); setStatementId(""); closeInspector(); }}
          options={[
            { value: "", label: "Tous les comptes", note: "Aucune restriction" },
            ...(workspace?.accounts ?? []).map((account): WheatSelectOption => ({
              value: String(account.id),
              label: String(account.bankName ?? ""),
              note: account.iban ? String(account.iban) : undefined,
              keywords: String(account.iban ?? ""),
            })),
          ]}
        /></label>
        <label className="op-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Libellé ou référence…" /></label>
        <label className="op-compact-select"><span>État</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="OPEN">À traiter</option><option value="UNRECONCILED">Non rapproché</option><option value="PARTIAL">Partiel</option><option value="REVIEW_REQUIRED">Contrôle requis</option><option value="RECONCILED">Rapproché</option><option value="EXCLUDED">Exclu</option><option value="ALL">Tous</option></select></label>
        <span className="op-result-count">{filteredMovements.length} mouvement(s)</span>
      </div>

      {activeStatement && (
        <div className="op-batch-banner" role="status">
          <FileClock size={16} />
          <div>
            <strong>Relevé « {String(activeStatement.sourceName)} »</strong>
            <span>{filteredMovements.length} mouvement(s) affiché(s) sur les {String(activeStatement.importedCount ?? activeStatement.rowCount ?? "?")} de ce relevé.</span>
          </div>
          <button type="button" className="op-text-action" onClick={() => { setStatementId(""); closeInspector(); }}>
            Voir tout le compte
          </button>
        </div>
      )}

      {selectedAccount && (selectedAccount.statements?.length ?? 0) > 0 && (
        <section className="op-import-history" aria-label="Historique des imports bancaires">
          <div className="op-import-history__head"><span><FileClock size={16} /> Historique des imports</span><small>{selectedAccount.statements?.length} affiché(s)</small></div>
          <div className="op-import-history__list">
            {selectedAccount.statements?.map((statement) => (
              <div key={statement.id} data-testid="bank-import-history-row">
                <span><strong>{statement.sourceName}</strong><small>{formatDate(statement.importedAt)} · {statement.sourceFormat ?? "UNKNOWN"}</small></span>
                <span><strong>{statement.importedCount ?? statement.rowCount} importé(s)</strong><small>{statement.duplicateCount ?? 0} doublon(s) · {statement.errorCount ?? 0} erreur(s)</small></span>
              </div>
            ))}
          </div>
        </section>
      )}

      {selectedAccount && !selectedAccount.ledgerAccountId && (
        <div className="op-inline-warning"><AlertTriangle size={16} /><span><strong>Compte général non associé.</strong> Configurez un compte 514… avant de confirmer un rapprochement.</span></div>
      )}

      <div className="op-recon-layout">
        <div className="op-table-wrap op-recon-table-wrap">
          {loading ? <div className="op-loading"><LoaderCircle className="op-spin" size={20} /> Chargement des mouvements…</div> : filteredMovements.length ? (
            <table className="op-table op-recon-table">
              <thead><tr><th>Date</th><th>Référence</th><th>Libellé</th><th className="op-number" title="Sens du relevé bancaire : sorties du compte">Débit</th><th className="op-number" title="Sens du relevé bancaire : entrées sur le compte">Crédit</th><th className="op-number">Alloué</th><th className="op-number">Reste</th><th>État</th><th /></tr></thead>
              <tbody>{filteredMovements.map((movement) => (
                <tr key={movement.id} className={`${selectedMovementId === movement.id ? "is-selected" : ""} ${movement.reconciliation.status === "REVIEW_REQUIRED" ? "is-review" : ""}`} onClick={() => void loadCandidates(movement)}>
                  <td>{formatDate(movement.date)}</td><td><strong className="op-primary-cell">{movement.reference || "—"}</strong>{movement.statementRow && <small>Ligne {movement.statementRow}</small>}</td><td className="op-label-cell">{movement.label}</td>
                  <td className="op-number is-outflow">{statementSide(movement.amountCents) === "DEBIT" ? <strong>{statementColumnAmount(movement.amountCents, "DEBIT", movementCurrency(movement))}</strong> : <span className="op-blank-cell">—</span>}</td>
                  <td className="op-number is-inflow">{statementSide(movement.amountCents) === "CREDIT" ? <strong>{statementColumnAmount(movement.amountCents, "CREDIT", movementCurrency(movement))}</strong> : <span className="op-blank-cell">—</span>}</td>
                  <td className="op-number">{formatExactCents(movement.reconciliation.allocatedCents, currency)}</td><td className="op-number">{formatExactCents(movement.reconciliation.remainingCents, currency)}</td>
                  <td><StatusBadge status={movement.reconciliation.status} /></td><td><ChevronRight size={15} /></td>
                </tr>
              ))}</tbody>
            </table>
          ) : <EmptyState icon={<Landmark size={22} />} title="Aucun mouvement dans cette vue" detail="Changez le filtre ou importez un relevé bancaire." />}
        </div>

        <AnimatePresence>
          {selectedMovement && (
            <>
              <motion.button className="op-inspector-backdrop" type="button" aria-label="Fermer l’inspecteur" onClick={closeInspector} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
              <motion.aside className="op-inspector" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.18 }} aria-label="Inspecteur de rapprochement">
                <div className="op-inspector__head"><div><span>Mouvement sélectionné</span><strong>{selectedMovement.reference || "Sans référence"}</strong></div><button type="button" className="op-icon-button" onClick={closeInspector} aria-label="Fermer"><X size={17} /></button></div>
                <div className="op-movement-summary">
                  <div><span>{formatDate(selectedMovement.date)}</span><StatusBadge status={selectedMovement.reconciliation.status} /></div>
                  <p>{selectedMovement.label}</p>
                  <strong className={statementSide(selectedMovement.amountCents) === "DEBIT" ? "is-outflow" : "is-inflow"}>
                    {statementSide(selectedMovement.amountCents) === "DEBIT" ? "Débit" : "Crédit"} {statementColumnAmount(selectedMovement.amountCents, statementSide(selectedMovement.amountCents) ?? "CREDIT", currency)}
                  </strong>
                  <dl>
                    <div><dt>Sens du relevé</dt><dd>{statementSide(selectedMovement.amountCents) === "DEBIT" ? "Débit — sortie du compte" : "Crédit — entrée sur le compte"}</dd></div>
                    {selectedMovement.valueDate ? <div><dt>Date de valeur</dt><dd>{formatDate(selectedMovement.valueDate)}</dd></div> : null}
                    <div><dt>Alloué</dt><dd>{formatExactCents(selectedMovement.reconciliation.allocatedCents, currency)}</dd></div>
                    <div><dt>Reste à rapprocher</dt><dd>{formatExactCents(selectedMovement.reconciliation.remainingCents, currency)}</dd></div>
                    <div><dt>Révision</dt><dd>v{selectedMovement.revision}</dd></div>
                  </dl>
                </div>

                {selectedMovement.reconciliation.status === "REVIEW_REQUIRED" && <div className="op-inspector-alert"><AlertTriangle size={16} /><span>L’ancien statut n’est pas une preuve de rapprochement. Sélectionnez une ligne comptable réelle.</span></div>}

                {selectedMovement.reconciliation.status === "EXCLUDED" ? (
                  <div className="op-inspector-section">
                    <div className="op-section-title"><div><strong>Mouvement exclu</strong><span>{selectedMovement.exclusionReason || "Motif non disponible"}</span></div></div>
                    {intent?.type === "restore" ? <ConfirmationBox title="Restaurer ce mouvement ?" detail="Il reviendra dans la file à rapprocher. Aucun solde bancaire ne sera modifié." busy={busy} onCancel={() => setIntent(null)} onConfirm={() => void executeIntent()} /> : <button type="button" className="op-button op-button--primary op-button--full" onClick={() => setIntent({ type: "restore" })}><RotateCcw size={15} /> Examiner la restauration</button>}
                  </div>
                ) : (
                  <>
                    <div className="op-inspector-section">
                      <div className="op-section-title"><div><strong>Lignes comptables candidates</strong><span>Compte bancaire associé · écritures comptabilisées</span></div><small>{visibleCandidates.length}</small></div>
                      {candidateLoading ? <div className="op-loading op-loading--small"><LoaderCircle className="op-spin" size={17} /> Recherche de rapprochements possibles…</div> : allCandidates.length ? (
                        <>
                          <label className="op-search op-search--inset"><Search size={14} /><input value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="Chercher une écriture (n°, pièce, libellé, compte)…" />{candidateQuery && <button type="button" onClick={() => setCandidateQuery("")} aria-label="Effacer la recherche d’écriture"><X size={13} /></button>}</label>
                          {rejectedCount > 0 && (
                            <p className="op-candidate-rejected">
                              <span>{rejectedCount} suggestion(s) écartée(s)</span>
                              <button type="button" onClick={() => { setRejectedLineIds([]); setIntent(null); }}>Réafficher</button>
                            </p>
                          )}
                          {visibleCandidates.length ? <div className="op-candidates">{visibleCandidates.map((line) => {
                            const reasons = candidateReasonText(line);
                            return (
                              <div key={line.id} className={`op-candidate-row${selectedLineId === line.id ? " is-selected" : ""}`}>
                                <button type="button" className="op-candidate-pick" onClick={() => { setSelectedLineId(line.id); setAllocationAmount(centsToDecimal(line.suggestedCents)); setIntent(null); }}>
                                  <span className="op-radio-mark">{selectedLineId === line.id && <span />}</span>
                                  <span className="op-candidate-copy"><strong>{line.entry.number} · {line.entry.pieceNumber}</strong><small>{formatDate(line.entry.date)} · {line.label}</small><em>{line.account.code} · disponible {formatExactCents(line.availableCents, currency)}</em>{reasons && <span className="op-candidate-reasons">{reasons}</span>}</span>
                                  <span className="op-score">{line.score}%</span>
                                </button>
                                <button type="button" className="op-icon-button op-candidate-reject" onClick={() => rejectCandidate(line.id)} title={`Écarter ${String(line.entry.number ?? "cette suggestion")}`} aria-label={`Écarter la suggestion ${String(line.entry.number ?? "")}`}><X size={14} /></button>
                              </div>
                            );
                          })}</div> : <p className="op-inspector-empty">{candidateQuery ? "Aucune écriture chargée ne correspond à cette recherche." : "Toutes les suggestions ont été écartées. Réaffichez-les pour en choisir une."}</p>}
                        </>
                      ) : <p className="op-inspector-empty">Aucune ligne compatible. Vérifiez l’association du compte bancaire et les écritures comptabilisées.</p>}
                    </div>

                    {evidenceCandidates.length > 0 && selectedMovement.reconciliation.status !== "RECONCILED" && (
                      <div className="op-inspector-section">
                        <div className="op-section-title"><div><strong>Règlements correspondants</strong><span>Chèques, virements et espèces déjà saisis, non encore rapprochés</span></div><small>{evidenceCandidates.length}</small></div>
                        <div className="op-candidates op-evidence">
                          {evidenceCandidates.map((payment) => {
                            const paymentId = String(payment.id);
                            const checked = evidencePaymentIds.includes(paymentId);
                            const retained = evidenceAllocations.find((item) => item.paymentId === paymentId);
                            return (
                              <label key={paymentId} className={checked ? "is-selected" : ""}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(event) => {
                                    setEvidencePaymentIds((current) => (event.target.checked ? [...current, paymentId] : current.filter((item) => item !== paymentId)));
                                    setIntent(null);
                                  }}
                                />
                                <span className="op-candidate-copy">
                                  <strong>{String(payment.method ?? "Règlement")}{payment.reference ? ` · ${String(payment.reference)}` : ""}</strong>
                                  <small>{formatDate(payment.paymentDate)} · {String((payment.counterparty as LooseRecord | undefined)?.name ?? "Tiers non nommé")}</small>
                                  <em>disponible {formatExactCents(payment.availableEvidenceCents, currency)}{retained ? ` · retenu ${formatExactCents(retained.amountCents, currency)}` : ""}</em>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <p className="op-inspector-hint">
                          Rattacher un règlement rapproche le chèque ou le virement de son mouvement bancaire. Le montant retenu ne dépasse jamais l’allocation comptable ci-dessous.
                        </p>
                      </div>
                    )}

                    {selectedLine && selectedMovement.reconciliation.status !== "RECONCILED" && (
                      <div className="op-inspector-section op-allocation-form">
                        {/* Named here because the search box above can hide the chosen row. */}
                        <p className="op-allocation-target">Ligne retenue · <strong>{String(selectedLine.entry.number ?? "")}</strong> · {selectedLine.label}</p>
                        <label className="op-field"><span>Montant à allouer ({currency})</span><input inputMode="decimal" value={allocationAmount} onChange={(event) => { setAllocationAmount(event.target.value); setIntent(null); }} placeholder="0.00" /></label>
                        <div className="op-cent-preview"><span>Montant exact</span><strong>{decimalToCents(allocationAmount) ? formatExactCents(decimalToCents(allocationAmount), currency) : "—"}</strong></div>
                        <label className="op-field"><span>Note d’audit <em>facultatif</em></span><textarea rows={2} value={note} onChange={(event) => { setNote(event.target.value); setIntent(null); }} placeholder="Justification ou référence complémentaire" /></label>
                        {intent?.type === "confirm" ? <ConfirmationBox title="Confirmer cette allocation ?" detail={`${formatExactCents(intent.amountCents, currency)} sera affecté à ${intent.line.entry.number}${intent.paymentEvidence.length ? `, avec ${intent.paymentEvidence.length} règlement(s) rattaché(s) comme preuve` : ""}. Cette opération crée un lot de rapprochement auditable.`} busy={busy} onCancel={() => setIntent(null)} onConfirm={() => void executeIntent()} /> : <button type="button" className="op-button op-button--primary op-button--full" onClick={reviewConfirm}><ShieldCheck size={15} /> Examiner l’allocation</button>}
                      </div>
                    )}

                    {activeReconciliations.length > 0 && (
                      <div className="op-inspector-section">
                        <div className="op-section-title"><div><strong>Lots actifs</strong><span>L’annulation conserve chaque allocation.</span></div><small>{activeReconciliations.length}</small></div>
                        <div className="op-active-batches">{activeReconciliations.map((reconciliation) => (
                          <div key={reconciliation.id}><span><strong>{formatDate(reconciliation.confirmedAt)}</strong><small>{(reconciliation.allocations ?? []).length} ligne(s) · {formatExactCents((reconciliation.allocations ?? []).reduce((sum: bigint, item: LooseRecord) => sum + BigInt(item.amountCents), 0n).toString(), currency)}</small></span><button type="button" className="op-icon-button op-icon-button--danger" onClick={() => { setReason(""); setIntent({ type: "void", reconciliationId: reconciliation.id, reason: "" }); }} title="Annuler ce lot"><XCircle size={16} /></button></div>
                        ))}</div>
                        {intent?.type === "void" && <div className="op-reason-box"><label className="op-field"><span>Motif d’annulation</span><textarea autoFocus rows={2} value={reason} onChange={(event) => { setReason(event.target.value); setIntent({ ...intent, reason: event.target.value }); }} /></label><ConfirmationBox title="Annuler ce lot ?" detail="L’historique et les montants d’origine resteront consultables." busy={busy} confirmDisabled={!reason.trim()} danger onCancel={() => setIntent(null)} onConfirm={() => void executeIntent()} /></div>}
                      </div>
                    )}

                    {activeReconciliations.length === 0 && (
                      <div className="op-inspector-section op-exclusion-section">
                        {intent?.type === "exclude" ? <><label className="op-field"><span>Motif d’exclusion</span><textarea autoFocus rows={2} value={reason} onChange={(event) => { setReason(event.target.value); setIntent({ type: "exclude", reason: event.target.value }); }} placeholder="Ex. mouvement personnel documenté" /></label><ConfirmationBox title="Exclure ce mouvement ?" detail="Le mouvement restera dans l’historique et pourra être restauré." busy={busy} confirmDisabled={!reason.trim()} danger onCancel={() => setIntent(null)} onConfirm={() => void executeIntent()} /></> : <button type="button" className="op-text-action op-text-action--danger" onClick={() => { setReason(""); setIntent({ type: "exclude", reason: "" }); }}><XCircle size={14} /> Examiner l’exclusion</button>}
                      </div>
                    )}
                  </>
                )}
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function ConfirmationBox({ title, detail, busy, confirmDisabled, danger, onCancel, onConfirm }: {
  title: string;
  detail: string;
  busy: boolean;
  confirmDisabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div className={`op-confirm-box ${danger ? "op-confirm-box--danger" : ""}`} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} role="alertdialog">
      <div><strong>{title}</strong><span>{detail}</span></div>
      <div><button type="button" className="op-button op-button--quiet" onClick={onCancel} disabled={busy}>Retour</button><button type="button" className={`op-button ${danger ? "op-button--danger" : "op-button--primary"}`} onClick={onConfirm} disabled={busy || confirmDisabled}><BusyButtonContent busy={busy}>{danger ? <XCircle size={15} /> : <CheckCircle2 size={15} />} Confirmer</BusyButtonContent></button></div>
    </motion.div>
  );
}
