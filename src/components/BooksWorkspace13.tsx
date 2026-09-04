import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Banknote,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  Download,
  FileClock,
  FileSearch,
  FileSpreadsheet,
  History,
  ListChecks,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  TableProperties,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useAccessibleDialog } from "../lib/useAccessibleDialog";
import { useDraftedForm } from "../lib/useFormDraft";
import { proposeLedgerImportMapping, type MappingSuggestion } from "../lib/ledgerImportMapping";
import "./BooksWorkspace13.css";
import { Explainer, TabPanel, Tabs } from "./ui";
import { WheatSelect, type WheatSelectOption } from "./ui/WheatSelect";

type LooseRecord = Record<string, any>;
type NoticeTone = "success" | "warning" | "error" | "info";

export interface BooksAccountOption {
  id: string;
  code: string;
  label: string;
  active?: boolean;
  classNo?: number;
  type?: string;
  version?: number;
}

export interface BooksJournalOption {
  id: string;
  code: string;
  label: string;
  active?: boolean;
  locked?: boolean;
  version?: number;
}

export interface BooksWorkspace13Props {
  companyId: string;
  companyName?: string;
  currency?: string;
  accounts?: BooksAccountOption[];
  journals?: BooksJournalOption[];
  /** Which workspace opens first — "Rapports comptables" and "Contrôles & imports" share this component. */
  initialTab?: WorkspaceTab;
  onChanged?: () => void | Promise<void>;
  onNotify?: (message: string, tone: NoticeTone) => void;
  exportRows?: (rows: Array<Record<string, unknown>>, suggestedName: string, sheetName: string) => void | Promise<void>;
  exportPdf?: (title: string, head: string[], rows: unknown[][], suggestedName: string) => void | Promise<void>;
}

type WorkspaceTab = "reports" | "imports" | "configuration" | "control";
type ReportId = "entries" | "trial-balance" | "general-ledger" | "journal" | "aged-receivables" | "aged-payables" | "counterparty" | "integrity";
type ConfigurationArea = "company" | "fiscal-years" | "accounts" | "journals" | "banks" | "drafts";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; note: string; help: string; icon: typeof BookOpenCheck }> = [
  { id: "reports", label: "Rapports", note: "Grand livre, balance, balances âgées", help: "Éditez et exportez les états comptables à partir des écritures comptabilisées.", icon: BookOpenCheck },
  { id: "imports", label: "Imports", note: "Reprendre un historique", help: "Chargez une balance ou un journal venu d'un autre logiciel : Wheat contrôle avant de créer quoi que ce soit.", icon: FileSpreadsheet },
  { id: "configuration", label: "Référentiels", note: "Comptes, journaux, exercices", help: "Le paramétrage du dossier : plan de comptes, journaux, comptes bancaires, exercices et brouillons.", icon: Settings2 },
  { id: "control", label: "Contrôles", note: "Verrous, sceaux, audit", help: "Verrouillez une période, scellez un exercice et vérifiez la chaine d'audit.", icon: ShieldCheck },
];

const reportDefinitions: Array<{ id: ReportId; label: string; description: string }> = [
  { id: "entries", label: "Écritures", description: "Pièces comptabilisées, extournes comprises" },
  { id: "trial-balance", label: "Balance", description: "Ouverture, mouvements et clôture par compte" },
  { id: "general-ledger", label: "Grand livre", description: "Mouvements et solde progressif d’un compte" },
  { id: "journal", label: "Journal", description: "Écritures d’un journal dans l’ordre comptable" },
  { id: "aged-receivables", label: "Ancienneté clients", description: "Créances ouvertes à une date d’arrêté" },
  { id: "aged-payables", label: "Ancienneté fournisseurs", description: "Dettes ouvertes à une date d’arrêté" },
  { id: "counterparty", label: "Compte tiers", description: "Mouvements rattachés à un tiers" },
  { id: "integrity", label: "Intégrité", description: "Contrôles structurels des livres locaux" },
];

const configurationAreas: Array<{ id: ConfigurationArea; label: string }> = [
  { id: "company", label: "Société" },
  { id: "fiscal-years", label: "Exercices" },
  { id: "accounts", label: "Comptes" },
  { id: "journals", label: "Journaux" },
  { id: "banks", label: "Banques" },
  { id: "drafts", label: "Brouillons" },
];

const importFields = [
  { key: "entryKey", label: "Clé d’écriture", required: true },
  { key: "date", label: "Date ISO (AAAA-MM-JJ)", required: true },
  { key: "journalCode", label: "Code journal", required: true },
  { key: "pieceNumber", label: "N° de pièce", required: true },
  { key: "entryLabel", label: "Libellé d’écriture", required: true },
  { key: "accountCode", label: "N° de compte", required: true },
  { key: "lineLabel", label: "Libellé de ligne", required: true },
  { key: "debit", label: "Débit MAD exact", required: true },
  { key: "credit", label: "Crédit MAD exact", required: true },
  { key: "thirdParty", label: "Tiers", required: false },
] as const;

type ImportField = (typeof importFields)[number]["key"];
type ImportMapping = Record<ImportField, string>;
type ImportedSheet = { name: string; headers: string[]; rows: Array<{ sourceRow: number; values: string[] }> };
type ImportedSource = { name: string; extension: string; bytesBase64: string; sheets: ImportedSheet[] };
type NormalizedImportRow = {
  sourceRow: number;
  entryKey: string;
  date: string;
  journalCode: string;
  pieceNumber: string;
  entryLabel: string;
  accountCode: string;
  lineLabel: string;
  debit: string;
  credit: string;
  thirdParty: string;
};

const blankMapping = (): ImportMapping => ({
  entryKey: "",
  date: "",
  journalCode: "",
  pieceNumber: "",
  entryLabel: "",
  accountCode: "",
  lineLabel: "",
  debit: "",
  credit: "",
  thirdParty: "",
});

const todayIso = () => new Date().toISOString().slice(0, 10);
const yearStartIso = () => `${new Date().getFullYear()}-01-01`;

function bridgeApi(): LooseRecord {
  return (window.wheat ?? {}) as LooseRecord;
}

function hasBridgeMethod(name: string): boolean {
  return typeof bridgeApi()[name] === "function";
}

async function callBridge<T = any>(name: string, payload?: unknown): Promise<T> {
  const method = bridgeApi()[name];
  if (typeof method !== "function") throw new Error(`La fonction « ${name} » n’est pas disponible dans cette version de Wheat.`);
  return method(payload) as Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw) return "—";
  const iso = raw.slice(0, 10);
  const parts = iso.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : raw;
}

function centsParts(value: unknown): { sign: string; whole: string; fraction: string } | null {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "").padStart(3, "0");
  return { sign: negative && !/^0+$/.test(digits) ? "−" : "", whole: digits.slice(0, -2), fraction: digits.slice(-2) };
}

