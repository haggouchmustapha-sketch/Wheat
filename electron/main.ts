import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, safeStorage, shell } from "electron";
import { fileURLToPath } from "node:url";
import { disconnectPrisma, ensureDatabaseFile, getPrisma, migrateAndValidateDatabase, resolveDatabasePath, restoreBundledSeed } from "./database";
import { recordProfileMigration, resolveProfileDirectory } from "./profileMigration";
import { closeSmartOcrWorker, processSmartOcrFiles, SMART_OCR_PROGRESS_CHANNEL } from "./smartOcr";
import { getPaddleOcrStatus, warmPaddleOcr } from "./paddleOcr";
import {
  createWheatBackup,
  extractWheatBackupToStaging,
  validateWheatSqliteDatabase,
  type WheatBackupFileManifest,
} from "./archive";
import {
  assertManagedFileSetMatchesArchive,
  repairNonPortableManagedPaths,
  verifyManagedFileProvenance,
  type ManagedFileProvenanceResult,
} from "./managedFileProvenance";
import { forgetDocumentPagePreviews, renderDocumentPage } from "./documentPagePreview";
import { counterpartyIdentityKey, quantityToMilli, registerSubledgerIpc } from "./subledger";
import { matchPartyIdentity, normalizeCompanyName } from "./partyIdentity";
import {
  InvoiceDraftPlanError,
  missingAccountMessage,
  planInvoiceDraftFromDocument,
  requiredRolesForPlan,
  resolveAccountRole,
  type ChartAccount,
  type InvoiceDraftPlan,
  type ResolvedRole,
} from "./documentInvoiceDraft";
import {
  prepareDocumentReview,
  readDocumentReview,
  recordUserCorrections,
  settleDocumentReview,
} from "./documentReviewPayload";
import { deriveReconciliationState, registerReconciliationIpc } from "./reconciliation";
import { createFormDraftService, registerFormDraftIpc } from "./formDrafts";
import { createWheatDossierSetupService, registerWheatDossierSetupIpc } from "./wheatDossierSetup";
import { parseBankStatement } from "./bankStatementImporter";
import { registerLocalSecurityIpc, type LocalSecurityService } from "./localSecurity";
import { rollbackDatabaseReplacement, runBestEffortCleanup } from "./databaseRestore";
import { registerReportingIpc } from "./reporting";
import { registerReporting21Ipc } from "./reporting21";
import { registerFiscal21Ipc } from "./fiscal21";
import { importDialogFilters, selectImportFile, selectImportFiles } from "./importValidation";
import { registerWheatAiIpc } from "./wheatAi";
import { setWheatAiRemoteProviderService } from "./wheatAi";
import { AUTOMATIC_FREE_MODEL_ID, REMOTE_MODEL_PREFIX, WheatAiProviderService, registerWheatAiProviderIpc } from "./wheatAiProviderService";
import { setWheatAiDiagnosticSink } from "./wheatAiProviders";
import { listOllamaModels, runOllamaPlainChat } from "./wheatAi";
import { registerWheatReviewIpc, type WheatReviewModelResolution } from "./wheatReview";
import { registerWheatJourneyIpc } from "./wheatJourney";
import { registerWheatGuidedWorkIpc } from "./wheatGuidedWork";
import { registerOperations13Ipc } from "./operations13";
import { registerCompliance14Ipc } from "./compliance14";
import { registerCreditNotes14Ipc } from "./creditNotes14";
import { createEntryCommandService, postDraftEntryInTransaction } from "./entryCommands21";
import { buildDashboardMetrics } from "./dashboard";
import { appendActivityAndAudit } from "./audit13";
import { seedPcgeForCompany } from "./chartOfAccounts21";
import { allocatePieceNumber, previewNextPieceNumber } from "./pieceNumbering21";
import { WHEAT_APP_VERSION } from "../src/appVersion";
import { readWheatEnv } from "./runtimeEnvironment";
import {
  assertTrustedIpcSender,
  installBrowserWindowSecurity,
  prepareRuntimeEnvironment,
  resolveTrustedRendererLocation,
  type TrustedRendererLocation,
} from "./securityBoundary";
import { WHEAT_ADMIN_EMAIL, adminEmailValues } from "./legacyDomainValues";
import {
  currentPayrollPeriod,
  ENTRY_STATUS,
  madToCents,
  optionalText,
  parseAccountingDate,
  parseIsoDay,
  parsePayrollPeriod,
  provisionalEntryNumber,
  rendererSerialize,
  requireId,
  requireText,
} from "./accounting";
import {
  UpdateService,
  launchWindowsUpdateHelper,
  resolveAutomaticInstallationEnabled,
  resolveLocalUpdateDirectory,
  resolveUpdateChannel,
  resolveUpdaterStateDirectory,
  type PersistedUpdateState,
} from "./updater";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serialize = rendererSerialize;
let startupDatabaseError: Error | null = null;
let localSecurity: LocalSecurityService | null = null;
let subledgerService: ReturnType<typeof registerSubledgerIpc> | null = null;
let entryCommandService: ReturnType<typeof createEntryCommandService> | null = null;
let maintenanceOperation: string | null = null;
let allowSecurityMaintenanceAccess = false;
let trustedActorUserId: string | null = null;
let activeBusinessOperations = 0;
let maintenancePending = false;
let shutdownPending = false;
let internalRestartPending = false;
let mainWindow: BrowserWindow | null = null;
let trustedRendererLocation: TrustedRendererLocation | null = null;
let updateService: UpdateService | null = null;
let wheatAiProviderService: WheatAiProviderService | null = null;
let automaticUpdateCheckStarted = false;
const businessIdleWaiters = new Set<() => void>();
const operationDrainWaiters = new Set<() => void>();
/**
 * How long an ordinary operation waits for exclusive maintenance to finish
 * before giving up on it.
 *
 * Maintenance - a reset, a backup, a restore - takes the database to itself for
 * a moment, and anything arriving meanwhile used to be refused outright with
 * "reessayez dans un instant". That is a correct sentence and a poor design:
 * the reload that follows a reset lands inside exactly that window, so the
 * application told somebody to retry by hand what it could have waited for.
 * The wait is bounded, so a genuinely long restore still produces the honest
 * message rather than an interface that appears to have stopped.
 */
const MAINTENANCE_WAIT_MS = 15_000;
/** Released when exclusive maintenance ends, so a queued operation proceeds. */
const maintenanceWaiters = new Set<() => void>();

const UNGUARDED_IPC_CHANNELS = new Set([
  "wheat:workspace:reset",
  "wheat:backup:create",
  "wheat:backup:restore",
  "wheat:window:control",
  "wheat:app:restart",
  "wheat:update:status",
  "wheat:update:check",
  "wheat:update:download",
  "wheat:update:install",
  "wheat:update:postpone",
  "wheat:update:confirm-startup",
  "wheat:update:acknowledge",
]);

const ipcMain = {
  handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event, mainWindow, trustedRendererLocation);
      if (UNGUARDED_IPC_CHANNELS.has(channel)) return listener(event, ...args);
      return runBusinessOperation(() => listener(event, ...args));
    });
  },
};

function assertNoMaintenance() {
  if (shutdownPending) {
    throw new Error("Wheat est en cours de fermeture. Aucune nouvelle opération ne peut commencer.");
  }
  if (maintenancePending || maintenanceOperation) {
    throw new Error(`Wheat termine une opération de maintenance${maintenanceOperation ? ` (${maintenanceOperation})` : ""}. Réessayez dans un instant.`);
  }
}

function notifyOperationDrainWaiters() {
  if (activeBusinessOperations > 0 || maintenancePending || maintenanceOperation) return;
  for (const resolve of operationDrainWaiters) resolve();
  operationDrainWaiters.clear();
}

async function waitForOperationsToDrain() {
  if (activeBusinessOperations === 0 && !maintenancePending && !maintenanceOperation) return;
  await new Promise<void>((resolve) => operationDrainWaiters.add(resolve));
}

/**
 * Resolves once no maintenance is running, or gives up after the bound. It
 * never throws: the caller re-asserts, so the refusal keeps a single wording.
 */
async function waitForMaintenanceToFinish() {
  if (shutdownPending || !(maintenancePending || maintenanceOperation)) return;
  await new Promise<void>((resolve) => {
    const release = () => {
      clearTimeout(timer);
      maintenanceWaiters.delete(release);
      resolve();
    };
    const timer = setTimeout(release, MAINTENANCE_WAIT_MS);
    maintenanceWaiters.add(release);
  });
}

/**
 * Waits out maintenance, then refuses only if it is still running.
 *
 * `assertNoMaintenance` on its own is the right check at a point where nothing
 * may be in flight, but it is the wrong one in the middle of an operation that
 * has already awaited something: maintenance that started during that await
 * turned an ordinary read into a visible refusal. Resetting the workspace
 * reloads the window, and the reload's first read could land inside the tail of
 * the reset it was triggered by — and be told to try again, for an operation
 * that was about to finish on its own.
 */
async function awaitMaintenanceThenAssert() {
  await waitForMaintenanceToFinish();
  assertNoMaintenance();
}

async function runBusinessOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  if (!shutdownPending && (maintenancePending || maintenanceOperation)) {
    await waitForMaintenanceToFinish();
  }
  assertNoMaintenance();
  activeBusinessOperations += 1;
  try {
    return await operation();
  } finally {
    activeBusinessOperations -= 1;
    if (activeBusinessOperations === 0) {
      for (const resolve of businessIdleWaiters) resolve();
      businessIdleWaiters.clear();
    }
    notifyOperationDrainWaiters();
  }
}

async function runExclusiveMaintenance<T>(label: string, operation: () => Promise<T>): Promise<T> {
  assertNoMaintenance();
  maintenancePending = true;
  if (activeBusinessOperations > 0) {
    await new Promise<void>((resolve) => businessIdleWaiters.add(resolve));
  }
  maintenanceOperation = label;
  try {
    return await operation();
  } finally {
    maintenanceOperation = null;
    maintenancePending = false;
    for (const release of [...maintenanceWaiters]) release();
    notifyOperationDrainWaiters();
  }
}

async function withAuthorizedPrisma<T>(operation: (prisma: Awaited<ReturnType<typeof getPrisma>>) => Promise<T>): Promise<T> {
  if (localSecurity) {
    await localSecurity.assertUnlocked();
    await localSecurity.touch();
  }
  return operation(await getPrisma(app));
}

async function getAuthorizedPrisma() {
  return withAuthorizedPrisma(async (prisma) => prisma);
}

async function getTrustedActorUserId() {
  return trustedActorUserId;
}

async function appendTrustedAudit(tx: any, data: {
  companyId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  description: string;
  details?: Record<string, unknown>;
}) {
  await appendActivityAndAudit(tx, {
    companyId: data.companyId,
    actorUserId: trustedActorUserId,
    action: data.action,
    entityType: data.entity,
    entityId: data.entityId ?? null,
    description: data.description,
    payload: data.details ?? {},
  });
}

async function resetLocalSecurityAfterDatabaseReplacement() {
  allowSecurityMaintenanceAccess = true;
  try {
    await localSecurity?.resetAfterDatabaseReplacement();
    const prisma = await getPrisma(app);
    trustedActorUserId = (await prisma.user.findFirst({ select: { id: true } }))?.id ?? null;
  } finally {
    allowSecurityMaintenanceAccess = false;
  }
}

async function reopenDatabaseAndResetSession() {
  ensureDatabaseFile(app);
  await resetLocalSecurityAfterDatabaseReplacement();
  startupDatabaseError = null;
}

function bestEffortRestoreCleanup(description: string, cleanup: () => void) {
  runBestEffortCleanup(cleanup, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeMainProcessError(new Error(`Nettoyage différé après restauration (${description}) : ${message}`, { cause: error }));
  });
}

function restoreFailure(
  prefix: string,
  originalError: unknown,
  rollbackError: unknown | null,
  livePath: string,
  previousPath: string,
) {
  const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
  if (!rollbackError) {
    return new Error(`${prefix} La base précédente a été restaurée, validée et rouverte. ${originalMessage}`, { cause: originalError });
  }

  const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  return new Error(
    `${prefix} Wheat n'a pas pu confirmer le retour à la base précédente. ` +
    `N'écrivez plus de données avant vérification manuelle. Base active : ${livePath}. ` +
    `Copie précédente : ${previousPath}. Erreur initiale : ${originalMessage}. ` +
    `Erreur du retour arrière : ${rollbackMessage}`,
    { cause: new AggregateError([originalError, rollbackError], "Échec de restauration et de retour arrière") },
  );
}

function writeMainProcessError(error: unknown) {
  const message = error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`;
  const targetDir = app.isReady() ? app.getPath("userData") : process.cwd();
  try {
    fs.appendFileSync(path.join(targetDir, "wheat-main-errors.log"), `[${new Date().toISOString()}]\n${message}\n`);
  } catch {
    // Last-resort guard: never let error logging create a second main-process failure.
  }
  console.error(error);
}

process.on("uncaughtException", (error) => {
  writeMainProcessError(error);
});

process.on("unhandledRejection", (reason) => {
  writeMainProcessError(reason);
});

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

const starterJournals = [
  { code: "OD", label: "Operations diverses", nextNumber: 1, allowManualPieceOverride: true },
  { code: "BQ", label: "Banque", nextNumber: 1, allowManualPieceOverride: true },
  { code: "VE", label: "Ventes", nextNumber: 1, allowManualPieceOverride: true },
  { code: "AC", label: "Achats", nextNumber: 1, allowManualPieceOverride: true },
  { code: "CA", label: "Caisse", nextNumber: 1, allowManualPieceOverride: true },
  { code: "PA", label: "Paie", nextNumber: 1, allowManualPieceOverride: true },
];

const starterAccounts = [
  { code: "111100", label: "Capital social", classNo: 1, type: "EQUITY" },
  { code: "211100", label: "Frais preliminaires", classNo: 2, type: "ASSET" },
  { code: "233200", label: "Materiel de transport", classNo: 2, type: "ASSET" },
  { code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
  { code: "345510", label: "TVA recuperable sur immobilisations", classNo: 3, type: "ASSET" },
  { code: "345520", label: "TVA recuperable sur charges", classNo: 3, type: "ASSET" },
  { code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY" },
  { code: "445500", label: "Etat - TVA facturee", classNo: 4, type: "LIABILITY" },
  { code: "445660", label: "Etat - TVA due", classNo: 4, type: "LIABILITY" },
  { code: "514100", label: "Banques", classNo: 5, type: "ASSET" },
  { code: "516100", label: "Caisses", classNo: 5, type: "ASSET" },
  { code: "611100", label: "Achats de marchandises", classNo: 6, type: "EXPENSE" },
  { code: "612500", label: "Achats non stockes", classNo: 6, type: "EXPENSE" },
  { code: "614100", label: "Locations et charges locatives", classNo: 6, type: "EXPENSE" },
  { code: "617100", label: "Remunerations du personnel", classNo: 6, type: "EXPENSE" },
  { code: "711100", label: "Ventes de marchandises", classNo: 7, type: "REVENUE" },
  { code: "712400", label: "Prestations de services", classNo: 7, type: "REVENUE" },
];

async function clearWorkspace(prisma: Awaited<ReturnType<typeof getPrisma>>) {
  await prisma.$transaction(async (tx) => {
    // Immutable invoice artifacts intentionally reject ordinary deletion. An
    // explicit, backed-up workspace reset is the sole maintenance path that
    // temporarily removes these triggers; the surrounding SQLite transaction
    // guarantees they return even if any later delete fails.
    await tx.$executeRawUnsafe('DROP TRIGGER IF EXISTS "InvoiceArtifact_immutable_update"');
    await tx.$executeRawUnsafe('DROP TRIGGER IF EXISTS "InvoiceArtifact_immutable_delete"');

    await tx.vatWorkpaperEvidence.deleteMany();
    await tx.vatWorkpaperAdjustment.deleteMany();
    await tx.vatWorkpaperLine.deleteMany();
    await tx.vatWorkpaper.updateMany({ data: { supersedesWorkpaperId: null } });
    await tx.vatWorkpaper.deleteMany();
    await tx.invoiceArtifact.updateMany({ data: { supersedesArtifactId: null } });
    await tx.invoiceArtifact.deleteMany();
    await tx.fiscalYear.updateMany({ data: { closeRunId: null } });
    await tx.fiscalCloseRun.deleteMany();
    await tx.auditSeal.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.auditChain.deleteMany();
    await tx.wheatAiAuditEvent.deleteMany();
    await tx.wheatKnowledgePattern.deleteMany();
    await tx.wheatAiSettings.deleteMany();
    await tx.fiscalTableEvidence.deleteMany();
    await tx.fiscalTableWorkpaper.deleteMany();
    await tx.fiscalAdjustment.deleteMany();
    await tx.fiscalPackage.deleteMany();
    await tx.reportConfiguration.deleteMany();
    await tx.openingBalanceLine.deleteMany();
    await tx.openingBalanceRun.deleteMany();
    await tx.journalPieceSequence.deleteMany();
    await tx.activityLog.deleteMany();
    await tx.ledgerImportRow.deleteMany();
    await tx.ledgerImportBatch.deleteMany();
    await tx.bankImportProfile.deleteMany();
    await tx.companyUser.deleteMany();
    await tx.user.deleteMany();
    await tx.employee.deleteMany();
    await tx.taxPeriod.deleteMany();
    await tx.bankReconciliationPaymentEvidence.deleteMany();
    await tx.bankReconciliationAllocation.deleteMany();
    await tx.bankReconciliation.deleteMany();
    await tx.paymentAllocation.deleteMany();
    await tx.document.deleteMany();
    await tx.payment.deleteMany();
    await tx.invoiceLine.updateMany({ data: { creditedInvoiceLineId: null } });
    await tx.invoiceLine.deleteMany();
    await tx.invoice.updateMany({ data: { creditedInvoiceId: null, taxConfigurationVersionId: null } });
    await tx.invoice.deleteMany();
    await tx.taxRateDefinition.deleteMany();
    await tx.taxConfigurationVersion.deleteMany();
    await tx.invoiceSequence.deleteMany();
    await tx.bankMovement.deleteMany();
    await tx.bankStatementImport.deleteMany();
    await tx.bankAccount.deleteMany();
    await tx.payrollRun.deleteMany();
    await tx.entry.updateMany({ data: { reversalOfId: null } });
    await tx.entryLine.deleteMany();
    await tx.entry.deleteMany();
    await tx.counterparty.deleteMany();
    await tx.journal.deleteMany();
    await tx.account.deleteMany();
    await tx.fiscalYear.deleteMany();
    await tx.company.deleteMany();

    await tx.$executeRawUnsafe(`CREATE TRIGGER "InvoiceArtifact_immutable_update"
      BEFORE UPDATE ON "InvoiceArtifact"
      WHEN OLD."immutable" = true
      BEGIN
        SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be updated; append a revision instead.');
      END`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER "InvoiceArtifact_immutable_delete"
      BEFORE DELETE ON "InvoiceArtifact"
      WHEN OLD."immutable" = true
      BEGIN
        SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be deleted.');
      END`);
  }, { timeout: 60_000 });
}

