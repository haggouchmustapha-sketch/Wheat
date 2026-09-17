import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ClipboardCheck,
  FileSpreadsheet,
  Layers,
  Package,
  RefreshCw,
  Settings2,
  TrendingDown,
  Upload,
  Warehouse,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Tabs,
  type TabItem,
} from "./ui";
import { Fact, TextField } from "./StockFields";
import { downloadCsv, formatDate, formatQuantity, formatValue, messageOf } from "./stockFormat";
import {
  AccountPicker,
  ImpairmentsPanel,
  ImportPanel,
  InventoryPanel,
  ReportsPanel,
  UnitConversionsCard,
  WarehousesPanel,
} from "./StockPanels";
import "./StockWorkspace.css";

/**
 * Stock, as an accountant reads it.
 *
 * The centre of this screen is the article stock card: one row per movement,
 * with the running quantity and the running value after it, in the columns the
 * specification names. Everything a user does here — choosing an article, a
 * dépôt, a period — changes which rows that table shows.
 *
 * Numbers arrive from the main process as exact decimal strings (`display`)
 * beside their scaled integer (`raw`). This component formats the string for
 * reading and never parses it into a JavaScript number: a float here would
 * reintroduce, at the last possible moment, exactly the error the whole module
 * is built to avoid. `formatDecimal` therefore works on the text.
 */

type StockWorkspaceProps = {
  companyId: string | null | undefined;
  notify?: (message: string, tone?: "success" | "warning" | "info") => void;
  openEntry?: (entryId: string) => void;
};

export default function StockWorkspace({ companyId, notify, openEntry }: StockWorkspaceProps) {
  const [tab, setTab] = useState("card");
  const [workspace, setWorkspace] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId || !window.wheat) return;
    setLoading(true);
    setError(null);
    try {
      setWorkspace(await window.wheat.getStockWorkspace({ companyId }));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const tabs: TabItem[] = useMemo(() => [
    { id: "card", label: "Fiche de stock", icon: <FileSpreadsheet size={15} /> },
    { id: "state", label: "État du stock", icon: <Layers size={15} /> },
    { id: "articles", label: "Articles", icon: <Package size={15} />, count: workspace?.articles?.length },
    { id: "warehouses", label: "Dépôts", icon: <Warehouse size={15} />, count: workspace?.warehouses?.length },
    { id: "documents", label: "Mouvements", icon: <Boxes size={15} />, count: workspace?.overview?.draftDocuments },
    { id: "inventory", label: "Inventaire physique", icon: <ClipboardCheck size={15} /> },
    { id: "impairments", label: "Dépréciations", icon: <TrendingDown size={15} /> },
    { id: "imports", label: "Imports", icon: <Upload size={15} /> },
    { id: "reports", label: "Rapports", icon: <BarChart3 size={15} /> },
    { id: "settings", label: "Paramétrage", icon: <Settings2 size={15} /> },
  ], [workspace]);

  if (!companyId) {
    return <EmptyState icon={<Warehouse size={22} />} title="Aucun dossier ouvert" text="Ouvrez un dossier pour gérer son stock." />;
  }
  if (loading && !workspace) return <LoadingState label="Chargement du stock…" rows={4} />;
  if (error && !workspace) {
    return <ErrorState cause={error} fix="Vérifiez que le dossier est ouvert, puis réessayez." onRetry={() => void load()} />;
  }
  if (!workspace) return null;

  const { overview, settings } = workspace;

  return (
    <div className="stock-workspace">
      <div className="stock-summary">
        <SummaryItem label="Valeur du stock" value={`${formatValue(overview.totalValue)} MAD`} />
        <SummaryItem label="Articles actifs" value={String(overview.activeArticles)} />
        <SummaryItem label="Sous le minimum" value={String(overview.belowMinimum)} alert={overview.belowMinimum > 0} />
        <SummaryItem label="En rupture" value={String(overview.outOfStock)} alert={overview.outOfStock > 0} />
        <SummaryItem label="Lots proches de péremption" value={String(overview.expiringLots)} alert={overview.expiringLots > 0} />
        <SummaryItem label="Brouillons en attente" value={String(overview.draftDocuments)} />
      </div>

      {!settings.configured && (
        <Card
          title="Le paramétrage comptable du stock est incomplet"
          icon={<AlertTriangle size={16} />}
          actions={<Button variant="secondary" onClick={() => setTab("settings")}>Ouvrir le paramétrage</Button>}
        >
          <p className="stock-note">
            Wheat ne choisit aucun compte à votre place. Tant qu'un journal et au moins un compte de stock
            ne sont pas paramétrés, la validation d'un document reste bloquée plutôt que de comptabiliser
            sur un compte supposé.
          </p>
        </Card>
      )}

      <Tabs items={tabs} value={tab} onChange={setTab} ariaLabel="Sections du stock" />

      {tab === "card" && <StockCardPanel companyId={companyId} workspace={workspace} openEntry={openEntry} />}
      {tab === "state" && <StockStatePanel companyId={companyId} workspace={workspace} />}
      {tab === "articles" && <ArticlesPanel companyId={companyId} workspace={workspace} notify={notify} onSaved={load} />}
      {tab === "warehouses" && <WarehousesPanel companyId={companyId} workspace={workspace} notify={notify} onChanged={load} />}
      {tab === "documents" && <DocumentsPanel companyId={companyId} notify={notify} onChanged={load} />}
      {tab === "inventory" && <InventoryPanel companyId={companyId} workspace={workspace} notify={notify} onChanged={load} />}
      {tab === "impairments" && <ImpairmentsPanel companyId={companyId} workspace={workspace} notify={notify} onChanged={load} openEntry={openEntry} />}
      {tab === "imports" && <ImportPanel companyId={companyId} workspace={workspace} notify={notify} onChanged={load} />}
      {tab === "reports" && <ReportsPanel companyId={companyId} workspace={workspace} openEntry={openEntry} />}
      {tab === "settings" && <SettingsPanel companyId={companyId} workspace={workspace} notify={notify} onSaved={load} />}
    </div>
  );
}

