export {};

declare global {
  interface Window {
    /** The Wheat renderer bridge, published by `electron/preload.ts`. */
    wheat?: WheatBridge;
    /**
     * Hidden compatibility alias for the same object. It exists so packaged
     * renderer bundles and existing automated tests keep working; it is never
     * referenced in the interface.
     */
  }

  interface WheatBridge {
      getBootstrap: (companyId?: string) => Promise<any>;
      getSageExportEntries: (companyId: string) => Promise<any[]>;
      getSageExportProfile: (companyId: string) => Promise<any | null>;
      saveSageExportProfile: (payload: unknown) => Promise<any>;
      updateUserName: (payload: unknown) => Promise<any>;
      createCompany: (payload: unknown) => Promise<any>;
      resetWorkspace: (payload: unknown) => Promise<any>;
      deleteCompany: (companyId: string) => Promise<any>;
      createEntry: (payload: unknown) => Promise<any>;
      previewPieceNumber: (payload: unknown) => Promise<{ pieceNumber: string; sequence: number; fiscalYearId: string; fiscalYearLabel: string }>;
      postEntry: (entryId: string) => Promise<any>;
      duplicateEntry: (entryId: string) => Promise<any>;
      reverseEntry: (entryId: string, date?: string) => Promise<any>;
      deleteEntry: (entryId: string) => Promise<any>;
      lockFiscalPeriod: (payload: { companyId: string; fiscalYearId: string; lockedTo: string }) => Promise<any>;
      unlockFiscalPeriod: (payload: { companyId: string; fiscalYearId: string }) => Promise<any>;
      getReconciliationWorkspace: (payload: unknown) => Promise<any>;
      getReconciliationCandidates: (payload: unknown) => Promise<any>;
      confirmReconciliation: (payload: unknown) => Promise<any>;
      voidReconciliation: (payload: unknown) => Promise<any>;
      excludeBankMovement: (payload: unknown) => Promise<any>;
      restoreBankMovement: (payload: unknown) => Promise<any>;
      selectBankStatementFile: () => Promise<{ name: string; extension: string; bytesBase64: string } | null>;
      parseBankStatement: (payload: unknown) => Promise<any>;
      reviewBankStatement: (payload: unknown) => Promise<any>;
      importBankStatement: (payload: unknown) => Promise<any>;
      setBankLedgerAccount: (payload: unknown) => Promise<any>;
      createBankLedgerAccount: (payload: unknown) => Promise<any>;
      queryReportEntries: (payload: unknown) => Promise<any>;
      getReportEntryDetail: (payload: unknown) => Promise<any>;
      getTrialBalance: (payload: unknown) => Promise<any>;
      getGeneralLedger: (payload: unknown) => Promise<any>;
      getJournalReport: (payload: unknown) => Promise<any>;
      getAgedReceivables: (payload: unknown) => Promise<any>;
      getAgedPayables: (payload: unknown) => Promise<any>;
      getCounterpartyStatement: (payload: unknown) => Promise<any>;
      getAccountingIntegrity: (payload: unknown) => Promise<any>;
      getBalanceFamily: (payload: unknown) => Promise<any>;
      getBankTotal: (payload: unknown) => Promise<any>;
      getBilan: (payload: unknown) => Promise<any>;
      previewOpeningBalance: (payload: unknown) => Promise<any>;
      postOpeningBalance: (payload: unknown) => Promise<any>;
      generateFiscalPackage: (payload: unknown) => Promise<any>;
      validateFiscalPackage: (payload: unknown) => Promise<any>;
      addFiscalAdjustment: (payload: unknown) => Promise<any>;
      verifyFiscalAdjustment: (payload: unknown) => Promise<any>;
      getFiscalTableCatalog: () => Promise<any>;
      listFiscalTables: (payload: unknown) => Promise<any>;
      getFiscalTable: (payload: unknown) => Promise<any>;
      refreshFiscalTable: (payload: unknown) => Promise<any>;
      saveFiscalTable: (payload: unknown) => Promise<any>;
      reviewFiscalTable: (payload: unknown) => Promise<any>;
      reopenFiscalTable: (payload: unknown) => Promise<any>;
      markFiscalTableNotApplicable: (payload: unknown) => Promise<any>;
      clearFiscalTableNotApplicable: (payload: unknown) => Promise<any>;
      attachFiscalTableEvidence: (payload: unknown) => Promise<any>;
      removeFiscalTableEvidence: (payload: unknown) => Promise<any>;
      getFiscalControl: (payload: unknown) => Promise<any>;
      getWheatAiStatus: (payload: unknown) => Promise<any>;
      benchmarkWheatAi: (payload: unknown) => Promise<any>;
      installWheatAiModel: (payload: unknown) => Promise<any>;
      uninstallWheatAiModel: (payload: unknown) => Promise<any>;
      selectWheatAiModel: (payload: unknown) => Promise<any>;
      configureWheatAi: (payload: unknown) => Promise<any>;
      startWheatAiOllama: () => Promise<any>;
      listWheatAiTools: () => Promise<any[]>;
      executeWheatAiTool: (payload: unknown) => Promise<any>;
      executeWheatAiPlan: (payload: unknown) => Promise<any>;
      chatWithWheatAi: (payload: unknown) => Promise<any>;
      confirmWheatAiAction: (payload: unknown) => Promise<any>;
      cancelWheatAiAction: (payload: unknown) => Promise<any>;
      onWheatAiProgress: (listener: (payload: any) => void) => () => void;
      /**
       * Unfinished form contents, kept until the person decides. Never
       * accounting data: a draft becomes one only through the domain service
       * that owns the write.
       */
      saveFormDraft?: (payload: { companyId: string | undefined; entity: string; draftKey: string; payload: unknown; baseVersion?: number | null }) => Promise<{ updatedAt: string; revision: number }>;
      loadFormDraft?: (payload: { companyId: string | undefined; entity: string; draftKey: string; currentVersion?: number | null }) => Promise<{ payload: unknown; updatedAt: string; stale: boolean } | null>;
      listFormDrafts?: (payload: { companyId: string | undefined }) => Promise<Array<{ entity: string; draftKey: string; payload: unknown; updatedAt: string }>>;
      discardFormDraft?: (payload: { companyId: string | undefined; entity: string; draftKey: string }) => Promise<{ discarded: boolean }>;
      /** Initial preparation of a dossier, and the approval that ends it. */
      getDossierSetup?: (payload: { companyId: string }) => Promise<WheatDossierSetup>;
      setDossierSituation?: (payload: { companyId: string; situation: string }) => Promise<WheatDossierSetup>;
      unlockDossier?: (payload: { companyId: string }) => Promise<WheatDossierSetup>;
      reviewBeforeMutation: (payload: { companyId: string; workflowId: string; draft?: Record<string, unknown>; requested?: boolean }) => Promise<WheatReviewResult>;
      getReviewCoverage: () => Promise<WheatWorkflowCoverage>;
      getReviewModel: () => Promise<WheatReviewModelDescriptor>;
      getGuidedJourney: (payload: { companyId?: string }) => Promise<WheatJourneyState>;
      /**
       * Guided work. The first three read and propose; only `approveGuidedStep`
       * writes, and it performs exactly the operation ids it is handed.
       */
      getGuidedWork: (payload: { companyId?: string }) => Promise<any>;
      prepareGuidedStep: (payload: { companyId: string; stepId: string }) => Promise<any>;
      approveGuidedStep: (payload: { companyId: string; stepId: string; operationIds: string[] }) => Promise<any>;
      decideGuidedStep: (payload: { companyId: string; stepId: string; decision: "POSTPONED" | "NOT_APPLICABLE" | "RESUMED"; note?: string }) => Promise<any>;
      getSettingsWorkspace: (payload: unknown) => Promise<any>;
      updateCompanySettings: (payload: unknown) => Promise<any>;
      getDocumentPagePreview: (payload: unknown) => Promise<{
        page: number;
        pageCount: number;
        mimeType: string;
        base64: string;
        rendered: boolean;
        reason: string | null;
      }>;
      saveFiscalYear: (payload: unknown) => Promise<any>;
      saveAccount: (payload: unknown) => Promise<any>;
      setAccountActive: (payload: unknown) => Promise<any>;
      saveJournal: (payload: unknown) => Promise<any>;
      setJournalActive: (payload: unknown) => Promise<any>;
      saveBankAccount: (payload: unknown) => Promise<any>;
      setBankAccountActive: (payload: unknown) => Promise<any>;
      updateEntryDraft: (payload: unknown) => Promise<any>;
      listPayrollRuns: (payload: unknown) => Promise<any>;
      voidPayrollRun: (payload: unknown) => Promise<any>;
      stageLedgerImport: (payload: unknown) => Promise<any>;
      listLedgerImports: (payload: unknown) => Promise<any>;
      confirmLedgerImport: (payload: unknown) => Promise<any>;
      cancelLedgerImport: (payload: unknown) => Promise<any>;
      verifyAuditChain: (payload: unknown) => Promise<any>;
      listAuditEvents: (payload: unknown) => Promise<any>;
      getTaxWorkspace: (payload: unknown) => Promise<any>;
      saveTaxConfigurationDraft: (payload: unknown) => Promise<any>;
      activateTaxConfiguration: (payload: unknown) => Promise<any>;
      cloneTaxConfiguration: (payload: unknown) => Promise<any>;
      listVatWorkpapers: (payload: unknown) => Promise<any>;
      getVatWorkpaper: (payload: unknown) => Promise<any>;
      generateVatWorkpaper: (payload: unknown) => Promise<any>;
      regenerateVatWorkpaper: (payload: unknown) => Promise<any>;
      addVatWorkpaperAdjustment: (payload: unknown) => Promise<any>;
      attachVatWorkpaperEvidence: (payload: unknown) => Promise<any>;
      removeVatWorkpaperEvidence: (payload: unknown) => Promise<any>;
      reviewVatWorkpaper: (payload: unknown) => Promise<any>;
      returnVatWorkpaperToDraft: (payload: unknown) => Promise<any>;
      recordVatWorkpaperFiled: (payload: unknown) => Promise<any>;
      reopenVatWorkpaper: (payload: unknown) => Promise<any>;
      previewFiscalClose: (payload: unknown) => Promise<any>;
      closeFiscalYear: (payload: unknown) => Promise<any>;
      reopenFiscalYear: (payload: unknown) => Promise<any>;
      listFiscalCloseRuns: (payload: unknown) => Promise<any>;
      listAuditSeals: (payload: unknown) => Promise<any>;
      createAuditSeal: (payload: unknown) => Promise<any>;
      verifyAuditSeal: (payload: unknown) => Promise<any>;
      getSecurityStatus: () => Promise<any>;
      setupLocalLock: (payload: unknown) => Promise<any>;
      disableLocalLock: (payload: unknown) => Promise<any>;
      unlockLocalApp: (payload: unknown) => Promise<any>;
      lockLocalApp: () => Promise<any>;
      touchLocalLock: () => Promise<any>;
      listCounterparties: (payload: unknown) => Promise<any>;
      createCounterparty: (payload: unknown) => Promise<any>;
      updateCounterparty: (payload: unknown) => Promise<any>;
      archiveCounterparty: (payload: unknown) => Promise<any>;
      restoreCounterparty: (payload: unknown) => Promise<any>;
      listInvoices: (payload: unknown) => Promise<any>;
      createInvoiceDraft: (payload: unknown) => Promise<any>;
      updateInvoiceDraft: (payload: unknown) => Promise<any>;
      deleteInvoiceDraft: (payload: unknown) => Promise<any>;
      postInvoice: (payload: unknown) => Promise<any>;
      voidInvoice: (payload: unknown) => Promise<any>;
      getInvoiceSettlement: (payload: unknown) => Promise<any>;
      createCreditNoteDraft: (payload: unknown) => Promise<any>;
      updateCreditNoteDraft: (payload: unknown) => Promise<any>;
      postCreditNote: (payload: unknown) => Promise<any>;
      listInvoiceArtifacts: (payload: unknown) => Promise<any>;
      verifyInvoiceArtifact: (payload: unknown) => Promise<any>;
      exportInvoiceArtifact: (payload: unknown) => Promise<any>;
      listPayments: (payload: unknown) => Promise<any>;
      createPaymentDraft: (payload: unknown) => Promise<any>;
      updatePaymentDraft: (payload: unknown) => Promise<any>;
      deletePaymentDraft: (payload: unknown) => Promise<any>;
      postPayment: (payload: unknown) => Promise<any>;
      voidPayment: (payload: unknown) => Promise<any>;
      allocatePayment: (payload: unknown) => Promise<any>;
      reversePaymentAllocation: (payload: unknown) => Promise<any>;
      /** Recognises everything selected, and reports what it refused. */
      uploadDocuments: (companyId: string) => Promise<{ documents: any[]; rejections: Array<{ path: string; reason: string }>; truncated: boolean }>;
      selectDocumentFile: () => Promise<string | null>;
      selectDocumentFiles: () => Promise<{ accepted: string[]; rejections: Array<{ path: string; reason: string }>; truncated: boolean }>;
      selectDocumentFolder: () => Promise<{ accepted: string[]; rejections: Array<{ path: string; reason: string }>; truncated: boolean }>;
      /** One event per document while a batch import runs. */
      onSmartOcrProgress: (listener: (payload: any) => void) => () => void;
      /** Absolute path of a dropped File, via the preload's `webUtils` bridge. */
      getDroppedFilePath: (file: unknown) => string;
      smartOcrProcess: (payload: unknown) => Promise<{ documents: any[]; rejections: Array<{ path: string; reason: string }>; truncated: boolean }>;
      getPaddleOcrStatus: () => Promise<{ available: boolean; version: string | null; language: string; device: string; reason: string | null; vl16Installed?: boolean }>;
      updateDocumentExtraction: (payload: unknown) => Promise<any>;
      deleteDocument: (documentId: string) => Promise<any>;
      /** `kind` is supplied only when a person settles a direction the document could not establish. */
      postDocumentEntry: (documentId: string, kind?: "SALE" | "PURCHASE") => Promise<any>;
      reclassifyInvoiceDraft: (payload: { invoiceId?: string; documentId?: string; kind: "SALE" | "PURCHASE" }) => Promise<any>;
      postPayrollEntry: (companyId: string, period?: string) => Promise<any>;
      saveEmployee: (payload: unknown) => Promise<any>;
      deleteEmployee: (employeeId: string) => Promise<any>;
      importFile: () => Promise<{ name: string; extension: string; bytesBase64: string } | null>;
      exportFile: (payload: { suggestedName: string; bytesBase64: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
      createBackup: () => Promise<string | null>;
      getDatabasePath: () => Promise<string>;
      restoreBackup: () => Promise<string | null>;
      openPath: (target: string) => Promise<void>;
      windowControl: (action: "minimize" | "toggle-maximize" | "focus" | "close") => Promise<boolean | null>;
      restartApp: () => Promise<{ restarting: boolean }>;
      getUpdateStatus: () => Promise<WheatUpdateStatus>;
      confirmUpdateStartup: () => Promise<WheatUpdateStatus>;
      checkForUpdates: () => Promise<WheatUpdateStatus>;
      /** Fetches and verifies the offered release. Only ever called because the person asked. */
      downloadUpdate: () => Promise<WheatUpdateStatus>;
      /** Restarts Wheat into the installer. Flush drafts before calling this. */
      installUpdate: () => Promise<WheatUpdateStatus>;
      postponeUpdate: () => Promise<WheatUpdateStatus>;
      acknowledgeInstalledUpdate: () => Promise<WheatUpdateStatus>;
      onUpdateStatus: (listener: (status: WheatUpdateStatus) => void) => () => void;
      onWillRestart: (listener: () => void) => () => void;

      // --- Wheat AI providers (OpenRouter / Groq) ----------------------------
      // Masked metadata only: an API key never travels back to the renderer.
      getWheatAiProviderStatus?: (payload?: { refreshModels?: boolean }) => Promise<WheatAiProviderStatus>;
      setWheatAiProviderKey?: (payload: { provider: WheatAiProviderId; apiKey: string }) => Promise<WheatAiProviderStatus>;
      deleteWheatAiProviderKey?: (payload: { provider: WheatAiProviderId }) => Promise<WheatAiProviderStatus>;
      testWheatAiProvider?: (payload: { provider: WheatAiProviderId }) => Promise<WheatAiProviderTestResult>;
      setWheatAiProviderPreferences?: (payload: Partial<WheatAiProviderPreferences>) => Promise<WheatAiProviderStatus>;
      listWheatAiProviderModels?: (payload?: { refresh?: boolean }) => Promise<WheatAiProviderModelList>;
  }

  type WheatAiProviderId = "openrouter" | "groq";

  type WheatAiProviderPreferences = {
    activeProvider: WheatAiProviderId | "auto";
    automaticFreeModels: boolean;
    pinnedModelId: string | null;
    groqFreeTierConfirmed?: boolean;
    /** Opt-in AI re-reading of scanned documents. Off by default. */
    documentAiReview: boolean;
    documentAiReviewModelId: string | null;
    /**
     * The shared pre-submission review layer. On by default: with no model
     * reachable it is exactly the deterministic accounting preflight.
     */
    assistedReview?: boolean;
    /** Informed consent for a remote provider to read dossier extracts. */
    assistedReviewRemoteConsent?: boolean;
    /** `null` is automatic; otherwise `ollama:<name>` or `remote:<provider>:<model>`. */
    assistedReviewModelId?: string | null;
  };

  type WheatAiProviderStatus = {
    secureStorageAvailable: boolean;
    secureStorageNote: string;
    providers: Array<{
      id: WheatAiProviderId;
      label: string;
      configured: boolean;
      maskedKey: string | null;
      keyUpdatedAt: string | null;
      lastTestedAt: string | null;
      lastTestOk: boolean | null;
      lastTestMessage: string | null;
      freeModelCount: number | null;
    }>;
    preferences: WheatAiProviderPreferences;
    activeSelection: { provider: WheatAiProviderId | null; modelId: string | null; label: string; reason: string };
    maxFailoverAttempts: number;
  };

  type WheatAiProviderTestResult = {
    ok: boolean;
    message: string;
    freeModelCount: number | null;
    sampleModelId: string | null;
  };

  type WheatAiProviderModelList = {
    models: Array<{
      id: string;
      selectionId: string;
      provider: WheatAiProviderId;
      label: string;
      contextTokens: number;
      supportsTools: boolean;
      score: number;
      rankingReason: string;
    }>;
    rejected: Array<{ provider: WheatAiProviderId; id: string; reason: string }>;
    errors: Array<{ provider: WheatAiProviderId; message: string }>;
  };

  /**
   * The shared review result, mirrored from `electron/wheatReview.ts`.
   *
   * Kept as an explicit renderer-side declaration rather than an import: the
   * renderer never pulls main-process modules into its bundle.
   */
  type WheatReviewFinding = {
    code: string;
    severity: "INFO" | "WARNING" | "BLOCKER";
    origin: "DETERMINISTIC" | "MODEL";
    title: string;
    explanation: string;
    target: string | null;
    evidence: string[];
    currentValue: string | null;
    proposedValue: string | null;
    confidence: number | null;
    accountingReason: string;
    safeAutofix: boolean;
    requiresAcknowledgement: boolean;
  };

  /**
   * How far a dossier has got through its initial preparation.
   *
   * `mode` is the gate: while it is "SETUP" the application keeps the person in
   * guided work, because a dossier without an exercise, a chart, journals and a
   * VAT regime cannot be worked in coherently. It becomes "UNLOCKED" once and
   * never goes back.
   */
  type WheatDossierSetup = {
    companyId: string;
    mode: "SETUP" | "UNLOCKED";
    isTestDossier: boolean;
    situation: "NEW" | "EXISTING" | "DOCUMENTS" | null;
    situationOptions: Array<{ value: "NEW" | "EXISTING" | "DOCUMENTS"; title: string; detail: string }>;
    question: { prompt: string; why: string; whereToFind: string } | null;
    stages: Array<{ id: string; title: string; why: string; done: boolean; blocking: boolean }>;
    readyToUnlock: boolean;
    blockingReason: string | null;
    outstanding: string[];
    summary: string[];
  };

  type WheatReviewResult = {
    version: "WHEAT_REVIEW_1";
    workflowId: string;
    workflowLabel: string;
    entity: string;
    classification: "REVIEW_REQUIRED" | "DETERMINISTIC_ONLY" | "EXEMPT";
    riskLevel: 0 | 1 | 2 | 3;
    outcome: "PASS" | "WARNING" | "ATTENTION_REQUIRED";
    blocked: boolean;
    checked: string[];
    confirmed: string[];
    findings: WheatReviewFinding[];
    question: { prompt: string; why: string; whereToFind: string } | null;
    nextAction: string;
    model: {
      ran: boolean;
      status: "LOCAL" | "REMOTE" | "UNAVAILABLE" | "NOT_APPLICABLE" | "DECLINED" | "FAILED" | "NOT_NEEDED";
      provider: string | null;
      modelId: string | null;
      locality: "LOCAL" | "REMOTE" | "NONE";
      /** Free of provider and model identifiers; those are in `detail`. */
      message: string;
      detail: string | null;
    };
    acknowledgementRequired: boolean;
    reviewedAt: string;
  };

  /**
   * Which model would run a review, known before one is asked for.
   *
   * `selection` separates a model the person chose from one Wheat ranked, which
   * the waiting surface says out loud: a chosen model that fails is reported as
   * having failed, never replaced without telling them.
   */
  type WheatReviewModelDescriptor = {
    available: boolean;
    locality: "LOCAL" | "REMOTE" | "NONE";
    provider: string | null;
    modelId: string | null;
    selection: "EXPLICIT" | "AUTOMATIC" | "NONE";
    /** Free of provider and model identifiers: it is read during bookkeeping. */
    message: string;
    /** The identifiers, for settings, diagnostics and the details disclosure. */
    detail?: string | null;
  };

  type WheatWorkflowCoverage = {
    version: string;
    total: number;
    mutating: number;
    byClassification: { REVIEW_REQUIRED: number; DETERMINISTIC_ONLY: number; EXEMPT: number };
    workflows: Array<{
      id: string;
      channel: string;
      label: string;
      entity: string;
      mutating: boolean;
      classification: "REVIEW_REQUIRED" | "DETERMINISTIC_ONLY" | "EXEMPT";
      reason: string;
      reviewKind: string | null;
      capabilityId: string | null;
      riskLevel: number;
    }>;
    reviewKinds: string[];
    implementedReviewKinds: string[];
  };

  type WheatJourneyStage = {
    id: string;
    order: number;
    title: string;
    status: "DONE" | "READY" | "BLOCKED" | "NEEDS_ANSWER";
    why: string;
    state: string;
    action: { label: string; target: string } | null;
    question: { prompt: string; why: string; whereToFind: string } | null;
    blockedBy: string | null;
  };

  type WheatJourneyState = {
    version: "WHEAT_JOURNEY_1";
    companyId: string | null;
    companyName: string | null;
    stages: WheatJourneyStage[];
    completed: number;
    total: number;
    next: WheatJourneyStage | null;
    inferred: string[];
    computedAt: string;
  };
}

type WheatUpdateStatus = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "verifying" | "ready" | "installing" | "awaiting-confirmation" | "updated" | "error";
  source: string;
  currentVersion: string;
  availableVersion?: string;
  availableRelease?: { version: string; releaseDate: string; notes: string[] };
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  automaticInstallationEnabled: boolean;
  /** Real bytes while downloading. `totalBytes`/`percent` are null when the size is unknown. */
  download?: { transferredBytes: number; totalBytes: number | null; percent: number | null };
  /** The person chose "Plus tard": still offered in Réglages, no longer interrupting. */
  postponed?: boolean;
  installedUpdate?: {
    version: string;
    releaseDate: string;
    notes: string[];
    installedAt: string;
  };
};
