-- Wheat stock / inventory module.
--
-- Additive only: this migration creates the stock tables and touches no
-- existing Wheat table, so an existing dossier keeps every row it had and every
-- build applies exactly this one versioned change.
--
-- The triggers at the end are the point of the register. Wheat already protects
-- immutable artifacts this way (see InvoiceArtifact in the 1.4 migration): an
-- application-layer rule binds only the code that remembers to ask it, and a
-- stock movement that can be edited is a valuation that can be made to say
-- anything. Corrections append a reversal; they never rewrite what happened.

-- CreateTable
CREATE TABLE "StockSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "nextMovementSequence" BIGINT NOT NULL DEFAULT 1,
    "stockJournalId" TEXT,
    "impairmentAccountId" TEXT,
    "impairmentChargeAccountId" TEXT,
    "impairmentReversalAccountId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockSettings_stockJournalId_fkey" FOREIGN KEY ("stockJournalId") REFERENCES "Journal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockSettings_impairmentAccountId_fkey" FOREIGN KEY ("impairmentAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockSettings_impairmentChargeAccountId_fkey" FOREIGN KEY ("impairmentChargeAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockSettings_impairmentReversalAccountId_fkey" FOREIGN KEY ("impairmentReversalAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockAccountMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "familyId" TEXT,
    "articleId" TEXT,
    "stockAccountId" TEXT NOT NULL,
    "variationAccountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockAccountMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockAccountMapping_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "StockArticleFamily" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockAccountMapping_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockAccountMapping_stockAccountId_fkey" FOREIGN KEY ("stockAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAccountMapping_variationAccountId_fkey" FOREIGN KEY ("variationAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockUnit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockUnitConversion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fromUnitId" TEXT NOT NULL,
    "toUnitId" TEXT NOT NULL,
    "factor" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockUnitConversion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockUnitConversion_fromUnitId_fkey" FOREIGN KEY ("fromUnitId") REFERENCES "StockUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockUnitConversion_toUnitId_fkey" FOREIGN KEY ("toUnitId") REFERENCES "StockUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockArticleFamily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "parentFamilyId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockArticleFamily_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockArticleFamily_parentFamilyId_fkey" FOREIGN KEY ("parentFamilyId") REFERENCES "StockArticleFamily" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockArticle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "description" TEXT,
    "barcode" TEXT,
    "familyId" TEXT,
    "unitId" TEXT NOT NULL,
    "valuationMethod" TEXT NOT NULL DEFAULT 'CMP',
    "minQuantity" BIGINT NOT NULL DEFAULT 0,
    "maxQuantity" BIGINT,
    "lotTracking" BOOLEAN NOT NULL DEFAULT false,
    "expiryTracking" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultSupplierId" TEXT,
    "notes" TEXT,
    "customFieldsJson" TEXT NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockArticle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockArticle_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "StockArticleFamily" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockArticle_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "StockUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockArticle_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Counterparty" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockWarehouse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockWarehouse_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockLocation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresOn" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockLot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockLot_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockDocumentSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "lastIssued" INTEGER NOT NULL DEFAULT 0,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockDocumentSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentSequence_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "documentDate" DATETIME NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "targetWarehouseId" TEXT,
    "counterpartyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdByUserId" TEXT,
    "validatedByUserId" TEXT,
    "validatedAt" DATETIME,
    "reversalOfId" TEXT,
    "reversedAt" DATETIME,
    "accountingEntryId" TEXT,
    "inventoryCampaignId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_targetWarehouseId_fkey" FOREIGN KEY ("targetWarehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_validatedByUserId_fkey" FOREIGN KEY ("validatedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "StockDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_accountingEntryId_fkey" FOREIGN KEY ("accountingEntryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockDocument_inventoryCampaignId_fkey" FOREIGN KEY ("inventoryCampaignId") REFERENCES "StockInventoryCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockDocumentLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "articleId" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "unitId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "lotId" TEXT,
    "expiresOn" DATETIME,
    "direction" TEXT,
    "unitValue" BIGINT,
    "grossValue" BIGINT NOT NULL DEFAULT 0,
    "allocatedChargeValue" BIGINT NOT NULL DEFAULT 0,
    "stockValue" BIGINT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentLine_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "StockUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentLine_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockDocumentLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "lotId" TEXT,
    "documentId" TEXT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentDate" DATETIME NOT NULL,
    "sequence" BIGINT NOT NULL,
    "direction" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "value" BIGINT NOT NULL,
    "resultingQuantity" BIGINT NOT NULL,
    "resultingValue" BIGINT NOT NULL,
    "counterpartyId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "StockDocumentLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lotId" TEXT,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "value" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockBalance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockFifoLayer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lotId" TEXT,
    "documentId" TEXT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "documentDate" DATETIME NOT NULL,
    "sequence" BIGINT NOT NULL,
    "quantityReceived" BIGINT NOT NULL,
    "quantityRemaining" BIGINT NOT NULL,
    "valueReceived" BIGINT NOT NULL,
    "valueRemaining" BIGINT NOT NULL,
    "counterpartyId" TEXT,
    "expiresOn" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockFifoLayer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockFifoLayer_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockFifoLayer_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockFifoLayer_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockFifoLayer_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockFifoLayer_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "StockDocumentLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockFifoConsumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CONSUMPTION',
    "quantity" BIGINT NOT NULL,
    "value" BIGINT NOT NULL,
    "exhausted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockFifoConsumption_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockFifoConsumption_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "StockFifoLayer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockFifoConsumption_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockFifoConsumption_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockFifoConsumption_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "StockDocumentLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLandedCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "allocationMethod" TEXT NOT NULL DEFAULT 'VALUE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockLandedCost_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockLandedCost_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLandedCostAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "landedCostId" TEXT NOT NULL,
    "documentLineId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLandedCostAllocation_landedCostId_fkey" FOREIGN KEY ("landedCostId") REFERENCES "StockLandedCost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockLandedCostAllocation_documentLineId_fkey" FOREIGN KEY ("documentLineId") REFERENCES "StockDocumentLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockInventoryCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "countDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdByUserId" TEXT,
    "closedAt" DATETIME,
    "closedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockInventoryCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCampaign_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockInventoryCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "lotId" TEXT,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "locationId" TEXT,
    "expectedQuantity" BIGINT NOT NULL DEFAULT 0,
    "expectedValue" BIGINT NOT NULL DEFAULT 0,
    "countedQuantity" BIGINT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockInventoryCount_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StockInventoryCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "StockLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockInventoryCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockImpairment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "impairmentDate" DATETIME NOT NULL,
    "valueBefore" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "accountingEntryId" TEXT,
    "reversalOfId" TEXT,
    "reversedAt" DATETIME,
    "createdByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockImpairment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockImpairment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "StockArticle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockImpairment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "StockWarehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockImpairment_accountingEntryId_fkey" FOREIGN KEY ("accountingEntryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockImpairment_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "StockImpairment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockImpairment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StockSettings_companyId_key" ON "StockSettings"("companyId");

-- CreateIndex
CREATE INDEX "StockAccountMapping_companyId_scope_idx" ON "StockAccountMapping"("companyId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "StockAccountMapping_companyId_scopeKey_key" ON "StockAccountMapping"("companyId", "scopeKey");

-- CreateIndex
CREATE INDEX "StockUnit_companyId_active_idx" ON "StockUnit"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StockUnit_companyId_code_key" ON "StockUnit"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockUnitConversion_companyId_fromUnitId_toUnitId_key" ON "StockUnitConversion"("companyId", "fromUnitId", "toUnitId");

-- CreateIndex
CREATE INDEX "StockArticleFamily_companyId_active_idx" ON "StockArticleFamily"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StockArticleFamily_companyId_code_key" ON "StockArticleFamily"("companyId", "code");

-- CreateIndex
CREATE INDEX "StockArticle_companyId_active_familyId_idx" ON "StockArticle"("companyId", "active", "familyId");

-- CreateIndex
CREATE INDEX "StockArticle_companyId_searchText_idx" ON "StockArticle"("companyId", "searchText");

-- CreateIndex
CREATE UNIQUE INDEX "StockArticle_companyId_sku_key" ON "StockArticle"("companyId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "StockArticle_companyId_barcode_key" ON "StockArticle"("companyId", "barcode");

-- CreateIndex
CREATE INDEX "StockWarehouse_companyId_active_idx" ON "StockWarehouse"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StockWarehouse_companyId_code_key" ON "StockWarehouse"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_warehouseId_code_key" ON "StockLocation"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "StockLot_companyId_expiresOn_idx" ON "StockLot"("companyId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "StockLot_companyId_articleId_code_key" ON "StockLot"("companyId", "articleId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockDocumentSequence_companyId_fiscalYearId_type_key" ON "StockDocumentSequence"("companyId", "fiscalYearId", "type");

-- CreateIndex
CREATE INDEX "StockDocument_companyId_status_documentDate_idx" ON "StockDocument"("companyId", "status", "documentDate");

-- CreateIndex
CREATE INDEX "StockDocument_companyId_type_documentDate_idx" ON "StockDocument"("companyId", "type", "documentDate");

-- CreateIndex
CREATE INDEX "StockDocument_accountingEntryId_idx" ON "StockDocument"("accountingEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "StockDocument_companyId_reference_key" ON "StockDocument"("companyId", "reference");

-- CreateIndex
CREATE INDEX "StockDocumentLine_articleId_idx" ON "StockDocumentLine"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "StockDocumentLine_documentId_position_key" ON "StockDocumentLine"("documentId", "position");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_articleId_warehouseId_documentDate_sequence_idx" ON "StockMovement"("companyId", "articleId", "warehouseId", "documentDate", "sequence");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_documentDate_idx" ON "StockMovement"("companyId", "documentDate");

-- CreateIndex
CREATE INDEX "StockMovement_documentId_idx" ON "StockMovement"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_companyId_sequence_key" ON "StockMovement"("companyId", "sequence");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_articleId_idx" ON "StockBalance"("companyId", "articleId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_companyId_articleId_warehouseId_lotKey_key" ON "StockBalance"("companyId", "articleId", "warehouseId", "lotKey");

-- CreateIndex
CREATE INDEX "StockFifoLayer_companyId_articleId_warehouseId_documentDate_sequence_idx" ON "StockFifoLayer"("companyId", "articleId", "warehouseId", "documentDate", "sequence");

-- CreateIndex
CREATE INDEX "StockFifoLayer_documentLineId_idx" ON "StockFifoLayer"("documentLineId");

-- CreateIndex
CREATE INDEX "StockFifoConsumption_movementId_idx" ON "StockFifoConsumption"("movementId");

-- CreateIndex
CREATE INDEX "StockFifoConsumption_layerId_idx" ON "StockFifoConsumption"("layerId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLandedCost_documentId_position_key" ON "StockLandedCost"("documentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "StockLandedCostAllocation_landedCostId_documentLineId_key" ON "StockLandedCostAllocation"("landedCostId", "documentLineId");

-- CreateIndex
CREATE INDEX "StockInventoryCampaign_companyId_status_idx" ON "StockInventoryCampaign"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockInventoryCampaign_companyId_reference_key" ON "StockInventoryCampaign"("companyId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "StockInventoryCount_campaignId_articleId_lotKey_key" ON "StockInventoryCount"("campaignId", "articleId", "lotKey");

-- CreateIndex
CREATE INDEX "StockImpairment_companyId_articleId_status_idx" ON "StockImpairment"("companyId", "articleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockImpairment_companyId_reference_key" ON "StockImpairment"("companyId", "reference");



-- The register is append-only.
CREATE TRIGGER "StockMovement_append_only_update"
BEFORE UPDATE ON "StockMovement"
BEGIN
  SELECT RAISE(ABORT, 'Un mouvement de stock valide ne peut pas etre modifie; utilisez une contrepassation.');
END;

CREATE TRIGGER "StockMovement_append_only_delete"
BEFORE DELETE ON "StockMovement"
BEGIN
  SELECT RAISE(ABORT, 'Un mouvement de stock valide ne peut pas etre supprime; utilisez une contrepassation.');
END;

-- So is the FIFO provenance that explains what each movement cost. A reversal
-- appends a RESTORATION row rather than editing the consumption it undoes.
CREATE TRIGGER "StockFifoConsumption_append_only_update"
BEFORE UPDATE ON "StockFifoConsumption"
BEGIN
  SELECT RAISE(ABORT, 'Une consommation FIFO est immuable; une contrepassation ajoute une restauration.');
END;

CREATE TRIGGER "StockFifoConsumption_append_only_delete"
BEFORE DELETE ON "StockFifoConsumption"
BEGIN
  SELECT RAISE(ABORT, 'Une consommation FIFO est immuable; une contrepassation ajoute une restauration.');
END;