async function ensureDefaultUser(prisma: Awaited<ReturnType<typeof getPrisma>>) {
  // Looked up under either address so an installation created before the
  // rename keeps its single administrator instead of gaining a second one.
  const existing = await prisma.user.findFirst({ where: { email: { in: adminEmailValues() } } });
  const user = existing ?? await prisma.user.create({
    data: { name: "Administrateur local", email: WHEAT_ADMIN_EMAIL, role: "ADMIN", twoFactorOn: false },
  });
  trustedActorUserId = user.id;
  return user;
}

type StarterCompanyInput = {
  name: string;
  legalForm?: string;
  ice?: string;
  taxId?: string;
  city?: string;
  fiscalYearStart?: string;
  fiscalYearEnd?: string;
  vatFrequency?: "MONTHLY" | "QUARTERLY";
};

function starterPeriod(input: StarterCompanyInput) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startsOn = input.fiscalYearStart ? parseIsoDay(input.fiscalYearStart, "La date de début d'exercice") : d(`${year}-01-01`);
  const endsOn = input.fiscalYearEnd ? parseIsoDay(input.fiscalYearEnd, "La date de fin d'exercice") : d(`${year}-12-31`);
  if (startsOn > endsOn) throw new Error("La fin de l'exercice doit être postérieure à son début.");

  const vatFrequency = input.vatFrequency ?? "MONTHLY";
  if (!(["MONTHLY", "QUARTERLY"] as const).includes(vatFrequency)) {
    throw new Error("La fréquence de TVA doit être mensuelle ou trimestrielle.");
  }
  const reference = now < startsOn ? startsOn : now > endsOn ? endsOn : now;
  const periodEndMonth = vatFrequency === "MONTHLY"
    ? reference.getUTCMonth() + 1
    : Math.min(12, Math.ceil((reference.getUTCMonth() + 1) / 3) * 3);
  const periodEnd = new Date(Date.UTC(reference.getUTCFullYear(), periodEndMonth, 0));
  const declarationDue = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 20));
  const periodLabel = vatFrequency === "MONTHLY"
    ? `TVA mensuelle ${reference.getUTCFullYear()}-${String(reference.getUTCMonth() + 1).padStart(2, "0")}`
    : `TVA trimestrielle T${Math.ceil((reference.getUTCMonth() + 1) / 3)} ${reference.getUTCFullYear()}`;

  return { startsOn, endsOn, declarationDue, periodLabel };
}

async function createStarterCompany(prisma: Awaited<ReturnType<typeof getPrisma>>, input: StarterCompanyInput) {
  const user = await ensureDefaultUser(prisma);
  const period = starterPeriod(input);
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
      name: input.name.trim(),
      legalForm: input.legalForm?.trim() || "SARL",
      ice: input.ice?.trim() || "",
      taxId: input.taxId?.trim() || "",
      city: input.city?.trim() || "Casablanca",
      vatFrequency: input.vatFrequency ?? "MONTHLY",
      fiscalYears: {
        create: [
          {
            label: `Exercice ${period.startsOn.toISOString().slice(0, 10)} au ${period.endsOn.toISOString().slice(0, 10)}`,
            startsOn: period.startsOn,
            endsOn: period.endsOn,
            status: "OPEN",
          },
        ],
      },
      journals: { create: starterJournals },
      accounts: { create: starterAccounts },
      bankAccounts: {
        create: {
          bankName: "Compte bancaire principal",
          iban: "Renseigner IBAN",
          balanceCents: 0n,
          currency: "MAD",
        },
      },
      taxPeriods: {
        create: {
          label: period.periodLabel,
          collectedVatCents: 0n,
          deductibleVatCents: 0n,
          dueVatCents: 0n,
          creditVatCents: 0n,
          status: "DRAFT",
          declarationDue: period.declarationDue,
        },
      },
        companyUsers: {
          create: { userId: user.id, role: "ADMIN" },
        },
      },
      include: { accounts: true, journals: true, fiscalYears: true, bankAccounts: true },
    });

    await seedPcgeForCompany(tx, company.id);

    const defaultBankLedger = company.accounts.find((account) => account.code === "514100");
    const defaultBankAccount = company.bankAccounts[0];
    if (defaultBankLedger && defaultBankAccount) {
      await tx.bankAccount.update({
        where: { id: defaultBankAccount.id },
        data: { ledgerAccountId: defaultBankLedger.id, balanceSource: "OPENING_BALANCE" },
      });
    }
    await appendActivityAndAudit(tx, {
      companyId: company.id,
      actorUserId: user.id,
      action: "CREATE_COMPANY",
      entityType: "Company",
      entityId: company.id,
      description: "Société créée depuis l'assistant Wheat",
      payload: { name: company.name, legalForm: company.legalForm, fiscalYearStart: period.startsOn, fiscalYearEnd: period.endsOn },
    });
    return tx.company.findUniqueOrThrow({
      where: { id: company.id },
      include: { accounts: true, journals: true, fiscalYears: true, bankAccounts: true },
    });
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  trustedRendererLocation = resolveTrustedRendererLocation({
    isPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    rendererFilePath: path.join(__dirname, "../dist/index.html"),
  });
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: "Wheat",
    backgroundColor: "#f7f9fc",
    autoHideMenuBar: true,
    // The first launch has to open the SQLite profile, generate the Prisma
    // client bindings and evaluate a large renderer bundle before anything is
    // usable. Showing an empty frame during that window is what cost Wheat its
    // keyboard focus: Windows grants a starting process the right to take the
    // foreground only briefly, and a frame shown before its web contents exist
    // consumed that grant on a widget that could not accept a keystroke. The
    // window is therefore created hidden and shown — and explicitly focused,
    // web contents included — once the renderer is ready to paint.
    show: false,
    // Development only. A packaged Wheat has its icon compiled into Wheat.exe
    // by electron-builder, and `process.cwd()` there is wherever the shortcut
    // was launched from — pointing at it would name a file that does not exist.
    ...(app.isPackaged ? {} : { icon: path.join(process.cwd(), "build", "icon.png") }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  installBrowserWindowSecurity(win, trustedRendererLocation);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.once("did-finish-load", () => {
    if (!automaticUpdateCheckStarted) {
      automaticUpdateCheckStarted = true;
      // Asynchronous and unattended: Wheat is already usable, the check runs
      // beside the accountant's work, and it downloads nothing. Whatever it
      // finds is offered, never applied.
      setTimeout(() => void checkForUpdates(true).catch(writeMainProcessError), 1_500);
    }
  });
  // `ready-to-show` is the normal path. The timer is the guarantee: a renderer
  // that fails to reach first paint must still produce a visible window the
  // user can read the error in, never an invisible process.
  const revealWindow = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    focusWindowAndContents(win);
  };
  const revealTimer = setTimeout(revealWindow, 10_000);
  win.once("ready-to-show", () => {
    clearTimeout(revealTimer);
    revealWindow();
  });
  win.once("closed", () => clearTimeout(revealTimer));
  // A native window can hold the foreground while its render widget does not
  // hold the keyboard: the caret blinks, `document.activeElement` is the input,
  // and every keystroke is dropped. These two handlers repair only that half —
  // they never call `focus()` on the window itself, so Wheat cannot pull the
  // foreground away from whatever the user is doing in another application.
  win.on("focus", () => focusRendererWidget(win));
  win.webContents.on("did-finish-load", () => focusRendererWidget(win));

  if (trustedRendererLocation.mode === "development") {
    void win.loadURL(trustedRendererLocation.url);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  return win;
}

/**
 * Hands the keyboard to the page inside an already-focused window.
 *
 * Windows keyboard focus has two halves: the native frame, and the Chromium
 * render widget inside it. `BrowserWindow.focus()` only does the first, so a
 * window could be active, an input could be clicked and show a caret, and every
 * keystroke still go nowhere. This is the second half, and it is deliberately a
 * no-op when the window is not the active one.
 */
function focusRendererWidget(win: BrowserWindow) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  if (!win.isFocused()) return;
  win.webContents.focus();
}

/**
 * Brings a window forward and gives its page the keyboard. Used only where
 * taking the foreground is the intent: first reveal, second-instance launch,
 * and the renderer's explicit focus request after a native dialog.
 */
function focusWindowAndContents(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  win.focus();
  if (!win.webContents.isDestroyed()) win.webContents.focus();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  focusWindowAndContents(mainWindow);
}

/**
 * Wheat is the product name shown everywhere in the interface and to the OS.
 *
 * This identifier is not branding: it is the Windows AppUserModelID and the key
 * the NSIS installer registered this application under. Windows uses it to tie
 * an install, its uninstall entry, its Start-menu shortcuts and its taskbar
 * pinning together, so changing it would make an existing installation
 * unrecognisable and let a second copy install alongside it. It is immutable
 * for the life of the install and never reaches the interface.
 */
const WINDOWS_INSTALL_IDENTITY = "ma.atlasledger.desktop";

app.setName("Wheat");
app.setAppUserModelId(WINDOWS_INSTALL_IDENTITY);
const profileMigration = resolveProfileDirectory(app.getPath("appData"));
app.setPath("userData", profileMigration.profileDirectory);
recordProfileMigration(profileMigration.profileDirectory, profileMigration.events);

const explicitDevelopmentProfile = prepareRuntimeEnvironment({ isPackaged: app.isPackaged, env: process.env });
if (explicitDevelopmentProfile) {
  fs.mkdirSync(explicitDevelopmentProfile, { recursive: true });
  app.setPath("userData", explicitDevelopmentProfile);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) focusMainWindow();
    else void app.whenReady().then(focusMainWindow);
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  try {
    ensureDatabaseFile(app);
    startupDatabaseError = null;
  } catch (error) {
    startupDatabaseError = error instanceof Error ? error : new Error(String(error));
    writeMainProcessError(startupDatabaseError);
  }
  localSecurity = registerLocalSecurityIpc({
    ipcMain,
    getPrisma: () => {
      if (!allowSecurityMaintenanceAccess) assertNoMaintenance();
      return getPrisma(app);
    },
    serialize,
  });
  const updaterStateDirectory = resolveUpdaterStateDirectory(app);
  // Local folder or HTTPS release host, decided by what this build was
  // configured with. Without a feed URL this is exactly the previous behaviour.
  const updateChannel = resolveUpdateChannel({
    isPackaged: app.isPackaged,
    localDirectory: resolveLocalUpdateDirectory(app, path.resolve(__dirname, "..")),
  });
  updateService = new UpdateService({
    currentVersion: WHEAT_APP_VERSION,
    provider: updateChannel.provider,
    publicKey: updateChannel.publicKey,
    stateDirectory: updaterStateDirectory,
    automaticInstallationEnabled: resolveAutomaticInstallationEnabled({ isPackaged: app.isPackaged }),
    onStatus: (status) => mainWindow?.webContents.send("wheat:update:status", status),
  });
  if (updateChannel.misconfiguration) {
    void updateService.logger.log("channel-misconfigured", { provider: updateChannel.provider.name, reason: updateChannel.misconfiguration });
  }
  entryCommandService = createEntryCommandService({ getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId });
  registerIpc();
  subledgerService = registerSubledgerIpc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerReconciliationIpc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  // Unfinished form contents. Deliberately registered alongside the domain
  // services and deliberately not one of them: it stores what somebody has
  // typed, and never becomes accounting data except through the service that
  // owns that decision.
  registerFormDraftIpc(ipcMain, createFormDraftService(getAuthorizedPrisma));
  // Initial preparation of a dossier. A gate until the accountant approves the
  // foundation, and nothing at all afterwards.
  registerWheatDossierSetupIpc(ipcMain, createWheatDossierSetupService(getAuthorizedPrisma));
  registerReportingIpc({ ipcMain, getPrisma: getAuthorizedPrisma, serialize });
  registerReporting21Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, serialize });
  registerFiscal21Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerWheatAiIpc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    // The assistant reaches Wheat's document commands, not its own copies of
    // them, and every one is bound to the dossier the request came in for.
    documentCommands: {
      read: (companyId, documentId) => readDocumentExtraction(companyId, documentId),
      updateExtraction: (companyId, payload) => updateDocumentExtraction(companyId, payload),
      rerunOcr: (companyId, documentId) => rerunDocumentOcr(companyId, documentId),
      createInvoiceDraft: (companyId, documentId, kind) => createInvoiceDraftFromDocument(companyId, documentId, { forcedKind: kind ?? null }),
      reclassifyInvoiceDraft: (companyId, payload) => reclassifyInvoiceDraft(companyId, payload),
    },
    manifestPath: app.isPackaged
      ? path.join(process.resourcesPath, "models", "wheat-model-manifest.json")
      : path.resolve(__dirname, "..", "resources", "models", "wheat-model-manifest.json"),
    modelRoot: path.join(app.getPath("userData"), "wheat-ai-models"),
    appVersion: WHEAT_APP_VERSION,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    serialize,
  });
  wheatAiProviderService = registerWheatAiProviderIpc({
    ipcMain,
    service: new WheatAiProviderService({
      directory: path.join(app.getPath("userData"), "wheat-ai"),
      safeStorage,
    }),
  });
  installWheatAiDiagnostics(path.join(app.getPath("userData"), "wheat-ai-diagnostics.log"));
  setWheatAiRemoteProviderService(wheatAiProviderService);
  const operations13Service = registerOperations13Ipc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    serialize,
    persistImportSource: persistManagedLedgerImportSource,
    readImportSource: (storedPath) => fs.promises.readFile(storedPath),
  });
  registerCreditNotes14Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  const compliance14Service = registerCompliance14Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerWheatReviewIpc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    resolveModel: resolveReviewModel,
    describeModel: describeReviewModel,
    serialize,
  });
  registerWheatJourneyIpc({ ipcMain, getPrisma: getAuthorizedPrisma, serialize });
  // Guided work drives the services registered above rather than reimplementing
  // them: a draft it creates is the draft the documents screen creates, posted
  // by the subledger, with the same validation and the same audit entries.
  registerWheatGuidedWorkIpc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    serialize,
    services: {
      createInvoiceDraftFromDocument: ({ companyId, documentId, forcedKind }) =>
        createInvoiceDraftFromDocument(companyId, documentId, { forcedKind: forcedKind ?? null }),
      // The same correction the OCR review screen saves: one merge rule, one
      // confidence rule, one `SMART_OCR_CORRECT` audit entry.
      updateDocumentExtraction: ({ companyId, documentId, fields }) =>
        updateDocumentExtraction(companyId, { documentId, fields }),
      postInvoice: (input) => {
        if (!subledgerService) throw new Error("Le sous-livre des factures n'est pas encore disponible.");
        return subledgerService.postInvoice(input);
      },
      saveFiscalYear: (input) => operations13Service.saveFiscalYear(input),
      saveTaxConfigDraft: (input) => compliance14Service.saveTaxConfigDraft(input),
      activateTaxConfig: (input) => compliance14Service.activateTaxConfig(input),
    },
  });
  createWindow();

  // The recognition models load once and take several seconds. Doing it here,
  // in the background, means the first document a user imports no longer pays
  // for it — measured at roughly thirteen seconds on this repository's samples.
  // A machine without the local runtime simply carries on; the status call
  // reports why, exactly as before.
  void warmPaddleOcr(app).catch(() => undefined);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", async (event) => {
  if (!hasSingleInstanceLock) return;
  event.preventDefault();
  if (shutdownPending) return;
  shutdownPending = true;
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
  } catch (error) {
    writeMainProcessError(error);
  } finally {
    app.exit(0);
  }
});

async function relaunchWheat() {
  if (internalRestartPending) return { restarting: true };
  internalRestartPending = true;
  // Reject new operations while allowing the existing drain predicate to
  // become true. Setting maintenancePending here would deadlock because the
  // drain predicate itself requires maintenancePending to be false.
  shutdownPending = true;
  mainWindow?.webContents.send("wheat:app:will-restart");
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
    return { restarting: true };
  } catch (error) {
    internalRestartPending = false;
    shutdownPending = false;
    throw error;
  }
}

/**
 * Looks for a newer release. Never downloads, never installs.
 *
 * The unattended launch check stays silent when the release host cannot be
 * reached; a check the user asked for reports that plainly.
 */
async function checkForUpdates(automatic = false) {
  if (!updateService) throw new Error("Wheat updater is not ready.");
  // Diagnose the previous attempt before a check can rewrite it as already-staged,
  // even when renderer bootstrap/confirmation takes longer than our timer.
  if (automatic && !startupDatabaseError) await updateService.confirmSuccessfulStartup();
  if (automatic && await updateService.hasUnresolvedInstallationFailure()) return updateService.getStatus();
  const state = await updateService.checkForUpdates({ automatic });
  return state.status;
}

