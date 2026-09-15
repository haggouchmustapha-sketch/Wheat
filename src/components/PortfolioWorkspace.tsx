import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatExactCentsForUi } from "../lib/exactDecimal";
import "./PortfolioWorkspace.css";

/**
 * Every dossier at once, so the day can start with a decision instead of a tour.
 *
 * Read-only: it opens nothing and changes nothing. Each row names what is
 * waiting in that dossier and lets the person switch to it.
 *
 * It deliberately does not say a VAT declaration is late. Filing deadlines are
 * legal dates Wheat has not verified, so the screen reports the fact it can
 * stand behind — periods with no filed workpaper — and leaves the deadline to
 * the accountant who knows it.
 */

type PortfolioProps = {
  activeCompanyId?: string | null;
  onOpenDossier?: (companyId: string) => void;
  onNotify?: (message: string, tone?: "success" | "warning" | "info") => void;
};

type AttentionReason = { code: string; label: string; count: number };

function cents(value: unknown) {
  if (value === null || value === undefined) return "—";
  try {
    return formatExactCentsForUi(BigInt(String(value)));
  } catch {
    return "—";
  }
}

function staleness(days: number | null) {
  if (days === null) return "Aucun mouvement importé";
  if (days === 0) return "Relevé à jour";
  if (days === 1) return "Dernier mouvement hier";
  return `Dernier mouvement il y a ${days} jours`;
}

export default function PortfolioWorkspace({ activeCompanyId, onOpenDossier, onNotify }: PortfolioProps) {
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);

  const load = useCallback(async () => {
    const bridge = window.wheat;
    if (!bridge?.getPortfolioOverview) {
      setLoading(false);
      setError("La vue portefeuille nécessite l'application desktop Wheat.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setOverview(await bridge.getPortfolioOverview());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dossiers: any[] = overview?.dossiers ?? [];
  const shown = onlyAttention ? dossiers.filter((item) => item.attention.length > 0) : dossiers;
  const totals = overview?.totals;

  return (
    <div className="pf-shell">
      <header className="pf-head">
        <div>
          <h2 className="pf-title">Portefeuille</h2>
          <p className="pf-subtitle">
            {totals
              ? `${totals.dossierCount} dossier${totals.dossierCount > 1 ? "s" : ""} sur ce poste · ${totals.needingAttentionCount} en attente`
              : "Lecture de tous les dossiers…"}
          </p>
        </div>
        <div className="pf-head__actions">
          <label className="pf-toggle">
            <input type="checkbox" checked={onlyAttention} onChange={(event) => setOnlyAttention(event.target.checked)} />
            <span>En attente seulement</span>
          </label>
          <button type="button" className="wt-button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" /> Actualiser
          </button>
        </div>
      </header>

      {error && <p className="pf-error" role="alert">{error}</p>}
      {loading && !overview && <p className="pf-empty">Lecture des dossiers…</p>}

      {totals && (
        <div className="pf-totals">
          <Tile label="Écritures en brouillon" value={totals.draftEntryCount} />
          <Tile label="Documents non rattachés" value={totals.unfiledDocumentCount} />
          <Tile label="Imports à confirmer" value={totals.stagedImportCount} />
          <Tile label="Mouvements non rapprochés" value={totals.unreconciledMovementCount} />
          <Tile label="Factures clients échues" value={totals.overdueInvoiceCount} note={cents(totals.overdueReceivableCents)} />
        </div>
      )}

      {overview && shown.length === 0 && (
        <p className="pf-empty">
          {onlyAttention ? "Aucun dossier n'attend d'action." : "Aucun dossier sur ce poste."}
        </p>
      )}

      <div className="pf-grid">
        {shown.map((dossier) => (
          <article key={dossier.companyId} className={`pf-card${dossier.companyId === activeCompanyId ? " pf-card--active" : ""}`}>
            <header className="pf-card__head">
              <div>
                <h3 className="pf-card__name">{dossier.name}</h3>
                <p className="pf-card__meta">
                  {[dossier.city, dossier.ice ? `ICE ${dossier.ice}` : null].filter(Boolean).join(" · ") || "Identité incomplète"}
                </p>
              </div>
              {dossier.companyId !== activeCompanyId && onOpenDossier && (
                <button
                  type="button"
                  className="wt-button wt-button--ghost"
                  onClick={() => {
                    onOpenDossier(dossier.companyId);
                    onNotify?.(`Dossier ${dossier.name} ouvert.`, "success");
                  }}
                >
                  Ouvrir
                </button>
              )}
            </header>

            <dl className="pf-figures">
              <div><dt>Trésorerie</dt><dd>{cents(dossier.bankTotalCents)}</dd></div>
              <div><dt>Encours clients</dt><dd>{cents(dossier.outstandingReceivableCents)}</dd></div>
              <div><dt>Dont échu</dt><dd className={dossier.overdueInvoiceCount > 0 ? "pf-figure--warn" : ""}>{cents(dossier.overdueReceivableCents)}</dd></div>
            </dl>

            <p className="pf-bank">{staleness(dossier.daysSinceLastBankMovement)}</p>

            <p className="pf-vat">
              {dossier.latestVatPeriod
                ? `Dernière période de TVA : ${String(dossier.latestVatPeriod.periodEnd).slice(0, 10)} — ${dossier.latestVatPeriod.status}`
                : "Aucun dossier de travail TVA"}
            </p>

            {dossier.attention.length > 0 ? (
              <ul className="pf-reasons">
                {dossier.attention.map((reason: AttentionReason) => (
                  <li key={reason.code}>
                    {reason.label}
                    {reason.count > 0 && <span className="pf-count">{reason.count}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pf-clear">Rien en attente.</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="pf-tile">
      <span className="pf-tile__value">{value}</span>
      <span className="pf-tile__label">{label}</span>
      {note && <span className="pf-tile__note">{note}</span>}
    </div>
  );
}
