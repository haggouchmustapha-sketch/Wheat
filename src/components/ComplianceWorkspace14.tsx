import {
  AlertTriangle,
  BadgeCheck,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileCheck2,
  FileClock,
  FileMinus2,
  Fingerprint,
  History,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useDraftedForm } from "../lib/useFormDraft";
import { confirmWithAppFocus } from "../lib/confirmWithAppFocus";
import "./ComplianceWorkspace14.css";
import { WheatSelect, type WheatSelectOption } from "./ui/WheatSelect";

type LooseRecord = Record<string, any>;
type NoticeTone = "success" | "warning" | "error" | "info";
type ComplianceTab = "workpapers" | "configuration" | "close" | "integrity";

export interface ComplianceWorkspace14Props {
  companyId: string;
  companyName?: string;
  currency?: string;
  accounts?: Array<{ id: string; code: string; label: string; active?: boolean }>;
  documents?: Array<{ id: string; title: string; type?: string; contentSha256?: string | null }>;
  onChanged?: () => void | Promise<void>;
  onNotify?: (message: string, tone: NoticeTone) => void;
}

type RateDraft = {
  key: string;
  code: string;
  label: string;
  rate: string;
  direction: "COLLECTED" | "DEDUCTIBLE" | "BOTH";
  deductibility: string;
  accountId: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const currentYearStart = () => `${new Date().getFullYear()}-01-01`;
const currentYearEnd = () => `${new Date().getFullYear()}-12-31`;
const key = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const blankRate = (): RateDraft => ({ key: key(), code: "", label: "", rate: "20", direction: "BOTH", deductibility: "100", accountId: "" });

function api(): LooseRecord {
  return (window.wheat ?? {}) as LooseRecord;
}

async function callBridge<T = any>(method: string, payload: unknown): Promise<T> {
  const handler = api()[method];
  if (typeof handler !== "function") throw new Error(`La fonction « ${method} » n'est pas disponible dans cette version de Wheat.`);
  return handler(payload) as Promise<T>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rowsOf(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as LooseRecord).items)) return (value as LooseRecord).items;
  return [];
}

function workspaceRows(workspace: LooseRecord | null, ...keys: string[]) {
  for (const name of keys) {
    const rows = rowsOf(workspace?.[name]);
    if (rows.length || workspace?.[name]) return rows;
  }
  return [];
}

function formatDay(value: unknown) {
  const raw = String(value ?? "").slice(0, 10);
  const [year, month, day] = raw.split("-");
  return year && month && day ? `${day}/${month}/${year}` : "—";
}