async function launchStagedUpdateAndExit(state: PersistedUpdateState) {
  if (!updateService || !state.pending) throw new Error("No validated update is ready to install.");
  if (internalRestartPending) return;
  internalRestartPending = true;
  shutdownPending = true;
  const availableVersion = state.pending.release.version;
  let helperPid: number;
  try {
    state.pending.rollbackPath = path.join(resolveUpdaterStateDirectory(app), "rollback", state.pending.previousVersion);
    await updateService.store.write(state);
    // Wait for script readiness before draining operations or notifying the
    // renderer of shutdown. A failed helper leaves the running app usable.
    helperPid = await launchWindowsUpdateHelper(state, {
      stateDirectory: resolveUpdaterStateDirectory(app),
      helperPath: path.join(process.resourcesPath, "updater", "update-helper.ps1"),
      currentExecutable: process.execPath,
      parentPid: process.pid,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await updateService.logger.log("helper-launch-failed", { availableVersion, reason });
    internalRestartPending = false;
    shutdownPending = false;
    throw error;
  }
  await updateService.logger.log("helper-ready-confirmed", { availableVersion, helperPid });
  mainWindow?.webContents.send("wheat:app:will-restart");
  // The helper is now committed: it acts as soon as this process exits. Exiting
  // is therefore mandatory even if the drain fails, because staying alive would
  // leave it blocked forever and let a retry spawn a second one against the
  // same install directory.
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
  } catch (error) {
    writeMainProcessError(error);
    await updateService.logger.log("shutdown-drain-failed", { availableVersion, reason: error instanceof Error ? error.message : String(error) });
  }
  await updateService.logger.log("restart-requested", { availableVersion, helperPid });
  app.exit(0);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function normalizeSageMappings(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10_000) throw new Error(`${label} contient trop de codes.`);
  const normalized: Record<string, string> = {};
  for (const [rawSource, rawTarget] of entries) {
    const source = rawSource.trim();
    if (!source || source.length > 30 || /[\r\n;]/.test(source)) throw new Error(`${label} contient un code source invalide.`);
    if (typeof rawTarget !== "string") throw new Error(`${label} contient une cible invalide.`);
    const target = rawTarget.trim();
    if (target.length > 30 || /[\r\n;]/.test(target)) throw new Error(`${label} contient une cible invalide.`);
    normalized[source] = target;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function parseStoredSageMappings(value: string) {
  try {
    return normalizeSageMappings(JSON.parse(value), "Le profil Sage enregistré");
  } catch (error) {
    throw new Error(`Le profil Sage enregistré est endommagé. ${error instanceof Error ? error.message : ""}`.trim(), { cause: error });
  }
}

function normalizeSageProfilePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Le profil Sage est invalide.");
  const input = payload as Record<string, unknown>;
  const outputKind = requireText(input.outputKind, "Le type de fichier Sage", 10);
  if (!new Set(["TXT", "CSV", "PNM"]).has(outputKind)) throw new Error("Le type de fichier Sage est invalide.");
  const encoding = requireText(input.encoding, "L'encodage Sage", 30);
  if (!new Set(["windows-1252", "utf-8"]).has(encoding)) throw new Error("L'encodage Sage est invalide.");
  const accountLength = String(input.accountLength ?? "VARIABLE");
  if (accountLength !== "VARIABLE" && (!/^\d+$/.test(accountLength) || Number(accountLength) < 6 || Number(accountLength) > 13)) {
    throw new Error("La longueur des comptes Sage est invalide.");
  }
  if (typeof input.includeHeader !== "boolean" || typeof input.requireJournalMapping !== "boolean") {
    throw new Error("Les options du profil Sage sont invalides.");
  }

  return {
    companyId: requireId(input.companyId, "La société"),
    profileType: requireText(input.profileType, "Le profil Sage", 120),
    outputKind,
    encoding,
    includeHeader: input.includeHeader,
    accountLength,
    journalMappings: JSON.stringify(normalizeSageMappings(input.journalMappings, "Le mapping des journaux")),
    accountMappings: JSON.stringify(normalizeSageMappings(input.accountMappings, "Le mapping des comptes")),
    thirdPartyMappings: JSON.stringify(normalizeSageMappings(input.thirdPartyMappings ?? {}, "Le mapping des comptes tiers")),
    requireJournalMapping: input.requireJournalMapping,
  };
}

function registerIpc() {
  ipcMain.handle("wheat:update:status", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return updateService.getStatus();
  });
  ipcMain.handle("wheat:update:check", async () => checkForUpdates());
  // Three separate channels because they are three separate decisions by the
  // person using Wheat: look, fetch, restart. Nothing here ever escalates from
  // one to the next on its own.
  ipcMain.handle("wheat:update:download", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return (await updateService.downloadOfferedUpdate()).status;
  });
  ipcMain.handle("wheat:update:install", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return (await updateService.installStagedUpdate(launchStagedUpdateAndExit)).status;
  });
  ipcMain.handle("wheat:update:postpone", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return updateService.postponeUpdate();
  });
  ipcMain.handle("wheat:update:confirm-startup", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    if (startupDatabaseError) return updateService.getStatus();
    return updateService.confirmSuccessfulStartup();
  });
  ipcMain.handle("wheat:update:acknowledge", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return updateService.acknowledgeInstalledUpdate();
  });

  ipcMain.handle("wheat:bootstrap", async (_event, companyId?: string) => {
    let prisma: Awaited<ReturnType<typeof getPrisma>>;
    try {
      await awaitMaintenanceThenAssert();
      prisma = await getPrisma(app);
      await awaitMaintenanceThenAssert();
      startupDatabaseError = null;
    } catch (error) {
      startupDatabaseError = error instanceof Error ? error : new Error(String(error));
      const databasePath = resolveDatabasePath(app);
      throw new Error(
        `La base locale Wheat n'a pas pu être ouverte. Base concernée : ${databasePath}. ${startupDatabaseError.message}`,
        { cause: error },
      );
    }
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const user = await prisma.user.findFirst();
    trustedActorUserId = user?.id ?? null;
    const companyIds = await prisma.company.findMany({ select: { id: true } });
    for (const company of companyIds) {
      await prisma.$transaction((tx) => seedPcgeForCompany(tx, company.id), { timeout: 60_000 });
    }
    // The chart of accounts is only ever read for the dossier being worked on,
    // and each dossier carries the full PCGE — better than a thousand rows.
    // Shipping every dossier's chart made bootstrap cost grow with the size of
    // the cabinet rather than the size of the work: a twenty-five dossier
    // profile sent close to thirty thousand unused rows on every launch.
    const companyShells = await prisma.company.findMany({
      include: {
        fiscalYears: true,
        journals: { orderBy: { code: "asc" } },
        _count: { select: { entries: true, invoices: true, documents: true, employees: true } },
      },
      orderBy: { name: "asc" },
    });

    const activeCompanyId = companyId ?? companyShells[0]?.id;
    const activeAccounts = activeCompanyId
      ? await prisma.account.findMany({ where: { companyId: activeCompanyId }, orderBy: { code: "asc" } })
      : [];
    const companies = companyShells.map((company) => ({
      ...company,
      accounts: company.id === activeCompanyId ? activeAccounts : [],
    }));

    const [entries, invoices, documents, bankAccounts, taxPeriods, employees, activityLogs, ledgerEntryCount, dashboardMetrics] = await Promise.all([
      prisma.entry.findMany({
        where: { companyId: activeCompanyId },
        include: {
          journal: true,
          lines: { include: { account: true }, orderBy: { position: "asc" } },
        },
        orderBy: [{ date: "desc" }, { number: "desc" }],
        take: 500,
      }),
      prisma.invoice.findMany({ where: { companyId: activeCompanyId }, orderBy: { dueDate: "asc" }, take: 500 }),
      prisma.document.findMany({ where: { companyId: activeCompanyId }, orderBy: { createdAt: "desc" }, take: 500 }),
      prisma.bankAccount.findMany({
        where: { companyId: activeCompanyId },
        include: {
          movements: {
            include: {
              reconciliations: {
                where: { status: "ACTIVE" },
                include: { allocations: true },
              },
            },
            orderBy: { date: "desc" },
            take: 500,
          },
        },
        orderBy: { bankName: "asc" },
      }),
      prisma.taxPeriod.findMany({ where: { companyId: activeCompanyId }, orderBy: { declarationDue: "asc" } }),
      prisma.employee.findMany({ where: { companyId: activeCompanyId }, orderBy: { fullName: "asc" } }),
      prisma.activityLog.findMany({ where: { companyId: activeCompanyId }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.entry.count({ where: { companyId: activeCompanyId } }),
      buildDashboardMetrics(prisma, activeCompanyId),
    ]);

    return serialize({
      appVersion: WHEAT_APP_VERSION,
      databasePath: resolveDatabasePath(app),
      user,
      companies,
      activeCompanyId,
      entries,
      invoices,
      documents,
      bankAccounts: bankAccounts.map((bankAccount) => ({
        ...bankAccount,
        movements: bankAccount.movements.map((movement) => {
          const allocatedCents = movement.reconciliations.reduce(
            (sum, reconciliation) => sum + reconciliation.allocations.reduce((batch, allocation) => batch + allocation.amountCents, 0n),
            0n,
          );
          const reconciliation = deriveReconciliationState({
            amountCents: movement.amountCents,
            allocatedCents,
            excludedAt: movement.excludedAt,
            legacyMatchClaimed: movement.legacyMatchClaimed,
          });
          return {
            ...movement,
            reconciliationStatus: reconciliation.status,
            allocatedCents: reconciliation.allocatedCents,
            remainingCents: reconciliation.remainingCents,
            status: reconciliation.status === "RECONCILED" ? "MATCHED" : reconciliation.status,
          };
        }),
      })),
      taxPeriods,
      employees,
      activityLogs,
      dashboardMetrics,
      ledgerSummary: { totalEntries: ledgerEntryCount, displayedEntries: entries.length },
      workspaceLimits: { entries: 500, invoices: 500, documents: 500, bankMovementsPerAccount: 500 },
    });
  });

  ipcMain.handle("wheat:entry:sage-export-set", async (_event, rawCompanyId: unknown) => {
    const companyId = requireId(rawCompanyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new Error("La société sélectionnée n'existe plus.");
    const entries = await prisma.entry.findMany({
      where: { companyId, status: { in: [ENTRY_STATUS.posted, ENTRY_STATUS.reversed] } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: {
        id: true,
        number: true,
        date: true,
        pieceNumber: true,
        label: true,
        status: true,
        journalCodeSnapshot: true,
        lines: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            accountCodeSnapshot: true,
            label: true,
            debitCents: true,
            creditCents: true,
            thirdParty: true,
            counterpartyId: true,
          },
        },
      },
    });
    return serialize(entries.map((entry) => ({
      ...entry,
      journal: { code: entry.journalCodeSnapshot },
      lines: entry.lines.map((line) => ({
        ...line,
        account: { code: line.accountCodeSnapshot },
      })),
    })));
  });

  ipcMain.handle("wheat:sage-profile:get", async (_event, rawCompanyId: unknown) => {
    const companyId = requireId(rawCompanyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const profile = await prisma.sageExportProfile.findUnique({ where: { companyId } });
    if (!profile) return null;
    return serialize({
      ...profile,
      journalMappings: parseStoredSageMappings(profile.journalMappings),
      accountMappings: parseStoredSageMappings(profile.accountMappings),
      thirdPartyMappings: parseStoredSageMappings(profile.thirdPartyMappings),
    });
  });

  ipcMain.handle("wheat:sage-profile:save", async (_event, payload: unknown) => {
    const input = normalizeSageProfilePayload(payload);
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { id: true } });
    if (!company) throw new Error("La société sélectionnée n'existe plus.");

    const saved = await prisma.$transaction(async (tx) => {
      const profile = await tx.sageExportProfile.upsert({
        where: { companyId: input.companyId },
        create: input,
        update: {
          profileType: input.profileType,
          outputKind: input.outputKind,
          encoding: input.encoding,
          includeHeader: input.includeHeader,
          accountLength: input.accountLength,
          journalMappings: input.journalMappings,
          accountMappings: input.accountMappings,
          thirdPartyMappings: input.thirdPartyMappings,
          requireJournalMapping: input.requireJournalMapping,
          version: { increment: 1 },
        },
      });
      await appendActivityAndAudit(tx, {
        companyId: input.companyId,
        actorUserId: trustedActorUserId,
        action: "SAVE_SAGE_EXPORT_PROFILE",
        entityType: "SageExportProfile",
        entityId: profile.id,
        description: "Profil d'export Sage enregistré",
        payload: { outputKind: profile.outputKind, encoding: profile.encoding, accountLength: profile.accountLength, version: profile.version },
      });
      return profile;
    });

    return serialize({
      ...saved,
      journalMappings: parseStoredSageMappings(saved.journalMappings),
      accountMappings: parseStoredSageMappings(saved.accountMappings),
    });
  });

  ipcMain.handle("wheat:user:update", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données utilisateur sont invalides.");
    const name = requireText((payload as Record<string, unknown>).name, "Le nom utilisateur", 80);

    const prisma = await getAuthorizedPrisma();
    const user = await prisma.user.findFirst() ?? await ensureDefaultUser(prisma);
    trustedActorUserId = user.id;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({ where: { id: user.id }, data: { name } });
      const memberships = await tx.companyUser.findMany({ where: { userId: user.id }, select: { companyId: true } });
      for (const membership of memberships) {
        await appendActivityAndAudit(tx, {
          companyId: membership.companyId,
          actorUserId: user.id,
          action: "UPDATE_LOCAL_USER_NAME",
          entityType: "User",
          entityId: user.id,
          description: "Nom du profil local modifié",
          payload: { previousName: user.name, name },
        });
      }
      return result;
    });

    return serialize(updated);
  });

  ipcMain.handle("wheat:company:create", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de la société sont invalides.");
    const input = payload as Record<string, unknown>;
    const name = requireText(input.name, "Le nom de la société", 160);
    const legalForm = optionalText(input.legalForm, 60) ?? undefined;
    const ice = optionalText(input.ice, 30) ?? undefined;
    const taxId = optionalText(input.taxId, 40) ?? undefined;
    const city = optionalText(input.city, 100) ?? undefined;
    const fiscalYearStart = optionalText(input.fiscalYearStart, 10) ?? undefined;
    const fiscalYearEnd = optionalText(input.fiscalYearEnd, 10) ?? undefined;
    const vatFrequency = input.vatFrequency ?? "MONTHLY";
    if (vatFrequency !== "MONTHLY" && vatFrequency !== "QUARTERLY") throw new Error("La fréquence de TVA doit être mensuelle ou trimestrielle.");

    const prisma = await getAuthorizedPrisma();
    const company = await createStarterCompany(prisma, {
      name,
      legalForm,
      ice,
      taxId,
      city,
      fiscalYearStart,
      fiscalYearEnd,
      vatFrequency,
    });

    return serialize(company);
  });

  ipcMain.handle("wheat:company:delete", async (_event, companyId: string) => {
    const id = requireId(companyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            entries: { where: { status: { not: ENTRY_STATUS.draft } } },
            documents: true,
            invoices: true,
            payments: true,
            ledgerImportBatches: true,
          },
        },
      },
    });
    if (!company) throw new Error("La société à supprimer n'existe plus.");
    if (company._count.entries > 0) {
      throw new Error("Cette société contient des écritures comptabilisées. Elle ne peut pas être supprimée ; créez une sauvegarde puis conservez-la comme archive.");
    }
    if (company._count.documents > 0) {
      throw new Error("Cette société contient encore des documents. Supprimez-les explicitement depuis le classement OCR avant de supprimer la société.");
    }
    if (company._count.invoices > 0 || company._count.payments > 0) {
      throw new Error("Cette société contient un historique de factures ou de paiements. Wheat le conserve pour l'audit ; seule la réinitialisation explicite de tout l'espace peut l'effacer.");
    }
    if (company._count.ledgerImportBatches > 0) {
      throw new Error("Cette société contient des sources d'import comptable conservées comme preuve. Utilisez une réinitialisation explicite de l'espace après sauvegarde complète.");
    }
    const bankMovementCount = await prisma.bankMovement.count({ where: { bankAccount: { companyId: id } } });
    if (bankMovementCount > 0) {
      throw new Error("Cette société contient un relevé bancaire importé. Excluez ou archivez les mouvements au lieu de supprimer leur historique.");
    }

    await prisma.company.delete({ where: { id } });

    return serialize({ ok: true, id, name: company.name });
  });

  ipcMain.handle("wheat:bank:account:set-ledger", async (_event, payload: { companyId?: unknown; bankAccountId?: unknown; ledgerAccountId?: unknown }) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    const ledgerAccountId = requireId(payload?.ledgerAccountId, "Le compte comptable bancaire");

    return prisma.$transaction(async (tx) => {
      const [bankAccount, ledgerAccount] = await Promise.all([
        tx.bankAccount.findUnique({ where: { id: bankAccountId } }),
        tx.account.findUnique({ where: { id: ledgerAccountId } }),
      ]);
      if (!bankAccount || bankAccount.companyId !== companyId) throw new Error("Le compte bancaire n'appartient pas à cette société.");
      if (!ledgerAccount || ledgerAccount.companyId !== companyId || !ledgerAccount.active || !ledgerAccount.code.startsWith("514")) {
        throw new Error("Sélectionnez un compte bancaire actif de la classe 514 dans cette société.");
      }
      if (bankAccount.ledgerAccountId === ledgerAccountId) {
        return serialize(await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId }, include: { ledgerAccount: true } }));
      }
      const alreadyMapped = await tx.bankAccount.findFirst({ where: { ledgerAccountId, NOT: { id: bankAccountId } } });
      if (alreadyMapped) throw new Error("Ce compte comptable est déjà associé à un autre compte bancaire.");
      if (bankAccount.ledgerAccountId) {
        const activeReconciliationCount = await tx.bankReconciliation.count({
          where: { status: "ACTIVE", movement: { bankAccountId } },
        });
        if (activeReconciliationCount > 0) {
          throw new Error("Annulez d'abord les rapprochements actifs avant de changer le compte comptable associé.");
        }
      }
      const updated = await tx.bankAccount.update({
        where: { id: bankAccountId },
        data: { ledgerAccountId },
        include: { ledgerAccount: true },
      });
      await appendTrustedAudit(tx, {
        companyId,
        action: "MAP_BANK_LEDGER_ACCOUNT",
        entity: "BankAccount",
        entityId: bankAccountId,
        description: `${bankAccount.bankName} associé au compte ${ledgerAccount.code}`,
        details: { previousLedgerAccountId: bankAccount.ledgerAccountId, ledgerAccountId },
      });
      return serialize(updated);
    });
  });

  ipcMain.handle("wheat:bank:account:create-ledger", async (_event, payload: { companyId?: unknown; bankAccountId?: unknown; code?: unknown; label?: unknown }) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    const code = requireText(payload?.code, "Le numéro de compte", 20).replace(/\s+/g, "");
    const label = requireText(payload?.label, "Le libellé du compte", 160);
    if (!/^514\d{3,}$/.test(code)) throw new Error("Utilisez un numéro de compte bancaire commençant par 514 et comportant au moins 6 chiffres.");
    return prisma.$transaction(async (tx) => {
      const bankAccount = await tx.bankAccount.findUnique({ where: { id: bankAccountId } });
      if (!bankAccount || bankAccount.companyId !== companyId) throw new Error("Le compte bancaire n'appartient pas à cette société.");
      if (bankAccount.ledgerAccountId) throw new Error("Ce compte bancaire possède déjà un compte comptable associé.");
      const duplicate = await tx.account.findUnique({ where: { companyId_code: { companyId, code } } });
      if (duplicate) throw new Error("Ce numéro existe déjà dans le plan comptable. Sélectionnez-le dans la liste ou choisissez un autre sous-compte.");
      const account = await tx.account.create({ data: { companyId, code, label, classNo: 5, type: "ASSET", active: true } });
      const updated = await tx.bankAccount.update({ where: { id: bankAccountId }, data: { ledgerAccountId: account.id }, include: { ledgerAccount: true } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "CREATE_AND_MAP_BANK_LEDGER_ACCOUNT",
        entity: "BankAccount",
        entityId: bankAccountId,
        description: `${code} ${label} créé et associé à ${bankAccount.bankName}`,
        details: { ledgerAccountId: account.id, code },
      });
      return serialize(updated);
    });
  });

  ipcMain.handle("wheat:workspace:reset", async (event, payload: { mode: "blank" | "demo" }) => {
    if (!payload || (payload.mode !== "blank" && payload.mode !== "demo")) throw new Error("Le mode de réinitialisation est invalide.");
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const invokingWindow = BrowserWindow.fromWebContents(event.sender);

    try {
      return await runExclusiveMaintenance("réinitialisation de l'espace", async () => {
        if (payload.mode === "demo") {
          const currentPrisma = await getPrisma(app);
          const security = await currentPrisma.localAppSecurity.findUnique({ where: { id: "local" } });
          await disconnectPrisma();
          if (restoreBundledSeed(app)) {
            if (security) {
              const restoredPrisma = await getPrisma(app);
              const securityData = {
                enabled: security.enabled,
                pinSalt: security.pinSalt,
                pinHash: security.pinHash,
                pinKeyLength: security.pinKeyLength,
                idleMinutes: security.idleMinutes,
                lockOnStartup: security.lockOnStartup,
                failedAttempts: security.failedAttempts,
                lockedUntil: security.lockedUntil,
              };
              await restoredPrisma.localAppSecurity.upsert({
                where: { id: "local" },
                create: { id: "local", ...securityData },
                update: securityData,
              });
            }
            startupDatabaseError = null;
            const restoredPrisma = await getPrisma(app);
            trustedActorUserId = (await restoredPrisma.user.findFirst({ select: { id: true } }))?.id ?? null;
            return { ok: true, mode: "demo" };
          }
        }

        const prisma = await getPrisma(app);
        await clearWorkspace(prisma);
        const resetUser = await ensureDefaultUser(prisma);
        trustedActorUserId = resetUser.id;

        if (payload.mode === "demo") {
          await createStarterCompany(prisma, {
            name: "SOCIETE DEMO SARL",
            legalForm: "SARL",
            ice: "001589742000063",
            taxId: "IF 48291073",
            city: "Casablanca",
          });
        }

        return { ok: true, mode: payload.mode };
      });
    } finally {
      if (invokingWindow && !invokingWindow.isDestroyed()) {
        if (invokingWindow.isMinimized()) invokingWindow.restore();
        invokingWindow.show();
        invokingWindow.focus();
      }
    }
  });

  ipcMain.handle("wheat:entry:create", async (_event, payload) => {
    if (!entryCommandService) throw new Error("Le service des écritures n'est pas encore disponible.");
    return serialize(await entryCommandService.createEntry(payload));
  });

  ipcMain.handle("wheat:piece-number:preview", async (_event, payload: Record<string, unknown>) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const journalId = requireId(payload?.journalId, "Le journal");
    const date = parseAccountingDate(payload?.date, "La date de l'écriture");
    return serialize(await previewNextPieceNumber(prisma, companyId, journalId, date));
  });

  ipcMain.handle("wheat:entry:post", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const target = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!target || !entryCommandService) throw new Error("L'écriture demandée n'existe plus.");
    return serialize(await entryCommandService.postEntry({ companyId: target.companyId, entryId: id }));
  });

  ipcMain.handle("wheat:entry:duplicate", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const source = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!source || !entryCommandService) throw new Error("L'écriture à dupliquer n'existe plus.");
    const duplicate = await entryCommandService.duplicateEntry({ companyId: source.companyId, entryId: id });
    return serialize({ ok: true, number: duplicate.number, entry: duplicate });
  });

  ipcMain.handle("wheat:entry:reverse", async (_event, entryIdOrPayload: string | { entryId?: string; date?: string }, requestedDate?: string) => {
    const input = typeof entryIdOrPayload === "string" ? { entryId: entryIdOrPayload, date: requestedDate } : entryIdOrPayload;
    const entryId = requireId(input?.entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const source = await prisma.entry.findUnique({ where: { id: entryId }, select: { companyId: true } });
    if (!source || !entryCommandService) throw new Error("L'écriture à extourner n'existe plus.");
    const reversal = await entryCommandService.reverseEntry({ companyId: source.companyId, entryId, date: input?.date });
    return serialize({ ok: true, number: reversal.number, entry: reversal });
  });

  ipcMain.handle("wheat:entry:delete", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const target = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!target || !entryCommandService) throw new Error("L'écriture à supprimer n'existe plus.");
    return serialize(await entryCommandService.deleteDraftEntry({ companyId: target.companyId, entryId: id }));
  });

  ipcMain.handle("wheat:fiscal-period:lock", async (_event, payload: { companyId?: string; fiscalYearId?: string; lockedTo?: string }) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de verrouillage sont invalides.");
    const companyId = requireId(payload.companyId, "La société");
    const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
    const lockedTo = parseIsoDay(payload.lockedTo, "La date de verrouillage");
    const prisma = await getAuthorizedPrisma();
    const result = await prisma.$transaction(async (tx) => {
      const fiscalYear = await tx.fiscalYear.findUnique({ where: { id: fiscalYearId } });
      if (!fiscalYear || fiscalYear.companyId !== companyId) throw new Error("L'exercice n'appartient pas à la société sélectionnée.");
      if (fiscalYear.status !== "OPEN") throw new Error("Un exercice clôturé ne peut pas être verrouillé ou déverrouillé.");
      if (lockedTo < fiscalYear.startsOn || lockedTo > fiscalYear.endsOn) throw new Error("La date de verrouillage doit se situer dans l'exercice.");
      if (fiscalYear.lockedTo && lockedTo < fiscalYear.lockedTo) {
        throw new Error("Utilisez d'abord le déverrouillage explicite pour réduire la période verrouillée.");
      }
      if (fiscalYear.lockedTo?.getTime() === lockedTo.getTime()) throw new Error("La période est déjà verrouillée à cette date.");
      const updated = await tx.fiscalYear.update({ where: { id: fiscalYear.id }, data: { lockedTo } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "LOCK_FISCAL_PERIOD",
        entity: "FiscalYear",
        entityId: fiscalYearId,
        description: `${fiscalYear.label} verrouillé jusqu'au ${payload.lockedTo} inclus`,
        details: { lockedTo: payload.lockedTo },
      });
      return updated;
    });
    return serialize(result);
  });

  ipcMain.handle("wheat:fiscal-period:unlock", async (_event, payload: { companyId?: string; fiscalYearId?: string }) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de déverrouillage sont invalides.");
    const companyId = requireId(payload.companyId, "La société");
    const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
    const prisma = await getAuthorizedPrisma();
    const result = await prisma.$transaction(async (tx) => {
      const fiscalYear = await tx.fiscalYear.findUnique({ where: { id: fiscalYearId } });
      if (!fiscalYear || fiscalYear.companyId !== companyId) throw new Error("L'exercice n'appartient pas à la société sélectionnée.");
      if (fiscalYear.status !== "OPEN") throw new Error("Un exercice clôturé ne peut pas être déverrouillé.");
      if (!fiscalYear.lockedTo) throw new Error("Aucune période n'est actuellement verrouillée pour cet exercice.");
      const previousDate = fiscalYear.lockedTo.toISOString().slice(0, 10);
      const updated = await tx.fiscalYear.update({ where: { id: fiscalYear.id }, data: { lockedTo: null } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "UNLOCK_FISCAL_PERIOD",
        entity: "FiscalYear",
        entityId: fiscalYearId,
        description: `${fiscalYear.label} déverrouillé (ancien verrou : ${previousDate})`,
        details: { previousLockedTo: previousDate },
      });
      return updated;
    });
    return serialize(result);
  });

  ipcMain.handle("wheat:document:create-invoice-draft", async (_event, documentId: string, kind?: "SALE" | "PURCHASE") => createInvoiceDraftFromDocument(null, documentId, { forcedKind: kind ?? null }));
  ipcMain.handle("wheat:invoice:reclassify-draft", async (_event, payload: { invoiceId?: string; documentId?: string; kind: "SALE" | "PURCHASE" }) => reclassifyInvoiceDraft(null, payload));

  ipcMain.handle("wheat:payroll:post", async (_event, companyIdOrPayload: string | { companyId?: string; period?: string }, requestedPeriod?: string) => {
    const input = typeof companyIdOrPayload === "string"
      ? { companyId: companyIdOrPayload, period: requestedPeriod }
      : companyIdOrPayload;
    const companyId = requireId(input?.companyId, "La société");
    const { period, endDate } = parsePayrollPeriod(input?.period ?? currentPayrollPeriod());
    const prisma = await getAuthorizedPrisma();
    try {
      const created = await prisma.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new Error("La société sélectionnée n'existe plus.");
      const priorRun = await tx.payrollRun.findUnique({ where: { companyId_period: { companyId, period } } });
      if (priorRun) throw new Error(`La paie ${period} a déjà été générée.`);
      const employees = await tx.employee.findMany({ where: { companyId } });
      if (!employees.length) throw new Error("Aucun salarié n'est enregistré pour cette société.");

      for (const employee of employees) {
        const calculatedGross = employee.netSalaryCents + employee.cnssEmployeeCents + employee.amoEmployeeCents + employee.irCents;
        if (calculatedGross !== employee.grossSalaryCents) {
          throw new Error(`La fiche de ${employee.fullName} est déséquilibrée. Corrigez les retenues ou le salaire net avant de générer la paie.`);
        }
      }

      const grossCents = employees.reduce((sum, employee) => sum + employee.grossSalaryCents, 0n);
      const cnssAmoCents = employees.reduce((sum, employee) => sum + employee.cnssEmployeeCents + employee.amoEmployeeCents, 0n);
      const irCents = employees.reduce((sum, employee) => sum + employee.irCents, 0n);
      const netCents = employees.reduce((sum, employee) => sum + employee.netSalaryCents, 0n);
      const payrollRun = await tx.payrollRun.create({
        data: {
          companyId,
          period,
          status: ENTRY_STATUS.draft,
          lines: {
            create: employees.map((employee) => ({
              employeeId: employee.id,
              employeeName: employee.fullName,
              cin: employee.cin,
              cnss: employee.cnss,
              position: employee.position,
              grossSalaryCents: employee.grossSalaryCents,
              cnssEmployeeCents: employee.cnssEmployeeCents,
              amoEmployeeCents: employee.amoEmployeeCents,
              irCents: employee.irCents,
              netSalaryCents: employee.netSalaryCents,
            })),
          },
        },
      });

      const [journal, payrollExpense, staffPayable, socialPayable, taxPayable] = await Promise.all([
        tx.journal.findFirstOrThrow({ where: { companyId, code: "PA", active: true, locked: false } }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "617100" } },
          update: {},
          create: { companyId, code: "617100", label: "Rémunérations du personnel", classNo: 6, type: "EXPENSE" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "443200" } },
          update: {},
          create: { companyId, code: "443200", label: "Personnel - rémunérations dues", classNo: 4, type: "LIABILITY" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "444100" } },
          update: {},
          create: { companyId, code: "444100", label: "CNSS et AMO à payer", classNo: 4, type: "LIABILITY" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "445250" } },
          update: {},
          create: { companyId, code: "445250", label: "Etat - IR salarial", classNo: 4, type: "LIABILITY" },
        }),
      ]);

      const piece = await allocatePieceNumber(tx, { companyId, journalId: journal.id, date: endDate, source: "PAYROLL" });

      const draft = await tx.entry.create({
        data: {
          companyId,
          journalId: journal.id,
          journalCodeSnapshot: journal.code,
          number: provisionalEntryNumber(),
          date: endDate,
          ...piece,
          label: `Paie ${period}`,
          status: ENTRY_STATUS.draft,
          source: "PAYROLL",
          auditNote: `Paie ${period} générée pour ${employees.length} salarié(s)`,
          lines: {
            create: [
              { accountId: payrollExpense.id, accountCodeSnapshot: payrollExpense.code, accountLabelSnapshot: payrollExpense.label, label: `Salaires bruts ${period}`, debitCents: grossCents, creditCents: 0n },
              { accountId: staffPayable.id, accountCodeSnapshot: staffPayable.code, accountLabelSnapshot: staffPayable.label, label: "Net à payer", debitCents: 0n, creditCents: netCents },
              ...(cnssAmoCents > 0n ? [{ accountId: socialPayable.id, accountCodeSnapshot: socialPayable.code, accountLabelSnapshot: socialPayable.label, label: "CNSS/AMO salarié", debitCents: 0n, creditCents: cnssAmoCents }] : []),
              ...(irCents > 0n ? [{ accountId: taxPayable.id, accountCodeSnapshot: taxPayable.code, accountLabelSnapshot: taxPayable.label, label: "IR salarial", debitCents: 0n, creditCents: irCents }] : []),
            ].map((line, index) => ({ ...line, position: index + 1 })),
          },
        },
      });

      const entry = await postDraftEntryInTransaction(tx, draft.id, companyId);
      await tx.payrollRun.update({
        where: { id: payrollRun.id },
        data: { status: ENTRY_STATUS.posted, postedEntryId: entry.id, postedAt: new Date() },
      });
      await appendTrustedAudit(tx, {
        companyId,
        action: "POST_PAYROLL",
        entity: "PayrollRun",
        entityId: payrollRun.id,
        description: `${entry.number} générée pour la paie ${period}`,
        details: { entryId: entry.id, period, employeeCount: employees.length },
      });

      return entry;
    });

      return serialize(created);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new Error(`La paie ${period} a déjà été générée.`, { cause: error });
      }
      throw error;
    }
  });

  ipcMain.handle("wheat:employee:save", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données du salarié sont invalides.");
    const input = payload as Record<string, unknown>;
    const companyId = requireId(input.companyId, "La société");
    const id = input.id ? requireId(input.id, "Le salarié") : null;
    const fullName = requireText(input.fullName, "Le nom du salarié", 160);
    const cin = requireText(input.cin, "Le CIN", 40);
    const cnss = requireText(input.cnss, "Le numéro CNSS", 40);
    const position = requireText(input.position, "Le poste", 120);
    const grossSalaryCents = madToCents(input.grossSalary, "Le salaire brut");
    const cnssEmployeeCents = madToCents(input.cnssEmployee, "La retenue CNSS");
    const amoEmployeeCents = madToCents(input.amoEmployee, "La retenue AMO");
    const irCents = madToCents(input.ir, "La retenue IR");
    const netSalaryCents = madToCents(input.netSalary, "Le salaire net");
    const amounts = [grossSalaryCents, cnssEmployeeCents, amoEmployeeCents, irCents, netSalaryCents];
    if (amounts.some((amount) => amount < 0n)) throw new Error("Les montants de paie ne peuvent pas être négatifs.");
    if (netSalaryCents + cnssEmployeeCents + amoEmployeeCents + irCents !== grossSalaryCents) {
      throw new Error("Le salaire brut doit être égal au net plus les retenues CNSS, AMO et IR.");
    }

    const prisma = await getAuthorizedPrisma();
    const employee = await prisma.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new Error("La société sélectionnée n'existe plus.");
      if (id) {
        const existing = await tx.employee.findUnique({ where: { id }, select: { companyId: true } });
        if (!existing || existing.companyId !== companyId) throw new Error("Le salarié à modifier n'existe plus dans cette société.");
      }
      const data = {
        companyId,
        fullName,
        cin,
        cnss,
        position,
        grossSalaryCents,
        cnssEmployeeCents,
        amoEmployeeCents,
        irCents,
        netSalaryCents,
      };
      const saved = id
        ? await tx.employee.update({ where: { id }, data })
        : await tx.employee.create({ data });
      await appendTrustedAudit(tx, {
        companyId,
        action: id ? "UPDATE_EMPLOYEE" : "CREATE_EMPLOYEE",
        entity: "Employee",
        entityId: saved.id,
        description: `${fullName} ${id ? "mis à jour" : "ajouté"} dans la paie`,
        details: { position, grossSalaryCents, netSalaryCents },
      });
      return saved;
    });

    return serialize(employee);
  });

  ipcMain.handle("wheat:employee:delete", async (_event, employeeId: string) => {
    const prisma = await getAuthorizedPrisma();
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });

    await prisma.$transaction(async (tx) => {
      await tx.employee.delete({ where: { id: employeeId } });
      await appendTrustedAudit(tx, {
        companyId: employee.companyId,
        action: "DELETE_EMPLOYEE",
        entity: "Employee",
        entityId: employee.id,
        description: `${employee.fullName} supprimé de la paie`,
        details: { cin: employee.cin, cnss: employee.cnss },
      });
    });

    return serialize({ ok: true, id: employeeId, name: employee.fullName });
  });

  /**
   * Recognises everything the user offered, not merely the first file.
   *
   * Import used to run `selectImportFile`, which returns one path: dropping a
   * folder of thirty purchase invoices produced one document and no explanation
   * for the other twenty-nine. This accepts a whole selection — files, folders,
   * or both — recognises them with the pool, and reports what it refused.
   */
  const smartOcrImport = async (companyId: string, providedPaths?: string[], sender?: Electron.WebContents) => {
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    let filePaths = providedPaths?.length ? providedPaths : [];

    if (!filePaths.length) {
      const selection = await dialog.showOpenDialog({
        title: "Wheat - importer des pièces",
        properties: ["openFile", "multiSelections"],
        filters: importDialogFilters(),
      });

      if (selection.canceled) return { documents: [], rejections: [], truncated: false };
      filePaths = selection.filePaths;
    }

    const selection = selectImportFiles(filePaths);
    if (!selection.accepted.length) {
      // A selection that produced nothing usable must say why. Answering with
      // an empty list made "that format is not supported" indistinguishable
      // from "you cancelled".
      if (selection.rejections.length) throw new Error(selection.rejections.map((rejection) => rejection.reason).join(" "));
      return { documents: [], rejections: [], truncated: selection.truncated };
    }

    const existingDocuments = await prisma.document.findMany({
      where: { companyId },
      select: { id: true, title: true, type: true, extracted: true },
    });
    const processed = await processSmartOcrFiles(app, {
      companyId,
      companyName: company.name,
      filePaths: selection.accepted,
      existingDocuments,
      // The dossier's own identifiers are what tell a purchase invoice from a
      // sales invoice, and which of the two ICE numbers on the page belongs to
      // the counterparty.
      company: { name: company.name, ice: company.ice, taxId: company.taxId },
      aiReview: buildDocumentAiReviewer(),
      onProgress: (event) => {
        if (sender && !sender.isDestroyed()) sender.send(SMART_OCR_PROGRESS_CHANNEL, { companyId, ...event });
      },
    });

    const { createHash } = await import("node:crypto");
    const preparedDocuments = processed.map((doc) => {
      const storedBytes = fs.readFileSync(doc.storedPath);
      const contentSha256 = createHash("sha256").update(storedBytes).digest("hex");
      return {
        data: {
          companyId,
          title: doc.title,
          type: doc.type,
          fiscalYear: doc.fiscalYear,
          tags: doc.tags,
          storedPath: doc.storedPath,
          contentSha256,
          mimeType: mimeTypeForManagedDocument(doc.storedPath),
          byteSize: BigInt(storedBytes.length),
          ocrText: doc.ocrText,
          // Recognition is the first revision of a reviewable reading, not a
          // finished answer. The payload records which reading this is, what
          // it was read from, and — from here on — what anybody corrects.
          extracted: JSON.stringify(prepareDocumentReview(doc.extracted as Record<string, unknown>, {
            documentType: doc.type,
            sourceFingerprint: contentSha256,
          })),
          status: doc.status,
        },
      };
    });
    const created = await prisma.$transaction(async (tx) => {
      const documents: Array<{ id: string } & Record<string, unknown>> = [];
      for (const prepared of preparedDocuments) {
        documents.push(await tx.document.create({ data: prepared.data }));
      }
      await appendTrustedAudit(tx, {
        companyId,
        action: "SMART_OCR_IMPORT",
        entity: "Document",
        description: `${documents.length} document(s) traités par l'organiseur OCR`,
        details: {
          documents: documents.map((document, index) => ({
            id: document.id,
            sha256: preparedDocuments[index].data.contentSha256,
            title: preparedDocuments[index].data.title,
          })),
        },
      });
      return documents;
    });

    return serialize({ documents: created, rejections: selection.rejections, truncated: selection.truncated });
  };

  ipcMain.handle("wheat:documents:upload", async (event, companyId: string) => smartOcrImport(companyId, undefined, event.sender));

  /**
   * Several documents at once, or a whole folder of them.
   *
   * The single-file picker stays below for the screens that genuinely want one
   * file; a month of purchase invoices is not one of them.
   */
  ipcMain.handle("wheat:documents:select-files", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Wheat - choisir des pièces",
      properties: ["openFile", "multiSelections"],
      filters: importDialogFilters(),
    });
    if (selection.canceled) return { accepted: [], rejections: [], truncated: false };
    return serialize(selectImportFiles(selection.filePaths));
  });

  /** Same, for a folder: Windows cannot offer files and folders in one dialog. */
  ipcMain.handle("wheat:documents:select-folder", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Wheat - choisir un dossier de pièces",
      properties: ["openDirectory"],
    });
    if (selection.canceled) return { accepted: [], rejections: [], truncated: false };
    return serialize(selectImportFiles(selection.filePaths));
  });

  /**
   * One page of a managed document, as an image, so the source can sit beside
   * the values Wheat read from it.
   *
   * A read and only a read: it renders the file, never the extraction, so
   * paging and zooming cannot re-run recognition or disturb a correction in
   * progress. The document is resolved through the dossier, so a path cannot be
   * supplied from the renderer and a document from another dossier is refused.
   */
  ipcMain.handle("wheat:document:page-preview", async (_event, payload: Record<string, unknown>) => {
    const documentId = requireId(payload?.documentId, "Le document");
    const prisma = await getAuthorizedPrisma();
    const document = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, companyId: true, storedPath: true } });
    if (!document) throw new Error("Le document demandé n'existe plus.");
    if (typeof payload?.companyId === "string" && payload.companyId && document.companyId !== payload.companyId) {
      throw new Error("Le document appartient à un autre dossier.");
    }
    if (!document.storedPath) {
      return { page: 1, pageCount: 0, mimeType: "", base64: "", rendered: false, reason: "Aucun fichier n'est conservé pour cette pièce." };
    }
    return renderDocumentPage({
      storedPath: document.storedPath,
      page: Number(payload?.page ?? 1),
      scale: Number(payload?.scale ?? 1.5),
      app,
    });
  });

  ipcMain.handle("wheat:documents:select-file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Smart OCR Organizer - choisir un document",
      properties: ["openFile"],
      filters: importDialogFilters(),
    });

    if (selection.canceled) return null;
    return pickSingleImportFile(selection.filePaths)[0] ?? null;
  });

  ipcMain.handle("wheat:smart-ocr:process", async (event, payload: { companyId: string; filePaths?: string[] }) => smartOcrImport(payload.companyId, payload.filePaths, event.sender));
  ipcMain.handle("wheat:paddle-ocr:status", async () => serialize(await getPaddleOcrStatus(app)));

  ipcMain.handle("wheat:document:update-extraction", async (_event, payload: { documentId: string; type?: string; fields?: Record<string, unknown>; tags?: string }) => updateDocumentExtraction(null, payload));

  ipcMain.handle("wheat:document:delete", async (_event, documentId: string) => {
    const prisma = await getAuthorizedPrisma();
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    if (document.invoiceId || document.paymentId || document.entryId) {
      throw new Error("Ce document est lié à un brouillon, une facture, un paiement ou une écriture. Supprimez d'abord le brouillon lié ; les pièces comptabilisées restent conservées comme preuve.");
    }
    const storedPath = document.storedPath;
    let storedFileDeleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.document.delete({ where: { id: documentId } });
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "DELETE_DOCUMENT",
        entity: "Document",
        entityId: document.id,
        description: `${document.title} supprimé de l'organiseur de documents`,
        details: { contentSha256: document.contentSha256, byteSize: document.byteSize },
      });
    });

    if (storedPath) {
      // The rendered pages of a file that is gone must not outlive it.
      forgetDocumentPagePreviews(storedPath);
      storedFileDeleted = await trashStoredDocumentFile(app, storedPath);
    }

    return serialize({ ok: true, id: documentId, storedFileDeleted });
  });

  ipcMain.handle("wheat:import:file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Importer Excel ou CSV",
      properties: ["openFile"],
      filters: [{ name: "Excel / CSV", extensions: ["xlsx", "xls", "csv"] }],
    });

    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    return {
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytesBase64: fs.readFileSync(filePath).toString("base64"),
    };
  });

  ipcMain.handle("wheat:bank:statement:select-file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Sélectionner un relevé bancaire",
      properties: ["openFile"],
      filters: [
        { name: "Relevés bancaires", extensions: ["csv", "txt", "xlsx", "xls", "ofx", "qif", "sta", "mt940", "xml", "pdf", "png", "jpg", "jpeg", "tif", "tiff"] },
        { name: "Tous les fichiers", extensions: ["*"] },
      ],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    return {
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytesBase64: fs.readFileSync(filePath).toString("base64"),
    };
  });

  ipcMain.handle("wheat:bank:statement:parse", async (_event, payload: Record<string, unknown>) => {
    return serialize(await parseBankStatement({
      sourceName: requireText(payload?.sourceName, "Le nom du relevé", 250),
      bytesBase64: requireText(payload?.bytesBase64, "Le contenu du relevé", 40_000_000),
      mimeType: typeof payload?.mimeType === "string" ? payload.mimeType : undefined,
      app,
      // The same reviewer the document pipeline uses: the same provider, the
      // same consent, the same anti-invention gate. Absent unless the user has
      // enabled assisted reading and chosen a model.
      aiFallback: buildDocumentAiReviewer(),
    }));
  });

  ipcMain.handle("wheat:bank:statement:prepare", async (_event, payload: Record<string, unknown>) => {
    const prisma = await getAuthorizedPrisma();
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    // The dossier the accountant is working in, when the caller knows it. A
    // statement is filed under the bank account's own dossier either way; this
    // catches the case where the two disagree instead of quietly filing a
    // statement into a dossier nobody is looking at.
    const expectedCompanyId = payload?.companyId === undefined || payload?.companyId === null || payload?.companyId === ""
      ? null
      : requireId(payload.companyId, "La société");
    const sourceName = path.basename(requireText(payload?.sourceName, "Le nom du relevé", 250));
    const sourceSha256 = requireText(payload?.sourceSha256, "L'empreinte du relevé", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("L'empreinte SHA-256 du relevé est invalide.");
    const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
    if (!bankAccount) throw new Error("Le compte bancaire n'existe plus.");
    if (expectedCompanyId && bankAccount.companyId !== expectedCompanyId) {
      throw new Error("Ce compte bancaire appartient à un autre dossier. Changez de dossier avant d'importer ce relevé.");
    }
    if (!bankAccount.active) throw new Error("Restaurez ce compte bancaire archivé avant d'importer un relevé.");
    const bytesBase64 = requireText(payload?.sourceBytesBase64, "Le contenu du relevé", 40_000_000);
    const bytes = Buffer.from(bytesBase64, "base64");
    if (!bytes.length || bytes.length > 25_000_000) throw new Error("Le relevé est vide ou dépasse 25 Mo.");
    const calculated = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if (calculated !== sourceSha256) throw new Error("Le contenu du relevé ne correspond pas à son empreinte SHA-256.");
    const safeName = sourceName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "statement";
    const statementDir = path.join(managedDocumentsRoot(app), bankAccount.companyId, "bank-statements");
    fs.mkdirSync(statementDir, { recursive: true });
    const storedPath = path.join(statementDir, `${sourceSha256}-${safeName}`);
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, bytes, { flag: "wx" });
    const { sourceBytesBase64: _discarded, ...prepared } = payload;
    void _discarded;
    return { ...prepared, sourceStoredPath: storedPath };
  });

  ipcMain.handle("wheat:export:file", async (_event, payload: { suggestedName: string; bytesBase64: string; filters: Electron.FileFilter[] }) => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const result = await dialog.showSaveDialog({
      title: "Exporter depuis Wheat",
      defaultPath: payload.suggestedName,
      filters: payload.filters,
    });

    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, Buffer.from(payload.bytesBase64, "base64"));
    return result.filePath;
  });

  ipcMain.handle("wheat:backup:create", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const result = await dialog.showSaveDialog({
      title: "Créer une sauvegarde complète Wheat",
      defaultPath: `wheat-${new Date().toISOString().slice(0, 10)}.wheatbackup`,
      filters: [{ name: "Sauvegarde complète Wheat", extensions: ["wheatbackup", "atlasbackup"] }],
    });

    if (result.canceled || !result.filePath) return null;
    const livePath = path.resolve(resolveDatabasePath(app));
    const requestedPath = path.resolve(result.filePath);
    const targetPath = /\.(wheat|atlas)backup$/i.test(requestedPath)
      ? requestedPath
      : `${requestedPath}.wheatbackup`;
    if (targetPath === livePath) throw new Error("La sauvegarde doit être enregistrée dans un fichier différent de la base active.");
    return runExclusiveMaintenance("création de la sauvegarde", async () => {
      try {
        if (!fs.existsSync(livePath)) throw new Error("La base active est introuvable ; aucune sauvegarde n'a été créée.");
        return await createFullWheatBackup(targetPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`La sauvegarde complète n'a pas pu être créée. Aucun fichier existant n'a été remplacé. ${message}`, { cause: error });
      }
    });
  });

  ipcMain.handle("wheat:database:path", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    return resolveDatabasePath(app);
  });

  ipcMain.handle("wheat:backup:restore", async () => {
    let recoveryRestoreAllowed = Boolean(startupDatabaseError);
    if (localSecurity) {
      try {
        const securityStatus = await localSecurity.status();
        recoveryRestoreAllowed ||= securityStatus.configurationError;
      } catch {
        recoveryRestoreAllowed ||= Boolean(startupDatabaseError);
      }
      if (!recoveryRestoreAllowed) {
        await localSecurity.assertUnlocked();
        await localSecurity.touch();
      }
    }
    const result = await dialog.showOpenDialog({
      title: "Restaurer une sauvegarde Wheat",
      properties: ["openFile"],
      filters: [
        { name: "Sauvegarde complète Wheat", extensions: ["wheatbackup", "atlasbackup"] },
        { name: "Ancienne sauvegarde SQLite", extensions: ["sqlite", "db"] },
      ],
    });

    if (result.canceled || !result.filePaths[0]) return null;
    const sourcePath = path.resolve(result.filePaths[0]);
    const livePath = path.resolve(resolveDatabasePath(app));
    if (sourcePath === livePath) throw new Error("Sélectionnez une sauvegarde différente de la base active.");
    const isFullArchive = /\.(wheat|atlas)backup$/i.test(sourcePath);

    return runExclusiveMaintenance("restauration de la sauvegarde", async () => {

    if (!isFullArchive) {
      validateSqliteBackup(sourcePath);
      const backupDir = path.join(path.dirname(livePath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const rollbackPath = path.join(backupDir, `wheat-${timestampForBackup()}-before-legacy-restore.sqlite`);
      const stagingPath = path.join(path.dirname(livePath), `.wheat-restore-${process.pid}-${Date.now()}.sqlite`);
      const previousPath = path.join(path.dirname(livePath), `.wheat-previous-${process.pid}-${Date.now()}.sqlite`);
      const hadLiveDatabase = fs.existsSync(livePath);
      let databaseDetached = false;
      let replacementDone = false;

      try {
        await disconnectPrisma();
        databaseDetached = true;
        checkpointWheatDatabase(livePath);
        if (fs.existsSync(livePath)) fs.copyFileSync(livePath, rollbackPath, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
        migrateAndValidateDatabase(stagingPath);
        if (fs.existsSync(livePath)) fs.renameSync(livePath, previousPath);
        fs.renameSync(stagingPath, livePath);
        replacementDone = true;
        safeUnlink(`${livePath}-wal`);
        safeUnlink(`${livePath}-shm`);
        await reopenDatabaseAndResetSession();
      } catch (error) {
        let rollbackError: unknown | null = null;
        if (databaseDetached) {
          try {
            await rollbackDatabaseReplacement(
              { livePath, previousPath, replacementDone, hadLiveDatabase },
              {
                disconnect: disconnectPrisma,
                reopenAndReset: reopenDatabaseAndResetSession,
                onCleanupError: writeMainProcessError,
              },
            );
          } catch (caughtRollbackError) {
            rollbackError = caughtRollbackError;
            startupDatabaseError = caughtRollbackError instanceof Error
              ? caughtRollbackError
              : new Error(String(caughtRollbackError));
          }
        }

        if (!rollbackError) {
          bestEffortRestoreCleanup("fichier SQLite de préparation", () => safeUnlink(stagingPath));
        }
        if (!databaseDetached) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`La restauration a été annulée avant toute modification de la base active. ${message}`, { cause: error });
        }
        throw restoreFailure("La restauration SQLite a échoué.", error, rollbackError, livePath, previousPath);
      }

      // The restore is committed once the replacement database has been
      // validated, Prisma reopened and the lock/session state reset. Cleanup is
      // deliberately best-effort and can no longer send execution to rollback.
      bestEffortRestoreCleanup("copie SQLite précédente", () => safeUnlink(previousPath));
      bestEffortRestoreCleanup("fichier SQLite de préparation", () => safeUnlink(stagingPath));
      return livePath;
    }

    const userDataDir = resolveWheatUserDataDir(app);
    const documentsRoot = managedDocumentsRoot(app);
    const restoredParent = path.join(documentsRoot, "restored");
    const backupDir = path.join(userDataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const previousPath = path.join(userDataDir, `.wheat-previous-${process.pid}-${Date.now()}.sqlite`);
    const hadLiveDatabase = fs.existsSync(livePath);
    let staged: Awaited<ReturnType<typeof extractWheatBackupToStaging>> | null = null;
    let restoredAttachmentsRoot: string | null = null;
    let databaseDetached = false;
    let replacementDone = false;

    try {
      staged = await extractWheatBackupToStaging({ archivePath: sourcePath, stagingParentDirectory: userDataDir });
      migrateAndValidateDatabase(staged.databasePath);

      const attachmentFiles = staged.manifest.files.filter((file) => file.kind === "attachment");
      const prospectiveRestoredAttachmentsRoot = path.join(
        restoredParent,
        `restore-${timestampForBackup()}-${staged.manifest.backupId}`,
      );
      if (attachmentFiles.length) {
        restoredAttachmentsRoot = prospectiveRestoredAttachmentsRoot;
        rewriteRestoredDocumentPaths(staged.databasePath, attachmentFiles, restoredAttachmentsRoot);
      }
      validateWheatSqliteDatabase(staged.databasePath);
      const restoredProvenance = verifyManagedFileProvenance({
        databasePath: staged.databasePath,
        storedPathsRoot: prospectiveRestoredAttachmentsRoot,
        physicalFilesRoot: staged.attachmentsDirectory,
      });
      assertManagedFileSetMatchesArchive(
        restoredProvenance.relativePaths,
        attachmentFiles.map((file) => file.path.slice("attachments/".length)),
      );

      await disconnectPrisma();
      databaseDetached = true;
      if (fs.existsSync(livePath)) {
        const rollbackArchive = path.join(backupDir, `wheat-${timestampForBackup()}-before-restore.wheatbackup`);
        try {
          await createFullWheatBackup(rollbackArchive);
        } catch (backupError) {
          const emergencyCopy = path.join(backupDir, `wheat-${timestampForBackup()}-before-restore-unverified.sqlite`);
          fs.copyFileSync(livePath, emergencyCopy, fs.constants.COPYFILE_EXCL);
          writeMainProcessError(backupError);
        }
      }

      if (restoredAttachmentsRoot) {
        fs.mkdirSync(restoredParent, { recursive: true });
        if (fs.existsSync(restoredAttachmentsRoot)) throw new Error("Le dossier cible des pièces jointes restaurées existe déjà.");
        fs.renameSync(staged.attachmentsDirectory, restoredAttachmentsRoot);
      }

      if (fs.existsSync(livePath)) fs.renameSync(livePath, previousPath);
      fs.renameSync(staged.databasePath, livePath);
      replacementDone = true;
      safeUnlink(`${livePath}-wal`);
      safeUnlink(`${livePath}-shm`);
      await reopenDatabaseAndResetSession();
    } catch (error) {
      let rollbackError: unknown | null = null;
      if (databaseDetached) {
        try {
          await rollbackDatabaseReplacement(
            { livePath, previousPath, replacementDone, hadLiveDatabase },
            {
              disconnect: disconnectPrisma,
              reopenAndReset: reopenDatabaseAndResetSession,
              onCleanupError: writeMainProcessError,
            },
          );
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
          startupDatabaseError = caughtRollbackError instanceof Error
            ? caughtRollbackError
            : new Error(String(caughtRollbackError));
        }
      }

      // If rollback itself failed after the database was replaced, preserve all
      // restore artifacts: they may be required to recover the database that is
      // still active. Successful/no-file-change failures can be cleaned safely.
      if (!rollbackError) {
        if (restoredAttachmentsRoot && fs.existsSync(restoredAttachmentsRoot)) {
          bestEffortRestoreCleanup("pièces jointes restaurées", () => {
            removePrivateRestoreDirectory(restoredAttachmentsRoot!, restoredParent, "restore-");
          });
        }
        if (staged && fs.existsSync(staged.stagingDirectory)) {
          bestEffortRestoreCleanup("dossier temporaire de restauration", () => {
            removePrivateRestoreDirectory(staged!.stagingDirectory, userDataDir, "wheat-backup-restore-");
          });
        }
      }
      if (!databaseDetached) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`La restauration complète a été annulée avant toute modification de la base active. ${message}`, { cause: error });
      }
      throw restoreFailure("La restauration complète a échoué.", error, rollbackError, livePath, previousPath);
    }

    // Commit precedes cleanup so a locked/undeletable temporary file can never
    // roll back a database that Wheat has already reopened for normal use.
    bestEffortRestoreCleanup("copie SQLite précédente", () => safeUnlink(previousPath));
    if (staged && fs.existsSync(staged.stagingDirectory)) {
      bestEffortRestoreCleanup("dossier temporaire de restauration", () => {
        removePrivateRestoreDirectory(staged!.stagingDirectory, userDataDir, "wheat-backup-restore-");
      });
    }
    return livePath;
    });
  });

  ipcMain.handle("wheat:open-path", async (_event, target: string) => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const requestedPath = path.resolve(requireText(target, "Le chemin", 2048));
    const userDataPath = path.resolve(readWheatEnv("WHEAT_USER_DATA_DIR") || app.getPath("userData"));
    const databasePath = path.resolve(resolveDatabasePath(app));
    const insideUserData = requestedPath === userDataPath || requestedPath.startsWith(`${userDataPath}${path.sep}`);
    const isDatabaseLocation = requestedPath === databasePath || requestedPath === path.dirname(databasePath);
    if (!insideUserData && !isDatabaseLocation) throw new Error("Wheat refuse d'ouvrir un chemin extérieur à son espace de données local.");
    if (!fs.existsSync(requestedPath)) throw new Error("Le chemin demandé n'existe plus.");
    if (requestedPath === databasePath) {
      shell.showItemInFolder(requestedPath);
      return;
    }
    const errorMessage = await shell.openPath(requestedPath);
    if (errorMessage) throw new Error(`Windows n'a pas pu ouvrir ce chemin : ${errorMessage}`);
  });

  ipcMain.handle("wheat:window:control", (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    if (action === "minimize") {
      win.minimize();
      return false;
    }

    if (action === "toggle-maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    }

    if (action === "focus") {
      if (win.isMinimized()) win.restore();
      win.show();
      focusWindowAndContents(win);
      return true;
    }

    if (action === "close") {
      win.close();
      return true;
    }

    return null;
  });

  ipcMain.handle("wheat:app:restart", async () => relaunchWheat());
}