function formatCents(value: unknown, currency = "MAD"): string {
  const parts = centsParts(value);
  if (!parts) return "—";
  const grouped = parts.whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${parts.sign}${grouped},${parts.fraction} ${currency}`;
}

function centsToDecimal(value: unknown): string {
  const parts = centsParts(value);
  if (!parts) return "";
  return `${parts.sign === "−" ? "-" : ""}${parts.whole}.${parts.fraction}`;
}

function decimalToCents(value: string): string | null {
  const raw = value.trim().replace(",", ".");
  const match = raw.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return `${match[1]}${cents.toString()}`;
}

function exactDecimalCents(value: string): bigint | null {
  const cents = decimalToCents(value);
  if (cents === null) return null;
  return BigInt(cents);
}

function statusLabel(status: unknown): string {
  const labels: Record<string, string> = {
    POSTED: "Comptabilisé", REVERSED: "Extourné", DRAFT: "Brouillon", VOIDED: "Annulé",
    STAGED: "Prêt à confirmer", REVIEW_REQUIRED: "À corriger", IMPORTED: "Importé",
    VALID: "Valide", INVALID: "Invalide", OK: "Conforme", ERRORS: "Erreurs", WARNINGS: "Alertes",
    CHAINED: "Chaîné", IMPORTED_UNSEALED: "Historique importé",
  };
  return labels[String(status ?? "")] ?? String(status ?? "—");
}

function statusTone(status: unknown): "neutral" | "success" | "warning" | "danger" | "info" {
  const value = String(status ?? "");
  if (["POSTED", "STAGED", "IMPORTED", "VALID", "OK", "CHAINED"].includes(value)) return "success";
  if (["REVIEW_REQUIRED", "WARNINGS", "DRAFT", "IMPORTED_UNSEALED"].includes(value)) return "warning";
  if (["VOIDED", "INVALID", "ERRORS"].includes(value)) return "danger";
  if (["REVERSED"].includes(value)) return "info";
  return "neutral";
}

function StatusChip({ value, label }: { value: unknown; label?: string }) {
  return <span className={`books13-status books13-status--${statusTone(value)}`}>{label ?? statusLabel(value)}</span>;
}

function EmptyState({ icon: Icon = FileSearch, title, children, action }: { icon?: typeof FileSearch; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="books13-empty">
      <Icon size={28} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{children}</p>
      {action}
    </div>
  );
}

function LoadingLine({ label = "Chargement…" }: { label?: string }) {
  return <div className="books13-loading"><LoaderCircle size={16} className="books13-spin" /> {label}</div>;
}

function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const countOutsideQuotes = (character: string) => {
    let quoted = false;
    let count = 0;
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"') quoted = !quoted;
      else if (!quoted && firstLine[index] === character) count += 1;
    }
    return count;
  };
  const delimiter = countOutsideQuotes(";") >= countOutsideQuotes(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  rows.push(row);
  while (rows.length > 1 && rows.at(-1)?.every((value) => value === "")) rows.pop();
  return rows;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function textFromBase64(value: string): string {
  return new TextDecoder("utf-8").decode(bytesFromBase64(value));
}

function rowsToSheet(name: string, rows: string[][]): ImportedSheet {
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const first = rows[0] ?? [];
  const headers = Array.from({ length: width }, (_, index) => first[index]?.trim() || `Colonne ${index + 1}`);
  const data = rows.slice(1).map((row, index) => ({
    sourceRow: index + 2,
    values: Array.from({ length: width }, (_, column) => String(row[column] ?? "").trim()),
  }));
  return { name, headers, rows: data };
}

async function parseImportedSource(file: { name: string; extension: string; bytesBase64: string }): Promise<ImportedSource> {
  const extension = file.extension.toLowerCase().replace(/^\./, "");
  if (extension === "csv" || extension === "txt") {
    return { ...file, extension, sheets: [rowsToSheet("Données", parseCsv(textFromBase64(file.bytesBase64)))] };
  }
  if (extension !== "xlsx") throw new Error("Choisissez un fichier .xlsx ou .csv.");
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const bytes = bytesFromBase64(file.bytesBase64);
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheets: ImportedSheet[] = [];
  workbook.eachSheet((worksheet) => {
    const width = worksheet.columnCount;
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      rows.push(Array.from({ length: width }, (_, index) => row.getCell(index + 1).text.trim()));
    });
    sheets.push(rowsToSheet(worksheet.name, rows));
  });
  if (!sheets.length) throw new Error("Le classeur ne contient aucune feuille.");
  return { ...file, extension, sheets };
}

function extractList(value: unknown, preferred: string[] = []): LooseRecord[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as LooseRecord;
  for (const key of [...preferred, "items", "rows", "data"]) if (Array.isArray(record[key])) return record[key];
  return [];
}

function rowValue(row: { values: string[] }, mapping: ImportMapping, field: ImportField): string {
  const selected = mapping[field];
  if (selected === "") return "";
  return row.values[Number.parseInt(selected, 10)] ?? "";
}

function normalizeImportRows(sheet: ImportedSheet, mapping: ImportMapping): NormalizedImportRow[] {
  return sheet.rows.map((row) => ({
    sourceRow: row.sourceRow,
    entryKey: rowValue(row, mapping, "entryKey"),
    date: rowValue(row, mapping, "date"),
    journalCode: rowValue(row, mapping, "journalCode").toUpperCase(),
    pieceNumber: rowValue(row, mapping, "pieceNumber"),
    entryLabel: rowValue(row, mapping, "entryLabel"),
    accountCode: rowValue(row, mapping, "accountCode").toUpperCase(),
    lineLabel: rowValue(row, mapping, "lineLabel"),
    debit: rowValue(row, mapping, "debit"),
    credit: rowValue(row, mapping, "credit"),
    thirdParty: rowValue(row, mapping, "thirdParty"),
  }));
}

function validateImportRows(rows: NormalizedImportRow[], accounts: BooksAccountOption[], journals: BooksJournalOption[]): Map<number, string[]> {
  const errors = new Map<number, string[]>();
  const accountCodes = new Set(accounts.filter((item) => item.active !== false).map((item) => item.code.toUpperCase()));
  const journalCodes = new Set(journals.filter((item) => item.active !== false && !item.locked).map((item) => item.code.toUpperCase()));
  const add = (sourceRow: number, message: string) => errors.set(sourceRow, [...(errors.get(sourceRow) ?? []), message]);
  const entryGroups = new Map<string, NormalizedImportRow[]>();
  for (const row of rows) {
    if (!row.entryKey) add(row.sourceRow, "Clé d’écriture manquante");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) add(row.sourceRow, "Date ISO attendue");
    if (!row.journalCode) add(row.sourceRow, "Journal manquant");
    else if (journalCodes.size && !journalCodes.has(row.journalCode)) add(row.sourceRow, "Journal actif introuvable ou verrouillé");
    if (!row.pieceNumber) add(row.sourceRow, "N° de pièce manquant");
    if (!row.entryLabel) add(row.sourceRow, "Libellé d’écriture manquant");
    if (!row.accountCode) add(row.sourceRow, "Compte manquant");
    else if (accountCodes.size && !accountCodes.has(row.accountCode)) add(row.sourceRow, "Compte actif introuvable");
    if (!row.lineLabel) add(row.sourceRow, "Libellé de ligne manquant");
    const debit = exactDecimalCents(row.debit);
    const credit = exactDecimalCents(row.credit);
    if (debit === null || debit < 0n) add(row.sourceRow, "Débit exact invalide");
    if (credit === null || credit < 0n) add(row.sourceRow, "Crédit exact invalide");
    if (debit !== null && credit !== null && ((debit === 0n && credit === 0n) || (debit > 0n && credit > 0n))) {
      add(row.sourceRow, "Renseignez exclusivement un débit ou un crédit non nul");
    }
    if (row.entryKey) entryGroups.set(row.entryKey, [...(entryGroups.get(row.entryKey) ?? []), row]);
  }
  for (const [entryKey, group] of entryGroups) {
    const first = group[0];
    let debit = 0n;
    let credit = 0n;
    let amountsValid = true;
    for (const row of group) {
      if (row.date !== first.date || row.journalCode !== first.journalCode || row.pieceNumber !== first.pieceNumber || row.entryLabel !== first.entryLabel) {
        add(row.sourceRow, `En-tête différent des autres lignes de « ${entryKey} »`);
      }
      const rowDebit = exactDecimalCents(row.debit);
      const rowCredit = exactDecimalCents(row.credit);
      if (rowDebit === null || rowCredit === null) amountsValid = false;
      else {
        debit += rowDebit;
        credit += rowCredit;
      }
    }
    if (amountsValid && debit !== credit) for (const row of group) add(row.sourceRow, `Écriture « ${entryKey} » déséquilibrée`);
  }
  return errors;
}

export function BooksWorkspace13(props: BooksWorkspace13Props) {
  const { companyId, companyName = "Société active", currency = "MAD", accounts = [], journals = [], initialTab = "reports", onChanged, onNotify, exportRows, exportPdf } = props;
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  useEffect(() => setTab(initialTab), [companyId, initialTab]);
  const active = workspaceTabs.find((item) => item.id === tab) ?? workspaceTabs[0];

  const notify = useCallback((message: string, tone: NoticeTone) => {
    if (onNotify) onNotify(message, tone);
  }, [onNotify]);

  return (
    <section className="books13-shell wt-stack" aria-label="Livres comptables et contrôles">
      <Tabs
        variant="cards"
        ariaLabel="Espaces des livres comptables"
        value={tab}
        onChange={(next) => setTab(next as WorkspaceTab)}
        items={workspaceTabs.map((item) => {
          const Icon = item.icon;
          return { id: item.id, label: item.label, note: item.note, icon: <Icon size={16} aria-hidden="true" /> };
        })}
      />

      <Explainer icon={<ShieldCheck size={16} aria-hidden="true" />}>
        <strong>{active.label}</strong> — {active.help} Les états n'utilisent que les écritures <strong>comptabilisées</strong> de {companyName} : les brouillons en sont exclus.
      </Explainer>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          className="books13-stage"
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.16 }}
        >
          <TabPanel id={tab}>
          {tab === "reports" && (
            <ReportsWorkspace
              companyId={companyId}
              currency={currency}
              accounts={accounts}
              journals={journals}
              notify={notify}
              exportRows={exportRows}
              exportPdf={exportPdf}
            />
          )}
          {tab === "imports" && (
            <ImportWorkspace
              companyId={companyId}
              accounts={accounts}
              journals={journals}
              notify={notify}
              onChanged={onChanged}
            />
          )}
          {tab === "configuration" && (
            <ConfigurationWorkspace
              companyId={companyId}
              fallbackCompanyName={companyName}
              fallbackCurrency={currency}
              fallbackAccounts={accounts}
              fallbackJournals={journals}
              notify={notify}
              onChanged={onChanged}
            />
          )}
          {tab === "control" && (
            <ControlWorkspace companyId={companyId} currency={currency} notify={notify} onChanged={onChanged} />
          )}
          </TabPanel>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

type ReportWorkspaceProps = Pick<BooksWorkspace13Props, "companyId" | "currency" | "accounts" | "journals" | "exportRows" | "exportPdf"> & {
  notify: (message: string, tone: NoticeTone) => void;
};

function ReportsWorkspace({ companyId, currency = "MAD", accounts = [], journals = [], notify, exportRows, exportPdf }: ReportWorkspaceProps) {
  const [reportId, setReportId] = useState<ReportId>("entries");
  const [from, setFrom] = useState(yearStartIso);
  const [to, setTo] = useState(todayIso);
  const [asOf, setAsOf] = useState(todayIso);
  const [accountId, setAccountId] = useState(accounts.find((item) => item.active !== false)?.id ?? "");
  const [journalId, setJournalId] = useState(journals.find((item) => item.active !== false)?.id ?? "");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [counterparties, setCounterparties] = useState<LooseRecord[]>([]);
  const [counterpartyNextCursor, setCounterpartyNextCursor] = useState<string | null>(null);
  const [counterpartyHasMore, setCounterpartyHasMore] = useState(false);
  const [counterpartyTotalCount, setCounterpartyTotalCount] = useState(0);
  const [counterpartyLoading, setCounterpartyLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [result, setResult] = useState<LooseRecord | null>(null);
  const [detail, setDetail] = useState<LooseRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  const reportRequestId = useRef(0);
  const detailRequestId = useRef(0);

  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts.find((item) => item.active !== false)?.id ?? "");
  }, [accountId, accounts]);

  useEffect(() => {
    if (!journalId && journals.length) setJournalId(journals.find((item) => item.active !== false)?.id ?? "");
  }, [journalId, journals]);

  useEffect(() => {
    let cancelled = false;
    if (!hasBridgeMethod("listCounterparties")) return;
    setCounterparties([]);
    setCounterpartyId("");
    setCounterpartyNextCursor(null);
    setCounterpartyHasMore(false);
    setCounterpartyTotalCount(0);
    setCounterpartyLoading(true);
    callBridge("listCounterparties", { companyId, limit: 100 })
      .then((response) => {
        if (cancelled) return;
        const items = extractList(response, ["counterparties"]);
        setCounterparties(items);
        setCounterpartyId(items[0]?.id || "");
        setCounterpartyNextCursor(typeof response?.nextCursor === "string" ? response.nextCursor : null);
        setCounterpartyHasMore(response?.hasMore === true && typeof response?.nextCursor === "string");
        setCounterpartyTotalCount(typeof response?.totalCount === "number" ? response.totalCount : items.length);
      })
      .catch((caught) => { if (!cancelled) notify(errorMessage(caught), "error"); })
      .finally(() => { if (!cancelled) setCounterpartyLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, notify]);

  const loadMoreCounterparties = useCallback(async () => {
    if (!counterpartyHasMore || !counterpartyNextCursor || counterpartyLoading) return;
    setCounterpartyLoading(true);
    try {
      const response = await callBridge("listCounterparties", { companyId, limit: 100, cursor: counterpartyNextCursor });
      const additions = extractList(response, ["counterparties"]);
      setCounterparties((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [...current, ...additions.filter((item) => !existing.has(item.id))];
      });
      setCounterpartyNextCursor(typeof response?.nextCursor === "string" ? response.nextCursor : null);
      setCounterpartyHasMore(response?.hasMore === true && typeof response?.nextCursor === "string");
      setCounterpartyTotalCount(typeof response?.totalCount === "number" ? response.totalCount : counterparties.length + additions.length);
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setCounterpartyLoading(false);
    }
  }, [companyId, counterparties.length, counterpartyHasMore, counterpartyLoading, counterpartyNextCursor, notify]);

  const report = reportDefinitions.find((item) => item.id === reportId) ?? reportDefinitions[0];
  const invokeReport = useCallback(async (cursor: string | null) => {
    const range = { companyId, from: from || undefined, to: to || undefined };
    switch (reportId) {
      case "entries":
        return callBridge("queryReportEntries", { ...range, search: search.trim() || undefined, pageSize: 100, cursor });
      case "trial-balance":
        return callBridge("getTrialBalance", { ...range, includeZero });
      case "general-ledger":
        if (!accountId) throw new Error("Choisissez un compte.");
        return callBridge("getGeneralLedger", { ...range, accountId, pageSize: 100, cursor });
      case "journal":
        if (!journalId) throw new Error("Choisissez un journal.");
        return callBridge("getJournalReport", { ...range, journalId, pageSize: 100, cursor });
      case "aged-receivables":
        return callBridge("getAgedReceivables", { companyId, asOf, currency });
      case "aged-payables":
        return callBridge("getAgedPayables", { companyId, asOf, currency });
      case "counterparty":
        if (!counterpartyId) throw new Error("Choisissez un tiers.");
        return callBridge("getCounterpartyStatement", { ...range, counterpartyId, pageSize: 100, cursor });
      case "integrity":
        return callBridge("getAccountingIntegrity", { companyId, maxIssues: 500 });
    }
  }, [accountId, asOf, companyId, counterpartyId, currency, from, includeZero, journalId, reportId, search, to]);

  const runReport = useCallback(async (cursor: string | null = null, preserveHistory = false) => {
    const requestId = ++reportRequestId.current;
    setLoading(true);
    setError("");
    setDetail(null);
    try {
      const response = await invokeReport(cursor);
      if (requestId !== reportRequestId.current) return;
      setResult((response ?? {}) as LooseRecord);
      if (!preserveHistory) setCursorHistory([cursor]);
    } catch (caught) {
      if (requestId !== reportRequestId.current) return;
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      if (requestId === reportRequestId.current) setLoading(false);
    }
  }, [invokeReport, notify]);

  useEffect(() => {
    reportRequestId.current += 1;
    detailRequestId.current += 1;
    setLoading(false);
    setDetailLoading(false);
    setResult(null);
    setDetail(null);
    setCursorHistory([null]);
  }, [reportId, companyId]);

  const openEntryDetail = async (entryId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setError("");
    try {
      const nextDetail = await callBridge("getReportEntryDetail", { companyId, entryId });
      if (requestId === detailRequestId.current) setDetail(nextDetail);
    } catch (caught) {
      if (requestId !== detailRequestId.current) return;
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  };

  const exportModel = useMemo(() => buildReportExport(reportId, result, currency), [currency, reportId, result]);
  const loadCompleteExportResult = async (): Promise<LooseRecord> => {
    const paginated = new Set<ReportId>(["entries", "general-ledger", "journal", "counterparty"]);
    const first = (await invokeReport(null) ?? {}) as LooseRecord;
    if (!paginated.has(reportId)) return first;
    const items = [...extractList(first, ["items"])];
    let cursor = typeof first.nextCursor === "string" ? first.nextCursor : null;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error("La pagination de l’état est incohérente. Aucun export n’a été créé.");
      seen.add(cursor);
      const page = (await invokeReport(cursor) ?? {}) as LooseRecord;
      items.push(...extractList(page, ["items"]));
      if (items.length > 250_000) throw new Error("L’état dépasse 250 000 lignes. Réduisez la période avant de l’exporter.");
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    }
    return { ...first, items, nextCursor: null, exportedPageCount: seen.size + 1, exportedRowCount: items.length };
  };
  const exportExcel = async () => {
    if (!exportRows || !exportModel.rows.length) return;
    setExportLoading(true);
    try {
      const completeModel = buildReportExport(reportId, await loadCompleteExportResult(), currency);
      await exportRows(completeModel.rows, completeModel.fileName.replace(".pdf", ".xlsx"), completeModel.sheetName);
      notify(`Export complet créé : ${completeModel.rows.length} ligne(s).`, "success");
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setExportLoading(false);
    }
  };
  const exportAsPdf = async () => {
    if (!exportPdf || !exportModel.pdfRows.length) return;
    setExportLoading(true);
    try {
      const completeModel = buildReportExport(reportId, await loadCompleteExportResult(), currency);
      await exportPdf(completeModel.title, completeModel.headers, completeModel.pdfRows, completeModel.fileName);
      notify(`Export complet créé : ${completeModel.pdfRows.length} ligne(s).`, "success");
    } catch (caught) {
      notify(errorMessage(caught), "error");
    } finally {
      setExportLoading(false);
    }
  };

  const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;

  return (
    <div className="books13-workspace books13-workspace--reports">
      <aside className="books13-rail" aria-label="Choix de l’état">
        <div className="books13-rail__title"><TableProperties size={16} /> États disponibles</div>
        {reportDefinitions.map((item) => (
          <button key={item.id} type="button" className={reportId === item.id ? "is-active" : ""} onClick={() => setReportId(item.id)}>
            <strong>{item.label}</strong><small>{item.description}</small>
          </button>
        ))}
        <div className="books13-ledger-note">
          <BadgeCheck size={16} />
          <p><strong>Base comptable</strong><span>Les brouillons ne sont jamais mêlés aux états exacts.</span></p>
        </div>
      </aside>

      <main className="books13-main">
        <div className="books13-section-head">
          <div><span>État sélectionné</span><h3>{report.label}</h3><p>{report.description}.</p></div>
          <div className="books13-actions">
            {exportRows && <button type="button" className="books13-button books13-button--quiet" disabled={exportLoading || !exportModel.rows.length} onClick={exportExcel}><Download size={15} /> XLSX complet</button>}
            {exportPdf && <button type="button" className="books13-button books13-button--quiet" disabled={exportLoading || !exportModel.pdfRows.length} onClick={exportAsPdf}><Download size={15} /> PDF complet</button>}
            <button type="button" className="books13-button books13-button--primary" disabled={loading} onClick={() => runReport(null)}>
              {loading ? <LoaderCircle size={15} className="books13-spin" /> : <RefreshCw size={15} />} Produire l’état
            </button>
          </div>
        </div>

        <div className="books13-filterbar">
          {!reportId.startsWith("aged-") && reportId !== "integrity" && <>
            <label><span>Du</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label><span>Au</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </>}
          {reportId.startsWith("aged-") && <label><span>Date d’arrêté</span><input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label>}
          {reportId === "entries" && <label className="books13-filterbar__wide"><span>Recherche</span><div className="books13-input-icon"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="N° d’écriture, pièce ou libellé" /></div></label>}
          {reportId === "trial-balance" && <label className="books13-check"><input type="checkbox" checked={includeZero} onChange={(event) => setIncludeZero(event.target.checked)} /><span>Inclure les comptes sans mouvement</span></label>}
          {reportId === "general-ledger" && <label className="books13-filterbar__wide"><span>Compte</span><WheatSelect
            ariaLabel="Compte à consulter"
            placeholder="Choisir un compte…"
            searchPlaceholder="Numéro ou libellé du compte…"
            noOptionsLabel="Aucun compte dans ce dossier"
            value={accountId}
            onChange={setAccountId}
            options={accounts.map((item): WheatSelectOption => ({
              value: String(item.id),
              label: `${item.code} — ${item.label}`,
              keywords: String(item.label ?? ""),
            }))}
          /></label>}
          {reportId === "journal" && <label className="books13-filterbar__wide"><span>Journal</span><WheatSelect
            ariaLabel="Journal à éditer"
            placeholder="Choisir un journal…"
            searchPlaceholder="Code ou libellé du journal…"
            noOptionsLabel="Aucun journal dans ce dossier"
            value={journalId}
            onChange={setJournalId}
            options={journals.map((item): WheatSelectOption => ({
              value: String(item.id),
              label: `${item.code} — ${item.label}`,
              keywords: String(item.label ?? ""),
            }))}
          /></label>}
          {reportId === "counterparty" && <>
            <label className="books13-filterbar__wide"><span>Tiers · {counterparties.length} chargé(s) sur {counterpartyTotalCount}</span><WheatSelect
              ariaLabel="Tiers à consulter"
              placeholder="Choisir un tiers…"
              searchPlaceholder="Nom du tiers…"
              searchable
              loading={counterpartyLoading}
              noOptionsLabel="Aucun tiers chargé"
              footerNote={counterpartyHasMore ? "Chargez plus de tiers pour élargir la recherche" : undefined}
              value={counterpartyId}
              onChange={setCounterpartyId}
              options={counterparties.map((item): WheatSelectOption => ({
                value: String(item.id),
                label: String(item.displayName ?? item.legalName ?? item.id),
                note: item.ice ? `ICE ${item.ice}` : undefined,
                keywords: String(item.legalName ?? ""),
              }))}
            /></label>
            {counterpartyHasMore && <button type="button" className="books13-button books13-button--quiet" disabled={counterpartyLoading} onClick={() => void loadMoreCounterparties()}>{counterpartyLoading ? <LoaderCircle size={14} className="books13-spin" /> : <ArrowRight size={14} />} Charger {Math.min(100, Math.max(counterpartyTotalCount - counterparties.length, 1))} tiers de plus</button>}
          </>}
        </div>

        {error && <div className="books13-message books13-message--error"><AlertTriangle size={16} /><span>{error}</span></div>}
        {loading && <LoadingLine label="Calcul exact en cours dans la base locale…" />}
        {!loading && !result && <EmptyState title={`Produire : ${report.label}`}>Définissez la période et les filtres, puis demandez l’état. Les totaux ne sont pas recalculés dans l’interface.</EmptyState>}
        {!loading && result && (
          <ReportResult reportId={reportId} result={result} currency={currency} onEntry={openEntryDetail} />
        )}

        {result && (cursorHistory.length > 1 || nextCursor) && (
          <div className="books13-pagination">
            <button type="button" className="books13-button books13-button--quiet" disabled={loading || cursorHistory.length <= 1} onClick={() => {
              const nextHistory = cursorHistory.slice(0, -1);
              setCursorHistory(nextHistory);
              void runReport(nextHistory.at(-1) ?? null, true);
            }}><ArrowLeft size={15} /> Précédent</button>
            <span>Page {cursorHistory.length}</span>
            <button type="button" className="books13-button books13-button--quiet" disabled={loading || !nextCursor} onClick={() => {
              if (!nextCursor) return;
              setCursorHistory((current) => [...current, nextCursor]);
              void runReport(nextCursor, true);
            }}>Suivant <ArrowRight size={15} /></button>
          </div>
        )}
      </main>

      <AnimatePresence>
        {(detail || detailLoading) && (
          <motion.aside className="books13-inspector" initial={{ x: 22, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 16, opacity: 0 }}>
            <button type="button" className="books13-icon-button" onClick={() => setDetail(null)} aria-label="Fermer le détail"><X size={17} /></button>
            {detailLoading && <LoadingLine label="Lecture de la pièce…" />}
            {detail && <EntryInspector entry={detail} currency={currency} />}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function reportRows(reportId: ReportId, result: LooseRecord | null): LooseRecord[] {
  if (!result) return [];
  if (reportId === "trial-balance") return extractList(result, ["accounts"]);
  if (reportId === "integrity") return extractList(result, ["issues"]);
  return extractList(result, ["items", "rows", "counterparties"]);
}

function ReportResult({ reportId, result, currency, onEntry }: { reportId: ReportId; result: LooseRecord; currency: string; onEntry: (entryId: string) => void }) {
  const rows = reportRows(reportId, result);
  if (reportId === "integrity") return <IntegrityResult result={result} />;
  if (reportId === "trial-balance") return <TrialBalanceResult result={result} currency={currency} />;
  if (reportId === "aged-receivables" || reportId === "aged-payables") return <AgingResult result={result} currency={currency} />;
  if (!rows.length) return <EmptyState title="Aucun mouvement">Aucune donnée comptabilisée ne correspond à ces filtres.</EmptyState>;
  const isLedger = reportId === "general-ledger" || reportId === "counterparty";
  return (
    <div className="books13-result">
      {isLedger && (
        <div className="books13-totals-line">
          <span><small>Solde d’ouverture</small><strong>{formatCents(result.openingBalanceCents, currency)}</strong></span>
          <span><small>Débit période</small><strong>{formatCents(result.periodDebitCents, currency)}</strong></span>
          <span><small>Crédit période</small><strong>{formatCents(result.periodCreditCents, currency)}</strong></span>
          <span><small>Solde de clôture</small><strong>{formatCents(result.closingBalanceCents, currency)}</strong></span>
        </div>
      )}
      <div className="books13-table-wrap">
        <table className="books13-table">
          <thead><tr><th>Date</th><th>Journal</th><th>N° / Pièce</th><th>Libellé</th><th className="is-numeric">Débit</th><th className="is-numeric">Crédit</th>{isLedger && <th className="is-numeric">Solde</th>}<th>Statut</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const entryId = row.id ?? row.entryId;
              const number = row.number ?? row.entryNumber;
              return (
                <tr key={entryId ?? `${row.date}-${number}`} className={entryId ? "is-clickable" : ""} onClick={() => entryId && onEntry(entryId)}>
                  <td>{formatDate(row.date)}</td>
                  <td><strong>{row.journal?.code ?? row.journalCode ?? "—"}</strong></td>
                  <td><strong>{number ?? "—"}</strong><small>{row.pieceNumber ?? ""}</small></td>
                  <td>{row.label ?? row.entryLabel ?? "—"}</td>
                  <td className="is-numeric">{formatCents(row.debitCents, currency)}</td>
                  <td className="is-numeric">{formatCents(row.creditCents, currency)}</td>
                  {isLedger && <td className="is-numeric"><strong>{formatCents(row.runningBalanceCents, currency)}</strong></td>}
                  <td><StatusChip value={row.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {result.totals && (
        <div className="books13-result-foot">
          <span>Total débit <strong>{formatCents(result.totals.debitCents ?? result.totals.periodDebitCents, currency)}</strong></span>
          <span>Total crédit <strong>{formatCents(result.totals.creditCents ?? result.totals.periodCreditCents, currency)}</strong></span>
          {typeof result.balanced === "boolean" && <StatusChip value={result.balanced ? "OK" : "ERRORS"} label={result.balanced ? "Équilibré" : "Déséquilibré"} />}
        </div>
      )}
    </div>
  );
}

function TrialBalanceResult({ result, currency }: { result: LooseRecord; currency: string }) {
  const rows = extractList(result, ["accounts"]);
  if (!rows.length) return <EmptyState title="Balance sans mouvement">Aucun compte ne correspond à la période.</EmptyState>;
  return (
    <div className="books13-result">
      <div className="books13-table-wrap">
        <table className="books13-table books13-table--balance">
          <thead><tr><th>Compte</th><th>Libellé</th><th className="is-numeric">Ouverture</th><th className="is-numeric">Débit période</th><th className="is-numeric">Crédit période</th><th className="is-numeric">Solde débiteur</th><th className="is-numeric">Solde créditeur</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id ?? row.code}><td><strong>{row.code}</strong></td><td>{row.label}</td><td className="is-numeric">{formatCents(row.openingBalanceCents, currency)}</td><td className="is-numeric">{formatCents(row.periodDebitCents, currency)}</td><td className="is-numeric">{formatCents(row.periodCreditCents, currency)}</td><td className="is-numeric">{formatCents(row.closingDebitCents, currency)}</td><td className="is-numeric">{formatCents(row.closingCreditCents, currency)}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="books13-result-foot"><span>Total débit <strong>{formatCents(result.totals?.periodDebitCents, currency)}</strong></span><span>Total crédit <strong>{formatCents(result.totals?.periodCreditCents, currency)}</strong></span><StatusChip value={result.balanced ? "OK" : "ERRORS"} label={result.balanced ? "Balance équilibrée" : "Écart détecté"} /></div>
    </div>
  );
}

function AgingResult({ result, currency }: { result: LooseRecord; currency: string }) {
  const rows = extractList(result, ["rows"]);
  if (!rows.length) return <EmptyState title="Aucun encours">Aucune facture ouverte n’est justifiée à cette date d’arrêté.</EmptyState>;
  return (
    <div className="books13-result">
      <div className="books13-totals-line">
        <span><small>Encours total</small><strong>{formatCents(result.totals?.outstandingCents, currency)}</strong></span>
        <span><small>Non échu</small><strong>{formatCents(result.totals?.currentCents, currency)}</strong></span>
        <span><small>1–30 jours</small><strong>{formatCents(result.totals?.days1To30Cents, currency)}</strong></span>
        <span><small>Plus de 90 jours</small><strong>{formatCents(result.totals?.over90DaysCents, currency)}</strong></span>
      </div>
      <div className="books13-table-wrap"><table className="books13-table"><thead><tr><th>Échéance</th><th>Facture</th><th>Tiers</th><th>Ancienneté</th><th className="is-numeric">Original</th><th className="is-numeric">Imputé</th><th className="is-numeric">Encours</th></tr></thead><tbody>{rows.map((row) => <tr key={row.invoiceId}><td>{formatDate(row.dueDate)}</td><td><strong>{row.invoiceNo}</strong></td><td>{row.counterpartyName ?? row.displayName ?? "—"}</td><td>{row.bucketLabel ?? row.bucket ?? `${row.daysPastDue ?? 0} j`}</td><td className="is-numeric">{formatCents(row.originalCents, currency)}</td><td className="is-numeric">{formatCents(row.allocatedCents, currency)}</td><td className="is-numeric"><strong>{formatCents(row.outstandingCents, currency)}</strong></td></tr>)}</tbody></table></div>
      <p className="books13-footnote">Arrêté au {formatDate(result.asOf)}. Les pièces sans preuve comptable exploitable sont signalées dans les exclusions du rapport.</p>
    </div>
  );
}

function IntegrityResult({ result }: { result: LooseRecord }) {
  const issues = extractList(result, ["issues"]);
  const okay = result.status === "OK";
  return (
    <div className="books13-result">
      <div className={`books13-integrity-head ${okay ? "is-ok" : "is-alert"}`}>
        {okay ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
        <div><strong>{okay ? "Aucune anomalie détectée" : "Contrôle terminé avec observations"}</strong><span>{result.summary?.entryCount ?? 0} écriture(s) contrôlée(s) · {result.summary?.errorCount ?? 0} erreur(s) · {result.summary?.warningCount ?? 0} alerte(s)</span></div>
        <StatusChip value={result.status} />
      </div>
      {issues.length > 0 && <div className="books13-table-wrap"><table className="books13-table"><thead><tr><th>Niveau</th><th>Contrôle</th><th>Objet</th><th>Observation</th></tr></thead><tbody>{issues.map((issue, index) => <tr key={`${issue.code}-${issue.entityId}-${index}`}><td><StatusChip value={issue.severity === "ERROR" ? "ERRORS" : "WARNINGS"} label={issue.severity === "ERROR" ? "Erreur" : "Alerte"} /></td><td><strong>{issue.code}</strong></td><td>{issue.entityType}{issue.entityId ? <small>{issue.entityId}</small> : null}</td><td>{issue.message}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

function EntryInspector({ entry, currency }: { entry: LooseRecord; currency: string }) {
  const lines = extractList(entry, ["lines"]);
  return (
    <div className="books13-entry-detail">
      <span className="books13-eyebrow">Pièce comptable</span>
      <h3>{entry.number}</h3>
      <p>{entry.label}</p>
      <dl><div><dt>Date</dt><dd>{formatDate(entry.date)}</dd></div><div><dt>Journal</dt><dd>{entry.journal?.code ?? "—"}</dd></div><div><dt>Pièce</dt><dd>{entry.pieceNumber ?? "—"}</dd></div><div><dt>Statut</dt><dd><StatusChip value={entry.status} /></dd></div></dl>
      <div className="books13-inspector-lines">
        {lines.map((line) => <div key={line.id}><p><strong>{line.account?.code ?? "—"}</strong><span>{line.account?.label ?? line.label}</span></p><p className="is-numeric"><span>{line.debitCents !== "0" ? formatCents(line.debitCents, currency) : ""}</span><span>{line.creditCents !== "0" ? formatCents(line.creditCents, currency) : ""}</span></p></div>)}
      </div>
      <div className="books13-inspector-total"><span>Débit <strong>{formatCents(entry.debitCents, currency)}</strong></span><span>Crédit <strong>{formatCents(entry.creditCents, currency)}</strong></span></div>
      {entry.auditNote && <div className="books13-note"><History size={15} /><span><strong>Note d’audit</strong>{entry.auditNote}</span></div>}
    </div>
  );
}

function buildReportExport(reportId: ReportId, result: LooseRecord | null, currency: string) {
  const definition = reportDefinitions.find((item) => item.id === reportId) ?? reportDefinitions[0];
  const source = reportRows(reportId, result);
  const slug = reportId.replaceAll("-", "_");
  const title = `${definition.label} · Wheat`;
  let rows: Array<Record<string, unknown>>;
  if (reportId === "trial-balance") rows = source.map((row) => ({ Compte: row.code, Libellé: row.label, "Ouverture (centimes)": row.openingBalanceCents, "Débit période (centimes)": row.periodDebitCents, "Crédit période (centimes)": row.periodCreditCents, "Solde débiteur (centimes)": row.closingDebitCents, "Solde créditeur (centimes)": row.closingCreditCents, Devise: currency }));
  else if (reportId === "integrity") rows = source.map((row) => ({ Niveau: row.severity, Code: row.code, Objet: row.entityType, Identifiant: row.entityId ?? "", Observation: row.message }));
  else if (reportId.startsWith("aged-")) rows = source.map((row) => ({ Échéance: row.dueDate, Facture: row.invoiceNo, Tiers: row.counterpartyName ?? row.displayName, Ancienneté: row.bucketLabel ?? row.bucket, "Original (centimes)": row.originalCents, "Imputé (centimes)": row.allocatedCents, "Encours (centimes)": row.outstandingCents, Devise: currency }));
  else rows = source.map((row) => ({ Date: row.date, Journal: row.journal?.code ?? row.journalCode, Écriture: row.number ?? row.entryNumber, Pièce: row.pieceNumber, Libellé: row.label, "Débit (centimes)": row.debitCents, "Crédit (centimes)": row.creditCents, "Solde (centimes)": row.runningBalanceCents ?? "", Statut: row.status, Devise: currency }));
  const headers = Object.keys(rows[0] ?? {});
  return { title, rows, headers, pdfRows: rows.map((row) => headers.map((header) => row[header])), fileName: `${slug}-wheat.pdf`, sheetName: definition.label.slice(0, 31) };
}

function ImportWorkspace({ companyId, accounts, journals, notify, onChanged }: {
  companyId: string;
  accounts: BooksAccountOption[];
  journals: BooksJournalOption[];
  notify: (message: string, tone: NoticeTone) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [source, setSource] = useState<ImportedSource | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<ImportMapping>(blankMapping);
  /**
   * What Wheat worked out about the columns, kept beside the mapping rather
   * than folded into it: the user must be able to see which columns were
   * proposed, how sure Wheat was, and change any of them.
   */
  const [mappingProposal, setMappingProposal] = useState<MappingSuggestion[] | null>(null);
  const [imports, setImports] = useState<LooseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [cancelBatchId, setCancelBatchId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [confirmBatchId, setConfirmBatchId] = useState<string | null>(null);
  const [pendingSupersedes, setPendingSupersedes] = useState<LooseRecord | null>(null);

  const sheet = source?.sheets[sheetIndex] ?? null;
  const mappingsComplete = importFields.filter((field) => field.required).every((field) => mapping[field.key] !== "");
  const normalizedRows = useMemo(() => sheet && mappingsComplete ? normalizeImportRows(sheet, mapping) : [], [mapping, mappingsComplete, sheet]);
  const validation = useMemo(() => validateImportRows(normalizedRows, accounts, journals), [accounts, journals, normalizedRows]);
  const issueCount = [...validation.values()].reduce((sum, messages) => sum + messages.length, 0);

  const refreshImports = useCallback(async () => {
    if (!hasBridgeMethod("listLedgerImports")) return;
    setHistoryLoading(true);
    try {
      setImports(extractList(await callBridge("listLedgerImports", { companyId, limit: 50 }), ["items", "imports", "batches"]));
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
    } finally {
      setHistoryLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void refreshImports(); }, [refreshImports]);

  const chooseFile = async () => {
    setError("");
    setLoading(true);
    try {
      if (!hasBridgeMethod("importFile")) throw new Error("Le sélecteur de fichier local n’est pas disponible.");
      const file = await bridgeApi().importFile();
      if (!file) return;
      const parsed = await parseImportedSource(file);
      if (parsed.sheets.some((item) => item.rows.length > 10_000)) throw new Error("Une feuille dépasse la limite de 10 000 lignes de Wheat.");
      setSource(parsed);
      if (pendingSupersedes) {
        let evidence: LooseRecord = {};
        try { evidence = typeof pendingSupersedes.mappingJson === "string" ? JSON.parse(pendingSupersedes.mappingJson) : pendingSupersedes.mappingJson ?? {}; } catch { evidence = {}; }
        const restoredSheetIndex = parsed.sheets.findIndex((item) => item.name === evidence.sheet);
        const selectedIndex = restoredSheetIndex >= 0 ? restoredSheetIndex : 0;
        const selectedSheet = parsed.sheets[selectedIndex];
        const fields = evidence.fields && typeof evidence.fields === "object" ? evidence.fields as LooseRecord : {};
        const restoredMapping = blankMapping();
        for (const field of importFields) {
          const prior = fields[field.key];
          if (!prior || typeof prior !== "object") continue;
          const columnIndex = Number((prior as LooseRecord).columnIndex);
          const header = String((prior as LooseRecord).header ?? "");
          if (Number.isInteger(columnIndex) && selectedSheet.headers[columnIndex] === header) restoredMapping[field.key] = String(columnIndex);
        }
        setSheetIndex(selectedIndex);
        setMapping(restoredMapping);
        notify(`${file.name} rechargé. Wheat vérifiera l’empreinte et le périmètre avant de créer la révision.`, "info");
      } else {
        setSheetIndex(0);
        // Wheat proposes the mapping instead of asking for ten answers it can
        // work out. The proposal is shown with its reasons and is editable:
        // staging re-validates every row exactly as before.
        const proposal = proposeLedgerImportMapping(parsed.sheets[0]);
        const proposed = blankMapping();
        for (const suggestion of proposal.suggestions) {
          if (suggestion.columnIndex !== null) proposed[suggestion.field] = String(suggestion.columnIndex);
        }
        setMapping(proposed);
        setMappingProposal(proposal.suggestions);
        const mapped = proposal.suggestions.filter((item) => item.columnIndex !== null).length;
        notify(
          proposal.complete
            ? `${file.name} chargé. Wheat a reconnu ${mapped} colonne(s) : vérifiez le mapping proposé avant de préparer le lot.`
            : `${file.name} chargé. Wheat a reconnu ${mapped} colonne(s) ; indiquez celles qu'il n'a pas su déterminer.`,
          proposal.complete ? "success" : "info",
        );
      }
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const stage = async () => {
    if (!source || !sheet || !mappingsComplete || !normalizedRows.length || issueCount > 0) return;
    setLoading(true);
    setError("");
    try {
      const mappingEvidence = Object.fromEntries(importFields.map((field) => {
        const index = mapping[field.key];
        return [field.key, index === "" ? null : { columnIndex: Number.parseInt(index, 10), header: sheet.headers[Number.parseInt(index, 10)] }];
      }));
      const response = await callBridge<LooseRecord>("stageLedgerImport", {
        companyId,
        sourceName: source.name,
        sourceBytesBase64: source.bytesBase64,
        mapping: { sheet: sheet.name, fields: mappingEvidence },
        rows: normalizedRows,
        supersedesBatchId: pendingSupersedes?.id ?? undefined,
      });
      setSource(null);
      setMapping(blankMapping());
      setMappingProposal(null);
      setPendingSupersedes(null);
      await refreshImports();
      notify(`Lot ${response.id ?? ""} préparé. Vérifiez-le avant confirmation.`, response.status === "STAGED" ? "success" : "warning");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const confirm = async (batchId: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await callBridge<LooseRecord>("confirmLedgerImport", { companyId, batchId });
      setConfirmBatchId(null);
      await refreshImports();
      await onChanged?.();
      notify(`${response.entries?.length ?? 0} écriture(s) brouillon créée(s).`, "success");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    if (!cancelBatchId || !cancelReason.trim()) return;
    setLoading(true);
    setError("");
    try {
      await callBridge("cancelLedgerImport", { companyId, batchId: cancelBatchId, reason: cancelReason.trim() });
      setCancelBatchId(null);
      setCancelReason("");
      await refreshImports();
      notify("Lot annulé sans créer d’écriture.", "success");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="books13-import">
      <div className="books13-section-head">
        <div><span>Import de grand livre</span><h3>Préparer, contrôler, confirmer</h3><p>Wheat ne devine ni colonnes, ni comptes, ni montants. La confirmation crée uniquement des brouillons.</p></div>
        <button type="button" className="books13-button books13-button--primary" onClick={chooseFile} disabled={loading}><Upload size={15} /> {pendingSupersedes ? "Resélectionner le fichier" : "Choisir XLSX ou CSV"}</button>
      </div>
      {error && <div className="books13-message books13-message--error"><AlertTriangle size={16} /><span>{error}</span></div>}
      {pendingSupersedes && <div className="books13-message books13-message--info"><History size={16} /><span><strong>Reprise explicite du lot {pendingSupersedes.id}.</strong> Resélectionnez le même fichier. Wheat exigera les mêmes octets, la même feuille, le même mapping et les mêmes lignes avant de créer la révision {(Number(pendingSupersedes.revision ?? 1) + 1)}.</span><button type="button" className="books13-button books13-button--small books13-button--quiet" onClick={() => { setPendingSupersedes(null); setSource(null); setMapping(blankMapping()); setMappingProposal(null); }}>Abandonner la reprise</button></div>}

      {!source && (
        <div className="books13-import-intro">
          <div className="books13-import-intro__flow" aria-label="Étapes d’import">
            <span><b>1</b><strong>Choisir</strong><small>Fichier local original</small></span><i /><span><b>2</b><strong>Mapper</strong><small>Chaque colonne explicitement</small></span><i /><span><b>3</b><strong>Contrôler</strong><small>Toutes les lignes visibles</small></span><i /><span><b>4</b><strong>Confirmer</strong><small>Brouillons seulement</small></span>
          </div>
          <div className="books13-message books13-message--info"><ShieldCheck size={17} /><span><strong>Format monétaire strict.</strong> Utilisez des décimaux MAD avec au plus deux chiffres après la virgule, et écrivez explicitement 0 sur le côté sans montant.</span></div>
        </div>
      )}

      {source && sheet && (
        <div className="books13-import-review">
          <header>
            <div><FileSpreadsheet size={20} /><span><strong>{source.name}</strong><small>{source.extension.toUpperCase()} · {sheet.rows.length} ligne(s) à examiner</small></span></div>
            <button type="button" className="books13-icon-button" aria-label="Retirer le fichier" onClick={() => { setSource(null); setMapping(blankMapping()); setMappingProposal(null); }}><X size={17} /></button>
          </header>
          {source.sheets.length > 1 && <label className="books13-sheet-select"><span>Feuille à importer</span><WheatSelect
            ariaLabel="Feuille à importer"
            searchPlaceholder="Nom de la feuille…"
            value={String(sheetIndex)}
            onChange={(value) => {
              const index = Number.parseInt(value, 10);
              setSheetIndex(index);
              // A different sheet is a different file as far as mapping goes.
              const proposal = proposeLedgerImportMapping(source.sheets[index]);
              const proposed = blankMapping();
              for (const suggestion of proposal.suggestions) {
                if (suggestion.columnIndex !== null) proposed[suggestion.field] = String(suggestion.columnIndex);
              }
              setMapping(proposed);
              setMappingProposal(proposal.suggestions);
            }}
            options={source.sheets.map((item, index): WheatSelectOption => ({
              value: String(index),
              label: String(item.name),
              note: `${item.rows.length} ligne(s)`,
            }))}
          /></label>}

          <div className="books13-mapping">
            <div className="books13-subhead"><div><span>Étape 1</span><h4>Mapping proposé par Wheat</h4></div><small>{importFields.filter((field) => mapping[field.key]).length}/{importFields.length} champs mappés</small></div>
            {mappingProposal && (
              <div className="books13-message books13-message--info">
                <ShieldCheck size={17} />
                <span>
                  <strong>Wheat a déterminé le mapping à partir des en-têtes et du contenu des colonnes.</strong>{" "}
                  Vérifiez-le : chaque champ indique la colonne retenue et pourquoi. Modifiez ce qui ne convient pas —
                  rien n'est préparé tant que vous n'avez pas lancé l'étape suivante.
                </span>
              </div>
            )}
            <div className="books13-mapping-grid">
              {importFields.map((field) => {
                const suggestion = mappingProposal?.find((item) => item.field === field.key) ?? null;
                const untouched = suggestion && suggestion.columnIndex !== null && mapping[field.key] === String(suggestion.columnIndex);
                return <label key={field.key} data-confidence={untouched ? (suggestion.confidence >= 70 ? "high" : "low") : undefined}><span>{field.label}{field.required && <sup>requis</sup>}</span><WheatSelect
                ariaLabel={`Colonne source pour ${field.label}`}
                placeholder="Ne pas mapper"
                searchPlaceholder="Nom de colonne…"
                allowClear
                noOptionsLabel="Le fichier ne contient aucune colonne"
                value={mapping[field.key]}
                onChange={(value) => setMapping((current) => ({ ...current, [field.key]: value }))}
                options={sheet.headers.map((header, index): WheatSelectOption => ({
                  value: String(index),
                  label: `${String.fromCharCode(65 + (index % 26))} — ${header}`,
                  note: "Colonne du fichier",
                  keywords: String(header),
                }))}
              />
              {suggestion && untouched && (
                <small className="books13-mapping-reason" data-confidence={suggestion.confidence >= 70 ? "high" : "low"}>
                  {suggestion.confidence >= 70 ? <Check size={12} /> : <AlertTriangle size={12} />} {suggestion.reason} ({suggestion.confidence} %)
                </small>
              )}
              {suggestion && suggestion.columnIndex === null && field.required && (
                <small className="books13-mapping-reason" data-confidence="low">
                  <AlertTriangle size={12} /> {suggestion.reason}
                </small>
              )}
              </label>;
              })}
            </div>
          </div>

          <div className="books13-preview">
            <div className="books13-subhead"><div><span>Étape 2</span><h4>Prévisualisation de toutes les lignes</h4></div>{mappingsComplete && <StatusChip value={issueCount ? "ERRORS" : "OK"} label={issueCount ? `${issueCount} observation(s)` : "Prêt à préparer"} />}</div>
            {!mappingsComplete ? <EmptyState icon={ListChecks} title="Mapping incomplet">Wheat n’a pas su déterminer toutes les colonnes requises. Complétez celles qui restent, à l’étape 1.</EmptyState> : (
              <div className="books13-table-wrap books13-table-wrap--preview">
                <table className="books13-table books13-table--import"><thead><tr><th>Ligne</th><th>Clé</th><th>Date</th><th>Journal</th><th>Pièce</th><th>Compte</th><th>Libellé</th><th className="is-numeric">Débit</th><th className="is-numeric">Crédit</th><th>Contrôle</th></tr></thead><tbody>{normalizedRows.map((row) => {
                  const messages = validation.get(row.sourceRow) ?? [];
                  return <tr key={row.sourceRow} className={messages.length ? "has-error" : ""}><td>{row.sourceRow}</td><td><strong>{row.entryKey || "—"}</strong></td><td>{row.date || "—"}</td><td>{row.journalCode || "—"}</td><td>{row.pieceNumber || "—"}</td><td>{row.accountCode || "—"}</td><td>{row.lineLabel || "—"}</td><td className="is-numeric">{row.debit || "∅"}</td><td className="is-numeric">{row.credit || "∅"}</td><td>{messages.length ? <span className="books13-row-errors" title={messages.join(" · ")}><XCircle size={14} /> {messages[0]}{messages.length > 1 ? ` +${messages.length - 1}` : ""}</span> : <span className="books13-row-ok"><Check size={14} /> Valide</span>}</td></tr>;
                })}</tbody></table>
              </div>
            )}
          </div>

          <footer className="books13-review-footer">
            <p><ShieldCheck size={16} /><span><strong>Aucune comptabilisation à cette étape.</strong> Le fichier et son mapping sont conservés comme preuve du lot préparé.</span></p>
            <button type="button" className="books13-button books13-button--primary" disabled={loading || !mappingsComplete || !normalizedRows.length || issueCount > 0} onClick={stage}>{loading ? <LoaderCircle size={15} className="books13-spin" /> : <FileClock size={15} />} Préparer le lot</button>
          </footer>
        </div>
      )}

      <section className="books13-history">
        <div className="books13-subhead"><div><span>Historique local</span><h4>Lots préparés</h4></div><button type="button" className="books13-icon-button" onClick={refreshImports} aria-label="Actualiser"><RefreshCw size={15} className={historyLoading ? "books13-spin" : ""} /></button></div>
        {historyLoading && !imports.length ? <LoadingLine /> : !imports.length ? <EmptyState icon={History} title="Aucun lot enregistré">Le premier import apparaîtra ici avec le hash de son fichier source.</EmptyState> : (
          <div className="books13-table-wrap"><table className="books13-table"><thead><tr><th>Fichier</th><th>Préparé</th><th>Lignes</th><th>Preuve</th><th>Statut</th><th className="is-actions">Actions</th></tr></thead><tbody>{imports.map((batch) => {
            const rows = extractList(batch, ["rows"]);
            const invalid = rows.filter((row) => row.validationStatus === "INVALID").length;
            const actionable = batch.status === "STAGED" || batch.status === "REVIEW_REQUIRED";
            const canRevise = batch.status === "REVIEW_REQUIRED" || batch.status === "VOIDED";
            const rowCount = Number(batch.rowCount ?? rows.length);
            const invalidCount = Number(batch.invalidRowCount ?? invalid);
            return <tr key={batch.id}><td><strong>{batch.sourceName}</strong><small>{batch.sourceStoredPath ? "Copie gérée localement" : "Empreinte enregistrée"}</small></td><td>{formatDate(batch.importedAt ?? batch.createdAt)}<small>Révision {batch.revision ?? 1}</small></td><td>{rowCount}<small>{invalidCount ? `${invalidCount} invalide(s)` : "Toutes valides"}</small></td><td><code title={`Source ${batch.sourceSha256}\nPérimètre ${batch.scopeSha256}`}>{String(batch.sourceSha256 ?? "—").slice(0, 8)} · {String(batch.scopeSha256 ?? "—").slice(0, 8)}</code></td><td><StatusChip value={batch.status} /></td><td className="is-actions">{batch.status === "STAGED" && <button type="button" className="books13-button books13-button--small books13-button--primary" onClick={() => setConfirmBatchId(batch.id)}><CheckCircle2 size={14} /> Confirmer</button>}{actionable && <button type="button" className="books13-button books13-button--small books13-button--quiet" onClick={() => setCancelBatchId(batch.id)}><CircleSlash2 size={14} /> Annuler</button>}{canRevise && <button type="button" className="books13-button books13-button--small books13-button--quiet" onClick={() => { setPendingSupersedes(batch); setSource(null); setMapping(blankMapping()); setMappingProposal(null); setError(""); notify("Resélectionnez le fichier original pour reprendre ce périmètre sans perdre sa traçabilité.", "info"); }}><RefreshCw size={14} /> Reprendre cet import</button>}</td></tr>;
          })}</tbody></table></div>
        )}
      </section>

      <AnimatePresence>
        {confirmBatchId && <ConfirmDialog title="Créer les brouillons de ce lot ?" confirmLabel="Créer les brouillons" tone="primary" busy={loading} onClose={() => setConfirmBatchId(null)} onConfirm={() => confirm(confirmBatchId)}><p>Wheat revérifiera les journaux, les comptes, les exercices, les montants et l’équilibre. Aucune écriture ne sera comptabilisée automatiquement.</p></ConfirmDialog>}
        {cancelBatchId && <ConfirmDialog title="Annuler le lot préparé ?" confirmLabel="Annuler le lot" tone="danger" busy={loading} confirmDisabled={!cancelReason.trim()} onClose={() => { setCancelBatchId(null); setCancelReason(""); }} onConfirm={cancel}><label className="books13-field"><span>Motif conservé dans l’audit</span><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={500} data-autofocus /></label></ConfirmDialog>}
      </AnimatePresence>
    </div>
  );
}

function ConfirmDialog({ title, confirmLabel, tone, busy, confirmDisabled, onClose, onConfirm, children }: { title: string; confirmLabel: string; tone: "primary" | "danger"; busy?: boolean; confirmDisabled?: boolean; onClose: () => void; onConfirm: () => void | Promise<void>; children: ReactNode }) {
  const dialogRef = useAccessibleDialog<HTMLDivElement>(onClose);
  return <motion.div className="books13-dialog-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><motion.div ref={dialogRef} className="books13-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} initial={{ scale: 0.98, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.98, y: 5 }}><header><h3>{title}</h3><button type="button" className="books13-icon-button" onClick={onClose} aria-label="Fermer"><X size={17} /></button></header><div className="books13-dialog__body">{children}</div><footer><button type="button" className="books13-button books13-button--quiet" onClick={onClose}>Retour</button><button type="button" className={`books13-button books13-button--${tone}`} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="books13-spin" /> : tone === "danger" ? <CircleSlash2 size={15} /> : <Check size={15} />}{confirmLabel}</button></footer></motion.div></motion.div>;
}

function ConfigurationWorkspace({ companyId, fallbackCompanyName, fallbackCurrency, fallbackAccounts, fallbackJournals, notify, onChanged }: {
  companyId: string;
  fallbackCompanyName: string;
  fallbackCurrency: string;
  fallbackAccounts: BooksAccountOption[];
  fallbackJournals: BooksJournalOption[];
  notify: (message: string, tone: NoticeTone) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [area, setArea] = useState<ConfigurationArea>("company");
  const [workspace, setWorkspace] = useState<LooseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [companyForm, setCompanyForm] = useState({ name: fallbackCompanyName, legalForm: "", ice: "", taxId: "", city: "", vatFrequency: "MONTHLY", expectedVersion: 1 });
  const [fiscalForm, setFiscalForm] = useState<LooseRecord>({ label: "", startsOn: `${new Date().getFullYear()}-01-01`, endsOn: `${new Date().getFullYear()}-12-31` });
  const [accountForm, setAccountForm] = useState<LooseRecord>({ code: "", label: "", classNo: "", type: "ASSET" });
  const [journalForm, setJournalForm] = useState<LooseRecord>({ code: "", label: "", locked: false });
  const [bankForm, setBankForm] = useState<LooseRecord>({ bankName: "", iban: "", currency: fallbackCurrency, ledgerAccountId: "" });
  const fallbackRef = useRef({ fallbackCompanyName, fallbackCurrency, fallbackAccounts, fallbackJournals });
  const refreshRequestId = useRef(0);
  useEffect(() => {
    fallbackRef.current = { fallbackCompanyName, fallbackCurrency, fallbackAccounts, fallbackJournals };
  }, [fallbackAccounts, fallbackCompanyName, fallbackCurrency, fallbackJournals]);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    const fallback = fallbackRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await callBridge<LooseRecord>("getSettingsWorkspace", { companyId });
      if (requestId !== refreshRequestId.current) return;
      setWorkspace(response);
      setCompanyForm({
        name: String(response.name ?? fallback.fallbackCompanyName), legalForm: String(response.legalForm ?? ""), ice: String(response.ice ?? ""),
        taxId: String(response.taxId ?? ""), city: String(response.city ?? ""), vatFrequency: String(response.vatFrequency ?? "MONTHLY"), expectedVersion: Number(response.version ?? 1),
      });
    } catch (caught) {
      if (requestId !== refreshRequestId.current) return;
      const message = errorMessage(caught);
      setError(message);
      setWorkspace({ name: fallback.fallbackCompanyName, baseCurrency: fallback.fallbackCurrency, accounts: fallback.fallbackAccounts, journals: fallback.fallbackJournals, fiscalYears: [], bankAccounts: [] });
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    setSearch("");
    setFiscalForm({ label: "", startsOn: `${new Date().getFullYear()}-01-01`, endsOn: `${new Date().getFullYear()}-12-31` });
    setAccountForm({ code: "", label: "", classNo: "", type: "ASSET" });
    setJournalForm({ code: "", label: "", locked: false });
    setBankForm({ bankName: "", iban: "", currency: fallbackRef.current.fallbackCurrency, ledgerAccountId: "" });
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    if (area !== "drafts" || !workspace || Array.isArray(workspace.entries) || Array.isArray(workspace.draftEntries) || !hasBridgeMethod("getBootstrap")) return;
    callBridge<LooseRecord>("getBootstrap", companyId)
      .then((bootstrap) => {
        if (cancelled) return;
        setWorkspace((current) => current ? { ...current, draftEntries: extractList(bootstrap, ["entries"]).filter((entry) => entry.status === "DRAFT") } : current);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => { cancelled = true; };
  }, [area, companyId, workspace]);

  /*
   * Unfinished referential work survives leaving the screen.
   *
   * These five forms are where a dossier is built: its identity, its exercises,
   * its accounts, its journals and the bank account mapped to a ledger account.
   * They were the last meaningful composers still holding their contents in
   * component state, which meant switching areas in the rail — or opening
   * another dossier and coming back — discarded whatever had been typed.
   *
   * Each is drafted under its own identity, so an unfinished account and an
   * unfinished journal are two separate pieces of work and neither overwrites
   * the other. Restoring waits for the initial read to finish: the workspace
   * seeds these forms from the dossier, and held work must be applied on top of
   * that seeding rather than under it.
   */
  const drafting = !loading && Boolean(companyId);
  const companyDraft = useDraftedForm({
    companyId, entity: "settings.company", draftKey: "current",
    currentVersion: Number(companyForm.expectedVersion ?? 1),
    open: drafting && area === "company",
    value: companyForm,
    onRestore: (payload) => setCompanyForm((current) => ({ ...current, ...payload, expectedVersion: current.expectedVersion })),
    onStale: () => notify("La société a été modifiée ailleurs : votre saisie non enregistrée n'a pas été réappliquée.", "warning"),
  });
  const fiscalDraft = useDraftedForm<LooseRecord>({
    companyId, entity: "settings.fiscal_year", draftKey: String(fiscalForm.id ?? "new"),
    open: drafting && area === "fiscal-years",
    value: fiscalForm,
    onRestore: (payload) => setFiscalForm(payload),
  });
  const accountDraft = useDraftedForm<LooseRecord>({
    companyId, entity: "settings.account", draftKey: String(accountForm.id ?? "new"),
    open: drafting && area === "accounts",
    value: accountForm,
    onRestore: (payload) => setAccountForm(payload),
  });
  const journalDraft = useDraftedForm<LooseRecord>({
    companyId, entity: "settings.journal", draftKey: String(journalForm.id ?? "new"),
    open: drafting && area === "journals",
    value: journalForm,
    onRestore: (payload) => setJournalForm(payload),
  });
  const bankDraft = useDraftedForm<LooseRecord>({
    companyId, entity: "settings.bank_account", draftKey: String(bankForm.id ?? "new"),
    open: drafting && area === "banks",
    value: bankForm,
    onRestore: (payload) => setBankForm(payload),
  });

  const finishMutation = async (message: string) => {
    await refresh();
    await onChanged?.();
    notify(message, "success");
  };

  const runMutation = async (
    method: string,
    payload: LooseRecord,
    message: string,
    reset?: () => void,
    // Cleared here and nowhere else: after the domain service confirmed the
    // write, never in a `finally` and never on unmount.
    draft?: { clear: () => Promise<unknown> },
  ) => {
    setSaving(true);
    setError("");
    try {
      await callBridge(method, { companyId, ...payload });
      await draft?.clear();
      reset?.();
      await finishMutation(message);
    } catch (caught) {
      const text = errorMessage(caught);
      setError(text);
      notify(text, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveCompany = (event: FormEvent) => {
    event.preventDefault();
    void runMutation("updateCompanySettings", companyForm, "Paramètrès de la société enregistrés.", undefined, companyDraft);
  };

  const saveFiscal = (event: FormEvent) => {
    event.preventDefault();
    void runMutation("saveFiscalYear", fiscalForm, fiscalForm.id ? "Exercice modifié." : "Exercice créé.", () => setFiscalForm({ label: "", startsOn: `${new Date().getFullYear()}-01-01`, endsOn: `${new Date().getFullYear()}-12-31` }), fiscalDraft);
  };

  const saveAccount = (event: FormEvent) => {
    event.preventDefault();
    void runMutation("saveAccount", { ...accountForm, classNo: Number.parseInt(String(accountForm.classNo), 10) }, accountForm.id ? "Compte modifié." : "Compte créé.", () => setAccountForm({ code: "", label: "", classNo: "", type: "ASSET" }), accountDraft);
  };

  const saveJournal = (event: FormEvent) => {
    event.preventDefault();
    void runMutation("saveJournal", journalForm, journalForm.id ? "Journal modifié." : "Journal créé.", () => setJournalForm({ code: "", label: "", locked: false }), journalDraft);
  };

  const saveBank = (event: FormEvent) => {
    event.preventDefault();
    void runMutation("saveBankAccount", bankForm, bankForm.id ? "Compte bancaire modifié." : "Compte bancaire créé.", () => setBankForm({ bankName: "", iban: "", currency: fallbackCurrency, ledgerAccountId: "" }), bankDraft);
  };

  const accounts = extractList(workspace, ["accounts"]);
  const journals = extractList(workspace, ["journals"]);
  const fiscalYears = extractList(workspace, ["fiscalYears"]);
  const bankAccounts = extractList(workspace, ["bankAccounts"]);
  const drafts = extractList(workspace, ["entries", "draftEntries", "drafts"]);
  const normalizedSearch = search.trim().toLocaleLowerCase("fr");
  const filter = (rows: LooseRecord[]) => normalizedSearch ? rows.filter((row) => Object.values(row).some((value) => typeof value === "string" && value.toLocaleLowerCase("fr").includes(normalizedSearch))) : rows;

  return (
    <div className="books13-workspace books13-workspace--settings">
      <aside className="books13-rail books13-rail--settings">
        <div className="books13-rail__title"><Settings2 size={16} /> Référentiels</div>
        {configurationAreas.map((item) => <button key={item.id} type="button" className={area === item.id ? "is-active" : ""} onClick={() => { setArea(item.id); setSearch(""); }}><strong>{item.label}</strong><ChevronDown size={14} /></button>)}
        <div className="books13-ledger-note"><ShieldCheck size={16} /><p><strong>Version contrôlée</strong><span>Une modification concurrente impose une actualisation.</span></p></div>
      </aside>
      <main className="books13-main">
        <div className="books13-section-head"><div><span>Maintenance</span><h3>{configurationAreas.find((item) => item.id === area)?.label}</h3><p>Les objets déjà utilisés restent traçables ; archivez-les au lieu d’effacer leur historique.</p></div><button type="button" className="books13-button books13-button--quiet" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? "books13-spin" : ""} /> Actualiser</button></div>
        {error && <div className="books13-message books13-message--error"><AlertTriangle size={16} /><span>{error}</span></div>}
        {loading && !workspace ? <LoadingLine /> : (
          <>
            {area !== "company" && area !== "drafts" && <div className="books13-list-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filtrer la liste" /></div>}
            {area === "company" && <form className="books13-settings-form" onSubmit={saveCompany}>
              <FormHeading title="Identité comptable" note="Les identifiants restent distincts : ICE, identifiant fiscal et forme juridique." />
              <div className="books13-form-grid"><Field label="Raison sociale"><input required value={companyForm.name} onChange={(event) => setCompanyForm((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="Forme juridique"><input required value={companyForm.legalForm} onChange={(event) => setCompanyForm((current) => ({ ...current, legalForm: event.target.value }))} /></Field><Field label="ICE · 15 chiffres"><input inputMode="numeric" pattern="[0-9]{15}|^$" maxLength={15} value={companyForm.ice} onChange={(event) => setCompanyForm((current) => ({ ...current, ice: event.target.value.replace(/\D/g, "") }))} /></Field><Field label="Identifiant fiscal"><input value={companyForm.taxId} onChange={(event) => setCompanyForm((current) => ({ ...current, taxId: event.target.value }))} /></Field><Field label="Ville"><input required value={companyForm.city} onChange={(event) => setCompanyForm((current) => ({ ...current, city: event.target.value }))} /></Field><Field label="Fréquence TVA"><select value={companyForm.vatFrequency} onChange={(event) => setCompanyForm((current) => ({ ...current, vatFrequency: event.target.value }))}><option value="MONTHLY">Mensuelle</option><option value="QUARTERLY">Trimestrielle</option></select></Field></div>
              <FormActions busy={saving} label="Enregistrer la société" />
            </form>}

            {area === "fiscal-years" && <div className="books13-settings-split"><EntityList title="Exercices" rows={filter(fiscalYears)} render={(row) => <><span><strong>{row.label}</strong><small>{formatDate(row.startsOn)} → {formatDate(row.endsOn)}</small></span><StatusChip value={row.status} /></>} onEdit={(row) => setFiscalForm({ id: row.id, label: row.label, startsOn: String(row.startsOn).slice(0, 10), endsOn: String(row.endsOn).slice(0, 10), expectedVersion: row.version })} /><form className="books13-settings-form" onSubmit={saveFiscal}><FormHeading title={fiscalForm.id ? "Modifier l’exercice" : "Nouvel exercice"} note="Les périodes ne peuvent pas se chevaucher." /><div className="books13-form-grid"><Field label="Libellé"><input required value={fiscalForm.label} onChange={(event) => setFiscalForm((current) => ({ ...current, label: event.target.value }))} /></Field><Field label="Début"><input required type="date" value={fiscalForm.startsOn} onChange={(event) => setFiscalForm((current) => ({ ...current, startsOn: event.target.value }))} /></Field><Field label="Fin"><input required type="date" value={fiscalForm.endsOn} onChange={(event) => setFiscalForm((current) => ({ ...current, endsOn: event.target.value }))} /></Field></div><FormActions busy={saving} label={fiscalForm.id ? "Enregistrer" : "Créer l’exercice"} onReset={fiscalForm.id ? () => setFiscalForm({ label: "", startsOn: `${new Date().getFullYear()}-01-01`, endsOn: `${new Date().getFullYear()}-12-31` }) : undefined} /></form></div>}

            {area === "accounts" && <div className="books13-settings-split"><EntityList title={`Plan comptable · ${accounts.length}`} rows={filter(accounts)} render={(row) => <><span><strong>{row.code} · {row.label}</strong><small>Classe {row.classNo} · {row.type}</small></span><StatusChip value={row.active === false ? "VOIDED" : "OK"} label={row.active === false ? "Archivé" : "Actif"} /></>} onEdit={(row) => setAccountForm({ id: row.id, code: row.code, label: row.label, classNo: row.classNo, type: row.type, expectedVersion: row.version })} onToggle={(row) => runMutation("setAccountActive", { id: row.id, expectedVersion: row.version, active: row.active === false }, row.active === false ? "Compte restauré." : "Compte archivé.")} /><form className="books13-settings-form" onSubmit={saveAccount}><FormHeading title={accountForm.id ? "Modifier le compte" : "Nouveau compte"} note="Le numéro d’un compte utilisé devient une référence historique." /><div className="books13-form-grid"><Field label="Numéro"><input required maxLength={20} value={accountForm.code} onChange={(event) => setAccountForm((current) => ({ ...current, code: event.target.value.toUpperCase(), classNo: event.target.value[0] ?? current.classNo }))} /></Field><Field label="Libellé"><input required value={accountForm.label} onChange={(event) => setAccountForm((current) => ({ ...current, label: event.target.value }))} /></Field><Field label="Classe"><WheatSelect
              required
              ariaLabel="Classe du compte"
              placeholder="Choisir une classe…"
              value={accountForm.classNo}
              onChange={(value) => setAccountForm((current) => ({ ...current, classNo: value }))}
              options={Array.from({ length: 10 }, (_, index): WheatSelectOption => ({
                value: String(index),
                label: `Classe ${index}`,
              }))}
            /></Field><Field label="Nature"><select value={accountForm.type} onChange={(event) => setAccountForm((current) => ({ ...current, type: event.target.value }))}><option value="ASSET">Actif</option><option value="LIABILITY">Passif</option><option value="EQUITY">Capitaux propres</option><option value="EXPENSE">Charge</option><option value="REVENUE">Produit</option><option value="MEMO">Mémo</option></select></Field></div><FormActions busy={saving} label={accountForm.id ? "Enregistrer" : "Créer le compte"} onReset={accountForm.id ? () => setAccountForm({ code: "", label: "", classNo: "", type: "ASSET" }) : undefined} /></form></div>}

            {area === "journals" && <div className="books13-settings-split"><EntityList title={`Journaux · ${journals.length}`} rows={filter(journals)} render={(row) => <><span><strong>{row.code} · {row.label}</strong><small>{row.locked ? "Saisie verrouillée" : "Saisie ouverte"}</small></span><StatusChip value={row.active === false ? "VOIDED" : "OK"} label={row.active === false ? "Archivé" : "Actif"} /></>} onEdit={(row) => setJournalForm({ id: row.id, code: row.code, label: row.label, locked: row.locked, expectedVersion: row.version })} onToggle={(row) => runMutation("setJournalActive", { id: row.id, expectedVersion: row.version, active: row.active === false }, row.active === false ? "Journal restauré." : "Journal archivé.")} /><form className="books13-settings-form" onSubmit={saveJournal}><FormHeading title={journalForm.id ? "Modifier le journal" : "Nouveau journal"} note="Le verrouillage bloque la saisie et les imports dans ce journal." /><div className="books13-form-grid"><Field label="Code"><input required maxLength={20} value={journalForm.code} onChange={(event) => setJournalForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} /></Field><Field label="Libellé"><input required value={journalForm.label} onChange={(event) => setJournalForm((current) => ({ ...current, label: event.target.value }))} /></Field><label className="books13-check books13-check--form"><input type="checkbox" checked={journalForm.locked === true} onChange={(event) => setJournalForm((current) => ({ ...current, locked: event.target.checked }))} /><span>Verrouiller la saisie</span></label></div><FormActions busy={saving} label={journalForm.id ? "Enregistrer" : "Créer le journal"} onReset={journalForm.id ? () => setJournalForm({ code: "", label: "", locked: false }) : undefined} /></form></div>}

            {area === "banks" && <div className="books13-settings-split"><EntityList title={`Comptes bancaires · ${bankAccounts.length}`} rows={filter(bankAccounts)} render={(row) => <><span><strong>{row.bankName}</strong><small>{row.iban} · {row.ledgerAccount?.code ?? "Sans compte"}</small></span><StatusChip value={row.active === false ? "VOIDED" : "OK"} label={row.active === false ? "Archivé" : "Actif"} /></>} onEdit={(row) => setBankForm({ id: row.id, bankName: row.bankName, iban: row.iban, currency: row.currency, ledgerAccountId: row.ledgerAccountId, expectedVersion: row.version })} onToggle={(row) => runMutation("setBankAccountActive", { id: row.id, expectedVersion: row.version, active: row.active === false }, row.active === false ? "Compte bancaire restauré." : "Compte bancaire archivé.")} /><form className="books13-settings-form" onSubmit={saveBank}><FormHeading title={bankForm.id ? "Modifier la banque" : "Nouveau compte bancaire"} note="Le compte comptable doit être un compte actif de classe 5." /><div className="books13-form-grid"><Field label="Banque"><input required value={bankForm.bankName} onChange={(event) => setBankForm((current) => ({ ...current, bankName: event.target.value }))} /></Field><Field label="IBAN ou identifiant"><input required value={bankForm.iban} onChange={(event) => setBankForm((current) => ({ ...current, iban: event.target.value }))} /></Field><Field label="Devise"><input readOnly value={bankForm.currency ?? "MAD"} /></Field><Field label="Compte de classe 5"><WheatSelect
              required
              ariaLabel="Compte comptable rattaché"
              placeholder="Choisir un compte 514…"
              searchPlaceholder="Numéro ou libellé du compte…"
              noOptionsLabel="Aucun compte de trésorerie disponible"
              value={bankForm.ledgerAccountId}
              onChange={(value) => setBankForm((current) => ({ ...current, ledgerAccountId: value }))}
              options={accounts.map((item: LooseRecord): WheatSelectOption => ({
                value: String(item.id),
                label: `${item.code} — ${item.label}`,
                keywords: String(item.label ?? ""),
              }))}
            /></Field></div><FormActions busy={saving} label={bankForm.id ? "Enregistrer" : "Créer le compte"} onReset={bankForm.id ? () => setBankForm({ bankName: "", iban: "", currency: fallbackCurrency, ledgerAccountId: "" }) : undefined} /></form></div>}

            {area === "drafts" && <DraftEditor companyId={companyId} drafts={drafts} accounts={accounts} journals={journals} busy={saving} notify={notify} runMutation={runMutation} />}
          </>
        )}
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="books13-field"><span>{label}</span>{children}</label>;
}

function FormHeading({ title, note }: { title: string; note: string }) {
  return <div className="books13-form-heading"><div><h4>{title}</h4><p>{note}</p></div></div>;
}

function FormActions({ busy, label, onReset }: { busy: boolean; label: string; onReset?: () => void }) {
  return <div className="books13-form-actions">{onReset && <button type="button" className="books13-button books13-button--quiet" onClick={onReset}>Annuler la modification</button>}<button type="submit" className="books13-button books13-button--primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="books13-spin" /> : <Save size={15} />}{label}</button></div>;
}

function EntityList({ title, rows, render, onEdit, onToggle }: { title: string; rows: LooseRecord[]; render: (row: LooseRecord) => ReactNode; onEdit: (row: LooseRecord) => void; onToggle?: (row: LooseRecord) => void | Promise<void> }) {
  return <section className="books13-entity-list"><h4>{title}</h4>{!rows.length ? <EmptyState title="Aucun élément">Créez le premier élément dans le formulaire.</EmptyState> : <div>{rows.map((row) => <article key={row.id}><div>{render(row)}</div><span className="books13-entity-actions"><button type="button" className="books13-icon-button" aria-label="Modifier" onClick={() => onEdit(row)}><Pencil size={14} /></button>{onToggle && <button type="button" className="books13-icon-button" aria-label={row.active === false ? "Restaurer" : "Archiver"} onClick={() => onToggle(row)}>{row.active === false ? <RefreshCw size={14} /> : <Archive size={14} />}</button>}</span></article>)}</div>}</section>;
}

function DraftEditor({ companyId, drafts, accounts, journals, busy, notify, runMutation }: { companyId: string; drafts: LooseRecord[]; accounts: LooseRecord[]; journals: LooseRecord[]; busy: boolean; notify: (message: string, tone: NoticeTone) => void; runMutation: (method: string, payload: LooseRecord, message: string, reset?: () => void) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = drafts.find((item) => item.id === selectedId);
  const [form, setForm] = useState<LooseRecord | null>(null);
  useEffect(() => {
    if (!selected) { setForm(null); return; }
    setForm({
      entryId: selected.id, expectedVersion: selected.version, journalId: selected.journalId, date: String(selected.date).slice(0, 10), pieceNumber: selected.pieceNumber,
      label: selected.label, lines: extractList(selected, ["lines"]).map((line) => ({ id: line.id, accountId: line.accountId, label: line.label, debit: centsToDecimal(line.debitCents), credit: centsToDecimal(line.creditCents), thirdParty: line.thirdParty ?? "", counterpartyId: line.counterpartyId ?? null })),
    });
  }, [selected]);
  if (!drafts.length) return <EmptyState icon={FileClock} title="Aucun brouillon dans cet espace">La maintenance des brouillons apparaît ici lorsque le service de réglages les fournit. Les pièces comptabilisées restent immuables.</EmptyState>;
  const updateLine = (index: number, key: string, value: string) => setForm((current) => current ? ({ ...current, lines: current.lines.map((line: LooseRecord, rowIndex: number) => rowIndex === index ? { ...line, [key]: value } : line) }) : current);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const lines = form.lines.map((line: LooseRecord, index: number) => {
      const debitCents = decimalToCents(line.debit);
      const creditCents = decimalToCents(line.credit);
      if (debitCents === null || creditCents === null) throw new Error(`Montant exact invalide à la ligne ${index + 1}.`);
      return { accountId: line.accountId, label: line.label, debitCents, creditCents, thirdParty: line.thirdParty || null, counterpartyId: line.counterpartyId || null };
    });
    await runMutation("updateEntryDraft", { ...form, companyId, lines }, "Brouillon modifié.", () => setSelectedId(""));
    notify("Vérifiez puis comptabilisez le brouillon depuis les écritures.", "info");
  };
  return <div className="books13-drafts"><div className="books13-message books13-message--info"><ShieldCheck size={16} /><span>Seuls les brouillons sont modifiables. Les montants sont convertis en centimes exacts avant envoi.</span></div><label className="books13-field"><span>Brouillon à corriger</span><WheatSelect
      ariaLabel="Brouillon à modifier"
      placeholder="Choisir un brouillon…"
      searchPlaceholder="Numéro ou libellé…"
      noOptionsLabel="Aucun brouillon en attente"
      value={selectedId}
      onChange={setSelectedId}
      options={drafts.map((draft: LooseRecord): WheatSelectOption => ({
        value: String(draft.id),
        label: String(draft.label ?? draft.number ?? draft.id),
        note: draft.date ? formatDate(draft.date) : undefined,
      }))}
    /></label>{form && <form className="books13-settings-form" onSubmit={(event) => { void save(event).catch((caught) => notify(errorMessage(caught), "error")); }}><div className="books13-form-grid"><Field label="Journal"><WheatSelect
      ariaLabel="Journal du brouillon"
      placeholder="Choisir un journal…"
      searchPlaceholder="Code ou libellé du journal…"
      noOptionsLabel="Aucun journal disponible"
      value={form.journalId}
      onChange={(value) => setForm((current: LooseRecord) => ({ ...current, journalId: value }))}
      options={journals.map((journal: LooseRecord): WheatSelectOption => ({
        value: String(journal.id),
        label: `${journal.code} — ${journal.label}`,
        keywords: String(journal.label ?? ""),
      }))}
    /></Field><Field label="Date"><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></Field><Field label="Pièce"><input value={form.pieceNumber} onChange={(event) => setForm({ ...form, pieceNumber: event.target.value })} /></Field><Field label="Libellé"><input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></Field></div><div className="books13-draft-lines"><div className="books13-draft-lines__head"><span>Compte</span><span>Libellé</span><span>Débit MAD</span><span>Crédit MAD</span></div>{form.lines.map((line: LooseRecord, index: number) => <div key={line.id ?? index}><WheatSelect
        ariaLabel={`Compte de la ligne ${index + 1}`}
        placeholder="Choisir un compte…"
        searchPlaceholder="Numéro ou libellé du compte…"
        noOptionsLabel="Aucun compte disponible"
        size="sm"
        value={line.accountId}
        onChange={(value) => updateLine(index, "accountId", value)}
        options={accounts.map((account: LooseRecord): WheatSelectOption => ({
          value: String(account.id),
          label: `${account.code} — ${account.label}`,
          keywords: String(account.label ?? ""),
        }))}
      /><input value={line.label} onChange={(event) => updateLine(index, "label", event.target.value)} /><input inputMode="decimal" value={line.debit} onChange={(event) => updateLine(index, "debit", event.target.value)} /><input inputMode="decimal" value={line.credit} onChange={(event) => updateLine(index, "credit", event.target.value)} /></div>)}</div><FormActions busy={busy} label="Enregistrer le brouillon" /></form>}</div>;
}

function sumCents(rows: LooseRecord[], key: string): string {
  return rows.reduce((sum, row) => {
    const raw = String(row[key] ?? "0");
    return /^-?\d+$/.test(raw) ? sum + BigInt(raw) : sum;
  }, 0n).toString();
}

function ControlWorkspace({ companyId, currency, notify, onChanged }: { companyId: string; currency: string; notify: (message: string, tone: NoticeTone) => void; onChanged?: () => void | Promise<void> }) {
  const [audit, setAudit] = useState<LooseRecord | null>(null);
  const [events, setEvents] = useState<LooseRecord[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<LooseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [voidRun, setVoidRun] = useState<LooseRecord | null>(null);
  const [voidDate, setVoidDate] = useState(todayIso);
  const [voidReason, setVoidReason] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all([
        callBridge<LooseRecord>("verifyAuditChain", { companyId }),
        callBridge<unknown>("listAuditEvents", { companyId, take: 100 }),
        callBridge<unknown>("listPayrollRuns", { companyId, take: 100 }),
      ]);
      setAudit(results[0]);
      setEvents(extractList(results[1], ["events"]));
      setPayrollRuns(extractList(results[2], ["payrollRuns", "runs"]));
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const confirmVoid = async () => {
    if (!voidRun || !voidReason.trim() || !voidDate) return;
    setActing(true);
    setError("");
    try {
      await callBridge("voidPayrollRun", { companyId, payrollRunId: voidRun.id, expectedVersion: voidRun.version, date: voidDate, reason: voidReason.trim() });
      setVoidRun(null);
      setVoidReason("");
      await refresh();
      await onChanged?.();
      notify("Paie annulée par une écriture d’extourne traçable.", "success");
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "error");
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="books13-control">
      <div className="books13-section-head"><div><span>Gouvernance locale</span><h3>Audit et corrections</h3><p>Vérifiez l’enchaînement des événements et corrigez la paie par extourne, sans réécrire l’historique.</p></div><button type="button" className="books13-button books13-button--primary" disabled={loading} onClick={refresh}><RefreshCw size={15} className={loading ? "books13-spin" : ""} /> Revérifier</button></div>
      {error && <div className="books13-message books13-message--error"><AlertTriangle size={16} /><span>{error}</span></div>}
      {loading && !audit ? <LoadingLine label="Vérification locale de la chaîne et des paies…" /> : <>
        <section className="books13-audit-summary">
          <div className={`books13-audit-mark ${audit?.valid ? "is-valid" : "is-invalid"}`}>{audit?.valid ? <ShieldCheck size={28} /> : <AlertTriangle size={28} />}</div>
          <div><span className="books13-eyebrow">Chaîne d’audit SHA-256</span><h3>{audit?.valid ? "Chaîne vérifiable" : "Chaîne incohérente"}</h3><p>{audit?.valid ? "Les événements chaînés présents concordent avec leur empreinte et leur ordre." : "Une ou plusieurs incohérences exigent une investigation et une sauvegarde immédiate."}</p></div>
          <dl><div><dt>Événements</dt><dd>{audit?.eventCount ?? 0}</dd></div><div><dt>Chaînés</dt><dd>{audit?.chainedCount ?? 0}</dd></div><div><dt>Hérités non scellés</dt><dd>{audit?.importedUnsealedCount ?? 0}</dd></div><div><dt>Dernière séquence</dt><dd>{audit?.lastSequence ?? "0"}</dd></div></dl>
        </section>
        {(audit?.problems?.length ?? 0) > 0 && <div className="books13-problems"><h4>Incohérences détectées</h4>{(audit?.problems ?? []).map((problem: string, index: number) => <p key={`${problem}-${index}`}><XCircle size={15} /> {problem}</p>)}</div>}
        {audit?.importedUnsealedCount > 0 && <div className="books13-message books13-message--warning"><AlertTriangle size={16} /><span><strong>Historique antérieur non scellé.</strong> Wheat ne fabrique pas de preuve rétroactive : ces événements sont clairement distingués du segment vérifiable.</span></div>}

        <div className="books13-control-grid">
          <section className="books13-control-section">
            <div className="books13-subhead"><div><span>Journal de preuve</span><h4>Derniers événements</h4></div><span>{events.length} affiché(s)</span></div>
            {!events.length ? <EmptyState icon={History} title="Aucun événement chaîné">La prochaine opération prise en charge démarrera la chaîne vérifiable.</EmptyState> : <div className="books13-audit-events">{events.map((event) => <article key={event.id}><span className={`books13-event-dot is-${statusTone(event.integrityStatus)}`} /><div><strong>{event.description ?? event.action}</strong><p>{event.entityType}{event.entityId ? ` · ${event.entityId}` : ""}</p><small>{new Date(event.occurredAt ?? event.createdAt).toLocaleString("fr-MA")} · {event.actorSnapshot?.name ?? event.actor?.name ?? "Opérateur local"}</small></div><span><StatusChip value={event.integrityStatus} /><code>#{event.sequence}</code></span></article>)}</div>}
          </section>

          <section className="books13-control-section">
            <div className="books13-subhead"><div><span>Paie</span><h4>Runs et corrections</h4></div><span>{payrollRuns.length} affiché(s)</span></div>
            {!payrollRuns.length ? <EmptyState icon={Banknote} title="Aucune paie enregistrée">Les paies comptabilisées apparaîtront ici avec leur pièce et leur extourne éventuelle.</EmptyState> : <div className="books13-payroll-list">{payrollRuns.map((run) => {
              const lines = extractList(run, ["lines"]);
              return <article key={run.id}><div><strong>{run.period}</strong><small>{lines.length} salarié(s) · Net {formatCents(sumCents(lines, "netSalaryCents"), currency)}</small></div><div><StatusChip value={run.status} />{run.postedEntry?.number && <small>Pièce {run.postedEntry.number}</small>}{run.voidEntry?.number && <small>Extourne {run.voidEntry.number}</small>}</div>{run.status === "POSTED" && !run.voidEntryId && <button type="button" className="books13-button books13-button--small books13-button--quiet" onClick={() => { setVoidRun(run); setVoidDate(todayIso()); }}><CircleSlash2 size={14} /> Extourner</button>}</article>;
            })}</div>}
          </section>
        </div>
      </>}

      <AnimatePresence>{voidRun && <ConfirmDialog title={`Extourner la paie ${voidRun.period} ?`} confirmLabel="Créer l’extourne" tone="danger" busy={acting} confirmDisabled={!voidReason.trim() || !voidDate} onClose={() => { setVoidRun(null); setVoidReason(""); }} onConfirm={confirmVoid}><div className="books13-message books13-message--warning"><AlertTriangle size={16} /><span>La paie d’origine restera conservée. Wheat créera une écriture inverse comptabilisée et liera les deux preuves.</span></div><div className="books13-form-grid"><Field label="Date comptable de l’extourne"><input type="date" required value={voidDate} onChange={(event) => setVoidDate(event.target.value)} /></Field><Field label="Motif obligatoire"><textarea required maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} data-autofocus /></Field></div></ConfirmDialog>}</AnimatePresence>
    </div>
  );
}

export default BooksWorkspace13;
