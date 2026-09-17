/**
 * Importing a catalogue, or an opening stock, from a spreadsheet.
 *
 * Two shapes, one flow. `ARTICLES` creates or updates the catalogue.
 * `OPENING_STOCK` does the same and then builds one stock document per dépôt,
 * which is validated through the ordinary path so the opening position gets the
 * movements, the FIFO layers and the accounting draft that every other entry to
 * stock gets.
 *
 * ## Preview, then confirm
 *
 * Nothing is written until the person has seen what would be. `planImport`
 * reads the file, applies the column mapping they chose, validates every row
 * and returns the whole plan — including every refusal — without opening a
 * transaction. `commitImport` re-validates the same rows and writes them, all
 * of them or none.
 *
 * Re-validating rather than trusting the plan is deliberate: the preview
 * crossed a process boundary and came back, and a catalogue can have changed in
 * between. The plan is what the person agreed to; the database is what decides.
 *
 * ## A conflict is never resolved quietly
 *
 * A row whose SKU already exists is refused unless the person chose, for the
 * whole import, to update existing articles — and even then the update touches
 * only the fields the file actually carried. There is no mode in which an
 * import silently replaces a catalogue: a mistyped column would otherwise
 * rewrite every désignation in the dossier and report success.
 *
 * ## Nothing is guessed
 *
 * No account mapping, no valuation method beyond the dossier's stated default,
 * no unit invented from a label. A row naming a unit or a family the dossier
 * does not have is a refusal that names it, because creating one to make the
 * import succeed would put a code into the catalogue that nobody chose.
 */

import { appendActivityAndAudit } from "./audit13";
import { STOCK_DOCUMENT_STATUS, StockError, provisionalStockReference } from "./stockDomain";
import { moneyFromDecimal, moneyToDisplay, qtyFromDecimal, qtyToDisplay, valueFromUnitPrice } from "./stockUnits";
import { isValuationMethod } from "./stockValuation";
import { validateStockDocumentInTransaction } from "./stockValidation";
import { readTabularSource, type TabularOptions, type TabularSource } from "./tabularSource";

export const STOCK_IMPORT_KINDS = ["ARTICLES", "OPENING_STOCK"] as const;
export type StockImportKind = (typeof STOCK_IMPORT_KINDS)[number];

/** How a row that names an existing SKU is treated. Never implicit. */
export const STOCK_IMPORT_CONFLICT_MODES = ["REFUSE", "UPDATE", "SKIP"] as const;
export type StockImportConflictMode = (typeof STOCK_IMPORT_CONFLICT_MODES)[number];

const MAX_IMPORT_ROWS = 5_000;

const IMPORT_SOURCE: TabularOptions = {
  noun: "Le fichier importé",
  maxRows: MAX_IMPORT_ROWS,
  fail: (message: string) => new StockError(message),
};

/**
 * The columns each import shape understands.
 *
 * `required` is what a row cannot be built without. Everything else is offered
 * and ignored when the file does not carry it — an import that demanded a
 * barcode column would refuse catalogues that simply have no barcodes.
 */
export const STOCK_IMPORT_FIELDS: Record<StockImportKind, Array<{
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}>> = {
  ARTICLES: [
    { key: "sku", label: "Référence (SKU)", required: true },
    { key: "designation", label: "Désignation", required: true },
    { key: "family", label: "Famille (code)", required: false, hint: "Doit exister dans le dossier." },
    { key: "unit", label: "Unité (code)", required: false, hint: "Doit exister dans le dossier ; à défaut, l'unité par défaut choisie ci-dessus." },
    { key: "barcode", label: "Code-barres", required: false },
    { key: "valuationMethod", label: "Valorisation (CMP/FIFO)", required: false },
    { key: "minQuantity", label: "Stock minimum", required: false },
    { key: "notes", label: "Notes", required: false },
  ],
  OPENING_STOCK: [
    { key: "sku", label: "Référence (SKU)", required: true },
    { key: "designation", label: "Désignation", required: false, hint: "Utilisée seulement si l'article doit être créé." },
    { key: "family", label: "Famille (code)", required: false },
    { key: "unit", label: "Unité (code)", required: false },
    { key: "barcode", label: "Code-barres", required: false },
    { key: "warehouse", label: "Dépôt (code)", required: false, hint: "À défaut, le dépôt choisi ci-dessus." },
    { key: "quantity", label: "Quantité initiale", required: true },
    { key: "unitValue", label: "Valeur unitaire", required: true, hint: "Coût d'acquisition unitaire, hors taxes." },
  ],
};