/**
 * Routes Wheat AI's routing decisions to a profile-local log file.
 *
 * Which model was tried, why one was skipped, whether the fallback continued —
 * a developer needs all of it and a user needs none of it, so it lands here
 * instead of in the conversation. The sink writes structured lines carrying
 * model identifiers and failure kinds only: prompts, document text, image bytes
 * and API keys never reach it, and every string is redacted on the way in.
 */
function installWheatAiDiagnostics(logPath: string) {
  const MAX_LOG_BYTES = 2 * 1024 * 1024;
  setWheatAiDiagnosticSink((event) => {
    try {
      // One rotation keeps the file useful without letting it grow forever on
      // a machine that is never cleaned up.
      if ((fs.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
      fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}
`, { encoding: "utf8" });
    } catch {
      // A diagnostics disk problem must never fail a Wheat AI request.
    }
  });
}

/**
 * Builds the optional AI document reviewer, or returns `undefined`.
 *
 * `undefined` is the default and means the OCR pipeline runs entirely locally.
 * A reviewer is returned only when the user has enabled the setting AND named a
 * model. An `ollama:` model keeps the document on this machine; a provider
 * model sends it to that provider, which is what the setting's own wording in
 * Réglages tells the user before they turn it on.
 */
/**
 * Which model, if any, the shared review layer may use — local first.
 *
 * The order is deliberate and never negotiable by the user's wording:
 *
 *  1. a healthy installed local model (Ollama answering, at least one model
 *     listed). Nothing leaves the machine, so nothing has to be consented to;
 *  2. otherwise a configured remote provider, and only with the explicit
 *     consent recorded in the provider preferences;
 *  3. otherwise nothing — and the review says so in words rather than
 *     presenting its deterministic half as an AI reading.
 *
 * The model is chosen automatically. A person keeping books is not asked to
 * compare model identifiers or tiers.
 */
/**
 * The local models Wheat has seen recently, so a review does not re-discover them.
 *
 * `listOllamaModels` is an HTTP round trip to the local daemon, and it was on
 * the critical path of *every* review: on a machine with no Ollama installed it
 * was a connection failure the person waited through before the deterministic
 * result could even be shown. Discovery changes when somebody pulls a model,
 * which is minutes-scale, so a short cache costs nothing real and removes that
 * wait from every review after the first.
 *
 * Deliberately not invalidated on a failure: a machine without the daemon
 * answers "unavailable" quickly from here rather than timing out again.
 */
const OLLAMA_DISCOVERY_TTL_MS = 60_000;
let ollamaDiscoveryCache: { at: number; value: Awaited<ReturnType<typeof listOllamaModels>> } | null = null;

async function discoverOllamaModels() {
  const now = Date.now();
  if (ollamaDiscoveryCache && now - ollamaDiscoveryCache.at < OLLAMA_DISCOVERY_TTL_MS) {
    return ollamaDiscoveryCache.value;
  }
  const value = await listOllamaModels();
  ollamaDiscoveryCache = { at: now, value };
  return value;
}

/**
 * The local models that could actually answer a review, or none.
 *
 * An unreachable Ollama is not an error to report: it is simply a path not
 * taken, and both the explicit-pin check and the automatic ranking want the
 * same list, so they ask the same question here rather than each unwrapping
 * the discovery result their own way.
 */
async function usableLocalModels() {
  try {
    const discovery = await discoverOllamaModels();
    return discovery.available ? discovery.models.filter((model) => model.chatReady) : [];
  } catch {
    return [];
  }
}

/** What the review surface may say about the model *before* the model runs. */
export type WheatReviewModelDescriptor = {
  available: boolean;
  locality: "LOCAL" | "REMOTE" | "NONE";
  provider: string | null;
  modelId: string | null;
  /** How it was chosen: the user's explicit pick, or Wheat's ranking. */
  selection: "EXPLICIT" | "AUTOMATIC" | "NONE";
  /** Free of provider and model identifiers: it is read during bookkeeping. */
  message: string;
  /** The identifiers, for settings, diagnostics and the details disclosure. */
  detail?: string | null;
};

/**
 * Chooses the model that will perform a shared review, and says why.
 *
 * Two rules changed here, and both were user-visible faults.
 *
 * An explicit choice is now honoured wherever it points. The pin was only ever
 * consulted when it named an Ollama model, so a person who picked a remote one
 * in the settings got the automatic local ranking instead and had no way to
 * tell — the surface reported whatever had actually run. A chosen model that is
 * not reachable is now reported as unavailable rather than silently swapped:
 * "the model you picked did not answer" is a fact the reader can act on, and a
 * different model's opinion presented as theirs is not.
 *
 * And discovery is cached, so the local-model probe stops being a fresh network
 * round trip in front of every review.
 */
async function resolveReviewModelSelection(): Promise<{ resolution: WheatReviewModelResolution; descriptor: WheatReviewModelDescriptor }> {
  const unavailable = (
    message: string,
    status: "DECLINED" | "UNAVAILABLE" | "FAILED" = "UNAVAILABLE",
    detail: string | null = null,
  ): { resolution: WheatReviewModelResolution; descriptor: WheatReviewModelDescriptor } => ({
    resolution: { channel: null, status, message, detail },
    descriptor: { available: false, locality: "NONE", provider: null, modelId: null, selection: "NONE", message, detail },
  });

  const preferences = wheatAiProviderService?.getPreferences();
  if (preferences && preferences.assistedReview === false) {
    return unavailable("La relecture assistée est désactivée dans Réglages > Wheat AI. Seuls les contrôles déterministes de Wheat ont été exécutés.", "DECLINED");
  }

  const localChannel = (modelId: string, selection: "EXPLICIT" | "AUTOMATIC") => {
    const modelName = modelId.slice("ollama:".length);
    const message = selection === "EXPLICIT"
      ? "Relecture par le modèle local que vous avez choisi. Rien ne quitte cette machine."
      : "Relecture par un modèle local, choisi automatiquement. Rien ne quitte cette machine.";
    return {
      resolution: {
        channel: { locality: "LOCAL" as const, provider: "OLLAMA", modelId, run: (request: { system: string; user: string }) => runOllamaPlainChat(modelName, request) },
      },
      descriptor: { available: true, locality: "LOCAL" as const, provider: "OLLAMA", modelId, selection, message, detail: `OLLAMA · ${modelName}` },
    };
  };

  const service = wheatAiProviderService;
  const remoteChannel = (modelId: string | null, selection: "EXPLICIT" | "AUTOMATIC") => {
    const message = selection === "EXPLICIT"
      ? "Relecture par le modèle distant que vous avez choisi. Des extraits du dossier lui sont transmis."
      : "Relecture par un modèle distant gratuit, choisi automatiquement parmi les fournisseurs configurés. Des extraits du dossier lui sont transmis.";
    return {
      resolution: {
        channel: {
          locality: "REMOTE" as const,
          provider: "REMOTE",
          modelId: modelId ?? "auto",
          run: async (request: { system: string; user: string }) => {
            const result = await service!.chat({
              messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
              temperature: 0,
              maxTokens: 1024,
              // Only a model the user actually picked is pinned. An explicit
              // null means the reviewer's own automatic mode: the free-model
              // ranking and rotation, never the assistant's pinned model.
              pinnedModelId: modelId ?? null,
            });
            return result.text;
          },
        },
      },
      descriptor: { available: true, locality: "REMOTE" as const, provider: "REMOTE", modelId: modelId ?? "auto", selection, message, detail: `REMOTE · ${modelId ?? "auto"}` },
    };
  };

  const pinned = preferences?.assistedReviewModelId ?? null;

  // --- An explicit choice, honoured where it points ------------------------
  if (pinned?.startsWith("ollama:")) {
    const usable = await usableLocalModels();
    if (usable.some((model) => model.id === pinned)) return localChannel(pinned, "EXPLICIT");
    return unavailable(
      "Le modèle de relecture que vous avez choisi n'est pas disponible : Ollama ne répond pas, ou ce modèle n'y est plus installé. Wheat ne le remplace pas par un autre de sa propre initiative — choisissez-en un autre, ou repassez en mode automatique dans Réglages > Wheat AI.",
      "FAILED",
      `OLLAMA · ${pinned.slice("ollama:".length)}`,
    );
  }
  if (pinned?.startsWith(REMOTE_MODEL_PREFIX) && pinned !== AUTOMATIC_FREE_MODEL_ID) {
    if (!service?.isRemoteAvailable()) {
      return unavailable("Le modèle de relecture que vous avez choisi appartient à un fournisseur qui n'est plus configuré. Ajoutez sa clé, choisissez un autre modèle, ou repassez en mode automatique.", "FAILED", `REMOTE · ${pinned}`);
    }
    if (!preferences?.assistedReviewRemoteConsent) {
      return unavailable("Le modèle de relecture choisi est distant : il recevrait des extraits du dossier. Donnez votre accord explicite dans Réglages > Wheat AI, ou choisissez un modèle local.", "DECLINED");
    }
    return remoteChannel(pinned, "EXPLICIT");
  }

  // --- Automatic: local first, because nothing leaves the machine ----------
  const local = await usableLocalModels();
  if (local.length) {
    // Largest model that still runs comfortably on a workstation, so the
    // choice needs no question and no benchmark screen.
    const automatic = [...local].sort((left, right) => {
      const bounded = (bytes: number) => (bytes > 9 * 1024 ** 3 ? 0 : bytes);
      return bounded(right.bytes) - bounded(left.bytes);
    })[0];
    return localChannel(automatic.id, "AUTOMATIC");
  }

  // --- Automatic, remote: only free models, and only with recorded consent -
  if (service?.isRemoteAvailable()) {
    if (!preferences?.assistedReviewRemoteConsent) {
      return unavailable(
        "Aucun modèle local n'est disponible. Une relecture distante enverrait des extraits du dossier à un fournisseur externe : elle exige votre accord explicite dans Réglages > Wheat AI.",
        "DECLINED",
      );
    }
    return remoteChannel(null, "AUTOMATIC");
  }

  return unavailable(
    "Aucun modèle n'est installé ni configuré : seuls les contrôles déterministes de Wheat ont été exécutés. Vous pouvez installer le modèle local recommandé depuis l'écran Wheat AI, qui indique sa taille de téléchargement avant de commencer.",
  );
}

async function resolveReviewModel(): Promise<WheatReviewModelResolution> {
  return (await resolveReviewModelSelection()).resolution;
}

/**
 * Who will review, asked before the reviewing starts.
 *
 * The surface needs this to name the model while the person waits, which is the
 * difference between "Wheat is working" and "Wheat is not responding". It runs
 * the same selection as the review itself, so what is announced is what runs.
 */
async function describeReviewModel(): Promise<WheatReviewModelDescriptor> {
  try {
    return (await resolveReviewModelSelection()).descriptor;
  } catch (error) {
    return {
      available: false, locality: "NONE", provider: null, modelId: null, selection: "NONE",
      message: "Relecture par Wheat AI indisponible.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDocumentAiReviewer() {
  const preferences = wheatAiProviderService?.getPreferences();
  const modelId = preferences?.documentAiReviewModelId;
  if (!preferences?.documentAiReview || !modelId) return undefined;

  if (modelId.startsWith("ollama:")) {
    const modelName = modelId.slice("ollama:".length);
    return async (request: { system: string; user: string; images?: Array<{ mimeType: string; base64: string }> }) => ({
      text: await runOllamaPlainChat(modelName, request),
      provider: "OLLAMA",
      modelId,
    });
  }

  const service = wheatAiProviderService;
  if (!service?.isRemoteAvailable()) return undefined;
  return async (request: { system: string; user: string; images?: Array<{ mimeType: string; base64: string }> }) => {
    const result = await service.chat({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user, images: request.images },
      ],
      temperature: 0,
      maxTokens: 1024,
      // The stored identifier is already the `remote:<provider>:<model>` form
      // the service parses. Stripping the prefix here made the pin unparseable,
      // so the review quietly ran on whatever the automatic ranking chose
      // instead of on the model the user picked.
      pinnedModelId: modelId,
    });
    return { text: result.text, provider: result.provider, modelId: result.modelId };
  };
}


/**
 * Turns an OCR document into the purchase-invoice draft it describes.
 *
 * Lives here, at module scope, because two callers need exactly this behaviour:
 * the "Créer le brouillon" button and Wheat AI's `documents.create_invoice_draft`
 * capability. A second implementation for the assistant would be a second set of
 * account checks, a second duplicate-number rule and a second audit trail — so
 * there is one, and the assistant is simply another caller of it.
 *
 * `expectedCompanyId`, when given, refuses a document belonging to any other
 * dossier: the assistant must never reach across companies, and that is enforced
 * here rather than trusted to the model.
 */
/**
 * The extraction of one document, as the review screen sees it.
 *
 * Deliberately does not return the stored file path or the raw page images: the
 * assistant needs the fields, their confidence and the accounting checks to
 * explain a problem, and nothing about where the bytes live on disk.
 */
async function readDocumentExtraction(expectedCompanyId: string | null, documentId: string) {
  const id = requireId(documentId, "Le document");
  const prisma = await getAuthorizedPrisma();
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw new Error("Le document demandé n'existe plus.");
  if (expectedCompanyId && document.companyId !== expectedCompanyId) throw new Error("Le document appartient à un autre dossier.");
  // An unreadable extraction is not a reason to refuse the read: the caller
  // still needs the title, the status and the links to explain what it sees.
  let extracted: Record<string, any>;
  try {
    extracted = JSON.parse(document.extracted || "{}");
  } catch {
    extracted = {};
  }
  return {
    id: document.id,
    title: document.title,
    type: document.type,
    status: document.status,
    fiscalYear: document.fiscalYear,
    tags: document.tags,
    invoiceId: document.invoiceId,
    entryId: document.entryId,
    paymentId: document.paymentId,
    documentType: extracted.documentType ?? null,
    documentDirection: extracted.documentDirection ?? null,
    confidence: extracted.confidence ?? null,
    uncertainFields: extracted.uncertainFields ?? [],
    accountingChecks: extracted.accountingChecks ?? [],
    parties: extracted.parties ?? null,
    fields: extracted.fields ?? {},
    fieldConfidence: extracted.fieldConfidence ?? {},
    fieldSources: extracted.fieldSources ?? {},
    invoiceSchema: extracted.invoiceSchema ?? null,
    ocrTextExcerpt: String(document.ocrText ?? "").slice(0, 4000),
  };
}

/**
 * Runs recognition again on a document already filed in the dossier.
 *
 * The stored copy is re-read, never the original the user picked: that file may
 * be gone, and the stored copy is the one whose hash the audit chain records.
 * The document row is updated in place so links, hash and history survive.
 */
async function rerunDocumentOcr(expectedCompanyId: string | null, documentId: string) {
  const id = requireId(documentId, "Le document");
  const prisma = await getAuthorizedPrisma();
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw new Error("Le document demandé n'existe plus.");
  if (expectedCompanyId && document.companyId !== expectedCompanyId) throw new Error("Le document appartient à un autre dossier.");
  if (document.invoiceId || document.paymentId || document.entryId) {
    throw new Error("Ce document est déjà lié à un brouillon ou à une écriture. Supprimez d'abord son brouillon avant de relancer la reconnaissance.");
  }
  if (!document.storedPath || !fs.existsSync(document.storedPath)) {
    throw new Error("La copie archivée de ce document est introuvable ; la reconnaissance ne peut pas être relancée.");
  }
  const company = await prisma.company.findUniqueOrThrow({ where: { id: document.companyId } });
  const [processed] = await processSmartOcrFiles(app, {
    companyId: document.companyId,
    companyName: company.name,
    filePaths: [document.storedPath],
    existingDocuments: [],
    company: { name: company.name, ice: company.ice, taxId: company.taxId },
    aiReview: buildDocumentAiReviewer(),
  });
  if (!processed) throw new Error("La reconnaissance n'a produit aucun résultat pour ce document.");

  /*
   * A better reading of the page, not permission to discard what a person
   * established about it. Every correction made against the previous reading
   * is carried into this one and re-applied on top of it; the revision counter
   * records that this is a second pass.
   */
  let previousExtracted: Record<string, unknown> = {};
  try {
    previousExtracted = JSON.parse(document.extracted || "{}") as Record<string, unknown>;
  } catch {
    // An unreadable previous extraction carries nothing forward, which is the
    // honest outcome — there is no correction history to be found in it.
  }
  const rerunExtracted = prepareDocumentReview(processed.extracted as Record<string, unknown>, {
    documentType: processed.type,
    sourceFingerprint: document.contentSha256 ?? null,
    previous: previousExtracted,
  });
  const carriedCorrections = readDocumentReview(rerunExtracted)?.userCorrections.length ?? 0;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.document.update({
      where: { id },
      data: {
        type: processed.type,
        tags: processed.tags,
        ocrText: processed.ocrText,
        extracted: JSON.stringify(rerunExtracted),
        status: processed.status,
      },
    });
    await appendTrustedAudit(tx, {
      companyId: document.companyId,
      action: "SMART_OCR_RERUN",
      entity: "Document",
      entityId: document.id,
      description: `${document.title} : reconnaissance relancée`,
      details: {
        previousStatus: document.status,
        status: result.status,
        type: result.type,
        extractionRevision: readDocumentReview(rerunExtracted)?.extractionRevision ?? 1,
        carriedCorrections,
      },
    });
    return result;
  });

  return { id: updated.id, status: updated.status, type: updated.type, extraction: await readDocumentExtraction(expectedCompanyId, id) };
}

/**
 * Resolves every ledger account a planned draft needs, against this dossier's
 * own chart. Nothing is created here: a role with no account is a configuration
 * question, answered with a message that names the role and the codes tried.
 */
async function resolvePlanAccounts(tx: any, companyId: string, plan: InvoiceDraftPlan) {
  const accounts: ChartAccount[] = await tx.account.findMany({
    where: { companyId, active: true },
    select: { id: true, code: true, label: true, active: true, postable: true },
  });
  const resolved = new Map<string, ResolvedRole>();
  for (const role of requiredRolesForPlan(plan)) {
    resolved.set(role, resolveAccountRole(role as never, accounts));
  }
  const unresolved = [...resolved.values()].filter((item) => !item.account);
  if (unresolved.length) throw new Error(missingAccountMessage(unresolved));
  return resolved as Map<string, ResolvedRole & { account: ChartAccount }>;
}

/**
 * Creates the invoice draft a recognised document should become.
 *
 * The decisions — sale or purchase, which third party, which fields carry over,
 * which account each line belongs to — are made by `documentInvoiceDraft`,
 * which is a pure function of the stored extraction and therefore testable
 * against a recorded document. This function does the part that needs the
 * database: it resolves the roles against the dossier's chart, finds or creates
 * the third party, and writes the invoice and the document link in one
 * transaction so a document is never left pointing at a draft that does not
 * exist.
 *
 * `forcedKind` exists for the two cases where a person, not the document,
 * settles the direction: a reviewer answering the confirmation prompt on an
 * unattributable piece, and the reclassification workflow rebuilding a draft
 * that was filed on the wrong side.
 */
async function findOcrCounterparty(db: any, companyId: string, planned: InvoiceDraftPlan["counterparty"]) {
  const normalizedName = normalizeCompanyName(planned.displayName);
  const distinctiveToken = normalizedName.split(" ").sort((left, right) => right.length - left.length)[0] ?? "";
  const candidates = await db.counterparty.findMany({
    where: {
      companyId,
      OR: [
        ...(planned.ice ? [{ ice: planned.ice }] : []),
        ...(planned.taxId ? [{ taxId: planned.taxId }] : []),
        { displayName: planned.displayName },
        { legalName: planned.displayName },
        ...(distinctiveToken.length >= 3 ? [{ displayName: { contains: distinctiveToken } }, { legalName: { contains: distinctiveToken } }] : []),
      ],
    },
    take: 200,
  });
  const matches = candidates
    .map((candidate: any) => {
      const identities = [candidate.displayName, candidate.legalName]
        .filter(Boolean)
        .map((name) => matchPartyIdentity(
          { name: planned.displayName, ice: planned.ice, taxId: planned.taxId, rc: planned.rc },
          { name, ice: candidate.ice, taxId: candidate.taxId },
        ));
      identities.sort((left, right) => right.confidence - left.confidence);
      return { candidate, match: identities[0] };
    })
    .filter((item: any) => item.match?.verdict === "SAME")
    .sort((left: any, right: any) => right.match.confidence - left.match.confidence);
  if (matches.length > 1 && matches[0].match.confidence === matches[1].match.confidence) {
    throw new Error(`Plusieurs tiers du dossier correspondent à « ${planned.displayName} ». Fusionnez ou corrigez les doublons avant de créer le brouillon.`);
  }
  return matches[0]?.candidate ?? null;
}

async function createInvoiceDraftFromDocument(expectedCompanyId: string | null, documentId: string, options: { forcedKind?: "SALE" | "PURCHASE" | null } = {}) {
  const id = requireId(documentId, "Le document");
  const prisma = await getAuthorizedPrisma();
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw new Error("Le document demandé n'existe plus.");
  if (expectedCompanyId && document.companyId !== expectedCompanyId) throw new Error("Le document appartient à un autre dossier.");
  if (document.invoiceId) {
    const existing = await prisma.invoice.findUnique({ where: { id: document.invoiceId }, include: { lines: true } });
    if (existing) return serialize({ document, invoiceDraft: existing });
  }
  if (!subledgerService) throw new Error("Le sous-livre des factures n'est pas encore disponible.");

  let extracted: Record<string, any>;
  try {
    extracted = JSON.parse(document.extracted || "{}") as Record<string, any>;
  } catch {
    throw new Error("Les données OCR sont illisibles. Relancez l'extraction avant de créer la facture.");
  }
  const company = await prisma.company.findUniqueOrThrow({ where: { id: document.companyId } });

  let plan: InvoiceDraftPlan;
  try {
    // First identify the document's actual counterparty relative to the active
    // dossier. Looking up the issuer first used a supplier's terms on sales.
    plan = planInvoiceDraftFromDocument({
      extracted,
      documentTitle: document.title,
      company: { name: company.name, ice: company.ice, taxId: company.taxId, city: company.city, baseCurrency: company.baseCurrency },
      paymentTermsDays: null,
      forcedKind: options.forcedKind ?? null,
    });
    const knownParty = await findOcrCounterparty(prisma, document.companyId, plan.counterparty);
    if (knownParty) {
      plan = planInvoiceDraftFromDocument({
        extracted,
        documentTitle: document.title,
        company: { name: company.name, ice: company.ice, taxId: company.taxId, city: company.city, baseCurrency: company.baseCurrency },
        paymentTermsDays: knownParty.paymentTermsDays,
        forcedKind: options.forcedKind ?? null,
      });
    }
  } catch (error) {
    // The plan's own errors already name what is missing and what to do about
    // it; re-wrapping them would bury the actionable half.
    if (error instanceof InvoiceDraftPlanError) throw new Error(error.message, { cause: error });
    throw error;
  }

  const result = await prisma.$transaction(async (tx: any) => writeInvoiceDraftFromPlan(tx, { documentId: id, companyId: document.companyId, documentTitle: document.title, plan, forcedKind: options.forcedKind ?? null }));
  return serialize(result);
}

/**
 * Writes a planned draft, inside a transaction the caller owns.
 *
 * Both entry points into this need the same body: creating a draft from a
 * freshly recognised document, and rebuilding one on the other side of the
 * ledger after a misclassification. Sharing the transaction — rather than the
 * function that opens one — is what lets the reclassification delete the wrong
 * draft and write the right one without ever leaving the document unlinked.
 */
async function writeInvoiceDraftFromPlan(tx: any, input: { documentId: string; companyId: string; documentTitle: string; plan: InvoiceDraftPlan; forcedKind: "SALE" | "PURCHASE" | null }) {
  const { plan, companyId, documentTitle } = input;
  const id = input.documentId;
  const document = { companyId, title: documentTitle };
  const identityKey = counterpartyIdentityKey({
    displayName: plan.counterparty.displayName,
    ice: plan.counterparty.ice ?? undefined,
    taxId: plan.counterparty.taxId ?? undefined,
  });
  {
    const currentDocument = await tx.document.findUnique({ where: { id } });
    if (!currentDocument || currentDocument.companyId !== companyId) throw new Error("Le document n'existe plus dans cette société.");
    if (currentDocument.invoiceId) throw new Error("Ce document est déjà lié à une facture.");

    const roles = await resolvePlanAccounts(tx, document.companyId, plan);
    const controlAccount = roles.get(plan.controlRole)!.account;
    const vatAccount = roles.get(plan.vatRole)!.account;

    let counterparty = await findOcrCounterparty(tx, document.companyId, plan.counterparty);
    let counterpartyCreated = false;
    if (!counterparty) {
      counterparty = await tx.counterparty.create({
        data: {
          companyId: document.companyId,
          kind: plan.counterparty.kind,
          displayName: plan.counterparty.displayName,
          legalName: plan.counterparty.displayName,
          ice: plan.counterparty.ice,
          taxId: plan.counterparty.taxId,
          address: plan.counterparty.address,
          email: plan.counterparty.email,
          phone: plan.counterparty.phone,
          identityKey,
          ...(plan.counterparty.kind === "CUSTOMER"
            ? { defaultReceivableAccountId: controlAccount.id }
            : { defaultPayableAccountId: controlAccount.id }),
        },
      });
      counterpartyCreated = true;
    }
    const required = plan.counterparty.kind === "CUSTOMER" ? ["CUSTOMER", "BOTH"] : ["SUPPLIER", "BOTH"];
    if (!counterparty.active) throw new Error(`Le tiers « ${counterparty.displayName} » est archivé. Restaurez-le avant de créer le brouillon.`);
    if (!required.includes(counterparty.kind)) {
      // A party already known on the other side of the ledger is widened rather
      // than duplicated: one legal entity, one third party, both roles.
      counterparty = await tx.counterparty.update({ where: { id: counterparty.id }, data: { kind: "BOTH", version: { increment: 1 } } });
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "WIDEN_COUNTERPARTY_FROM_OCR",
        entity: "Counterparty",
        entityId: counterparty.id,
        description: `${counterparty.displayName} devient client et fournisseur : la pièce ${plan.invoiceNo} le désigne comme ${plan.counterparty.kind === "CUSTOMER" ? "client" : "fournisseur"}`,
        details: { documentId: id, identityKey, previousKind: plan.counterparty.kind === "CUSTOMER" ? "SUPPLIER" : "CUSTOMER" },
      });
    }

    const dueDate = plan.dueDate ? parseAccountingDate(plan.dueDate, "La date d'échéance") : null;
    const invoiceDate = parseAccountingDate(plan.invoiceDate, "La date de facture");

    const canonicalInvoiceNo = plan.invoiceNo
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
    if (!canonicalInvoiceNo) throw new Error("Le numéro de la pièce est invalide.");
    // A sale is numbered by the dossier and unique on its own; a purchase is
    // numbered by the supplier and unique only per supplier. This mirrors the
    // subledger's own key so a draft created from OCR collides exactly where a
    // draft typed by hand would.
    const numberKey = plan.kind === "SALE" ? `SALE:${canonicalInvoiceNo}` : `PURCHASE:${counterparty.id}:${canonicalInvoiceNo}`;
    const duplicate = await tx.invoice.findUnique({ where: { companyId_numberKey: { companyId: document.companyId, numberKey } } });
    if (duplicate) {
      throw new Error(plan.kind === "SALE"
        ? `Une facture de vente portant le numéro ${plan.invoiceNo} existe déjà dans ce dossier.`
        : `Une facture portant le numéro ${plan.invoiceNo} existe déjà pour le fournisseur ${counterparty.displayName}.`);
    }

    const invoiceDraft = await tx.invoice.create({
      data: {
        companyId: document.companyId,
        kind: plan.kind,
        counterparty: counterparty.displayName,
        ice: plan.counterparty.ice ?? counterparty.ice,
        invoiceNo: plan.invoiceNo,
        invoiceDate,
        dueDate,
        paymentDate: null,
        htCents: BigInt(plan.htCents),
        vatCents: BigInt(plan.vatCents),
        ttcCents: BigInt(plan.ttcCents),
        status: "DRAFT",
        paymentMethod: plan.paymentMethod,
        counterpartyId: counterparty.id,
        numberKey,
        currency: plan.currency,
        counterpartyNameSnapshot: counterparty.displayName,
        iceSnapshot: plan.counterparty.ice ?? counterparty.ice,
        taxIdSnapshot: plan.counterparty.taxId ?? counterparty.taxId,
        billingAddressSnapshot: plan.counterparty.address ?? counterparty.address,
        lifecycleStatus: "DRAFT",
        source: "OCR_1_3",
        notes: [
          `Brouillon créé depuis le document OCR « ${document.title} ».`,
          plan.directionStatus === "RESOLVED"
            ? `Sens ${plan.kind === "SALE" ? "vente" : "achat"} établi par ${plan.directionBasis}.`
            : "Sens confirmé manuellement.",
          ...plan.warnings,
          "Contrôle humain requis avant comptabilisation.",
        ].join(" "),
        needsReview: true,
        reviewNote: `Créé depuis OCR : vérifier tiers, numéro, date, comptes et montants.${plan.warnings.length ? ` ${plan.warnings.join(" ")}` : ""}`.slice(0, 500),
        controlAccountId: controlAccount.id,
        vatAccountId: vatAccount.id,
        lines: {
          create: plan.lines.map((line) => ({
            position: line.position,
            description: line.description,
            accountId: roles.get(line.accountRole)!.account.id,
            quantityMilli: quantityToMilli(line.quantity, `La quantité de la ligne ${line.position}`),
            unitPriceCents: line.unitPriceCents === null ? null : BigInt(line.unitPriceCents),
            discountCents: BigInt(line.discountCents),
            htCents: BigInt(line.htCents),
            vatCents: BigInt(line.vatCents),
            ttcCents: BigInt(line.ttcCents),
            vatRateBps: line.vatRateBps,
          })),
        },
      },
      include: { lines: true, counterpartyModel: true },
    });
    /*
     * The reading has become accounting data, so the review is over.
     *
     * The payload is settled and compacted in the same transaction that links
     * the document: the recogniser's working material — several hundred placed
     * words per page, and the candidates it rejected — was useful while
     * somebody was deciding and is dead weight in the dossier afterwards. Every
     * canonical value, every check and every correction stays; the source
     * attachment on disk is not touched at all.
     */
    const current = await tx.document.findUnique({ where: { id }, select: { extracted: true } });
    let settled: string | undefined;
    try {
      settled = JSON.stringify(settleDocumentReview(JSON.parse(current?.extracted || "{}"), "CONFIRMED"));
    } catch {
      // An unreadable extraction is left exactly as it is: the draft has been
      // planned from values already in hand, and rewriting a blob Wheat cannot
      // parse would destroy evidence rather than compact it.
    }
    const linked = await tx.document.updateMany({
      where: { id, companyId: document.companyId, invoiceId: null, paymentId: null, entryId: null },
      data: { invoiceId: invoiceDraft.id, status: "INVOICE_DRAFT", ...(settled ? { extracted: settled } : {}) },
    });
    if (linked.count !== 1) throw new Error("Le document a été lié ou modifié dans une autre opération.");
    if (counterpartyCreated) {
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "CREATE_COUNTERPARTY_FROM_OCR",
        entity: "Counterparty",
        entityId: counterparty.id,
        description: `${plan.counterparty.kind === "CUSTOMER" ? "Client" : "Fournisseur"} ${counterparty.displayName} créé depuis OCR`,
        details: { identityKey, documentId: id, kind: plan.counterparty.kind },
      });
    }
    await appendTrustedAudit(tx, {
      companyId: document.companyId,
      action: "CREATE_INVOICE_DRAFT_FROM_OCR",
      entity: "Invoice",
      entityId: invoiceDraft.id,
      description: `Brouillon ${plan.kind === "SALE" ? "de vente" : "d'achat"} ${plan.invoiceNo} créé et lié au document ${document.title}`,
      details: {
        documentId: id,
        counterpartyId: counterparty.id,
        kind: plan.kind,
        directionStatus: plan.directionStatus,
        directionBasis: plan.directionBasis,
        forcedKind: input.forcedKind,
        htCents: plan.htCents,
        vatCents: plan.vatCents,
        ttcCents: plan.ttcCents,
        deboursCents: plan.deboursCents,
        lineCount: plan.lines.length,
      },
    });
    const updatedDocument = await tx.document.findUniqueOrThrow({ where: { id } });
    return { document: updatedDocument, invoiceDraft, plan: { kind: plan.kind, directionStatus: plan.directionStatus, directionBasis: plan.directionBasis, warnings: plan.warnings, absentFields: plan.absentFields } };
  }
}

/**
 * Moves a draft to the other side of the ledger.
 *
 * A document filed as a purchase when it was the dossier's own sale cannot be
 * corrected by editing the draft: the ledger side decides the collective
 * account, the VAT account, the numbering key, and whether the third party is a
 * customer or a supplier. Wheat therefore rebuilds the draft from the source
 * document, which still carries the recognised fields, rather than mutating a
 * row into a shape the subledger would never have created.
 *
 * The whole exchange is one transaction: the wrong draft is removed and the
 * right one written together, so the document is never left pointing at
 * nothing. A draft that has been posted, allocated or voided is refused —
 * history is corrected by reversal, never by replacement.
 */
async function reclassifyInvoiceDraft(expectedCompanyId: string | null, payload: { invoiceId?: string; documentId?: string; kind: "SALE" | "PURCHASE" }) {
  const targetKind = payload.kind === "SALE" || payload.kind === "PURCHASE" ? payload.kind : null;
  if (!targetKind) throw new Error("Le sens cible doit être SALE ou PURCHASE.");
  const prisma = await getAuthorizedPrisma();

  const invoice = payload.invoiceId
    ? await prisma.invoice.findUnique({ where: { id: requireId(payload.invoiceId, "La facture") }, include: { documents: true, allocations: true } })
    : await prisma.invoice.findFirst({ where: { documents: { some: { id: requireId(payload.documentId ?? "", "Le document") } } }, include: { documents: true, allocations: true } });
  if (!invoice) throw new Error("Le brouillon à reclasser est introuvable.");
  if (expectedCompanyId && invoice.companyId !== expectedCompanyId) throw new Error("Cette facture appartient à un autre dossier.");
  if (invoice.lifecycleStatus !== "DRAFT" || invoice.status !== "DRAFT") {
    throw new Error(`La facture ${invoice.invoiceNo} n'est plus un brouillon (${invoice.lifecycleStatus}). Une facture comptabilisée se corrige par annulation et contrepassation, pas par reclassement.`);
  }
  if (invoice.allocations.length) throw new Error("Ce brouillon porte déjà des imputations de règlement. Annulez-les avant de le reclasser.");
  if (invoice.kind === targetKind) throw new Error(`La facture ${invoice.invoiceNo} est déjà une facture ${targetKind === "SALE" ? "de vente" : "d'achat"}.`);

  const document = invoice.documents[0];
  if (!document) {
    throw new Error("Ce brouillon n'est lié à aucun document source. Wheat ne peut pas le reconstruire dans l'autre sens : supprimez-le et saisissez la facture correcte.");
  }

  let extracted: Record<string, any>;
  try {
    extracted = JSON.parse(document.extracted || "{}") as Record<string, any>;
  } catch {
    throw new Error("Les données OCR du document source sont illisibles. Relancez la reconnaissance avant de reclasser le brouillon.");
  }
  const company = await prisma.company.findUniqueOrThrow({ where: { id: invoice.companyId } });

  // Planned before anything is deleted: a plan that cannot be built is a reason
  // to refuse, not a reason to leave the dossier without its draft.
  let plan: InvoiceDraftPlan;
  try {
    plan = planInvoiceDraftFromDocument({
      extracted,
      documentTitle: document.title,
      company: { name: company.name, ice: company.ice, taxId: company.taxId, city: company.city, baseCurrency: company.baseCurrency },
      paymentTermsDays: null,
      forcedKind: targetKind,
    });
    const knownParty = await findOcrCounterparty(prisma, invoice.companyId, plan.counterparty);
    if (knownParty) {
      plan = planInvoiceDraftFromDocument({
        extracted,
        documentTitle: document.title,
        company: { name: company.name, ice: company.ice, taxId: company.taxId, city: company.city, baseCurrency: company.baseCurrency },
        paymentTermsDays: knownParty.paymentTermsDays,
        forcedKind: targetKind,
      });
    }
  } catch (error) {
    if (error instanceof InvoiceDraftPlanError) throw new Error(error.message, { cause: error });
    throw error;
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const current = await tx.invoice.findUnique({ where: { id: invoice.id }, include: { allocations: true } });
    if (!current || current.lifecycleStatus !== "DRAFT" || current.status !== "DRAFT" || current.allocations.length) {
      throw new Error("Le brouillon a changé depuis la vérification. Rechargez-le puis recommencez.");
    }
    const unlinked = await tx.document.updateMany({
      where: { id: document.id, companyId: invoice.companyId, invoiceId: invoice.id },
      data: { invoiceId: null, status: document.status === "INVOICE_DRAFT" ? "EXTRACTED" : document.status },
    });
    if (unlinked.count !== 1) throw new Error("Le document source a été modifié dans une autre opération.");
    await tx.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.invoice.delete({ where: { id: invoice.id } });
    await appendTrustedAudit(tx, {
      companyId: invoice.companyId,
      action: "RECLASSIFY_INVOICE_DRAFT",
      entity: "Invoice",
      entityId: invoice.id,
      description: `Brouillon ${invoice.invoiceNo} reclassé de ${invoice.kind} vers ${targetKind} : reconstruit depuis le document source`,
      details: {
        documentId: document.id,
        previousKind: invoice.kind,
        targetKind,
        previousInvoiceId: invoice.id,
        previousTotals: { htCents: invoice.htCents.toString(), vatCents: invoice.vatCents.toString(), ttcCents: invoice.ttcCents.toString() },
      },
    });
    return writeInvoiceDraftFromPlan(tx, { documentId: document.id, companyId: invoice.companyId, documentTitle: document.title, plan, forcedKind: targetKind });
  });
  return serialize({ ...result, replaced: { invoiceId: invoice.id, kind: invoice.kind, invoiceNo: invoice.invoiceNo } });
}

/**
 * Records a manual correction of an OCR extraction.
 *
 * Shared by the review screen and by Wheat AI's `documents.update_extraction`
 * capability, for the same reason as the draft creation above: one place that
 * refuses to touch a document already linked to a draft, one audit entry.
 */
async function updateDocumentExtraction(expectedCompanyId: string | null, payload: { documentId: string; type?: string; fields?: Record<string, unknown>; tags?: string }) {
  const prisma = await getAuthorizedPrisma();
  const document = await prisma.document.findUniqueOrThrow({ where: { id: payload.documentId } });
  if (expectedCompanyId && document.companyId !== expectedCompanyId) throw new Error("Le document appartient à un autre dossier.");
  if (document.invoiceId || document.paymentId || document.entryId) {
    throw new Error("Ce document est déjà lié à un brouillon ou à une écriture. Corrigez le sous-livre lié, ou supprimez d'abord son brouillon, afin de préserver la preuve source.");
  }
  const previous = JSON.parse(document.extracted || "{}");
  const correctedFields = payload.fields ?? {};
  /*
   * A correction is a decision, and it is recorded as one.
   *
   * Writing the value into `fields` is not enough on its own: re-running
   * recognition rebuilds that object from the page and used to take every
   * correction with it. The review payload keeps what a person established, so
   * a later reading carries it forward instead of overwriting it.
   */
  const next = {
    ...recordUserCorrections(previous, correctedFields),
    manualCorrectedAt: new Date().toISOString(),
  };

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.document.update({
      where: { id: payload.documentId },
      data: {
        type: payload.type ?? document.type,
        tags: payload.tags ?? `${document.tags},corrected`,
        extracted: JSON.stringify(next),
        status: "EXTRACTED",
      },
    });
    await appendTrustedAudit(tx, {
      companyId: document.companyId,
      action: "SMART_OCR_CORRECT",
      entity: "Document",
      entityId: document.id,
      description: `${document.title} : extraction corrigée manuellement`,
      details: { correctedFields: Object.keys(correctedFields), type: result.type, tags: result.tags },
    });
    return result;
  });

  return serialize(updated);
}

