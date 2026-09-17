import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  Printer,
  RefreshCw,
  Snowflake,
  TrendingDown,
  Upload,
  Warehouse,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Tabs, type TabItem } from "./ui";
import { Fact, SelectField, TextField } from "./StockFields";
import {
  downloadCsv,
  formatDate,
  formatQuantity,
  formatSignedQuantity,
  formatValue,
  isZero,
  messageOf,
} from "./stockFormat";

/**
 * The Stock screens that were missing: dépôts, inventaire physique,
 * dépréciations, imports and the report set.
 *
 * They are panels of the same workspace, not a second interface. Each one is a
 * tab of `StockWorkspace`, reuses the same components, the same tokens and the
 * same `{ raw, display }` number transport, and every mutation goes through the
 * same `window.wheat` bridge the rest of the module uses.
 *
 * The rule the whole file follows: a screen never computes an accounting
 * figure. Variances, valuations and provisions are all calculated in the main
 * process and arrive as exact decimal strings; what happens here is layout.
 */

type PanelProps = {
  companyId: string;
  workspace: any;
  notify?: (message: string, tone?: "success" | "warning" | "info") => void;
  onChanged?: () => void;
  openEntry?: (entryId: string) => void;
};

const today = () => new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------- warehouses */

export function WarehousesPanel({ companyId, workspace, notify, onChanged }: PanelProps) {
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.wheat!.saveStockWarehouse({ companyId, ...draft });
      notify?.("Dépôt enregistré.", "success");
      setDraft(null);
      onChanged?.();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stock-workspace">
      <div className="stock-actions">
        <Button onClick={() => setDraft({ code: "", name: "", address: "", active: true })}>Créer un dépôt</Button>
      </div>

      {draft && (
        <Card title={draft.id ? "Modifier le dépôt" : "Nouveau dépôt"}>
          {error && <ErrorState cause={error} fix="Corrigez la fiche puis enregistrez à nouveau." />}
          <div className="stock-filters">
            <TextField label="Code" value={draft.code} onChange={(code) => setDraft({ ...draft, code })} />
            <TextField label="Nom du dépôt" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
            <TextField label="Adresse" value={draft.address ?? ""} onChange={(address) => setDraft({ ...draft, address })} />
            <SelectField
              label="Statut"
              value={draft.active ? "yes" : "no"}
              onChange={(value) => setDraft({ ...draft, active: value === "yes" })}
            >
              <option value="yes">Actif</option>
              <option value="no">Archivé</option>
            </SelectField>
          </div>
          <div className="stock-actions">
            <Button onClick={() => void save()} disabled={saving}>Enregistrer</Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>Annuler</Button>
          </div>
        </Card>
      )}

      {(workspace.warehouses ?? []).length === 0 ? (
        <EmptyState icon={<Warehouse size={22} />} title="Aucun dépôt" text="Un mouvement de stock se passe quelque part : créez au moins un dépôt." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Nom</th>
                <th scope="col">Adresse</th>
                <th scope="col">Emplacements</th>
                <th scope="col">Statut</th>
              </tr>
            </thead>
            <tbody>
              {workspace.warehouses.map((warehouse: any) => (
                <tr
                  key={warehouse.id}
                  tabIndex={0}
                  onClick={() => setDraft({
                    id: warehouse.id, code: warehouse.code, name: warehouse.name,
                    address: warehouse.address ?? "", active: warehouse.active,
                  })}
                >
                  <td>{warehouse.code}</td>
                  <td>{warehouse.name}</td>
                  <td>{warehouse.address ?? "—"}</td>
                  <td>{warehouse.locations?.length ?? 0}</td>
                  <td>{warehouse.active ? <Badge tone="success">actif</Badge> : <Badge tone="neutral">archivé</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ inventaire physique */

const CAMPAIGN_TONES: Record<string, "info" | "warning" | "success" | "neutral"> = {
  DRAFT: "neutral",
  COUNTING: "info",
  REVIEWED: "warning",
  VALIDATED: "success",
  CANCELLED: "neutral",
};

const CAMPAIGN_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  COUNTING: "Comptage en cours",
  REVIEWED: "Revue",
  VALIDATED: "Validée",
  CANCELLED: "Annulée",
};

/**
 * A campaign, from the freeze to the adjustment.
 *
 * The sheet shows the theoretical position, what was counted and the écart the
 * main process derived — never an écart computed here. A cell left empty means
 * "not counted", which is deliberately not the same as a counted zero, so the
 * input stays blank until somebody types into it.
 */
export function InventoryPanel({ companyId, workspace, notify, onChanged }: PanelProps) {
  const [campaigns, setCampaigns] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState<any>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      setCampaigns(await window.wheat!.getStockCampaigns({ companyId }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId]);

  const loadSheet = useCallback(async (campaignId: string) => {
    setError(null);
    try {
      const loaded = await window.wheat!.getStockCampaign({ companyId, campaignId });
      setSheet(loaded);
      setCounts({});
      setValues({});
    } catch (caught) {
      setError(messageOf(caught));
      setSheet(null);
    }
  }, [companyId]);

  useEffect(() => { void loadCampaigns(); }, [loadCampaigns]);
  useEffect(() => { if (selected) void loadSheet(selected); }, [selected, loadSheet]);

  const act = async (run: () => Promise<any>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      notify?.(success, "success");
      await loadCampaigns();
      if (selected) await loadSheet(selected);
      onChanged?.();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    await act(async () => {
      const created = await window.wheat!.createStockCampaign({
        companyId,
        countDate: creating.countDate,
        warehouseId: creating.warehouseId || null,
        note: creating.note || null,
      });
      setCreating(null);
      setSelected(created.id);
    }, "Campagne d'inventaire créée.");
  };

  /** Sends only the rows somebody actually typed into. */
  const saveCounts = async () => {
    const touched = Object.keys({ ...counts, ...values });
    if (touched.length === 0) {
      notify?.("Aucune quantité saisie à enregistrer.", "info");
      return;
    }
    const byId = new Map<string, any>((sheet?.rows ?? []).map((row: any) => [row.id, row]));
    const entries = touched.map((id) => {
      const row = byId.get(id);
      return {
        articleId: row.article.id,
        warehouseId: row.warehouse.id,
        lotId: row.lot?.id ?? null,
        countedQuantity: counts[id] !== undefined
          ? (counts[id].trim() === "" ? null : counts[id])
          : (row.countedQuantity?.display ?? null),
        unitValue: values[id] !== undefined
          ? (values[id].trim() === "" ? null : values[id])
          : (row.unitValue?.display ?? null),
        note: row.note ?? null,
      };
    });
    await act(() => window.wheat!.saveStockCampaignCounts({ companyId, campaignId: selected, entries }),
      `${entries.length} quantité(s) enregistrée(s).`);
  };

  const exportSheet = () => {
    if (!sheet) return;
    downloadCsv(
      `inventaire-${sheet.campaign.reference}.csv`,
      ["Référence", "Article", "Dépôt", "Lot", "Quantité théorique", "Quantité comptée", "Écart", "Valeur théorique", "Valeur de l'écart"],
      sheet.rows.map((row: any) => [
        row.article.sku,
        row.article.designation,
        row.warehouse.name,
        row.lot?.code ?? "",
        row.expectedQuantity.display,
        row.countedQuantity?.display ?? "",
        row.countedQuantity ? row.varianceQuantity.display : "",
        row.expectedValue.display,
        row.varianceValue?.display ?? "",
      ]),
    );
  };

  if (error && !campaigns) return <ErrorState cause={error} onRetry={() => void loadCampaigns()} />;
  if (!campaigns) return <LoadingState label="Chargement des inventaires…" />;

  const status = sheet?.campaign?.status;
  const counting = status === "COUNTING" || status === "REVIEWED";

  return (
    <div className="stock-workspace">
      {error && <ErrorState cause={error} fix="Corrigez la campagne puis réessayez." />}

      <div className="stock-actions">
        <Button
          onClick={() => setCreating({ countDate: today(), warehouseId: "", note: "" })}
          disabled={(workspace.warehouses ?? []).length === 0}
        >
          Nouvelle campagne
        </Button>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void loadCampaigns()}>Actualiser</Button>
      </div>

      {creating && (
        <Card title="Nouvelle campagne d'inventaire">
          <div className="stock-filters">
            <TextField label="Date d'inventaire" type="date" value={creating.countDate} onChange={(countDate) => setCreating({ ...creating, countDate })} />
            <SelectField label="Périmètre" value={creating.warehouseId} onChange={(warehouseId) => setCreating({ ...creating, warehouseId })}>
              <option value="">Tous les dépôts actifs</option>
              {workspace.warehouses.map((warehouse: any) => (
                <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
              ))}
            </SelectField>
            <TextField label="Note" value={creating.note} onChange={(note) => setCreating({ ...creating, note })} />
          </div>
          <p className="stock-note">
            La campagne est créée vide. Elle ne mesure rien tant que l'inventaire théorique n'est pas figé, et
            figer ne modifie aucun stock : c'est une photographie de ce que le registre dit à cette date.
          </p>
          <div className="stock-actions">
            <Button onClick={() => void create()} disabled={busy}>Créer</Button>
            <Button variant="secondary" onClick={() => setCreating(null)}>Annuler</Button>
          </div>
        </Card>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={22} />}
          title="Aucune campagne d'inventaire"
          text="Créez une campagne pour comparer le stock théorique au stock réellement compté."
        />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Référence</th>
                <th scope="col">Date</th>
                <th scope="col">Périmètre</th>
                <th scope="col">État</th>
                <th scope="col" className="stock-table__num">Positions</th>
                <th scope="col">Ajustements</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign: any) => (
                <tr
                  key={campaign.id}
                  aria-selected={selected === campaign.id}
                  tabIndex={0}
                  onClick={() => setSelected(campaign.id)}
                  onKeyDown={(event) => { if (event.key === "Enter") setSelected(campaign.id); }}
                >
                  <td>{campaign.reference}</td>
                  <td className="stock-table__date">{formatDate(campaign.countDate)}</td>
                  <td>{campaign.warehouse?.name ?? "Tous les dépôts"}</td>
                  <td><Badge tone={CAMPAIGN_TONES[campaign.status] ?? "neutral"}>{CAMPAIGN_LABELS[campaign.status] ?? campaign.status}</Badge></td>
                  <td className="stock-table__num">{campaign._count?.counts ?? 0}</td>
                  <td>{campaign.documents?.map((document: any) => document.reference).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheet && (
        <Card
          title={`${sheet.campaign.reference} — ${CAMPAIGN_LABELS[status] ?? status}`}
          icon={<ClipboardCheck size={16} />}
          actions={
            <>
              <Button variant="secondary" icon={<Snowflake size={15} />} disabled={busy || status === "VALIDATED" || status === "CANCELLED"}
                onClick={() => void act(() => window.wheat!.freezeStockCampaign({ companyId, campaignId: sheet.campaign.id }),
                  "Inventaire théorique figé.")}
              >
                {sheet.campaign.frozenAt ? "Rafraîchir le théorique" : "Figer le théorique"}
              </Button>
              <Button variant="secondary" icon={<Download size={15} />} onClick={exportSheet} disabled={sheet.rows.length === 0}>
                Exporter
              </Button>
              <Button variant="secondary" icon={<Printer size={15} />} onClick={() => window.print()} disabled={sheet.rows.length === 0}>
                Imprimer
              </Button>
            </>
          }
        >
          <dl className="stock-card__identity">
            <Fact label="Date d'inventaire" value={formatDate(sheet.campaign.countDate)} />
            <Fact label="Figé le" value={formatDate(sheet.campaign.frozenAt)} />
            <Fact label="Positions" value={String(sheet.summary.positions)} />
            <Fact label="Comptées" value={String(sheet.summary.counted)} />
            <Fact label="Non comptées" value={String(sheet.summary.uncounted)} />
            <Fact label="Excédents" value={String(sheet.summary.surplus)} />
            <Fact label="Manquants" value={String(sheet.summary.shortage)} />
            <Fact label="Valeur théorique" value={`${formatValue(sheet.summary.expectedValue)} MAD`} />
            <Fact label="Valeur des écarts" value={`${formatValue(sheet.summary.varianceValue)} MAD`} />
          </dl>

          {sheet.summary.unvalued > 0 && (
            <p className="stock-note stock-note--alert">
              {sheet.summary.unvalued} excédent(s) portent sur une position dont le dossier ne détenait rien :
              indiquez leur valeur d'acquisition unitaire. Wheat n'invente pas un coût pour une marchandise dont
              il n'a aucune trace, et la validation restera bloquée tant que cette valeur manque.
            </p>
          )}

          {sheet.rows.length === 0 ? (
            <EmptyState
              icon={<Snowflake size={22} />}
              title="Aucune position figée"
              text="Figez l'inventaire théorique pour obtenir la feuille de comptage."
            />
          ) : (
            <div className="stock-table-wrap">
              <table className="stock-table">
                <caption className="wt-visually-hidden">
                  Feuille de comptage : quantité théorique, quantité comptée et écart pour chaque position.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Référence</th>
                    <th scope="col">Article</th>
                    <th scope="col">Dépôt</th>
                    <th scope="col" className="stock-table__num">Qté théorique</th>
                    <th scope="col" className="stock-table__num">Qté comptée</th>
                    <th scope="col" className="stock-table__num">Écart</th>
                    <th scope="col" className="stock-table__num">Valeur théorique</th>
                    <th scope="col" className="stock-table__num">Valeur de l'écart</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row: any) => {
                    const typed = counts[row.id];
                    const shown = typed !== undefined ? typed : (row.countedQuantity?.display ?? "");
                    const needsValue = row.countedQuantity && row.varianceValue === null;
                    return (
                      <tr key={row.id} className={needsValue ? "stock-table__row--alert" : undefined}>
                        <td>{row.article.sku}</td>
                        <td>{row.article.designation}{row.lot ? ` · lot ${row.lot.code}` : ""}</td>
                        <td>{row.warehouse.name}</td>
                        <td className="stock-table__num">{formatQuantity(row.expectedQuantity)}</td>
                        <td className="stock-table__num">
                          {counting ? (
                            <input
                              className="stock-count-input"
                              aria-label={`Quantité comptée pour ${row.article.designation}`}
                              value={shown}
                              onChange={(event) => setCounts({ ...counts, [row.id]: event.target.value })}
                            />
                          ) : formatQuantity(row.countedQuantity)}
                        </td>
                        <td className="stock-table__num">
                          {row.countedQuantity ? formatSignedQuantity(row.varianceQuantity) : "—"}
                        </td>
                        <td className="stock-table__num">{formatValue(row.expectedValue)}</td>
                        <td className="stock-table__num">
                          {needsValue && counting ? (
                            <input
                              className="stock-count-input"
                              placeholder="Valeur unitaire"
                              aria-label={`Valeur d'acquisition unitaire pour ${row.article.designation}`}
                              value={values[row.id] ?? row.unitValue?.display ?? ""}
                              onChange={(event) => setValues({ ...values, [row.id]: event.target.value })}
                            />
                          ) : row.varianceValue ? formatValue(row.varianceValue) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="stock-actions">
            {counting && <Button onClick={() => void saveCounts()} disabled={busy}>Enregistrer les quantités comptées</Button>}
            {status === "COUNTING" && (
              <Button variant="secondary" disabled={busy}
                onClick={() => void act(() => window.wheat!.setStockCampaignStatus({ companyId, campaignId: sheet.campaign.id, status: "REVIEWED" }), "Campagne passée en revue.")}
              >
                Passer en revue
              </Button>
            )}
            {status === "REVIEWED" && (
              <Button variant="secondary" disabled={busy}
                onClick={() => void act(() => window.wheat!.setStockCampaignStatus({ companyId, campaignId: sheet.campaign.id, status: "COUNTING" }), "Retour au comptage.")}
              >
                Revenir au comptage
              </Button>
            )}
            {counting && (
              <Button disabled={busy}
                onClick={() => void act(() => window.wheat!.validateStockCampaign({
                  companyId, campaignId: sheet.campaign.id, expectedVersion: sheet.campaign.version,
                }), "Inventaire validé : les écarts sont écrits.")}
              >
                Valider l'inventaire
              </Button>
            )}
            {(status === "DRAFT" || counting) && (
              <Button variant="secondary" disabled={busy}
                onClick={() => void act(() => window.wheat!.setStockCampaignStatus({ companyId, campaignId: sheet.campaign.id, status: "CANCELLED" }), "Campagne annulée.")}
              >
                Annuler la campagne
              </Button>
            )}
          </div>

          {counting && (
            <p className="stock-note">
              La validation écrit les écarts sous forme de documents d'excédent et de manquant validés, avec leurs
              mouvements immuables et leur brouillon comptable. Elle est refusée si le stock théorique a changé
              depuis le gel : rafraîchissez alors le théorique — les quantités comptées sont conservées.
            </p>
          )}

          {sheet.campaign.documents?.length > 0 && (
            <div className="stock-actions">
              {sheet.campaign.documents.map((document: any) => (
                <Badge key={document.id} tone="success">{document.reference} ({document.type})</Badge>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- impairment */

/**
 * Provisions: recorded against a real carrying value, released by a reprise.
 *
 * The carrying value is not typed by the user — it is read back from the
 * register for the article, the dépôt and the date they chose, so the
 * recoverable value they enter is compared against what the books actually say.
 */
export function ImpairmentsPanel({ companyId, workspace, notify, onChanged, openEntry }: PanelProps) {
  const [impairments, setImpairments] = useState<any[] | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setImpairments(await window.wheat!.getStockImpairments({ companyId }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  // The carrying value follows the article, the dépôt and the date, so the form
  // always compares against the position the decision is actually about.
  useEffect(() => {
    if (!draft?.articleId || !draft?.impairmentDate) { setPreview(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.wheat!.previewStockImpairment({
          companyId,
          articleId: draft.articleId,
          warehouseId: draft.warehouseId || null,
          impairmentDate: draft.impairmentDate,
        });
        if (!cancelled) setPreview(loaded);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, draft?.articleId, draft?.warehouseId, draft?.impairmentDate]);

  const act = async (run: () => Promise<any>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      notify?.(success, "success");
      await load();
      onChanged?.();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const accountsMissing = !workspace.settings.impairmentAccountId
    || !workspace.settings.impairmentChargeAccountId
    || !workspace.settings.impairmentReversalAccountId;

  if (error && !impairments) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!impairments) return <LoadingState label="Chargement des dépréciations…" />;

  return (
    <div className="stock-workspace">
      {error && <ErrorState cause={error} fix="Corrigez la dépréciation puis réessayez." />}

      {accountsMissing && (
        <Card title="Les comptes de dépréciation ne sont pas paramétrés" icon={<AlertTriangle size={16} />}>
          <p className="stock-note">
            Une dépréciation n'existe que dans les comptes : elle ne déplace aucune marchandise. Tant que les comptes
            de provision, de dotation et de reprise ne sont pas choisis dans le paramétrage comptable du stock, Wheat
            refuse d'en enregistrer une plutôt que de deviner un compte. Les codes CGNC proposés
            {" "}({workspace.impairmentSuggestions?.provision} / {workspace.impairmentSuggestions?.charge} / {workspace.impairmentSuggestions?.reversal})
            {" "}sont des suggestions à faire valider par votre comptable.
          </p>
        </Card>
      )}

      <div className="stock-actions">
        <Button
          disabled={accountsMissing || (workspace.articles ?? []).length === 0}
          onClick={() => setDraft({
            articleId: workspace.articles?.[0]?.id ?? "",
            warehouseId: "",
            impairmentDate: today(),
            recoverableValue: "",
            reason: "",
            note: "",
          })}
        >
          Constater une dépréciation
        </Button>
      </div>

      {draft && (
        <Card title="Nouvelle dépréciation" icon={<TrendingDown size={16} />}>
          <div className="stock-filters">
            <SelectField label="Article" value={draft.articleId} onChange={(articleId) => setDraft({ ...draft, articleId })}>
              {workspace.articles.map((article: any) => (
                <option key={article.id} value={article.id}>{article.sku} — {article.designation}</option>
              ))}
            </SelectField>
            <SelectField label="Dépôt" value={draft.warehouseId} onChange={(warehouseId) => setDraft({ ...draft, warehouseId })}>
              <option value="">Tous les dépôts</option>
              {workspace.warehouses.map((warehouse: any) => (
                <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
              ))}
            </SelectField>
            <TextField label="Date" type="date" value={draft.impairmentDate} onChange={(impairmentDate) => setDraft({ ...draft, impairmentDate })} />
            <TextField
              label="Valeur recouvrable"
              value={draft.recoverableValue}
              placeholder="Valeur nette estimée"
              onChange={(recoverableValue) => setDraft({ ...draft, recoverableValue })}
            />
            <TextField label="Motif" value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} />
          </div>

          {preview && (
            <dl className="stock-card__identity">
              <Fact label="Quantité en stock" value={formatQuantity(preview.quantity)} />
              <Fact label="Valeur comptable" value={`${formatValue(preview.value)} MAD`} />
              <Fact label="Coût unitaire" value={preview.unitCost ? `${formatValue(preview.unitCost)} MAD` : "—"} />
              <Fact
                label="Dépréciation déjà active"
                value={preview.activeImpairment
                  ? `${preview.activeImpairment.reference} — ${formatValue(preview.activeImpairment.amount)} MAD`
                  : "Aucune"}
              />
            </dl>
          )}

          <p className="stock-note">
            La dotation est la différence exacte entre la valeur comptable ci-dessus et la valeur recouvrable que vous
            saisissez. Une provision déjà active se corrige par une reprise datée, jamais en réécrivant la précédente.
          </p>

          <div className="stock-actions">
            <Button
              disabled={busy || !draft.reason.trim() || !draft.recoverableValue.trim()}
              onClick={() => void act(async () => {
                await window.wheat!.saveStockImpairment({ companyId, ...draft, warehouseId: draft.warehouseId || null });
                setDraft(null);
              }, "Dépréciation enregistrée et comptabilisée en brouillon.")}
            >
              Enregistrer
            </Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>Annuler</Button>
          </div>
        </Card>
      )}

      {impairments.length === 0 ? (
        <EmptyState
          icon={<TrendingDown size={22} />}
          title="Aucune dépréciation"
          text="Une dépréciation constate que des marchandises valent moins que ce qu'elles ont coûté, sans rien déplacer."
        />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Référence</th>
                <th scope="col">Date</th>
                <th scope="col">Article</th>
                <th scope="col">Dépôt</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Valeur comptable</th>
                <th scope="col" className="stock-table__num">Valeur recouvrable</th>
                <th scope="col" className="stock-table__num">Dépréciation</th>
                <th scope="col">État</th>
                <th scope="col">Écriture</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {impairments.map((impairment: any) => (
                <tr key={impairment.id}>
                  <td>{impairment.reference}</td>
                  <td className="stock-table__date">{formatDate(impairment.impairmentDate)}</td>
                  <td>{impairment.article.designation}</td>
                  <td>{impairment.warehouse?.name ?? "Tous"}</td>
                  <td className="stock-table__num">{formatQuantity(impairment.quantity)}</td>
                  <td className="stock-table__num">{formatValue(impairment.valueBefore)}</td>
                  <td className="stock-table__num">{formatValue(impairment.recoverableValue)}</td>
                  <td className="stock-table__num">{formatValue(impairment.amount)}</td>
                  <td>
                    <Badge tone={impairment.status === "ACTIVE" ? "warning" : impairment.status === "REVERSAL" ? "info" : "neutral"}>
                      {impairment.status === "ACTIVE" ? "Active" : impairment.status === "REVERSAL" ? "Reprise" : "Reprise effectuée"}
                    </Badge>
                  </td>
                  <td>
                    {impairment.accountingEntry ? (
                      <Button variant="secondary" onClick={() => openEntry?.(impairment.accountingEntry.id)}>
                        {impairment.accountingEntry.pieceNumber ?? impairment.accountingEntry.number}
                      </Button>
                    ) : "—"}
                  </td>
                  <td>
                    {impairment.status === "ACTIVE" && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void act(() => window.wheat!.reverseStockImpairment({ companyId, impairmentId: impairment.id }),
                          "Reprise enregistrée.")}
                      >
                        Reprendre
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ import */

/**
 * Import: choose the file, associate the columns, look at what would happen,
 * then confirm.
 *
 * The preview writes nothing. The confirmation re-sends the same file, which is
 * re-read and re-checked in the main process, so what is written is what the
 * file says rather than what a screen remembered about it.
 */
export function ImportPanel({ companyId, workspace, notify, onChanged }: PanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"ARTICLES" | "OPENING_STOCK">("ARTICLES");
  const [conflictMode, setConflictMode] = useState("REFUSE");
  const [defaultUnitId, setDefaultUnitId] = useState(workspace.units?.[0]?.id ?? "");
  const [defaultWarehouseId, setDefaultWarehouseId] = useState(workspace.warehouses?.[0]?.id ?? "");
  const [defaultValuationMethod, setDefaultValuationMethod] = useState("CMP");
  const [documentDate, setDocumentDate] = useState(today());
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = () => ({
    companyId,
    kind,
    conflictMode,
    defaultUnitId,
    defaultWarehouseId: defaultWarehouseId || null,
    defaultValuationMethod,
    documentDate: kind === "OPENING_STOCK" ? documentDate : null,
    fileName: file?.name,
    bytesBase64: file?.base64,
  });

  const choose = async (chosen: File | null) => {
    if (!chosen) return;
    setError(null);
    setPlan(null);
    setMapping({});
    const buffer = await chosen.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    setFile({ name: chosen.name, base64: btoa(binary) });
  };

  const runPreview = async (withMapping?: Record<string, string>) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const loaded = await window.wheat!.previewStockImport({ ...payload(), mapping: withMapping ?? mapping });
      setPlan(loaded);
      setMapping(loaded.mapping ?? {});
    } catch (caught) {
      setError(messageOf(caught));
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.wheat!.confirmStockImport({ ...payload(), mapping });
      notify?.(`Import terminé : ${result.created} créé(s), ${result.updated} mis à jour, ${result.skipped} ignoré(s).`, "success");
      setPlan(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      onChanged?.();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if ((workspace.units ?? []).length === 0) {
    return (
      <EmptyState
        icon={<Upload size={22} />}
        title="Aucune unité de mesure"
        text="Un article importé doit se compter dans une unité qui existe déjà. Créez-en une avant d'importer."
      />
    );
  }

  return (
    <div className="stock-workspace">
      {error && <ErrorState cause={error} fix="Corrigez le fichier ou l'association des colonnes, puis réessayez." />}

      <Card title="Fichier à importer" icon={<FileSpreadsheet size={16} />}>
        <div className="stock-filters">
          <SelectField label="Type d'import" value={kind} onChange={(value) => { setKind(value as any); setPlan(null); }}>
            <option value="ARTICLES">Catalogue d'articles</option>
            <option value="OPENING_STOCK">Stock initial</option>
          </SelectField>
          <SelectField label="Unité par défaut" value={defaultUnitId} onChange={setDefaultUnitId}>
            {workspace.units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.code} — {unit.label}</option>)}
          </SelectField>
          <SelectField label="Valorisation par défaut" value={defaultValuationMethod} onChange={setDefaultValuationMethod}>
            {(workspace.valuationMethods ?? ["CMP", "FIFO"]).map((method: string) => <option key={method} value={method}>{method}</option>)}
          </SelectField>
          <SelectField label="Doublons de référence" value={conflictMode} onChange={setConflictMode}>
            <option value="REFUSE">Refuser l'import (recommandé)</option>
            <option value="UPDATE">Mettre à jour l'article existant</option>
            <option value="SKIP">Ignorer la ligne</option>
          </SelectField>
          {kind === "OPENING_STOCK" && (
            <>
              <SelectField label="Dépôt par défaut" value={defaultWarehouseId} onChange={setDefaultWarehouseId}>
                <option value="">Indiqué sur chaque ligne</option>
                {workspace.warehouses.map((warehouse: any) => (
                  <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
                ))}
              </SelectField>
              <TextField label="Date du stock initial" type="date" value={documentDate} onChange={setDocumentDate} />
            </>
          )}
          <div className="stock-filters__field">
            <label htmlFor="stock-import-file">Fichier CSV ou XLSX</label>
            <input
              id="stock-import-file"
              ref={fileInput}
              type="file"
              accept=".csv,.txt,.xlsx"
              onChange={(event) => void choose(event.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <div className="stock-actions">
          <Button onClick={() => void runPreview()} disabled={!file || busy}>Prévisualiser</Button>
        </div>
        <p className="stock-note">
          La prévisualisation n'écrit rien. La confirmation écrit la totalité des lignes ou aucune : un fichier qui
          comporte une seule erreur ne laisse pas de catalogue à moitié importé.
        </p>
      </Card>

      {plan && (
        <>
          <Card title="Association des colonnes" note="Wheat propose une association ; celle qui s'applique est celle que vous confirmez ici.">
            <div className="stock-filters">
              {plan.fields.map((field: any) => (
                <SelectField
                  key={field.key}
                  label={`${field.label}${field.required ? " *" : ""}`}
                  value={mapping[field.key] ?? ""}
                  onChange={(header) => {
                    const next: Record<string, string> = { ...mapping, [field.key]: header };
                    if (!header) delete next[String(field.key)];
                    setMapping(next);
                    void runPreview(next);
                  }}
                >
                  <option value="">— non associée —</option>
                  {plan.headers.map((header: string) => <option key={header} value={header}>{header}</option>)}
                </SelectField>
              ))}
            </div>
          </Card>

          <Card title={`Aperçu — ${plan.rowCount} ligne(s) lue(s), format ${plan.format}`}>
            <dl className="stock-card__identity">
              <Fact label="À créer" value={String(plan.totals.create)} />
              <Fact label="À mettre à jour" value={String(plan.totals.update)} />
              <Fact label="Ignorées" value={String(plan.totals.skip)} />
              <Fact label="Erreurs" value={String(plan.errors.length)} />
              {kind === "OPENING_STOCK" && <Fact label="Quantité totale" value={formatQuantity({ raw: "", display: plan.totals.quantity })} />}
              {kind === "OPENING_STOCK" && <Fact label="Valeur totale" value={`${formatValue({ raw: "", display: plan.totals.value })} MAD`} />}
            </dl>

            {plan.errors.length > 0 && (
              <div className="stock-table-wrap">
                <table className="stock-table">
                  <caption className="wt-visually-hidden">Lignes refusées, avec la raison du refus</caption>
                  <thead><tr><th scope="col">Ligne</th><th scope="col">Refus</th></tr></thead>
                  <tbody>
                    {plan.errors.map((issue: any, index: number) => (
                      <tr key={index} className="stock-table__row--alert">
                        <td>{issue.row === 0 ? "En-tête" : issue.row}</td>
                        <td>{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {plan.warnings.length > 0 && (
              <ul className="stock-note">
                {plan.warnings.map((issue: any, index: number) => <li key={index}>{issue.message}</li>)}
              </ul>
            )}

            {plan.articles.length > 0 && (
              <div className="stock-table-wrap">
                <table className="stock-table">
                  <caption className="wt-visually-hidden">Les vingt premières lignes telles qu'elles seront écrites</caption>
                  <thead>
                    <tr>
                      <th scope="col">Ligne</th>
                      <th scope="col">Action</th>
                      <th scope="col">Référence</th>
                      <th scope="col">Désignation</th>
                      <th scope="col">Valorisation</th>
                      {kind === "OPENING_STOCK" && <th scope="col" className="stock-table__num">Quantité</th>}
                      {kind === "OPENING_STOCK" && <th scope="col" className="stock-table__num">Valeur unitaire</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {plan.articles.slice(0, 20).map((article: any) => {
                      const opening = plan.openings.find((row: any) => row.row === article.row);
                      return (
                        <tr key={article.row}>
                          <td>{article.row}</td>
                          <td>
                            <Badge tone={article.action === "CREATE" ? "success" : article.action === "UPDATE" ? "warning" : "neutral"}>
                              {article.action === "CREATE" ? "Création" : article.action === "UPDATE" ? "Mise à jour" : "Ignorée"}
                            </Badge>
                          </td>
                          <td>{article.sku}</td>
                          <td>{article.designation}</td>
                          <td>{article.valuationMethod}</td>
                          {kind === "OPENING_STOCK" && <td className="stock-table__num">{opening ? formatQuantity(opening.quantity) : "—"}</td>}
                          {kind === "OPENING_STOCK" && <td className="stock-table__num">{opening ? formatValue(opening.unitValue) : "—"}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="stock-actions">
              <Button onClick={() => void confirm()} disabled={busy || plan.errors.length > 0 || plan.articles.length === 0}>
                Confirmer l'import
              </Button>
              <Button variant="secondary" onClick={() => setPlan(null)}>Abandonner</Button>
            </div>
            {plan.errors.length > 0 && (
              <p className="stock-note stock-note--alert">
                Cet import ne peut pas être confirmé tant qu'une ligne est refusée. Corrigez le fichier, ou changez
                l'association des colonnes, puis prévisualisez de nouveau.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- reports */

export function ValuationReportPanel({ companyId, workspace }: PanelProps) {
  const [asOf, setAsOf] = useState(today());
  const [groupBy, setGroupBy] = useState("ARTICLE");
  const [warehouseId, setWarehouseId] = useState("");
  const [familyId, setFamilyId] = useState("");
  const [valuationMethod, setValuationMethod] = useState("");
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await window.wheat!.getStockValuationReport({
        companyId, asOf, groupBy,
        warehouseId: warehouseId || null,
        familyId: familyId || null,
        valuationMethod: valuationMethod || null,
      }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId, asOf, groupBy, warehouseId, familyId, valuationMethod]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!report) return <LoadingState label="Calcul de la valorisation…" />;

  const hasImpairment = !isZero(report.totals.impairment);

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <TextField label="Arrêté au" type="date" value={asOf} onChange={setAsOf} />
        <SelectField label="Regroupement" value={groupBy} onChange={setGroupBy}>
          <option value="ARTICLE">Par article et dépôt</option>
          <option value="WAREHOUSE">Par dépôt</option>
          <option value="FAMILY">Par famille</option>
          <option value="METHOD">Par méthode de valorisation</option>
        </SelectField>
        <SelectField label="Dépôt" value={warehouseId} onChange={setWarehouseId}>
          <option value="">Tous les dépôts</option>
          {workspace.warehouses.map((warehouse: any) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </SelectField>
        <SelectField label="Famille" value={familyId} onChange={setFamilyId}>
          <option value="">Toutes les familles</option>
          {workspace.families.map((family: any) => <option key={family.id} value={family.id}>{family.designation}</option>)}
        </SelectField>
        <SelectField label="Valorisation" value={valuationMethod} onChange={setValuationMethod}>
          <option value="">Toutes</option>
          {(workspace.valuationMethods ?? []).map((method: string) => <option key={method} value={method}>{method}</option>)}
        </SelectField>
        <Button variant="secondary" icon={<Download size={15} />} disabled={report.rows.length === 0}
          onClick={() => downloadCsv(
            `valorisation-${asOf}.csv`,
            ["Libellé", "Détail", "Quantité", "Coût unitaire", "Valeur brute", "Dépréciation", "Valeur nette"],
            report.rows.map((row: any) => [
              row.label, row.sublabel ?? "", row.quantity.display,
              row.unitCost?.display ?? "", row.value.display, row.impairment.display, row.netValue.display,
            ]),
          )}
        >
          Exporter
        </Button>
        <Button variant="secondary" icon={<Printer size={15} />} onClick={() => window.print()} disabled={report.rows.length === 0}>
          Imprimer
        </Button>
      </div>

      {report.rows.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet size={22} />} title="Aucun stock à cette date." text="Aucun mouvement n'avait été validé au plus tard à la date d'arrêté." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <caption className="wt-visually-hidden">
              Valorisation du stock à la date d'arrêté, reconstruite à partir des mouvements.
            </caption>
            <thead>
              <tr>
                <th scope="col">Libellé</th>
                <th scope="col">Détail</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Coût unitaire</th>
                <th scope="col" className="stock-table__num">Valeur brute</th>
                {hasImpairment && <th scope="col" className="stock-table__num">Dépréciation</th>}
                {hasImpairment && <th scope="col" className="stock-table__num">Valeur nette</th>}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row: any) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{row.sublabel ?? "—"}</td>
                  <td className="stock-table__num">{formatQuantity(row.quantity)}</td>
                  <td className="stock-table__num">{row.unitCost ? formatValue(row.unitCost) : "—"}</td>
                  <td className="stock-table__num">{formatValue(row.value)}</td>
                  {hasImpairment && <td className="stock-table__num">{formatValue(row.impairment)}</td>}
                  {hasImpairment && <td className="stock-table__num">{formatValue(row.netValue)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="stock-table__num">{formatQuantity(report.totals.quantity)}</td>
                <td />
                <td className="stock-table__num">{formatValue(report.totals.value)}</td>
                {hasImpairment && <td className="stock-table__num">{formatValue(report.totals.impairment)}</td>}
                {hasImpairment && <td className="stock-table__num">{formatValue(report.totals.netValue)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

export function MovementReportPanel({ companyId, workspace, openEntry }: PanelProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [articleId, setArticleId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [direction, setDirection] = useState("");
  const [reference, setReference] = useState("");
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await window.wheat!.getStockMovementReport({
        companyId,
        from: from || null,
        to: to || null,
        articleId: articleId || null,
        warehouseId: warehouseId || null,
        documentType: documentType || null,
        direction: direction || null,
        reference: reference || null,
      }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId, from, to, articleId, warehouseId, documentType, direction, reference]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!report) return <LoadingState label="Chargement du journal des mouvements…" />;

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <TextField label="Du" type="date" value={from} onChange={setFrom} />
        <TextField label="Au" type="date" value={to} onChange={setTo} />
        <SelectField label="Article" value={articleId} onChange={setArticleId}>
          <option value="">Tous les articles</option>
          {workspace.articles.map((article: any) => <option key={article.id} value={article.id}>{article.sku} — {article.designation}</option>)}
        </SelectField>
        <SelectField label="Dépôt" value={warehouseId} onChange={setWarehouseId}>
          <option value="">Tous les dépôts</option>
          {workspace.warehouses.map((warehouse: any) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </SelectField>
        <SelectField label="Type de document" value={documentType} onChange={setDocumentType}>
          <option value="">Tous les types</option>
          {(workspace.documentTypes ?? []).map((type: any) => <option key={type.id} value={type.id}>{type.label}</option>)}
        </SelectField>
        <SelectField label="Sens" value={direction} onChange={setDirection}>
          <option value="">Entrées et sorties</option>
          <option value="IN">Entrées</option>
          <option value="OUT">Sorties</option>
        </SelectField>
        <TextField label="Référence" value={reference} onChange={setReference} placeholder="BR-2026-…" />
        <Button variant="secondary" icon={<Download size={15} />} disabled={report.rows.length === 0}
          onClick={() => downloadCsv(
            "mouvements-de-stock.csv",
            ["Date", "Référence", "Désignation", "Article", "Dépôt", "Sens", "Quantité", "Valeur", "Stock après", "Valeur après"],
            report.rows.map((row: any) => [
              formatDate(row.date), row.reference ?? "", row.designation, row.article.sku, row.warehouse.name,
              row.direction, row.quantity.display, row.value.display,
              row.resultingQuantity.display, row.resultingValue.display,
            ]),
          )}
        >
          Exporter
        </Button>
      </div>

      {report.rows.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet size={22} />} title="Aucun mouvement" text="Aucun mouvement ne correspond à ces filtres." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Référence</th>
                <th scope="col">Désignation</th>
                <th scope="col">Article</th>
                <th scope="col">Dépôt</th>
                <th scope="col">Tiers</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Valeur</th>
                <th scope="col">Écriture</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row: any) => (
                <tr key={row.id}>
                  <td className="stock-table__date">{formatDate(row.date)}</td>
                  <td>{row.reference ?? "—"}</td>
                  <td>{row.designation}</td>
                  <td>{row.article.sku}</td>
                  <td>{row.warehouse.name}</td>
                  <td>{row.counterparty?.displayName ?? "—"}</td>
                  <td className="stock-table__num">
                    {row.direction === "IN" ? "+" : "−"}{formatQuantity(row.quantity)}
                  </td>
                  <td className="stock-table__num">{formatValue(row.value)}</td>
                  <td>
                    {row.accountingEntryId
                      ? <Button variant="secondary" onClick={() => openEntry?.(row.accountingEntryId)}>Ouvrir</Button>
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>Total entrées / sorties</td>
                <td className="stock-table__num">
                  +{formatQuantity(report.totals.inQuantity)} / −{formatQuantity(report.totals.outQuantity)}
                </td>
                <td className="stock-table__num">
                  {formatValue(report.totals.inValue)} / {formatValue(report.totals.outValue)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Anomalies the engine can prove, not anomalies it suspects.
 *
 * Every row here is a statement about arithmetic — a negative quantity, a value
 * with no quantity behind it, FIFO layers that do not add up to the position
 * they belong to. None of it is a heuristic, which is why each one is worth
 * acting on.
 */
export function AnomalyReportPanel({ companyId, workspace }: PanelProps) {
  const [warehouseId, setWarehouseId] = useState("");
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await window.wheat!.getStockAnomalyReport({ companyId, warehouseId: warehouseId || null }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId, warehouseId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!report) return <LoadingState label="Contrôle des positions…" />;

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <SelectField label="Dépôt" value={warehouseId} onChange={setWarehouseId}>
          <option value="">Tous les dépôts</option>
          {workspace.warehouses.map((warehouse: any) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </SelectField>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>Actualiser</Button>
      </div>

      {report.anomalies.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={22} />}
          title="Aucune anomalie détectée"
          text="Chaque position détenue porte une quantité et une valeur cohérentes, et les couches FIFO totalisent exactement leur position."
        />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Article</th>
                <th scope="col">Dépôt</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Valeur</th>
                <th scope="col">Constat</th>
              </tr>
            </thead>
            <tbody>
              {report.anomalies.map((anomaly: any, index: number) => (
                <tr key={`${anomaly.articleId}-${anomaly.kind}-${index}`} className="stock-table__row--alert">
                  <td>{anomaly.sku} — {anomaly.designation}</td>
                  <td>{anomaly.warehouseName}</td>
                  <td className="stock-table__num">{formatQuantity(anomaly.quantity)}</td>
                  <td className="stock-table__num">{formatValue(anomaly.value)}</td>
                  <td>{anomaly.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="stock-note">
        Ces constats sont déterministes : chacun est une propriété arithmétique de la position, pas une suspicion.
        La correction passe par un ajustement ou une contrepassation — jamais par une modification de l'historique validé.
      </p>
    </div>
  );
}

export function AgeingReportPanel({ companyId, workspace }: PanelProps) {
  const [asOf, setAsOf] = useState(today());
  const [warehouseId, setWarehouseId] = useState("");
  const [minimumDays, setMinimumDays] = useState("");
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await window.wheat!.getStockAgeingReport({
        companyId, asOf,
        warehouseId: warehouseId || null,
        minimumDays: minimumDays ? Number(minimumDays) : null,
      }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId, asOf, warehouseId, minimumDays]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!report) return <LoadingState label="Calcul de la rotation…" />;

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <TextField label="Arrêté au" type="date" value={asOf} onChange={setAsOf} />
        <SelectField label="Dépôt" value={warehouseId} onChange={setWarehouseId}>
          <option value="">Tous les dépôts</option>
          {workspace.warehouses.map((warehouse: any) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </SelectField>
        <TextField label="Sans mouvement depuis (jours)" value={minimumDays} onChange={setMinimumDays} placeholder="90" />
        <Button variant="secondary" icon={<Download size={15} />} disabled={report.rows.length === 0}
          onClick={() => downloadCsv(
            `rotation-${asOf}.csv`,
            ["Référence", "Article", "Dépôt", "Quantité", "Valeur", "Dernier mouvement", "Jours sans mouvement", "Dernière sortie"],
            report.rows.map((row: any) => [
              row.sku, row.designation, row.warehouse.name, row.quantity.display, row.value.display,
              row.lastMovementDate ? String(row.lastMovementDate).slice(0, 10) : "",
              row.days === null ? "" : String(row.days),
              row.lastIssueDate ? String(row.lastIssueDate).slice(0, 10) : "",
            ]),
          )}
        >
          Exporter
        </Button>
      </div>

      <div className="stock-summary">
        {report.buckets.map((bucket: any) => (
          <div key={bucket.label} className="stock-summary__item">
            <span className="stock-summary__label">{bucket.label}</span>
            <span className="stock-summary__value">{bucket.positions} · {formatValue(bucket.value)} MAD</span>
          </div>
        ))}
      </div>

      {report.rows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck size={22} />} title="Aucune position détenue" text="Aucun article n'est en stock à cette date avec ces filtres." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <caption className="wt-visually-hidden">
              Ancienneté des positions détenues, mesurée depuis le dernier mouvement enregistré.
            </caption>
            <thead>
              <tr>
                <th scope="col">Référence</th>
                <th scope="col">Article</th>
                <th scope="col">Dépôt</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Valeur</th>
                <th scope="col">Dernier mouvement</th>
                <th scope="col" className="stock-table__num">Jours</th>
                <th scope="col">Dernière sortie</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row: any) => (
                <tr key={`${row.articleId}-${row.warehouse.id}`}>
                  <td>{row.sku}</td>
                  <td>{row.designation}</td>
                  <td>{row.warehouse.name}</td>
                  <td className="stock-table__num">{formatQuantity(row.quantity)}</td>
                  <td className="stock-table__num">{formatValue(row.value)}</td>
                  <td className="stock-table__date">{formatDate(row.lastMovementDate)}</td>
                  <td className="stock-table__num">{row.days ?? "—"}</td>
                  <td className="stock-table__date">
                    {row.lastIssueDate ? formatDate(row.lastIssueDate) : <Badge tone="warning">jamais sortie</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="stock-note">
        Une position « lente » est ici une position dont le dernier mouvement est ancien, avec la date qui le dit.
        Wheat ne classe pas un article comme obsolète : c'est un jugement, et il appartient au comptable.
      </p>
    </div>
  );
}

/** The report set, as one tabbed section rather than five separate screens. */
export function ReportsPanel(props: PanelProps) {
  const [tab, setTab] = useState("valuation");
  const tabs: TabItem[] = useMemo(() => [
    { id: "valuation", label: "Valorisation" },
    { id: "movements", label: "Mouvements" },
    { id: "anomalies", label: "Anomalies" },
    { id: "ageing", label: "Rotation" },
  ], []);
  return (
    <div className="stock-workspace">
      <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Rapports de stock" />
      {tab === "valuation" && <ValuationReportPanel {...props} />}
      {tab === "movements" && <MovementReportPanel {...props} />}
      {tab === "anomalies" && <AnomalyReportPanel {...props} />}
      {tab === "ageing" && <AgeingReportPanel {...props} />}
    </div>
  );
}

/* --------------------------------------------------- units and conversions */

/** A chart picker that shows the code beside the label, as an accountant reads it. */
export function AccountPicker({ label, accounts, value, onChange }: {
  label: string;
  accounts: Array<{ id: string; code: string; label: string }> | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SelectField label={label} value={value} onChange={onChange}>
      <option value="">Non paramétré</option>
      {(accounts ?? []).map((account) => (
        <option key={account.id} value={account.id}>{account.code} — {account.label}</option>
      ))}
    </SelectField>
  );
}

/**
 * Units, and the conversions between them.
 *
 * A conversion is stated once — "1 carton = 12 unité" — and Wheat derives the
 * other direction from it. A factor that contradicts what the existing
 * conversions already imply is refused when it is saved rather than producing a
 * graph that answers the same question two different ways.
 *
 * Retiring a conversion deactivates it. Every document line already written
 * carries the factor it used, so nothing historical moves either way.
 */
export function UnitConversionsCard({ companyId, workspace, notify, onSaved }: {
  companyId: string;
  workspace: any;
  notify?: (message: string, tone?: "success" | "warning" | "info") => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<any>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      notify?.(success, "success");
      setDraft(null);
      onSaved();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const units = workspace.units ?? [];
  const conversions = (workspace.conversions ?? []).filter((conversion: any) => conversion.active);

  return (
    <Card
      title="Unités et conversions"
      note="Une conversion n'est jamais supposée : « 1 carton = 12 unité » est un fait sur le conditionnement du dossier, pas sur les mots."
    >
      {error && <ErrorState cause={error} fix="Corrigez le facteur puis enregistrez à nouveau." />}

      <div className="stock-actions">
        <Button
          disabled={units.length < 2}
          onClick={() => setDraft({ fromUnitId: units[0]?.id ?? "", toUnitId: units[1]?.id ?? "", factor: "" })}
        >
          Ajouter une conversion
        </Button>
      </div>

      {units.length < 2 && (
        <p className="stock-note">Une conversion relie deux unités : créez-en au moins deux dans le catalogue.</p>
      )}

      {draft && (
        <>
          <div className="stock-filters">
            <SelectField label="1 unité de" value={draft.fromUnitId} onChange={(fromUnitId) => setDraft({ ...draft, fromUnitId })}>
              {units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.code} — {unit.label}</option>)}
            </SelectField>
            <TextField label="vaut" value={draft.factor} placeholder="12" onChange={(factor) => setDraft({ ...draft, factor })} />
            <SelectField label="de l'unité" value={draft.toUnitId} onChange={(toUnitId) => setDraft({ ...draft, toUnitId })}>
              {units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.code} — {unit.label}</option>)}
            </SelectField>
          </div>
          <div className="stock-actions">
            <Button
              disabled={busy || !draft.factor.trim() || draft.fromUnitId === draft.toUnitId}
              onClick={() => void act(() => window.wheat!.saveStockUnitConversion({ companyId, ...draft }), "Conversion enregistrée.")}
            >
              Enregistrer
            </Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>Annuler</Button>
          </div>
        </>
      )}

      {conversions.length === 0 ? (
        <p className="stock-note">
          Aucune conversion paramétrée : chaque ligne de document se saisit alors dans l'unité de stock de son article.
        </p>
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Unité de départ</th>
                <th scope="col" className="stock-table__num">Facteur</th>
                <th scope="col">Unité d'arrivée</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {conversions.map((conversion: any) => (
                <tr key={conversion.id}>
                  <td>1 {conversion.fromUnit.label || conversion.fromUnit.code}</td>
                  <td className="stock-table__num">{formatQuantity(conversion.factor)}</td>
                  <td>{conversion.toUnit.label || conversion.toUnit.code}</td>
                  <td>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void act(() => window.wheat!.deleteStockUnitConversion({ companyId, id: conversion.id }),
                        "Conversion retirée.")}
                    >
                      Retirer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="stock-note">
        Une quantité saisie dans une autre unité est convertie une seule fois, au moment où la ligne est écrite, et le
        facteur employé est conservé sur la ligne. Modifier une conversion plus tard change ce que les nouvelles lignes
        donneront et ne touche à aucun mouvement déjà validé. Une conversion qui ne tombe pas juste à six décimales est
        refusée : Wheat n'arrondit pas une quantité de stock.
      </p>
    </Card>
  );
}
