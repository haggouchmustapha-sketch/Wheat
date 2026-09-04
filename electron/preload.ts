import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The Wheat renderer bridge.
 *
 * Every method is a thin, one-way `invoke` into the main process. No secret,
 * file handle or provider credential is ever exposed here: the Wheat AI
 * provider methods below return masked metadata only.
 *
 * The bridge is published as `window.wheat`, and only as that.
 */
const wheat = {
  getBootstrap: (companyId?: string) => ipcRenderer.invoke("wheat:bootstrap", companyId),
  getSageExportEntries: (companyId: string) => ipcRenderer.invoke("wheat:entry:sage-export-set", companyId),
  getSageExportProfile: (companyId: string) => ipcRenderer.invoke("wheat:sage-profile:get", companyId),
  saveSageExportProfile: (payload: unknown) => ipcRenderer.invoke("wheat:sage-profile:save", payload),
  updateUserName: (payload: unknown) => ipcRenderer.invoke("wheat:user:update", payload),
  createCompany: (payload: unknown) => ipcRenderer.invoke("wheat:company:create", payload),
  resetWorkspace: (payload: unknown) => ipcRenderer.invoke("wheat:workspace:reset", payload),
  deleteCompany: (companyId: string) => ipcRenderer.invoke("wheat:company:delete", companyId),
  createEntry: (payload: unknown) => ipcRenderer.invoke("wheat:entry:create", payload),
  previewPieceNumber: (payload: unknown) => ipcRenderer.invoke("wheat:piece-number:preview", payload),
  postEntry: (entryId: string) => ipcRenderer.invoke("wheat:entry:post", entryId),
  duplicateEntry: (entryId: string) => ipcRenderer.invoke("wheat:entry:duplicate", entryId),
  reverseEntry: (entryId: string, date?: string) => ipcRenderer.invoke("wheat:entry:reverse", entryId, date),
  deleteEntry: (entryId: string) => ipcRenderer.invoke("wheat:entry:delete", entryId),
  lockFiscalPeriod: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-period:lock", payload),
  unlockFiscalPeriod: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-period:unlock", payload),
  getReconciliationWorkspace: (payload: unknown) => ipcRenderer.invoke("wheat:bank:reconciliation:workspace", payload),
  getReconciliationCandidates: (payload: unknown) => ipcRenderer.invoke("wheat:bank:reconciliation:candidates", payload),
  confirmReconciliation: (payload: unknown) => ipcRenderer.invoke("wheat:bank:reconciliation:confirm", payload),
  voidReconciliation: (payload: unknown) => ipcRenderer.invoke("wheat:bank:reconciliation:void", payload),
  excludeBankMovement: (payload: unknown) => ipcRenderer.invoke("wheat:bank:movement:exclude", payload),
  restoreBankMovement: (payload: unknown) => ipcRenderer.invoke("wheat:bank:movement:restore", payload),
  selectBankStatementFile: () => ipcRenderer.invoke("wheat:bank:statement:select-file"),
  parseBankStatement: (payload: unknown) => ipcRenderer.invoke("wheat:bank:statement:parse", payload),
  reviewBankStatement: (payload: unknown) => ipcRenderer.invoke("wheat:bank:statement:review", payload),
  importBankStatement: async (payload: unknown) => {
    const prepared = await ipcRenderer.invoke("wheat:bank:statement:prepare", payload);
    return ipcRenderer.invoke("wheat:bank:statement:import", prepared);
  },
  setBankLedgerAccount: (payload: unknown) => ipcRenderer.invoke("wheat:bank:account:set-ledger", payload),
  createBankLedgerAccount: (payload: unknown) => ipcRenderer.invoke("wheat:bank:account:create-ledger", payload),
  queryReportEntries: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:entries", payload),
  getReportEntryDetail: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:entry-detail", payload),
  getTrialBalance: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:trial-balance", payload),
  getGeneralLedger: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:general-ledger", payload),
  getJournalReport: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:journal", payload),
  getAgedReceivables: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:aged-receivables", payload),
  getAgedPayables: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:aged-payables", payload),
  getCounterpartyStatement: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:counterparty-statement", payload),
  getAccountingIntegrity: (payload: unknown) => ipcRenderer.invoke("wheat:reporting:integrity-checks", payload),
  getBalanceFamily: (payload: unknown) => ipcRenderer.invoke("wheat:balance-family", payload),
  getBankTotal: (payload: unknown) => ipcRenderer.invoke("wheat:bank-total", payload),
  getBilan: (payload: unknown) => ipcRenderer.invoke("wheat:bilan", payload),
  previewOpeningBalance: (payload: unknown) => ipcRenderer.invoke("wheat:opening:preview", payload),
  postOpeningBalance: (payload: unknown) => ipcRenderer.invoke("wheat:opening:post", payload),
  generateFiscalPackage: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-package:generate", payload),
  validateFiscalPackage: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-package:validate", payload),
  addFiscalAdjustment: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-package:adjustment", payload),
  verifyFiscalAdjustment: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-package:adjustment:verify", payload),
  getFiscalTableCatalog: () => ipcRenderer.invoke("wheat:fiscal-table:catalog"),
  listFiscalTables: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:list", payload),
  getFiscalTable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:get", payload),
  refreshFiscalTable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:refresh", payload),
  saveFiscalTable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:save", payload),
  reviewFiscalTable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:review", payload),
  reopenFiscalTable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:reopen", payload),
  markFiscalTableNotApplicable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:not-applicable", payload),
  clearFiscalTableNotApplicable: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:not-applicable:clear", payload),
  attachFiscalTableEvidence: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:evidence:attach", payload),
  removeFiscalTableEvidence: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:evidence:remove", payload),
  getFiscalControl: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-table:control", payload),
  getWheatAiStatus: (payload: unknown) => ipcRenderer.invoke("wheat:ai:status", payload),
  benchmarkWheatAi: (payload: unknown) => ipcRenderer.invoke("wheat:ai:benchmark", payload),
  installWheatAiModel: (payload: unknown) => ipcRenderer.invoke("wheat:ai:install", payload),
  uninstallWheatAiModel: (payload: unknown) => ipcRenderer.invoke("wheat:ai:uninstall", payload),
  selectWheatAiModel: (payload: unknown) => ipcRenderer.invoke("wheat:ai:select", payload),
  configureWheatAi: (payload: unknown) => ipcRenderer.invoke("wheat:ai:configure", payload),
  startWheatAiOllama: () => ipcRenderer.invoke("wheat:ai:ollama:start"),
  listWheatAiTools: () => ipcRenderer.invoke("wheat:ai:tools"),
  executeWheatAiTool: (payload: unknown) => ipcRenderer.invoke("wheat:ai:execute-tool", payload),
  executeWheatAiPlan: (payload: unknown) => ipcRenderer.invoke("wheat:ai:execute-plan", payload),
  chatWithWheatAi: (payload: unknown) => ipcRenderer.invoke("wheat:ai:chat", payload),
  confirmWheatAiAction: (payload: unknown) => ipcRenderer.invoke("wheat:ai:confirm-action", payload),
  cancelWheatAiAction: (payload: unknown) => ipcRenderer.invoke("wheat:ai:cancel-action", payload),
  onWheatAiProgress: (listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("wheat:ai:progress", wrapped);
    return () => ipcRenderer.removeListener("wheat:ai:progress", wrapped);
  },
  /**
   * The shared pre-submission review. Called by every screen just before it
   * asks a domain service to change something, and by nothing else: it reads
   * the dossier and returns an opinion, it never mutates.
   */
  reviewBeforeMutation: (payload: unknown) => ipcRenderer.invoke("wheat:review:run", payload),
  getReviewCoverage: () => ipcRenderer.invoke("wheat:review:coverage"),
  /** Which model would review, so the surface can name it while it waits. */
  getReviewModel: () => ipcRenderer.invoke("wheat:review:model"),
  /**
   * Unfinished form contents.
   *
   * `saveFormDraft` is called as somebody types, debounced by the caller;
   * `discardFormDraft` only ever after a submission the domain service
   * confirmed, or when the person says to throw the work away. Navigating away
   * calls neither, which is the entire point.
   */
  saveFormDraft: (payload: unknown) => ipcRenderer.invoke("wheat:draft:save", payload),
  loadFormDraft: (payload: unknown) => ipcRenderer.invoke("wheat:draft:load", payload),
  listFormDrafts: (payload: unknown) => ipcRenderer.invoke("wheat:draft:list", payload),
  discardFormDraft: (payload: unknown) => ipcRenderer.invoke("wheat:draft:discard", payload),
  /**
   * Initial preparation of a dossier. `getDossierSetup` reads how far it has
   * got; `unlockDossier` is the accountant's approval that the foundation is
   * right, and is the last time this surface gates anything.
   */
  getDossierSetup: (payload: unknown) => ipcRenderer.invoke("wheat:setup:state", payload),
  setDossierSituation: (payload: unknown) => ipcRenderer.invoke("wheat:setup:situation", payload),
  unlockDossier: (payload: unknown) => ipcRenderer.invoke("wheat:setup:unlock", payload),
  getGuidedJourney: (payload: unknown) => ipcRenderer.invoke("wheat:journey:state", payload),
  /**
   * Guided work. `state` and `prepare` only read and propose; `approve` is the
   * one method that writes, and it performs exactly the operation ids it is
   * given — each re-validated by the domain service that owns it.
   */
  getDocumentPagePreview: (payload: unknown) => ipcRenderer.invoke("wheat:document:page-preview", payload),
  getGuidedWork: (payload: unknown) => ipcRenderer.invoke("wheat:guided:state", payload),
  prepareGuidedStep: (payload: unknown) => ipcRenderer.invoke("wheat:guided:prepare", payload),
  approveGuidedStep: (payload: unknown) => ipcRenderer.invoke("wheat:guided:approve", payload),
  decideGuidedStep: (payload: unknown) => ipcRenderer.invoke("wheat:guided:decide", payload),
  getSettingsWorkspace: (payload: unknown) => ipcRenderer.invoke("wheat:settings:workspace", payload),
  updateCompanySettings: (payload: unknown) => ipcRenderer.invoke("wheat:settings:company:update", payload),
  saveFiscalYear: (payload: unknown) => ipcRenderer.invoke("wheat:settings:fiscal-year:save", payload),
  saveAccount: (payload: unknown) => ipcRenderer.invoke("wheat:settings:account:save", payload),
  setAccountActive: (payload: unknown) => ipcRenderer.invoke("wheat:settings:account:archive", payload),
  saveJournal: (payload: unknown) => ipcRenderer.invoke("wheat:settings:journal:save", payload),
  setJournalActive: (payload: unknown) => ipcRenderer.invoke("wheat:settings:journal:archive", payload),
  saveBankAccount: (payload: unknown) => ipcRenderer.invoke("wheat:settings:bank-account:save", payload),
  setBankAccountActive: (payload: unknown) => ipcRenderer.invoke("wheat:settings:bank-account:archive", payload),
  updateEntryDraft: (payload: unknown) => ipcRenderer.invoke("wheat:entry:update-draft", payload),
  listPayrollRuns: (payload: unknown) => ipcRenderer.invoke("wheat:payroll:runs", payload),
  voidPayrollRun: (payload: unknown) => ipcRenderer.invoke("wheat:payroll:void", payload),
  stageLedgerImport: (payload: unknown) => ipcRenderer.invoke("wheat:ledger-import:stage", payload),
  listLedgerImports: (payload: unknown) => ipcRenderer.invoke("wheat:ledger-import:list", payload),
  confirmLedgerImport: (payload: unknown) => ipcRenderer.invoke("wheat:ledger-import:confirm", payload),
  cancelLedgerImport: (payload: unknown) => ipcRenderer.invoke("wheat:ledger-import:cancel", payload),
  verifyAuditChain: (payload: unknown) => ipcRenderer.invoke("wheat:audit:verify", payload),
  listAuditEvents: (payload: unknown) => ipcRenderer.invoke("wheat:audit:events", payload),
  getTaxWorkspace: (payload: unknown) => ipcRenderer.invoke("wheat:tax:workspace", payload),
  saveTaxConfigurationDraft: (payload: unknown) => ipcRenderer.invoke("wheat:tax:config:save-draft", payload),
  activateTaxConfiguration: (payload: unknown) => ipcRenderer.invoke("wheat:tax:config:activate", payload),
  cloneTaxConfiguration: (payload: unknown) => ipcRenderer.invoke("wheat:tax:config:clone", payload),
  listVatWorkpapers: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:list", payload),
  getVatWorkpaper: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:get", payload),
  generateVatWorkpaper: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:generate", payload),
  regenerateVatWorkpaper: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:regenerate", payload),
  addVatWorkpaperAdjustment: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:add-adjustment", payload),
  attachVatWorkpaperEvidence: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:attach-evidence", payload),
  removeVatWorkpaperEvidence: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:remove-evidence", payload),
  reviewVatWorkpaper: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:review", payload),
  returnVatWorkpaperToDraft: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:return-to-draft", payload),
  recordVatWorkpaperFiled: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:record-filed", payload),
  reopenVatWorkpaper: (payload: unknown) => ipcRenderer.invoke("wheat:vat-workpaper:reopen", payload),
  previewFiscalClose: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-close:preview", payload),
  closeFiscalYear: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-close:close", payload),
  reopenFiscalYear: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-close:reopen", payload),
  listFiscalCloseRuns: (payload: unknown) => ipcRenderer.invoke("wheat:fiscal-close:runs", payload),
  listAuditSeals: (payload: unknown) => ipcRenderer.invoke("wheat:audit-seal:list", payload),
  createAuditSeal: (payload: unknown) => ipcRenderer.invoke("wheat:audit-seal:create", payload),
  verifyAuditSeal: (payload: unknown) => ipcRenderer.invoke("wheat:audit-seal:verify", payload),
  getSecurityStatus: () => ipcRenderer.invoke("wheat:security:status"),
  setupLocalLock: (payload: unknown) => ipcRenderer.invoke("wheat:security:setup", payload),
  disableLocalLock: (payload: unknown) => ipcRenderer.invoke("wheat:security:disable", payload),
  unlockLocalApp: (payload: unknown) => ipcRenderer.invoke("wheat:security:unlock", payload),
  lockLocalApp: () => ipcRenderer.invoke("wheat:security:lock"),
  touchLocalLock: () => ipcRenderer.invoke("wheat:security:touch"),
  listCounterparties: (payload: unknown) => ipcRenderer.invoke("wheat:counterparty:list", payload),
  createCounterparty: (payload: unknown) => ipcRenderer.invoke("wheat:counterparty:create", payload),
  updateCounterparty: (payload: unknown) => ipcRenderer.invoke("wheat:counterparty:update", payload),
  archiveCounterparty: (payload: unknown) => ipcRenderer.invoke("wheat:counterparty:archive", payload),
  restoreCounterparty: (payload: unknown) => ipcRenderer.invoke("wheat:counterparty:restore", payload),
  listInvoices: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:list", payload),
  createInvoiceDraft: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:create", payload),
  updateInvoiceDraft: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:update", payload),
  deleteInvoiceDraft: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:delete-draft", payload),
  postInvoice: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:post", payload),
  voidInvoice: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:void", payload),
  getInvoiceSettlement: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:settlement", payload),
  createCreditNoteDraft: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:credit:create", payload),
  updateCreditNoteDraft: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:credit:update", payload),
  postCreditNote: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:credit:post", payload),
  listInvoiceArtifacts: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:artifact:list", payload),
  verifyInvoiceArtifact: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:artifact:verify", payload),
  exportInvoiceArtifact: (payload: unknown) => ipcRenderer.invoke("wheat:invoice:artifact:export", payload),
  listPayments: (payload: unknown) => ipcRenderer.invoke("wheat:payment:list", payload),
  createPaymentDraft: (payload: unknown) => ipcRenderer.invoke("wheat:payment:create", payload),
  updatePaymentDraft: (payload: unknown) => ipcRenderer.invoke("wheat:payment:update", payload),
  deletePaymentDraft: (payload: unknown) => ipcRenderer.invoke("wheat:payment:delete-draft", payload),
  postPayment: (payload: unknown) => ipcRenderer.invoke("wheat:payment:post", payload),
  voidPayment: (payload: unknown) => ipcRenderer.invoke("wheat:payment:void", payload),
  allocatePayment: (payload: unknown) => ipcRenderer.invoke("wheat:payment:allocate", payload),
  reversePaymentAllocation: (payload: unknown) => ipcRenderer.invoke("wheat:payment:reverse-allocation", payload),
  uploadDocuments: (companyId: string) => ipcRenderer.invoke("wheat:documents:upload", companyId),
  selectDocumentFile: () => ipcRenderer.invoke("wheat:documents:select-file"),
  selectDocumentFiles: () => ipcRenderer.invoke("wheat:documents:select-files"),
  selectDocumentFolder: () => ipcRenderer.invoke("wheat:documents:select-folder"),
  /**
   * Progress of a running batch import, one event per document.
   *
   * A thirty-invoice import takes minutes whatever the pipeline does; without
   * this the window simply looked frozen.
   */
  onSmartOcrProgress: (listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("wheat:smart-ocr:progress", wrapped);
    return () => ipcRenderer.removeListener("wheat:smart-ocr:progress", wrapped);
  },
  /**
   * Absolute path of a file the user dropped onto the window.
   *
   * Electron removed the non-standard `File.path` property in version 32, so
   * the renderer's `dataTransfer.files` entries carry no path at all any more
   * and drag-and-drop import silently produced nothing. `webUtils` is the
   * supported replacement and can only be reached from the preload, which is
   * why it is bridged here rather than read in the renderer.
   *
   * Returns "" for anything that is not a real file (a dragged selection of
   * text, a folder on some platforms), so the caller can say why nothing
   * happened instead of failing quietly.
   */
  getDroppedFilePath: (file: unknown) => {
    try {
      return file instanceof File ? webUtils.getPathForFile(file) : "";
    } catch {
      return "";
    }
  },
  smartOcrProcess: (payload: unknown) => ipcRenderer.invoke("wheat:smart-ocr:process", payload),
  getPaddleOcrStatus: () => ipcRenderer.invoke("wheat:paddle-ocr:status"),
  updateDocumentExtraction: (payload: unknown) => ipcRenderer.invoke("wheat:document:update-extraction", payload),
  deleteDocument: (documentId: string) => ipcRenderer.invoke("wheat:document:delete", documentId),
  postDocumentEntry: (documentId: string, kind?: "SALE" | "PURCHASE") => ipcRenderer.invoke("wheat:document:create-invoice-draft", documentId, kind),
  reclassifyInvoiceDraft: (payload: { invoiceId?: string; documentId?: string; kind: "SALE" | "PURCHASE" }) => ipcRenderer.invoke("wheat:invoice:reclassify-draft", payload),
  postPayrollEntry: (companyId: string, period?: string) => ipcRenderer.invoke("wheat:payroll:post", companyId, period),
  saveEmployee: (payload: unknown) => ipcRenderer.invoke("wheat:employee:save", payload),
  deleteEmployee: (employeeId: string) => ipcRenderer.invoke("wheat:employee:delete", employeeId),
  importFile: () => ipcRenderer.invoke("wheat:import:file"),
  exportFile: (payload: unknown) => ipcRenderer.invoke("wheat:export:file", payload),
  createBackup: () => ipcRenderer.invoke("wheat:backup:create"),
  getDatabasePath: () => ipcRenderer.invoke("wheat:database:path"),
  restoreBackup: () => ipcRenderer.invoke("wheat:backup:restore"),
  openPath: (target: string) => ipcRenderer.invoke("wheat:open-path", target),
  windowControl: (action: string) => ipcRenderer.invoke("wheat:window:control", action),
  restartApp: () => ipcRenderer.invoke("wheat:app:restart"),
  getUpdateStatus: () => ipcRenderer.invoke("wheat:update:status"),
  confirmUpdateStartup: () => ipcRenderer.invoke("wheat:update:confirm-startup"),
  checkForUpdates: () => ipcRenderer.invoke("wheat:update:check"),
  // Look, fetch, restart — three deliberate acts, never one. Nothing is
  // downloaded until `downloadUpdate`, and Wheat never closes until
  // `installUpdate`.
  downloadUpdate: () => ipcRenderer.invoke("wheat:update:download"),
  installUpdate: () => ipcRenderer.invoke("wheat:update:install"),
  postponeUpdate: () => ipcRenderer.invoke("wheat:update:postpone"),
  acknowledgeInstalledUpdate: () => ipcRenderer.invoke("wheat:update:acknowledge"),
  onUpdateStatus: (listener: (payload: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("wheat:update:status", wrapped);
    return () => ipcRenderer.removeListener("wheat:update:status", wrapped);
  },
  onWillRestart: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("wheat:app:will-restart", wrapped);
    return () => ipcRenderer.removeListener("wheat:app:will-restart", wrapped);
  },

  // --- Wheat AI providers (OpenRouter / Groq) --------------------------------
  // These return masked metadata only. An API key travels one way: renderer ->
  // main, inside `setWheatAiProviderKey`. It never travels back.
  getWheatAiProviderStatus: (payload?: unknown) => ipcRenderer.invoke("wheat:ai:provider:status", payload),
  setWheatAiProviderKey: (payload: unknown) => ipcRenderer.invoke("wheat:ai:provider:set-key", payload),
  deleteWheatAiProviderKey: (payload: unknown) => ipcRenderer.invoke("wheat:ai:provider:delete-key", payload),
  testWheatAiProvider: (payload: unknown) => ipcRenderer.invoke("wheat:ai:provider:test", payload),
  setWheatAiProviderPreferences: (payload: unknown) => ipcRenderer.invoke("wheat:ai:provider:preferences", payload),
  listWheatAiProviderModels: (payload?: unknown) => ipcRenderer.invoke("wheat:ai:provider:models", payload),
};

contextBridge.exposeInMainWorld("wheat", wheat);