/**
 * Picks the one file an import may proceed with, or explains why it may not.
 *
 * The rules live in `importValidation.ts`; this wrapper turns a refusal into the
 * error the renderer shows. It used to return an empty list instead, which the
 * interface could not tell apart from a cancelled dialog — so an unsupported or
 * unreadable file simply did nothing.
 */
function pickSingleImportFile(inputPaths: string[]) {
  const selection = selectImportFile(inputPaths);
  if (selection.ok) return [selection.filePath];
  if (!selection.rejections.length) return [];
  throw new Error(selection.rejections.map((rejection) => rejection.reason).join(" "));
}

async function trashStoredDocumentFile(appInstance: Electron.App, storedPath: string) {
  const userDataDir = readWheatEnv("WHEAT_USER_DATA_DIR") || appInstance.getPath("userData");
  const resolvedStoredPath = path.resolve(storedPath);
  const resolvedUserDataDir = path.resolve(userDataDir);
  if (!resolvedStoredPath.startsWith(`${resolvedUserDataDir}${path.sep}`)) return false;
  if (!fs.existsSync(resolvedStoredPath)) return false;
  const stat = fs.statSync(resolvedStoredPath);
  if (!stat.isFile()) return false;
  try {
    await shell.trashItem(resolvedStoredPath);
    return true;
  } catch {
    // The database record can still be removed without destroying an
    // attachment that Windows could not move to the Recycle Bin.
    return false;
  }
}