function formatCents(value: unknown, currency = "MAD") {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "0").trim();
  if (!/^-?\d+$/.test(raw)) return "—";
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "").padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative && !/^0+$/.test(digits) ? "−" : ""}${whole},${digits.slice(-2)} ${currency}`;
}

function decimalToCents(value: string, label: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error(`${label} doit être un montant positif avec deux décimales au maximum.`);
  const [whole, fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}

function percentToBps(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("Le taux doit être un pourcentage positif avec deux décimales au maximum.");
  const [whole, fraction = ""] = normalized.split(".");
  const bps = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (bps < 0 || bps > 10_000) throw new Error("Le taux doit être compris entre 0 % et 100 %.");
  return bps;
}

function statusLabel(status: unknown) {
  const labels: Record<string, string> = {
    DRAFT: "Brouillon",
    ACTIVE: "Active",
    REVIEWED: "Revu",
    FILED: "Déposé hors Wheat",
    REOPENED: "Réouvert",
    COMPLETED: "Terminé",
    CLOSED: "Clôturé",
    OPEN: "Ouvert",
    POSTED: "Comptabilisé",
    VOIDED: "Annulé",
  };
  const value = String(status ?? "");
  return labels[value] ?? (value || "—");
}

function statusTone(status: unknown) {
  const value = String(status ?? "");
  if (["ACTIVE", "REVIEWED", "FILED", "COMPLETED", "CLOSED", "POSTED"].includes(value)) return "is-good";
  if (["DRAFT", "REOPENED", "OPEN"].includes(value)) return "is-warn";
  return "is-muted";
}

const tabs: Array<{ id: ComplianceTab; label: string; note: string; icon: typeof ClipboardCheck }> = [
  { id: "workpapers", label: "TVA", note: "Sources, calcul et preuve", icon: ClipboardCheck },
  { id: "configuration", label: "Règles", note: "Versions et taux revus", icon: SlidersHorizontal },
  { id: "close", label: "Clôture", note: "Contrôles avant verrouillage", icon: LockKeyhole },
  { id: "integrity", label: "Intégrité", note: "Points de contrôle locaux", icon: Fingerprint },
];

export function ComplianceWorkspace14({
  companyId,
  companyName = "Société active",
  currency = "MAD",
  accounts = [],
  documents = [],
  onChanged,
  onNotify,
}: ComplianceWorkspace14Props) {
  const [tab, setTab] = useState<ComplianceTab>("workpapers");
  const [workspace, setWorkspace] = useState<LooseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkpaperId, setSelectedWorkpaperId] = useState<string | null>(null);
  const [workpaperDetail, setWorkpaperDetail] = useState<LooseRecord | null>(null);
  const [closePreview, setClosePreview] = useState<LooseRecord | null>(null);
  const [configName, setConfigName] = useState("TVA sur encaissements");
  const [frequency, setFrequency] = useState<"MONTHLY" | "QUARTERLY">("MONTHLY");
  const [effectiveFrom, setEffectiveFrom] = useState(currentYearStart);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [rates, setRates] = useState<RateDraft[]>([blankRate()]);
  const [proposalApplied, setProposalApplied] = useState(false);
  const [periodStart, setPeriodStart] = useState(currentYearStart);
  const [periodEnd, setPeriodEnd] = useState(currentYearEnd);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [adjustment, setAdjustment] = useState({ direction: "COLLECTED", taxable: "", vat: "", reason: "", documentId: "" });
  const [evidence, setEvidence] = useState({ documentId: "", role: "SUPPORT", note: "" });
  const [filing, setFiling] = useState({ reference: "", filedOn: today(), documentId: "" });
  const [sealNote, setSealNote] = useState("");
  const workspaceRequestId = useRef(0);
  const workpaperRequestId = useRef(0);

  const notify = useCallback((message: string, tone: NoticeTone = "info") => {
    onNotify?.(message, tone);
  }, [onNotify]);

  const loadWorkspace = useCallback(async (quiet = false) => {
    const requestId = ++workspaceRequestId.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const next = await callBridge<LooseRecord>("getTaxWorkspace", { companyId });
      if (requestId !== workspaceRequestId.current) return;
      setWorkspace(next ?? {});
      const configs = workspaceRows(next, "configurations", "taxConfigurations");
      const active = configs.find((row) => row.status === "ACTIVE") ?? configs[0];
      setSelectedConfigId((current) => configs.some((row) => row.id === current && row.status === "ACTIVE") ? current : active?.id || "");
    } catch (loadError) {
      if (requestId === workspaceRequestId.current) setError(errorMessage(loadError));
    } finally {
      if (requestId === workspaceRequestId.current) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    workpaperRequestId.current += 1;
    setSelectedWorkpaperId(null);
    setWorkpaperDetail(null);
    setClosePreview(null);
    void loadWorkspace();
  }, [loadWorkspace]);

  const configurations = useMemo(() => workspaceRows(workspace, "configurations", "taxConfigurations"), [workspace]);
  const starterProposal = (workspace?.starterProposal ?? null) as LooseRecord | null;
  const workpapers = useMemo(() => workspaceRows(workspace, "workpapers", "vatWorkpapers"), [workspace]);
  const fiscalYears = useMemo(() => workspaceRows(workspace, "fiscalYears"), [workspace]);
  const closeRuns = useMemo(() => workspaceRows(workspace, "closeRuns", "fiscalCloseRuns"), [workspace]);
  const seals = useMemo(() => workspaceRows(workspace, "seals", "auditSeals"), [workspace]);
  const creditNotes = useMemo(() => workspaceRows(workspace, "creditNotes"), [workspace]);
  const hashedDocuments = useMemo(() => documents.filter((document) => document.contentSha256), [documents]);

  /**
   * Fills the form from the dossier's starter proposal. It stops at the form on
   * purpose: the accountant reads every rate, corrects what the activity
   * requires, and saves and activates under their own name, exactly as for a
   * configuration typed from nothing.
   */
  const applyStarterProposal = useCallback(() => {
    if (!starterProposal) return;
    setConfigName(String(starterProposal.name ?? "TVA sur encaissements"));
    setSourceReference(String(starterProposal.sourceReference ?? ""));
    setRates((Array.isArray(starterProposal.rates) ? starterProposal.rates : []).map((rate: LooseRecord): RateDraft => ({
      key: key(),
      code: String(rate.code ?? ""),
      label: String(rate.label ?? ""),
      rate: (Number(rate.rateBps ?? 0) / 100).toString(),
      direction: (rate.direction === "COLLECTED" || rate.direction === "DEDUCTIBLE" ? rate.direction : "BOTH"),
      deductibility: (Number(rate.deductibilityBps ?? 10_000) / 100).toString(),
      accountId: String(rate.accountId ?? ""),
    })));
    setProposalApplied(true);
    notify("Proposition chargée dans le formulaire. Vérifiez chaque taux, puis enregistrez et activez.", "info");
  }, [starterProposal, notify]);

  const run = useCallback(async (label: string, action: () => Promise<unknown>, success: string) => {
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      notify(success, "success");
      await loadWorkspace(true);
      await onChanged?.();
      return result;
    } catch (actionError) {
      const message = errorMessage(actionError);
      setError(message);
      notify(message, "error");
      return null;
    } finally {
      setBusy(null);
    }
  }, [loadWorkspace, notify, onChanged]);

  const openWorkpaper = useCallback(async (id: string) => {
    const requestId = ++workpaperRequestId.current;
    setSelectedWorkpaperId(id);
    setWorkpaperDetail(null);
    setBusy(`workpaper:${id}`);
    setError(null);
    try {
      const detail = await callBridge<LooseRecord>("getVatWorkpaper", { companyId, id });
      if (requestId === workpaperRequestId.current) setWorkpaperDetail(detail?.workpaper ?? detail);
    } catch (detailError) {
      if (requestId === workpaperRequestId.current) setError(errorMessage(detailError));
    } finally {
      if (requestId === workpaperRequestId.current) setBusy(null);
    }
  }, [companyId]);

  /*
   * A VAT configuration is a long form: a name, a rhythm, dates, a source
   * reference, and a rate table typed line by line with accounts against each
   * one. It is exactly the kind of work somebody interrupts to go and look
   * something up — the deductibility of a rate, which account a rate posts to —
   * and it was held in component state, so looking it up threw it away.
   */
  const configurationDraft = useDraftedForm({
    companyId,
    entity: "tax_configuration",
    draftKey: "new",
    open: tab === "configuration",
    value: { configName, frequency, effectiveFrom, effectiveTo, sourceReference, rates },
    onRestore: (payload) => {
      if (typeof payload.configName === "string") setConfigName(payload.configName);
      if (payload.frequency === "MONTHLY" || payload.frequency === "QUARTERLY") setFrequency(payload.frequency);
      if (typeof payload.effectiveFrom === "string") setEffectiveFrom(payload.effectiveFrom);
      if (typeof payload.effectiveTo === "string") setEffectiveTo(payload.effectiveTo);
      if (typeof payload.sourceReference === "string") setSourceReference(payload.sourceReference);
      if (Array.isArray(payload.rates) && payload.rates.length) setRates(payload.rates);
    },
  });

  const saveConfiguration = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await run("config:save", () => callBridge("saveTaxConfigurationDraft", {
      companyId,
      name: configName,
      accountingBasis: "COLLECTION",
      frequency,
      effectiveFrom,
      effectiveTo: effectiveTo || undefined,
      sourceReference,
      rates: rates.map((rate) => ({
        code: rate.code,
        label: rate.label,
        rateBps: percentToBps(rate.rate),
        direction: rate.direction,
        deductibilityBps: rate.direction === "COLLECTED" ? 0 : percentToBps(rate.deductibility),
        accountId: rate.accountId || undefined,
      })),
    }), "Configuration enregistrée comme brouillon.");
    // Cleared once the service confirmed the write, and only then: a refused
    // configuration must leave the person every rate they typed.
    if (saved !== null) await configurationDraft.clear();
  };

  const generateWorkpaper = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run("workpaper:generate", () => callBridge<LooseRecord>("generateVatWorkpaper", {
      companyId,
      taxConfigurationVersionId: selectedConfigId,
      periodStart,
      periodEnd,
    }), "Document de travail TVA généré à partir des sources locales.");
    const id = (result as LooseRecord | null)?.id ?? (result as LooseRecord | null)?.workpaper?.id;
    if (id) await openWorkpaper(id);
  };

  const refreshWorkpaper = async () => {
    if (!selectedWorkpaperId) return;
    await openWorkpaper(selectedWorkpaperId);
  };

  const workpaperAction = async (method: string, success: string, extra: LooseRecord = {}) => {
    const record = workpaperDetail;
    if (!record?.id) return;
    const result = await run(`workpaper:${method}`, () => callBridge<LooseRecord>(method, {
      companyId,
      id: record.id,
      expectedVersion: record.version,
      ...extra,
    }), success);
    if (result) await openWorkpaper(record.id);
    return result;
  };

  const addAdjustment = async (event: FormEvent) => {
    event.preventDefault();
    const result = await workpaperAction("addVatWorkpaperAdjustment", "Ajustement documenté ajouté.", {
      direction: adjustment.direction,
      taxableCents: decimalToCents(adjustment.taxable, "La base taxable"),
      vatCents: decimalToCents(adjustment.vat, "La TVA"),
      reason: adjustment.reason,
      evidenceDocumentId: adjustment.documentId,
    });
    if (result) setAdjustment({ direction: "COLLECTED", taxable: "", vat: "", reason: "", documentId: "" });
  };

  const attachEvidence = async (event: FormEvent) => {
    event.preventDefault();
    const result = await workpaperAction("attachVatWorkpaperEvidence", "Pièce probante rattachée.", {
      documentId: evidence.documentId,
      role: evidence.role,
      note: evidence.note || undefined,
    });
    if (result) setEvidence({ documentId: "", role: "SUPPORT", note: "" });
  };

  const recordFiled = async (event: FormEvent) => {
    event.preventDefault();
    await workpaperAction("recordVatWorkpaperFiled", "Dépôt externe enregistré avec sa preuve.", {
      filingReference: filing.reference,
      filedOn: filing.filedOn,
      filingReceiptDocumentId: filing.documentId,
    });
  };

  const previewClose = async (fiscalYearId: string) => {
    setBusy(`close:preview:${fiscalYearId}`);
    setError(null);
    try {
      const preview = await callBridge<LooseRecord>("previewFiscalClose", { companyId, fiscalYearId });
      setClosePreview({ ...preview, fiscalYearId });
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setBusy(null);
    }
  };

  const closeYear = async () => {
    if (!closePreview?.fiscalYearId || !closePreview?.checkHash) return;
    if (!confirmWithAppFocus("Clôturer cet exercice et verrouiller sa période comptable ? Wheat revérifiera tous les contrôles.")) return;
    await run("close:commit", () => callBridge("closeFiscalYear", {
      companyId,
      fiscalYearId: closePreview.fiscalYearId,
      checkHash: closePreview.checkHash,
    }), "Exercice clôturé après nouvelle vérification.");
    setClosePreview(null);
  };

  const reopenYear = async (fiscalYearId: string) => {
    const reason = window.prompt("Motif obligatoire de réouverture de l'exercice :")?.trim();
    if (!reason) return;
    await run("close:reopen", () => callBridge("reopenFiscalYear", { companyId, fiscalYearId, reason }), "Exercice réouvert avec trace d'audit.");
  };

  const createSeal = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run("seal:create", () => callBridge("createAuditSeal", { companyId, note: sealNote || undefined }), "Point de contrôle local créé.");
    if (result) setSealNote("");
  };

  if (loading) {
    return <div className="compliance14-loading"><LoaderCircle className="is-spinning" size={20} /> Chargement de l'espace de conformité…</div>;
  }

  return (
    <div className="compliance14-shell">
      <header className="compliance14-heading">
        <div>
          <span className="compliance14-eyebrow">Wheat · {companyName}</span>
          <h2>TVA, clôture et preuves locales</h2>
          <p>Préparez, contrôlez et figez les éléments comptables sans transmission automatique à l'administration.</p>
        </div>
        <div className="compliance14-heading__assurance">
          <ShieldCheck size={22} />
          <div><strong>Traçabilité locale</strong><small>Centimes exacts · versions immuables</small></div>
        </div>
      </header>

      <div className="compliance14-boundary">
        <AlertTriangle size={17} />
        <span>Wheat produit des documents de travail et conserve vos preuves. Il ne dépose aucune déclaration, ne signe aucun fichier et ne revendique aucune certification DGI ou CNSS.</span>
      </div>

      <nav className="compliance14-nav" aria-label="Sections conformité">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
              <Icon size={17} /><span><strong>{item.label}</strong><small>{item.note}</small></span>{tab === item.id && <i />}
            </button>
          );
        })}
      </nav>

      {error && <div className="compliance14-message is-error"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Fermer"><X size={15} /></button></div>}

      <main className="compliance14-stage">
        {tab === "configuration" && (
          <div className="compliance14-split">
            <section className="compliance14-pane">
              <SectionHeading eyebrow="Versions" title="Configurations fiscales" note="Une version activée devient immuable et ne recouvre aucune autre période active." />
              <div className="compliance14-list">
                {configurations.map((configuration) => (
                  <article key={configuration.id}>
                    <div><strong>{configuration.name}</strong><small>{formatDay(configuration.effectiveFrom)} → {configuration.effectiveTo ? formatDay(configuration.effectiveTo) : "sans fin"} · {configuration.filingFrequency ?? configuration.frequency}</small></div>
                    <span className={`compliance14-status ${statusTone(configuration.status)}`}>{statusLabel(configuration.status)}</span>
                    {configuration.status === "DRAFT" && <button className="compliance14-link" disabled={!!busy} onClick={() => run(`config:activate:${configuration.id}`, () => callBridge("activateTaxConfiguration", { companyId, id: configuration.id, expectedVersion: configuration.version }), "Configuration activée et figée.")}>Activer</button>}
                    <button className="compliance14-link" disabled={!!busy} onClick={() => run(`config:clone:${configuration.id}`, () => callBridge("cloneTaxConfiguration", { companyId, id: configuration.id }), "Nouvelle révision créée comme brouillon.")}>Dupliquer</button>
                  </article>
                ))}
                {!configurations.length && <EmptyState title="Aucune configuration" note="Aucune facture portant de la TVA ne peut être comptabilisée tant qu'une version n'est pas active." />}
                {!configurations.length && starterProposal && (
                  <div className="compliance14-message is-info">
                    <AlertTriangle size={17} />
                    <span>{String(starterProposal.notice ?? "")}</span>
                    <button type="button" disabled={proposalApplied} onClick={applyStarterProposal}>
                      {proposalApplied ? "Chargée" : "Pré-remplir le formulaire"}
                    </button>
                  </div>
                )}
              </div>
            </section>

            <form className="compliance14-form" onSubmit={saveConfiguration}>
              <SectionHeading eyebrow="Nouvelle version" title="Règles sur encaissements" note="Wheat limite volontairement ce moteur au régime sur encaissements." />
              <div className="compliance14-fields two">
                <label><span>Nom</span><input required value={configName} onChange={(event) => setConfigName(event.target.value)} /></label>
                <label><span>Fréquence</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)}><option value="MONTHLY">Mensuelle</option><option value="QUARTERLY">Trimestrielle</option></select></label>
                <label><span>Début d'effet</span><input required type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
                <label><span>Fin d'effet (facultative)</span><input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></label>
              </div>
              <label className="compliance14-field-wide"><span>Référence de règle vérifiée</span><textarea required rows={2} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} placeholder="Texte, article, note interne et date de vérification" /></label>
              <div className="compliance14-rate-head"><strong>Taux et sens</strong><button type="button" onClick={() => setRates((current) => [...current, blankRate()])}><Plus size={14} /> Ajouter</button></div>
              <div className="compliance14-rates">
                {rates.map((rate, index) => (
                  <div className="compliance14-rate" key={rate.key}>
                    <input required placeholder="Code" value={rate.code} onChange={(event) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, code: event.target.value } : item))} />
                    <input required placeholder="Libellé" value={rate.label} onChange={(event) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, label: event.target.value } : item))} />
                    <label><input required inputMode="decimal" value={rate.rate} onChange={(event) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, rate: event.target.value } : item))} /><span>%</span></label>
                    <select className="wt-native-select" value={rate.direction} onChange={(event) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, direction: event.target.value as RateDraft["direction"] } : item))}><option value="BOTH">Collectée + déductible</option><option value="COLLECTED">Collectée</option><option value="DEDUCTIBLE">Déductible</option></select>
                    <label><input required inputMode="decimal" disabled={rate.direction === "COLLECTED"} value={rate.direction === "COLLECTED" ? "0" : rate.deductibility} onChange={(event) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, deductibility: event.target.value } : item))} /><span>% déd.</span></label>
                    <WheatSelect
                      ariaLabel={`Compte de TVA pour le taux ${rate.code ?? ""}`}
                      placeholder="Compte non imposé"
                      searchPlaceholder="Numéro ou libellé du compte…"
                      allowClear
                      noOptionsLabel="Aucun compte disponible"
                      size="sm"
                      value={rate.accountId}
                      onChange={(value) => setRates((current) => current.map((item) => item.key === rate.key ? { ...item, accountId: value } : item))}
                      options={accounts.map((account: LooseRecord): WheatSelectOption => ({
                        value: String(account.id),
                        label: `${account.code} — ${account.label}`,
                        keywords: String(account.label ?? ""),
                      }))}
                    />
                    <button type="button" aria-label={`Supprimer le taux ${index + 1}`} disabled={rates.length === 1} onClick={() => setRates((current) => current.filter((item) => item.key !== rate.key))}><X size={15} /></button>
                  </div>
                ))}
              </div>
              <footer><button className="compliance14-button primary" disabled={!!busy}><Save size={16} /> Enregistrer le brouillon</button></footer>
            </form>
          </div>
        )}

        {tab === "workpapers" && (
          <div className="compliance14-workpapers">
            <aside className="compliance14-rail">
              <form onSubmit={generateWorkpaper}>
                <strong>Nouvelle période</strong>
                <label><span>Configuration active</span><WheatSelect
                  required
                  ariaLabel="Configuration TVA active"
                  placeholder="Sélectionner une configuration…"
                  searchPlaceholder="Nom ou révision…"
                  noOptionsLabel="Aucune configuration active"
                  value={selectedConfigId}
                  onChange={setSelectedConfigId}
                  options={configurations.filter((configuration: LooseRecord) => configuration.status === "ACTIVE").map((configuration: LooseRecord): WheatSelectOption => ({
                    value: String(configuration.id),
                    label: `${configuration.name} · révision ${configuration.revision}`,
                    note: formatDay(configuration.effectiveFrom),
                  }))}
                /></label>
                <label><span>Du</span><input type="date" required value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label>
                <label><span>Au</span><input type="date" required value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label>
                <button className="compliance14-button primary" disabled={!!busy || !selectedConfigId}><Plus size={15} /> Générer</button>
              </form>
              <div className="compliance14-rail-list">
                <span>Documents de travail</span>
                {workpapers.map((workpaper) => (
                  <button key={workpaper.id} className={selectedWorkpaperId === workpaper.id ? "is-active" : ""} onClick={() => void openWorkpaper(workpaper.id)}>
                    <div><strong>{formatDay(workpaper.periodStart)} — {formatDay(workpaper.periodEnd)}</strong><small>Révision {workpaper.revision ?? 1}</small></div>
                    <span className={`compliance14-status ${statusTone(workpaper.status)}`}>{statusLabel(workpaper.status)}</span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="compliance14-workpaper-detail">
              {!workpaperDetail ? (
                <EmptyState icon={FileClock} title="Sélectionnez une période" note="Le calcul est reconstruit depuis les encaissements, imputations, extournes et avoirs liés." />
              ) : (
                <>
                  <div className="compliance14-detail-head">
                    <div><span>Document de travail · révision {workpaperDetail.revision ?? 1}</span><h3>{formatDay(workpaperDetail.periodStart)} — {formatDay(workpaperDetail.periodEnd)}</h3><p>Source figée : <code>{String(workpaperDetail.sourceHash ?? workpaperDetail.sourceSha256 ?? "—").slice(0, 20)}…</code></p></div>
                    <div className="compliance14-actions"><span className={`compliance14-status ${statusTone(workpaperDetail.status)}`}>{statusLabel(workpaperDetail.status)}</span><button title="Actualiser" onClick={() => void refreshWorkpaper()}><RefreshCw size={15} /></button></div>
                  </div>
                  <div className="compliance14-totals">
                    <Metric label="TVA collectée" value={formatCents(workpaperDetail.collectedVatCents, currency)} />
                    <Metric label="TVA déductible" value={formatCents(workpaperDetail.deductibleVatCents, currency)} />
                    <Metric label="TVA due" value={formatCents(workpaperDetail.netVatDueCents ?? workpaperDetail.dueVatCents, currency)} emphasis />
                    <Metric label="Crédit TVA" value={formatCents(workpaperDetail.creditCarryforwardCents ?? workpaperDetail.creditVatCents, currency)} />
                  </div>
                  <div className="compliance14-toolbar">
                    {workpaperDetail.status === "DRAFT" && <><button onClick={() => void workpaperAction("regenerateVatWorkpaper", "Sources recalculées et nouvelle empreinte enregistrée.")}><RefreshCw size={15} /> Recalculer</button><button className="primary" onClick={() => void workpaperAction("reviewVatWorkpaper", "Document de travail revu et figé.")}><CheckCircle2 size={15} /> Marquer revu</button></>}
                    {workpaperDetail.status === "REVIEWED" && <><button onClick={() => { const reason = window.prompt("Motif du retour en brouillon :")?.trim(); if (reason) void workpaperAction("returnVatWorkpaperToDraft", "Document renvoyé en brouillon.", { reason }); }}><RotateCcw size={15} /> Retour en brouillon</button></>}
                    {workpaperDetail.status === "FILED" && <button onClick={() => { const reason = window.prompt("Motif de réouverture :")?.trim(); if (reason) void workpaperAction("reopenVatWorkpaper", "Nouvelle révision ouverte.", { reason }); }}><History size={15} /> Réouvrir</button>}
                  </div>

                  {workpaperDetail.status === "DRAFT" && (
                    <div className="compliance14-detail-grid">
                      <form onSubmit={addAdjustment}>
                        <h4>Ajustement justifié</h4>
                        <div className="compliance14-fields two"><label><span>Sens</span><select value={adjustment.direction} onChange={(event) => setAdjustment((current) => ({ ...current, direction: event.target.value }))}><option value="COLLECTED">Collectée</option><option value="DEDUCTIBLE">Déductible</option></select></label><label><span>Base taxable</span><input required inputMode="decimal" value={adjustment.taxable} onChange={(event) => setAdjustment((current) => ({ ...current, taxable: event.target.value }))} /></label><label><span>TVA</span><input required inputMode="decimal" value={adjustment.vat} onChange={(event) => setAdjustment((current) => ({ ...current, vat: event.target.value }))} /></label><label><span>Pièce hashée</span><WheatSelect
                          required
                          ariaLabel="Document justificatif du retraitement"
                          placeholder="Sélectionner un document…"
                          searchPlaceholder="Titre du document…"
                          noOptionsLabel="Aucun document hashé disponible"
                          value={adjustment.documentId}
                          onChange={(value) => setAdjustment((current) => ({ ...current, documentId: value }))}
                          options={hashedDocuments.map((document: LooseRecord): WheatSelectOption => ({
                            value: String(document.id),
                            label: String(document.title ?? document.id),
                            note: document.type ? String(document.type) : undefined,
                          }))}
                        /></label></div>
                        <label className="compliance14-field-wide"><span>Motif</span><textarea required rows={2} value={adjustment.reason} onChange={(event) => setAdjustment((current) => ({ ...current, reason: event.target.value }))} /></label>
                        <button className="compliance14-button"><Plus size={14} /> Ajouter</button>
                      </form>
                      <form onSubmit={attachEvidence}>
                        <h4>Rattacher une preuve</h4>
                        <label><span>Document hashé</span><WheatSelect
                          required
                          ariaLabel="Document justificatif"
                          placeholder="Sélectionner un document…"
                          searchPlaceholder="Titre du document…"
                          noOptionsLabel="Aucun document hashé disponible"
                          value={evidence.documentId}
                          onChange={(value) => setEvidence((current) => ({ ...current, documentId: value }))}
                          options={hashedDocuments.map((document: LooseRecord): WheatSelectOption => ({
                            value: String(document.id),
                            label: String(document.title ?? document.id),
                            note: document.type ? String(document.type) : undefined,
                          }))}
                        /></label>
                        <label><span>Rôle</span><select value={evidence.role} onChange={(event) => setEvidence((current) => ({ ...current, role: event.target.value }))}><option value="SUPPORT">Justificatif</option><option value="RECONCILIATION">Rapprochement</option><option value="CALCULATION">Calcul</option></select></label>
                        <label><span>Note</span><input value={evidence.note} onChange={(event) => setEvidence((current) => ({ ...current, note: event.target.value }))} /></label>
                        <button className="compliance14-button"><FileCheck2 size={14} /> Rattacher</button>
                      </form>
                    </div>
                  )}

                  {workpaperDetail.status === "REVIEWED" && (
                    <form className="compliance14-filing" onSubmit={recordFiled}>
                      <div><h4>Enregistrer un dépôt réalisé hors Wheat</h4><p>La référence et le reçu hashé prouvent uniquement ce que vous avez enregistré localement.</p></div>
                      <label><span>Référence externe</span><input required value={filing.reference} onChange={(event) => setFiling((current) => ({ ...current, reference: event.target.value }))} /></label>
                      <label><span>Date</span><input required type="date" value={filing.filedOn} onChange={(event) => setFiling((current) => ({ ...current, filedOn: event.target.value }))} /></label>
                      <label><span>Reçu hashé</span><WheatSelect
                        required
                        ariaLabel="Reçu de dépôt"
                        placeholder="Sélectionner un document…"
                        searchPlaceholder="Titre du document…"
                        noOptionsLabel="Aucun document hashé disponible"
                        value={filing.documentId}
                        onChange={(value) => setFiling((current) => ({ ...current, documentId: value }))}
                        options={hashedDocuments.map((document: LooseRecord): WheatSelectOption => ({
                          value: String(document.id),
                          label: String(document.title ?? document.id),
                          note: document.type ? String(document.type) : undefined,
                        }))}
                      /></label>
                      <button className="compliance14-button primary"><BadgeCheck size={15} /> Enregistrer le dépôt externe</button>
                    </form>
                  )}

                  <WorkpaperEvidence record={workpaperDetail} currency={currency} onRemove={(evidenceId) => void workpaperAction("removeVatWorkpaperEvidence", "Pièce détachée du brouillon.", { evidenceId })} />
                </>
              )}
            </section>
          </div>
        )}

        {tab === "close" && (
          <div className="compliance14-split close">
            <section className="compliance14-pane">
              <SectionHeading eyebrow="Exercices" title="Précontrôle de clôture" note="La clôture repart toujours d'un aperçu frais et compare son empreinte." />
              <div className="compliance14-list fiscal">
                {fiscalYears.map((year) => (
                  <article key={year.id}>
                    <CalendarCheck size={18} />
                    <div><strong>{year.label ?? `${formatDay(year.startsOn)} — ${formatDay(year.endsOn)}`}</strong><small>{formatDay(year.startsOn)} → {formatDay(year.endsOn)}</small></div>
                    <span className={`compliance14-status ${statusTone(year.status)}`}>{statusLabel(year.status)}</span>
                    {year.status === "CLOSED" ? <button className="compliance14-link" onClick={() => void reopenYear(year.id)}>Réouvrir</button> : <button className="compliance14-link" onClick={() => void previewClose(year.id)}>Contrôler <ChevronRight size={14} /></button>}
                  </article>
                ))}
              </div>
              <h4 className="compliance14-history-title">Historique</h4>
              <div className="compliance14-timeline">
                {closeRuns.map((runRecord) => <article key={runRecord.id}><span /><div><strong>{runRecord.action === "REOPEN" ? "Réouverture" : "Clôture"} · séquence {String(runRecord.sequence ?? "—")}</strong><small>{formatDay(runRecord.completedAt ?? runRecord.createdAt)} · {statusLabel(runRecord.status)}</small></div></article>)}
                {!closeRuns.length && <p>Aucune clôture enregistrée.</p>}
              </div>
            </section>
            <section className="compliance14-close-preview">
              {!closePreview ? <EmptyState icon={Scale} title="Lancez un précontrôle" note="Wheat examine les brouillons, imports, preuves, TVA, audit et rapprochements avant de proposer la clôture." /> : (
                <>
                  <SectionHeading eyebrow="Aperçu vérifiable" title={closePreview.ready ? "Clôture possible" : "Clôture bloquée"} note={`Empreinte ${String(closePreview.checkHash ?? "—").slice(0, 24)}…`} />
                  <CheckList title="Blocages" items={rowsOf(closePreview.blockers)} tone="error" empty="Aucun blocage détecté." />
                  <CheckList title="Avertissements" items={rowsOf(closePreview.warnings)} tone="warning" empty="Aucun avertissement." />
                  <button className="compliance14-button primary close" disabled={!closePreview.ready || !!busy} onClick={() => void closeYear()}><LockKeyhole size={16} /> Clôturer après revérification</button>
                </>
              )}
            </section>
          </div>
        )}

        {tab === "integrity" && (
          <div className="compliance14-split integrity">
            <section className="compliance14-pane">
              <SectionHeading eyebrow="Chaîne d'audit" title="Points de contrôle locaux" note="Chaque point couvre un segment continu de hashes. Ce n'est ni une signature ni un horodatage tiers." />
              <form className="compliance14-seal-form" onSubmit={createSeal}><label><span>Note facultative</span><input value={sealNote} onChange={(event) => setSealNote(event.target.value)} placeholder="Ex. revue mensuelle interne" /></label><button className="compliance14-button primary" disabled={!!busy}><Fingerprint size={15} /> Créer un point</button></form>
              <div className="compliance14-seals">
                {seals.map((seal) => (
                  <article key={seal.id}>
                    <Fingerprint size={18} />
                    <div><strong>Séquences {String(seal.fromSequence)} → {String(seal.throughSequence)}</strong><small>{seal.eventCount} événement(s) · {formatDay(seal.sealedAt)}</small><code>{String(seal.rootHash).slice(0, 28)}…</code></div>
                    <button className="compliance14-link" onClick={async () => {
                      const result = await run(`seal:verify:${seal.id}`, () => callBridge<LooseRecord>("verifyAuditSeal", { companyId, sealId: seal.id }), "Vérification locale terminée.");
                      if (result) window.alert((result as LooseRecord).valid ? "Le segment local est intact." : `Échec : ${rowsOf((result as LooseRecord).problems).join(" ")}`);
                    }}>Vérifier</button>
                  </article>
                ))}
                {!seals.length && <EmptyState title="Aucun point local" note="Créez-en après une revue ou à la clôture d'une période interne." />}
              </div>
            </section>
            <section className="compliance14-pane credit-summary">
              <SectionHeading eyebrow="Avoirs récents" title="Impact contrôlé" note="Les avoirs liés sont positifs, plafonnés à l'original et comptabilisés en sens opposé." />
              <div className="compliance14-credit-list">
                {creditNotes.map((credit) => <article key={credit.id}><FileMinus2 size={17} /><div><strong>{credit.invoiceNo}</strong><small>{credit.creditedInvoice?.invoiceNo ? `Facture ${credit.creditedInvoice.invoiceNo} · ` : ""}{formatDay(credit.invoiceDate)}</small></div><span>{formatCents(credit.ttcCents, currency)}</span><span className={`compliance14-status ${statusTone(credit.lifecycleStatus)}`}>{statusLabel(credit.lifecycleStatus)}</span></article>)}
                {!creditNotes.length && <EmptyState title="Aucun avoir récent" note="Les avoirs se créent depuis une facture comptabilisée dans Ventes ou Achats." />}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function SectionHeading({ eyebrow, title, note }: { eyebrow: string; title: string; note: string }) {
  return <div className="compliance14-section-head"><span>{eyebrow}</span><h3>{title}</h3><p>{note}</p></div>;
}

function EmptyState({ icon: Icon = FileClock, title, note }: { icon?: typeof FileClock; title: string; note: string }) {
  return <div className="compliance14-empty"><Icon size={23} /><strong>{title}</strong><p>{note}</p></div>;
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <article className={emphasis ? "is-emphasis" : ""}><span>{label}</span><strong>{value}</strong></article>;
}

function CheckList({ title, items, tone, empty }: { title: string; items: any[]; tone: "error" | "warning"; empty: string }) {
  return <section className={`compliance14-checklist is-${tone}`}><h4>{title} <span>{items.length}</span></h4>{items.length ? <ul>{items.map((item, index) => <li key={item.id ?? `${title}-${index}`}><AlertTriangle size={14} /><span>{typeof item === "string" ? item : item.message ?? item.label ?? JSON.stringify(item)}</span></li>)}</ul> : <p><CheckCircle2 size={15} /> {empty}</p>}</section>;
}

function WorkpaperEvidence({ record, currency, onRemove }: { record: LooseRecord; currency: string; onRemove: (id: string) => void }) {
  const lines = rowsOf(record.lines);
  const adjustments = rowsOf(record.adjustments);
  const evidence = rowsOf(record.evidence);
  return (
    <div className="compliance14-evidence">
      <div><h4>Sources figées <span>{lines.length}</span></h4>{lines.slice(0, 40).map((line) => <article key={line.id}><div><strong>{line.eventType ?? line.sourceType ?? "Source"}</strong><small>{formatDay(line.eventDate ?? line.accountingDate)} · {line.invoiceNumber ?? line.invoiceId ?? "—"}</small></div><span>{formatCents(line.vatCents, currency)}</span></article>)}{lines.length > 40 && <p>40 lignes affichées sur {lines.length}. Le hash couvre l'ensemble figé.</p>}</div>
      <div><h4>Ajustements <span>{adjustments.length}</span></h4>{adjustments.map((item) => <article key={item.id}><div><strong>{item.reason}</strong><small>{item.direction}</small></div><span>{formatCents(item.vatCents, currency)}</span></article>)}{!adjustments.length && <p>Aucun ajustement manuel.</p>}</div>
      <div><h4>Preuves <span>{evidence.length}</span></h4>{evidence.map((item) => <article key={item.id}><div><strong>{item.document?.title ?? item.documentTitleSnapshot ?? item.role}</strong><small>{item.role} · {String(item.contentSha256Snapshot ?? item.document?.contentSha256 ?? "").slice(0, 16)}…</small></div>{record.status === "DRAFT" && <button onClick={() => onRemove(item.id)}><X size={14} /></button>}</article>)}{!evidence.length && <p>Aucune pièce rattachée.</p>}</div>
    </div>
  );
}