function SummaryItem({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={alert ? "stock-summary__item stock-summary__item--alert" : "stock-summary__item"}>
      <span className="stock-summary__label">{label}</span>
      <span className="stock-summary__value">{value}</span>
    </div>
  );
}

/* -------------------------------------------------------------- stock card */

/**
 * The signature table.
 *
 * Columns are exactly those the specification names, and each one means what it
 * says: Achats holds acquisitions, Ventes holds sales, and a transfer, a
 * production run or an inventory adjustment appears in the neutral Mouvement
 * column under its own label rather than being dressed up as a purchase.
 */
function StockCardPanel({ companyId, workspace, openEntry }: { companyId: string; workspace: any; openEntry?: (entryId: string) => void }) {
  const [articleId, setArticleId] = useState<string>(workspace.articles?.[0]?.id ?? "");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [card, setCard] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!articleId || !window.wheat) { setCard(null); return; }
    setLoading(true);
    setError(null);
    try {
      setCard(await window.wheat.getStockCard({
        companyId,
        articleId,
        warehouseId: warehouseId || null,
        from: from || null,
        to: to || null,
      }));
    } catch (caught) {
      setError(messageOf(caught));
      setCard(null);
    } finally {
      setLoading(false);
    }
  }, [companyId, articleId, warehouseId, from, to]);

  useEffect(() => { void load(); }, [load]);

  const openRow = async (movementId: string) => {
    setSelected(movementId);
    setDetail(null);
    try {
      setDetail(await window.wheat!.getStockMovement({ companyId, movementId }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  if ((workspace.articles ?? []).length === 0) {
    return (
      <EmptyState
        icon={<Package size={22} />}
        title="Aucun article enregistré."
        text="Créez un article, puis saisissez son stock initial pour voir sa fiche se remplir."
      />
    );
  }

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <div className="stock-filters__field">
          <label htmlFor="stock-card-article">Article</label>
          <select id="stock-card-article" value={articleId} onChange={(event) => setArticleId(event.target.value)}>
            {workspace.articles.map((article: any) => (
              <option key={article.id} value={article.id}>{article.sku} — {article.designation}</option>
            ))}
          </select>
        </div>
        <div className="stock-filters__field">
          <label htmlFor="stock-card-warehouse">Dépôt</label>
          <select id="stock-card-warehouse" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
            <option value="">Tous les dépôts</option>
            {workspace.warehouses.map((warehouse: any) => (
              <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
            ))}
          </select>
        </div>
        <div className="stock-filters__field">
          <label htmlFor="stock-card-from">Du</label>
          <input id="stock-card-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="stock-filters__field">
          <label htmlFor="stock-card-to">Au</label>
          <input id="stock-card-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>Actualiser</Button>
        <Button variant="secondary" onClick={() => exportCardCsv(card)} disabled={!card || card.rows.length === 0}>
          Exporter en CSV
        </Button>
        <Button variant="secondary" onClick={() => window.print()} disabled={!card || card.rows.length === 0}>
          Imprimer
        </Button>
      </div>

      {error && <ErrorState cause={error} fix="Corrigez les filtres ou rechargez la fiche." onRetry={() => void load()} />}

      {card && (
        <>
          <dl className="stock-card__identity">
            <Fact label="Désignation" value={card.article.designation} />
            <Fact label="Référence" value={card.article.sku} />
            {card.article.barcode && <Fact label="Code-barres" value={card.article.barcode} />}
            <Fact label="Famille" value={card.article.family?.designation ?? "—"} />
            <Fact label="Unité" value={card.article.unit?.label ?? "—"} />
            <Fact label="Valorisation" value={card.header.valuationMethod} />
            <Fact label="Stock en quantité" value={formatQuantity(card.header.currentQuantity)} />
            <Fact label="Stock en valeur" value={`${formatValue(card.header.currentValue)} MAD`} />
            <Fact label="Coût unitaire" value={card.header.unitCost ? `${formatValue(card.header.unitCost)} MAD` : "—"} />
            <Fact label="Stock minimum" value={formatQuantity(card.article.minQuantity)} />
          </dl>

          {loading && <LoadingState label="Chargement des mouvements…" />}

          <div className="stock-table-wrap">
            <table className="stock-table">
              <caption className="wt-visually-hidden">
                Fiche de stock de {card.article.designation} : un mouvement par ligne, avec le stock en quantité et en valeur après chaque mouvement.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Désignation</th>
                  <th scope="col" className="stock-table__num">Stock init (1er achat)</th>
                  <th scope="col" className="stock-table__num">Achats</th>
                  <th scope="col" className="stock-table__num">Ventes</th>
                  <th scope="col" className="stock-table__num">Mouvement</th>
                  <th scope="col" className="stock-table__num">Stock en quant</th>
                  <th scope="col" className="stock-table__num">Stock en valeur</th>
                </tr>
              </thead>
              <tbody>
                {(from && (card.opening.quantity.raw !== "0" || card.opening.value.raw !== "0")) && (
                  <tr className="stock-table__opening">
                    <td className="stock-table__date">{formatDate(from)}</td>
                    <td className="stock-table__designation">Report à nouveau</td>
                    <td className="stock-table__num" />
                    <td className="stock-table__num" />
                    <td className="stock-table__num" />
                    <td className="stock-table__num" />
                    <td className="stock-table__num">{formatQuantity(card.opening.quantity)}</td>
                    <td className="stock-table__num">{formatValue(card.opening.value)}</td>
                  </tr>
                )}
                {card.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="stock-table__empty">Aucun mouvement de stock.</td>
                  </tr>
                )}
                {card.rows.map((row: any) => (
                  <tr
                    key={row.id}
                    aria-selected={selected === row.id}
                    onClick={() => void openRow(row.id)}
                    onKeyDown={(event) => { if (event.key === "Enter") void openRow(row.id); }}
                    tabIndex={0}
                  >
                    <td className="stock-table__date">{formatDate(row.date)}</td>
                    <td className="stock-table__designation">{row.designation}</td>
                    <td className="stock-table__num">{row.column === "OPENING" ? formatQuantity(row.quantity) : ""}</td>
                    <td className="stock-table__num">{row.column === "PURCHASE" ? formatQuantity(row.quantity) : ""}</td>
                    <td className="stock-table__num">{row.column === "SALE" ? formatQuantity(row.quantity) : ""}</td>
                    <td className="stock-table__num">
                      {row.column === "OTHER" ? `${row.direction === "IN" ? "+" : "−"}${formatQuantity(row.quantity)}` : ""}
                    </td>
                    <td className="stock-table__num">{formatQuantity(row.runningQuantity)}</td>
                    <td className="stock-table__num">{formatValue(row.runningValue)}</td>
                  </tr>
                ))}
              </tbody>
              {card.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6}>Position finale</td>
                    <td className="stock-table__num">{formatQuantity(card.rows[card.rows.length - 1].runningQuantity)}</td>
                    <td className="stock-table__num">{formatValue(card.rows[card.rows.length - 1].runningValue)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {detail && <MovementDetail detail={detail} openEntry={openEntry} />}
        </>
      )}
    </div>
  );
}

/** Where a movement's value came from, including the FIFO layers it consumed. */
function MovementDetail({ detail, openEntry }: { detail: any; openEntry?: (entryId: string) => void }) {
  const { movement, document, fifo, landedCosts } = detail;
  return (
    <div className="stock-detail">
      <div className="stock-section-title">
        <h3>{movement.designation}</h3>
        <Badge tone={movement.direction === "IN" ? "success" : "warning"}>
          {movement.direction === "IN" ? "Entrée" : "Sortie"}
        </Badge>
      </div>
      <dl className="stock-detail__grid">
        <Fact label="Document" value={document?.reference ?? "—"} />
        <Fact label="Statut" value={document?.status ?? "—"} />
        <Fact label="Quantité" value={formatQuantity(movement.quantity)} />
        <Fact label="Valeur du mouvement" value={`${formatValue(movement.value)} MAD`} />
        <Fact label="Valorisation unitaire" value={movement.unitValue ? `${formatValue(movement.unitValue)} MAD` : "—"} />
        <Fact label="Quantité avant" value={formatQuantity(movement.beforeQuantity)} />
        <Fact label="Quantité après" value={formatQuantity(movement.afterQuantity)} />
        <Fact label="Valeur avant" value={`${formatValue(movement.beforeValue)} MAD`} />
        <Fact label="Valeur après" value={`${formatValue(movement.afterValue)} MAD`} />
        <Fact label="Dépôt" value={movement.warehouse?.name ?? "—"} />
        <Fact label="Lot" value={movement.lot?.code ?? "—"} />
        <Fact label="Tiers" value={document?.counterparty?.displayName ?? "—"} />
        <Fact label="Créé par" value={document?.createdBy?.name ?? "—"} />
        <Fact label="Validé par" value={document?.validatedBy?.name ?? "—"} />
        <Fact label="Date de validation" value={formatDate(document?.validatedAt)} />
        <Fact label="Contrepassé le" value={formatDate(document?.reversedAt)} />
      </dl>

      {document?.accountingEntry && (
        <div className="stock-actions">
          <Button variant="secondary" onClick={() => openEntry?.(document.accountingEntry.id)}>
            Ouvrir l'écriture {document.accountingEntry.pieceNumber ?? document.accountingEntry.number} ({document.accountingEntry.status})
          </Button>
        </div>
      )}

      {landedCosts?.length > 0 && (
        <table className="stock-detail__fifo">
          <caption className="wt-visually-hidden">Frais d'acquisition imputés à cette ligne</caption>
          <thead>
            <tr><th scope="col">Frais</th><th scope="col">Répartition</th><th scope="col" className="stock-table__num">Montant imputé</th></tr>
          </thead>
          <tbody>
            {landedCosts.map((charge: any, index: number) => (
              <tr key={index}>
                <td>{charge.label}</td>
                <td>{charge.method}</td>
                <td className="stock-table__num">{formatValue(charge.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fifo?.length > 0 && (
        <table className="stock-detail__fifo">
          <caption className="wt-visually-hidden">Couches FIFO consommées par ce mouvement</caption>
          <thead>
            <tr>
              <th scope="col">Couche d'acquisition</th>
              <th scope="col">Date</th>
              <th scope="col">Nature</th>
              <th scope="col" className="stock-table__num">Quantité</th>
              <th scope="col" className="stock-table__num">Valeur</th>
            </tr>
          </thead>
          <tbody>
            {fifo.map((consumption: any) => (
              <tr key={consumption.id}>
                <td>{consumption.layerReference ?? consumption.layerId}</td>
                <td>{formatDate(consumption.layerDate)}</td>
                <td>{consumption.kind === "RESTORATION" ? "Restitution" : "Consommation"}</td>
                <td className="stock-table__num">{formatQuantity(consumption.quantity)}</td>
                <td className="stock-table__num">{formatValue(consumption.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Exports the visible card.
 *
 * The exact decimal the register holds, not the grouped display string: a
 * spreadsheet that receives "1 650,00" with a space in it reads it as text.
 */
function exportCardCsv(card: any) {
  if (!card) return;
  downloadCsv(
    `fiche-stock-${card.article.sku}.csv`,
    ["Date", "Désignation", "Stock init (1er achat)", "Achats", "Ventes", "Mouvement", "Stock en quant", "Stock en valeur"],
    card.rows.map((row: any) => [
      formatDate(row.date),
      row.designation,
      row.column === "OPENING" ? row.quantity.display : "",
      row.column === "PURCHASE" ? row.quantity.display : "",
      row.column === "SALE" ? row.quantity.display : "",
      row.column === "OTHER" ? `${row.direction === "IN" ? "" : "-"}${row.quantity.display}` : "",
      row.runningQuantity.display,
      row.runningValue.display,
    ]),
  );
}

/* ------------------------------------------------------------- stock state */

function StockStatePanel({ companyId, workspace }: { companyId: string; workspace: any }) {
  const [warehouseId, setWarehouseId] = useState("");
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await window.wheat!.getStockState({ companyId, warehouseId: warehouseId || null }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId, warehouseId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!state) return <LoadingState label="Chargement de l'état du stock…" />;

  return (
    <div className="stock-workspace">
      <div className="stock-filters">
        <div className="stock-filters__field">
          <label htmlFor="stock-state-warehouse">Dépôt</label>
          <select id="stock-state-warehouse" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
            <option value="">Tous les dépôts</option>
            {workspace.warehouses.map((warehouse: any) => (
              <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
            ))}
          </select>
        </div>
      </div>
      {state.rows.length === 0 ? (
        <EmptyState icon={<Layers size={22} />} title="Aucun mouvement de stock." text="Saisissez un stock initial pour commencer." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Référence</th>
                <th scope="col">Article</th>
                <th scope="col">Dépôt</th>
                <th scope="col">Lot</th>
                <th scope="col">Valorisation</th>
                <th scope="col" className="stock-table__num">Quantité</th>
                <th scope="col" className="stock-table__num">Coût unitaire</th>
                <th scope="col" className="stock-table__num">Valeur</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row: any) => (
                <tr key={row.id}>
                  <td>{row.article.sku}</td>
                  <td>{row.article.designation}</td>
                  <td>{row.warehouse.name}</td>
                  <td>{row.lot?.code ?? "—"}</td>
                  <td>{row.article.valuationMethod}</td>
                  <td className="stock-table__num">
                    {formatQuantity(row.quantity)}
                    {row.belowMinimum && <> <Badge tone="warning">sous le minimum</Badge></>}
                  </td>
                  <td className="stock-table__num">{row.unitCost ? formatValue(row.unitCost) : "—"}</td>
                  <td className="stock-table__num">{formatValue(row.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Total</td>
                <td className="stock-table__num">{formatQuantity(state.totals.quantity)}</td>
                <td />
                <td className="stock-table__num">{formatValue(state.totals.value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- articles */

function ArticlesPanel({ companyId, workspace, notify, onSaved }: { companyId: string; workspace: any; notify?: StockWorkspaceProps["notify"]; onSaved: () => void }) {
  const [draft, setDraft] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blank = () => ({
    sku: "", designation: "", barcode: "", familyId: "",
    unitId: workspace.units?.[0]?.id ?? "", valuationMethod: "CMP",
    minQuantity: "", lotTracking: false, expiryTracking: false,
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.wheat!.saveStockArticle({ companyId, ...draft, minQuantity: draft.minQuantity || undefined });
      notify?.("Article enregistré.", "success");
      setDraft(null);
      onSaved();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  if (workspace.units.length === 0) {
    return (
      <EmptyState
        icon={<Package size={22} />}
        title="Aucune unité de mesure"
        text="Un article se compte dans une unité. Créez d'abord une unité (unité, kg, carton…) dans le paramétrage."
      />
    );
  }

  return (
    <div className="stock-workspace">
      <div className="stock-actions">
        <Button onClick={() => setDraft(blank())}>Créer un article</Button>
      </div>

      {draft && (
        <Card title={draft.id ? "Modifier l'article" : "Nouvel article"}>
          {error && <ErrorState cause={error} fix="Corrigez la fiche puis enregistrez à nouveau." />}
          <div className="stock-filters">
            <TextField label="Référence (SKU)" value={draft.sku} onChange={(value) => setDraft({ ...draft, sku: value })} />
            <TextField label="Désignation" value={draft.designation} onChange={(value) => setDraft({ ...draft, designation: value })} />
            <TextField label="Code-barres" value={draft.barcode} onChange={(value) => setDraft({ ...draft, barcode: value })} />
            <div className="stock-filters__field">
              <label htmlFor="article-unit">Unité</label>
              <select id="article-unit" value={draft.unitId} onChange={(event) => setDraft({ ...draft, unitId: event.target.value })}>
                {workspace.units.map((unit: any) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
              </select>
            </div>
            <div className="stock-filters__field">
              <label htmlFor="article-family">Famille</label>
              <select id="article-family" value={draft.familyId} onChange={(event) => setDraft({ ...draft, familyId: event.target.value })}>
                <option value="">Aucune</option>
                {workspace.families.map((family: any) => <option key={family.id} value={family.id}>{family.designation}</option>)}
              </select>
            </div>
            <div className="stock-filters__field">
              <label htmlFor="article-valuation">Valorisation</label>
              <select id="article-valuation" value={draft.valuationMethod} onChange={(event) => setDraft({ ...draft, valuationMethod: event.target.value })}>
                {workspace.valuationMethods.map((method: string) => <option key={method} value={method}>{method}</option>)}
              </select>
            </div>
            <TextField label="Stock minimum" value={draft.minQuantity} onChange={(value) => setDraft({ ...draft, minQuantity: value })} />
          </div>
          <div className="stock-actions">
            <Button onClick={() => void save()} disabled={saving}>Enregistrer</Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>Annuler</Button>
          </div>
        </Card>
      )}

      {workspace.articles.length === 0 ? (
        <EmptyState icon={<Package size={22} />} title="Aucun article enregistré." text="Créez votre premier article pour commencer." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Référence</th>
                <th scope="col">Désignation</th>
                <th scope="col">Famille</th>
                <th scope="col">Unité</th>
                <th scope="col">Valorisation</th>
                <th scope="col" className="stock-table__num">Stock min.</th>
                <th scope="col">Suivi</th>
              </tr>
            </thead>
            <tbody>
              {workspace.articles.map((article: any) => (
                <tr key={article.id} onClick={() => setDraft({
                  id: article.id, sku: article.sku, designation: article.designation,
                  barcode: article.barcode ?? "", familyId: article.familyId ?? "", unitId: article.unitId,
                  valuationMethod: article.valuationMethod, minQuantity: article.minQuantity.display,
                  lotTracking: article.lotTracking, expiryTracking: article.expiryTracking,
                })}>
                  <td>{article.sku}</td>
                  <td>{article.designation}</td>
                  <td>{article.family?.designation ?? "—"}</td>
                  <td>{article.unit?.code ?? "—"}</td>
                  <td>{article.valuationMethod}</td>
                  <td className="stock-table__num">{formatQuantity(article.minQuantity)}</td>
                  <td>
                    {article.lotTracking && <Badge tone="info">lot</Badge>}
                    {article.expiryTracking && <> <Badge tone="warning">péremption</Badge></>}
                    {!article.active && <> <Badge tone="neutral">désactivé</Badge></>}
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

/* --------------------------------------------------------------- documents */

function DocumentsPanel({ companyId, notify, onChanged }: { companyId: string; notify?: StockWorkspaceProps["notify"]; onChanged: () => void }) {
  const [documents, setDocuments] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDocuments(await window.wheat!.getStockDocuments({ companyId }));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (documentId: string, action: "validate" | "reverse") => {
    setBusy(documentId);
    setError(null);
    try {
      if (action === "validate") await window.wheat!.validateStockDocument({ companyId, documentId });
      else await window.wheat!.reverseStockDocument({ companyId, documentId });
      notify?.(action === "validate" ? "Document validé." : "Document contrepassé.", "success");
      await load();
      onChanged();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  if (error && !documents) return <ErrorState cause={error} onRetry={() => void load()} />;
  if (!documents) return <LoadingState label="Chargement des documents…" />;

  return (
    <div className="stock-workspace">
      {error && <ErrorState cause={error} fix="Corrigez le document puis réessayez." />}
      {documents.length === 0 ? (
        <EmptyState icon={<Boxes size={22} />} title="Aucun document de stock." text="Les bons de réception et de sortie apparaîtront ici." />
      ) : (
        <div className="stock-table-wrap">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Référence</th>
                <th scope="col">Type</th>
                <th scope="col">Dépôt</th>
                <th scope="col">Tiers</th>
                <th scope="col">Statut</th>
                <th scope="col">Écriture</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document: any) => (
                <tr key={document.id}>
                  <td className="stock-table__date">{formatDate(document.documentDate)}</td>
                  <td>{document.reference}</td>
                  <td>{document.type}</td>
                  <td>{document.warehouse?.name}{document.targetWarehouse ? ` → ${document.targetWarehouse.name}` : ""}</td>
                  <td>{document.counterparty?.displayName ?? "—"}</td>
                  <td>
                    <Badge tone={document.status === "VALIDATED" ? "success" : document.status === "REVERSED" ? "neutral" : "info"}>
                      {document.status}
                    </Badge>
                  </td>
                  <td>{document.accountingEntry ? `${document.accountingEntry.number} (${document.accountingEntry.status})` : "—"}</td>
                  <td>
                    {document.status === "DRAFT" && (
                      <Button variant="secondary" onClick={() => void act(document.id, "validate")} disabled={busy === document.id}>
                        Valider
                      </Button>
                    )}
                    {document.status === "VALIDATED" && !document.reversedAt && (
                      <Button variant="secondary" onClick={() => void act(document.id, "reverse")} disabled={busy === document.id}>
                        Contrepasser
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

/* ---------------------------------------------------------------- settings */

function SettingsPanel({ companyId, workspace, notify, onSaved }: { companyId: string; workspace: any; notify?: StockWorkspaceProps["notify"]; onSaved: () => void }) {
  const [journalId, setJournalId] = useState(workspace.settings.stockJournalId ?? "");
  const [allowNegative, setAllowNegative] = useState(Boolean(workspace.settings.allowNegativeStock));
  const [impairmentAccountId, setImpairmentAccountId] = useState(workspace.settings.impairmentAccountId ?? "");
  const [impairmentChargeAccountId, setImpairmentChargeAccountId] = useState(workspace.settings.impairmentChargeAccountId ?? "");
  const [impairmentReversalAccountId, setImpairmentReversalAccountId] = useState(workspace.settings.impairmentReversalAccountId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.wheat!.saveStockSettings({
        companyId,
        stockJournalId: journalId || null,
        allowNegativeStock: allowNegative,
        impairmentAccountId: impairmentAccountId || null,
        impairmentChargeAccountId: impairmentChargeAccountId || null,
        impairmentReversalAccountId: impairmentReversalAccountId || null,
      });
      notify?.("Paramétrage du stock enregistré.", "success");
      onSaved();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stock-workspace">
      <Card title="Journal et politique de stock">
        {error && <ErrorState cause={error} />}
        <div className="stock-filters">
          <div className="stock-filters__field">
            <label htmlFor="stock-journal">Journal des écritures de stock</label>
            <select id="stock-journal" value={journalId} onChange={(event) => setJournalId(event.target.value)}>
              <option value="">Non paramétré</option>
              {workspace.journals.map((journal: any) => (
                <option key={journal.id} value={journal.id}>{journal.code} — {journal.label}</option>
              ))}
            </select>
          </div>
          <div className="stock-filters__field">
            <label htmlFor="stock-negative">Stock négatif</label>
            <select id="stock-negative" value={allowNegative ? "yes" : "no"} onChange={(event) => setAllowNegative(event.target.value === "yes")}>
              <option value="no">Interdit (recommandé)</option>
              <option value="yes">Autorisé en CMP, si un coût de référence existe</option>
            </select>
          </div>
        </div>
        <p className="stock-note">
          La méthode FIFO refuse toujours le stock négatif : il n'existe aucune couche d'acquisition à consommer,
          et Wheat n'invente pas un coût.
        </p>

        <h4 className="stock-section-title">Comptes de dépréciation</h4>
        <div className="stock-filters">
          <AccountPicker
            label="Compte de provision"
            accounts={workspace.accounts}
            value={impairmentAccountId}
            onChange={setImpairmentAccountId}
          />
          <AccountPicker
            label="Compte de dotation"
            accounts={workspace.accounts}
            value={impairmentChargeAccountId}
            onChange={setImpairmentChargeAccountId}
          />
          <AccountPicker
            label="Compte de reprise"
            accounts={workspace.accounts}
            value={impairmentReversalAccountId}
            onChange={setImpairmentReversalAccountId}
          />
        </div>
        <p className="stock-note">
          Une dépréciation n'existe que dans les comptes. Tant que ces trois comptes ne sont pas choisis, Wheat refuse
          d'en enregistrer une plutôt que d'en deviner un. Les codes CGNC souvent utilisés
          {" "}({workspace.impairmentSuggestions?.provision} provision, {workspace.impairmentSuggestions?.charge} dotation,
          {" "}{workspace.impairmentSuggestions?.reversal} reprise) sont des <strong>suggestions à faire vérifier par
          votre comptable</strong>, pas une recommandation de Wheat : elles dépendent du plan du dossier et de la
          méthode d'inventaire qu'il applique.
        </p>

        <div className="stock-actions">
          <Button onClick={() => void save()} disabled={saving}>Enregistrer</Button>
        </div>
      </Card>

      <UnitConversionsCard companyId={companyId} workspace={workspace} notify={notify} onSaved={onSaved} />

      <Card
        title="Comptes de stock"
        note="Résolution : article, puis famille, puis dossier. Sans paramétrage applicable, la validation est bloquée — aucun compte par défaut n'est choisi à votre place."
      >
        {workspace.mappings.length === 0 ? (
          <EmptyState
            icon={<Settings2 size={22} />}
            title="Le paramétrage comptable du stock est incomplet."
            text="Associez un compte de stock et un compte de variation, au moins au niveau du dossier."
          />
        ) : (
          <div className="stock-table-wrap">
            <table className="stock-table">
              <thead>
                <tr>
                  <th scope="col">Niveau</th>
                  <th scope="col">Cible</th>
                  <th scope="col">Compte de stock</th>
                  <th scope="col">Compte de variation</th>
                </tr>
              </thead>
              <tbody>
                {workspace.mappings.map((mapping: any) => (
                  <tr key={mapping.id}>
                    <td>{mapping.scope}</td>
                    <td>{mapping.article?.designation ?? mapping.family?.designation ?? "Tout le dossier"}</td>
                    <td>{mapping.stockAccount.code} — {mapping.stockAccount.label}</td>
                    <td>{mapping.variationAccount.code} — {mapping.variationAccount.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="stock-note">
          Codes CGNC suggérés, à vérifier contre le plan comptable du dossier :
          {" "}{workspace.accountSuggestions.map((suggestion: any) => `${suggestion.familyHint} ${suggestion.stock}/${suggestion.variation}`).join(" · ")}.
        </p>
      </Card>
    </div>
  );
}