function validateSqliteBackup(filePath: string) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("Le fichier de sauvegarde sélectionné n'existe plus.");
  if (fs.statSync(filePath).size < 100) throw new Error("Le fichier sélectionné est trop petit pour être une base SQLite valide.");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("binary") !== "SQLite format 3\0") throw new Error("Le fichier sélectionné n'est pas une base SQLite.");
  } finally {
    fs.closeSync(descriptor);
  }

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok") throw new Error("Le contrôle d'intégrité SQLite a échoué.");
    const companyTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Company'").get();
    if (!companyTable) throw new Error("Cette base ne contient pas les données d'une installation Wheat.");
  } finally {
    database.close();
  }
}

function timestampForBackup(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeUnlink(filePath: string) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
}

function resolveWheatUserDataDir(appInstance: Electron.App) {
  return path.resolve(readWheatEnv("WHEAT_USER_DATA_DIR") || appInstance.getPath("userData"));
}

function managedDocumentsRoot(appInstance: Electron.App) {
  return path.join(resolveWheatUserDataDir(appInstance), "documents");
}

function mimeTypeForManagedDocument(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function persistManagedLedgerImportSource(input: { companyId: string; sourceName: string; sourceSha256: string; bytes: Buffer }) {
  const safeName = path.basename(input.sourceName).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "ledger-import";
  const importDirectory = path.join(managedDocumentsRoot(app), input.companyId, "ledger-imports");
  fs.mkdirSync(importDirectory, { recursive: true });
  const storedPath = path.join(importDirectory, `${input.sourceSha256}-${safeName}`);
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, input.bytes, { flag: "wx" });
  return storedPath;
}

function pathIsStrictlyInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function checkpointWheatDatabase(databasePath: string) {
  if (!fs.existsSync(databasePath)) return;
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

async function createFullWheatBackup(destinationPath: string) {
  const livePath = path.resolve(resolveDatabasePath(app));
  const documentsRoot = managedDocumentsRoot(app);
  await disconnectPrisma();
  checkpointWheatDatabase(livePath);
  // A single attachment stored under a name the archive's path contract
  // refuses used to make the whole dossier impossible to back up. Names are
  // repaired first — same bytes, portable name, row updated — and anything that
  // genuinely cannot be repaired is named rather than silently left out.
  const repair = repairNonPortableManagedPaths({ databasePath: livePath, storedPathsRoot: documentsRoot });
  if (repair.unrepairable.length) {
    const details = repair.unrepairable.map((item) => `${item.relativePath} (${item.reason})`).join(" ; ");
    throw new Error(`La sauvegarde a été interrompue pour ne pas se déclarer complète en omettant des pièces : ${details}`);
  }
  const provenance = verifyManagedFileProvenance({
    databasePath: livePath,
    storedPathsRoot: documentsRoot,
  });
  const summary = await createWheatBackup({
    destinationPath,
    databasePath: livePath,
    managedAttachmentsRoot: provenance.relativePaths.length ? documentsRoot : undefined,
    managedAttachmentPaths: provenance.relativePaths,
    appVersion: WHEAT_APP_VERSION,
    workingDirectory: resolveWheatUserDataDir(app),
  });
  try {
    assertBackupManifestMatchesProvenance(summary.manifest.files, provenance);
  } catch (error) {
    safeUnlink(summary.archivePath);
    throw error;
  }
  return summary.archivePath;
}

function assertBackupManifestMatchesProvenance(
  manifestFiles: readonly WheatBackupFileManifest[],
  provenance: ManagedFileProvenanceResult,
) {
  const attachments = manifestFiles.filter((file) => file.kind === "attachment");
  assertManagedFileSetMatchesArchive(
    provenance.relativePaths,
    attachments.map((file) => file.path.slice("attachments/".length)),
  );
  const expectedByPath = new Map(provenance.files.map((file) => [file.relativePath, file]));
  for (const attachment of attachments) {
    const relativePath = attachment.path.slice("attachments/".length);
    const expected = expectedByPath.get(relativePath);
    if (!expected || expected.sha256 !== attachment.sha256 || expected.byteSize !== attachment.size) {
      throw new Error(`Le fichier géré a changé pendant la création de la sauvegarde : ${relativePath}.`);
    }
  }
}

function rewriteRestoredDocumentPaths(databasePath: string, files: WheatBackupFileManifest[], destinationRoot: string) {
  const candidates = files
    .filter((file) => file.kind === "attachment" && file.path.startsWith("attachments/"))
    .map((file) => file.path.slice("attachments/".length))
    .sort((left, right) => right.length - left.length);
  if (!candidates.length) return;

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    const documentTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Document'").get();
    const statementTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'BankStatementImport'").get();
    const ledgerImportTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'LedgerImportBatch'").get();
    if (!documentTable && !statementTable && !ledgerImportTable) return;
    const rows: Array<{ table: "Document" | "BankStatementImport" | "LedgerImportBatch"; id: string; storedPath: string }> = [];
    if (documentTable) {
      rows.push(...(database.prepare('SELECT "id", "storedPath" FROM "Document" WHERE "storedPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "Document" as const })));
    }
    if (statementTable) {
      rows.push(...(database.prepare('SELECT "id", "sourceStoredPath" AS "storedPath" FROM "BankStatementImport" WHERE "sourceStoredPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "BankStatementImport" as const })));
    }
    if (ledgerImportTable) {
      rows.push(...(database.prepare('SELECT "id", "sourceStoredPath" AS "storedPath" FROM "LedgerImportBatch" WHERE "sourceStoredPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "LedgerImportBatch" as const })));
    }
    const updateDocument = documentTable ? database.prepare('UPDATE "Document" SET "storedPath" = ? WHERE "id" = ?') : null;
    const updateStatement = statementTable ? database.prepare('UPDATE "BankStatementImport" SET "sourceStoredPath" = ? WHERE "id" = ?') : null;
    const updateLedgerImport = ledgerImportTable ? database.prepare('UPDATE "LedgerImportBatch" SET "sourceStoredPath" = ? WHERE "id" = ?') : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const normalized = row.storedPath.replaceAll("\\", "/").normalize("NFC").toLocaleLowerCase("en-US");
        const relative = candidates.find((candidate) => {
          const key = candidate.normalize("NFC").toLocaleLowerCase("en-US");
          return normalized === key || normalized.endsWith(`/${key}`);
        });
        if (relative) {
          const nextPath = path.join(destinationRoot, ...relative.split("/"));
          if (row.table === "Document") updateDocument?.run(nextPath, row.id);
          else if (row.table === "BankStatementImport") updateStatement?.run(nextPath, row.id);
          else updateLedgerImport?.run(nextPath, row.id);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function removePrivateRestoreDirectory(target: string, permittedParent: string, expectedPrefix?: string) {
  const resolved = path.resolve(target);
  const parent = path.resolve(permittedParent);
  if (!pathIsStrictlyInside(parent, resolved)) throw new Error("Wheat a refusé de supprimer un dossier de restauration hors de son espace privé.");
  if (expectedPrefix && !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error("Wheat a refusé de supprimer un dossier qui ne ressemble pas à un dossier de restauration privé.");
  }
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}