export type ImportRowIssue = { row: number; message: string };

export type PlannedArticle = {
  row: number;
  sku: string;
  designation: string;
  barcode: string | null;
  familyId: string | null;
  unitId: string;
  valuationMethod: string;
  minQuantity: bigint;
  notes: string | null;
  /** Set when this SKU already exists; the mode decides what happens then. */
  existingArticleId: string | null;
  action: "CREATE" | "UPDATE" | "SKIP";
};

export type PlannedOpening = {
  row: number;
  sku: string;
  warehouseId: string;
  quantity: bigint;
  unitValue: bigint;
  value: bigint;
};

export type StockImportPlan = {
  kind: StockImportKind;
  format: string;
  headers: string[];
  mapping: Record<string, string>;
  rowCount: number;
  articles: PlannedArticle[];
  openings: PlannedOpening[];
  errors: ImportRowIssue[];
  warnings: ImportRowIssue[];
  /** Totals a person can check against the spreadsheet before committing. */
  totals: { create: number; update: number; skip: number; quantity: string; value: string };
};

function normalizeHeader(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * A first guess at which column is which, offered for the person to correct.
 *
 * Only ever a suggestion: the mapping that governs is the one that comes back
 * from the screen. Guessing silently is how an import puts the barcode column
 * into the désignation of nine hundred articles.
 */
export function suggestStockMapping(kind: StockImportKind, headers: string[]): Record<string, string> {
  const candidates: Record<string, string[]> = {
    sku: ["sku", "reference", "ref", "code", "codearticle", "referencearticle"],
    designation: ["designation", "libelle", "nom", "description", "intitule", "article"],
    family: ["famille", "family", "categorie", "category", "codefamille"],
    unit: ["unite", "unit", "uom", "mesure", "codeunite"],
    barcode: ["codebarres", "barcode", "ean", "gencod", "ean13"],
    valuationMethod: ["valorisation", "methode", "valuation", "methodevalorisation"],
    minQuantity: ["stockmini", "stockminimum", "minimum", "seuil", "minquantity"],
    notes: ["notes", "note", "commentaire", "observation"],
    warehouse: ["depot", "warehouse", "magasin", "entrepot", "codedepot"],
    quantity: ["quantite", "quantity", "qte", "stock", "stockinitial", "quantiteinitiale"],
    unitValue: ["valeurunitaire", "prixunitaire", "cout", "cump", "pu", "unitprice", "unitcost", "prixachat"],
  };
  const normalized = headers.map((header) => ({ header, key: normalizeHeader(header) }));
  const mapping: Record<string, string> = {};
  const taken = new Set<string>();
  for (const field of STOCK_IMPORT_FIELDS[kind]) {
    const wanted = candidates[field.key] ?? [];
    const found = normalized.find(({ header, key }) => !taken.has(header) && wanted.some((word) => key === word))
      ?? normalized.find(({ header, key }) => !taken.has(header) && wanted.some((word) => key.startsWith(word) || key.endsWith(word)));
    if (found) {
      mapping[field.key] = found.header;
      taken.add(found.header);
    }
  }
  return mapping;
}

export type ImportContext = {
  companyId: string;
  kind: StockImportKind;
  conflictMode: StockImportConflictMode;
  defaultUnitId: string;
  defaultWarehouseId: string | null;
  defaultValuationMethod: string;
  documentDate: Date | null;
};

type Catalogue = {
  unitsByCode: Map<string, string>;
  familiesByCode: Map<string, string>;
  warehousesByCode: Map<string, string>;
  articlesBySku: Map<string, { id: string; sku: string }>;
  barcodes: Map<string, string>;
};

async function readCatalogue(client: any, companyId: string): Promise<Catalogue> {
  const [units, families, warehouses, articles] = await Promise.all([
    client.stockUnit.findMany({ where: { companyId }, select: { id: true, code: true } }),
    client.stockArticleFamily.findMany({ where: { companyId }, select: { id: true, code: true } }),
    client.stockWarehouse.findMany({ where: { companyId }, select: { id: true, code: true } }),
    client.stockArticle.findMany({ where: { companyId }, select: { id: true, sku: true, barcode: true } }),
  ]);
  const key = (value: string) => value.trim().toLowerCase();
  return {
    unitsByCode: new Map(units.map((unit: any) => [key(unit.code), unit.id])),
    familiesByCode: new Map(families.map((family: any) => [key(family.code), family.id])),
    warehousesByCode: new Map(warehouses.map((warehouse: any) => [key(warehouse.code), warehouse.id])),
    articlesBySku: new Map(articles.map((article: any) => [key(article.sku), { id: article.id, sku: article.sku }])),
    barcodes: new Map(articles.filter((article: any) => article.barcode).map((article: any) => [key(article.barcode), article.id])),
  };
}

/**
 * Turns the file and the mapping into a plan, refusing row by row.
 *
 * A row that fails produces an error naming its line number and stops at
 * nothing else: the person needs the whole list of problems in one pass, not
 * the first one repeatedly.
 */
export function planRows(
  source: TabularSource,
  mapping: Record<string, string>,
  context: ImportContext,
  catalogue: Catalogue,
): StockImportPlan {
  const fields = STOCK_IMPORT_FIELDS[context.kind];
  const errors: ImportRowIssue[] = [];
  const warnings: ImportRowIssue[] = [];
  const articles: PlannedArticle[] = [];
  const openings: PlannedOpening[] = [];

  for (const field of fields) {
    if (field.required && !mapping[field.key]) {
      errors.push({ row: 0, message: `La colonne « ${field.label} » n'est associée à aucune colonne du fichier.` });
    }
  }
  for (const [key, header] of Object.entries(mapping)) {
    if (!header) continue;
    if (!source.headers.includes(header)) {
      errors.push({ row: 0, message: `La colonne « ${header} » associée à « ${key} » est absente du fichier.` });
    }
  }
  if (errors.length > 0) {
    return emptyPlan(context, source, mapping, errors, warnings);
  }

  const read = (row: Record<string, string>, key: string): string => {
    const header = mapping[key];
    return header ? (row[header] ?? "").trim() : "";
  };
  // Duplicates *inside the file* are as real as duplicates against the
  // catalogue, and far easier to miss: two rows claiming the same SKU would
  // otherwise both be written and the second would silently win.
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  const seenPosition = new Map<string, number>();

  source.rows.forEach((row, index) => {
    const line = index + 2; // header is line 1, as a spreadsheet counts
    const fail = (message: string) => errors.push({ row: line, message });

    const sku = read(row, "sku");
    if (!sku) {
      fail("La référence (SKU) est vide.");
      return;
    }
    const skuKey = sku.toLowerCase();
    const duplicate = seenSku.get(skuKey);
    if (duplicate !== undefined && context.kind === "ARTICLES") {
      fail(`La référence « ${sku} » apparaît déjà ligne ${duplicate} du même fichier.`);
      return;
    }
    seenSku.set(skuKey, line);

    const unitCode = read(row, "unit");
    let unitId = context.defaultUnitId;
    if (unitCode) {
      const found = catalogue.unitsByCode.get(unitCode.toLowerCase());
      if (!found) {
        fail(`L'unité « ${unitCode} » n'existe pas dans ce dossier. Créez-la d'abord ; Wheat n'invente pas d'unité de mesure.`);
        return;
      }
      unitId = found;
    }

    const familyCode = read(row, "family");
    let familyId: string | null = null;
    if (familyCode) {
      const found = catalogue.familiesByCode.get(familyCode.toLowerCase());
      if (!found) {
        fail(`La famille « ${familyCode} » n'existe pas dans ce dossier.`);
        return;
      }
      familyId = found;
    }

    const barcode = read(row, "barcode") || null;
    if (barcode) {
      const inFile = seenBarcode.get(barcode.toLowerCase());
      if (inFile !== undefined) {
        fail(`Le code-barres « ${barcode} » apparaît déjà ligne ${inFile} du même fichier.`);
        return;
      }
      seenBarcode.set(barcode.toLowerCase(), line);
    }

    const existing = catalogue.articlesBySku.get(skuKey) ?? null;
    if (barcode) {
      const owner = catalogue.barcodes.get(barcode.toLowerCase());
      if (owner && owner !== existing?.id) {
        fail(`Le code-barres « ${barcode} » est déjà utilisé par un autre article du dossier.`);
        return;
      }
    }

    let action: PlannedArticle["action"] = "CREATE";
    if (existing) {
      if (context.conflictMode === "REFUSE") {
        fail(`La référence « ${sku} » existe déjà dans ce dossier. Choisissez explicitement de mettre à jour ou d'ignorer les doublons.`);
        return;
      }
      action = context.conflictMode === "UPDATE" ? "UPDATE" : "SKIP";
    }

    const designation = read(row, "designation");
    if (context.kind === "ARTICLES" && !designation) {
      fail("La désignation est vide.");
      return;
    }
    if (!existing && !designation) {
      fail(`L'article « ${sku} » n'existe pas encore : sa désignation est obligatoire pour le créer.`);
      return;
    }

    const valuationRaw = read(row, "valuationMethod") || context.defaultValuationMethod;
    const valuationMethod = valuationRaw.toUpperCase();
    if (!isValuationMethod(valuationMethod)) {
      fail(`La méthode de valorisation « ${valuationRaw} » est inconnue : utilisez CMP ou FIFO.`);
      return;
    }

    let minQuantity = 0n;
    const minRaw = read(row, "minQuantity");
    if (minRaw) {
      try {
        minQuantity = qtyFromDecimal(minRaw, "Le stock minimum");
        if (minQuantity < 0n) throw new StockError("Le stock minimum ne peut pas être négatif.");
      } catch (error: any) {
        fail(String(error?.message ?? error));
        return;
      }
    }

    articles.push({
      row: line,
      sku,
      designation: designation || existing?.sku || sku,
      barcode,
      familyId,
      unitId,
      valuationMethod,
      minQuantity,
      notes: read(row, "notes") || null,
      existingArticleId: existing?.id ?? null,
      action,
    });

    if (context.kind !== "OPENING_STOCK") return;

    const warehouseCode = read(row, "warehouse");
    let warehouseId = context.defaultWarehouseId;
    if (warehouseCode) {
      const found = catalogue.warehousesByCode.get(warehouseCode.toLowerCase());
      if (!found) {
        fail(`Le dépôt « ${warehouseCode} » n'existe pas dans ce dossier.`);
        return;
      }
      warehouseId = found;
    }
    if (!warehouseId) {
      fail("Aucun dépôt n'est indiqué sur la ligne ni choisi pour l'import.");
      return;
    }
    const positionKey = `${skuKey}|${warehouseId}`;
    const samePosition = seenPosition.get(positionKey);
    if (samePosition !== undefined) {
      fail(`« ${sku} » est déjà présent ligne ${samePosition} pour le même dépôt.`);
      return;
    }
    seenPosition.set(positionKey, line);

    try {
      const quantity = qtyFromDecimal(read(row, "quantity"), "La quantité initiale");
      if (quantity <= 0n) throw new StockError("La quantité initiale doit être strictement positive.");
      const unitValue = moneyFromDecimal(read(row, "unitValue"), "La valeur unitaire");
      if (unitValue < 0n) throw new StockError("La valeur unitaire ne peut pas être négative.");
      openings.push({ row: line, sku, warehouseId, quantity, unitValue, value: valueFromUnitPrice(quantity, unitValue) });
    } catch (error: any) {
      fail(String(error?.message ?? error));
    }
  });

  for (const warning of source.warnings) warnings.push({ row: 0, message: warning });

  const create = articles.filter((article) => article.action === "CREATE").length;
  const update = articles.filter((article) => article.action === "UPDATE").length;
  const skip = articles.filter((article) => article.action === "SKIP").length;
  return {
    kind: context.kind,
    format: source.format,
    headers: source.headers,
    mapping,
    rowCount: source.rows.length,
    articles,
    openings,
    errors,
    warnings,
    totals: {
      create,
      update,
      skip,
      quantity: qtyToDisplay(openings.reduce((sum, opening) => sum + opening.quantity, 0n)),
      value: moneyToDisplay(openings.reduce((sum, opening) => sum + opening.value, 0n)),
    },
  };
}

function emptyPlan(
  context: ImportContext,
  source: TabularSource,
  mapping: Record<string, string>,
  errors: ImportRowIssue[],
  warnings: ImportRowIssue[],
): StockImportPlan {
  return {
    kind: context.kind,
    format: source.format,
    headers: source.headers,
    mapping,
    rowCount: source.rows.length,
    articles: [],
    openings: [],
    errors,
    warnings,
    totals: { create: 0, update: 0, skip: 0, quantity: qtyToDisplay(0n), value: moneyToDisplay(0n) },
  };
}

/** Reads the file and plans it, touching nothing. */
export async function planImport(client: any, input: {
  context: ImportContext;
  bytes: Buffer;
  fileName: string;
  mapping?: Record<string, string> | null;
}): Promise<StockImportPlan> {
  const source = await readTabularSource(input.bytes, input.fileName, IMPORT_SOURCE);
  const mapping = input.mapping && Object.keys(input.mapping).length > 0
    ? input.mapping
    : suggestStockMapping(input.context.kind, source.headers);
  const catalogue = await readCatalogue(client, input.context.companyId);
  return planRows(source, mapping, input.context, catalogue);
}

/**
 * Writes an approved plan, entirely or not at all.
 *
 * The caller owns the transaction. A row that fails here — a unique the plan
 * could not see, a period that closed in between — takes the whole import down
 * with it, which is the only outcome that leaves a catalogue somebody can
 * reason about. A half-applied spreadsheet is worse than a refused one.
 */
export async function commitImportInTransaction(tx: any, input: {
  context: ImportContext;
  plan: StockImportPlan;
  actorUserId: string | null;
}) {
  const { context, plan } = input;
  if (plan.errors.length > 0) {
    throw new StockError(`Cet import comporte ${plan.errors.length} erreur(s) : corrigez le fichier avant de confirmer.`);
  }
  if (plan.articles.length === 0) throw new StockError("Cet import ne contient aucune ligne exploitable.");

  const articleIdBySku = new Map<string, string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const planned of plan.articles) {
    if (planned.action === "SKIP") {
      if (planned.existingArticleId) articleIdBySku.set(planned.sku.toLowerCase(), planned.existingArticleId);
      skipped += 1;
      continue;
    }
    const data = {
      companyId: context.companyId,
      sku: planned.sku,
      designation: planned.designation,
      barcode: planned.barcode,
      familyId: planned.familyId,
      unitId: planned.unitId,
      valuationMethod: planned.valuationMethod,
      minQuantity: planned.minQuantity,
      notes: planned.notes,
      searchText: `${planned.sku} ${planned.designation}`.toLowerCase(),
    };
    if (planned.action === "UPDATE" && planned.existingArticleId) {
      // A method change is refused once the article has moved, for the same
      // reason it is refused on the article screen: it would reprice movements
      // that are already in the ledger.
      const existing = await tx.stockArticle.findUnique({ where: { id: planned.existingArticleId } });
      if (existing.valuationMethod !== planned.valuationMethod) {
        const moved = await tx.stockMovement.count({ where: { companyId: context.companyId, articleId: existing.id } });
        if (moved > 0) {
          throw new StockError(
            `Ligne ${planned.row} : la méthode de valorisation de « ${planned.sku} » ne peut plus changer, cet article a déjà des mouvements validés.`,
          );
        }
      }
      const article = await tx.stockArticle.update({
        where: { id: planned.existingArticleId },
        data: { ...data, version: { increment: 1 } },
      });
      articleIdBySku.set(planned.sku.toLowerCase(), article.id);
      updated += 1;
      continue;
    }
    // The plan was built a moment ago, outside this transaction. A unique that
    // it could not have seen — a second import running at the same time, a row
    // added in between — is reported in the user's words rather than Prisma's,
    // and takes the whole import down with it like any other failure here.
    const article = await tx.stockArticle.create({ data }).catch((error: any) => {
      if (error?.code !== "P2002") throw error;
      const target = String(error.meta?.target ?? "");
      throw new StockError(target.includes("barcode")
        ? `Ligne ${planned.row} : le code-barres « ${planned.barcode} » vient d'être utilisé par un autre article. Rien n'a été importé.`
        : `Ligne ${planned.row} : la référence « ${planned.sku} » vient d'être créée par ailleurs. Rien n'a été importé.`);
    });
    articleIdBySku.set(planned.sku.toLowerCase(), article.id);
    created += 1;
  }

  const documentIds: string[] = [];
  if (context.kind === "OPENING_STOCK" && plan.openings.length > 0) {
    if (!context.documentDate) throw new StockError("La date du stock initial est obligatoire.");
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: { companyId: context.companyId, startsOn: { lte: context.documentDate }, endsOn: { gte: context.documentDate } },
      orderBy: { startsOn: "desc" },
    });
    if (!fiscalYear) throw new StockError("La date du stock initial ne correspond à aucun exercice comptable.");

    // One document per dépôt: a stock document names its dépôt, and a single
    // document spanning three warehouses would be harder to read and to
    // contrepasser than the three it really is.
    const byWarehouse = new Map<string, PlannedOpening[]>();
    for (const opening of plan.openings) {
      const held = byWarehouse.get(opening.warehouseId) ?? [];
      held.push(opening);
      byWarehouse.set(opening.warehouseId, held);
    }
    for (const [warehouseId, openings] of byWarehouse) {
      const document = await tx.stockDocument.create({
        data: {
          companyId: context.companyId,
          fiscalYearId: fiscalYear.id,
          type: "OPENING_STOCK",
          reference: provisionalStockReference(),
          documentDate: context.documentDate,
          warehouseId,
          status: STOCK_DOCUMENT_STATUS.draft,
          note: "Stock initial importé",
          createdByUserId: input.actorUserId,
          lines: {
            create: openings.map((opening, index) => {
              const articleId = articleIdBySku.get(opening.sku.toLowerCase());
              if (!articleId) throw new StockError(`Ligne ${opening.row} : « ${opening.sku} » n'a pas été créé par cet import.`);
              return {
                position: index + 1,
                articleId,
                quantity: opening.quantity,
                // An opening stock is stated in the article's own unit: the
                // import has no conversion to freeze, so the factor is 1.
                unitId: plan.articles.find((article) => article.sku === opening.sku)!.unitId,
                unitFactor: 1_000_000n,
                baseQuantity: opening.quantity,
                warehouseId,
                unitValue: opening.unitValue,
                description: "Stock initial importé",
              };
            }),
          },
        },
      });
      await validateStockDocumentInTransaction(tx, {
        companyId: context.companyId,
        documentId: document.id,
        actorUserId: input.actorUserId,
      });
      documentIds.push(document.id);
    }
  }

  await appendActivityAndAudit(tx, {
    companyId: context.companyId,
    actorUserId: input.actorUserId,
    action: context.kind === "OPENING_STOCK" ? "STOCK_OPENING_IMPORTED" : "STOCK_CATALOGUE_IMPORTED",
    entityType: "StockArticle",
    entityId: context.companyId,
    description: `Import ${context.kind === "OPENING_STOCK" ? "de stock initial" : "de catalogue"} : `
      + `${created} créé(s), ${updated} mis à jour, ${skipped} ignoré(s)`,
    payload: {
      kind: context.kind,
      format: plan.format,
      conflictMode: context.conflictMode,
      created,
      updated,
      skipped,
      documents: documentIds,
    },
  });

  return { created, updated, skipped, documentIds, rows: plan.articles.length };
}
