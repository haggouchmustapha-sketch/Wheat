import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  readSmartFields,
  readSmartType,
  smartFieldFromInput,
  smartFieldLabels,
  stringifyFields,
  visibleSmartFields,
} from "./lib/smartFields";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Banknote,
  BarChart3,
  BookOpen,
  Building2,
  Calendar,
  ChevronLeft,
  CheckCircle2,
  LoaderCircle,
  ChevronRight,
  Command,
  Copy,
  DatabaseBackup,
  Download,
  Eye,
  FileSearch,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FileUp,
  Filter,
  HelpCircle,
  HardDrive,
  Landmark,
  Lightbulb,
  Languages,
  LayoutDashboard,
  Lock,
  ListChecks,
  Moon,
  Percent,
  Pencil,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scale,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Users,
  Wrench,
  Wand2,
  FolderOpen,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { createDemoData } from "./data/demoData";
import { date, daysBetween, money, statusLabel } from "./lib/format";
import { exactDecimalFromCents, formatExactCentsForUi, tryParseExactDecimalCents } from "./lib/exactDecimal";
import {
  buildSageTxtLines,
  buildSageTxtRows,
  encodeSageWindows1252,
  validateSageTxtExport,
  type SageOutputKind,
  type SageTxtProfile,
} from "./lib/sageTxt";
import { OperationalAccounting, ReconciliationWorkbench } from "./components/OperationalAccounting";
import { BooksWorkspace13 } from "./components/BooksWorkspace13";
import { ComplianceWorkspace14 } from "./components/ComplianceWorkspace14";
import { FiscalWorkspace, WheatAiWorkspace } from "./components/FiscalWorkspace";
import { WheatSelect, type WheatSelectOption } from "./components/ui/WheatSelect";
import { WheatAiMark, WheatMark } from "./components/ui/brand";
import { WheatAiProviderSettings } from "./components/WheatAiProviderSettings";
import { UpdateDownloadProgress, WheatUpdateNotices } from "./components/WheatUpdate";
import { formatUpdateDateTime, updateStatusLabel } from "./lib/updateStatus";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Explainer,
  Field,
  FeatureTile,
  HelpDisclosure,
  IconButton,
  InfoTip,
  IssueList,
  LoadingState,
  NextStep,
  PageHeader,
  SearchInput,
  Section,
  Stat,
  Switch,
  TableWrap,
  type GuideItem,
  type Tone,
} from "./components/ui";
import { bankImportIssues } from "./lib/bankImportIssues";
import { issuesOfSeverity } from "./lib/wheatIssues";
import { resetAccessibleDialogState, useAccessibleDialog } from "./lib/useAccessibleDialog";
import { useViewportAnchor } from "./lib/useViewportAnchor";
import { useWheatReview } from "./lib/useWheatReview";
import { ocrCheckIssues } from "./lib/ocrCheckIssues";
import { flushAllFormDrafts, useDraftedForm } from "./lib/useFormDraft";
import { DossierSetupGate } from "./components/DossierSetupGate";
import { useGuidedJourney } from "./lib/useGuidedJourney";
import { GuidedJourney } from "./components/GuidedJourney";
import { GuidedWork } from "./components/GuidedWork";
import { clearTransientDocumentState, confirmWithAppFocus } from "./lib/confirmWithAppFocus";
import { WHEAT_APP_VERSION, WHEAT_RELEASE_LABEL } from "./appVersion";
import licenseText from "../LICENSE?raw";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./App.css";
import "./SingleFont.css";

const VatChart = lazy(() => import("./components/DashboardCharts").then((module) => ({ default: module.VatChart })));
const MetricSparkline = lazy(() => import("./components/DashboardCharts").then((module) => ({ default: module.MetricSparkline })));

type Page =
  | "home"
  | "guided"
  | "production"
  | "dashboard"
  | "companies"
  | "entries"
  | "documents"
  | "billing"
  | "reconciliation"
  | "vat"
  | "payroll"
  | "reports"
  | "books"
  | "fiscal"
  | "statements"
  | "wheat-ai"
  | "sage"
  | "assistant"
  | "settings";

type Toast = { id: number; tone: "success" | "info" | "warning"; message: string };
type LoadFailure = { message: string; databasePath?: string };
type UpdateStatus = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "verifying" | "ready" | "installing" | "awaiting-confirmation" | "updated" | "error";
  source: string;
  currentVersion: string;
  availableVersion?: string;
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  automaticInstallationEnabled: boolean;
  availableRelease?: { version: string; releaseDate: string; notes: string[] };
  download?: { transferredBytes: number; totalBytes: number | null; percent: number | null };
  postponed?: boolean;
  installedUpdate?: { version: string; releaseDate: string; notes: string[]; installedAt: string };
};
type BankImportDraft = {
  bankAccountId: string;
  file: { name: string; extension: string; bytesBase64: string };
  sourceSha256: string;
  parsed: {
    format: string;
    formatLabel: string;
    parser: string;
    headers: string[];
    rows: Array<Record<string, string>>;
    previewRows: Array<Record<string, string>>;
    suggestedMapping: Record<string, string | undefined>;
    warnings: string[];
    currency: string | null;
    rowCount: number;
    /**
     * The balances the source states about itself, present only for formats
     * that declare them as machine-readable fields. Passed straight to the
     * import, which refuses a statement whose movements do not reconcile them.
     */
    declaredBalances?: { openingBalanceCents?: string; closingBalanceCents?: string };
    /**
     * How the scan was read, and by what.
     *
     * The pipeline already records which rows the assisted pass had to fill,
     * how well the page was reconstructed, and whether it recommends a second
     * look — and none of it reached this screen, so the assistance Wheat
     * promises for scanned statements was invisible exactly where it was used.
     * `assistedRows` are 1-based row numbers, always non-empty when a model
     * contributed anything, because a filled cell is a proposal to check.
     */
    ocr?: {
      engine: string;
      engineVersion: string;
      confidence: number;
      pageCount: number;
      local: true;
      assistedRows?: number[];
      fallbackRecommended?: boolean;
      confidenceDimensions?: { layout?: number; rowReconstruction?: number; fieldMapping?: number };
    };
  };
  complète: () => void;
};
type LocalSecurityStatus = {
  enabled: boolean;
  locked: boolean;
  lockOnStartup: boolean;
  idleMinutes: number;
  throttled: boolean;
  retryAfterMs: number;
  configurationError: boolean;
};
type AnalysisMessage = { role: "analysis" | "user"; text: string; source?: string };
type AnalysisResult = { text: string; source: string };
type AppLanguage = "fr" | "en" | "ar";
type ContextMenuAction = {
  label: string;
  icon?: any;
  tone?: "default" | "danger";
  disabled?: boolean;
  run: () => void | Promise<void>;
};
type ContextMenuState = {
  x: number;
  y: number;
  title?: string;
  actions: ContextMenuAction[];
} | null;

/**
 * Wheat 2.0 navigation.
 *
 * Every feature keeps its own visible entry: nothing is hidden behind an
 * overflow menu, a kebab or a keyboard-only shortcut. Entries are gathered in
 * labelled groups that follow the order of an accounting month, and each one
 * carries a plain-language description so a user who has never opened an
 * accounting package still knows what the screen is for.
 */
const navItems: Array<{ page: Page; label: string; icon: any }> = [
  { page: "home", label: "Accueil", icon: LayoutDashboard },
  { page: "guided", label: "Travail guidé", icon: Wand2 },
  { page: "production", label: "Production du jour", icon: Sparkles },
  { page: "dashboard", label: "Tableau de bord", icon: BarChart3 },
  { page: "companies", label: "Dossiers", icon: Building2 },
  { page: "entries", label: "Écritures", icon: BookOpen },
  { page: "documents", label: "Documents & OCR", icon: FileText },
  { page: "billing", label: "Factures & paiements", icon: Banknote },
  { page: "payroll", label: "Paie", icon: Users },
  { page: "reconciliation", label: "Banque & rapprochement", icon: Landmark },
  { page: "vat", label: "TVA", icon: Percent },
  { page: "statements", label: "Comptes & états", icon: Scale },
  { page: "fiscal", label: "Liasse fiscale", icon: FileSpreadsheet },
  { page: "reports", label: "Rapports comptables", icon: FileSearch },
  { page: "books", label: "Contrôles & imports", icon: ShieldCheck },
  { page: "sage", label: "Export Sage & FEC", icon: FileOutput },
  { page: "assistant", label: "Analyse locale", icon: Command },
  { page: "wheat-ai", label: "Wheat AI", icon: Sparkles },
  { page: "settings", label: "Réglages", icon: Settings },
];

type NavGroup = { id: string; label: Record<AppLanguage, string>; pages: Page[] };

const navGroups: NavGroup[] = [
  {
    id: "pilotage",
    label: { fr: "Pilotage", en: "Overview", ar: "القيادة" },
    pages: ["home", "guided", "production", "dashboard"],
  },
  {
    id: "dossiers",
    label: { fr: "Dossiers", en: "Client files", ar: "الملفات" },
    pages: ["companies"],
  },
  {
    id: "saisie",
    label: { fr: "Saisie & pièces", en: "Bookkeeping", ar: "القيد والوثائق" },
    pages: ["entries", "documents", "billing", "payroll"],
  },
  {
    id: "banque",
    label: { fr: "Banque", en: "Banking", ar: "البنك" },
    pages: ["reconciliation"],
  },
  {
    id: "fiscal",
    label: { fr: "Fiscalité & clôture", en: "Tax & closing", ar: "الجباية" },
    pages: ["vat", "statements", "fiscal"],
  },
  {
    id: "analyse",
    label: { fr: "Rapports & contrôles", en: "Reports & controls", ar: "التقارير" },
    pages: ["reports", "books", "sage", "assistant"],
  },
  {
    id: "assistance",
    label: { fr: "Assistance", en: "Assistance", ar: "المساعدة" },
    pages: ["wheat-ai"],
  },
  {
    id: "système",
    label: { fr: "Configuration", en: "Configuration", ar: "الإعدادات" },
    pages: ["settings"],
  },
];

/**
 * One sentence per screen, written for someone who has never used an
 * accounting package. Shown in the rail tooltip, the command palette and the
 * page header, so the same explanation follows the feature everywhere.
 */
const pagePurpose: Record<Page, string> = {
  home: "Le point de départ guidé : ce qu'il faut faire maintenant sur ce dossier.",
  guided: "Wheat analyse le dossier, prépare les opérations et vous les soumet : vous approuvez, rejetez ou corrigez.",
  production: "La file de travail du jour, dans l'ordre : pièces, OCR, comptabilisation, banque, TVA.",
  dashboard: "Les chiffres clés du dossier : trésorerie, encours clients, TVA et alertes.",
  companies: "Créer, ouvrir et basculer entre les dossiers (sociétés) gérés sur ce poste.",
  entries: "Saisir et comptabiliser les écritures, la brique de base de la comptabilité.",
  documents: "Importer factures et justificatifs, lire les montants automatiquement (OCR) et les contrôler.",
  billing: "Factures de vente et d'achat, avoirs, tiers et règlements.",
  payroll: "Salariés, éléments de paie et écriture comptable de la paie mensuelle.",
  reconciliation: "Importer les relevés bancaires et rapprocher chaque mouvement d'une écriture.",
  vat: "Préparer, contrôler et archiver la déclaration de TVA avec ses justificatifs.",
  statements: "Plan comptable (PCGE), balance, bilan, CPC et trésorerie du dossier.",
  fiscal: "Construire la liasse fiscale : tableaux, retraitements, contrôles et dossier de travail.",
  reports: "Éditer les rapports comptables : grand livre, balance, journaux, balances âgées, intégrité.",
  books: "Imports de balance ou de journal, paramétrage du dossier et contrôles de fiabilité.",
  sage: "Exporter les écritures vers Sage ou au format FEC, avec contrôle avant génération.",
  assistant: "Poser une question sur les données du dossier, calculée localement sans internet.",
  "wheat-ai": "L'assistant Wheat AI : il explique, cherche et prépare des actions que vous confirmez.",
  settings: "Profil, sécurité locale, exercices, sauvegardes, mises à jour et fournisseurs Wheat AI.",
};

/** Short "what happens here" label used on tiles and the command palette. */
const pageShortHelp: Record<Page, string> = {
  home: "Par où commencer",
  guided: "Wheat prépare, vous approuvez",
  production: "Traiter la journée",
  dashboard: "Voir les chiffres",
  companies: "Choisir le dossier",
  entries: "Saisir au journal",
  documents: "Lire les pièces",
  billing: "Facturer et encaisser",
  payroll: "Payer les salariés",
  reconciliation: "Pointer la banque",
  vat: "Déclarer la TVA",
  statements: "Comptes et bilan",
  fiscal: "Liasse fiscale",
  reports: "Éditer un rapport",
  books: "Importer et contrôler",
  sage: "Exporter vers Sage",
  assistant: "Interroger les données",
  "wheat-ai": "Demander à Wheat AI",
  settings: "Configurer Wheat",
};

const languageStorageKey = "wheat.language";
const railStorageKey = "wheat.navigation.collapsed";
/** Session-only hand-off between the production queue and the reconciliation desk. */
const reconciliationFocusKey = "wheat.reconciliation.focus";
/**
 * Session-only hand-off from guided work to the screen that owns a record.
 *
 * Guided work has to be leavable: every proposed operation names the document,
 * draft or movement it came from, and clicking it must land on that record
 * rather than on the top of a list. Session storage keeps that a navigation
 * detail rather than application state.
 */
const guidedFocusKey = "wheat.guided.focus";
/** Pre-2.0 key, read once so an existing install keeps its chosen language. */
const legacyLanguageStorageKey = "atlas-ledger-language";
const languageOptions: Array<{ value: AppLanguage; label: string; nativeName: string }> = [
  { value: "fr", label: "French", nativeName: "Francais" },
  { value: "en", label: "English", nativeName: "English" },
  { value: "ar", label: "Arabic", nativeName: "العربية" },
];

const navLabels: Record<AppLanguage, Partial<Record<Page, string>>> = {
  fr: {
    home: "Accueil",
    guided: "Travail guidé",
    production: "Production du jour",
    dashboard: "Tableau de bord",
    companies: "Dossiers",
    entries: "Écritures",
    documents: "Documents & OCR",
    billing: "Factures & paiements",
    payroll: "Paie",
    reconciliation: "Banque & rapprochement",
    vat: "TVA",
    statements: "Comptes & états",
    fiscal: "Liasse fiscale",
    reports: "Rapports comptables",
    books: "Contrôles & imports",
    sage: "Export Sage & FEC",
    assistant: "Analyse locale",
    "wheat-ai": "Wheat AI",
    settings: "Réglages",
  },
  en: {
    home: "Home",
    guided: "Guided work",
    production: "Daily production",
    dashboard: "Dashboard",
    companies: "Client files",
    entries: "Journal entries",
    documents: "Documents & OCR",
    billing: "Invoices & payments",
    payroll: "Payroll",
    reconciliation: "Bank & reconciliation",
    vat: "VAT",
    statements: "Accounts & statements",
    fiscal: "Tax return package",
    reports: "Accounting reports",
    books: "Controls & imports",
    sage: "Sage & FEC export",
    assistant: "Local analysis",
    "wheat-ai": "Wheat AI",
    settings: "Settings",
  },
  ar: {
    home: "الرئيسية",
    guided: "العمل الموجّه",
    production: "إنتاج اليوم",
    dashboard: "لوحة القيادة",
    companies: "الملفات",
    entries: "القيود",
    documents: "الوثائق",
    billing: "الفواتير والمدفوعات",
    payroll: "الأجور",
    reconciliation: "البنك والتسوية",
    vat: "TVA",
    statements: "الحسابات والقوائم",
    fiscal: "الحزمة الضريبية",
    reports: "التقارير",
    books: "الضوابط والاستيراد",
    sage: "تصدير Sage",
    assistant: "تحليل محلي",
    "wheat-ai": "Wheat AI",
    settings: "الإعدادات",
  },
};

const shellCopy: Record<AppLanguage, {
  search: string;
  activeCompany: string;
  noCompany: string;
  newCompany: string;
  newEntry: string;
  help: string;
  theme: string;
  settingsTitle: string;
  settingsSubtitle: string;
  preferences: string;
  profile?: string;
  profileName?: string;
  profileNameHint?: string;
  saveProfile?: string;
  appLanguage: string;
  appLanguageHint: string;
  darkOn: string;
  darkOff: string;
  cloud: string;
}> = {
  fr: {
    search: "Rechercher… (Ctrl+K)",
    activeCompany: "Société active",
    noCompany: "Aucun dossier",
    newCompany: "Nouveau dossier",
    newEntry: "Nouvelle écriture",
    help: "Aide",
    theme: "Changer le thème",
    settingsTitle: "Sécurité & réglages",
    settingsSubtitle: "Profil local, sauvegardes et préférences de ce poste.",
    preferences: "Préférences",
    profile: "Profil utilisateur",
    profileName: "Nom affiché",
    profileNameHint: "Ce nom apparaît dans la barre latérale et les journaux d'activité.",
    saveProfile: "Enregistrer le nom",
    appLanguage: "Langue de l'application",
    appLanguageHint: "Utilisée pour l'interface et les nouveaux écrans traduits.",
    darkOn: "Désactiver le mode sombre",
    darkOff: "Activer le mode sombre",
    cloud: "Données conservées localement · aucun compte cloud requis",
  },
  en: {
    search: "Search... (Ctrl+K)",
    activeCompany: "Active company",
    noCompany: "No company",
    newCompany: "New company",
    newEntry: "New entry",
    help: "Help",
    theme: "Change theme",
    settingsTitle: "Security & settings",
    settingsSubtitle: "Local profile, backups, and preferences for this computer.",
    preferences: "Preferences",
    profile: "User profile",
    profileName: "Display name",
    profileNameHint: "This name appears in the sidebar and activity logs.",
    saveProfile: "Save name",
    appLanguage: "Application language",
    appLanguageHint: "Used for the interface and newly translated screens.",
    darkOn: "Turn off dark mode",
    darkOff: "Turn on dark mode",
    cloud: "Stored locally · no cloud account required",
  },
  ar: {
    search: "بحث... (Ctrl+K)",
    activeCompany: "الشركة النشطة",
    noCompany: "لا توجد شركة",
    newCompany: "شركة جديدة",
    newEntry: "قيد جديد",
    help: "مساعدة",
    theme: "تغيير المظهر",
    settingsTitle: "الأمان والإعدادات",
    settingsSubtitle: "الأدوار، النسخ الاحتياطي، التفضيلات، والتحضير لوضع الخادم.",
    preferences: "التفضيلات",
    appLanguage: "لغة التطبيق",
    appLanguageHint: "تستخدم للواجهة والشاشات المترجمة الجديدة.",
    darkOn: "إيقاف الوضع الداكن",
    darkOff: "تشغيل الوضع الداكن",
    cloud: "البيانات محفوظة محليا · لا يلزم حساب سحابي",
  },
};

const pageCopy: Record<AppLanguage, Record<string, string>> = {
  fr: {
    productionTitle: "Production comptable",
    productionSubtitle: "Un seul écran pour traiter les pièces comme dans un cabinet: OCR, contrôle, comptabilisation, banque, TVA et exports.",
    productionHeroTitle: "Commencez ici chaque matin.",
    productionHeroText: "Wheat vous montre les dossiers à faire dans l'ordre. Chaque bouton lance une vraie action ou ouvre l'écran utile.",
    productionCollect: "Importer une pièce",
    productionReview: "Vérifier OCR",
    productionPost: "Comptabiliser",
    productionBank: "Ouvrir le rapprochement",
    productionVat: "Exporter TVA",
    productionQueue: "Files à traiter",
    productionNoQueue: "Aucun document en attente. Importez une facture ou un relevé pour commencer.",
    productionOpenDocuments: "Ouvrir documents",
    productionOpenBank: "Ouvrir banque",
    productionOpenReports: "Ouvrir rapports",
    productionPosted: "déjà comptabilisé",
    productionReady: "pret",
    entriesTitle: "Écritures comptables",
    entriesSubtitle: "Saisie manuelle, import Excel/CSV, validation debit/credit, périodes verrouillees et piste d'audit.",
    chartTitle: "Plan comptable CGNC",
    importExcelCsv: "Importer Excel/CSV",
    exportExcel: "Exporter Excel",
    exportPdf: "Exporter PDF",
    documentsTitle: "Documents & OCR",
    documentsSubtitle: "Nouveau moteur local: pretraitement image, OCR multi-passe, classification et export Excel structure.",
    ocrEngineLabel: "Moteur de lecture local",
    documentsHeroTitle: "Importez une pièce : Wheat la lit, la classe et prépare les données comptables.",
    documentsHeroText: "PDF, JPG, PNG, WEBP, HEIC, TIFF, Excel, CSV et TXT. Un seul fichier a la fois ; Wheat normalise les scans, relit les champs critiques et garde tout hors ligne.",
    importDocument: "Importer un document",
    importingDocument: "Analyse OCR en cours...",
    importOneFile: "Aucun fichier exploitable dans cette sélection.",
    importSuccess: "Document analyse, classe et organise",
    importEmpty: "Aucun document importé. Choisissez un fichier PDF, image, CSV ou TXT.",
    importFailed: "OCR impossible",
    importUnsupported: "Choisissez des fichiers PDF, image, CSV, TXT ou XLSX, ou un dossier qui en contient.",
    confidenceLabel: "Confiance",
    ocrDone: "Termine",
    ocrNeedsReview: "A vérifier",
    ocrPosted: "Comptabilisé",
    contextOpenFile: "Ouvrir le fichier",
    contextCopyOcr: "Copier le texte OCR",
    contextPostEntry: "Créer le brouillon de facture",
    contextDeleteDocument: "Supprimer le document",
    deleteDocumentConfirm: "Supprimer ce document OCR ? La copie classée par Wheat sera déplacée vers la Corbeille Windows.",
    deleteDocumentPostedConfirm: "Ce document est déjà comptabilisé. Supprimer le document OCR ne supprime pas l'écriture comptable. Continuer ?",
    deleteDocumentSuccess: "Document supprime",
    copiedOcrText: "Texte OCR copie",
    noOcrTextToCopy: "Aucun texte OCR a copier",
    exportExcelStructured: "Exporter Excel structure",
    pdfSummary: "Résumé PDF",
    analyzedDocuments: "Documents analyses",
    noOcrTitle: "Aucun document OCR",
    noOcrText: "Importez un PDF, une image, un CSV ou un TXT pour créer des données exploitables.",
    smartReview: "Revue intelligente",
    detectedTables: "Tables detectees",
    ocrText: "Texte OCR",
    openFile: "Ouvrir fichier",
    saveCorrections: "Enregistrer corrections",
    suggestedEntry: "Créer écriture suggeree",
    bankTitle: "Rapprochement bancaire",
    bankSubtitle: "Import de relevés et rapprochement vérifiable avec les écritures comptabilisées.",
    importStatement: "Importer relevé",
    noMovementTitle: "Aucun mouvement importé",
    noMovementText: "Importez un relevé CSV/XLSX pour générer les suggestions de rapprochement.",
    vatTitle: "TVA marocaine",
    vatSubtitle: "Suivi historique des montants TVA à vérifier avant toute déclaration.",
    isIrHelpers: "Aides IS / IR",
    payrollTitle: "Paie",
    payrollSubtitle: "Fiches employées, montants saisis et écritures de paie locales à vérifier.",
    exportPayroll: "Exporter paie",
    payslipsPdf: "Résumé PDF interne",
    generatePayrollEntry: "Générer écriture de paie",
    reportsTitle: "Rapports",
    reportsSubtitle: "Balance generale, grand livre, journal, balances agees et contrôles d'intégrité avec exports complets.",
    sageTitle: "Export Sage",
    sageSubtitle: "Profils Sage 100, Sage 50, Generation Experts et TXT/CSV personnalisable avec validation avant export.",
    assistantTitle: "Analyse locale",
    assistantSubtitle: "Réponses calculées uniquement à partir des données chargées pour la société active.",
    assistantPlaceholder: "Ex. : afficher les impayés de plus de 90 jours",
    assistantGreeting: "Interrogez vos écritures comptabilisées, factures, périodes de TVA et mouvements bancaires. Chaque réponse indique ses sources.",
    assistantInitialQuestion: "Afficher les fournisseurs impayés depuis plus de 90 jours.",
    assistantName: "Analyse locale",
    send: "Envoyer",
    backup: "Sauvegarder",
    restore: "Restaurer",
    openDb: "Ouvrir DB",
    activityLogs: "Journal d'activité",
    auditTrail: "Piste d'audit",
    auditActive: "Active",
    windowMinimize: "Reduire",
    windowToggleMaximize: "Agrandir / restaurer",
    windowClose: "Fermer",
    windowControls: "Contrôles de fenêtre",
    assistantCommand: "Ouvrir l'analyse locale",
    documentCommand: "Importer document",
    vatDeclaration: "Declaration TVA",
    createBackupCommand: "Créer une sauvegarde",
    commandPlaceholder: "Commandes Wheat",
    settingsSecurity: "Données locales",
    settingsBackups: "Sauvegardes",
    settingsStartReset: "Démarrer / reinitialiser",
    rolesValue: "Données privées sur ce poste",
    twoFactor: "Session",
    twoFactorOn: "Profil local actif",
    twoFactorReady: "Profil local",
    shortcuts: "Raccourcis",
    shortcutsValue: "Ctrl+K palette - Ctrl+N nouvelle écriture",
  },
  en: {
    productionTitle: "Accounting production",
    productionSubtitle: "One screen for the firm workflow: OCR, review, posting, bank matching, VAT, and exports.",
    productionHeroTitle: "Start here every morning.",
    productionHeroText: "Wheat shows the work in order. Every button either runs a real action or opens the right screen.",
    productionCollect: "Import document",
    productionReview: "Review OCR",
    productionPost: "Post entry",
    productionBank: "Match bank",
    productionVat: "Export VAT",
    productionQueue: "Work queue",
    productionNoQueue: "No document waiting. Import an invoice or statement to start.",
    productionOpenDocuments: "Open documents",
    productionOpenBank: "Open bank",
    productionOpenReports: "Open reports",
    productionPosted: "already posted",
    productionReady: "ready",
    entriesTitle: "Accounting entries",
    entriesSubtitle: "Manual entry, Excel/CSV import, debit/credit validation, locked periods, and audit trail.",
    chartTitle: "CGNC chart of accounts",
    importExcelCsv: "Import Excel/CSV",
    exportExcel: "Export Excel",
    exportPdf: "Export PDF",
    documentsTitle: "Documents & OCR",
    documentsSubtitle: "New local engine: image preprocessing, multi-pass OCR, classification, and structured Excel export.",
    ocrEngineLabel: "Local reading engine",
    documentsHeroTitle: "Import one document: Wheat reads it, files it, and préparés the accounting data.",
    documentsHeroText: "PDF, JPG, PNG, WEBP, HEIC, TIFF, Excel, CSV, and TXT. One file at a time; Wheat normalizes scans, re-reads critical fields, and keeps everything offline.",
    importDocument: "Import document",
    importingDocument: "OCR analysis in progress...",
    importOneFile: "Nothing usable in that selection.",
    importSuccess: "Document analyzed, classified, and organized",
    importEmpty: "No document imported. Choose a PDF, image, CSV, or TXT file.",
    importFailed: "OCR failed",
    importUnsupported: "Choose PDF, image, CSV, TXT or XLSX files, or a folder containing them.",
    confidenceLabel: "Confidence",
    ocrDone: "Done",
    ocrNeedsReview: "Review",
    ocrPosted: "Posted",
    contextOpenFile: "Open file",
    contextCopyOcr: "Copy OCR text",
    contextPostEntry: "Create entry",
    contextDeleteDocument: "Delete document",
    deleteDocumentConfirm: "Delete this OCR document? Wheat will move its filed copy to the Windows Recycle Bin.",
    deleteDocumentPostedConfirm: "This document is already posted. Deleting the OCR document will not delete the accounting entry. Continue?",
    deleteDocumentSuccess: "Document deleted",
    copiedOcrText: "OCR text copied",
    noOcrTextToCopy: "No OCR text to copy",
    exportExcelStructured: "Export structured Excel",
    pdfSummary: "PDF summary",
    analyzedDocuments: "Analyzed documents",
    noOcrTitle: "No OCR document",
    noOcrText: "Import a PDF, image, CSV, or TXT to create usable data.",
    smartReview: "Smart review",
    detectedTables: "Detected tables",
    ocrText: "OCR text",
    openFile: "Open file",
    saveCorrections: "Save corrections",
    suggestedEntry: "Create suggested entry",
    bankTitle: "Bank reconciliation",
    bankSubtitle: "Statement import, payment detection, confidence scores, and manual matching.",
    importStatement: "Import statement",
    noMovementTitle: "No imported movement",
    noMovementText: "Import a CSV/XLSX statement to generate reconciliation suggestions.",
    vatTitle: "Moroccan VAT",
    vatSubtitle: "Historical VAT tracking amounts that must be reviewed before filing.",
    isIrHelpers: "IS / IR helpers",
    payrollTitle: "Payroll",
    payrollSubtitle: "Employee records, entered payroll amounts, and local accounting entries for review.",
    exportPayroll: "Export payroll",
    payslipsPdf: "Internal payroll PDF",
    generatePayrollEntry: "Generate payroll entry",
    reportsTitle: "Reports",
    reportsSubtitle: "Trial balance, general ledger, journal, aging, and integrity checks with complete exports.",
    sageTitle: "Sage export",
    sageSubtitle: "Sage 100, Sage 50, Generation Experts, and custom TXT/CSV profiles with validation before export.",
    assistantTitle: "Local analysis",
    assistantSubtitle: "Answers are calculated only from records loaded for the active company.",
    assistantPlaceholder: "Ex: show unpaid invoices older than 90 days",
    assistantGreeting: "Ask about posted entries, invoices, VAT periods, or bank movements. Every answer names its sources.",
    assistantInitialQuestion: "Show unpaid suppliers older than 90 days.",
    assistantName: "Local analysis",
    send: "Send",
    backup: "Backup",
    restore: "Restore",
    openDb: "Open DB",
    activityLogs: "Activity logs",
    auditTrail: "Audit trail",
    auditActive: "Active",
    windowMinimize: "Minimize",
    windowToggleMaximize: "Maximize / restore",
    windowClose: "Close",
    windowControls: "Window controls",
    assistantCommand: "Open local analysis",
    documentCommand: "Import document",
    vatDeclaration: "VAT declaration",
    createBackupCommand: "Create backup",
    commandPlaceholder: "Wheat commands",
    settingsSecurity: "Local data",
    settingsBackups: "Backups",
    settingsStartReset: "Start / reset",
    rolesValue: "Private data on this computer",
    twoFactor: "Session",
    twoFactorOn: "Local profile active",
    twoFactorReady: "Local profile",
    shortcuts: "Shortcuts",
    shortcutsValue: "Ctrl+K palette - Ctrl+N new entry",
  },
  ar: {
    entriesTitle: "القيود المحاسبية",
    entriesSubtitle: "ادخال يدوي، استيراد Excel/CSV، تحقق مدين/دائن، وفترات مقفلة.",
    chartTitle: "مخطط الحسابات CGNC",
    importExcelCsv: "استيراد Excel/CSV",
    exportExcel: "تصدير Excel",
    exportPdf: "تصدير PDF",
    documentsTitle: "منظم OCR الذكي",
    documentsSubtitle: "قراءة وتصنيف وارشفة تلقائية وتصدير Excel منظم للوثائق الممسوحة.",
    documentsHeroTitle: "استورد وثيقة واحدة، وWheat يصنفها وينظم بياناتها.",
    documentsHeroText: "PDF وJPG وPNG وWEBP وHEIC وTIFF وCSV وTXT. اختر ملفا واحدا في كل مرة.",
    importDocument: "استيراد وثيقة",
    importingDocument: "Analyse OCR en cours...",
    importOneFile: "Aucun fichier exploitable dans cette sélection.",
    importSuccess: "Document analyse, classe et organise",
    importEmpty: "Aucun document importé. Choisissez un fichier PDF, image, CSV ou TXT.",
    importFailed: "OCR impossible",
    importUnsupported: "Choisissez des fichiers PDF, image, CSV, TXT ou XLSX, ou un dossier qui en contient.",
    exportExcelStructured: "تصدير Excel منظم",
    pdfSummary: "ملخص PDF",
    analyzedDocuments: "الوثائق المحللة",
    noOcrTitle: "لا توجد وثيقة OCR",
    noOcrText: "استورد PDF او صورة او CSV او TXT لانشاء بيانات قابلة للاستعمال.",
    smartReview: "مراجعة ذكية",
    detectedTables: "الجداول المكتشفة",
    ocrText: "نص OCR",
    openFile: "فتح الملف",
    saveCorrections: "حفظ التصحيحات",
    suggestedEntry: "انشاء قيد مقترح",
    bankTitle: "مطابقة البنك",
    bankSubtitle: "استيراد الكشوفات، كشف المدفوعات، درجات الثقة، والمطابقة اليدوية.",
    importStatement: "استيراد كشف",
    noMovementTitle: "لا توجد حركة مستوردة",
    noMovementText: "استورد كشف CSV/XLSX لانشاء اقتراحات المطابقة.",
    vatTitle: "TVA المغرب",
    vatSubtitle: "تتبع تاريخي لمبالغ الضريبة على القيمة المضافة، مع مراجعة إلزامية قبل أي تصريح خارجي.",
    isIrHelpers: "مساعدات IS / IR",
    payrollTitle: "الأجور",
    payrollSubtitle: "بيانات الموظفين والمبالغ المدخلة وقيود الأجور المحلية التي تتطلب المراجعة.",
    exportPayroll: "تصدير الاجور",
    payslipsPdf: "ملخص PDF داخلي",
    generatePayrollEntry: "انشاء قيد الاجور",
    reportsTitle: "التقارير",
    reportsSubtitle: "ميزان المراجعة ودفتر الأستاذ واليومية وتقارير الآجال وفحوصات النزاهة مع تصدير كامل.",
    assistantTitle: "تحليل محلي",
    assistantSubtitle: "إجابات محسوبة فقط من بيانات الشركة النشطة المحمّلة.",
    assistantPlaceholder: "مثال: عرض الفواتير غير المدفوعة",
    send: "ارسال",
    backup: "نسخ احتياطي",
    restore: "استرجاع",
    openDb: "فتح DB",
    activityLogs: "سجل النشاط",
  },
};

const readStoredLanguage = (): AppLanguage => {
  if (typeof window === "undefined") return "fr";
  // Reads the Wheat key first, then falls back to the pre-2.0 key so an
  // existing installation keeps the language the user already chose.
  const stored = window.localStorage.getItem(languageStorageKey) ?? window.localStorage.getItem(legacyLanguageStorageKey);
  return languageOptions.some((option) => option.value === stored) ? (stored as AppLanguage) : "fr";
};

const languageName = (language: AppLanguage) => languageOptions.find((option) => option.value === language)?.nativeName ?? "Francais";

const navLabel = (page: Page, language: AppLanguage) => navLabels[language]?.[page] ?? navLabels.fr[page] ?? page;

const sparkData = [
  { name: "Jan", value: 82 },
  { name: "Fév", value: 91 },
  { name: "Mar", value: 88 },
  { name: "Avr", value: 102 },
  { name: "Mai", value: 118 },
  { name: "Juin", value: 111 },
];

const bytesFromBase64 = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const textFromBase64 = (base64: string) => new TextDecoder("utf-8").decode(bytesFromBase64(base64));
const base64FromArrayBuffer = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
};
const base64FromText = (text: string) => base64FromArrayBuffer(new TextEncoder().encode(text).buffer as ArrayBuffer);
const initialsFromName = (name?: string) => {
  const parts = String(name ?? "Wheat")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "AL";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
};

const createDefaultSageProfile = (): SageTxtProfile => ({
  profileType: "Sage 100 TXT — 10 champs vérifiés",
  outputKind: "TXT",
  encoding: "windows-1252",
  includeHeader: false,
  accountLength: "VARIABLE",
  journalMappings: {},
  accountMappings: {},
  thirdPartyMappings: {},
  requireJournalMapping: true,
});

/**
 * Per-dossier Sage profile cache key. The literal keeps its pre-2.0 spelling so
 * an existing installation keeps the profile it already saved; it is a
 * localStorage key, never a label shown in the interface.
 */
const sageProfileKey = (companyId?: string) => `wheat.sage.profile.${companyId ?? "default"}`;
/** Pre-rename key, read once so an existing install keeps its saved Sage mapping. */
const legacySageProfileKey = (companyId?: string) => `atlas-ledger-sage-profile-${companyId ?? "default"}`;

function App() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState<Page>("home");
  const [activeCompanyId, setActiveCompanyId] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [employeeEditor, setEmployeeEditor] = useState<{ employee?: any } | null>(null);
  const [bankImportDraft, setBankImportDraft] = useState<BankImportDraft | null>(null);
  /** Set when a recognised document could not be attributed to this dossier. */
  const [directionChoice, setDirectionChoice] = useState<{ documentId: string; message: string } | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(railStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [language, setLanguage] = useState<AppLanguage>(() => readStoredLanguage());
  const [alertsMuted, setAlertsMuted] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /*
   * What Wheat is doing right now, when it is doing something slow.
   *
   * Several operations reach the disk or the OCR sidecar and take seconds or
   * minutes — a full dossier backup, a restore, reading a scanned statement —
   * and used to show nothing at all while they ran. From the outside that is
   * indistinguishable from a frozen application, and the usual response to a
   * frozen application is to press the button again.
   *
   * One label rather than a flag per button, because the useful thing to say
   * is *what* is happening, not merely that something is. It is cleared in a
   * `finally`: a failure must resolve the loading state, or the screen stays
   * busy forever over an error the person already dismissed.
   */
  const [runningTask, setRunningTask] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [browserPreview, setBrowserPreview] = useState(false);
  const [knownDatabasePath, setKnownDatabasePath] = useState<string | undefined>();
  const [appContextMenu, setAppContextMenu] = useState<ContextMenuState>(null);
  const [securityStatus, setSecurityStatus] = useState<LocalSecurityStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const loadRequestId = useRef(0);
  const dataRef = useRef(data);
  const knownDatabasePathRef = useRef(knownDatabasePath);
  useEffect(() => {
    dataRef.current = data;
    knownDatabasePathRef.current = knownDatabasePath;
  }, [data, knownDatabasePath]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now();
    setToasts((items) => [...items, { id, tone, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((toast) => toast.id !== id)), 3800);
  }, []);

  useEffect(() => {
    if (!data || !window.wheat?.confirmUpdateStartup) return;
    window.wheat.confirmUpdateStartup().then((status) => setUpdateStatus(status as UpdateStatus)).catch(() => undefined);
  }, [data]);

  const clearTransientUiState = useCallback(() => {
    setQuery("");
    setCommandOpen(false);
    setEntryModalOpen(false);
    setCompanyModalOpen(false);
    setEmployeeEditor(null);
    setBankImportDraft(null);
    setAppContextMenu(null);
    resetAccessibleDialogState();
    clearTransientDocumentState();
  }, []);

  const load = useCallback(async (companyId?: string) => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setLoadFailure(null);
    try {
      if (window.wheat?.getSecurityStatus) {
        try {
          const currentSecurity = await window.wheat.getSecurityStatus();
          if (requestId !== loadRequestId.current) return;
          setSecurityStatus(currentSecurity);
          if (currentSecurity.enabled && currentSecurity.locked) {
            setData(null);
            setBrowserPreview(false);
            return;
          }
        } catch (securityError) {
          // Let bootstrap surface the database's recovery-safe error. A damaged
          // database cannot answer the independent local-lock status query.
          console.warn("Local lock status is unavailable during bootstrap", securityError);
        }
      }
      const bootstrap = window.wheat ? await window.wheat.getBootstrap(companyId) : createDemoData();
      if (requestId !== loadRequestId.current) return;
      setData(bootstrap);
      setActiveCompanyId(bootstrap.activeCompanyId);
      setBrowserPreview(!window.wheat);
      setKnownDatabasePath(bootstrap.databasePath);
      knownDatabasePathRef.current = bootstrap.databasePath;
    } catch (error) {
      if (requestId !== loadRequestId.current) return;
      console.error(error);
      const message = error instanceof Error ? error.message : "Impossible de charger Wheat";
      let databasePath = (error as { databasePath?: string } | null)?.databasePath ?? dataRef.current?.databasePath;
      if (!databasePath && window.wheat?.getDatabasePath) {
        try {
          databasePath = await window.wheat.getDatabasePath();
          if (requestId !== loadRequestId.current) return;
          setKnownDatabasePath(databasePath);
          knownDatabasePathRef.current = databasePath;
        } catch {
          // Recovery still works even when the path cannot be resolved.
        }
      }
      setLoadFailure({
        message,
        databasePath: databasePath ?? knownDatabasePathRef.current,
      });
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => window.wheat?.onWillRestart?.(clearTransientUiState), [clearTransientUiState]);

  useEffect(() => {
    let active = true;
    window.wheat?.getUpdateStatus?.().then((status) => {
      if (active) setUpdateStatus(status as UpdateStatus);
    }).catch(() => undefined);
    const unsubscribe = window.wheat?.onUpdateStatus?.((status) => {
      if (active) setUpdateStatus(status as UpdateStatus);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!securityStatus?.enabled || securityStatus.locked || !window.wheat?.getSecurityStatus) return;
    let lastTouch = 0;
    const check = async () => {
      try {
        const status = await window.wheat!.getSecurityStatus();
        setSecurityStatus(status);
        if (status.locked) setData(null);
      } catch {
        // A protected operation will surface any persistent local-lock error.
      }
    };
    const activity = () => {
      const now = Date.now();
      if (now - lastTouch < 30_000) return;
      lastTouch = now;
      window.wheat?.touchLocalLock?.().then(setSecurityStatus).catch(() => undefined);
    };
    const interval = window.setInterval(check, 15_000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [securityStatus?.enabled, securityStatus?.locked]);

  useEffect(() => {
    try {
      window.localStorage.setItem(railStorageKey, railCollapsed ? "1" : "0");
    } catch {
      // A locked-down profile can refuse storage; the rail simply resets next launch.
    }
  }, [railCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(languageStorageKey, language);
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        const target = event.target instanceof Element ? event.target : null;
        if (isEditableKeyboardTarget(event.target) && !target?.closest(".topbar-search")) return;
        event.preventDefault();
        setCommandOpen(true);
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (isEditableKeyboardTarget(event.target)) return;
        if (data?.companies?.length) setEntryModalOpen(true);
        else setCompanyModalOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [data]);

  useEffect(() => {
    if (!appContextMenu) return;
    const closeMenu = () => setAppContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [appContextMenu]);

  const currentCompany = useMemo(
    () => data?.companies?.find((company: any) => company.id === activeCompanyId) ?? data?.companies?.[0],
    [data, activeCompanyId],
  );

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data?.entries ?? [];
    return (data?.entries ?? []).filter((entry: any) =>
      [entry.number, entry.pieceNumber, entry.label, entry.journal?.code, entry.status].join(" ").toLowerCase().includes(needle),
    );
  }, [data, query]);

  const metrics = useMemo(() => buildMetrics(data), [data]);

  // The guided journey is derived further down the component; a ref keeps
  // `refresh` — used by every screen — free of that ordering constraint.
  const reloadJourneyRef = useRef<(() => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    await load(activeCompanyId);
    await reloadJourneyRef.current?.();
  }, [activeCompanyId, load]);
  const operationalNotify = useCallback((message: string, tone: "info" | "success" | "warning" | "error") => {
    notify(message, tone === "error" ? "warning" : tone);
  }, [notify]);

  const checkForUpdates = useCallback(async () => {
    if (!window.wheat?.checkForUpdates) throw new Error("La recherche de mises à jour est disponible uniquement dans l'application desktop.");
    const status = await window.wheat.checkForUpdates() as UpdateStatus;
    setUpdateStatus(status);
    if (status.phase === "up-to-date") notify("Wheat est à jour.", "success");
    if (status.phase === "error") notify(status.error ?? "Impossible de vérifier les mises à jour.", "warning");
    return status;
  }, [notify]);

  /**
   * Fetches and verifies the offered release. Runs only because somebody
   * pressed "Mettre à jour"; the check that found it downloaded nothing.
   */
  const downloadUpdate = useCallback(async () => {
    if (!window.wheat?.downloadUpdate) return;
    setUpdateBusy(true);
    try {
      const status = await window.wheat.downloadUpdate() as UpdateStatus;
      setUpdateStatus(status);
      if (status.phase === "ready" && !status.automaticInstallationEnabled) {
        notify("Mise à jour vérifiée. Cette version de Wheat ne l'installe pas automatiquement.", "info");
      }
      if (status.phase === "error") notify(status.error ?? "Le téléchargement de la mise à jour a échoué.", "warning");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Le téléchargement de la mise à jour a échoué.", "warning");
    } finally {
      setUpdateBusy(false);
    }
  }, [notify]);

  /**
   * Restarts into the installer, and only ever from an explicit click.
   *
   * Queued drafts are written first: autosave runs 700ms behind the keystroke,
   * which is ample for every ordinary close but not for a restart the person
   * triggers a moment after typing. This is the existing draft system being
   * flushed, not a second one.
   */
  const installUpdate = useCallback(async () => {
    if (!window.wheat?.installUpdate) return;
    setUpdateBusy(true);
    try {
      await flushAllFormDrafts();
      const status = await window.wheat.installUpdate() as UpdateStatus;
      setUpdateStatus(status);
      if (status.phase === "error") notify(status.error ?? "L'installation de la mise à jour n'a pas pu démarrer.", "warning");
    } catch (error) {
      notify(error instanceof Error ? error.message : "L'installation de la mise à jour n'a pas pu démarrer.", "warning");
    } finally {
      setUpdateBusy(false);
    }
  }, [notify]);

  /** "Plus tard": the offer stays in Réglages, it simply stops interrupting. */
  const postponeUpdate = useCallback(async () => {
    setUpdateStatus((current) => current ? { ...current, postponed: true } : current);
    await window.wheat?.postponeUpdate?.().then((status) => setUpdateStatus(status as UpdateStatus)).catch(() => undefined);
  }, []);

  const acknowledgeInstalledUpdate = useCallback(async () => {
    setUpdateStatus((current) => current ? { ...current, phase: "up-to-date", installedUpdate: undefined } : current);
    await window.wheat?.acknowledgeInstalledUpdate?.().catch(() => undefined);
  }, []);

  const updateActions = useMemo(() => ({
    download: () => { void downloadUpdate(); },
    install: () => { void installUpdate(); },
    postpone: () => { void postponeUpdate(); },
    acknowledge: () => { void acknowledgeInstalledUpdate(); },
  }), [downloadUpdate, installUpdate, postponeUpdate, acknowledgeInstalledUpdate]);

  const unlockLocalApp = async (pin: string) => {
    if (!window.wheat?.unlockLocalApp) return;
    try {
      const status = await window.wheat.unlockLocalApp({ pin });
      setSecurityStatus(status);
      await load(activeCompanyId);
    } catch (error) {
      try {
        if (window.wheat.getSecurityStatus) setSecurityStatus(await window.wheat.getSecurityStatus());
      } catch {
        // Keep the prior lock status if the database itself cannot be read.
      }
      throw error;
    }
  };

  const setupLocalLock = async (payload: unknown) => {
    if (!window.wheat?.setupLocalLock) throw new Error("Le verrou local n'est disponible que dans l'application desktop.");
    const status = await window.wheat.setupLocalLock(payload);
    setSecurityStatus(status);
    notify("Verrou local activé sur cet ordinateur.", "success");
  };

  const disableLocalLock = async (pin: string) => {
    if (!window.wheat?.disableLocalLock) return;
    const status = await window.wheat.disableLocalLock({ pin });
    setSecurityStatus(status);
    notify("Verrou local désactivé.", "success");
  };

  const mapBankLedgerAccount = async (payload: { companyId: string; bankAccountId: string; ledgerAccountId: string }) => {
    if (!window.wheat?.setBankLedgerAccount) throw new Error("La configuration bancaire n'est disponible que dans l'application desktop.");
    await window.wheat.setBankLedgerAccount(payload);
    notify("Compte comptable bancaire associé. Le rapprochement peut maintenant utiliser ses lignes comptabilisées.", "success");
    await refresh();
  };

  const createBankLedgerAccount = async (payload: { companyId: string; bankAccountId: string; code: string; label: string }) => {
    if (!window.wheat?.createBankLedgerAccount) throw new Error("La création de compte bancaire n'est disponible que dans l'application desktop.");
    await window.wheat.createBankLedgerAccount(payload);
    notify("Sous-compte 514 créé et associé au compte bancaire.", "success");
    await refresh();
  };

  const lockLocalApp = async () => {
    if (!window.wheat?.lockLocalApp) return;
    const status = await window.wheat.lockLocalApp();
    setSecurityStatus(status);
    setData(null);
  };

  // The shared pre-submission review. One instance for the whole shell, so
  // every screen shows the same surface and only one can be open at a time.
  const { request: requestReview, element: reviewSurface } = useWheatReview(
    activeCompanyId,
    notify,
    // "Changer de modèle" leads where the reviewing model is actually chosen,
    // rather than telling the person to go and find it.
    () => setPage("settings"),
  );

  /**
   * Whether this dossier has been prepared far enough to be worked in.
   *
   * A dossier with no exercise, no chart, no journals and no VAT regime is not
   * a dossier somebody should be entering invoices into: whatever they enter
   * will have to be unpicked once the foundation is laid under it. So until the
   * accountant has approved that foundation, Wheat keeps them in guided work —
   * which prepares each missing piece and submits it for approval — and in the
   * two places they must always be able to reach, the dossier list and the
   * settings.
   *
   * The gate is deliberately one-way and deliberately narrow. It ends the first
   * time somebody approves the foundation and never returns, a dossier named
   * TEST never enters it at all, and a setup state that cannot be read leaves
   * the application open rather than locking somebody out of their own books.
   */
  const [dossierSetup, setDossierSetup] = useState<WheatDossierSetup | null>(null);
  /**
   * Keyed to the dossier whose records are on screen, not to `activeCompanyId`.
   *
   * The two can differ — `currentCompany` falls back to the first loaded
   * dossier when the active id names one the workspace has not loaded — and
   * gating on the wrong one is how a person ends up locked out of a dossier
   * they are looking at because a different one is unfinished.
   */
  const gatedCompanyId = currentCompany?.id;
  const refreshDossierSetup = useCallback(async () => {
    if (!gatedCompanyId || !window.wheat?.getDossierSetup) return setDossierSetup(null);
    try {
      setDossierSetup(await window.wheat.getDossierSetup({ companyId: gatedCompanyId }));
    } catch {
      setDossierSetup(null);
    }
  }, [gatedCompanyId]);
  /*
   * Re-read on dossier change, on navigation, and whenever the dossier gains
   * its first real content.
   *
   * The gate opens permanently once a dossier holds entries, invoices or
   * documents — it exists to stop somebody bookkeeping into an incoherent
   * foundation, not to stand in front of a dossier that is plainly already in
   * use. That verdict is computed in the main process from the records, so the
   * rail only learns of it when it asks again. Asking only on navigation meant
   * that creating the dossier's first entry from guided work, or through Wheat
   * AI, left the rail locked until the person happened to change screens.
   */
  const dossierContentMarker = [
    (data?.entries ?? []).length,
    (data?.invoices ?? []).length,
    (data?.documents ?? []).length,
  ].join("/");
  useEffect(() => { void refreshDossierSetup(); }, [refreshDossierSetup, data?.company?.id, page, dossierContentMarker]);

  const dossierLocked = dossierSetup?.mode === "SETUP";
  /**
   * Reachable while a dossier is still being prepared.
   *
   * The gate withholds accounting *output*, not the means of building the
   * dossier. Everything listed here is part of getting it ready — guided work
   * prepares the foundation, the referentials are where a chart, journals and a
   * VAT regime are created by hand for anybody who would rather do it
   * themselves, documents is where the pieces come in, and a person must always
   * be able to reach another dossier or their settings. What stays shut is
   * everything that would write or report on a ledger that is not yet coherent:
   * entries, invoicing, payroll, reconciliation, VAT, statements, the fiscal
   * package and the exports.
   *
   * Locking somebody out of the screen that creates accounts while demanding
   * they have a chart of accounts would not be a gate; it would be a trap.
   */
  const setupAllowedPages: Page[] = ["guided", "companies", "settings", "reports", "documents"];
  useEffect(() => {
    if (dossierLocked && !setupAllowedPages.includes(page)) setPage("guided");
  }, [dossierLocked, page]);
  const { journey, reload: reloadJourney } = useGuidedJourney(activeCompanyId);
  /**
   * Where a guided action leads.
   *
   * Most steps name a screen. A few name a specific editor, and those open it
   * in place: the person keeps the guided context they were working in, and
   * comes back to it when they save or cancel, instead of being left on a
   * settings tab to find the right panel themselves.
   */
  const [identityEditorOpen, setIdentityEditorOpen] = useState(false);
  /*
   * The statement batch the reconciliation desk opens on.
   *
   * Set by the import when somebody chooses to reconcile what they have just
   * imported, and cleared on leaving the desk so a later visit shows the whole
   * account rather than silently hiding most of it.
   */
  const [reconciliationBatch, setReconciliationBatch] = useState<{ bankAccountId: string; statementId: string } | undefined>(undefined);
  /** Bumped whenever a shell-level editor changes what guided work reads. */
  const [guidedRefreshToken, setGuidedRefreshToken] = useState(0);
  const openGuidedTarget = useCallback((target: string, recordId?: string | null) => {
    if (target === "dossier-identity") {
      setIdentityEditorOpen(true);
      return;
    }
    if (recordId) window.sessionStorage.setItem(guidedFocusKey, recordId);
    setPage(target as Page);
  }, []);

  useEffect(() => {
    reloadJourneyRef.current = reloadJourney;
  }, [reloadJourney]);

  /*
   * A batch filter belongs to the visit that arrived with it. Leaving the desk
   * ends that visit, so coming back later shows the whole account instead of a
   * filtered view whose reason has been forgotten.
   */
  useEffect(() => {
    if (page !== "reconciliation") setReconciliationBatch(undefined);
  }, [page]);

  const openAppContextMenu = (event: any, actions: ContextMenuAction[], title?: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!actions.length) return;
    setAppContextMenu({
      x: Math.max(12, Math.min(event.clientX, window.innerWidth - 260)),
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - 240)),
      title,
      actions,
    });
  };

  const runContextAction = async (action: ContextMenuAction) => {
    if (action.disabled) return;
    setAppContextMenu(null);
    try {
      await action.run();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Action impossible", "warning");
    }
  };

  const copyToClipboard = async (value?: string, successMessage = "Copie effectuée") => {
    const text = String(value ?? "").trim();
    if (!text) return notify("Rien a copier", "info");

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = globalThis.document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      globalThis.document.body.appendChild(textarea);
      textarea.select();
      globalThis.document.execCommand("copy");
      textarea.remove();
    }
    notify(successMessage, "success");
  };

  const changeLanguage = (nextLanguage: AppLanguage) => {
    setLanguage(nextLanguage);
    notify(`Langue active: ${languageName(nextLanguage)}`, "success");
  };

  const switchCompany = async (companyId: string) => {
    clearTransientUiState();
    await load(companyId);
    notify("Société active mise à jour", "success");
  };

  const openEntryModal = () => {
    if (!currentCompany) {
      notify("Créez d'abord une société, puis ajoutez les écritures.", "warning");
      setCompanyModalOpen(true);
      return;
    }

    setEntryModalOpen(true);
  };

  const createCompany = async (payload: {
    name: string;
    legalForm: string;
    ice: string;
    taxId: string;
    city: string;
    fiscalYear?: number;
    fiscalYearStart?: string;
    fiscalYearEnd?: string;
    vatFrequency?: "MONTHLY" | "QUARTERLY";
  }) => {
    if (!window.wheat) {
      notify("Création de société disponible dans l'application desktop Electron", "warning");
      return;
    }

    const fiscalYear = payload.fiscalYear ?? new Date().getFullYear();
    const fiscalYearStart = payload.fiscalYearStart ?? `${fiscalYear}-01-01`;
    const fiscalYearEnd = payload.fiscalYearEnd ?? `${fiscalYear}-12-31`;
    const approval = await requestReview("company.create", { ...payload, fiscalYearStart, fiscalYearEnd });
    if (!approval.approved) return;

    try {
      const company = await window.wheat.createCompany({
        ...payload,
        fiscalYearStart,
        fiscalYearEnd,
      });
      setCompanyModalOpen(false);
      setPage("home");
      notify("Société créée. Votre espace comptable est prêt.", "success");
      await load(company.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Création de société impossible", "warning");
    }
  };

  const deleteCompany = async (company: any) => {
    if (!window.wheat?.deleteCompany) {
      notify("Suppression disponible dans l'application desktop Electron", "warning");
      return;
    }

    if (!confirmWithAppFocus(`Supprimer ${company.name} et toutes ses données locales ?`)) return;

    try {
      await window.wheat.deleteCompany(company.id);
      notify("Société supprimée", "success");
      await load(company.id === activeCompanyId ? undefined : activeCompanyId);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression société impossible", "warning");
    }
  };

  const resetWorkspace = async (mode: "blank" | "demo") => {
    if (!window.wheat) {
      notify("Réinitialisation disponible dans l'application desktop Electron", "warning");
      return;
    }

    const message = mode === "blank"
      ? "Cela va supprimer les sociétés et données de la base locale. Les copies de documents OCR resteront sur disque afin qu'une restauration soit possible. Continuer ?"
      : "Cela va remplacer la base locale par les données de démonstration. Les copies de documents OCR resteront sur disque afin qu'une restauration soit possible. Continuer ?";

    if (!confirmWithAppFocus(message)) return;

    try {
      clearTransientUiState();
      await window.wheat.resetWorkspace({ mode });
      setPage("home");
      notify(mode === "blank" ? "Application vidée. Créez une nouvelle société." : "Données de démonstration restaurées.", "success");
      await load();
      clearTransientUiState();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Réinitialisation impossible", "warning");
    }
  };

  const exportRows = async (rows: any[], suggestedName: string, sheetName: string) => {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Wheat";
    const worksheet = workbook.addWorksheet(sheetName);
    const headers = Object.keys(rows[0] ?? { Message: "Aucune donnée" });
    worksheet.addRow(headers);
    rows.forEach((row) => worksheet.addRow(headers.map((header) => row[header])));
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns.forEach((column) => {
      column.width = 18;
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const bytesBase64 = base64FromArrayBuffer(buffer as ArrayBuffer);

    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName,
        bytesBase64,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (target) notify(`Export créé: ${target}`, "success");
    } else {
      notify("Export Excel préparé dans la prévisualisation navigateur", "success");
    }
  };

  const exportPdf = async (title: string, head: string[], rows: any[][], suggestedName: string) => {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text(title, 14, 16);
    autoTable(doc, { startY: 24, head: [head], body: rows, styles: { fontSize: 8 } });
    const bytesBase64 = doc.output("datauristring").split(",")[1];

    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName,
        bytesBase64,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (target) notify(`PDF créé: ${target}`, "success");
    } else {
      notify("PDF préparé dans la prévisualisation navigateur", "success");
    }
  };

  const importEntries = async () => {
    if (!window.wheat) {
      notify("Import disponible dans l'application desktop Electron", "warning");
      return;
    }

    try {
      const file = await window.wheat.importFile();
      if (!file || !currentCompany) return;
      const importedRows = await readImportRows(file) as Array<Record<string, unknown>>;
      if (!importedRows.length) throw new Error("Le fichier ne contient aucune ligne de données.");
      const requiredColumns = ["entryKey", "date", "journalCode", "pieceNumber", "entryLabel", "accountCode", "lineLabel", "debit", "credit"];
      const headers = Object.keys(importedRows[0]);
      const missing = requiredColumns.filter((column) => !headers.includes(column));
      if (missing.length) {
        throw new Error(`Import non préparé : colonnes exactes manquantes (${missing.join(", ")}). Ouvrez Livres fiables > Imports pour mapper et prévisualiser le fichier sans deviner les comptes.`);
      }
      const batch = await window.wheat.stageLedgerImport({
        companyId: currentCompany.id,
        sourceName: file.name,
        sourceBytesBase64: file.bytesBase64,
        mapping: Object.fromEntries(requiredColumns.map((column) => [column, column])),
        rows: importedRows.map((row, index) => ({ sourceRow: index + 2, ...row })),
      });
      notify(
        batch.status === "STAGED"
          ? `${batch.rows.length} ligne(s) contrôlée(s). Confirmez le lot depuis Livres fiables > Imports.`
          : `${batch.rows.filter((row: any) => row.validationStatus === "INVALID").length} ligne(s) à corriger. Aucune écriture n'a été créée.`,
        batch.status === "STAGED" ? "success" : "warning",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Import impossible", "warning");
    }
  };

  const importBankStatement = async (bankAccountId: string) => {
    if (!window.wheat?.selectBankStatementFile || !window.wheat.parseBankStatement || !window.wheat.reviewBankStatement || !window.wheat.importBankStatement) {
      throw new Error("Import de relevé disponible uniquement dans l’application desktop.");
    }

    const file = await window.wheat.selectBankStatementFile();
    if (!file) return;
    /*
     * Reading a statement is the slowest thing Wheat does on demand: a scanned
     * PDF goes through the local OCR sidecar and can take a minute. Only the
     * phases actually known here are named — the page-by-page progress of the
     * recogniser is not reported over this channel, and a percentage nobody
     * measured is worse than no percentage.
     */
    setRunningTask("Analyse du relevé bancaire…");
    let parsed;
    try {
      parsed = await window.wheat.parseBankStatement({ sourceName: file.name, bytesBase64: file.bytesBase64 });
    } finally {
      // Cleared before the dialog opens, and on failure — the caller reports
      // the error, and a refused statement must not leave the shell busy.
      setRunningTask("");
    }
    const sourceSha256 = await sha256Base64(file.bytesBase64);
    await new Promise<void>((complète) => {
      setBankImportDraft({ bankAccountId, file, sourceSha256, parsed, complète });
    });
  };

  const matchBankMovement = async (movementId: string) => {
    window.sessionStorage.setItem(reconciliationFocusKey, movementId);
    setPage("reconciliation");
    notify("Sélectionnez une écriture comptabilisée et confirmez le rapprochement dans l'inspecteur.", "info");
  };

  const deleteBankMovement = async (movement: any) => {
    if (!window.wheat?.excludeBankMovement) {
      notify("Exclusion disponible dans l'application desktop Electron", "warning");
      return;
    }

    const reason = window.prompt(`Motif d'exclusion du mouvement ${movement.reference ?? movement.label} :`);
    if (!reason?.trim()) return;

    try {
      await window.wheat.excludeBankMovement({ movementId: movement.id, expectedRevision: movement.revision ?? 0, reason });
      notify("Mouvement exclu sans supprimer son historique", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Exclusion du mouvement impossible", "warning");
    }
  };

  const deleteDocumentRecord = async (document: any) => {
    if (!window.wheat?.deleteDocument) {
      notify("Suppression disponible dans l'application desktop Electron", "warning");
      return;
    }

    const message = document.status === "POSTED"
      ? "Ce document est déjà comptabilisé. Supprimer le document OCR ne supprime pas l'écriture. Continuer ?"
      : "Supprimer ce document OCR et son fichier classe ?";
    if (!confirmWithAppFocus(message)) return;

    try {
      await window.wheat.deleteDocument(document.id);
      notify("Document supprime", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression document impossible", "warning");
    }
  };

  /**
   * Turns a recognised document into an invoice draft.
   *
   * Wheat decides the ledger side from the identities printed on the piece. It
   * used to assume "achat" whenever it could not, which filed a dossier's own
   * sales invoices against itself; it now refuses and says so. A refusal for
   * that one reason is a question, not a failure, so it is asked here rather
   * than reported — `kind` carries the answer back.
   */
  const postDocumentEntry = async (documentId: string, kind?: "SALE" | "PURCHASE") => {
    if (!window.wheat) {
      notify("Validation OCR disponible dans l'application desktop Electron", "warning");
      return;
    }

    const approval = await requestReview("document.create_invoice_draft", { documentId, ...(kind ? { kind } : {}) });
    if (!approval.approved) return;

    try {
      const created = await window.wheat.postDocumentEntry(documentId, kind);
      const draftKind = created?.invoiceDraft?.kind === "SALE" ? "de vente" : "d'achat";
      notify(`Brouillon ${draftKind} créé depuis l'OCR. Contrôlez-le avant comptabilisation.`, "success");
      refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Création du brouillon OCR impossible";
      if (!kind && /vente ou un achat/i.test(message)) {
        setDirectionChoice({ documentId, message });
        return;
      }
      notify(message, "warning");
    }
  };

  const postPayrollEntry = async (period: string) => {
    if (!window.wheat || !currentCompany) {
      notify("Génération de paie disponible dans l'application desktop Electron", "warning");
      return;
    }

    try {
      await (window.wheat.postPayrollEntry as any)(currentCompany.id, period);
      notify(`Écriture de paie ${period} créée`, "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Génération de l'écriture de paie impossible", "warning");
    }
  };

  const deleteEmployee = async (employee: any) => {
    if (!window.wheat?.deleteEmployee) {
      notify("Suppression disponible dans l'application desktop Electron", "warning");
      return;
    }

    if (!confirmWithAppFocus(`Supprimer ${employee.fullName} du module paie ?`)) return;

    try {
      await window.wheat.deleteEmployee(employee.id);
      notify("Employe supprime", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression employe impossible", "warning");
    }
  };

  const saveEmployee = async (payload: any) => {
    if (!window.wheat?.saveEmployee || !activeCompanyId) {
      notify("Gestion des salariés disponible dans l'application desktop Electron", "warning");
      return;
    }
    try {
      await window.wheat.saveEmployee({ ...payload, companyId: activeCompanyId });
      setEmployeeEditor(null);
      notify(payload.id ? "Salarié mis à jour" : "Salarié ajouté", "success");
      await refresh();
    } catch (error) {
      throw error instanceof Error ? error : new Error("Enregistrement du salarié impossible");
    }
  };

  const updateUserName = async (name: string) => {
    const cleanName = name.trim();
    if (!cleanName) {
      notify("Le nom utilisateur est obligatoire", "warning");
      return;
    }
    if (!window.wheat?.updateUserName) {
      notify("Modification du profil disponible dans l'application desktop Electron", "warning");
      return;
    }

    try {
      await window.wheat.updateUserName({ name: cleanName });
      notify("Nom utilisateur mis à jour", "success");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Modification du nom impossible", "warning");
    }
  };

  const createBackup = async () => {
    if (!window.wheat) {
      notify("Sauvegarde disponible dans l'application desktop Electron", "warning");
      return;
    }

    setRunningTask("Sauvegarde du dossier en cours…");
    try {
      const target = await window.wheat.createBackup();
      if (target) notify(`Sauvegarde créée: ${target}`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Sauvegarde impossible", "warning");
    } finally {
      setRunningTask("");
    }
  };

  const restoreBackup = async () => {
    if (!window.wheat) {
      notify("Restauration disponible dans l'application desktop Electron", "warning");
      return;
    }

    setRunningTask("Restauration de la sauvegarde…");
    try {
      const target = await window.wheat.restoreBackup();
      if (target) {
        notify("Sauvegarde restaurée. Données rechargées.", "success");
        await load();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Restauration impossible", "warning");
    } finally {
      setRunningTask("");
    }
  };

  const recoverLocalLockFromBackup = async () => {
    if (!window.wheat?.restoreBackup) throw new Error("La restauration n'est disponible que dans l'application desktop.");
    const target = await window.wheat.restoreBackup();
    if (target) await load();
  };

  if (loading && !data) return <LoadingShell />;

  if (securityStatus?.enabled && securityStatus.locked) {
    return <LocalLockScreen status={securityStatus} unlock={unlockLocalApp} recoverFromBackup={recoverLocalLockFromBackup} />;
  }

  if (loadFailure || !data) {
    return (
      <>
        <RecoveryScreen
          failure={loadFailure ?? { message: "Wheat n'a reçu aucune donnée de la base locale." }}
          retry={() => load(activeCompanyId)}
          createBackup={createBackup}
          restoreBackup={restoreBackup}
        />
        <ToastStack toasts={toasts} />
      </>
    );
  }

  if ((data.companies ?? []).length === 0) {
    return (
      <>
        <FirstRunOnboarding onCreate={createCompany} onExploreDemo={() => resetWorkspace("demo")} loading={loading} />
        <WheatUpdateNotices status={updateStatus} actions={updateActions} busy={updateBusy} />
        <ToastStack toasts={toasts} />
      </>
    );
  }

  return (
    <div className={railCollapsed ? "wt-shell app-shell is-rail-collapsed" : "wt-shell app-shell"}>
      {browserPreview && (
        <div className="wt-preview-ribbon" role="status">
          Previsualisation navigateur - données d'exemple, rien n'est enregistre
        </div>
      )}

      <AppRail
        page={page}
        setPage={setPage}
        user={data?.user}
        language={language}
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((current) => !current)}
        // Showing destinations that refuse to open is worse than not showing
        // them: it reads as the application being broken rather than the
        // dossier being unfinished.
        allowedPages={dossierLocked ? setupAllowedPages : null}
      />

      <div className="wt-workspace">
        <AppTopbar
          data={data}
          currentCompany={currentCompany}
          query={query}
          setQuery={setQuery}
          switchCompany={switchCompany}
          setCommandOpen={setCommandOpen}
          openEntryModal={openEntryModal}
          setCompanyModalOpen={setCompanyModalOpen}
          darkMode={darkMode}
          setDarkMode={setDarkMode}
          setPage={setPage}
          language={language}
          updateStatus={updateStatus}
        />

        <MobileNav page={page} setPage={setPage} language={language} />

        <AnimatePresence mode="wait">
          <motion.main
            key={`${currentCompany?.id ?? "workspace"}:${page}`}
            id="wheat-main"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            className="wt-page page"
          >
            <div className="wt-page__inner">
              {page === "home" && (
                <HomePage
                  data={data}
                  currentCompany={currentCompany}
                  metrics={metrics}
                  journey={journey}
                  setPage={setPage}
                  openGuidedTarget={openGuidedTarget}
                  openEntryModal={openEntryModal}
                  setCompanyModalOpen={setCompanyModalOpen}
                  resetWorkspace={resetWorkspace}
                />
              )}
              {page === "guided" && (
                <>
                  <PageHeader
                    icon={<Wand2 size={22} />}
                    title="Travail guidé"
                    purpose="Wheat analyse le dossier, prépare les opérations qui viennent et vous les soumet. Rien n'est enregistré sans votre approbation, et vous pouvez à tout moment ouvrir la pièce, corriger, reporter ou travailler normalement ailleurs."
                    guide={[
                      { icon: <Search size={16} />, title: "Wheat détecte", text: "Il lit le dossier : pièces, factures, comptes, exercices." },
                      { icon: <Wand2 size={16} />, title: "Wheat prépare", text: "Il construit les opérations complètes, avec leur niveau de confiance." },
                      { icon: <CheckCircle2 size={16} />, title: "Vous approuvez", text: "Seules les lignes cochées sont exécutées, chacune revalidée à l'exécution." },
                    ]}
                  />
                  <DossierSetupGate
                    companyId={gatedCompanyId ?? null}
                    onNotify={notify}
                    onUnlocked={() => { void refreshDossierSetup(); }}
                  />
                  <GuidedWork
                    companyId={activeCompanyId ?? null}
                    onOpen={openGuidedTarget}
                    refreshToken={guidedRefreshToken}
                    onChanged={async () => { await refresh(); await reloadJourney(); }}
                    notify={notify}
                  />
                </>
              )}
              {page === "production" && (
                <ProductionPage
                  data={data}
                  currentCompany={currentCompany}
                  metrics={metrics}
                  journey={journey}
                  setPage={setPage}
                  openGuidedTarget={openGuidedTarget}
                  postDocumentEntry={postDocumentEntry}
                  matchBankMovement={matchBankMovement}
                  openContextMenu={openAppContextMenu}
                  copyToClipboard={copyToClipboard}
                  deleteBankMovement={deleteBankMovement}
                  deleteDocumentRecord={deleteDocumentRecord}
                />
              )}
              {page === "dashboard" && (
                <Dashboard
                  data={data}
                  entries={filteredEntries}
                  metrics={metrics}
                  setPage={setPage}
                  alertsMuted={alertsMuted}
                  setAlertsMuted={setAlertsMuted}
                  notify={notify}
                  language={language}
                />
              )}
              {page === "companies" && (
                <CompaniesPage
                  data={data}
                  activeCompanyId={activeCompanyId}
                  switchCompany={switchCompany}
                  setCompanyModalOpen={setCompanyModalOpen}
                  openContextMenu={openAppContextMenu}
                  copyToClipboard={copyToClipboard}
                  deleteCompany={deleteCompany}
                  setPage={setPage}
                />
              )}
              {page === "entries" && (
                <EntriesPage
                  data={data}
                  entries={filteredEntries}
                  language={language}
                  requestReview={requestReview}
                  copyToClipboard={copyToClipboard}
                  openEntryModal={openEntryModal}
                  importEntries={importEntries}
                  notify={notify}
                  refresh={refresh}
                  openContextMenu={openAppContextMenu}
                  setPage={setPage}
                />
              )}
              {page === "documents" && (
                <DocumentsPage
                  data={data}
                  currentCompany={currentCompany}
                  notify={notify}
                  refresh={refresh}
                  postDocumentEntry={postDocumentEntry}
                  requestReview={requestReview}
                  language={language}
                  setPage={setPage}
                />
              )}
              {page === "billing" && currentCompany && (
                <PageFrame
                  page="billing"
                  language={language}
                  icon={<Banknote size={22} />}
                  guide={[
                    { icon: <FileText size={16} />, title: "Factures de vente", text: "Créez, contrôlez puis comptabilisez les factures clients." },
                    { icon: <FileUp size={16} />, title: "Factures d'achat", text: "Enregistrez les factures fournisseurs et leur TVA déductible." },
                    { icon: <Users size={16} />, title: "Tiers", text: "Clients et fournisseurs, avec ICE et conditions de règlement." },
                    { icon: <Banknote size={16} />, title: "Règlements", text: "Encaissements et décaissements, lettrés avec les factures." },
                  ]}
                  help={{
                    summary: "Comment fonctionne cet écran ?",
                    content: (
                      <>
                        <p>Une <strong>facture</strong> est le document commercial. Tant qu'elle est en <strong>brouillon</strong>, rien n'est écrit en comptabilité : vous pouvez la corriger librement.</p>
                        <p>Quand vous la <strong>comptabilisez</strong>, Wheat créé l'écriture correspondante (client / produit / TVA collectée pour une vente) et la facture devient immuable. Pour corriger après coup, utilisez un <strong>avoir</strong>.</p>
                        <p>Un <strong>règlement</strong> représente l'argent réellement encaissé ou payé. On l'<strong>affecte</strong> ensuite a une ou plusieurs factures pour solder leur reste du.</p>
                      </>
                    ),
                  }}
                >
                  <OperationalAccounting
                    companyId={currentCompany.id}
                    companyName={currentCompany.name}
                    currency={currentCompany.baseCurrency ?? "MAD"}
                    accounts={currentCompany.accounts ?? []}
                    bankAccounts={data.bankAccounts ?? []}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                  />
                </PageFrame>
              )}
              {page === "reconciliation" && currentCompany && (
                <PageFrame
                  page="reconciliation"
                  language={language}
                  icon={<Landmark size={22} />}
                  guide={[
                    { icon: <FileUp size={16} />, title: "Importer un relevé", text: "CSV, Excel, OFX ou PDF scanne : Wheat détecté le format." },
                    { icon: <ListChecks size={16} />, title: "Rapprocher", text: "Associez chaque mouvement bancaire a son écriture comptable." },
                    { icon: <Filter size={16} />, title: "Exclure", text: "Écartez un mouvement hors perimêtre en gardant sa trace et son motif." },
                    { icon: <ShieldCheck size={16} />, title: "Contrôler", text: "Le solde rapproche doit correspondre au solde du compte 514." },
                  ]}
                  help={{
                    summary: "A quoi sert le rapprochement bancaire ?",
                    content: (
                      <>
                        <p>Le <strong>rapprochement bancaire</strong> compare ce que dit la banque avec ce qui est enregistre en comptabilité. Chaque ligne du relevé doit correspondre a une écriture, et inversement.</p>
                        <p>Wheat ne rapproche jamais automatiquement : il propose des candidats classes par pertinence, vous confirmez. Une confirmation est reversible tant que l'exercice n'est pas clôture.</p>
                        <p>Si un mouvement n'a pas d'écriture (frais bancaires oublies, par exemple), créez l'écriture manquante depuis Écritures puis revenez ici.</p>
                      </>
                    ),
                  }}
                >
                  <ReconciliationWorkbench
                    companyId={currentCompany.id}
                    initialMovementId={window.sessionStorage.getItem(reconciliationFocusKey) ?? undefined}
                    openBatch={reconciliationBatch}
                    onImportStatement={importBankStatement}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                  />
                </PageFrame>
              )}
              {page === "vat" && currentCompany && (
                <PageFrame
                  page="vat"
                  language={language}
                  icon={<Percent size={22} />}
                  guide={[
                    { icon: <Settings size={16} />, title: "Paramétrage", text: "Taux, régime et périodicité (mensuelle ou trimestrielle) du dossier." },
                    { icon: <FileSpreadsheet size={16} />, title: "Dossier de travail", text: "Le detail chiffré de la déclaration, justifié ligne par ligne." },
                    { icon: <Lock size={16} />, title: "Clôture de période", text: "Fige la période déclarée pour empecher toute modification après dépôt." },
                    { icon: <ShieldCheck size={16} />, title: "Intégrité", text: "Contrôles automatiques avant dépôt : cohérence, TVA sans pièce, écarts." },
                  ]}
                  help={{
                    summary: "Comprendre la TVA en deux minutes",
                    content: (
                      <>
                        <p>La <strong>TVA collectée</strong> est la TVA facturée a vos clients ; la <strong>TVA déductible</strong> celle payee a vos fournisseurs. La difference est ce que vous devez à l'administration (ou ce qu'elle vous doit, un <strong>credit de TVA</strong>).</p>
                        <p>Le <strong>dossier de travail</strong> conserve le calcul et les justificatifs. Il permet de retrouver, des mois plus tard, d'où vient chaque montant declare.</p>
                        <p>Wheat ne teletransmet rien : il prépare, contrôle et archive. Le dépôt reste fait sur le portail officiel.</p>
                      </>
                    ),
                  }}
                >
                  <ComplianceWorkspace14
                    companyId={currentCompany.id}
                    companyName={currentCompany.name}
                    currency={currentCompany.baseCurrency ?? "MAD"}
                    accounts={currentCompany.accounts ?? []}
                    documents={data.documents ?? []}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                  />
                </PageFrame>
              )}
              {page === "payroll" && (
                <PayrollPage
                  data={data}
                  exportRows={exportRows}
                  exportPdf={exportPdf}
                  postPayrollEntry={postPayrollEntry}
                  language={language}
                  openContextMenu={openAppContextMenu}
                  copyToClipboard={copyToClipboard}
                  deleteEmployee={deleteEmployee}
                  editEmployee={(employee?: any) => setEmployeeEditor({ employee })}
                  setPage={setPage}
                />
              )}
              {(page === "reports" || page === "books") && currentCompany && (
                <PageFrame
                  page={page}
                  language={language}
                  icon={page === "reports" ? <FileSearch size={22} /> : <ShieldCheck size={22} />}
                  guide={page === "reports" ? [
                    { icon: <BookOpen size={16} />, title: "Grand livre", text: "Tous les mouvements d'un compte, dans l'ordre, avec son solde." },
                    { icon: <Scale size={16} />, title: "Balance", text: "Le total débit / crédit et le solde de chaque compte à une date." },
                    { icon: <Calendar size={16} />, title: "Âges", text: "Ce que vos clients vous doivent, classé par ancienneté." },
                    { icon: <ShieldCheck size={16} />, title: "Intégrité", text: "Détecte les déséquilibres, trous de numérotation et anomalies." },
                  ] : [
                    { icon: <FileUp size={16} />, title: "Imports", text: "Reprendre une balance ou un journal venant d'un autre logiciel." },
                    { icon: <Settings size={16} />, title: "Paramétrage", text: "Comptes, journaux, comptes bancaires et exercices du dossier." },
                    { icon: <ListChecks size={16} />, title: "Brouillons", text: "Les écritures préparées qui attendent un contrôle." },
                    { icon: <ShieldCheck size={16} />, title: "Contrôles", text: "Verrouillage de période, scellement et vérification de la chaine d'audit." },
                  ]}
                  help={{
                    summary: page === "reports" ? "Quel rapport choisir ?" : "Que faire ici ?",
                    content: page === "reports" ? (
                      <>
                        <p>Le <strong>grand livre</strong> répond a la question « que s'est-il passe sur ce compte ? ». La <strong>balance</strong> répond a « où en sont tous les comptes à cette date ? ».</p>
                        <p>Les <strong>ages</strong> (balance agee) servent au recouvrement : ils montrent les factures impayées classees par retard.</p>
                        <p>Chaque rapport s'exporte en Excel ou PDF sans quitter l'écran.</p>
                      </>
                    ) : (
                      <>
                        <p>Un <strong>import</strong> permet de reprendre l'historique d'un dossier venu de Sage ou d'Excel. Rien n'est écrit avant votre confirmation : Wheat contrôle d'abord chaque ligne.</p>
                        <p>Le <strong>paramétrage</strong> definit le plan de comptes et les journaux du dossier ; il conditionne toute la saisie.</p>
                        <p>Les <strong>contrôles</strong> garantissent qu'une période déclarée ne peut plus être modifiée en silence.</p>
                      </>
                    ),
                  }}
                >
                  <BooksWorkspace13
                    companyId={currentCompany.id}
                    companyName={currentCompany.name}
                    currency={currentCompany.baseCurrency ?? "MAD"}
                    accounts={currentCompany.accounts ?? []}
                    journals={currentCompany.journals ?? []}
                    initialTab={page === "books" ? "configuration" : "reports"}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                    exportRows={exportRows}
                    exportPdf={exportPdf}
                  />
                </PageFrame>
              )}
              {page === "fiscal" && currentCompany && (
                <PageFrame
                  page="fiscal"
                  language={language}
                  icon={<FileSpreadsheet size={22} />}
                  guide={[
                    { icon: <FileSpreadsheet size={16} />, title: "Tableaux", text: "Les états officiels de la liasse, remplis depuis vos comptes." },
                    { icon: <Pencil size={16} />, title: "Retraitements", text: "Les corrections fiscales (réintégrations, deductions) justifiees." },
                    { icon: <ListChecks size={16} />, title: "Contrôles", text: "Vérifié la cohérence entre bilan, CPC et tableaux avant dépôt." },
                    { icon: <FileText size={16} />, title: "Dossier de travail", text: "Les pièces justificatives rattachees à chaque tableau." },
                  ]}
                  help={{
                    summary: "Qu'est-ce que la liasse fiscale ?",
                    content: (
                      <>
                        <p>La <strong>liasse fiscale</strong> est l'ensemble des tableaux normalisés deposes chaque année avec la déclaration de résultat. Elle part du bilan et du CPC, puis applique les <strong>retraitements fiscaux</strong>.</p>
                        <p>Un <strong>retraitement</strong> corrige le résultat comptable pour obtenir le résultat fiscal : par exemple réintégrer une charge non déductible.</p>
                        <p>Wheat conserve la justification de chaque retraitement pour qu'un contrôle ulterieur puisse la retracer.</p>
                      </>
                    ),
                  }}
                >
                  <FiscalWorkspace
                    company={currentCompany}
                    documents={data.documents ?? []}
                    currency={data.currency}
                    initialTab="fiscal"
                    onChanged={refresh}
                    onNotify={operationalNotify}
                  />
                </PageFrame>
              )}
              {page === "statements" && currentCompany && (
                <PageFrame
                  page="statements"
                  language={language}
                  icon={<Scale size={22} />}
                  guide={[
                    { icon: <BookOpen size={16} />, title: "Plan comptable", text: "Le PCGE marocain : la liste officielle des comptes utilisables." },
                    { icon: <Scale size={16} />, title: "Balance", text: "Soldes generaux, auxiliaires, d'ouverture, de mouvement et de clôture." },
                    { icon: <BarChart3 size={16} />, title: "Bilan & CPC", text: "La photo du patrimoine et le compte de produits et charges." },
                    { icon: <Landmark size={16} />, title: "Trésorerie", text: "Le total des comptes bancaires et de caisse à une date donnée." },
                  ]}
                  help={{
                    summary: "Bilan, CPC, balance : quelle difference ?",
                    content: (
                      <>
                        <p>La <strong>balance</strong> est un outil de travail : elle liste tous les comptes avec leurs totaux. Elle sert à vérifier que la comptabilité est équilibrée.</p>
                        <p>Le <strong>bilan</strong> est une photo à une date : ce que l'entreprise possede (actif) et ce qu'elle doit (passif).</p>
                        <p>Le <strong>CPC</strong> (compte de produits et charges) couvre une période : il explique comment le résultat s'est forme.</p>
                      </>
                    ),
                  }}
                >
                  <FiscalWorkspace
                    company={currentCompany}
                    documents={data.documents ?? []}
                    currency={currentCompany.baseCurrency ?? "MAD"}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                  />
                </PageFrame>
              )}
              {page === "wheat-ai" && currentCompany && (
                <PageFrame
                  page="wheat-ai"
                  language={language}
                  icon={<WheatAiMark size={26} />}
                  guide={[
                    { icon: <Search size={16} />, title: "Poser une question", text: "Sur le dossier ouvert : soldes, factures, TVA, écritures." },
                    { icon: <ListChecks size={16} />, title: "Preparer une action", text: "Wheat AI propose, vous confirmez : rien n'est écrit sans accord." },
                    { icon: <ShieldCheck size={16} />, title: "Traçabilité", text: "Chaque proposition et chaque execution sont journalisées." },
                    { icon: <Settings size={16} />, title: "Fournisseur et modèle", text: "Local, OpenRouter ou Groq - à configurer dans Réglages." },
                  ]}
                  help={{
                    summary: "Comment Wheat AI travaille-t-il ?",
                    content: (
                      <>
                        <p>Wheat AI ne voit que les données du dossier ouvert, transmises sous forme de résumés bornés. Il ne peut appeler que des <strong>capacités typees</strong> déclarées par Wheat : il n'écrit jamais directement en base.</p>
                        <p>Toute action qui modifie des données passe par une <strong>proposition</strong> que vous lisez puis confirmez ou refusez.</p>
                        <p>Avec un modèle local, rien ne quitte l'ordinateur. Avec OpenRouter ou Groq, seule la question et le contexte borné sont envoyes au fournisseur choisi.</p>
                      </>
                    ),
                  }}
                >
                  <WheatAiWorkspace
                    company={currentCompany}
                    onChanged={refresh}
                    onNotify={operationalNotify}
                    onNavigate={(target) => {
                      const destinations: Record<string, Page> = {
                        dashboard: "dashboard",
                        entries: "entries",
                        documents: "documents",
                        invoices: "billing",
                        banking: "reconciliation",
                        reports: "reports",
                        bilan: "statements",
                        fiscal: "fiscal",
                        vat: "vat",
                        settings: "settings",
                        "wheat-ai": "wheat-ai",
                      };
                      setPage(destinations[target] ?? "home");
                    }}
                  />
                </PageFrame>
              )}
              {page === "sage" && <SageExportPage data={data} currentCompany={currentCompany} exportRows={exportRows} notify={notify} />}
              {page === "assistant" && <LocalAnalysisPage data={data} language={language} />}
              {page === "settings" && (
                <SettingsPage
                  data={data}
                  darkMode={darkMode}
                  setDarkMode={setDarkMode}
                  createBackup={createBackup}
                  restoreBackup={restoreBackup}
                  resetWorkspace={resetWorkspace}
                  setCompanyModalOpen={setCompanyModalOpen}
                  notify={notify}
                  language={language}
                  setLanguage={changeLanguage}
                  updateUserName={updateUserName}
                  securityStatus={securityStatus}
                  setupLocalLock={setupLocalLock}
                  disableLocalLock={disableLocalLock}
                  lockLocalApp={lockLocalApp}
                  mapBankLedgerAccount={mapBankLedgerAccount}
                  createBankLedgerAccount={createBankLedgerAccount}
                  updateStatus={updateStatus}
                  checkForUpdates={checkForUpdates}
                  downloadUpdate={downloadUpdate}
                  installUpdate={installUpdate}
                  updateBusy={updateBusy}
                />
              )}

              {/* These workspaces need an open dossier: say so instead of rendering nothing. */}
              {!currentCompany && ["billing", "reconciliation", "vat", "reports", "books", "fiscal", "statements", "wheat-ai"].includes(page) && (
                <>
                  <PageHeader
                    icon={<Building2 size={22} />}
                    title={navLabel(page, language)}
                    purpose={pagePurpose[page]}
                  />
                  <EmptyState
                    icon={<Building2 size={22} />}
                    title="Ouvrez d'abord un dossier"
                    text="Cet écran travaille sur une société précise. Créez un dossier, ou sélectionnez-en un dans la barre du haut, pour continuer."
                    actions={
                      <>
                        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCompanyModalOpen(true)}>Créer un dossier</Button>
                        <Button variant="secondary" onClick={() => setPage("companies")}>Voir les dossiers</Button>
                      </>
                    }
                  />
                </>
              )}
            </div>
          </motion.main>
        </AnimatePresence>
      </div>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        setPage={setPage}
        openEntryModal={openEntryModal}
        setCompanyModalOpen={setCompanyModalOpen}
        createBackup={createBackup}
        language={language}
      />

      {identityEditorOpen && currentCompany && (
        <CompanyIdentityDialog
          company={currentCompany}
          requestReview={requestReview}
          notify={notify}
          onClose={() => setIdentityEditorOpen(false)}
          onSaved={async () => {
            setIdentityEditorOpen(false);
            await refresh();
            await reloadJourney();
            // Guided work derives its step from the dossier, so it has to read
            // the dossier again before it can stop asking for what was saved.
            setGuidedRefreshToken((token) => token + 1);
          }}
        />
      )}

      {entryModalOpen && currentCompany && (
        <EntryModal
          company={currentCompany}
          requestReview={requestReview}
          onClose={() => setEntryModalOpen(false)}
          onCreated={() => {
            setEntryModalOpen(false);
            notify("Brouillon enregistre. Comptabilisez-le après contrôle.", "success");
            refresh();
          }}
        />
      )}

      {directionChoice && (
        <ConfirmDialog
          title="Achat ou vente ?"
          question={directionChoice.message}
          consequence="Le sens décide du compte collectif, du compte de TVA et de la nature du tiers. Wheat ne le devine pas : choisissez celui qui correspond à la pièce."
          reversible="Un brouillon classé du mauvais côté peut être reclassé tant qu'il n'est pas comptabilisé."
          confirmLabel="C'est une vente du dossier"
          cancelLabel="C'est un achat du dossier"
          onClose={() => {
            const { documentId } = directionChoice;
            setDirectionChoice(null);
            void postDocumentEntry(documentId, "PURCHASE");
          }}
          onConfirm={async () => {
            const { documentId } = directionChoice;
            setDirectionChoice(null);
            await postDocumentEntry(documentId, "SALE");
          }}
        />
      )}

      {companyModalOpen && (
        <CompanyModal
          onClose={() => setCompanyModalOpen(false)}
          onCreate={createCompany}
        />
      )}

      {employeeEditor && currentCompany && (
        <EmployeeModal
          employee={employeeEditor.employee}
          onClose={() => setEmployeeEditor(null)}
          onSave={saveEmployee}
        />
      )}

      {bankImportDraft && (
        <BankStatementImportModal
          companyId={activeCompanyId}
          draft={bankImportDraft}
          onClose={() => {
            bankImportDraft.complète();
            setBankImportDraft(null);
          }}
          onImported={() => {
            bankImportDraft.complète();
            notify("Le relevé a été importé après contrôle. Aucun rapprochement n'a été créé automatiquement.", "success");
            refresh();
          }}
          onReconcileBatch={(batch) => {
            // The import is finished and those movements now exist; what
            // follows is the reconciliation of exactly those movements.
            setReconciliationBatch(batch);
            bankImportDraft.complète();
            setBankImportDraft(null);
            setPage("reconciliation");
          }}
        />
      )}

      {reviewSurface}
      <AppContextMenu menu={appContextMenu} onRun={runContextAction} />
      <WheatUpdateNotices status={updateStatus} actions={updateActions} busy={updateBusy} />
      <RunningTaskBanner label={runningTask} />
      <ToastStack toasts={toasts} />
    </div>
  );
}

/**
 * Shared frame for the screens whose body is a full workspace component.
 * It guarantees every one of them opens with the same three answers: what the
 * screen is for, what lives on it, and where to find help.
 */
function PageFrame({
  page,
  language,
  icon,
  guide,
  help,
  actions,
  children,
}: {
  page: Page;
  language: AppLanguage;
  icon: ReactNode;
  guide?: GuideItem[];
  help?: { summary: string; content: ReactNode };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        icon={icon}
        title={navLabel(page, language)}
        purpose={pagePurpose[page]}
        actions={actions}
        guide={guide}
        help={help}
      />
      {children}
    </>
  );
}

function FirstRunOnboarding({ onCreate, onExploreDemo, loading }: any) {
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({
    name: "",
    legalForm: "SARL",
    city: "Casablanca",
    ice: "",
    taxId: "",
    fiscalYear: currentYear,
    vatFrequency: "MONTHLY" as "MONTHLY" | "QUARTERLY",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    clearTransientDocumentState();
    const focusFrame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(".onboarding-form [data-autofocus]")?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Indiquez le nom de la société.");
      return;
    }

    setError("");
    setBusy(true);
    try {
      await onCreate({ ...form, name: form.name.trim() });
    } finally {
      setBusy(false);
    }
  };

  const legalFormOptions: WheatSelectOption[] = [
    { value: "SARL", label: "SARL", note: "Société a responsabilité limitee" },
    { value: "SARL AU", label: "SARL AU", note: "SARL a associé unique" },
    { value: "SA", label: "SA", note: "Société anonyme" },
    { value: "SAS", label: "SAS", note: "Société par actions simplifiee" },
    { value: "Auto-entrepreneur", label: "Auto-entrepreneur" },
    { value: "Personne physique", label: "Personne physique" },
    { value: "Association", label: "Association" },
  ];
  const yearOptions: WheatSelectOption[] = [currentYear - 1, currentYear, currentYear + 1].map((year) => ({
    value: String(year),
    label: String(year),
    note: year === currentYear ? "Exercice en cours" : year < currentYear ? "Exercice précédent" : "Exercice suivant",
  }));
  const vatOptions: WheatSelectOption[] = [
    { value: "MONTHLY", label: "Mensuelle", note: "Declaration chaque mois" },
    { value: "QUARTERLY", label: "Trimestrielle", note: "Declaration tous les trois mois" },
  ];

  return (
    <main className="wt-fullscreen onboarding-shell">
      <motion.section
        className="wt-onboard"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
      >
        <div className="wt-onboard__intro">
          <div className="wt-row">
            <WheatMark size={44} />
            <span className="wt-rail__brand-text">
              <span className="wt-rail__brand-name wheat-wordmark">Wheat</span>
              <span className="wt-rail__brand-note">{WHEAT_RELEASE_LABEL}</span>
            </span>
          </div>

          <div>
            <span className="wt-eyebrow">Bienvenue</span>
            <h1 className="wt-onboard__title">Créons votre premier dossier.</h1>
            <p className="wt-subtitle">
              Un <strong>dossier</strong> représente une société. Wheat y installe automatiquement le plan comptable marocain (PCGE), les journaux usuels et l'exercice que vous choisissez.
            </p>
          </div>

          <ol className="wt-onboard__steps" aria-label="Ce que Wheat prépare">
            <li className="wt-onboard__step">
              <span className="wt-onboard__step-num">1</span>
              <span><strong>Identité de la société</strong><br />Nom, forme juridique, ville et identifiants officiels.</span>
            </li>
            <li className="wt-onboard__step">
              <span className="wt-onboard__step-num">2</span>
              <span><strong>Exercice comptable</strong><br />La période de douze mois sur laquelle le résultat sera calculé.</span>
            </li>
            <li className="wt-onboard__step">
              <span className="wt-onboard__step-num">3</span>
              <span><strong>Régime de TVA</strong><br />Le rythme de vos déclarations : mensuel ou trimestriel.</span>
            </li>
          </ol>

          <Callout tone="neutral" icon={<HardDrive size={17} />} title="Tout reste sur cet ordinateur">
            Wheat ne créé aucun compte et n'envoie aucune donnée comptable sur internet.
          </Callout>
        </div>

        <form className="wt-onboard__form onboarding-form" onSubmit={submit}>
          <div>
            <span className="wt-eyebrow">Étape 1 sur 3</span>
            <h2 className="wt-title">Informations de la société</h2>
            <p className="wt-hint">Seul le nom est obligatoire. Vous pourrez compléter le reste à tout moment.</p>
          </div>

          <div className="wt-form-grid">
            <Field label="Nom de la société" htmlFor="onboarding-name" required className="wt-span-all">
              <input
                id="onboarding-name"
                className="wt-input"
                autoFocus
                data-autofocus
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Ex. : EL AMANA SERVICES SARL"
              />
            </Field>
            <Field label="Forme juridique" htmlFor="onboarding-legal">
              <WheatSelect
                id="onboarding-legal"
                options={legalFormOptions}
                value={form.legalForm}
                onChange={(value) => setForm((current) => ({ ...current, legalForm: value }))}
                ariaLabel="Forme juridique"
              />
            </Field>
            <Field label="Ville" htmlFor="onboarding-city">
              <input id="onboarding-city" className="wt-input" value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} placeholder="Casablanca" />
            </Field>
            <Field label="ICE" htmlFor="onboarding-ice" optional tip="Identifiant Commun de l'Entreprise : le numéro a 15 chiffres obligatoire sur les factures marocaines.">
              <input
                id="onboarding-ice"
                className="wt-input"
                value={form.ice}
                onChange={(event) => setForm((current) => ({ ...current, ice: event.target.value.replace(/\D/g, "").slice(0, 15) }))}
                inputMode="numeric"
                placeholder="15 chiffres"
              />
            </Field>
            <Field label="Identifiant fiscal" htmlFor="onboarding-tax" optional tip="Le numéro attribué par la Direction Générale des Impôts, utilisé sur les déclarations.">
              <input id="onboarding-tax" className="wt-input" value={form.taxId} onChange={(event) => setForm((current) => ({ ...current, taxId: event.target.value }))} />
            </Field>
          </div>

          <hr className="wt-divider" />

          <div>
            <span className="wt-eyebrow">Étapes 2 et 3</span>
            <h2 className="wt-title">Cadre comptable et fiscal</h2>
            <p className="wt-hint">Wheat prépare un exercice civil et le plan comptable de base ; tout reste modifiable ensuite.</p>
          </div>

          <div className="wt-form-grid">
            <Field label="Exercice comptable" htmlFor="onboarding-year" required>
              <WheatSelect
                id="onboarding-year"
                options={yearOptions}
                value={String(form.fiscalYear)}
                onChange={(value) => setForm((current) => ({ ...current, fiscalYear: Number(value) }))}
                ariaLabel="Exercice comptable"
                searchable={false}
              />
            </Field>
            <Field label="Declaration de TVA" htmlFor="onboarding-vat" required tip="Le rythme depend du chiffré d'affaires et figure sur l'attestation fiscale de la société.">
              <WheatSelect
                id="onboarding-vat"
                options={vatOptions}
                value={form.vatFrequency}
                onChange={(value) => setForm((current) => ({ ...current, vatFrequency: value as "MONTHLY" | "QUARTERLY" }))}
                ariaLabel="Declaration de TVA"
                searchable={false}
              />
            </Field>
          </div>

          {error && <Callout tone="danger" title="Le dossier n'a pas été créé">{error}</Callout>}

          <Button type="submit" variant="primary" size="lg" block busy={busy || loading} trailingIcon={<ArrowRight size={17} />}>
            Créer mon dossier comptable
          </Button>
          <p className="wt-hint">Une base vierge sera créée. Aucun chiffré d'exemple ne sera ajoute.</p>

          <hr className="wt-divider" />

          <Card
            title="Vous préférez d'abord regarder ?"
            note="Wheat peut charger un dossier de démonstration, clairement identifiable, pour explorer sans risque."
            className="wt-card--sunken"
            footer={
              <Button variant="secondary" onClick={onExploreDemo} disabled={busy || loading} trailingIcon={<ArrowRight size={15} />}>
                Explorer un dossier de démonstration
              </Button>
            }
          />
        </form>
      </motion.section>
    </main>
  );
}

function LocalLockScreen({ status, unlock, recoverFromBackup }: { status: LocalSecurityStatus; unlock: (pin: string) => Promise<void>; recoverFromBackup: () => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [remainingMs, setRemainingMs] = useState(status.retryAfterMs ?? 0);

  useEffect(() => {
    setRemainingMs(status.retryAfterMs ?? 0);
  }, [status.retryAfterMs]);

  useEffect(() => {
    if (remainingMs <= 0) return;
    const interval = window.setInterval(() => setRemainingMs((value) => Math.max(0, value - 1_000)), 1_000);
    return () => window.clearInterval(interval);
  }, [remainingMs > 0]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await unlock(pin);
      setPin("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Déverrouillage impossible");
    } finally {
      setSubmitting(false);
    }
  };

  const recover = async () => {
    setError("");
    setSubmitting(true);
    try {
      await recoverFromBackup();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Restauration impossible");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="wt-fullscreen">
      <form className="wt-panel-screen" onSubmit={submit}>
        <div className="wt-row">
          <span className="wt-page-header__icon"><Lock size={22} aria-hidden="true" /></span>
          <span className="wt-rail__brand-text">
            <span className="wt-eyebrow">Verrou local</span>
            <span className="wt-title">Wheat est verrouillé</span>
          </span>
        </div>

        <p className="wt-subtitle">
          Entrez le code PIN defini sur cet ordinateur. Ce verrou empeche l'ouverture de l'application ; il ne chiffré ni la base comptable ni les documents classes.
        </p>

        {status.configurationError ? (
          <>
            <Callout tone="danger" title="La configuration du verrou est invalide">
              Dans cet état, Wheat n'autorise qu'une restauration contrôlée. Votre base actuelle ne sera pas remplacée sans votre choix explicite.
            </Callout>
            {error && <Callout tone="danger" title="La restauration n'a pas abouti">{error}</Callout>}
            <Button variant="primary" size="lg" block icon={<DatabaseBackup size={17} />} busy={submitting} onClick={() => void recover()}>
              Restaurer une sauvegarde fiable
            </Button>
          </>
        ) : (
          <>
            <Field label="Code PIN" htmlFor="lock-pin" required hint="Au moins 6 caracteres. Il a été defini dans Réglages > Sécurité locale.">
              <input
                id="lock-pin"
                className="wt-input"
                autoFocus
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                minLength={6}
                maxLength={64}
              />
            </Field>
            {error && <Callout tone="danger" title="Deverrouillage refuse">{error}</Callout>}
            {remainingMs > 0 && (
              <Callout tone="warning" title="Trop de tentatives">
                Patientez {Math.max(1, Math.ceil(remainingMs / 1000))} seconde(s) avant un nouvel essai.
              </Callout>
            )}
            <Button type="submit" variant="primary" size="lg" block icon={<Lock size={17} />} busy={submitting} disabled={pin.length < 6 || remainingMs > 0}>
              Déverrouiller
            </Button>
          </>
        )}

        <span className="wt-rail__local">
          <HardDrive size={13} aria-hidden="true" />
          <span>Vos données restent sur cet ordinateur.</span>
        </span>
      </form>
    </main>
  );
}

/**
 * Shown when the local database cannot be opened. It never substitutes demo
 * data: it explains what happened, what Wheat did NOT do, and offers the three
 * recovery actions in order of safety.
 */
function RecoveryScreen({ failure, retry, createBackup, restoreBackup }: any) {
  return (
    <main className="wt-fullscreen recovery-shell">
      <motion.section className="wt-panel-screen wt-panel-screen--wide" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="wt-row">
          <WheatMark size={34} />
          <span className="wheat-wordmark wt-rail__brand-name">Wheat</span>
        </div>

        <div className="wt-row">
          <span className="wt-page-header__icon" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            <Wrench size={22} aria-hidden="true" />
          </span>
          <span className="wt-rail__brand-text">
            <span className="wt-eyebrow">Récupération</span>
            <span className="wt-title">La base comptable locale n'a pas pu être ouverte</span>
          </span>
        </div>

        <Callout tone="info" title="Ce que Wheat n'a pas fait">
          Aucune donnée d'exemple n'a été chargee a la place, et votre fichier n'a pas été modifie. Rien ne sera remplace sans une action explicite de votre part.
        </Callout>

        <Callout tone="danger" title="Detail technique" className="recovery-error">
          {failure.message}
        </Callout>

        {failure.databasePath && (
          <Field label="Fichier concerne" htmlFor="recovery-path" hint="Chemin complet de la base que Wheat a tente d'ouvrir.">
            <div className="wt-input-affix">
              <HardDrive size={15} aria-hidden="true" />
              <input id="recovery-path" readOnly value={failure.databasePath} aria-label="Chemin de la base concernee" />
              <Button variant="ghost" size="sm" onClick={() => window.wheat?.openPath(failure.databasePath)}>Ouvrir l'emplacement</Button>
            </div>
          </Field>
        )}

        <div className="wt-stack wt-stack--tight">
          <span className="wt-eyebrow">Que faire, dans cet ordre</span>
          <div className="wt-row">
            <Button variant="primary" icon={<RefreshCw size={15} />} onClick={retry}>1. Réessayer</Button>
            {window.wheat?.createBackup && (
              <Button variant="secondary" icon={<DatabaseBackup size={15} />} onClick={createBackup}>2. Sauvegarder l'état actuel</Button>
            )}
            {window.wheat?.restoreBackup && (
              <Button variant="secondary" icon={<Upload size={15} />} onClick={restoreBackup}>3. Restaurer une sauvegarde</Button>
            )}
          </div>
          <p className="wt-hint">
            Sauvegardez d'abord le fichier actuel, même endommagé : il peut encore contenir des écritures récupérables qu'une restauration ecraserait.
          </p>
        </div>
      </motion.section>
    </main>
  );
}

/**
 * Right-click menu. It never holds an action that is unavailable elsewhere:
 * every entry here also exists as a visible button on the screen.
 */
function AppContextMenu({ menu, onRun }: { menu: ContextMenuState; onRun: (action: ContextMenuAction) => void }) {
  return (
    <AnimatePresence>
      {menu && <AppContextMenuSurface menu={menu} onRun={onRun} />}
    </AnimatePresence>
  );
}

/** The menu body itself, mounted only when open so it can measure and fold
    itself back inside the window before the first paint. */
function AppContextMenuSurface({ menu, onRun }: { menu: NonNullable<ContextMenuState>; onRun: (action: ContextMenuAction) => void }) {
  const [ref, placement] = useViewportAnchor<HTMLDivElement>({ x: menu.x, y: menu.y });
  return (
    <motion.div
      ref={ref}
      className="wt-context-menu context-menu"
      style={{ left: placement.left, top: placement.top, maxHeight: placement.maxHeight || undefined, overflowY: "auto" }}
      initial={{ opacity: 0, scale: 0.98, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: -4 }}
      transition={{ duration: 0.12 }}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      {menu.title && <span className="wt-context-menu__title">{menu.title}</span>}
      {menu.actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <button
            key={`${action.label}-${index}`}
            type="button"
            className={action.tone === "danger" ? "wt-context-menu__item is-danger" : "wt-context-menu__item"}
            disabled={action.disabled}
            onClick={() => onRun(action)}
            role="menuitem"
          >
            {Icon && <Icon size={15} aria-hidden="true" />}
            {action.label}
          </button>
        );
      })}
    </motion.div>
  );
}

function buildMetrics(data: any) {
  const invoices = data?.invoices ?? [];
  const entries = ledgerEntries(data?.entries ?? []);
  const bankAccounts = data?.bankAccounts ?? [];
  const tax = data?.taxPeriods?.[0];
  const unpaid = invoices.filter((invoice: any) => ["UNPAID", "OVERDUE", "PARTIALLY_PAID", "PARTIALLY_PAID_OVERDUE"].includes(invoice.status));
  const overdue = unpaid.filter((invoice: any) => daysBetween(invoice.dueDate) > 0);
  const balance = buildBalanceRows(entries);
  const revenue = balance
    .filter((row) => String(row.Compte).startsWith("7"))
    .reduce((sum, row) => sum + Math.abs(row.Solde), 0);
  const expenses = balance
    .filter((row) => String(row.Compte).startsWith("6"))
    .reduce((sum, row) => sum + Math.abs(row.Solde), 0);

  const complète = data?.dashboardMetrics;
  const revenueCents = exactCents(complète?.revenueCents, revenue);
  const expensesCents = exactCents(complète?.expensesCents, expenses);
  const resultCents = exactCents(complète?.resultCents, revenue - expenses);
  const dueVatCents = exactCents(tax?.dueVatCents, tax?.dueVat ?? 0);
  const deductibleVatCents = exactCents(tax?.deductibleVatCents, tax?.deductibleVat ?? 0);
  const collectedVatCents = exactCents(tax?.collectedVatCents, tax?.collectedVat ?? 0);
  const creditVatCents = exactCents(tax?.creditVatCents, tax?.creditVat ?? 0);
  const unpaidTotalCents = exactCents(complète?.unpaidTotalCents, unpaid.reduce((sum: number, invoice: any) => sum + Number(invoice.ttc ?? 0), 0));
  const bankTotalCents = exactCents(complète?.bankTotalCents, bankAccounts.reduce((sum: number, account: any) => sum + Number(account.balance ?? 0), 0));

  return {
    revenue: Number(exactDecimalFromCents(revenueCents)),
    result: Number(exactDecimalFromCents(resultCents)),
    dueVat: Number(exactDecimalFromCents(dueVatCents)),
    deductibleVat: Number(exactDecimalFromCents(deductibleVatCents)),
    collectedVat: Number(exactDecimalFromCents(collectedVatCents)),
    creditVat: Number(exactDecimalFromCents(creditVatCents)),
    unpaidTotal: Number(exactDecimalFromCents(unpaidTotalCents)),
    bankTotal: Number(exactDecimalFromCents(bankTotalCents)),
    revenueCents,
    expensesCents,
    resultCents,
    dueVatCents,
    deductibleVatCents,
    collectedVatCents,
    creditVatCents,
    unpaidTotalCents,
    bankTotalCents,
    unpaidCount: complète?.unpaidCount ?? unpaid.length,
    overdueCount: complète?.overdueCount ?? overdue.length,
    entryCount: complète?.entryCount ?? entries.length,
  };
}

function exactCents(canonicalValue: unknown, decimalFallback: unknown = 0): bigint {
  if (typeof canonicalValue === "bigint") return canonicalValue;
  if (typeof canonicalValue === "string" && /^-?\d+$/.test(canonicalValue.trim())) return BigInt(canonicalValue.trim());
  const text = String(decimalFallback ?? 0).trim().replace(",", ".");
  const negative = text.startsWith("-");
  const parsed = tryParseExactDecimalCents(negative ? text.slice(1) : text);
  return parsed === null ? 0n : negative ? -parsed : parsed;
}

function metricMoney(metrics: any, key: string) {
  return formatExactCentsForUi(metrics?.[`${key}Cents`] ?? 0n);
}

function entryStatusMeta(status: string) {
  if (status === "DRAFT") return { label: "Brouillon", tone: "warning" };
  if (status === "POSTED" || status === "VALIDATED") return { label: "Comptabilisée", tone: "success" };
  if (status === "REVERSED") return { label: "Extournée", tone: "neutral" };
  return { label: statusLabel(status), tone: "warning" };
}

function isDraftEntry(entry: any) {
  return entry?.status === "DRAFT";
}

function isPostedEntry(entry: any) {
  return entry?.status === "POSTED" || entry?.status === "VALIDATED";
}

function ledgerEntries(entries: any[] = []) {
  return entries.filter((entry) => entry?.status !== "DRAFT");
}

/**
 * Thème-aware Wheat mark. Both variants stay mounted and are swapped with
 * opacity so changing theme never flashes the wrong logo.
 */
/**
 * Primary navigation.
 *
 * Grouped, always-visible entries: every feature Wheat ships has its own row
 * with an icon, a label and a plain-language tooltip. The rail can be
 * collapsed to icons to free horizontal space, but nothing disappears — the
 * tooltip then carries the same label and explanation.
 *
 * Each entry sets `aria-label` explicitly: collapsing hides the label text, so
 * without it the accessible name would fall back to the long tooltip.
 */
function AppRail({
  allowedPages,
  page,
  setPage,
  user,
  language,
  collapsed,
  onToggleCollapsed,
}: {
  /** Destinations reachable right now, or null when every one is. */
  allowedPages?: Page[] | null;
  page: Page;
  setPage: (page: Page) => void;
  user?: { name?: string };
  language: AppLanguage;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const iconFor = (target: Page) => navItems.find((item) => item.page === target)?.icon ?? LayoutDashboard;
  return (
    <aside className="wt-rail" aria-label="Navigation principale">
      <div className="wt-rail__brand">
        <WheatMark size={32} />
        <span className="wt-rail__brand-text">
          <span className="wt-rail__brand-name wheat-wordmark">Wheat</span>
          <span className="wt-rail__brand-note">comptabilité locale</span>
        </span>
        <IconButton
          className="wt-rail__collapse"
          label={collapsed ? "Deplier le menu" : "Replier le menu"}
          size="sm"
          onClick={onToggleCollapsed}
        >
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
        </IconButton>
      </div>

      <nav className="wt-rail__nav">
        {navGroups.map((group) => (
          <div className="wt-nav-group" key={group.id}>
            <span className="wt-nav-group__label">{group.label[language] ?? group.label.fr}</span>
            {group.pages.filter((target) => !allowedPages || allowedPages.includes(target)).map((target) => {
              const Icon = iconFor(target);
              const label = navLabel(target, language);
              return (
                <button
                  key={target}
                  type="button"
                  className={page === target ? "wt-nav-item nav-item is-active" : "wt-nav-item nav-item"}
                  aria-current={page === target ? "page" : undefined}
                  aria-label={label}
                  title={`${label} — ${pagePurpose[target]}`}
                  onClick={() => setPage(target)}
                >
                  {target === "wheat-ai" ? <WheatAiMark size={18} /> : <Icon size={18} aria-hidden="true" />}
                  <span className="wt-nav-item__label">{label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="wt-rail__foot">
        <button type="button" className="wt-rail__profile user-card" onClick={() => setPage("settings")}>
          <span className="wt-avatar" aria-hidden="true">{initialsFromName(user?.name)}</span>
          <span className="wt-rail__profile-text">
            <strong>{user?.name ?? "Utilisateur local"}</strong>
            <span>Profil de ce poste · Réglages</span>
          </span>
        </button>
        <span className="wt-rail__local" title="Vos données comptables restent sur cet ordinateur. Aucun compte cloud n'est requis.">
          <HardDrive size={13} aria-hidden="true" />
          <span>Données locales · aucun cloud</span>
        </span>
      </div>
    </aside>
  );
}

/**
 * Workspace header. It answers "which dossier am I in?" first, then offers
 * search and the two actions used dozens of times a day.
 */
function AppTopbar({
  data,
  currentCompany,
  query,
  setQuery,
  switchCompany,
  setCommandOpen,
  openEntryModal,
  setCompanyModalOpen,
  darkMode,
  setDarkMode,
  setPage,
  language,
  updateStatus,
}: any) {
  const copy = shellCopy[language as AppLanguage] ?? shellCopy.fr;
  const companies = (data?.companies ?? []) as any[];
  const companyOptions: WheatSelectOption[] = companies.map((company) => ({
    value: company.id,
    label: company.name,
    note: [company.legalForm, company.city].filter(Boolean).join(" · "),
    keywords: `${company.ice ?? ""} ${company.taxId ?? ""}`,
  }));
  const updateReady = updateStatus?.phase === "available" || updateStatus?.phase === "ready";

  return (
    <header className="wt-topbar topbar">
      <div className="wt-topbar__company company-switcher">
        <Building2 size={17} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
        <WheatSelect
          options={companyOptions}
          value={currentCompany?.id ?? ""}
          onChange={(value) => value && switchCompany(value)}
          ariaLabel={copy.activeCompany}
          placeholder={copy.noCompany}
          searchPlaceholder="Rechercher un dossier, un ICE…"
          noOptionsLabel="Aucun dossier"
          footerNote={`${companies.length} dossier(s)`}
        />
      </div>

      <div className="wt-topbar__search topbar-search">
        <SearchInput
          value={query}
          onChange={setQuery}
          ariaLabel="Rechercher une écriture"
          placeholder="Rechercher une écriture, une pièce, un journal…"
          onEnter={() => query.trim() && setPage("entries")}
          trailing={
            <button type="button" className="wt-kbd" onClick={() => setCommandOpen(true)} title="Ouvrir la palette de commandes">
              Ctrl K
            </button>
          }
        />
      </div>

      <div className="wt-topbar__actions">
        <Button variant="secondary" icon={<Building2 size={15} />} onClick={() => setCompanyModalOpen(true)}>
          {copy.newCompany}
        </Button>
        <Button variant="primary" className="primary-button" icon={<Plus size={15} />} onClick={openEntryModal}>
          {copy.newEntry}
        </Button>
        <span className="wt-topbar__divider" aria-hidden="true" />
        {updateReady && (
          <IconButton label="Une mise à jour Wheat est disponible — ouvrir Réglages" onClick={() => setPage("settings")}>
            <Download size={17} aria-hidden="true" style={{ color: "var(--success)" }} />
          </IconButton>
        )}
        <IconButton label={darkMode ? copy.darkOn : copy.darkOff} onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
        </IconButton>
        <IconButton label="Aide et raccourcis" onClick={() => setCommandOpen(true)}>
          <HelpCircle size={17} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Compact navigation for narrow windows. It shows the most used destinations
 * and always ends with "Tout" (the command palette) so no screen becomes
 * unreachable on a small display.
 */
function MobileNav({ page, setPage, language }: { page: Page; setPage: (page: Page) => void; language: AppLanguage }) {
  const visible: Page[] = ["home", "production", "entries", "documents", "billing", "reconciliation", "vat", "reports", "wheat-ai", "settings"];
  return (
    <nav className="wt-mobile-nav" aria-label="Navigation compacte">
      {visible.map((target) => {
        const Icon = navItems.find((item) => item.page === target)?.icon ?? LayoutDashboard;
        return (
          <button
            key={target}
            type="button"
            className={page === target ? "is-active" : ""}
            aria-current={page === target ? "page" : undefined}
            aria-label={navLabel(target, language)}
            onClick={() => setPage(target)}
            title={pagePurpose[target]}
          >
            {target === "wheat-ai" ? <WheatAiMark size={16} /> : <Icon size={16} aria-hidden="true" />}
            <span>{navLabel(target, language)}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Accueil — the guided landing screen.
 *
 * It answers, in order: which dossier am I in, what is the state of the work,
 * what should I do next, and where does everything else live. Nothing here is
 * a shortcut-only path: every tile also exists in the navigation rail.
 */
function HomePage({ data, currentCompany, metrics, journey, setPage, openGuidedTarget, openEntryModal, setCompanyModalOpen, resetWorkspace }: any) {
  const hasCompany = Boolean(currentCompany);
  const documents = (data?.documents ?? []) as any[];
  const pendingDocuments = documents.filter((document) => !document.invoiceId).length;
  const draftEntries = (data?.entries ?? []).filter((entry: any) => isDraftEntry(entry)).length;

  // The journey is derived in the main process from the dossier's own
  // records. When it is available it decides the next step; the local
  // heuristics below stay as the offline fallback.
  const derivedNext = journey?.next
    ? {
        title: journey.next.title,
        text: `${journey.next.state} ${journey.next.why}`,
        label: journey.next.action?.label ?? "Ouvrir",
        run: () => journey.next.action && openGuidedTarget(journey.next.action.target),
      }
    : null;

  const nextStep = derivedNext ?? (!hasCompany
    ? {
        title: "Commencez par créer un dossier",
        text: "Un dossier représente une société : son plan comptable, ses journaux et ses exercices.",
        label: "Créer un dossier",
        run: () => setCompanyModalOpen(true),
      }
    : pendingDocuments > 0
      ? {
          title: `${pendingDocuments} pièce(s) attendent d'être traitées`,
          text: "Ouvrez Documents & OCR pour vérifier les montants lus, puis créez les factures correspondantes.",
          label: "Traiter les pièces",
          run: () => setPage("documents"),
        }
      : draftEntries > 0
        ? {
            title: `${draftEntries} brouillon(s) à contrôler`,
            text: "Un brouillon n'a aucun effet comptable tant qu'il n'est pas comptabilisé. Vérifiez-le puis validez-le.",
            label: "Ouvrir les écritures",
            run: () => setPage("entries"),
          }
        : {
            title: "Le dossier est à jour",
            text: "Aucune pièce en attente et aucun brouillon. Vous pouvez saisir une écriture ou contrôler la banque.",
            label: "Nouvelle écriture",
            run: openEntryModal,
          });

  const steps: Array<{ n: number; icon: ReactNode; title: string; text: string; cta: string; run: () => void }> = [
    {
      n: 1,
      icon: <Building2 size={18} aria-hidden="true" />,
      title: hasCompany ? "Vérifier le dossier" : "Créer le dossier",
      text: hasCompany
        ? `Vous travaillez sur ${currentCompany.name}. Vérifiez l'ICE, l'exercice et le regime de TVA.`
        : "Renseignez la raison sociale, l'ICE et l'exercice comptable de votre client.",
      cta: hasCompany ? "Voir les dossiers" : "Créer un dossier",
      run: () => (hasCompany ? setPage("companies") : setCompanyModalOpen(true)),
    },
    {
      n: 2,
      icon: <FileSearch size={18} aria-hidden="true" />,
      title: "Importer les pièces",
      text: "Deposez les factures et justificatifs. Wheat lit les montants (OCR) et vous les fait confirmer.",
      cta: "Ouvrir Documents & OCR",
      run: () => setPage("documents"),
    },
    {
      n: 3,
      icon: <BookOpen size={18} aria-hidden="true" />,
      title: "Comptabiliser",
      text: "Transformez les pièces en écritures, ou saisissez directement au journal.",
      cta: "Nouvelle écriture",
      run: openEntryModal,
    },
    {
      n: 4,
      icon: <Landmark size={18} aria-hidden="true" />,
      title: "Pointer la banque",
      text: "Importez le relevé et associez chaque mouvement a son écriture comptable.",
      cta: "Ouvrir le rapprochement",
      run: () => setPage("reconciliation"),
    },
    {
      n: 5,
      icon: <Percent size={18} aria-hidden="true" />,
      title: "Déclarer la TVA",
      text: "Preparez la déclaration, contrôlez-la et archivez son dossier de travail.",
      cta: "Ouvrir la TVA",
      run: () => setPage("vat"),
    },
    {
      n: 6,
      icon: <FileSpreadsheet size={18} aria-hidden="true" />,
      title: "Clôturer l'exercice",
      text: "États financiers, retraitements fiscaux et liasse à déposer.",
      cta: "Ouvrir la liasse",
      run: () => setPage("fiscal"),
    },
  ];

  return (
    <>
      <PageHeader
        icon={<LayoutDashboard size={22} aria-hidden="true" />}
        title="Accueil"
        purpose={pagePurpose.home}
        meta={
          <>
            <span><Building2 size={13} aria-hidden="true" /> {currentCompany?.name ?? "Aucun dossier ouvert"}</span>
            {currentCompany && <span><Calendar size={13} aria-hidden="true" /> Exercice {currentCompany.fiscalYear ?? new Date().getFullYear()}</span>}
            <span><HardDrive size={13} aria-hidden="true" /> Données stockees sur cet ordinateur</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => setPage("production")}>
              Production du jour
            </Button>
            <Button variant="secondary" icon={<Plus size={15} />} onClick={openEntryModal}>
              Nouvelle écriture
            </Button>
          </>
        }
        help={{
          summary: "Première fois sur Wheat ? Lisez ceci.",
          content: (
            <>
              <p>Wheat tient la comptabilité d'une ou plusieurs sociétés, appelees ici <strong>dossiers</strong>. Tout se passe en local : aucune donnée ne part sur internet.</p>
              <p>Le travail suit toujours le même chemin : on <strong>collecte</strong> les pièces, on les <strong>comptabilisé</strong>, on <strong>pointe la banque</strong>, on <strong>declare la TVA</strong>, puis on <strong>clôture</strong> l'exercice. Les six étapes ci-dessous suivent cet ordre.</p>
              <p>Le menu de gauche donne accès a toutes les fonctions, groupees par moment du travail. Rien n'est cache : si une fonction existe, elle a une ligne dans ce menu.</p>
            </>
          ),
        }}
      />

      <NextStep title={nextStep.title} text={nextStep.text} action={<Button variant="primary" onClick={nextStep.run}>{nextStep.label}</Button>} />

      <div className="wt-grid wt-grid--narrow">
        <Stat
          label="Écritures"
          value={metrics.entryCount}
          note="Toutes écritures du dossier, brouillons compris"
          tip="Une écriture comptable enregistre une operation en respectant l'équilibre debit = credit."
        />
        <Stat
          label="Trésorerie"
          value={metricMoney(metrics, "bankTotal")}
          note="Solde des comptes bancaires connus"
          tip="Somme des soldes des comptes bancaires enregistrès dans le dossier."
        />
        <Stat
          label="Factures impayées"
          value={metricMoney(metrics, "unpaidTotal")}
          note="Reste du par vos clients"
          tip="Total des factures de vente comptabilisées dont le règlement n'est pas encore encaissé."
        />
        <Stat
          label="TVA à décaisser"
          value={metricMoney(metrics, "dueVat")}
          note="Estimation à vérifier avant déclaration"
          tip="TVA collectée sur les ventes moins TVA déductible sur les achats. A confirmer dans l'écran TVA."
        />
      </div>

      {journey ? (
        <GuidedJourney journey={journey} onOpen={openGuidedTarget} />
      ) : (
        <Section
          title="Les six étapes d'un dossier"
          note="Elles suivent l'ordre reel d'un mois comptable. Chaque étape ouvre l'écran dédié."
        >
          <div className="wt-grid">
            {steps.map((step) => (
              <FeatureTile
                key={step.n}
                icon={step.icon}
                title={`${step.n}. ${step.title}`}
                description={step.text}
                cta={step.cta}
                onClick={step.run}
              />
            ))}
          </div>
        </Section>
      )}

      <div className="wt-split">
        <Card
          title="Où trouver le reste"
          note="Wheat ne masque aucune fonction. Voici les écrans moins quotidiens, avec ce qu'ils font."
        >
          <ul className="wt-list">
            {(["billing", "payroll", "statements", "reports", "books", "sage", "assistant", "wheat-ai"] as Page[]).map((target) => {
              const Icon = navItems.find((item) => item.page === target)?.icon ?? FileText;
              return (
                <li className="wt-list__item" key={target}>
                  {target === "wheat-ai" ? <WheatAiMark size={18} /> : <Icon size={18} aria-hidden="true" style={{ color: "var(--brand)" }} />}
                  <span className="wt-list__item-text">
                    <strong>{navLabel(target, "fr")}</strong>
                    <span>{pagePurpose[target]}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setPage(target)} trailingIcon={<ArrowRight size={14} />}>
                    Ouvrir
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="wt-stack">
          <Card
            title="Découvrir avec un jeu d'essai"
            note="Remplace le contenu local par un dossier de démonstration déjà rempli, pour se familiariser sans risque."
          >
            <Callout tone="warning" title="Cette action remplace les données locales">
              Les sociétés et écritures présentés sur ce poste seront supprimées. Faites une sauvegarde d'abord si elles comptent.
            </Callout>
            <div className="wt-row">
              <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => resetWorkspace("demo")}>
                Charger le dossier de démonstration
              </Button>
              <Button variant="ghost" icon={<DatabaseBackup size={15} />} onClick={() => setPage("settings")}>
                Sauvegardes
              </Button>
            </div>
          </Card>

          <Card
            title="Repartir de zéro"
            note="Vide entièrement la base locale pour commencer un dossier neuf. Une confirmation est demandee."
          >
            <Button variant="danger-outline" icon={<RotateCcw size={15} />} onClick={() => resetWorkspace("blank")}>
              Vider et recommencer
            </Button>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Production du jour — the daily work queue.
 *
 * Same five steps a practice follows every morning, each with its own visible
 * section, its own count and its own button. Nothing is auto-posted: every
 * step ends with an action the user triggers.
 */
function ProductionPage({
  data,
  currentCompany,
  metrics,
  journey,
  setPage,
  openGuidedTarget,
  postDocumentEntry,
  matchBankMovement,
  openContextMenu,
  copyToClipboard,
  deleteBankMovement,
  deleteDocumentRecord,
}: any) {
  const documents = (data?.documents ?? []) as any[];
  const ocrStats = buildSmartOcrStats(documents);
  const pendingDocuments = documents.filter((document) => !document.invoiceId);
  const reviewDocuments = documents.filter((document) => document.status === "TO_REVIEW" || (safeJson(document.extracted).uncertainFields ?? []).length);
  const nextDocument = pendingDocuments[0];
  const movements = collectBankMovements(data);
  const unmatchedMovements = movements.filter((movement: any) => movement.status !== "MATCHED");
  const nextMovement = unmatchedMovements[0];
  const postedCount = documents.filter((document) => document.status === "POSTED").length;
  const totalUnits = documents.length + movements.length;
  const doneUnits = postedCount + (movements.length - unmatchedMovements.length);
  const flowScore = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 100;

  const steps: Array<{
    id: string;
    icon: ReactNode;
    title: string;
    what: string;
    state: string;
    tone: Tone;
    cta: string;
    run: () => void;
  }> = [
    {
      id: "collect",
      icon: <FileUp size={18} aria-hidden="true" />,
      title: "1. Collecter les pièces",
      what: "Importer les factures, reçus et relevés du dossier avant toute saisie.",
      state: currentCompany ? `${documents.length} pièce(s) déjà dans le dossier` : "Aucun dossier ouvert",
      tone: documents.length ? "success" : "neutral",
      cta: "Importer une pièce",
      run: () => setPage("documents"),
    },
    {
      id: "ocr",
      icon: <FileSearch size={18} aria-hidden="true" />,
      title: "2. Vérifier la lecture OCR",
      what: "Contrôler les montants lus automatiquement. Wheat signale les champs incertains.",
      state: `${reviewDocuments.length} à vérifier · confiance moyenne ${ocrStats.averageConfidence}%`,
      tone: reviewDocuments.length ? "warning" : "success",
      cta: "Vérifier l'OCR",
      run: () => setPage("documents"),
    },
    {
      id: "post",
      icon: <BookOpen size={18} aria-hidden="true" />,
      title: "3. Créer les factures",
      what: "Transformer une pièce lue en brouillon de facture, à contrôler puis comptabiliser.",
      state: nextDocument ? `Prochaine pièce : ${nextDocument.title}` : "Toutes les pièces sont rattachees",
      tone: nextDocument ? "brand" : "success",
      cta: nextDocument ? "Créer le brouillon" : "Ouvrir les documents",
      run: () => (nextDocument ? postDocumentEntry(nextDocument.id) : setPage("documents")),
    },
    {
      id: "bank",
      icon: <Landmark size={18} aria-hidden="true" />,
      title: "4. Rapprocher la banque",
      what: "Associer chaque ligne du relevé bancaire a l'écriture qui la justifié.",
      state: unmatchedMovements.length ? `${unmatchedMovements.length} mouvement(s) sans preuve` : "Tous les mouvements sont rapproches",
      tone: unmatchedMovements.length ? "warning" : "success",
      cta: nextMovement ? "Rapprocher maintenant" : "Ouvrir le rapprochement",
      run: () => (nextMovement ? matchBankMovement(nextMovement.id) : setPage("reconciliation")),
    },
    {
      id: "vat",
      icon: <Percent size={18} aria-hidden="true" />,
      title: "5. Preparer la TVA",
      what: "Vérifier le calcul, rattacher les justificatifs et archiver le dossier de travail.",
      state: `Estimation courante : ${metricMoney(metrics, "dueVat")}`,
      tone: "brand",
      cta: "Ouvrir la TVA",
      run: () => setPage("vat"),
    },
  ];

  return (
    <div className="production-page wt-stack">
      <PageHeader
        icon={<Sparkles size={22} aria-hidden="true" />}
        title="Production du jour"
        purpose={pagePurpose.production}
        meta={
          <>
            <span><Building2 size={13} aria-hidden="true" /> {currentCompany?.name ?? "Aucun dossier ouvert"}</span>
            <span><ListChecks size={13} aria-hidden="true" /> {pendingDocuments.length} pièce(s) et {unmatchedMovements.length} mouvement(s) en attente</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<FileUp size={15} />} onClick={() => setPage("documents")}>
              Importer une pièce
            </Button>
            <Button variant="secondary" icon={<Landmark size={15} />} onClick={() => setPage("reconciliation")}>
              Rapprochement
            </Button>
          </>
        }
        help={{
          summary: "Pourquoi cet ordre ?",
          content: (
            <>
              <p>Une comptabilité se tient dans un ordre precis : on ne peut pas rapprocher la banque avant d'avoir comptabilisé les factures, ni déclarer la TVA avant d'avoir tout rapproche.</p>
              <p>Cet écran suit cet ordre et vous indique, à chaque étape, combien d'éléments restent. Vous pouvez toujours sauter une étape : les écrans dédiés restent accessibles depuis le menu de gauche.</p>
            </>
          ),
        }}
      />

      <div className="wt-grid wt-grid--narrow">
        <Stat label="Avancement du flux" value={`${flowScore}%`} note={`${doneUnits} élément(s) traités sur ${totalUnits}`} tip="Part des pièces comptabilisées et des mouvements rapproches sur l'ensemble reçu." />
        <Stat label="Pièces OCR" value={documents.length} note={`${ocrStats.averageConfidence}% de confiance moyenne`} tip="La confiance OCR mesure la certitude de la lecture automatique. En dessous de 80 %, vérifiez le montant." />
        <Stat label="A vérifier" value={reviewDocuments.length} note="Champs incertains signalés" tip="Documents dont au moins un champ lu doit être confirme à la main." />
        <Stat label="Comptabilisées" value={postedCount} note={`${pendingDocuments.length} encore en attente`} />
        <Stat label="Banque a pointer" value={unmatchedMovements.length} note="Mouvements sans écriture associée" />
      </div>

      {journey && <GuidedJourney journey={journey} onOpen={openGuidedTarget} compact />}

      <Section title="Le parcours du jour" note="Cinq étapes, dans l'ordre. Chacune indique ou vous en êtes et ce qu'il reste à faire.">
        <div className="wt-grid">
          {steps.map((step) => (
            <Card
              key={step.id}
              className="production-step"
              title={step.title}
              note={step.what}
              icon={step.icon}
              actions={<Badge tone={step.tone} dot>{step.tone === "success" ? "A jour" : step.tone === "warning" ? "A traiter" : "En cours"}</Badge>}
              footer={
                <>
                  <span className="wt-hint">{step.state}</span>
                  <span className="wt-spacer" />
                  <Button variant={step.tone === "warning" ? "primary" : "secondary"} size="sm" onClick={step.run} trailingIcon={<ArrowRight size={14} />}>
                    {step.cta}
                  </Button>
                </>
              }
            />
          ))}
        </div>
      </Section>

      <div className="wt-split wt-split--even">
        <Card
          title="Pièces à traiter"
          note="Documents importés qui n'ont pas encore de facture rattachée."
          icon={<FileText size={18} aria-hidden="true" />}
          actions={<Button variant="ghost" size="sm" onClick={() => setPage("documents")}>Tout voir</Button>}
          flush
        >
          {!pendingDocuments.length ? (
            <EmptyState
              icon={<CheckCircle2 size={22} aria-hidden="true" />}
              title="Aucune pièce en attente"
              text="Toutes les pièces importées sont rattachees a une facture. Importez de nouveaux documents pour continuer."
              actions={<Button variant="secondary" onClick={() => setPage("documents")}>Importer une pièce</Button>}
            />
          ) : (
            <ul className="wt-list">
              {pendingDocuments.slice(0, 6).map((document: any) => {
                const extracted = safeJson(document.extracted);
                const fields = readSmartFields(extracted);
                const confidence = readSmartConfidence(extracted);
                return (
                  <li
                    key={document.id}
                    className="wt-list__item"
                    onContextMenu={(event) =>
                      openContextMenu?.(event, [
                        {
                          label: document.storedPath ? "Ouvrir le fichier" : "Fichier indisponible",
                          icon: FileText,
                          disabled: !document.storedPath,
                          run: () => window.wheat?.openPath(document.storedPath),
                        },
                        {
                          label: document.invoiceId ? "Facture déjà créée" : "Créer le brouillon de facture",
                          icon: BadgeCheck,
                          disabled: Boolean(document.invoiceId),
                          run: () => postDocumentEntry(document.id),
                        },
                        { label: "Supprimer le document", icon: Trash2, tone: "danger", run: () => deleteDocumentRecord(document) },
                      ], document.title)
                    }
                  >
                    <span className="wt-list__item-text">
                      <strong>{document.title}</strong>
                      <span>{smartTypeLabel(readSmartType(extracted, document.type), document.type)} · {fields.counterparty || fields.supplier || "Tiers à confirmer"}</span>
                    </span>
                    <span className="wt-num" style={{ fontWeight: 600 }}>
                      {fields.ttc ? money(Number(fields.ttc), fields.currency || "MAD") : `${confidence}%`}
                    </span>
                    <Button variant="primary" size="sm" disabled={Boolean(document.invoiceId)} onClick={() => postDocumentEntry(document.id)}>
                      {document.invoiceId ? "Brouillon créé" : "Créer la facture"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title="Banque à rapprocher"
          note="Mouvements bancaires importés qui n'ont pas encore d'écriture comptable associée."
          icon={<Landmark size={18} aria-hidden="true" />}
          actions={<Button variant="ghost" size="sm" onClick={() => setPage("reconciliation")}>Tout voir</Button>}
          flush
        >
          {!unmatchedMovements.length ? (
            <EmptyState
              icon={<CheckCircle2 size={22} aria-hidden="true" />}
              title="Banque à jour"
              text="Chaque mouvement importé est rapproche d'une écriture. Importez un nouveau relevé pour continuer."
              actions={<Button variant="secondary" onClick={() => setPage("reconciliation")}>Importer un relevé</Button>}
            />
          ) : (
            <ul className="wt-list">
              {unmatchedMovements.slice(0, 6).map((movement: any) => (
                <li
                  key={movement.id}
                  className="wt-list__item"
                  onContextMenu={(event) =>
                    openContextMenu?.(event, [
                      { label: "Rapprocher ce mouvement", icon: CheckCircle2, run: () => matchBankMovement(movement.id) },
                      { label: "Copier la référence", icon: Copy, disabled: !movement.reference, run: () => copyToClipboard(movement.reference, "Reference copiee") },
                      { label: "Exclure avec motif", icon: Trash2, tone: "danger", run: () => deleteBankMovement(movement) },
                    ], movement.reference ?? movement.label)
                  }
                >
                  <span className="wt-list__item-text">
                    <strong>{movement.label}</strong>
                    <span>{date(movement.date)} · correspondance estimee {movement.confidence}%</span>
                  </span>
                  <span className="wt-num" style={{ fontWeight: 600 }}>{money(movement.amount)}</span>
                  <Button variant="secondary" size="sm" onClick={() => matchBankMovement(movement.id)}>
                    Rapprocher
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Section title="Aller plus loin" note="Les écrans complets, avec tous leurs outils. Ils sont aussi dans le menu de gauche.">
        <div className="wt-grid">
          <FeatureTile icon={<Percent size={18} />} title="TVA" description={pagePurpose.vat} cta="Ouvrir la TVA" onClick={() => setPage("vat")} />
          <FeatureTile icon={<FileSearch size={18} />} title="Rapports comptables" description={pagePurpose.reports} cta="Editer un rapport" onClick={() => setPage("reports")} />
          <FeatureTile icon={<Banknote size={18} />} title="Factures & paiements" description={pagePurpose.billing} cta="Ouvrir la facturation" onClick={() => setPage("billing")} />
          <FeatureTile icon={<ShieldCheck size={18} />} title="Contrôles & imports" description={pagePurpose.books} cta="Ouvrir les contrôles" onClick={() => setPage("books")} />
        </div>
      </Section>
    </div>
  );
}

/**
 * Tableau de bord — the numbers a manager looks at first.
 *
 * Every figure carries a plain-language tooltip explaining what it measures
 * and where it comes from, so the screen reads without accounting training.
 */
function Dashboard({ data, entries, metrics, setPage, alertsMuted, setAlertsMuted, notify, language }: any) {
  const labels = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const postedEntries = ledgerEntries(entries);
  const currentCompany = (data?.companies ?? []).find((company: any) => company.id === data?.activeCompanyId) ?? data?.companies?.[0];
  const fiscalYear = (currentCompany?.fiscalYears ?? []).find((year: any) => year.status === "OPEN") ?? currentCompany?.fiscalYears?.[0];
  const taxPeriod = data?.taxPeriods?.[0];

  const periodOptions: WheatSelectOption[] = [
    { value: "fiscal-year", label: fiscalYear ? `Exercice ${date(fiscalYear.startsOn)} - ${date(fiscalYear.endsOn)}` : "Toutes les périodes", note: "Période comptable ouverte" },
    { value: "tax-period", label: taxPeriod?.label ?? "Période TVA non définie", note: "Période de déclaration TVA" },
    { value: "all", label: "Depuis l'origine du dossier", note: "Toutes les écritures enregistrées" },
  ];
  const statusOptions: WheatSelectOption[] = [
    { value: "all", label: "Tous les statuts", note: "Brouillons et écritures comptabilisées" },
    { value: "posted", label: "Comptabilisées", note: "Definitives, incluses dans les états" },
    { value: "draft", label: "A contrôler", note: "Brouillons sans effet comptable" },
  ];
  const tagOptions: WheatSelectOption[] = [
    { value: "all", label: "Tous les domaines" },
    { value: "vat", label: "TVA" },
    { value: "bank", label: "Banque" },
    { value: "ocr", label: "Documents OCR" },
  ];

  const [period, setPeriod] = useState("fiscal-year");
  const [status, setStatus] = useState("all");
  const [tag, setTag] = useState("all");
  const [filterApplied, setFilterApplied] = useState(false);

  const labelOf = (options: WheatSelectOption[], value: string) => options.find((option) => option.value === value)?.label ?? value;

  const vatData = [
    { name: "TVA collectée", value: metrics.collectedVat, color: "var(--chart-1)" },
    { name: "TVA déductible", value: metrics.deductibleVat, color: "var(--chart-4)" },
    { name: "TVA à décaisser", value: metrics.dueVat, color: "var(--danger)" },
    { name: "Credit de TVA", value: metrics.creditVat, color: "var(--chart-5)" },
  ];
  const delayRows = buildDelayDeclarationRows(data?.invoices ?? []);
  const averageDelay = delayRows.length
    ? Math.round(delayRows.reduce((sum, row) => sum + Number(row["Jours de retard"] || 0), 0) / delayRows.length)
    : 0;

  return (
    <>
      <PageHeader
        icon={<BarChart3 size={22} aria-hidden="true" />}
        title="Tableau de bord"
        purpose={pagePurpose.dashboard}
        meta={
          <>
            <span><Building2 size={13} aria-hidden="true" /> {currentCompany?.name ?? "Aucun dossier"}</span>
            <span><Calendar size={13} aria-hidden="true" /> {labelOf(periodOptions, period)}</span>
          </>
        }
        actions={
          <>
            <Button variant="secondary" icon={<FileSearch size={15} />} onClick={() => setPage("reports")}>Rapports détaillés</Button>
            <Button variant="primary" icon={<Percent size={15} />} onClick={() => setPage("vat")}>Ouvrir la TVA</Button>
          </>
        }
        help={{
          summary: "Que veulent dire ces chiffres ?",
          content: (
            <>
              <p>Le <strong>chiffré d'affaires HT</strong> est le total des ventes hors taxe. Le <strong>résultat comptable</strong> est la difference entre les produits (classe 7) et les charges (classe 6).</p>
              <p>La <strong>TVA à décaisser</strong> est ce que l'entreprise doit reverser ; un <strong>credit de TVA</strong> signifie l'inverse.</p>
              <p>Tous ces chiffres proviennent uniquement des écritures <strong>comptabilisées</strong>. Les brouillons n'y figurent pas, ce qui explique un écart avec la saisie en cours.</p>
            </>
          ),
        }}
      />

      <div className="wt-filterbar" role="group" aria-label="Filtres du tableau de bord">
        <Field label="Période" htmlFor="dashboard-period" hint="Change la fenêtre de calcul des indicateurs.">
          <WheatSelect id="dashboard-period" options={periodOptions} value={period} onChange={setPeriod} ariaLabel="Période" />
        </Field>
        <Field label="Statut des écritures" htmlFor="dashboard-status" hint="Un brouillon n'a aucun effet comptable.">
          <WheatSelect id="dashboard-status" options={statusOptions} value={status} onChange={setStatus} ariaLabel="Statut des écritures" />
        </Field>
        <Field label="Domaine" htmlFor="dashboard-tag" hint="Restreint les alertes affichees.">
          <WheatSelect id="dashboard-tag" options={tagOptions} value={tag} onChange={setTag} ariaLabel="Domaine" />
        </Field>
        <div className="wt-filterbar__actions">
          <Button
            variant={filterApplied ? "soft" : "secondary"}
            icon={<Filter size={15} />}
            onClick={() => {
              setFilterApplied(true);
              notify(`Filtre actif : ${labelOf(periodOptions, period)} · ${labelOf(statusOptions, status)} · ${labelOf(tagOptions, tag)}`, "info");
            }}
          >
            Appliquer
          </Button>
          <Button
            variant="ghost"
            icon={<RefreshCw size={15} />}
            onClick={() => {
              setAlertsMuted(false);
              setPeriod("fiscal-year");
              setStatus("all");
              setTag("all");
              setFilterApplied(false);
            }}
          >
            Reinitialiser
          </Button>
        </div>
      </div>

      <div className="wt-grid wt-grid--narrow">
        <MetricCard
          title="Chiffre d'affaires (HT)"
          value={metricMoney(metrics, "revenue")}
          delta={`${metrics.entryCount} écriture(s) comptabilisée(s)`}
          tip="Total des ventes hors taxe sur la période, issu des comptes de la classe 7."
        />
        <MetricCard
          title="Résultat comptable"
          value={metricMoney(metrics, "result")}
          delta="Produits (classe 7) moins charges (classe 6)"
          tip="Benefice ou perte avant retraitements fiscaux. Le résultat fiscal se calculé dans la liasse."
        />
        <MetricCard
          title="TVA à décaisser"
          value={metricMoney(metrics, "dueVat")}
          delta={taxPeriod?.label ?? "Aucune période TVA définie"}
          tip="TVA collectée sur les ventes moins TVA déductible sur les achats. A confirmer dans l'écran TVA."
        />
        <MetricCard
          title="Solde bancaire total"
          value={metricMoney(metrics, "bankTotal")}
          delta={`${data?.bankAccounts?.length ?? 0} compte(s) bancaire(s)`}
          tip="Somme des soldes enregistrès pour les comptes bancaires du dossier."
        />
      </div>

      <div className="wt-split">
        <Card
          title={`TVA — ${taxPeriod?.label ?? "aucune période définie"}`}
          note="Répartition de la TVA sur la période. Le detail justifié chaque montant."
          icon={<Percent size={18} aria-hidden="true" />}
          actions={<Button variant="ghost" size="sm" onClick={() => setPage("vat")} trailingIcon={<ArrowRight size={14} />}>Voir le detail</Button>}
        >
          <div className="vat-layout">
            <Suspense fallback={<LoadingState label="Chargement du graphique TVA…" />}>
              <VatChart data={vatData} />
            </Suspense>
            <dl className="wt-kv">
              {vatData.map((item) => (
                <div key={item.name}>
                  <dt>
                    <span className="wt-dot" style={{ background: item.color, display: "inline-block", marginRight: "var(--space-3)" }} aria-hidden="true" />
                    {item.name}
                  </dt>
                  <dd>{money(item.value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>

        <div className="wt-stack">
          <Card
            title="Factures impayées"
            note="Ce que vos clients doivent encore, classe par ancienneté du retard."
            icon={<Banknote size={18} aria-hidden="true" />}
            actions={<Button variant="ghost" size="sm" onClick={() => setPage("reports")}>Balance agee</Button>}
          >
            <span className="wt-stat__value">{metricMoney(metrics, "unpaidTotal")}</span>
            <span className="wt-hint">{metrics.unpaidCount} facture(s) · delai moyen observe {averageDelay} jour(s)</span>
            <AgingBars invoices={data?.invoices ?? []} />
          </Card>
        </div>
      </div>

      <div className="wt-split wt-split--even">
        <Card
          title="Alertes"
          note="Ce qui demande une action. Chaque ligne indique le nombre d'éléments concernés."
          icon={<AlertTriangle size={18} aria-hidden="true" />}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setAlertsMuted(!alertsMuted)}>
              {alertsMuted ? "Reafficher" : "Marquer comme lu"}
            </Button>
          }
          flush
        >
          <AlertList muted={alertsMuted} data={data} setPage={setPage} />
        </Card>

        <Card
          title={labels.assistantTitle ?? pageCopy.fr.assistantTitle}
          note="Un résumé calculé sur ce poste, sans connexion internet."
          icon={<FileSearch size={18} aria-hidden="true" />}
          actions={<Button variant="ghost" size="sm" onClick={() => setPage("assistant")}>Ouvrir</Button>}
        >
          <dl className="wt-kv">
            <div><dt>Écritures comptabilisées</dt><dd>{ledgerEntries(data?.entries ?? []).length}</dd></div>
            <div><dt>Documents à traiter</dt><dd>{(data?.documents ?? []).filter((document: any) => document.status !== "POSTED").length}</dd></div>
            <div><dt>Mouvements à rapprocher</dt><dd>{collectBankMovements(data).filter((movement: any) => movement.status !== "MATCHED").length}</dd></div>
          </dl>
          <Button variant="secondary" icon={<Send size={15} />} onClick={() => setPage("assistant")} block>
            Interroger les données locales
          </Button>
        </Card>
      </div>

      <Card
        title="Dernières écritures comptabilisées"
        note="Les huit écritures definitives les plus recentes. Un brouillon n'apparait pas ici."
        icon={<BookOpen size={18} aria-hidden="true" />}
        actions={<Button variant="ghost" size="sm" onClick={() => setPage("entries")} trailingIcon={<ArrowRight size={14} />}>Toutes les écritures</Button>}
        flush
      >
        {postedEntries.length ? (
          <EntryTable entries={postedEntries.slice(0, 8)} dense />
        ) : (
          <EmptyState
            icon={<BookOpen size={22} aria-hidden="true" />}
            title="Aucune écriture comptabilisée"
            text="Les écritures apparaissent ici une fois comptabilisées. Un brouillon reste modifiable et n'a pas d'effet comptable."
            actions={<Button variant="primary" onClick={() => setPage("entries")}>Ouvrir la saisie</Button>}
          />
        )}
      </Card>

      <Card
        title="Solde par compte bancaire"
        note="Solde enregistre dans la base locale pour chaque compte du dossier."
        icon={<Landmark size={18} aria-hidden="true" />}
        actions={<Button variant="ghost" size="sm" onClick={() => setPage("reconciliation")}>Rapprochement</Button>}
      >
        {(data?.bankAccounts ?? []).length ? (
          <div className="wt-grid wt-grid--narrow">
            {(data?.bankAccounts ?? []).map((account: any) => (
              <div className="wt-stat" key={account.id}>
                <span className="wt-stat__label"><Banknote size={14} aria-hidden="true" /> {account.bankName}</span>
                <span className="wt-stat__value wt-stat__value--sm">{money(account.balance, account.currency)}</span>
                <span className="wt-stat__note"><span className="wt-code">{account.iban}</span></span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Landmark size={22} aria-hidden="true" />}
            title="Aucun compte bancaire enregistre"
            text="Ajoutez un compte bancaire dans Contrôles & imports > Référentiels pour importer des relevés et rapprocher les mouvements."
            actions={<Button variant="secondary" onClick={() => setPage("books")}>Ouvrir les référentiels</Button>}
          />
        )}
      </Card>
    </>
  );
}

function MetricCard({ title, value, delta, tip }: { title: string; value: ReactNode; delta?: ReactNode; tip?: string }) {
  return (
    <div className="wt-stat metric-card">
      <span className="wt-stat__label">
        {title}
        {tip && <InfoTip text={tip} />}
      </span>
      <span className="wt-stat__value">{value}</span>
      {delta && <span className="wt-stat__note">{delta}</span>}
      <Suspense fallback={<span className="wt-skeleton wt-skeleton--text" aria-hidden="true" />}>
        <MetricSparkline data={sparkData} />
      </Suspense>
    </div>
  );
}

/** Aged receivables, drawn as labelled meters rather than an unlabelled chart. */
function AgingBars({ invoices }: any) {
  const buckets = [
    { label: "0 a 30 jours", hint: "Retard recent", value: invoices.filter((invoice: any) => daysBetween(invoice.dueDate) <= 30).reduce((sum: number, invoice: any) => sum + invoice.ttc, 0), tone: "success" },
    { label: "31 a 60 jours", hint: "A relancer", value: invoices.filter((invoice: any) => daysBetween(invoice.dueDate) > 30 && daysBetween(invoice.dueDate) <= 60).reduce((sum: number, invoice: any) => sum + invoice.ttc, 0), tone: "warning" },
    { label: "61 a 90 jours", hint: "Relance urgente", value: invoices.filter((invoice: any) => daysBetween(invoice.dueDate) > 60 && daysBetween(invoice.dueDate) <= 90).reduce((sum: number, invoice: any) => sum + invoice.ttc, 0), tone: "warning" },
    { label: "Plus de 90 jours", hint: "Risque d'impayé", value: invoices.filter((invoice: any) => daysBetween(invoice.dueDate) > 90).reduce((sum: number, invoice: any) => sum + invoice.ttc, 0), tone: "danger" },
  ];

  const max = Math.max(...buckets.map((bucket) => bucket.value), 1);
  return (
    <div className="wt-stack wt-stack--tight">
      {buckets.map((bucket) => (
        <div className={`wt-meter wt-meter--${bucket.tone}`} key={bucket.label}>
          <div className="wt-meter__head">
            <span>{bucket.label} <span className="wt-hint">· {bucket.hint}</span></span>
            <strong className="wt-num">{money(bucket.value)}</strong>
          </div>
          <div className="wt-meter__track">
            <div className="wt-meter__fill" style={{ width: `${(bucket.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Alerts, each with a plain description and a button that opens the right screen. */
function AlertList({ muted, data, setPage }: { muted: boolean; data: any; setPage?: (page: Page) => void }) {
  const taxPeriod = data?.taxPeriods?.[0];
  const invoices = data?.invoices ?? [];
  const overdueInvoices = invoices.filter((invoice: any) => invoice.status === "OVERDUE" || (["UNPAID"].includes(invoice.status) && daysBetween(invoice.dueDate) > 0));
  const unmatchedMovements = collectBankMovements(data).filter((movement: any) => movement.status !== "MATCHED");
  const pendingDocuments = (data?.documents ?? []).filter((document: any) => document.status !== "POSTED");
  const drafts = (data?.entries ?? []).filter((entry: any) => entry.status === "DRAFT");

  const alerts: Array<{ icon: ReactNode; title: string; detail: string; tone: Tone; target?: Page; cta?: string }> = [
    ...(taxPeriod ? [{
      icon: <Calendar size={17} aria-hidden="true" />,
      title: `Declaration TVA — ${taxPeriod.label}`,
      detail: `Échéance enregistrée : ${date(taxPeriod.declarationDue)} · ${taxPeriod.status === "TO_FILE" ? "à déclarer" : statusLabel(taxPeriod.status)}`,
      tone: "danger" as Tone,
      target: "vat" as Page,
      cta: "Preparer",
    }] : []),
    {
      icon: <AlertTriangle size={17} aria-hidden="true" />,
      title: `${overdueInvoices.length} facture(s) en retard de paiement`,
      detail: `Montant total ${money(overdueInvoices.reduce((sum: number, invoice: any) => sum + Number(invoice.ttc || 0), 0))}`,
      tone: "warning",
      target: "billing",
      cta: "Relancer",
    },
    {
      icon: <Landmark size={17} aria-hidden="true" />,
      title: "Rapprochement bancaire",
      detail: `${unmatchedMovements.length} mouvement(s) sans écriture associée`,
      tone: unmatchedMovements.length ? "warning" : "success",
      target: "reconciliation",
      cta: "Rapprocher",
    },
    {
      icon: <FileText size={17} aria-hidden="true" />,
      title: "Documents à traiter",
      detail: `${pendingDocuments.length} document(s) importé(s) non comptabilisé(s)`,
      tone: pendingDocuments.length ? "info" : "success",
      target: "documents",
      cta: "Traiter",
    },
    {
      icon: <BookOpen size={17} aria-hidden="true" />,
      title: "Brouillons à contrôler",
      detail: `${drafts.length} écriture(s) préparée(s) sans effet comptable`,
      tone: drafts.length ? "info" : "success",
      target: "entries",
      cta: "Contrôler",
    },
  ];

  if (muted) {
    return (
      <div className="wt-card__body">
        <Callout tone="neutral" title="Alertes masquees">
          Les alertes sont marquees comme lues pour cette session. Utilisez « Reafficher » pour les revoir : rien n'est supprime.
        </Callout>
      </div>
    );
  }

  return (
    <ul className="wt-list">
      {alerts.map((alert) => (
        <li className="wt-list__item" key={alert.title}>
          <span style={{ color: `var(--${alert.tone === "info" ? "info" : alert.tone})`, display: "flex" }}>{alert.icon}</span>
          <span className="wt-list__item-text">
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
          </span>
          {alert.target && setPage && (
            <Button variant="ghost" size="sm" onClick={() => setPage(alert.target!)} trailingIcon={<ArrowRight size={14} />}>
              {alert.cta}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The shared ledger table. Column headers explain the accounting vocabulary. */
function EntryTable({ entries, dense = false, onDuplicate, onPost, onReverse, openContextMenu, contextActions }: any) {
  const hasActions = Boolean(onDuplicate || onPost || onReverse);
  return (
    <TableWrap label="Écritures comptables">
      <table className={dense ? "wt-table wt-table--dense" : "wt-table"}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">N° de pièce</th>
            <th scope="col">Journal</th>
            <th scope="col">Libellé</th>
            <th scope="col" className="is-numeric">Débit</th>
            <th scope="col" className="is-numeric">Crédit</th>
            <th scope="col">Statut</th>
            {hasActions && <th scope="col" className="is-numeric">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry: any) => {
            const debit = entry.lines.reduce((sum: number, line: any) => sum + line.debit, 0);
            const credit = entry.lines.reduce((sum: number, line: any) => sum + line.credit, 0);
            const meta = entryStatusMeta(entry.status);
            return (
              <tr
                key={entry.id}
                onContextMenu={(event) => {
                  if (openContextMenu && contextActions) openContextMenu(event, contextActions(entry), entry.number ?? entry.pieceNumber);
                }}
              >
                <td className="wt-num">{date(entry.date)}</td>
                <td><span className="wt-code">{entry.pieceNumber}</span></td>
                <td>{entry.journal?.code}</td>
                <td className="wt-table__primary">{entry.label}</td>
                <td className="is-numeric">{money(debit)}</td>
                <td className="is-numeric">{money(credit)}</td>
                <td>
                  <Badge tone={statusBadgeTone(meta.tone)} dot>{meta.label}</Badge>
                </td>
                {hasActions && (
                  <td>
                    <div className="wt-table__actions">
                      {onPost && (
                        <Button
                          variant="soft"
                          size="sm"
                          icon={<BadgeCheck size={14} />}
                          disabled={!isDraftEntry(entry)}
                          onClick={() => onPost(entry.id)}
                          title={isDraftEntry(entry) ? "Rendre l'écriture definitive et l'inclure dans les états" : "Seul un brouillon peut être comptabilisé"}
                        >
                          Comptabiliser
                        </Button>
                      )}
                      {onDuplicate && (
                        <Button variant="ghost" size="sm" icon={<Copy size={14} />} onClick={() => onDuplicate(entry.id)} title="Créer un nouveau brouillon identique">
                          Dupliquer
                        </Button>
                      )}
                      {onReverse && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<RotateCcw size={14} />}
                          disabled={!isPostedEntry(entry)}
                          onClick={() => onReverse(entry.id)}
                          title={isPostedEntry(entry) ? "Créer l'écriture inverse qui annule celle-ci" : "Seule une écriture comptabilisée peut être extournee"}
                        >
                          Extourner
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Maps the legacy status tone vocabulary onto the design-system badge tones. */
function statusBadgeTone(tone: string): Tone {
  if (tone === "green" || tone === "success") return "success";
  if (tone === "amber" || tone === "warning") return "warning";
  if (tone === "red" || tone === "danger") return "danger";
  if (tone === "blue" || tone === "info") return "info";
  return "neutral";
}

/**
 * Dossiers — one card per company, with everything the user needs to tell
 * two dossiers apart (ICE, city, fiscal years) and switch between them.
 * The actions that used to hide in a right-click menu are visible buttons.
 */
function CompaniesPage({ data, activeCompanyId, switchCompany, setCompanyModalOpen, openContextMenu, copyToClipboard, deleteCompany, setPage }: any) {
  const [query, setQuery] = useState("");
  const companies = (data?.companies ?? []) as any[];
  const needle = query.trim().toLocaleLowerCase("fr-FR");
  const visible = needle
    ? companies.filter((company) => `${company.name} ${company.city ?? ""} ${company.ice ?? ""} ${company.taxId ?? ""}`.toLocaleLowerCase("fr-FR").includes(needle))
    : companies;

  return (
    <>
      <PageHeader
        icon={<Building2 size={22} aria-hidden="true" />}
        title="Dossiers"
        purpose={pagePurpose.companies}
        meta={<span><Building2 size={13} aria-hidden="true" /> {companies.length} dossier(s) sur ce poste</span>}
        actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCompanyModalOpen(true)}>Créer un dossier</Button>}
        help={{
          summary: "Qu'est-ce qu'un dossier ?",
          content: (
            <>
              <p>Un <strong>dossier</strong> correspond a une société. Il contient son plan comptable, ses journaux, ses exercices, ses écritures et ses documents.</p>
              <p>Les dossiers sont totalement étanches : une écriture saisie dans l'un n'apparait jamais dans un autre. Le dossier actif est celui affiche en haut à gauche de l'écran.</p>
              <p>L'<strong>ICE</strong> (Identifiant Commun de l'Entreprise) et l'<strong>IF</strong> (Identifiant Fiscal) figurent sur les documents officiels de la société ; ils sont repris sur les factures et la liasse.</p>
            </>
          ),
        }}
      />

      {companies.length > 5 && (
        <SearchInput value={query} onChange={setQuery} placeholder="Rechercher un dossier par nom, ville ou ICE…" ariaLabel="Rechercher un dossier" />
      )}

      {!companies.length ? (
        <EmptyState
          icon={<Building2 size={22} aria-hidden="true" />}
          title="Aucun dossier sur ce poste"
          text="Créez le dossier de votre première société : Wheat installe automatiquement le plan comptable marocain (PCGE) et les journaux usuels."
          actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCompanyModalOpen(true)}>Créer un dossier</Button>}
        />
      ) : !visible.length ? (
        <EmptyState
          icon={<Search size={22} aria-hidden="true" />}
          title="Aucun dossier ne correspond"
          text={`Aucun dossier ne contient « ${query} ». Vérifiez l'orthographe ou effacez la recherche.`}
          actions={<Button variant="secondary" onClick={() => setQuery("")}>Effacer la recherche</Button>}
        />
      ) : (
        <div className="wt-grid wt-grid--wide">
          {visible.map((company: any) => {
            const isActive = company.id === activeCompanyId;
            return (
              <Card
                key={company.id}
                className={isActive ? "company-card wt-card--accent" : "company-card"}
                title={company.name}
                note={[company.legalForm, company.city].filter(Boolean).join(" · ") || "Forme juridique non renseignée"}
                icon={<Building2 size={18} aria-hidden="true" />}
                actions={isActive ? <Badge tone="brand" dot>Dossier actif</Badge> : undefined}
                footer={
                  <>
                    <Button variant={isActive ? "ghost" : "primary"} size="sm" disabled={isActive} onClick={() => switchCompany(company.id)}>
                      {isActive ? "Déjà ouvert" : "Ouvrir ce dossier"}
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Copy size={14} />} disabled={!company.ice} onClick={() => copyToClipboard(company.ice, "ICE copie")}>
                      Copier l'ICE
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Settings size={14} />} onClick={() => { switchCompany(company.id); setPage?.("books"); }}>
                      Paramétrer
                    </Button>
                    <span className="wt-spacer" />
                    <Button variant="danger-outline" size="sm" icon={<Trash2 size={14} />} onClick={() => deleteCompany(company)}>
                      Supprimer
                    </Button>
                  </>
                }
              >
                <div
                  onContextMenu={(event) =>
                    openContextMenu?.(event, [
                      { label: isActive ? "Dossier déjà ouvert" : "Ouvrir ce dossier", icon: Building2, disabled: isActive, run: () => switchCompany(company.id) },
                      { label: "Continuer la configuration", icon: ListChecks, run: () => { switchCompany(company.id); setPage?.("home"); } },
                      { label: "Contrôler la santé du dossier", icon: ShieldCheck, run: () => { switchCompany(company.id); setPage?.("books"); } },
                      { label: "Ouvrir les paramètres", icon: Settings, run: () => { switchCompany(company.id); setPage?.("settings"); } },
                      { label: "Copier l'ICE", icon: Copy, disabled: !company.ice, run: () => copyToClipboard(company.ice, "ICE copie") },
                      { label: "Copier l'identifiant fiscal", icon: Copy, disabled: !company.taxId, run: () => copyToClipboard(company.taxId, "Identifiant fiscal copié") },
                      { label: "Supprimer le dossier", icon: Trash2, tone: "danger", run: () => deleteCompany(company) },
                    ], company.name)
                  }
                >
                  <dl className="wt-kv">
                    <div>
                      <dt>ICE <InfoTip text="Identifiant Commun de l'Entreprise, obligatoire sur les factures marocaines." /></dt>
                      <dd>{company.ice || "Non renseigné"}</dd>
                    </div>
                    <div>
                      <dt>Identifiant fiscal</dt>
                      <dd>{company.taxId || "Non renseigné"}</dd>
                    </div>
                    <div><dt>Écritures</dt><dd>{company._count?.entries ?? 0}</dd></div>
                    <div><dt>Documents</dt><dd>{company._count?.documents ?? 0}</dd></div>
                    <div><dt>Salariés</dt><dd>{company._count?.employees ?? 0}</dd></div>
                  </dl>

                  {(company.fiscalYears ?? []).length > 0 && (
                    <>
                      <hr className="wt-divider" />
                      <span className="wt-eyebrow">Exercices comptables</span>
                      <ul className="wt-list">
                        {(company.fiscalYears ?? []).map((year: any) => (
                          <li className="wt-list__item" key={year.id} style={{ paddingInline: 0 }}>
                            <span className="wt-list__item-text">
                              <strong>{year.label}</strong>
                              <span>{year.status === "CLOSED" ? "Clôture : plus aucune écriture ne peut y être ajoutée" : year.lockedTo ? `Verrouillé jusqu'au ${date(year.lockedTo)}` : "Ouvert, aucune période verrouillée"}</span>
                            </span>
                            <Badge tone={year.status === "CLOSED" ? "neutral" : "success"} dot>
                              {year.status === "CLOSED" ? "Clôture" : "Ouvert"}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function EntriesPage({ data, entries, openEntryModal, importEntries, notify, refresh, language, openContextMenu, copyToClipboard, requestReview, setPage }: any) {
  const copy = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const currentCompany = (data?.companies ?? []).find((company: any) => company.id === data?.activeCompanyId) ?? data?.companies?.[0];
  const currentFiscalYear = (currentCompany?.fiscalYears ?? []).find((year: any) => year.status === "OPEN") ?? currentCompany?.fiscalYears?.[0];
  const [lockDate, setLockDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [statusFilter, setStatusFilter] = useState("all");
  const [journalFilter, setJournalFilter] = useState("all");
  const [lockConfirm, setLockConfirm] = useState(false);
  const lockedTo = currentFiscalYear?.lockedTo;
  const duplicate = async (id: string) => {
    if (!window.wheat) return notify("Duplication disponible dans l'application desktop Electron", "warning");
    try {
      await window.wheat.duplicateEntry(id);
      notify("Écriture dupliquée en brouillon", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Duplication impossible", "warning");
    }
  };

  const post = async (id: string) => {
    const postEntry = (window.wheat as any)?.postEntry;
    if (!postEntry) return notify("Comptabilisation disponible dans l'application desktop Wheat", "warning");
    // Comptabiliser is level 3: the shared review runs before the domain
    // service, which re-validates everything again inside its transaction.
    if (requestReview && !(await requestReview("entry.post", { entryId: id })).approved) return;
    try {
      await postEntry(id);
      notify("Écriture comptabilisée. Elle est maintenant protégée.", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Comptabilisation impossible", "warning");
    }
  };

  const reverse = async (id: string) => {
    if (!window.wheat) return notify("Extourne disponible dans l'application desktop Electron", "warning");
    if (requestReview && !(await requestReview("entry.reverse", { entryId: id })).approved) return;
    try {
      await window.wheat.reverseEntry(id);
      notify("Écriture extournée", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Extourne impossible", "warning");
    }
  };

  // "Relire avec Wheat" runs the same pipeline as a save would, and stops
  // there: the dialog is the whole point, nothing is written afterwards.
  const runEntryReview = async (entry: any) => {
    if (!requestReview) return notify("La relecture est disponible dans l'application desktop Wheat", "warning");
    const outcome = await requestReview("entry.post", { entryId: entry.id }, { always: true });
    if (!outcome.review) notify("Relecture indisponible pour cette écriture.", "warning");
  };

  const copyEntryNumber = async (entry: any) => {
    try {
      await navigator.clipboard.writeText(entry.number ?? entry.pieceNumber ?? "");
      notify("Numéro copie", "success");
    } catch {
      notify("Copie impossible", "warning");
    }
  };

  const deleteEntry = async (entry: any) => {
    if (!isDraftEntry(entry)) {
      notify("Une écriture comptabilisée ne se supprime pas. Utilisez l'extourne pour conserver la piste d'audit.", "warning");
      return;
    }
    if (!window.wheat?.deleteEntry) return notify("Suppression disponible dans l'application desktop Electron", "warning");
    if (requestReview && !(await requestReview("entry.delete_draft", { entryId: entry.id })).approved) return;
    if (!confirmWithAppFocus(`Supprimer l'écriture ${entry.number ?? entry.pieceNumber} ?`)) return;

    try {
      await window.wheat.deleteEntry(entry.id);
      notify("Écriture supprimée", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression écriture impossible", "warning");
    }
  };

  const updateFiscalLock = async () => {
    if (!currentCompany || !currentFiscalYear) return notify("Aucun exercice ouvert", "warning");
    const bridge = window.wheat as any;
    try {
      if (lockedTo) {
        if (!bridge?.unlockFiscalPeriod) return notify("Déverrouillage disponible dans l'application desktop Wheat", "warning");
        await bridge.unlockFiscalPeriod({ companyId: currentCompany.id, fiscalYearId: currentFiscalYear.id });
        notify("Période comptable déverrouillée", "success");
      } else {
        if (!bridge?.lockFiscalPeriod) return notify("Verrouillage disponible dans l'application desktop Wheat", "warning");
        await bridge.lockFiscalPeriod({
          companyId: currentCompany.id,
          fiscalYearId: currentFiscalYear.id,
          lockedTo: lockDate,
          throughDate: lockDate,
        });
        notify(`Période verrouillée jusqu'au ${date(lockDate)}`, "success");
      }
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Mise à jour du verrou impossible", "warning");
    }
  };

  const journals = (currentCompany?.journals ?? []) as any[];
  const journalOptions: WheatSelectOption[] = [
    { value: "all", label: "Tous les journaux", note: "Aucune restriction" },
    ...journals.map((journal: any) => ({
      value: journal.code,
      label: `${journal.code} — ${journal.label ?? journal.name ?? ""}`.trim(),
      note: journal.kind ? `Type ${journal.kind}` : undefined,
      keywords: journal.label ?? "",
    })),
  ];
  const statusOptions: WheatSelectOption[] = [
    { value: "all", label: "Tous les statuts" },
    { value: "draft", label: "Brouillons", note: "Modifiables, sans effet comptable" },
    { value: "posted", label: "Comptabilisées", note: "Definitives, incluses dans les états" },
  ];

  const visibleEntries = (entries ?? []).filter((entry: any) => {
    if (statusFilter === "draft" && !isDraftEntry(entry)) return false;
    if (statusFilter === "posted" && !isPostedEntry(entry)) return false;
    if (journalFilter !== "all" && entry.journal?.code !== journalFilter) return false;
    return true;
  });

  const draftCount = (entries ?? []).filter((entry: any) => isDraftEntry(entry)).length;
  const accounts = (currentCompany?.accounts ?? []) as any[];

  return (
    <>
      <PageHeader
        icon={<BookOpen size={22} aria-hidden="true" />}
        title={copy.entriesTitle}
        purpose={pagePurpose.entries}
        meta={
          <>
            <span><ListChecks size={13} aria-hidden="true" /> {(entries ?? []).length} écriture(s)</span>
            <span><Pencil size={13} aria-hidden="true" /> {draftCount} brouillon(s) à contrôler</span>
            <span><Lock size={13} aria-hidden="true" /> {lockedTo ? `Verrouillé au ${date(lockedTo)}` : "Aucune période verrouillée"}</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<Plus size={15} />} onClick={openEntryModal}>Nouvelle écriture</Button>
            <Button variant="secondary" icon={<Upload size={15} />} onClick={importEntries}>{copy.importExcelCsv}</Button>
          </>
        }
        guide={[
          { icon: <Plus size={16} />, title: "Saisir", text: "Créez un brouillon équilibré : total débit = total crédit." },
          { icon: <BadgeCheck size={16} />, title: "Comptabiliser", text: "Rend l'écriture définitive et l'inclut dans tous les états." },
          { icon: <RotateCcw size={16} />, title: "Extourner", text: "Corrige une écriture définitive en créant son inverse, sans effacer l'historique." },
          { icon: <Lock size={16} />, title: "Verrouiller", text: "Empêche toute saisie avant une date, après une déclaration par exemple." },
        ]}
        help={{
          summary: "Débit, crédit, brouillon : le minimum à savoir",
          content: (
            <>
              <p>Une <strong>écriture</strong> enregistre une opération dans un <strong>journal</strong> (ventes, achats, banque, opérations diverses). Elle contient au moins deux lignes et doit toujours être équilibrée : le total au <strong>débit</strong> égale le total au <strong>crédit</strong>.</p>
              <p>Une nouvelle saisie est un <strong>brouillon</strong> : elle n'apparaît dans aucun état et reste librement modifiable. La <strong>comptabilisation</strong> la rend définitive et lui attribue un numéro.</p>
              <p>On ne supprime jamais une écriture comptabilisée : on l'<strong>extourne</strong>, c'est-à-dire qu'on crée l'écriture inverse. La piste d'audit reste ainsi complète.</p>
            </>
          ),
        }}
      />

      <Callout tone="info" title="Cycle sécurisé">
        Chaque nouvelle saisie reste en brouillon jusqu'à votre validation. Après comptabilisation, la correction passe par une extourne tracée : rien n'est modifié en silence.
      </Callout>

      <Card
        title="Verrouillage de période"
        note="Empêche toute saisie ou modification avant une date donnée — à utiliser après avoir déposé une déclaration."
        icon={<Lock size={18} aria-hidden="true" />}
      >
        {!currentFiscalYear ? (
          <Callout tone="warning">Aucun exercice comptable n'est defini pour ce dossier. Creez-en un dans Contrôles &amp; imports &gt; Référentiels.</Callout>
        ) : lockedTo ? (
          <div className="wt-row wt-row--between">
            <span>
              La période est verrouillée jusqu'au <strong>{date(lockedTo)}</strong>. Aucune écriture ne peut être ajoutée ou modifiée avant cette date.
            </span>
            <Button variant="secondary" icon={<Lock size={15} />} onClick={() => setLockConfirm(true)}>Déverrouiller</Button>
          </div>
        ) : (
          <div className="wt-row" style={{ alignItems: "flex-end" }}>
            <Field label="Verrouiller jusqu'au" htmlFor="entries-lock-date" hint="Toutes les dates antérieures ou égales seront figées." className="wt-field--inline">
              <input id="entries-lock-date" type="date" className="wt-input" value={lockDate} onChange={(event) => setLockDate(event.target.value)} />
            </Field>
            <Button variant="secondary" icon={<Lock size={15} />} onClick={() => setLockConfirm(true)}>Verrouiller la période</Button>
          </div>
        )}
      </Card>

      <Card
        title="Journal des écritures"
        note="Filtrez par statut ou par journal. Un clic droit sur une ligne ouvre les mêmes actions que les boutons."
        icon={<BookOpen size={18} aria-hidden="true" />}
        actions={
          <div className="wt-row">
            <WheatSelect
              options={statusOptions}
              value={statusFilter}
              onChange={setStatusFilter}
              ariaLabel="Filtrer par statut"
              className="wt-select--inline"
              size="sm"
            />
            <WheatSelect
              options={journalOptions}
              value={journalFilter}
              onChange={setJournalFilter}
              ariaLabel="Filtrer par journal"
              searchPlaceholder="Rechercher un journal…"
              size="sm"
            />
          </div>
        }
        flush
      >
        {!visibleEntries.length ? (
          <EmptyState
            icon={<BookOpen size={22} aria-hidden="true" />}
            title={(entries ?? []).length ? "Aucune écriture ne correspond aux filtres" : "Aucune écriture dans ce dossier"}
            text={
              (entries ?? []).length
                ? "Élargissez les filtres ci-dessus pour retrouver vos écritures."
                : "Commencez par saisir une écriture, ou importez un journal existant depuis Contrôles & imports."
            }
            actions={
              (entries ?? []).length ? (
                <Button variant="secondary" onClick={() => { setStatusFilter("all"); setJournalFilter("all"); }}>Reinitialiser les filtres</Button>
              ) : (
                <>
                  <Button variant="primary" icon={<Plus size={15} />} onClick={openEntryModal}>Nouvelle écriture</Button>
                  <Button variant="secondary" icon={<Upload size={15} />} onClick={importEntries}>Importer</Button>
                </>
              )
            }
          />
        ) : (
          <EntryTable
            entries={visibleEntries}
            onDuplicate={duplicate}
            onPost={post}
            onReverse={reverse}
            openContextMenu={openContextMenu}
            contextActions={(entry: any) => [
              { label: "Ouvrir dans le grand livre", icon: BookOpen, run: () => setPage?.("books") },
              { label: "Relire avec Wheat", icon: Sparkles, disabled: !isDraftEntry(entry), run: () => runEntryReview(entry) },
              { label: "Dupliquer en brouillon", icon: Copy, run: () => duplicate(entry.id) },
              { label: "Comptabiliser", icon: BadgeCheck, disabled: !isDraftEntry(entry), run: () => post(entry.id) },
              { label: "Extourner", icon: RotateCcw, disabled: !isPostedEntry(entry), run: () => reverse(entry.id) },
              { label: "Filtrer sur ce journal", icon: Filter, run: () => setJournalFilter(entry.journal?.id ?? entry.journalId ?? "all") },
              { label: "Copier le numéro", icon: Copy, run: () => copyEntryNumber(entry) },
              { label: "Copier le libellé", icon: Copy, run: () => copyToClipboard?.(entry.label, "Libellé copié") },
              { label: "Supprimer le brouillon", icon: Trash2, tone: "danger", disabled: !isDraftEntry(entry), run: () => deleteEntry(entry) },
            ]}
          />
        )}
      </Card>

      <Card
        title={copy.chartTitle}
        note="Les comptes les plus utilisés de ce dossier. Le plan complet se consulte dans Comptes & états."
        icon={<Scale size={18} aria-hidden="true" />}
        actions={<Button variant="ghost" size="sm" onClick={() => setPage?.("statements")} trailingIcon={<ArrowRight size={14} />}>Plan comptable complet</Button>}
      >
        {accounts.length ? (
          <div className="wt-grid wt-grid--narrow">
            {accounts.slice(0, 12).map((account: any) => (
              <div className="wt-stat" key={account.id}>
                <span className="wt-stat__label"><span className="wt-code">{account.code}</span></span>
                <span className="wt-stat__value wt-stat__value--sm" style={{ fontSize: "var(--text-base)", fontWeight: 500 }}>{account.label}</span>
                <span className="wt-stat__note">Classe {account.classNo}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Scale size={22} aria-hidden="true" />} title="Plan comptable vide" text="Ce dossier n'a pas encore de comptes. Ils sont normalement créés automatiquement a la création du dossier." />
        )}
      </Card>

      {lockConfirm && (
        <ConfirmDialog
          title={lockedTo ? "Déverrouiller la période ?" : "Verrouiller la période ?"}
          question={
            lockedTo
              ? `La période est actuellement figée jusqu'au ${date(lockedTo)}.`
              : `Toutes les dates jusqu'au ${date(lockDate)} incluses seront figées.`
          }
          consequence={
            lockedTo
              ? "Les écritures anterieures redeviendront modifiables. A n'utiliser que pour corriger une erreur identifiée, avant tout dépôt."
              : "Plus aucune écriture ne pourra être saisie, modifiée ou supprimée sur cette période. L'operation est reversible."
          }
          reversible="Cette operation est journalisee dans la piste d'audit."
          confirmLabel={lockedTo ? "Déverrouiller" : "Verrouiller"}
          tone={lockedTo ? "danger" : "primary"}
          onClose={() => setLockConfirm(false)}
          onConfirm={async () => {
            setLockConfirm(false);
            await updateFiscalLock();
          }}
        />
      )}
    </>
  );
}

function DocumentsPage({ data, currentCompany, notify, refresh, postDocumentEntry, requestReview, language, setPage }: any) {
  const copy = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const documents = data?.documents ?? [];
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    // A record handed over by guided work wins over "the first in the list",
    // and is consumed so a later visit opens normally.
    const handed = window.sessionStorage.getItem(guidedFocusKey);
    if (handed) window.sessionStorage.removeItem(guidedFocusKey);
    return handed ?? documents[0]?.id ?? null;
  });
  const selected = documents.find((doc: any) => doc.id === selectedId) ?? documents[0];
  const selectedExtracted = safeJson(selected?.extracted ?? "{}");
  // Driven by what the pipeline read, not by a list maintained in the renderer.
  const visibleFields = visibleSmartFields(readSmartFields(selectedExtracted), readSmartType(selectedExtracted, selected?.type));
  const [correction, setCorrection] = useState<Record<string, string>>({});
  const [correctedDocumentType, setCorrectedDocumentType] = useState("UNKNOWN");
  const [ocrBusy, setOcrBusy] = useState(false);
  /**
   * Progress of the running batch, pushed by the main process per document.
   *
   * Thirty invoices take minutes whatever the pipeline does with them. Without
   * this the window is simply frozen for the whole of it, which is
   * indistinguishable from a crash.
   */
  const [ocrProgress, setOcrProgress] = useState<{ completed: number; total: number; fileName: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [paddleStatus, setPaddleStatus] = useState<{ available: boolean; version: string | null; reason: string | null } | null>(null);
  const [scanPreview, setScanPreview] = useState<any>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; document: any } | null>(null);

  /**
   * What the extraction said when this document was opened.
   *
   * Kept so that saving can send the fields the person actually changed rather
   * than the whole form. The difference is not cosmetic: the main process
   * stamps every field it receives with confidence 100 and names it in the
   * audit chain as manually corrected, so sending twenty untouched boxes
   * records twenty corrections that never happened and claims certainty about
   * readings nobody looked at.
   */
  const correctionBaseline = useRef<Record<string, string>>({});

  useEffect(() => {
    const seeded = stringifyFields(readSmartFields(selectedExtracted), visibleFields);
    correctionBaseline.current = seeded;
    setCorrection(seeded);
    setCorrectedDocumentType(selected?.type ?? "UNKNOWN");
  }, [selected?.id, selected?.type]);

  /**
   * Corrections survive leaving this screen.
   *
   * An accountant comparing a scan against the boxes beside it will open the
   * suppliers list to check a name, or the chart to check an account, and come
   * back. Until now that lost every correction they had made, because the
   * corrections lived in component state and navigating unmounts the component.
   *
   * The held work also takes precedence over a re-run of the recogniser. A
   * person who fixed a misread total and then re-scanned the page must not find
   * their correction replaced by the same misreading: what they typed is a
   * decision, and what OCR produced is a proposal.
   */
  const correctionDraft = useDraftedForm<{ fields: Record<string, string>; type: string }>({
    companyId: currentCompany?.id,
    entity: "document_extraction",
    draftKey: selected?.id ?? "none",
    open: Boolean(selected?.id),
    value: { fields: correction, type: correctedDocumentType },
    onRestore: (payload) => {
      if (payload?.fields) setCorrection(payload.fields);
      if (payload?.type) setCorrectedDocumentType(payload.type);
      notify("Vos corrections non enregistrées sur cette pièce ont été retrouvées.", "info");
    },
  });

  useEffect(() => {
    let active = true;
    window.wheat?.getPaddleOcrStatus?.().then((status) => {
      if (active) setPaddleStatus(status);
    }).catch(() => {
      if (active) setPaddleStatus({ available: false, version: null, reason: "Moteur PaddleOCR indisponible" });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const openContextMenu = (event: any, doc: any) => {
    event.preventDefault();
    setSelectedId(doc.id);
    setContextMenu({
      x: Math.max(12, Math.min(event.clientX, window.innerWidth - 240)),
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - 190)),
      document: doc,
    });
  };

  /** Re-runs recognition through the same managed pipeline as the import. */
  const rerunDocumentOcr = async (doc: any) => {
    if (!currentCompany || !window.wheat?.smartOcrProcess) return notify("Relance OCR disponible dans l'application desktop Wheat", "warning");
    if (!doc.storedPath) return notify("Le fichier source de cette pièce n'est plus disponible.", "warning");
    if (requestReview && !(await requestReview("document.rerun_ocr", { documentId: doc.id, fields: {} })).approved) return;
    try {
      await window.wheat.smartOcrProcess({ companyId: currentCompany.id, filePaths: [doc.storedPath] });
      // A re-run proposes; a correction decides. Whatever the person had
      // already fixed stays in the form, and they are told so rather than
      // discovering later that a fresh misreading replaced their fix.
      const held = Object.keys(correction).some((key) => correction[key] !== (correctionBaseline.current[key] ?? ""));
      notify(
        held
          ? "Reconnaissance relancée. Vos corrections manuelles ont été conservées : la nouvelle lecture ne les a pas remplacées."
          : "Reconnaissance relancée. Contrôlez les champs lus.",
        "success",
      );
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Relance OCR impossible", "warning");
    }
  };

  const copyDocumentReference = async (doc: any) => {
    const extracted = safeJson(doc.extracted);
    const fields = readSmartFields(extracted);
    const reference = String((fields as any)?.invoiceNumber ?? (fields as any)?.reference ?? "").trim();
    setContextMenu(null);
    if (!reference) return notify("Aucune référence n'a été extraite de cette pièce.", "info");
    try {
      await navigator.clipboard.writeText(reference);
      notify("Référence copiée", "success");
    } catch {
      notify("Copie impossible", "warning");
    }
  };

  const copyDocumentText = async (doc: any) => {
    const extracted = safeJson(doc.extracted);
    const text = String(doc.ocrText || extracted.freeText || "").trim();
    if (!text) {
      notify(copy.noOcrTextToCopy ?? "Aucun texte OCR a copier", "info");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = globalThis.document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      globalThis.document.body.appendChild(textarea);
      textarea.select();
      globalThis.document.execCommand("copy");
      textarea.remove();
    }
    setContextMenu(null);
    notify(copy.copiedOcrText ?? "Texte OCR copie", "success");
  };

  const deleteDocument = async (doc: any) => {
    if (!window.wheat?.deleteDocument) return notify("Suppression disponible dans l'application desktop Electron", "warning");
    const confirmMessage = doc.status === "POSTED"
      ? copy.deleteDocumentPostedConfirm
      : copy.deleteDocumentConfirm;
    if (!confirmWithAppFocus(confirmMessage ?? "Supprimer ce document OCR ?")) return;

    try {
      await window.wheat.deleteDocument(doc.id);
      if (selected?.id === doc.id) {
        setSelectedId(documents.find((item: any) => item.id !== doc.id)?.id ?? null);
      }
      setContextMenu(null);
      notify(copy.deleteDocumentSuccess ?? "Document supprime", "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Suppression document impossible", "warning");
    }
  };

  /**
   * Recognises a whole selection: files, a folder, or a drag-and-drop of both.
   *
   * Import used to refuse anything but a single file, which made the one thing
   * a fiduciaire actually does — hand Wheat a month of invoices — impossible.
   * The main process now expands folders, recognises the batch with its worker
   * pool and reports progress per document, so this only has to keep the person
   * informed and say what was refused.
   */
  useEffect(() => {
    if (!window.wheat?.onSmartOcrProgress) return;
    return window.wheat.onSmartOcrProgress((event: any) => {
      if (!event || event.phase === "BATCH_START") return setOcrProgress(null);
      if (event.phase === "BATCH_DONE") return setOcrProgress(null);
      setOcrProgress({ completed: Number(event.completed ?? 0), total: Number(event.total ?? 0), fileName: String(event.fileName ?? "") });
    });
  }, []);

  const processFiles = async (filePaths?: string[]) => {
    if (!currentCompany) return notify("Créez ou choisissez une société avant l'OCR.", "warning");
    if (!window.wheat) return notify("Smart OCR disponible dans l'application desktop Electron", "warning");
    let targetPaths = filePaths?.filter(Boolean) ?? [];
    if (!targetPaths.length) {
      const selection = await window.wheat.selectDocumentFiles?.();
      if (!selection || !selection.accepted.length) {
        if (selection?.rejections.length) {
          setOcrStatus(selection.rejections[0].reason);
          notify(selection.rejections[0].reason, "warning");
        } else setOcrStatus("");
        return;
      }
      targetPaths = selection.accepted;
    }

    setScanPreview(makeScanPreview(targetPaths[0]));
    setOcrBusy(true);
    setOcrProgress(null);
    setOcrStatus(targetPaths.length > 1 ? `${copy.importingDocument} (${targetPaths.length} pièces)` : copy.importingDocument);
    try {
      const result = await window.wheat.smartOcrProcess({ companyId: currentCompany.id, filePaths: targetPaths });
      const created = result?.documents ?? [];
      const rejections = result?.rejections ?? [];
      if (created.length) {
        setSelectedId(created[0].id);
        setScanPreview(makeScanPreview(created[0].storedPath || targetPaths[0], created[0].title));
        const summary = created.length > 1
          ? `${created.length} pièces analysées et classées${rejections.length ? `, ${rejections.length} ignorée(s)` : ""}.`
          : `${copy.importSuccess}: ${created[0].title}`;
        setOcrStatus(summary);
        notify(summary, rejections.length ? "info" : "success");
        refresh();
      } else if (filePaths?.length) {
        setOcrStatus(copy.importUnsupported);
        notify(copy.importUnsupported, "warning");
      } else {
        setOcrStatus(copy.importEmpty);
        notify(copy.importEmpty, "info");
      }
      // Refusals are named rather than silently dropped: "28 retenues, 2
      // ignorées" is only useful if the two can be identified.
      if (rejections.length) notify(rejections.map((item: any) => item.reason).join(" "), "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.importFailed;
      setOcrStatus(`${copy.importFailed}: ${message}`);
      notify(message, "warning");
    } finally {
      setOcrBusy(false);
      setOcrProgress(null);
    }
  };

  /** Recognises every supported document inside a folder the user picks. */
  const processFolder = async () => {
    if (!window.wheat?.selectDocumentFolder) return notify("Import de dossier disponible dans l'application desktop Wheat.", "warning");
    const selection = await window.wheat.selectDocumentFolder();
    if (!selection.accepted.length) {
      const message = selection.rejections[0]?.reason ?? "Ce dossier ne contient aucune pièce exploitable.";
      setOcrStatus(message);
      notify(message, "warning");
      return;
    }
    await processFiles(selection.accepted);
  };

  /**
   * Accepts a document dropped onto the import zone.
   *
   * The path comes from the preload bridge, not from `File.path`: Electron
   * removed that property, so reading it here returned `undefined` for every
   * drop and the whole drag-and-drop import — images included — reported "no
   * path" and did nothing.
   */
  const onDrop = (event: any) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []) as File[];
    if (!files.length) {
      notify("Le glisser-déposer n'a fourni aucun fichier. Utilisez le bouton d'import.", "warning");
      return;
    }
    // Every dropped entry, not merely the first. A folder resolves to a path
    // too, and the main process walks it.
    const paths = files.map((file) => window.wheat?.getDroppedFilePath?.(file) ?? "").filter(Boolean);
    if (!paths.length) {
      notify(`« ${files[0].name} » n'a pas pu être lu depuis le glisser-déposer. Utilisez le bouton d'import.`, "warning");
      return;
    }
    if (paths.length < files.length) {
      notify(`${files.length - paths.length} élément(s) déposés n'ont pas pu être lus ; les autres sont analysés.`, "info");
    }
    processFiles(paths);
  };

  const filtered = documents.filter((doc: any) => {
    const extracted = safeJson(doc.extracted);
    const fields = readSmartFields(extracted);
    const haystack = `${doc.title} ${doc.type} ${doc.tags} ${doc.ocrText} ${Object.values(fields).join(" ")}`.toLowerCase();
    const matchesQuery = !query.trim() || haystack.includes(query.toLowerCase());
    const matchesType = typeFilter === "ALL" || readSmartType(extracted, doc.type) === typeFilter;
    return matchesQuery && matchesType;
  });

  const stats = buildSmartOcrStats(documents);

  const saveCorrection = async () => {
    if (!selected || !window.wheat) return;
    // Only what changed, decoded back into the units the pipeline stores.
    // `vatRate` in particular is read back as basis points by the draft planner.
    const changed = Object.fromEntries(
      Object.entries(correction)
        .filter(([key, value]) => value !== (correctionBaseline.current[key] ?? ""))
        .map(([key, value]) => [key, smartFieldFromInput(key, value)]),
    );
    if (!Object.keys(changed).length) {
      notify("Aucune correction à enregistrer : les champs sont identiques à la lecture.", "info");
      return;
    }
    if (requestReview) {
      const approval = await requestReview(
        "document.update_extraction",
        { documentId: selected.id, type: correctedDocumentType, fields: changed },
        {
          // A draft-level autofix only ever rewrites the form the user is
          // looking at; the document itself is untouched until they save.
          onApplyFix: (finding: WheatReviewFinding) => {
            if (!finding.target || !finding.proposedValue) return;
            setCorrection((current) => ({ ...current, [finding.target as string]: finding.proposedValue as string }));
            notify(`Champ « ${finding.target} » mis à jour dans le formulaire. Rien n'est enregistré tant que vous n'avez pas validé.`, "info");
          },
        },
      );
      if (!approval.approved) return;
    }
    try {
      await window.wheat.updateDocumentExtraction({
        documentId: selected.id,
        type: correctedDocumentType,
        fields: changed,
      });
      correctionBaseline.current = { ...correction };
      // Confirmed by the service: the unfinished copy is no longer needed. A
      // failure never reaches this line, so the work stays where it was.
      await correctionDraft.clear();
      notify(`${Object.keys(changed).length} correction(s) enregistrée(s)`, "success");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Correction OCR impossible", "warning");
    }
  };

  const exportSmartExcel = async () => {
    const workbook = await buildSmartOcrWorkbook(documents, currentCompany?.name ?? "Wheat");
    const buffer = await workbook.xlsx.writeBuffer();
    const bytesBase64 = base64FromArrayBuffer(buffer as ArrayBuffer);
    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName: `smart-ocr-${currentCompany?.name ?? "wheat"}.xlsx`,
        bytesBase64,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (target) notify(`Export Smart OCR créé: ${target}`, "success");
    } else {
      notify("Export Smart OCR préparé dans la prévisualisation navigateur", "success");
    }
  };

  const exportSmartCsv = async () => {
    const rows = buildSmartOcrRows(documents, currentCompany?.name ?? "Wheat");
    const bytesBase64 = base64FromText(rowsToCsv(rows));
    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName: `smart-ocr-${currentCompany?.name ?? "wheat"}.csv`,
        bytesBase64,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (target) notify(`Export CSV créé: ${target}`, "success");
    }
  };

  const exportSmartJson = async () => {
    const payload = documents.map((doc: any) => ({ ...doc, extracted: safeJson(doc.extracted) }));
    const bytesBase64 = base64FromText(JSON.stringify(payload, null, 2));
    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName: `smart-ocr-${currentCompany?.name ?? "wheat"}.json`,
        bytesBase64,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (target) notify(`Export JSON créé: ${target}`, "success");
    }
  };

  const exportSmartPdf = async () => {
    const rows = buildSmartOcrRows(documents, currentCompany?.name ?? "Wheat");
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text(`${copy.documentsTitle} - ${currentCompany?.name ?? "Wheat"}`, 14, 16);
    autoTable(doc, {
      startY: 24,
      head: [["Document", "Type", "Date", "Tiers", "HT", "TVA", "TTC", "Confiance", "Statut"]],
      body: rows.map((row) => [row.Title, row.Type, row.Date, row.Counterparty, row.HT, row.TVA, row.TTC, `${row.Confidence}%`, row.Status]),
      styles: { fontSize: 8 },
    });
    const bytesBase64 = doc.output("datauristring").split(",")[1];
    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName: `smart-ocr-summary-${currentCompany?.name ?? "wheat"}.pdf`,
        bytesBase64,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (target) notify(`PDF Smart OCR créé: ${target}`, "success");
    }
  };

  const typeOptions: WheatSelectOption[] = [
    { value: "ALL", label: "Tous les types de document" },
    ...smartTypeOptions.map((item) => ({ value: item.value, label: item.label })),
  ];
  const documentTypeOptions: WheatSelectOption[] = [
    { value: "INVOICE", label: "Facture", note: "Facture de vente ou d'achat" },
    { value: "CREDIT_NOTE", label: "Avoir", note: "Note de crédit fournisseur ou client" },
    { value: "BANK_STATEMENT", label: "Relevé bancaire", note: "Extrait de compte" },
    { value: "RECEIPT", label: "Recu", note: "Ticket ou justificatif de caisse" },
    { value: "FILING_RECEIPT", label: "Accuse de dépôt fiscal", note: "Preuve de teledeclaration" },
    { value: "TAX", label: "Autre document fiscal" },
    { value: "CONTRACT", label: "Contrat" },
    { value: "PAYROLL", label: "Document de paie" },
    { value: "IDENTITY", label: "Pièce d'identité" },
    { value: "LETTER", label: "Courrier" },
    { value: "TABLE", label: "Tableau" },
    { value: "UNKNOWN", label: "Type non determine" },
  ];
  const uncertainFields: string[] = selectedExtracted.uncertainFields ?? [];
  /* Failed arithmetic checks, explained rather than left in the advanced panel. */
  const documentCheckIssues = useMemo(
    () => ocrCheckIssues(selectedExtracted.accountingChecks),
    [selectedExtracted.accountingChecks],
  );

  return (
    <>
      <PageHeader
        icon={<FileSearch size={22} aria-hidden="true" />}
        title="Documents & OCR"
        purpose={pagePurpose.documents}
        meta={
          <>
            <span><FileText size={13} aria-hidden="true" /> {documents.length} document(s)</span>
            <span><CheckCircle2 size={13} aria-hidden="true" /> {stats.averageConfidence}% de confiance moyenne</span>
            {paddleStatus && (
              <span title={paddleStatus.reason ?? "Reconnaissance de texte exécutée sur cet ordinateur"}>
                <ShieldCheck size={13} aria-hidden="true" />
                {paddleStatus.available ? `Moteur PaddleOCR ${paddleStatus.version ?? ""} (local)` : "Moteur Tesseract local (repli)"}
              </span>
            )}
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<FileUp size={15} />} busy={ocrBusy} onClick={() => processFiles()}>
              {ocrBusy ? copy.importingDocument : "Importer des pièces"}
            </Button>
            <Button variant="secondary" icon={<FolderOpen size={15} />} disabled={ocrBusy} onClick={() => void processFolder()}>
              Importer un dossier
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet size={15} />} disabled={!documents.length} onClick={exportSmartExcel}>
              Exporter (Excel)
            </Button>
          </>
        }
        guide={[
          { icon: <FileUp size={16} />, title: "Importer", text: "Déposez un lot de PDF, de photos ou de scans, ou un dossier entier : Wheat les traite ensemble." },
          { icon: <Search size={16} />, title: "Lire (OCR)", text: "Les montants, dates et tiers sont extraits, avec un indice de confiance." },
          { icon: <Pencil size={16} />, title: "Corriger", text: "Les champs incertains sont signalés : vous confirmez ou corrigez." },
          { icon: <BadgeCheck size={16} />, title: "Comptabiliser", text: "La pièce devient un brouillon de facture, à contrôler puis valider." },
        ]}
        help={{
          summary: "Qu'est-ce que l'OCR, et pourquoi vérifier ?",
          content: (
            <>
              <p><strong>OCR</strong> signifie « reconnaissance optique de caracteres » : le logiciel lit le texte present sur une image ou un PDF scanne. C'est ce qui évite de retaper une facture à la main.</p>
              <p>La lecture n'est jamais sure a 100 %. Wheat affiche un <strong>indice de confiance</strong> et surligné les champs douteux. En dessous de 80 %, vérifiez systematiquement le montant TTC et la date.</p>
              <p>Rien n'est comptabilisé automatiquement : la pièce devient un <strong>brouillon de facture</strong> que vous relisez avant de la valider.</p>
            </>
          ),
        }}
      />

      <div className="wt-grid wt-grid--narrow">
        <Stat label="Documents importés" value={documents.length} note="Toutes pièces confondues" />
        <Stat label="Confiance moyenne" value={`${stats.averageConfidence}%`} note="Fiabilité de la lecture automatique" tip="Moyenne des indices de confiance OCR. En dessous de 80 %, une vérification manuelle est recommandee." />
        <Stat label="A vérifier" value={stats.needsReview} note="Au moins un champ incertain" />
        <Stat label="Doublons détectés" value={stats.duplicates} note="Pièces au contenu identique" tip="Wheat compare les montants, dates et tiers pour signaler une pièce déjà importée." />
      </div>

      <Card
        title="Importer des pièces"
        note="Un fichier, une sélection ou un dossier entier. Wheat les reconnaît en parallèle et les range par société, année, mois, type et tiers."
        icon={<FileUp size={18} aria-hidden="true" />}
      >
        <button
          type="button"
          className={`upload-zone smart-dropzone${dragging ? " is-dragging" : ""}`}
          onClick={() => processFiles()}
          onDrop={onDrop}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          disabled={ocrBusy}
        >
          <FileUp size={30} aria-hidden="true" />
          <strong>{ocrBusy ? copy.importingDocument : "Glissez vos pièces ici, ou cliquez pour les choisir"}</strong>
          <span>PDF, JPG, PNG, WEBP, TIFF, BMP, CSV, XLSX · plusieurs fichiers ou un dossier</span>
          {scanPreview && <DocumentScanPreview preview={scanPreview} busy={ocrBusy} />}
        </button>
        {/* Progressive feedback: which document, and how far through the batch. */}
        {ocrBusy && ocrProgress && ocrProgress.total > 1 && (
          <p className="ocr-progress" role="status" aria-live="polite">
            <progress value={ocrProgress.completed} max={ocrProgress.total} />
            <span>{ocrProgress.completed} / {ocrProgress.total} — {ocrProgress.fileName}</span>
          </p>
        )}
        {ocrStatus && (
          ocrBusy
            ? <LoadingState label={ocrStatus} />
            : <Callout tone={ocrStatus.startsWith(copy.importFailed) ? "danger" : "success"}>{ocrStatus}</Callout>
        )}
      </Card>

      <div className="wt-filterbar ocr-toolbar" role="group" aria-label="Filtrer et exporter les documents">
        <Field label="Rechercher" htmlFor="documents-search" hint="Cherche dans le texte OCR, l'ICE, le tiers et les montants.">
          <SearchInput value={query} onChange={setQuery} ariaLabel="Rechercher dans les documents" placeholder="Texte OCR, ICE, fournisseur, montant…" />
        </Field>
        <Field label="Type de document" htmlFor="documents-type" hint="Restreint la liste a une catégorie.">
          <WheatSelect id="documents-type" options={typeOptions} value={typeFilter} onChange={setTypeFilter} ariaLabel="Filtrer par type de document" />
        </Field>
        <div className="wt-filterbar__actions">
          <span className="wt-hint">Exporter la liste :</span>
          <Button variant="secondary" size="sm" disabled={!documents.length} onClick={exportSmartExcel}>Excel</Button>
          <Button variant="secondary" size="sm" disabled={!documents.length} onClick={exportSmartCsv}>CSV</Button>
          <Button variant="secondary" size="sm" disabled={!documents.length} onClick={exportSmartJson}>JSON</Button>
          <Button variant="secondary" size="sm" disabled={!documents.length} onClick={exportSmartPdf}>PDF</Button>
        </div>
      </div>

      <div className="wt-split wt-split--aside-first ocr-workbench">
        <Card
          title={copy.analyzedDocuments}
          note="Cliquez sur une pièce pour ouvrir sa fiche de contrôle à droite."
          icon={<FileText size={18} aria-hidden="true" />}
          actions={<Badge tone="neutral">{filtered.length} résultat(s)</Badge>}
          flush
        >
          {!filtered.length ? (
            <EmptyState
              icon={<FileSearch size={22} aria-hidden="true" />}
              title={documents.length ? "Aucune pièce ne correspond" : copy.noOcrTitle}
              text={documents.length ? "Modifiez la recherche ou le filtre de type pour retrouver vos pièces." : copy.noOcrText}
              actions={
                documents.length ? (
                  <Button variant="secondary" onClick={() => { setQuery(""); setTypeFilter("ALL"); }}>Effacer les filtres</Button>
                ) : (
                  <Button variant="primary" icon={<FileUp size={15} />} onClick={() => processFiles()}>Importer une pièce</Button>
                )
              }
            />
          ) : (
            <ul className="wt-list">
              {filtered.map((document: any) => {
                const extracted = safeJson(document.extracted);
                const fields = readSmartFields(extracted);
                const confidence = readSmartConfidence(extracted);
                const type = readSmartType(extracted, document.type);
                const uncertain = extracted.uncertainFields ?? [];
                const duplicateIds = extracted.duplicateIds ?? [];
                const status = smartOcrStatusMeta(document.status, uncertain, copy);
                return (
                  <li key={document.id} className={selected?.id === document.id ? "wt-list__item is-selected" : "wt-list__item"} style={{ padding: 0 }}>
                    <button
                      type="button"
                      className={selected?.id === document.id ? "wt-nav-item is-active" : "wt-nav-item"}
                      style={{ padding: "var(--space-5) var(--space-6)", borderRadius: 0 }}
                      onClick={() => setSelectedId(document.id)}
                      onContextMenu={(event) => openContextMenu(event, document)}
                      aria-pressed={selected?.id === document.id}
                    >
                      <FileText size={17} aria-hidden="true" />
                      <span className="wt-list__item-text">
                        <strong>{document.title}</strong>
                        <span>{smartTypeLabel(type, document.type)} · {fields.counterparty || fields.supplier || "Tiers à confirmer"}</span>
                        <span>{fields.date || "Date à vérifier"} · {fields.ttc ? money(Number(fields.ttc), fields.currency || "MAD") : "Montant à vérifier"}</span>
                      </span>
                      <span className="wt-row" style={{ gap: "var(--space-2)", flexWrap: "nowrap" }}>
                        {duplicateIds.length > 0 && <Badge tone="warning">Doublon</Badge>}
                        {uncertain.length > 0 && <Badge tone="warning">A vérifier</Badge>}
                        <Badge tone={statusBadgeTone(status.tone)}>{status.label}</Badge>
                        <span className="wt-hint wt-num">{confidence}%</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title={copy.smartReview}
          note="Vérifiez les champs lus, corrigez si nécessaire, puis créez le brouillon de facture."
          icon={<BadgeCheck size={18} aria-hidden="true" />}
          actions={selected ? <Badge tone="info">{statusLabel(selected.status)}</Badge> : undefined}
        >
          {!selected ? (
            <EmptyState
              icon={<FileSearch size={22} aria-hidden="true" />}
              title="Aucune pièce sélectionnée"
              text="Choisissez un document dans la liste, ou importez-en un, pour afficher les champs extraits."
              actions={<Button variant="primary" icon={<FileUp size={15} />} onClick={() => processFiles()}>Importer une pièce</Button>}
            />
          ) : (
            <>
              <div className="wt-row wt-row--between">
                <span className="wt-list__item-text">
                  <strong style={{ fontSize: "var(--text-lg)" }}>{selected.title}</strong>
                  <span>{selected.type} · exercice {selected.fiscalYear} · {selected.tags || "aucune étiquette"}</span>
                </span>
                <Stat label="Confiance de lecture" value={`${readSmartConfidence(selectedExtracted)}%`} tip="Certitude de la reconnaissance automatique pour cette pièce." />
              </div>

              {uncertainFields.length > 0 && (
                <Callout tone="warning" title={`${uncertainFields.length} champ(s) à confirmer`}>
                  Les champs surlignés n'ont pas été lus avec certitude. Comparez-les avec le document original avant de comptabiliser.
                </Callout>
              )}

              {/*
                * A document whose own arithmetic does not hold.
                *
                * The pipeline has always scored the reading against the rules
                * an invoice must satisfy, and the verdicts were only visible
                * inside the collapsed "Diagnostic d'extraction (avancé)" panel
                * — so the person correcting the fields never learnt that the
                * totals did not add up. They are checked findings, so they are
                * rendered the way every other checked finding is, with the
                * explanation affordance that comes with it.
                */}
              {documentCheckIssues.length > 0 && (
                <div className="wt-stack" data-testid="ocr-check-issues">
                  <p className="wt-hint">
                    {documentCheckIssues.length} contrôle(s) comptable(s) de cette pièce ne passent pas. Ils n'empêchent pas
                    la correction : ils indiquent où la lecture et le document ne concordent pas.
                  </p>
                  <IssueList issues={documentCheckIssues} />
                </div>
              )}

              <p className="wt-hint">
                Fichier classe dans : <span className="wt-code">{selectedExtracted.organizedPath ?? selected.storedPath}</span>
              </p>

              {/* The page on the left, the values Wheat took from it on the
                  right. The correction form is unchanged: what changed is that
                  the thing being corrected against is now on the same screen. */}
              <div className="ocr-review-split">
                <DocumentSourceViewer documentId={selected.id} companyId={currentCompany?.id} title={selected.title} />
                <div className="ocr-review-split__fields">
                  <div className="wt-form-grid">
                <Field label="Type de document" htmlFor="documents-corrected-type" hint="Determine le traitement comptable propose." className="wt-span-all">
                  <WheatSelect
                    id="documents-corrected-type"
                    options={documentTypeOptions}
                    value={correctedDocumentType}
                    onChange={setCorrectedDocumentType}
                    ariaLabel="Type de document"
                  />
                </Field>
                {visibleFields.map((key) => (
                  <Field
                    key={key}
                    label={smartFieldLabels[key] ?? key}
                    htmlFor={`documents-field-${key}`}
                    hint={uncertainFields.includes(key) ? "Champ lu avec une faible certitude — à confirmer." : undefined}
                  >
                    <input
                      id={`documents-field-${key}`}
                      className="wt-input"
                      value={correction[key] ?? ""}
                      aria-invalid={uncertainFields.includes(key) || undefined}
                      onChange={(event) => setCorrection({ ...correction, [key]: event.target.value })}
                    />
                  </Field>
                ))}
                  </div>
                </div>
              </div>

              <HelpDisclosure summary={copy.detectedTables}>
                <MiniTable rows={selectedExtracted.tableRows ?? []} />
              </HelpDisclosure>

              <HelpDisclosure summary={copy.ocrText}>
                <pre tabIndex={0} aria-label="Texte OCR extrait" className="wt-code" style={{ display: "block", whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", padding: "var(--space-5)" }}>
                  {selected.ocrText || selectedExtracted.freeText || "Aucun texte exploitable n'a été extrait de cette pièce."}
                </pre>
              </HelpDisclosure>

              <OcrDiagnostics extracted={selectedExtracted} />

              <div className="wt-row">
                <Button variant="secondary" icon={<Eye size={15} />} disabled={!selected.storedPath} onClick={() => selected.storedPath && window.wheat?.openPath(selected.storedPath)}>
                  {copy.openFile}
                </Button>
                <Button variant="secondary" icon={<Save size={15} />} onClick={saveCorrection}>
                  {copy.saveCorrections}
                </Button>
                <span className="wt-spacer" />
                <Button variant="primary" icon={<BadgeCheck size={15} />} disabled={Boolean(selected.invoiceId)} onClick={() => postDocumentEntry(selected.id)}>
                  {selected.invoiceId ? (selected.status === "POSTED" ? "Facture comptabilisée" : "Brouillon déjà créé") : "Créer le brouillon de facture"}
                </Button>
              </div>
              {selected.invoiceId && (
                <Callout tone="success" title="Cette pièce est rattachée a une facture">
                  Ouvrez « Factures & paiements » pour la contrôler puis la comptabiliser.
                  <div className="wt-callout__actions">
                    <Button variant="secondary" size="sm" onClick={() => setPage?.("billing")}>Ouvrir la facture</Button>
                  </div>
                </Callout>
              )}
            </>
          )}
        </Card>
      </div>

      <AnimatePresence>
        {contextMenu && (
          <DocumentContextMenuSurface anchor={contextMenu}>
            <span className="wt-context-menu__title">{contextMenu.document.title}</span>
            <button
              type="button"
              role="menuitem"
              className="wt-context-menu__item"
              onClick={() => {
                if (contextMenu.document.storedPath) window.wheat?.openPath(contextMenu.document.storedPath);
                setContextMenu(null);
              }}
              disabled={!contextMenu.document.storedPath}
            >
              <FileText size={15} aria-hidden="true" /> {copy.contextOpenFile ?? "Ouvrir le fichier"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="wt-context-menu__item"
              onClick={() => { setSelectedId(contextMenu.document.id); setContextMenu(null); }}
            >
              <FileSearch size={15} aria-hidden="true" /> Vérifier l'extraction
            </button>
            <button
              type="button"
              role="menuitem"
              className="wt-context-menu__item"
              onClick={() => { setContextMenu(null); void rerunDocumentOcr(contextMenu.document); }}
              disabled={Boolean(contextMenu.document.invoiceId) || !contextMenu.document.storedPath}
            >
              <RefreshCw size={15} aria-hidden="true" /> Relancer la reconnaissance
            </button>
            <button
              type="button"
              role="menuitem"
              className="wt-context-menu__item"
              onClick={() => { setContextMenu(null); setPage?.("billing"); }}
              disabled={!contextMenu.document.invoiceId}
            >
              <Banknote size={15} aria-hidden="true" /> Ouvrir la facture liée
            </button>
            <button type="button" role="menuitem" className="wt-context-menu__item" onClick={() => copyDocumentReference(contextMenu.document)}>
              <Copy size={15} aria-hidden="true" /> Copier la référence extraite
            </button>
            <button type="button" role="menuitem" className="wt-context-menu__item" onClick={() => copyDocumentText(contextMenu.document)}>
              <Copy size={15} aria-hidden="true" /> {copy.contextCopyOcr ?? "Copier le texte OCR"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="wt-context-menu__item"
              onClick={() => {
                setContextMenu(null);
                postDocumentEntry(contextMenu.document.id);
              }}
              disabled={Boolean(contextMenu.document.invoiceId)}
            >
              <BadgeCheck size={15} aria-hidden="true" /> {contextMenu.document.invoiceId ? "Facture déjà créée" : (copy.contextPostEntry ?? "Créer le brouillon de facture")}
            </button>
            <button type="button" role="menuitem" className="wt-context-menu__item is-danger" onClick={() => deleteDocument(contextMenu.document)}>
              <Trash2 size={15} aria-hidden="true" /> {copy.contextDeleteDocument ?? "Supprimer le document"}
            </button>
          </DocumentContextMenuSurface>
        )}
      </AnimatePresence>
    </>
  );
}

/** Document right-click menu body, clamped inside the window before paint. */
function DocumentContextMenuSurface({ anchor, children }: { anchor: { x: number; y: number }; children: ReactNode }) {
  const [ref, placement] = useViewportAnchor<HTMLDivElement>({ x: anchor.x, y: anchor.y });
  return (
    <motion.div
      ref={ref}
      className="wt-context-menu context-menu"
      style={{ left: placement.left, top: placement.top, maxHeight: placement.maxHeight || undefined, overflowY: "auto" }}
      initial={{ opacity: 0, scale: 0.98, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: -4 }}
      transition={{ duration: 0.12 }}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      {children}
    </motion.div>
  );
}

function PayrollPage({ data, exportRows, exportPdf, postPayrollEntry, language, openContextMenu, copyToClipboard, deleteEmployee, editEmployee, setPage }: any) {
  const copy = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const employees = data?.employees ?? [];
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const periodLabel = period
    ? new Intl.DateTimeFormat(language === "ar" ? "ar-MA" : language === "en" ? "en-GB" : "fr-MA", { month: "long", year: "numeric" })
      .format(new Date(`${period}-01T12:00:00`))
    : "";
  const rowFromEmployee = (employee: any) => ({
    Employé: employee.fullName,
    CIN: employee.cin,
    CNSS: employee.cnss,
    Poste: employee.position,
    Brut: employee.grossSalary,
    "CNSS salarié": employee.cnssEmployee,
    AMO: employee.amoEmployee,
    IR: employee.ir,
    Net: employee.netSalary,
  });
  const rows = employees.map(rowFromEmployee);

  const columns = Object.keys(rows[0] ?? {});
  const totalGross = employees.reduce((sum: number, employee: any) => sum + Number(employee.grossSalary || 0), 0);
  const totalNet = employees.reduce((sum: number, employee: any) => sum + Number(employee.netSalary || 0), 0);
  const totalContributions = employees.reduce(
    (sum: number, employee: any) => sum + Number(employee.cnssEmployee || 0) + Number(employee.amoEmployee || 0) + Number(employee.ir || 0),
    0,
  );

  return (
    <>
      <PageHeader
        icon={<Users size={22} aria-hidden="true" />}
        title="Paie"
        purpose={pagePurpose.payroll}
        meta={
          <>
            <span><Users size={13} aria-hidden="true" /> {employees.length} salarié(s)</span>
            <span><Calendar size={13} aria-hidden="true" /> Période {periodLabel || "non choisie"}</span>
          </>
        }
        actions={
          <>
            <Button variant="secondary" icon={<Plus size={15} />} onClick={() => editEmployee()}>Ajouter un salarié</Button>
            <Button
              variant="primary"
              icon={<CheckCircle2 size={15} />}
              disabled={!period || employees.length === 0}
              onClick={() => postPayrollEntry(period)}
            >
              {copy.generatePayrollEntry}
            </Button>
          </>
        }
        guide={[
          { icon: <Users size={16} />, title: "Salariés", text: "Fiche de chaque salarié : CIN, CNSS, poste et éléments de rémunération." },
          { icon: <Calendar size={16} />, title: "Période", text: "Le mois traite. Chaque mois donne lieu a une écriture de paie distincte." },
          { icon: <FileSpreadsheet size={16} />, title: "Exports", text: "Livre de paie en Excel et bulletins recapitulatifs en PDF." },
          { icon: <CheckCircle2 size={16} />, title: "Écriture de paie", text: "Genere le brouillon comptable : charges, retenues et net à payer." },
        ]}
        help={{
          summary: "Brut, net, CNSS, AMO, IR : que veulent dire ces colonnes ?",
          content: (
            <>
              <p>Le <strong>brut</strong> est la rémunération avant toute retenue. Le <strong>net</strong> est ce que le salarié percoit réellement.</p>
              <p>Entre les deux : la <strong>CNSS</strong> (sécurité sociale), l'<strong>AMO</strong> (assurance maladie obligatoire) et l'<strong>IR</strong> (impot sur le revenu retenu a la source). Ces montants sont retenus sur le salaire et reverses par l'employeur.</p>
              <p>« Générer l'écriture de paie » créé un <strong>brouillon</strong> comptable : il reste à contrôler puis a comptabiliser depuis l'écran Écritures.</p>
            </>
          ),
        }}
      />

      <div className="wt-grid wt-grid--narrow">
        <Stat label="Salariés" value={employees.length} note="Enregistrès dans ce dossier" />
        <Stat label="Masse salariale brute" value={money(totalGross)} note="Avant retenues" tip="Total des salaires bruts du mois, avant CNSS, AMO et IR." />
        <Stat label="Retenues salariales" value={money(totalContributions)} note="CNSS + AMO + IR" tip="Part retenue sur les salaires et reversée aux organismes." />
        <Stat label="Net à payer" value={money(totalNet)} note="Montant verse aux salariés" />
      </div>

      <Card
        title="Période de paie et exports"
        note="Choisissez le mois traite, puis exportez le livre de paie ou generez l'écriture comptable."
        icon={<Calendar size={18} aria-hidden="true" />}
      >
        <div className="wt-row" style={{ alignItems: "flex-end" }}>
          <Field label="Mois de paie" htmlFor="payroll-period" hint="Chaque mois donne lieu a une écriture comptable distincte.">
            <input id="payroll-period" type="month" className="wt-input" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </Field>
          <Button
            variant="secondary"
            icon={<FileSpreadsheet size={15} />}
            disabled={!employees.length}
            onClick={() => exportRows(rows, `paie-${period}.xlsx`, "Paie")}
          >
            {copy.exportPayroll}
          </Button>
          <Button
            variant="secondary"
            icon={<FileText size={15} />}
            disabled={!employees.length}
            onClick={() => exportPdf(`Paie ${periodLabel}`, columns, rows.map((row: any) => Object.values(row)), `paie-${period}.pdf`)}
          >
            {copy.payslipsPdf}
          </Button>
        </div>
      </Card>

      <Card
        title="Salariés"
        note="Un clic droit sur une ligne ouvre les mêmes actions que les boutons de la colonne Actions."
        icon={<Users size={18} aria-hidden="true" />}
        actions={<Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => editEmployee()}>Ajouter</Button>}
        flush
      >
        {!employees.length ? (
          <EmptyState
            icon={<Users size={22} aria-hidden="true" />}
            title="Aucun salarié enregistre"
            text="Ajoutez vos salariés avec leur salaire brut et leurs retenues. Wheat calculé ensuite le net et prépare l'écriture de paie mensuelle."
            actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => editEmployee()}>Ajouter un salarié</Button>}
          />
        ) : (
          <TableWrap label="Tableau des salariés">
            <table className="wt-table">
              <thead>
                <tr>
                  {columns.map((key) => (
                    <th key={key} scope="col" className={typeof (rows[0] as any)?.[key] === "number" ? "is-numeric" : undefined}>
                      {key}
                    </th>
                  ))}
                  <th scope="col" className="is-numeric">Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((employee: any) => {
                  const row = rowFromEmployee(employee);
                  return (
                    <tr
                      key={employee.id}
                      onContextMenu={(event) =>
                        openContextMenu?.(event, [
                          { label: "Modifier la fiche", icon: Pencil, run: () => editEmployee(employee) },
                          { label: "Comptabiliser la paie du mois", icon: BadgeCheck, run: () => postPayrollEntry(new Date().toISOString().slice(0, 7)) },
                          { label: "Ouvrir l'écriture de paie", icon: BookOpen, run: () => setPage?.("entries") },
                          { label: "Copier le CIN", icon: Copy, disabled: !employee.cin, run: () => copyToClipboard(employee.cin, "CIN copie") },
                          { label: "Copier le numéro CNSS", icon: Copy, disabled: !employee.cnss, run: () => copyToClipboard(employee.cnss, "CNSS copie") },
                          { label: "Supprimer le salarié", icon: Trash2, tone: "danger", run: () => deleteEmployee(employee) },
                        ], employee.fullName)
                      }
                    >
                      {Object.entries(row).map(([key, value]) => (
                        <td key={key} className={typeof value === "number" ? "is-numeric" : undefined}>
                          {typeof value === "number" ? money(value) : String(value ?? "")}
                        </td>
                      ))}
                      <td>
                        <div className="wt-table__actions">
                          <Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={() => editEmployee(employee)}>Modifier</Button>
                          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => deleteEmployee(employee)}>Supprimer</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

function BankStatementImportModal({ companyId, draft, onClose, onImported, onReconcileBatch }: {
  companyId: string | undefined;
  draft: BankImportDraft;
  onClose: () => void;
  onImported: () => void;
  onReconcileBatch: (batch: { bankAccountId: string; statementId: string }) => void;
}) {
  const dialogRef = useAccessibleDialog<HTMLElement>(onClose);
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(
    Object.entries(draft.parsed.suggestedMapping ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])),
  ));
  const [review, setReview] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"review" | "import" | "">("");
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [mappingRestored, setMappingRestored] = useState(false);
  const [report, setReport] = useState<any>(null);
  /*
   * The opening and closing balances the statement itself declares — MT940 and
   * CAMT.053 carry them, CSV, Excel, OFX, QIF and scanned PDFs do not.
   *
   * When the file declares none, the accountant has them anyway: they are
   * printed on the statement in their hand. Typing them buys two things Wheat
   * could not otherwise offer for those formats — the import checks that
   * opening + movements equals closing and refuses a statement with a missed or
   * mistyped line, and the bank total gains a real bank balance to compare the
   * ledger against, which is the whole point of a rapprochement.
   *
   * Left empty, nothing changes: Wheat never invents a balance it was not told.
   */
  const declared = draft.parsed.declaredBalances ?? {};
  const fileDeclaresBalances = declared.openingBalanceCents !== undefined && declared.closingBalanceCents !== undefined;
  const [statedBalances, setStatedBalances] = useState({ opening: "", closing: "" });

  /**
   * Reads a balance as the accountant writes it, sign included: a bank account
   * can be overdrawn, so a leading minus is a real value and not a typo.
   * Returns null for anything that is not a complete amount, so a half-typed
   * figure is treated as "not stated" rather than as zero.
   */
  const balanceToCents = (value: string): string | null => {
    const text = value.trim();
    if (!text) return null;
    const negative = text.startsWith("-");
    const magnitude = tryParseExactDecimalCents(negative ? text.slice(1) : text);
    if (magnitude === null) return null;
    return (negative ? -magnitude : magnitude).toString();
  };

  /**
   * Both balances or neither: the equation the import checks needs the two ends
   * of it, and one alone would let a wrong figure through unchecked.
   */
  const statedBalancesPayload = () => {
    const openingBalanceCents = balanceToCents(statedBalances.opening);
    const closingBalanceCents = balanceToCents(statedBalances.closing);
    return openingBalanceCents !== null && closingBalanceCents !== null ? { openingBalanceCents, closingBalanceCents } : {};
  };

  const statedBalancesIncomplete = Boolean(statedBalances.opening.trim() || statedBalances.closing.trim())
    && Object.keys(statedBalancesPayload()).length === 0;

  /*
   * The column mapping somebody worked out, kept until the statement is
   * actually imported.
   *
   * Mapping an unfamiliar statement is the slowest part of an import: it means
   * reading the file's own headings and deciding which is the value date and
   * whether the amounts are signed or split. Closing the dialog to go and look
   * — or Wheat restarting — threw all of that away and re-proposed the
   * suggestion the person had just corrected.
   *
   * Keyed by the file's content hash within its bank account, so the same
   * statement offered again is recognised, and a mapping worked out for one
   * account or one file can never appear against another.
   *
   * Deliberately not held: `review`, which is the service's answer and is
   * recomputed rather than remembered, and `allowDuplicates`, which is consent
   * to import rows Wheat believes are already there. Consent belongs to the
   * review it was given against; restoring it later would pre-arm a duplicate
   * import nobody re-authorised.
   */
  const mappingDraft = useDraftedForm<{ mapping: Record<string, string> }>({
    companyId,
    entity: "bank.statement.import",
    draftKey: `${draft.bankAccountId}:${draft.sourceSha256}`,
    open: true,
    value: { mapping },
    onRestore: (payload) => {
      if (!payload?.mapping || typeof payload.mapping !== "object") return;
      setMapping(Object.fromEntries(
        Object.entries(payload.mapping).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ));
      // A restored mapping was never checked against the file by the service.
      setReview(null);
      setAllowDuplicates(false);
      setMappingRestored(true);
    },
  });

  const updateMapping = (field: string, value: string) => {
    setMapping((current) => {
      const next = { ...current, [field]: value };
      if (field === "amount" && value) {
        next.debit = "";
        next.credit = "";
      }
      if ((field === "debit" || field === "credit") && value) next.amount = "";
      return next;
    });
    setReview(null);
    setAllowDuplicates(false);
    setMappingRestored(false);
    setError("");
  };

  const reviewImport = async () => {
    if (!window.wheat?.reviewBankStatement) return;
    setBusy("review");
    setError("");
    try {
      const result = await window.wheat.reviewBankStatement({
        bankAccountId: draft.bankAccountId,
        sourceSha256: draft.sourceSha256,
        rows: draft.parsed.rows,
        mapping,
        sourceCurrency: draft.parsed.currency,
      });
      setReview(result);
    } catch (reviewError) {
      setReview(null);
      setError(reviewError instanceof Error ? reviewError.message : "Le mapping n'a pas pu être validé.");
    } finally {
      setBusy("");
    }
  };

  const confirmImport = async () => {
    if (!window.wheat?.importBankStatement || !review?.canImport || (review.duplicateCount > 0 && !allowDuplicates)) return;
    setBusy("import");
    setError("");
    try {
      const result = await window.wheat.importBankStatement({
        companyId,
        bankAccountId: draft.bankAccountId,
        sourceName: draft.file.name,
        sourceSha256: draft.sourceSha256,
        sourceBytesBase64: draft.file.bytesBase64,
        sourceFormat: draft.parsed.format,
        sourceCurrency: draft.parsed.currency,
        rows: draft.parsed.rows,
        mapping,
        // The balances the statement declares about itself, when it declares
        // them. The import service compares them against the movements it read
        // and refuses a statement that does not add up; sending nothing left
        // that check permanently unavailable. A format that declares none falls
        // back to what the accountant read off the paper statement.
        ...(fileDeclaresBalances ? declared : statedBalancesPayload()),
        allowSuspectedDuplicates: Boolean(review.duplicateCount && allowDuplicates),
      });
      setReport({
        format: draft.parsed.formatLabel,
        sourceName: draft.file.name,
        importedCount: result?.movements?.length ?? draft.parsed.rowCount,
        duplicateCount: result?.suspectedDuplicateRows?.length ?? 0,
        statement: result?.statement,
      });
      // The statement is in the books, so the mapping is finished work.
      // Reached only after the import service returned.
      await mappingDraft.clear();
      onImported();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "L'import n'a pas pu être finalisé.");
    } finally {
      setBusy("");
    }
  };

  const mappingFields = [
    ["date", "Date d'opération", true],
    ["valueDate", "Date de valeur", false],
    ["label", "Libellé / description", true],
    ["reference", "Référence", false],
    ["externalId", "Identifiant bancaire", false],
    ["amount", "Montant signé", false],
    ["debit", "Débit", false],
    ["credit", "Crédit", false],
    ["currency", "Devise", false],
  ] as const;
  const previewHeaders = draft.parsed.headers.slice(0, 12);
  const assistedRows = new Set(draft.parsed.ocr?.assistedRows ?? []);

  const headerOptions: WheatSelectOption[] = [
    { value: "", label: "Non mappé", note: "Cette information ne figure pas dans le fichier" },
    ...draft.parsed.headers.map((header) => ({ value: header, label: header, note: "Colonne du fichier" })),
  ];
  const canConfirm = Boolean(review?.canImport) && !(review && review.duplicateCount > 0 && !allowDuplicates);

  return (
    <Dialog
      title={report ? "Import terminé" : "Contrôler le relevé bancaire"}
      note={
        report
          ? "Les mouvements sont enregistrés. Le rapprochement avec vos écritures reste à faire."
          : "Wheat n'écrit rien tant que vous n'avez pas confirmé. Vérifiez la correspondance des colonnes, puis les contrôles."
      }
      icon={<Landmark size={18} aria-hidden="true" />}
      size="xl"
      onClose={onClose}
      footerNote={report ? undefined : "Aucun rapprochement n'est créé automatiquement : vous restez maître de chaque association."}
      footer={
        report ? (
          <Button variant="primary" onClick={onClose}>Terminer</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>Annuler</Button>
            <Button
              variant="secondary"
              icon={<ListChecks size={15} />}
              busy={busy === "review"}
              disabled={Boolean(busy)}
              onClick={() => void reviewImport()}
              data-testid="bank-import-review"
            >
              Vérifier le mapping
            </Button>
            <Button
              variant="primary"
              icon={<Upload size={15} />}
              busy={busy === "import"}
              disabled={Boolean(busy) || !canConfirm}
              onClick={() => void confirmImport()}
              data-testid="bank-import-confirm"
            >
              Confirmer l'import
            </Button>
          </>
        )
      }
    >
      <div ref={dialogRef as any} className="wt-stack">
        {report ? (
          <div data-testid="bank-import-report" className="wt-stack">
            <Callout tone="success" title={`${report.importedCount} mouvement(s) importé(s)`}>
              <p>{report.sourceName} · format {report.format}</p>
              <p>{report.duplicateCount} doublon(s) probable(s) accepté(s) explicitement.</p>
            </Callout>
            <NextStep
              title="Étape suivante : rapprocher"
              text={report.statement?.id
                ? `Ouvrez les ${report.importedCount} mouvement(s) de ce relevé et associez chacun à l’écriture comptable qui le justifie.`
                : "Associez chaque mouvement importé à l’écriture comptable qui le justifie, depuis Banque & rapprochement."}
              action={report.statement?.id ? (
                <Button
                  variant="primary"
                  icon={<ArrowRight size={15} />}
                  data-testid="bank-import-reconcile"
                  onClick={() => onReconcileBatch({ bankAccountId: draft.bankAccountId, statementId: String(report.statement.id) })}
                >
                  Rapprocher maintenant
                </Button>
              ) : undefined}
            />
          </div>
        ) : (
          <>
            <div className="wt-grid wt-grid--narrow" aria-label="Résumé de detection">
              <Stat label="Format détecté" value={<span data-testid="bank-import-format">{draft.parsed.formatLabel}</span>} note={`Analyseur : ${draft.parsed.parser}`} />
              <Stat label="Lignes trouvées" value={draft.parsed.rowCount} note="Avant contrôle" />
              <Stat label="Devise du fichier" value={draft.parsed.currency ?? "À contrôler"} note="Doit correspondre au compte" />
              <Stat label="Fichier" value={draft.file.name} note={draft.file.extension.toUpperCase()} />
            </div>

            {draft.parsed.ocr && (
              <Callout
                tone={draft.parsed.ocr.fallbackRecommended ? "warning" : "info"}
                icon={<FileSearch size={17} />}
                title="Relevé lu par reconnaissance de texte"
              >
                <p>
                  {draft.parsed.ocr.engine} {draft.parsed.ocr.engineVersion} · confiance {draft.parsed.ocr.confidence}% · {draft.parsed.ocr.pageCount} page(s) · traitement local.
                  Vérifiez attentivement les montants : une lecture automatique n'est jamais sûre à 100 %.
                </p>
                {/*
                  * What the reading was actually good at. One average hides the
                  * case that matters — a page read cleanly whose columns were
                  * not identified — so the three parts are named separately.
                  */}
                {draft.parsed.ocr.confidenceDimensions && (
                  <p data-testid="bank-import-ocr-dimensions">
                    Mise en page {draft.parsed.ocr.confidenceDimensions.layout ?? "—"}% ·
                    reconstruction des lignes {draft.parsed.ocr.confidenceDimensions.rowReconstruction ?? "—"}% ·
                    identification des colonnes {draft.parsed.ocr.confidenceDimensions.fieldMapping ?? "—"}%
                  </p>
                )}
                {draft.parsed.ocr.fallbackRecommended && (
                  <p>Cette page a été difficile à lire. Contrôlez chaque ligne, ou fournissez le relevé en CSV, OFX ou CAMT.053 si votre banque le propose.</p>
                )}
              </Callout>
            )}

            {/*
              * The assisted pass, named where it was used.
              *
              * Wheat asks a model only about rows its local reading left
              * unusable, and only ever fills empty cells with values it can
              * find again in the recognised text. Saying so here — and marking
              * the rows in the preview below — is what turns that from an
              * invisible promise into something an accountant can check.
              */}
            {assistedRows.size > 0 && (
              <Callout tone="warning" icon={<Sparkles size={17} />} title="Lignes complétées par la relecture assistée">
                <p data-testid="bank-import-assisted-rows">
                  Ligne(s) {[...assistedRows].join(", ")} : la lecture locale n'a pas pu établir toutes les valeurs, et les cellules vides ont été complétées à partir du texte reconnu de la page.
                </p>
                <p>
                  Rien n'a été remplacé : ce que Wheat avait lu est resté tel quel, et aucune valeur introuvable dans la page n'a été retenue.
                  Ces lignes restent des propositions — vérifiez-les avant de confirmer.
                </p>
              </Callout>
            )}

            {(draft.parsed.warnings?.length ?? 0) > 0 && (
              <Callout tone="warning" title="Points signalés à la lecture du fichier">
                <ul>{draft.parsed.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </Callout>
            )}

            <Card
              title="Soldes déclarés par le relevé"
              note={fileDeclaresBalances
                ? "Ce format porte ses propres soldes : Wheat vérifiera que les mouvements lus les relient exactement."
                : "Ce format ne porte aucun solde. Saisissez ceux imprimés sur votre relevé pour que Wheat contrôle l'import et puisse comparer banque et comptabilité."}
              icon={<Scale size={18} aria-hidden="true" />}
            >
              {fileDeclaresBalances ? (
                <div className="wt-grid wt-grid--narrow" data-testid="bank-import-declared-balances">
                  <Stat label="Solde initial" value={formatExactCentsForUi(BigInt(declared.openingBalanceCents!), draft.parsed.currency ?? "MAD")} note="Lu dans le fichier" />
                  <Stat label="Solde final" value={formatExactCentsForUi(BigInt(declared.closingBalanceCents!), draft.parsed.currency ?? "MAD")} note="Lu dans le fichier" />
                </div>
              ) : (
                <>
                  <Explainer>
                    Facultatif, et vivement conseillé. Renseignés, Wheat refuse le relevé si <strong>solde initial + mouvements</strong> ne donne pas exactement le solde final — c'est ce qui attrape une ligne oubliée ou mal lue avant tout enregistrement. Laissés vides, l'import reste possible mais aucun solde bancaire ne pourra être comparé à la comptabilité. Un découvert se saisit avec le signe moins.
                  </Explainer>
                  <div className="wt-form-grid">
                    <Field label="Solde initial du relevé" htmlFor="bank-opening-balance" optional>
                      <input
                        id="bank-opening-balance"
                        className="wt-input"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={statedBalances.opening}
                        onChange={(event) => setStatedBalances((current) => ({ ...current, opening: event.target.value }))}
                      />
                    </Field>
                    <Field label="Solde final du relevé" htmlFor="bank-closing-balance" optional>
                      <input
                        id="bank-closing-balance"
                        className="wt-input"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={statedBalances.closing}
                        onChange={(event) => setStatedBalances((current) => ({ ...current, closing: event.target.value }))}
                      />
                    </Field>
                  </div>
                  {statedBalancesIncomplete && (
                    <Callout tone="warning" title="Contrôle des soldes incomplet">
                      Indiquez les deux soldes, ou aucun. Avec un seul, Wheat n'a pas les deux bouts de l'égalité et ne peut rien vérifier : l'import se fera sans ce contrôle.
                    </Callout>
                  )}
                </>
              )}
            </Card>

            <Card
              title="Correspondance des colonnes"
              note="Indiquez, pour chaque information attendue, la colonne du fichier qui la contient. Wheat propose une correspondance : vérifiez-la."
              icon={<ListChecks size={18} aria-hidden="true" />}
            >
              <Explainer>
                Choisissez soit une colonne de <strong>montant signé</strong> (positif = encaissement, négatif = décaissement), soit deux colonnes séparées <strong>Débit</strong> et <strong>Crédit</strong>. Une colonne « solde » n'est jamais un mouvement.
              </Explainer>
              {mappingRestored && (
                <Callout tone="info" title="Correspondance retrouvée">
                  Le travail que vous aviez commencé sur ce relevé a été retrouvé. Vérifiez-le, puis relancez « Vérifier le mapping » : rien n'est importé tant que vous n'avez pas confirmé.
                </Callout>
              )}
              <div className="wt-form-grid">
                {mappingFields.map(([field, label, required]) => (
                  <Field key={field} label={label} htmlFor={`bank-map-${field}`} required={Boolean(required)} optional={!required}>
                    <WheatSelect
                      id={`bank-map-${field}`}
                      options={headerOptions}
                      value={mapping[field] ?? ""}
                      onChange={(value) => updateMapping(field, value)}
                      ariaLabel={label}
                      searchPlaceholder="Rechercher une colonne…"
                      size="sm"
                    />
                  </Field>
                ))}
              </div>
            </Card>

            <Card
              title="Aperçu du fichier source"
              note="Les 20 premières lignes, telles qu'elles ont été lues."
              icon={<Eye size={18} aria-hidden="true" />}
              flush
            >
              <TableWrap label="Previsualisation du relevé">
                <table className="wt-table wt-table--dense">
                  <thead>
                    <tr>
                      <th scope="col">Ligne</th>
                      {previewHeaders.map((header) => <th key={header} scope="col">{header}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {draft.parsed.previewRows.map((row, index) => {
                      // 1-based, matching the row numbers the pipeline reports.
                      const assisted = assistedRows.has(index + 1);
                      return (
                        <tr key={index} className={assisted ? "wt-row--assisted" : undefined}>
                          <td className="wt-num">
                            {index + 1}
                            {assisted && <span className="wt-assisted-mark" title="Ligne complétée par la relecture assistée : à vérifier">·IA</span>}
                          </td>
                          {previewHeaders.map((header) => <td key={header}>{row[header] || "—"}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </Card>

            {review && (
              <Card
                title="Résultat des contrôles"
                note="Wheat vérifie chaque ligne avant de ne rien enregistrer."
                icon={<ShieldCheck size={18} aria-hidden="true" />}
              >
                <div className="wt-grid wt-grid--narrow" aria-live="polite" data-testid="bank-import-validation">
                  <Stat label="Lignes valides" value={review.validCount} />
                  <Stat label="Avertissements" value={review.warningCount} note="À vérifier, non bloquant" />
                  <Stat label="Doublons probables" value={review.duplicateCount} note="Déjà présents dans le compte" />
                  <Stat label="Prêts à importer" value={review.readyCount} />
                  <Stat label="Erreurs" value={review.errorCount} note={review.errorCount ? "Bloquent l'import" : "Aucune"} />
                </div>

                {review.exactFileDuplicate && (
                  <Callout tone="danger" title="Ce fichier a déjà été importé">
                    Le contenu exact de ce fichier existe déjà dans ce compte, même s'il a été renommé. La confirmation est bloquée pour éviter de compter deux fois les mêmes mouvements.
                  </Callout>
                )}

                {review.errors?.length > 0 && (
                  <Callout tone="danger" title="Erreurs bloquantes">
                    {/* The refusal keeps its one line; the row it refused, the
                        rule and the remedy sit behind the information control. */}
                    <IssueList issues={bankImportIssues(review.errors.slice(0, 20), draft?.parsed?.rows)} />
                  </Callout>
                )}

                {review.warnings?.length > 0 && (
                  <Callout tone="warning" title="Avertissements">
                    <ul>{review.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul>
                  </Callout>
                )}

                {review.duplicateCount > 0 && !review.exactFileDuplicate && (
                  <label className="wt-checkbox">
                    <input type="checkbox" checked={allowDuplicates} onChange={(event) => setAllowDuplicates(event.target.checked)} />
                    <span className="wt-checkbox__text">
                      <span>J'ai contrôle les lignes {review.duplicateRows.join(", ")} et je confirme leur import.</span>
                      <small>Ces lignes ressemblent a des mouvements déjà présents. Sans cette confirmation, l'import reste bloqué.</small>
                    </span>
                  </label>
                )}
              </Card>
            )}

            {error && <Callout tone="danger" title="L'operation n'a pas abouti">{error}</Callout>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function EmployeeModal({ employee, onClose, onSave }: any) {
  const [form, setForm] = useState({
    id: employee?.id,
    fullName: employee?.fullName ?? "",
    cin: employee?.cin ?? "",
    cnss: employee?.cnss ?? "",
    position: employee?.position ?? "",
    grossSalary: employee ? String(employee.grossSalary ?? "") : "",
    cnssEmployee: employee ? String(employee.cnssEmployee ?? "") : "",
    amoEmployee: employee ? String(employee.amoEmployee ?? "") : "",
    ir: employee ? String(employee.ir ?? "") : "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useAccessibleDialog<HTMLFormElement>(onClose);
  const grossSalaryCents = tryParseExactDecimalCents(form.grossSalary);
  const cnssEmployeeCents = tryParseExactDecimalCents(form.cnssEmployee);
  const amoEmployeeCents = tryParseExactDecimalCents(form.amoEmployee);
  const irCents = tryParseExactDecimalCents(form.ir);
  const amountsValid = [grossSalaryCents, cnssEmployeeCents, amoEmployeeCents, irCents].every((value) => value !== null);
  const deductionsCents = amountsValid ? cnssEmployeeCents! + amoEmployeeCents! + irCents! : null;
  const netSalaryCents = amountsValid ? grossSalaryCents! - deductionsCents! : null;
  const updateAmount = (key: "grossSalary" | "cnssEmployee" | "amoEmployee" | "ir", value: string) => {
    setForm({ ...form, [key]: value });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!form.fullName.trim() || !form.cin.trim() || !form.cnss.trim() || !form.position.trim()) {
      setError("Le nom, le CIN, le numéro CNSS et le poste sont obligatoires.");
      return;
    }
    if (!amountsValid || deductionsCents === null || netSalaryCents === null) {
      setError("Les montants doivent contenir au plus deux décimales.");
      return;
    }
    if (netSalaryCents < 0n) {
      setError("Les retenues ne peuvent pas dépasser le salaire brut.");
      return;
    }
    setBusy(true);
    try {
      await onSave({ ...form, netSalary: exactDecimalFromCents(netSalaryCents) });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  const netValid = netSalaryCents !== null && netSalaryCents >= 0n;

  return (
    <Dialog
      title={employee ? "Modifier la fiche du salarié" : "Ajouter un salarié"}
      note="Le net est calculé sur ce poste. Une paie déjà comptabilisée conserve son propre instantane, même si cette fiche change ensuite."
      icon={<Users size={18} aria-hidden="true" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" form="employee-form" variant="primary" icon={<Save size={15} />} busy={busy}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="employee-form" ref={dialogRef} onSubmit={submit} className="wt-stack">
        <div className="wt-form-grid">
          <Field label="Nom complet" htmlFor="employee-name" required>
            <input id="employee-name" className="wt-input" data-autofocus value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
          </Field>
          <Field label="Poste occupe" htmlFor="employee-position" required>
            <input id="employee-position" className="wt-input" value={form.position} onChange={(event) => setForm({ ...form, position: event.target.value })} />
          </Field>
          <Field label="CIN" htmlFor="employee-cin" required tip="Carte d'Identité Nationale : l'identifiant du salarié sur les documents de paie.">
            <input id="employee-cin" className="wt-input" value={form.cin} onChange={(event) => setForm({ ...form, cin: event.target.value })} />
          </Field>
          <Field label="Numéro CNSS" htmlFor="employee-cnss" required tip="Numéro d'immatriculation a la Caisse Nationale de Sécurité Sociale.">
            <input id="employee-cnss" className="wt-input" value={form.cnss} onChange={(event) => setForm({ ...form, cnss: event.target.value })} />
          </Field>
        </div>

        <Explainer>
          Le <strong>net à payer</strong> se calculé ainsi : salaire brut moins les retenues CNSS, AMO et IR. Wheat le recalcule à chaque modification ci-dessous.
        </Explainer>

        <div className="wt-form-grid">
          <Field label="Salaire brut" htmlFor="employee-gross" required hint="Rémunération avant toute retenue.">
            <input id="employee-gross" className="wt-input wt-input--numeric" type="text" inputMode="decimal" value={form.grossSalary} onChange={(event) => updateAmount("grossSalary", event.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Retenue CNSS" htmlFor="employee-cnss-amount" tip="Part salariale de la cotisation de sécurité sociale.">
            <input id="employee-cnss-amount" className="wt-input wt-input--numeric" type="text" inputMode="decimal" value={form.cnssEmployee} onChange={(event) => updateAmount("cnssEmployee", event.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Retenue AMO" htmlFor="employee-amo" tip="Part salariale de l'assurance maladie obligatoire.">
            <input id="employee-amo" className="wt-input wt-input--numeric" type="text" inputMode="decimal" value={form.amoEmployee} onChange={(event) => updateAmount("amoEmployee", event.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Retenue IR" htmlFor="employee-ir" tip="Impot sur le revenu retenu a la source par l'employeur.">
            <input id="employee-ir" className="wt-input wt-input--numeric" type="text" inputMode="decimal" value={form.ir} onChange={(event) => updateAmount("ir", event.target.value)} placeholder="0,00" />
          </Field>
        </div>

        <div className="wt-row wt-row--between modal-total" style={{ padding: "var(--space-5) var(--space-6)", background: "var(--surface-muted)", borderRadius: "var(--radius-md)" }}>
          <span className="wt-num">Retenues <strong>{deductionsCents === null ? "montant invalide" : formatExactCentsForUi(deductionsCents)}</strong></span>
          <span className="wt-num">Net calculé <strong>{netSalaryCents === null ? "montant invalide" : formatExactCentsForUi(netSalaryCents < 0n ? 0n : netSalaryCents)}</strong></span>
          <Badge tone={netValid ? "success" : "danger"} dot>{netValid ? "Calcul cohérent" : "A corriger"}</Badge>
        </div>

        {error && <Callout tone="danger" title="La fiche n'a pas été enregistrée">{error}</Callout>}
      </form>
    </Dialog>
  );
}

function SageExportPage({ data, currentCompany, exportRows, notify }: any) {
  const [profile, setProfile] = useState<SageTxtProfile>(() => loadSageProfile(currentCompany?.id));
  const [sageEntries, setSageEntries] = useState<any[]>([]);
  const [sageLoading, setSageLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const profileEditRevision = useRef(0);
  const profileLoadRequestId = useRef(0);
  const profileSaveRequestId = useRef(0);
  const profileCompanyId = useRef<string | undefined>(currentCompany?.id);
  useEffect(() => {
    profileCompanyId.current = currentCompany?.id;
    profileSaveRequestId.current += 1;
    setProfileSaving(false);
  }, [currentCompany?.id]);
  const postedEntries = useMemo(() => ledgerEntries(sageEntries), [sageEntries]);
  const sageBuild = useMemo(() => {
    try {
      return { rows: buildSageTxtRows(postedEntries, profile), error: "" };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : "Les montants Sage sont invalides." };
    }
  }, [postedEntries, profile]);
  const sageRows = sageBuild.rows;
  const validation = useMemo(() => {
    const result = validateSageTxtExport(postedEntries, sageRows, profile);
    return sageBuild.error ? { ...result, errors: [sageBuild.error, ...result.errors] } : result;
  }, [postedEntries, profile, sageBuild.error, sageRows]);
  const previewLines = useMemo(
    () => profile.outputKind === "PNM" ? [] : buildSageTxtLines(sageRows, profile.includeHeader),
    [profile.includeHeader, profile.outputKind, sageRows],
  );
  const previewText = profile.outputKind === "PNM"
    ? "Aucun aperçu PNM : le schéma de positions n'est pas vérifié et l'export est bloqué."
    : previewLines.slice(0, 80).join("\n");
  const journalCodes = useMemo(() => {
    const fromEntries: string[] = postedEntries.map((entry: any) => String(entry.journalCodeSnapshot ?? entry.journal?.code ?? "").trim()).filter(Boolean);
    const fromCompany: string[] = (currentCompany?.journals ?? []).map((journal: any) => String(journal.code ?? "").trim()).filter(Boolean);
    return Array.from(new Set<string>(fromEntries.length ? fromEntries : fromCompany)).sort();
  }, [currentCompany?.journals, postedEntries]);
  const accountCodes = useMemo(
    () => Array.from(new Set(sageRows.map((row) => row.rawAccountNumber).filter(Boolean))).sort(),
    [sageRows],
  );
  /* Every party carried by a prepared line, keyed by its counterparty id. The
     name is only ever shown here, so the accountant can recognise whose Sage
     third-party account is still missing. */
  const thirdParties = useMemo(() => {
    const parties = new Map<string, string>();
    for (const row of sageRows) {
      if (row.thirdPartyKey) parties.set(row.thirdPartyKey, row.thirdPartyName || row.thirdPartyKey);
    }
    return Array.from(parties, ([key, name]) => ({ key, name })).sort((left, right) => left.name.localeCompare(right.name));
  }, [sageRows]);
  const unlinkedThirdParties = useMemo(
    () => Array.from(new Set(sageRows.filter((row) => row.thirdPartyStatus === "UNIDENTIFIED").map((row) => row.thirdPartyName))).sort(),
    [sageRows],
  );
  const blockingIssues = useMemo(() => issuesOfSeverity(validation.issues, "BLOCKER"), [validation.issues]);
  const reviewIssues = useMemo(() => issuesOfSeverity(validation.issues, "REVIEW"), [validation.issues]);
  const warningIssues = useMemo(() => issuesOfSeverity(validation.issues, "WARNING"), [validation.issues]);

  useEffect(() => {
    let cancelled = false;
    const companyId = currentCompany?.id;
    const requestId = ++profileLoadRequestId.current;
    const localProfile = loadSageProfile(companyId);
    const editRevision = ++profileEditRevision.current;
    setProfile(localProfile);
    setProfileLoading(false);
    if (!companyId || !window.wheat?.getSageExportProfile) return;
    setProfileLoading(true);
    window.wheat.getSageExportProfile(companyId)
      .then((saved) => {
        if (!cancelled && requestId === profileLoadRequestId.current && editRevision === profileEditRevision.current && saved) {
          setProfile(normalizeSageProfile(saved));
        }
      })
      .catch((error) => {
        if (!cancelled && requestId === profileLoadRequestId.current) notify(error instanceof Error ? error.message : String(error), "warning");
      })
      .finally(() => {
        if (!cancelled && requestId === profileLoadRequestId.current) setProfileLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentCompany?.id, notify]);

  useEffect(() => {
    let cancelled = false;
    if (!currentCompany?.id) {
      setSageEntries([]);
      return;
    }
    if (!window.wheat?.getSageExportEntries) {
      setSageEntries(ledgerEntries(data?.entries ?? []));
      return;
    }
    setSageLoading(true);
    window.wheat.getSageExportEntries(currentCompany.id)
      .then((entries) => {
        if (!cancelled) setSageEntries(Array.isArray(entries) ? entries : []);
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : String(error), "warning");
      })
      .finally(() => {
        if (!cancelled) setSageLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentCompany?.id, data?.entries, notify]);

  const updateProfile = (patch: Partial<SageTxtProfile>) => {
    profileEditRevision.current += 1;
    setProfile((previous) => ({ ...previous, ...patch }));
  };

  const reuseWheatJournalCodes = () => {
    updateProfile({ journalMappings: Object.fromEntries(journalCodes.map((code) => [code, code])) });
  };

  const updateJournalMapping = (sourceCode: string, targetCode: string) => {
    updateProfile({ journalMappings: { ...profile.journalMappings, [sourceCode]: targetCode } });
  };

  const updateAccountMapping = (sourceCode: string, targetCode: string) => {
    const accountMappings = { ...profile.accountMappings };
    if (targetCode.trim()) accountMappings[sourceCode] = targetCode;
    else delete accountMappings[sourceCode];
    updateProfile({ accountMappings });
  };

  const updateThirdPartyMapping = (counterpartyId: string, accountCode: string) => {
    const thirdPartyMappings = { ...profile.thirdPartyMappings };
    if (accountCode.trim()) thirdPartyMappings[counterpartyId] = accountCode.trim();
    else delete thirdPartyMappings[counterpartyId];
    updateProfile({ thirdPartyMappings });
  };

  const saveProfile = async () => {
    const companyId = currentCompany?.id;
    if (!companyId) return;
    const requestId = ++profileSaveRequestId.current;
    const editRevision = profileEditRevision.current;
    const profileToSave = profile;
    setProfileSaving(true);
    try {
      const saved = window.wheat?.saveSageExportProfile
        ? await window.wheat.saveSageExportProfile({ companyId, ...profileToSave })
        : profileToSave;
      const normalized = normalizeSageProfile(saved);
      if (profileCompanyId.current === companyId && requestId === profileSaveRequestId.current && editRevision === profileEditRevision.current) {
        setProfile(normalized);
      }
      window.localStorage.setItem(sageProfileKey(companyId), JSON.stringify(normalized));
      notify("Profil Sage enregistré dans la base locale et ses sauvegardes", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Enregistrement du profil Sage impossible", "warning");
    } finally {
      if (requestId === profileSaveRequestId.current) setProfileSaving(false);
    }
  };

  const exportTextFile = async () => {
    if (validation.errors.length) {
      notify("Corrigez les erreurs avant export Sage", "warning");
      return;
    }

    if (profile.outputKind === "PNM") return;
    const extension = profile.outputKind.toLowerCase() as "txt" | "csv";
    const text = buildSageTxtLines(sageRows, profile.includeHeader).join("\r\n");
    const bytes = profile.encoding === "windows-1252" ? encodeSageWindows1252(text) : new TextEncoder().encode(text);
    const bytesBase64 = base64FromArrayBuffer(bytes.slice().buffer as ArrayBuffer);
    const suggestedName = `${slug(currentCompany?.name ?? "wheat")}-sage.${extension}`;

    if (window.wheat) {
      const target = await window.wheat.exportFile({
        suggestedName,
        bytesBase64,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (target) notify(`Export Sage créé : ${target}`, "success");
    } else {
      notify("Export Sage préparé dans la prévisualisation navigateur", "success");
    }
  };

  const exportExcel = () => {
    if (validation.errors.length) {
      notify("Corrigez les erreurs avant export Sage", "warning");
      return;
    }
    exportRows(sageRows.map((row: any) => ({
      Journal: row.journalCode,
      Date: row.date,
      Pièce: row.pieceNumber,
      Compte: row.accountNumber,
      Tiers: row.thirdParty,
      Libellé: row.label,
      Debit: row.debit,
      Credit: row.credit,
      Échéance: row.dueDate,
      Reference: row.reference,
    })), `${slug(currentCompany?.name ?? "wheat")}-sage.xlsx`, "Export Sage");
  };

  const outputKindOptions: WheatSelectOption[] = [
    { value: "TXT", label: "TXT — 10 champs contrôles", note: "Format texte standard attendu par Sage" },
    { value: "CSV", label: "CSV — mêmes 10 champs", note: "Ouvrable dans Excel avant import" },
    { value: "PNM", label: "PNM — non vérifié", note: "Schema de positions non valide : export bloqué" },
  ];
  const accountLengthOptions: WheatSelectOption[] = [
    { value: "VARIABLE", label: "Variable, maximum 13", note: "Conserve la longueur d'origine" },
    ...[6, 7, 8, 9, 10, 11, 12, 13].map((length) => ({ value: String(length), label: `${length} caracteres exactement`, note: "Complète ou tronque a la longueur du dossier Sage" })),
  ];
  const encodingOptions: WheatSelectOption[] = [
    { value: "windows-1252", label: "Windows-1252", note: "Encodage attendu par Sage sous Windows" },
    { value: "utf-8", label: "UTF-8", note: "A n'utiliser que si le dossier cible l'exige" },
  ];

  const blocked = validation.errors.length > 0;

  return (
    <>
      <PageHeader
        icon={<FileOutput size={22} aria-hidden="true" />}
        title="Export Sage & FEC"
        purpose={pagePurpose.sage}
        meta={
          <>
            <span><Building2 size={13} aria-hidden="true" /> {currentCompany?.name ?? "Aucun dossier"}</span>
            <span><ListChecks size={13} aria-hidden="true" /> {sageRows.length} ligne(s) préparée(s)</span>
            <span><ShieldCheck size={13} aria-hidden="true" /> Seules les écritures comptabilisées sont exportees</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<Download size={15} />} disabled={blocked} onClick={exportTextFile}>
              Exporter en .{profile.outputKind}
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet size={15} />} disabled={blocked} onClick={exportExcel}>
              Exporter en Excel
            </Button>
          </>
        }
        guide={[
          { icon: <Settings size={16} />, title: "Paramètres", text: "Format de fichier, longueur des comptes et encodage attendus par Sage." },
          { icon: <ListChecks size={16} />, title: "Correspondances", text: "Associez chaque journal et compte Wheat a son code dans le dossier Sage." },
          { icon: <ShieldCheck size={16} />, title: "Contrôles", text: "Wheat vérifié l'équilibre et les codes manquants avant de générer le fichier." },
          { icon: <Eye size={16} />, title: "Aperçu", text: "Le contenu exact du fichier, avant de l'écrire sur le disque." },
        ]}
        help={{
          summary: "A quoi sert cet export ?",
          content: (
            <>
              <p>Cet écran produit un fichier que le logiciel <strong>Sage</strong> sait relire, afin de transferer les écritures d'un dossier Wheat vers un dossier Sage existant.</p>
              <p>Sage n'accepte que des codes de journaux et de comptes qui existent déjà chez lui. La section <strong>Correspondances</strong> sert a indiquer, pour chaque code Wheat, le code equivalent dans Sage. Wheat ne créé jamais de code dans Sage.</p>
              <p>Le format <strong>FEC</strong> (Fichier des Écritures Comptables) suit la même logique : un fichier plat, contrôle avant génération. Un export dont les contrôles échouent reste bloqué tant que les erreurs ne sont pas corrigees.</p>
            </>
          ),
        }}
      />

      {sageLoading && <LoadingState label="Lecture complète des livres comptables…" />}

      <Card
        title="Parametrès du fichier Sage"
        note="Format physique contrôle : 10 champs dans un ordre fixe, separateur point-virgule, date JJMMAA et montants avec virgule a deux decimales."
        icon={<Settings size={18} aria-hidden="true" />}
        actions={<Badge tone="success" dot>Format TXT contrôle</Badge>}
        footer={
          <Button variant="secondary" icon={<Save size={15} />} busy={profileSaving} disabled={profileLoading} onClick={saveProfile}>
            {profileLoading ? "Lecture du profil…" : "Enregistrer ce profil pour le dossier"}
          </Button>
        }
      >
        <div className="wt-form-grid">
          <Field label="Profil" htmlFor="sage-profile" hint="Determine par le format choisi ; non modifiable.">
            <input id="sage-profile" className="wt-input" value={profile.profileType} readOnly />
          </Field>
          <Field label="Type de fichier" htmlFor="sage-output" hint="TXT est le format attendu par la plupart des dossiers Sage.">
            <WheatSelect id="sage-output" options={outputKindOptions} value={profile.outputKind} onChange={(value) => updateProfile({ outputKind: value as SageOutputKind })} ariaLabel="Type de fichier" />
          </Field>
          <Field
            label="Longueur des comptes"
            htmlFor="sage-account-length"
            tip="Certains dossiers Sage exigent des numéros de compte d'une longueur fixe. Dans le doute, laissez Variable."
            hint="Doit correspondre au paramétrage du dossier Sage cible."
          >
            <WheatSelect id="sage-account-length" options={accountLengthOptions} value={String(profile.accountLength)} onChange={(value) => updateProfile({ accountLength: value })} ariaLabel="Longueur des comptes" />
          </Field>
          <Field label="Separateur de champs" htmlFor="sage-separator" hint="Impose par le format : non modifiable.">
            <input id="sage-separator" className="wt-input" value="Point-virgule (;)" readOnly />
          </Field>
          <Field label="Encodage" htmlFor="sage-encoding" tip="L'encodage decide comment les accents sont ecrits dans le fichier. Un mauvais choix affiche des caracteres etranges dans Sage.">
            <WheatSelect id="sage-encoding" options={encodingOptions} value={profile.encoding} onChange={(value) => updateProfile({ encoding: value as SageTxtProfile["encoding"] })} ariaLabel="Encodage" />
          </Field>
          <Field label="Format date / montant" htmlFor="sage-formats" hint="Impose par le format : non modifiable.">
            <input id="sage-formats" className="wt-input" value="JJMMAA / 1234,56" readOnly />
          </Field>
        </div>
        <label className="wt-checkbox">
          <input type="checkbox" checked={profile.includeHeader} onChange={(event) => updateProfile({ includeHeader: event.target.checked })} />
          <span className="wt-checkbox__text">
            <span>Inclure une ligne d'en-tête</span>
            <small>Désactivé par defaut : la plupart des dossiers Sage refusent une première ligne de titres.</small>
          </span>
        </label>
      </Card>

      <Card
        title="Correspondances de codes"
        note="Un code journal cible est obligatoire. Un compte cible laisse vide conserve exactement le code Wheat."
        icon={<ListChecks size={18} aria-hidden="true" />}
        actions={<Button variant="secondary" size="sm" onClick={reuseWheatJournalCodes}>Reprendre les codes Wheat</Button>}
      >
        <Callout tone="info">
          Wheat ne créé aucun code dans Sage. Si un code cible n'existe pas dans le dossier Sage, l'import y sera refuse — vérifiez-les avec la personne qui tient le dossier Sage.
        </Callout>

        <Section title="Journaux utilisés" note="Chaque journal present dans les écritures doit avoir un code Sage.">
          {journalCodes.length ? (
            <div className="wt-form-grid">
              {journalCodes.map((code) => (
                <Field key={code} label={`Journal ${code}`} htmlFor={`sage-journal-${code}`} required hint="Code du journal equivalent dans Sage.">
                  <input
                    id={`sage-journal-${code}`}
                    className="wt-input"
                    aria-label={`Journal ${code} vers code Sage`}
                    value={profile.journalMappings[code] ?? ""}
                    onChange={(event) => updateJournalMapping(code, event.target.value)}
                    maxLength={6}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <EmptyState icon={<ListChecks size={22} aria-hidden="true" />} title="Aucun journal à mapper" text="Ce dossier ne contient pas encore d'écriture comptabilisée." />
          )}
        </Section>

        <Section
          title="Comptes tiers utilisés"
          note="Le champ Sage « N° compte tiers » attend un numéro de compte auxiliaire du dossier Sage, jamais la raison sociale. Laissez vide si ces lignes ne doivent porter aucun compte auxiliaire."
        >
          {thirdParties.length ? (
            <div className="wt-form-grid">
              {thirdParties.map((party) => (
                <Field
                  key={party.key}
                  label={party.name}
                  htmlFor={`sage-third-party-${party.key}`}
                  optional
                  hint="Numéro de compte tiers dans le dossier Sage (17 caractères au maximum)."
                >
                  <input
                    id={`sage-third-party-${party.key}`}
                    className="wt-input"
                    aria-label={`Compte tiers Sage de ${party.name}`}
                    value={profile.thirdPartyMappings[party.key] ?? ""}
                    placeholder="Aucun compte tiers"
                    onChange={(event) => updateThirdPartyMapping(party.key, event.target.value)}
                    maxLength={17}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Users size={22} aria-hidden="true" />} title="Aucun tiers à mapper" text="Aucune écriture comptabilisée ne porte encore de tiers rattaché à une fiche." />
          )}
          {unlinkedThirdParties.length > 0 && (
            <Callout tone="warning" title="Tiers saisis en texte libre">
              Ces noms sont saisis à la main sur des écritures et ne sont rattachés à aucune fiche tiers, donc aucun compte tiers Sage ne peut leur être associé : {unlinkedThirdParties.join(", ")}.
            </Callout>
          )}
        </Section>

        <Section title="Comptes utilisés" note="Laissez vide pour conserver le numéro de compte tel quel.">
          {accountCodes.length ? (
            <div className="wt-form-grid">
              {accountCodes.map((code) => (
                <Field key={code} label={`Compte ${code}`} htmlFor={`sage-account-${code}`} optional hint="Vide = identique au code Wheat.">
                  <input
                    id={`sage-account-${code}`}
                    className="wt-input"
                    aria-label={`Compte ${code} vers compte Sage`}
                    value={profile.accountMappings[code] ?? ""}
                    placeholder={`Identique : ${code}`}
                    onChange={(event) => updateAccountMapping(code, event.target.value)}
                    maxLength={13}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Scale size={22} aria-hidden="true" />} title="Aucun compte à mapper" text="Les comptes apparaissent des qu'une écriture comptabilisée existe." />
          )}
        </Section>
      </Card>

      <Card
        title="Contrôles avant export"
        note="Wheat vérifié l'équilibre, les codes manquants et le format de chaque champ. Une erreur bloqué l'export."
        icon={<ShieldCheck size={18} aria-hidden="true" />}
      >
        <div className={`wt-stack wt-stack--tight validation-list${blocked ? " has-errors" : ""}`}>
          {blocked ? (
            <Callout tone="danger" title={`${blockingIssues.length} erreur(s) bloquent l'export`}>
              Corrigez les points ci-dessous : tant qu'une erreur subsiste, aucun fichier n'est généré.
              <IssueList issues={blockingIssues} />
            </Callout>
          ) : (
            <Callout tone="success" title="Aucune erreur bloquante" className="ok">
              {sageLoading ? "Lecture complète des livres en cours…" : `${sageRows.length} ligne(s) prête(s). Débit et crédit sont équilibrés au centime.`}
            </Callout>
          )}
          {reviewIssues.length > 0 && (
            <Callout tone="warning" title={`${reviewIssues.length} correspondance(s) à vérifier`}>
              Ces points n'empêchent pas l'export, mais une information comptable en sortira incomplète tant qu'ils ne sont pas tranchés.
              <IssueList issues={reviewIssues} />
            </Callout>
          )}
          {warningIssues.length > 0 && (
            <Callout tone="info" title={`${warningIssues.length} point(s) de vigilance`}>
              <IssueList issues={warningIssues} />
            </Callout>
          )}
        </div>
      </Card>

      <Card
        title="Aperçu du fichier"
        note="Le contenu exact qui sera écrit sur le disque — 80 premieres lignes."
        icon={<Eye size={18} aria-hidden="true" />}
        footer={
          <>
            <Button variant="primary" icon={<Download size={15} />} disabled={blocked} onClick={exportTextFile}>
              Exporter en .{profile.outputKind}
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet size={15} />} disabled={blocked} onClick={exportExcel}>
              Exporter en Excel
            </Button>
            {blocked && <span className="wt-hint">Export bloqué tant que les erreurs ci-dessus ne sont pas corrigees.</span>}
          </>
        }
      >
        <pre
          className="sage-preview wt-code"
          tabIndex={0}
          aria-label="Aperçu de l'export Sage"
          style={{ display: "block", whiteSpace: "pre", overflow: "auto", maxHeight: 320, padding: "var(--space-5)" }}
        >
          {previewText || "Aucune ligne a exporter."}
        </pre>
      </Card>
    </>
  );
}

function loadSageProfile(companyId?: string) {
  try {
    const stored = window.localStorage.getItem(sageProfileKey(companyId))
      ?? window.localStorage.getItem(legacySageProfileKey(companyId));
    return stored ? normalizeSageProfile(JSON.parse(stored)) : createDefaultSageProfile();
  } catch {
    return createDefaultSageProfile();
  }
}

function normalizeSageProfile(value: any): SageTxtProfile {
  const fallback = createDefaultSageProfile();
  if (!value || typeof value !== "object") return fallback;
  const outputKind = ["TXT", "CSV", "PNM"].includes(value.outputKind) ? value.outputKind : fallback.outputKind;
  const encoding = ["windows-1252", "utf-8"].includes(value.encoding) ? value.encoding : fallback.encoding;
  const accountLength = value.accountLength === "VARIABLE" || (Number.isInteger(Number(value.accountLength)) && Number(value.accountLength) >= 6 && Number(value.accountLength) <= 13)
    ? value.accountLength
    : fallback.accountLength;
  const stringRecord = (input: unknown) => input && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return {
    ...fallback,
    outputKind,
    encoding,
    accountLength,
    includeHeader: value.includeHeader === true,
    journalMappings: stringRecord(value.journalMappings),
    accountMappings: stringRecord(value.accountMappings),
    thirdPartyMappings: stringRecord(value.thirdPartyMappings),
  };
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "wheat";
}

function LocalAnalysisPage({ data, language }: any) {
  const copy = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const [messages, setMessages] = useState<AnalysisMessage[]>([
    {
      role: "analysis",
      text: copy.assistantGreeting ?? pageCopy.fr.assistantGreeting,
      source: buildAnalysisScope(data),
    },
  ]);
  const [question, setQuestion] = useState(copy.assistantInitialQuestion ?? pageCopy.fr.assistantInitialQuestion);

  const answer = () => {
    if (!question.trim()) return;
    const result = buildLocalAnalysisAnswer(question, data);
    setMessages((items) => [
      ...items,
      { role: "user", text: question.trim() },
      { role: "analysis", text: result.text, source: result.source },
    ]);
    setQuestion("");
  };

  const examples = [
    "Quel est le total des factures impayées ?",
    "Combien de documents restent à traiter ?",
    "Quel est le solde bancaire du dossier ?",
    "Combien d'écritures sont encore en brouillon ?",
  ];

  return (
    <>
      <PageHeader
        icon={<Command size={22} aria-hidden="true" />}
        title="Analyse locale"
        purpose={pagePurpose.assistant}
        meta={
          <>
            <span><HardDrive size={13} aria-hidden="true" /> Calcul effectue sur cet ordinateur</span>
            <span><ShieldCheck size={13} aria-hidden="true" /> Aucune donnée envoyee sur internet</span>
          </>
        }
        help={{
          summary: "En quoi est-ce different de Wheat AI ?",
          content: (
            <>
              <p>L'<strong>analyse locale</strong> ne fait aucun appel a un modèle de langage : elle répond en interrogeant directement les données chargees, avec des calculs deterministes. La même question donne toujours la même réponse, et chaque réponse indique sa source.</p>
              <p><strong>Wheat AI</strong>, lui, s'appuie sur un modèle de langage — local ou distant — et sait raisonner, expliquer et préparer des actions, mais ses réponses ne sont pas garanties reproductibles.</p>
              <p>Utilisez l'analyse locale pour un chiffré sur, et Wheat AI pour comprendre ou agir.</p>
            </>
          ),
        }}
      />

      <Explainer>
        Posez une question en francais sur le dossier ouvert. Wheat répond à partir des enregistrements charges et affiche systematiquement <strong>d'où vient</strong> le chiffré annonce.
      </Explainer>

      <Card
        title={copy.assistantName ?? pageCopy.fr.assistantName}
        note="Historique de la conversation. Rien n'est enregistre : la conversation disparait au changement d'écran."
        icon={<FileSearch size={18} aria-hidden="true" />}
        footer={
          <>
            <div className="wt-input-affix" style={{ flex: "1 1 320px" }}>
              <Search size={15} aria-hidden="true" />
              <input
                value={question}
                aria-label={copy.assistantPlaceholder}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && answer()}
                placeholder={copy.assistantPlaceholder}
              />
            </div>
            <Button variant="primary" icon={<Send size={15} />} disabled={!question.trim()} onClick={answer}>
              {copy.send}
            </Button>
          </>
        }
      >
        <div className="wt-stack wt-stack--tight" role="log" aria-live="polite" aria-label="Conversation d'analyse locale">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className="wt-callout"
              style={{
                background: message.role === "analysis" ? "var(--surface-muted)" : "var(--brand-soft)",
                borderColor: message.role === "analysis" ? "var(--line-subtle)" : "var(--brand-border)",
                alignSelf: message.role === "analysis" ? "flex-start" : "flex-end",
                maxWidth: "min(90%, 78ch)",
              }}
            >
              {message.role === "analysis" ? <FileSearch size={16} aria-hidden="true" /> : <Users size={16} aria-hidden="true" />}
              <div className="wt-callout__body">
                <span className="wt-callout__title">{message.role === "analysis" ? (copy.assistantName ?? pageCopy.fr.assistantName) : "Vous"}</span>
                <p>{message.text}</p>
                {message.source && <span className="wt-hint">Source : {message.source}</span>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Exemples de questions" note="Cliquez pour remplir la zone de saisie." icon={<Lightbulb size={18} aria-hidden="true" />}>
        <div className="wt-row">
          {examples.map((example) => (
            <button type="button" key={example} className="wt-chip" onClick={() => setQuestion(example)}>
              {example}
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}

function SettingsPage({ data, darkMode, setDarkMode, createBackup, restoreBackup, resetWorkspace, setCompanyModalOpen, notify, language, setLanguage, updateUserName, securityStatus, setupLocalLock, disableLocalLock, lockLocalApp, mapBankLedgerAccount, createBankLedgerAccount, updateStatus, checkForUpdates, downloadUpdate, installUpdate, updateBusy }: any) {
  const copy = shellCopy[language as AppLanguage] ?? shellCopy.fr;
  const labels = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const [profileName, setProfileName] = useState(data?.user?.name ?? "");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const licenseDialogRef = useAccessibleDialog<HTMLElement>(() => setLicenseOpen(false), licenseOpen);
  const savedProfileName = data?.user?.name ?? "";
  const profileNameChanged = profileName.trim() !== savedProfileName;

  useEffect(() => {
    setProfileName(data?.user?.name ?? "");
  }, [data?.user?.name]);

  const saveProfileName = () => {
    updateUserName(profileName);
  };

  const languageSelectOptions: WheatSelectOption[] = languageOptions.map((option) => ({
    value: option.value,
    label: option.nativeName,
    note: option.label,
  }));
  const busyUpdate = ["checking", "downloading", "verifying", "installing"].includes(updateStatus?.phase);

  return (
    <>
      <PageHeader
        icon={<Settings size={22} aria-hidden="true" />}
        title="Réglages"
        purpose={pagePurpose.settings}
        meta={
          <>
            <span><HardDrive size={13} aria-hidden="true" /> {copy.cloud}</span>
            <span><BadgeCheck size={13} aria-hidden="true" /> Wheat {data?.appVersion ?? WHEAT_APP_VERSION}</span>
          </>
        }
        guide={[
          { icon: <Users size={16} />, title: "Profil", text: "Le nom affiche dans la barre laterale et les journaux d'activité." },
          { icon: <Lock size={16} />, title: "Sécurité locale", text: "Verrou par code PIN pour proteger l'accès sur ce poste." },
          { icon: <DatabaseBackup size={16} />, title: "Sauvegardes", text: "Copier ou restaurer l'integralite des données comptables." },
          { icon: <Sparkles size={16} />, title: "Wheat AI", text: "Fournisseur, clé d'API et selection automatique des modèles gratuits." },
        ]}
      />

      <div className="wt-split wt-split--even">
        <Card
          title={copy.profile ?? shellCopy.fr.profile}
          note={copy.profileNameHint ?? shellCopy.fr.profileNameHint}
          icon={<Users size={18} aria-hidden="true" />}
          footer={
            <Button variant="primary" icon={<BadgeCheck size={15} />} disabled={!profileName.trim() || !profileNameChanged} onClick={saveProfileName}>
              {copy.saveProfile ?? shellCopy.fr.saveProfile}
            </Button>
          }
        >
          <div className="wt-row">
            <span className="wt-avatar" style={{ width: 48, height: 48, fontSize: "var(--text-base)" }} aria-hidden="true">
              {initialsFromName(profileName || savedProfileName)}
            </span>
            <Field label={copy.profileName ?? shellCopy.fr.profileName} htmlFor="settings-profile-name" className="wt-spacer">
              <input
                id="settings-profile-name"
                className="wt-input"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") saveProfileName(); }}
                maxLength={80}
                placeholder="Votre nom"
              />
            </Field>
          </div>
        </Card>

        <Card
          title={copy.preferences}
          note="Langue de l'interface et apparence de l'application sur ce poste."
          icon={<Languages size={18} aria-hidden="true" />}
        >
          <Field label={copy.appLanguage} htmlFor="settings-language" hint={copy.appLanguageHint}>
            <WheatSelect
              id="settings-language"
              options={languageSelectOptions}
              value={language}
              onChange={(value) => setLanguage(value as AppLanguage)}
              ariaLabel={copy.appLanguage}
              searchable={false}
            />
          </Field>
          <Switch
            checked={darkMode}
            onChange={() => setDarkMode(!darkMode)}
            label="Mode sombre"
            hint="Palette Wheat sombre, pensee pour les longues sessions de saisie."
          />
          <Callout tone="neutral" icon={<HardDrive size={17} />}>{copy.cloud}</Callout>
        </Card>
      </div>

      <WheatAiProviderSettings notify={notify} activeCompanyId={data?.activeCompanyId} />

      <div className="wt-split wt-split--even">
        <Card
          title={labels.settingsSecurity ?? pageCopy.fr.settingsSecurity}
          note="Wheat s'appuie sur la session Windows de cet ordinateur. Le verrou local ajoute un code PIN à l'ouverture."
          icon={<ShieldCheck size={18} aria-hidden="true" />}
        >
          <dl className="wt-kv">
            <div><dt>Stockage des données</dt><dd>Base et documents locaux</dd></div>
            <div><dt>Contexte de sécurité</dt><dd>Session Windows de ce poste</dd></div>
            <div><dt>{labels.shortcuts ?? pageCopy.fr.shortcuts}</dt><dd>{labels.shortcutsValue ?? pageCopy.fr.shortcutsValue}</dd></div>
          </dl>
          <hr className="wt-divider" />
          <LocalLockSettings status={securityStatus} setup={setupLocalLock} disable={disableLocalLock} lock={lockLocalApp} />
        </Card>

        <Card
          title={labels.settingsBackups ?? pageCopy.fr.settingsBackups}
          note="Une sauvegarde contient la base comptable et les documents classes. Conservez-la sur un autre support."
          icon={<DatabaseBackup size={18} aria-hidden="true" />}
          footer={
            <>
              <Button variant="primary" icon={<DatabaseBackup size={15} />} onClick={createBackup}>{labels.backup}</Button>
              <Button variant="secondary" icon={<Upload size={15} />} onClick={restoreBackup}>{labels.restore}</Button>
              <Button variant="ghost" onClick={() => data?.databasePath && window.wheat?.openPath(data.databasePath)}>{labels.openDb}</Button>
            </>
          }
        >
          <Field label="Emplacement de la base locale" htmlFor="settings-db-path" hint="Le fichier de base de données utilisé par ce poste.">
            <input id="settings-db-path" className="wt-input" value={data?.databasePath ?? ""} readOnly />
          </Field>
          <Callout tone="warning" title="La restauration remplace tout">
            Restaurer une sauvegarde ecrase les données actuelles de ce poste. Creez une sauvegarde de l'état present avant de restaurer un ancien fichier.
          </Callout>
        </Card>
      </div>

      <Card
        title="Comptes bancaires et grand livre"
        note="Associez chaque banque à son compte 514… pour que le rapprochement ne propose que les lignes comptabilisées correspondantes."
        icon={<Landmark size={18} aria-hidden="true" />}
      >
        <Explainer>
          Un <strong>compte 514</strong> est le compte du plan comptable qui représente une banque. Sans cette association, Wheat ne sait pas quelles écritures comparer au relevé importé.
        </Explainer>
        <BankLedgerMapping data={data} onMap={mapBankLedgerAccount} onCreate={createBankLedgerAccount} />
      </Card>

      <Card
        title={labels.settingsStartReset ?? pageCopy.fr.settingsStartReset}
        note="Créer un nouveau dossier, charger un jeu de démonstration, ou repartir de zéro."
        icon={<RotateCcw size={18} aria-hidden="true" />}
      >
        <Callout tone="danger" title="Les deux dernières actions effacent les données locales">
          Elles remplacent l'integralite du contenu de ce poste. Creez d'abord une sauvegarde si le dossier contient de vraies écritures.
        </Callout>
        <div className="wt-row">
          <Button variant="primary" icon={<Building2 size={15} />} onClick={() => setCompanyModalOpen(true)}>Nouveau dossier</Button>
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => resetWorkspace("demo")}>Charger un dossier de démonstration</Button>
          <Button variant="danger-outline" icon={<RotateCcw size={15} />} onClick={() => resetWorkspace("blank")}>Vider l'application</Button>
        </div>
      </Card>

      <div className="wt-split wt-split--even">
        <Card
          title="Mises à jour"
          note="Wheat vérifie les mises à jour en arrière-plan. Rien n'est téléchargé ni installé sans votre accord."
          icon={<Download size={18} aria-hidden="true" />}
          actions={<Badge tone={updateStatus?.error ? "danger" : updateStatus?.phase === "ready" || updateStatus?.phase === "available" ? "brand" : "success"} dot>{updateStatusLabel(updateStatus)}</Badge>}
          footer={
            <>
              <Button variant="secondary" busy={busyUpdate} icon={<RefreshCw size={15} />} disabled={busyUpdate} onClick={() => void checkForUpdates()}>
                Rechercher les mises à jour
              </Button>
              {updateStatus?.phase === "available" && (
                <Button variant="primary" busy={updateBusy} icon={<Download size={15} />} onClick={() => void downloadUpdate()}>
                  Mettre à jour
                </Button>
              )}
              {updateStatus?.phase === "ready" && updateStatus.automaticInstallationEnabled && (
                <Button variant="primary" busy={updateBusy} icon={<RefreshCw size={15} />} onClick={() => void installUpdate()}>
                  Redémarrer et installer
                </Button>
              )}
            </>
          }
        >
          <div aria-live="polite" className="wt-stack wt-stack--tight">
            <dl className="wt-kv">
              <div><dt>Version installée</dt><dd>Wheat {data?.appVersion ?? WHEAT_APP_VERSION}</dd></div>
              <div>
                <dt>Dernière vérification</dt>
                <dd>{updateStatus?.lastCheckedAt ? formatUpdateDateTime(updateStatus.lastCheckedAt) : "Jamais"}</dd>
              </div>
              {updateStatus?.availableVersion && (
                <div><dt>Version disponible</dt><dd>{updateStatus.availableVersion}</dd></div>
              )}
            </dl>
            {updateStatus?.phase === "downloading" && updateStatus.download && (
              <UpdateDownloadProgress download={updateStatus.download} />
            )}
            {updateStatus?.availableRelease && updateStatus.availableRelease.notes.length > 0 && (updateStatus.phase === "available" || updateStatus.phase === "ready") && (
              <>
                <span className="wt-eyebrow">Nouveautés de la version {updateStatus.availableRelease.version}</span>
                <ul className="wt-callout__body" style={{ paddingLeft: "var(--space-7)", listStyle: "disc" }}>
                  {updateStatus.availableRelease.notes.map((note: string, index: number) => <li key={`${index}-${note}`}>{note}</li>)}
                </ul>
              </>
            )}
            {updateStatus?.error && (
              <Callout
                tone="danger"
                title={updateStatus.phase === "ready"
                  ? `L'installation n'a pas pu démarrer — Wheat ${updateStatus.currentVersion} n'a pas été modifié`
                  : "Impossible de vérifier les mises à jour"}
              >
                {updateStatus.error}
                {updateStatus.phase === "ready" && " La mise à jour vérifiée reste disponible : vous pouvez réessayer."}
              </Callout>
            )}
            {updateStatus && !updateStatus.automaticInstallationEnabled && (
              <Callout tone="info" title="Installation automatique désactivée">
                En mode développement ou portable, Wheat vérifie et prépare la mise à jour mais ne remplace aucun fichier programme.
              </Callout>
            )}
          </div>
        </Card>

        <Card
          title="A propos et licence"
          note="Wheat est un logiciel libre, utilisable sans abonnement."
          icon={<BadgeCheck size={18} aria-hidden="true" />}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLicenseOpen(true)}>Lire la licence complète</Button>
              {window.wheat?.restartApp && (
                <Button
                  variant="ghost"
                  icon={<RefreshCw size={15} />}
                  onClick={() => {
                    if (confirmWithAppFocus("Redémarrer Wheat maintenant ? Les operations en cours seront terminees proprement.")) void window.wheat?.restartApp();
                  }}
                >
                  Redémarrer l'application
                </Button>
              )}
            </>
          }
        >
          <p className="wt-subtitle">
            Copyright © 2026 Wheat contributors. Logiciel libre sous licence GPL-3.0-or-later : vous pouvez l'utiliser, le partager et le modifier selon les termes de cette licence. Wheat est fourni sans garantie.
          </p>
        </Card>
      </div>

      <Card
        title={labels.activityLogs}
        note="Trace locale des operations effectuees sur ce poste."
        icon={<ListChecks size={18} aria-hidden="true" />}
        flush
      >
        {(data?.activityLogs ?? []).length ? (
          <ul className="wt-list">
            {(data?.activityLogs ?? []).map((log: any) => (
              <li className="wt-list__item" key={log.id}>
                <span className="wt-list__item-text">
                  <strong>{log.action}</strong>
                  <span>{log.description}</span>
                </span>
                <span className="wt-hint wt-num">{date(log.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<ListChecks size={22} aria-hidden="true" />} title="Aucune activité enregistrée" text="Les operations comptables apparaitront ici au fur et a mesure." />
        )}
      </Card>

      {licenseOpen && (
        <Dialog
          title="GNU GPL v3 ou ulterieure"
          note="Licence complète du logiciel Wheat."
          size="lg"
          onClose={() => setLicenseOpen(false)}
          footer={<Button variant="secondary" onClick={() => setLicenseOpen(false)}>Fermer</Button>}
        >
          <pre
            ref={licenseDialogRef as any}
            className="license-text wt-code"
            tabIndex={0}
            aria-label="Texte de la licence GNU GPL"
            style={{ display: "block", whiteSpace: "pre-wrap", padding: "var(--space-5)" }}
          >
            {licenseText}
          </pre>
        </Dialog>
      )}
    </>
  );
}

function BankLedgerMapping({ data, onMap, onCreate }: any) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const company = (data?.companies ?? []).find((item: any) => item.id === data?.activeCompanyId) ?? data?.companies?.[0];
  const banks = data?.bankAccounts ?? [];
  const ledgerAccounts = (company?.accounts ?? []).filter((account: any) => account.active !== false && String(account.code).startsWith("514"));

  if (!banks.length) {
    return (
      <EmptyState
        icon={<Landmark size={22} aria-hidden="true" />}
        title="Aucun compte bancaire dans ce dossier"
        text="Ajoutez un compte bancaire dans Contrôles & imports > Référentiels : c'est lui qui recevra les relevés importés."
      />
    );
  }

  const choose = async (bankAccountId: string, ledgerAccountId: string) => {
    if (!company?.id || !ledgerAccountId) return;
    setBusyId(bankAccountId);
    setError("");
    try {
      await onMap({ companyId: company.id, bankAccountId, ledgerAccountId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Association impossible");
    } finally {
      setBusyId("");
    }
  };

  const create = async (bank: any) => {
    if (!company?.id) return;
    const defaultCode = `514${String(ledgerAccounts.length + 2).padStart(3, "0")}`;
    const code = window.prompt(`Numéro du nouveau sous-compte bancaire pour ${bank.bankName} :`, defaultCode);
    if (!code?.trim()) return;
    const label = window.prompt("Libellé du nouveau compte :", `Banque - ${bank.bankName}`);
    if (!label?.trim()) return;
    setBusyId(bank.id);
    setError("");
    try {
      await onCreate({ companyId: company.id, bankAccountId: bank.id, code: code.trim(), label: label.trim() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Création impossible");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="wt-stack wt-stack--tight">
      {banks.map((bank: any) => {
        const options: WheatSelectOption[] = ledgerAccounts.map((account: any) => {
          const usedElsewhere = banks.some((other: any) => other.id !== bank.id && other.ledgerAccountId === account.id);
          return {
            value: account.id,
            label: `${account.code} — ${account.label}`,
            note: usedElsewhere ? "Déjà associé a une autre banque" : "Disponible",
            disabled: usedElsewhere,
            keywords: account.label,
          };
        });
        return (
          <div className="wt-row" key={bank.id} style={{ alignItems: "flex-end" }}>
            <Field
              label={bank.bankName}
              htmlFor={`bank-ledger-${bank.id}`}
              hint={bank.iban ? `IBAN ${bank.iban}` : "IBAN non renseigné"}
              className="wt-spacer"
            >
              <WheatSelect
                id={`bank-ledger-${bank.id}`}
                options={options}
                value={bank.ledgerAccountId ?? ""}
                onChange={(value) => void choose(bank.id, value)}
                ariaLabel={`Compte comptable de ${bank.bankName}`}
                placeholder="Choisir un compte 514…"
                searchPlaceholder="Numéro ou libellé du compte…"
                disabled={busyId === bank.id || !ledgerAccounts.length}
                noOptionsLabel="Aucun compte 514 dans ce dossier"
              />
            </Field>
            {!bank.ledgerAccountId && (
              <Button variant="secondary" disabled={busyId === bank.id} onClick={() => void create(bank)}>
                Créer un compte 514
              </Button>
            )}
          </div>
        );
      })}
      {error && <Callout tone="danger" title="L'association n'a pas abouti">{error}</Callout>}
    </div>
  );
}

function LocalLockSettings({ status, setup, disable, lock }: any) {
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [idleMinutes, setIdleMinutes] = useState(status?.idleMinutes ?? 15);
  const [lockOnStartup, setLockOnStartup] = useState(status?.lockOnStartup ?? false);
  const [error, setError] = useState("");

  useEffect(() => {
    setIdleMinutes(status?.idleMinutes ?? 15);
    setLockOnStartup(status?.lockOnStartup ?? false);
  }, [status?.idleMinutes, status?.lockOnStartup]);

  const enableOrUpdate = async () => {
    setError("");
    try {
      await setup({ newPin: pin, currentPin: status?.enabled ? currentPin : undefined, idleMinutes, lockOnStartup });
      setPin("");
      setCurrentPin("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Configuration impossible");
    }
  };

  const disableLock = async () => {
    setError("");
    try {
      await disable(currentPin);
      setCurrentPin("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Désactivation impossible");
    }
  };

  const idleOptions: WheatSelectOption[] = [
    { value: "0", label: "Jamais", note: "Aucun verrouillage automatique" },
    { value: "5", label: "5 minutes" },
    { value: "15", label: "15 minutes" },
    { value: "30", label: "30 minutes" },
    { value: "60", label: "1 heure" },
  ];

  return (
    <div className="wt-stack wt-stack--tight">
      <div className="wt-row wt-row--between">
        <span className="wt-list__item-text">
          <strong>Verrou local par code PIN</strong>
          <span>Masque l'application après une période d'inactivite ou au démarrage.</span>
        </span>
        <Badge tone={status?.enabled ? "success" : "neutral"} dot>{status?.enabled ? "Actif" : "Inactif"}</Badge>
      </div>

      <Callout tone="info" title="Ce que ce verrou fait — et ne fait pas">
        Il empeche l'ouverture de l'application sur ce poste. Il <strong>ne chiffré pas</strong> la base comptable ni les documents : une personne ayant accès au disque pourrait toujours les lire. Pour proteger les fichiers eux-memes, utilisez le chiffrement de disque du système.
      </Callout>

      <div className="wt-form-grid">
        {status?.enabled && (
          <Field label="Code PIN actuel" htmlFor="lock-current-pin" required hint="Nécessaire pour changer ou désactiver le verrou.">
            <input id="lock-current-pin" className="wt-input" type="password" autoComplete="current-password" value={currentPin} onChange={(event) => setCurrentPin(event.target.value)} maxLength={64} />
          </Field>
        )}
        <Field label={status?.enabled ? "Nouveau code PIN" : "Code PIN"} htmlFor="lock-new-pin" required hint="6 caracteres minimum.">
          <input id="lock-new-pin" className="wt-input" type="password" autoComplete="new-password" value={pin} onChange={(event) => setPin(event.target.value)} maxLength={64} />
        </Field>
        <Field label="Verrouiller après" htmlFor="lock-idle" hint="Durée d'inactivite avant verrouillage automatique.">
          <WheatSelect
            id="lock-idle"
            options={idleOptions}
            value={String(idleMinutes)}
            onChange={(value) => setIdleMinutes(Number(value))}
            ariaLabel="Delai de verrouillage automatique"
            searchable={false}
          />
        </Field>
        <Field label="Au démarrage" htmlFor="lock-startup">
          <Switch
            checked={lockOnStartup}
            onChange={setLockOnStartup}
            label="Verrouiller à chaque ouverture"
            hint="Le code sera demande à chaque lancement de Wheat."
          />
        </Field>
      </div>

      {error && <Callout tone="danger" title="La configuration n'a pas abouti">{error}</Callout>}

      <div className="wt-row">
        <Button
          variant="primary"
          icon={<Lock size={15} />}
          disabled={pin.length < 6 || (status?.enabled && currentPin.length < 6)}
          onClick={enableOrUpdate}
        >
          {status?.enabled ? "Changer le code PIN" : "Activer le verrou"}
        </Button>
        {status?.enabled && (
          <Button variant="secondary" icon={<Lock size={15} />} onClick={lock}>Verrouiller maintenant</Button>
        )}
        {status?.enabled && (
          <Button variant="danger-outline" disabled={currentPin.length < 6} onClick={disableLock}>Désactiver le verrou</Button>
        )}
      </div>
    </div>
  );
}

function EntryModal({ company, onClose, onCreated, requestReview }: any) {
  const [busy, setBusy] = useState(false);
  const dialogRef = useAccessibleDialog<HTMLFormElement>(() => {
    if (!busy) onClose();
  });
  const defaultJournal = company.journals.find((journal: any) => journal.code === "OD") ?? company.journals[0];
  const [form, setForm] = useState({
    journalId: defaultJournal?.id,
    date: new Date().toISOString().slice(0, 10),
    pieceNumber: "",
    label: "",
  });
  const [piecePreview, setPiecePreview] = useState("");
  // A new line must start on an account an entry can actually use. The first
  // two accounts of the PCGE are class roots: nothing may be posted to them,
  // and offering them as the default made every untouched line wrong.
  const postableAccounts = company.accounts.filter((account: any) => account.active !== false && account.postable !== false);
  const defaultAccountId = (index: number) => (postableAccounts[index] ?? postableAccounts[0] ?? company.accounts[index])?.id;
  const [lines, setLines] = useState([
    { accountId: defaultAccountId(0), label: "", debit: "", credit: "" },
    { accountId: defaultAccountId(1), label: "", debit: "", credit: "" },
  ]);
  const [error, setError] = useState("");
  const selectedJournal = company.journals.find((journal: any) => journal.id === form.journalId) ?? defaultJournal;

  /**
   * A journal entry in progress outlives the dialog it is typed into.
   *
   * Ten minutes of work on a multi-line entry used to end with the Escape key,
   * a misclick outside the modal, or a crash. None of those is somebody saying
   * they wanted the entry thrown away.
   */
  const entryDraft = useDraftedForm<{ form: typeof form; lines: typeof lines }>({
    companyId: company.id,
    entity: "entry",
    draftKey: "new",
    open: true,
    value: { form, lines },
    onRestore: (payload) => {
      if (payload?.form) setForm(payload.form);
      if (Array.isArray(payload?.lines) && payload.lines.length) setLines(payload.lines);
    },
  });

  useEffect(() => {
    let active = true;
    if (!window.wheat?.previewPieceNumber || !form.journalId || !form.date) {
      setPiecePreview(`${selectedJournal?.code ?? "OD"}-${form.date.slice(0, 4)}-000001`);
      return () => { active = false; };
    }
    window.wheat.previewPieceNumber({ companyId: company.id, journalId: form.journalId, date: form.date })
      .then((preview) => { if (active) setPiecePreview(preview.pieceNumber); })
      .catch((reason) => { if (active) setPiecePreview(reason instanceof Error ? reason.message : "Indisponible"); });
    return () => { active = false; };
  }, [company.id, form.date, form.journalId, selectedJournal?.code]);
  const parsedLines = lines.map((line) => ({
    ...line,
    debitCents: tryParseExactDecimalCents(line.debit),
    creditCents: tryParseExactDecimalCents(line.credit),
  }));
  const amountsValid = parsedLines.every((line) => line.debitCents !== null && line.creditCents !== null);
  const debitCents = amountsValid ? parsedLines.reduce((sum, line) => sum + line.debitCents!, 0n) : null;
  const creditCents = amountsValid ? parsedLines.reduce((sum, line) => sum + line.creditCents!, 0n) : null;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setError("");
    if (!form.label.trim()) {
      setError("Le libellé est obligatoire, même pour un brouillon.");
      return;
    }
    if (!amountsValid) {
      setError("Les montants doivent être positifs et contenir au plus deux décimales.");
      return;
    }
    const meaningfulLines = parsedLines.filter((line) => line.debitCents !== 0n || line.creditCents !== 0n);
    if (!meaningfulLines.length) {
      setError("Ajoutez au moins une ligne avec un montant. Un brouillon peut rester déséquilibré.");
      return;
    }
    if (meaningfulLines.some((line) => !line.label.trim())) {
      setError("Ajoutez un libellé à chaque ligne renseignée.");
      return;
    }

    const payload = {
      companyId: company.id,
      journalId: form.journalId,
      date: new Date(form.date).toISOString(),
      pieceNumber: selectedJournal?.allowManualPieceOverride ? form.pieceNumber.trim() : "",
      label: form.label.trim(),
      status: "DRAFT",
      lines: meaningfulLines.map((line) => ({
        accountId: line.accountId,
        label: line.label,
        debit: line.debit,
        credit: line.credit,
      })),
    };

    // The shared review reads the draft exactly as it will be sent, so what
    // it reports is what the accounting service will receive.
    if (requestReview && window.wheat) {
      const approval = await requestReview("entry.create", payload);
      if (!approval.approved) return;
    }

    setBusy(true);
    try {
      if (!window.wheat) {
        await onCreated();
        return;
      }

      await window.wheat.createEntry(payload);
      // Only now: a create that threw leaves the entry on screen and held.
      await entryDraft.clear();
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  const journalOptions: WheatSelectOption[] = company.journals.map((journal: any) => ({
    value: journal.id,
    label: `${journal.code} — ${journal.label}`,
    note: journal.allowManualPieceOverride ? "Numéro de pièce saisi à la main" : "Numéro de pièce attribué automatiquement",
    keywords: journal.label,
  }));
  const accountOptions: WheatSelectOption[] = company.accounts.map((account: any) => ({
    value: account.id,
    label: `${account.code} — ${account.label}`,
    note: `Classe ${account.classNo}`,
    keywords: `${account.label} ${account.code}`,
    group: `Classe ${account.classNo}`,
  }));

  const balanced = debitCents !== null && creditCents !== null && debitCents === creditCents;

  return (
    <Dialog
      title="Nouvelle écriture"
      note="La saisie est enregistrée en brouillon : elle n'a aucun effet comptable tant que vous ne la comptabilisez pas."
      icon={<BookOpen size={18} aria-hidden="true" />}
      size="lg"
      className="entry-modal"
      onClose={() => { if (!busy) onClose(); }}
      footerNote={
        balanced
          ? "Écriture équilibrée : elle pourra être comptabilisée telle quelle."
          : "Un brouillon peut rester desequilibre ; l'équilibre sera exige a la comptabilisation."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" form="entry-form" variant="primary" icon={<Save size={15} />} busy={busy}>
            Enregistrer le brouillon
          </Button>
        </>
      }
    >
      <form id="entry-form" ref={dialogRef} onSubmit={submit} className="wt-stack">
        <div className="wt-form-grid">
          <Field label="Journal" htmlFor="entry-journal" required tip="Le journal regroupe les écritures de même nature : ventes, achats, banque, opérations diverses.">
            <WheatSelect
              id="entry-journal"
              options={journalOptions}
              value={form.journalId}
              onChange={(value) => setForm({ ...form, journalId: value })}
              ariaLabel="Journal"
              searchPlaceholder="Rechercher un journal…"
            />
          </Field>
          <Field label="Date de l'opération" htmlFor="entry-date" required hint="Date à laquelle l'opération a eu lieu, pas la date de saisie.">
            <input id="entry-date" type="date" className="wt-input" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
          </Field>
          <Field
            label="N° de pièce"
            htmlFor="entry-piece"
            tip="Référence du justificatif. Wheat l'attribue automatiquement, sauf si le journal autorise la saisie manuelle."
            hint={selectedJournal?.allowManualPieceOverride ? "Ce journal autorise une référence saisie à la main." : "Attribue automatiquement a l'enregistrement."}
          >
            <input
              id="entry-piece"
              className="wt-input"
              data-autofocus={selectedJournal?.allowManualPieceOverride ? true : undefined}
              value={selectedJournal?.allowManualPieceOverride ? form.pieceNumber : piecePreview}
              readOnly={!selectedJournal?.allowManualPieceOverride}
              onChange={(event) => setForm({ ...form, pieceNumber: event.target.value })}
              placeholder={selectedJournal?.allowManualPieceOverride ? "Référence de la pièce" : piecePreview || "Attribué automatiquement"}
            />
          </Field>
          <Field label="Libellé" htmlFor="entry-label" required hint="Ce que décrit l'opération, en clair. Il apparaît dans tous les états.">
            <input
              id="entry-label"
              className="wt-input"
              data-autofocus={selectedJournal?.allowManualPieceOverride ? undefined : true}
              value={form.label}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
              placeholder="Ex : Facture client mars 2026"
            />
          </Field>
        </div>

        <Explainer>
          Chaque ligne porte un montant au <strong>débit</strong> ou au <strong>crédit</strong>, jamais les deux. Une écriture est <strong>équilibrée</strong> quand le total des débits égale le total des crédits.
        </Explainer>

        <div className="wt-stack wt-stack--tight">
          {lines.map((line, index) => (
            <div className="wt-form-grid" key={index} style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)" }}>
              <Field label={index === 0 ? "Compte" : ""} htmlFor={`entry-line-${index}-account`}>
                <WheatSelect
                  id={`entry-line-${index}-account`}
                  options={accountOptions}
                  value={line.accountId}
                  onChange={(value) => setLines(lines.map((item, position) => position === index ? { ...item, accountId: value } : item))}
                  ariaLabel={`Compte de la ligne ${index + 1}`}
                  searchPlaceholder="Numéro ou libellé du compte…"
                  size="sm"
                />
              </Field>
              <Field label={index === 0 ? "Libellé de ligne" : ""} htmlFor={`entry-line-${index}-label`}>
                <input
                  id={`entry-line-${index}-label`}
                  className="wt-input"
                  aria-label={`Libellé de la ligne ${index + 1}`}
                  value={line.label}
                  onChange={(event) => setLines(lines.map((item, position) => position === index ? { ...item, label: event.target.value } : item))}
                  placeholder="Détail de la ligne"
                />
              </Field>
              <Field label={index === 0 ? "Débit" : ""} htmlFor={`entry-line-${index}-debit`}>
                <input
                  id={`entry-line-${index}-debit`}
                  className="wt-input wt-input--numeric"
                  type="text"
                  inputMode="decimal"
                  aria-label={`Débit de la ligne ${index + 1}`}
                  value={line.debit}
                  onChange={(event) => setLines(lines.map((item, position) => position === index ? { ...item, debit: event.target.value } : item))}
                  placeholder="0,00"
                />
              </Field>
              <Field label={index === 0 ? "Crédit" : ""} htmlFor={`entry-line-${index}-credit`}>
                <input
                  id={`entry-line-${index}-credit`}
                  className="wt-input wt-input--numeric"
                  type="text"
                  inputMode="decimal"
                  aria-label={`Crédit de la ligne ${index + 1}`}
                  value={line.credit}
                  onChange={(event) => setLines(lines.map((item, position) => position === index ? { ...item, credit: event.target.value } : item))}
                  placeholder="0,00"
                />
              </Field>
            </div>
          ))}
        </div>

        <Button
          variant="secondary"
          icon={<Plus size={15} />}
          disabled={busy}
          onClick={() => setLines([...lines, { accountId: defaultAccountId(0), label: "", debit: "", credit: "" }])}
        >
          Ajouter une ligne
        </Button>

        <div className="wt-row wt-row--between modal-total" style={{ padding: "var(--space-5) var(--space-6)", background: "var(--surface-muted)", borderRadius: "var(--radius-md)" }}>
          <span className="wt-num">Débit <strong>{debitCents === null ? "montant invalide" : formatExactCentsForUi(debitCents)}</strong></span>
          <span className="wt-num">Crédit <strong>{creditCents === null ? "montant invalide" : formatExactCentsForUi(creditCents)}</strong></span>
          <Badge tone={balanced ? "success" : debitCents === null || creditCents === null ? "danger" : "warning"} dot>
            {balanced
              ? "Équilibrée"
              : debitCents === null || creditCents === null
                ? "Montant invalide"
                : `Écart de ${formatExactCentsForUi(debitCents - creditCents)}`}
          </Badge>
        </div>

        {error && <Callout tone="danger" title="La saisie n'a pas été enregistrée">{error}</Callout>}
      </form>
    </Dialog>
  );
}

/**
 * The dossier's own identity, edited where it was asked for.
 *
 * Guided work asks for the ICE, the tax identifier, the legal form and the city
 * because Moroccan invoices must carry them. It used to answer that request by
 * navigating to the settings tab, which is a different screen with a different
 * purpose and no memory of what was being asked — so the person arrived, found
 * a referentials workspace, and had lost the step they were on.
 *
 * This writes through the same company service as the referentials form: the
 * same validation, the same optimistic version check, the same audit entry. It
 * is a second surface onto one operation, not a second implementation of it.
 */
function CompanyIdentityDialog({ company, onClose, onSaved, notify, requestReview }: any) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useAccessibleDialog<HTMLFormElement>(() => { if (!busy) onClose(); });
  const [form, setForm] = useState({
    name: String(company?.name ?? ""),
    legalForm: String(company?.legalForm ?? ""),
    ice: String(company?.ice ?? ""),
    taxId: String(company?.taxId ?? ""),
    city: String(company?.city ?? ""),
    vatFrequency: company?.vatFrequency === "QUARTERLY" ? "QUARTERLY" : "MONTHLY",
  });

  // What guided work is still waiting for, named field by field rather than as
  // a single "identity incomplete".
  const missing = [
    !form.name.trim() && "la raison sociale",
    !form.legalForm.trim() && "la forme juridique",
    !form.city.trim() && "la ville",
    !form.ice.trim() && "l'ICE",
    !form.taxId.trim() && "l'identifiant fiscal",
  ].filter(Boolean) as string[];

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setError("");
    if (!window.wheat?.updateCompanySettings) {
      setError("L'enregistrement de l'identité n'est disponible que dans l'application Wheat.");
      return;
    }
    const payload = {
      companyId: company.id,
      expectedVersion: company.version ?? 1,
      ...form,
    };
    setBusy(true);
    try {
      if (requestReview && !(await requestReview("company.update", payload)).approved) return;
      await window.wheat.updateCompanySettings(payload);
      notify?.("Identité du dossier enregistrée.", "success");
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const vatOptions: WheatSelectOption[] = [
    { value: "MONTHLY", label: "Mensuelle", note: "Déclaration chaque mois" },
    { value: "QUARTERLY", label: "Trimestrielle", note: "Déclaration tous les trois mois" },
  ];

  return (
    <Dialog
      title="Identité du dossier"
      note="L'ICE, l'identifiant fiscal, la forme juridique et la ville sont des mentions obligatoires des factures marocaines."
      icon={<Building2 size={18} aria-hidden="true" />}
      onClose={() => { if (!busy) onClose(); }}
      footerNote="Vous revenez au travail guidé après l'enregistrement."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" form="dossier-identity-form" variant="primary" icon={<CheckCircle2 size={15} />} busy={busy}>
            Enregistrer l'identité
          </Button>
        </>
      }
    >
      <form id="dossier-identity-form" ref={dialogRef} onSubmit={submit} className="wt-stack">
        {missing.length > 0 && (
          <Callout tone="info" title="Ce qui manque encore">
            Wheat attend {missing.join(", ")}.
          </Callout>
        )}
        <div className="wt-form-grid">
          <Field label="Raison sociale" htmlFor="identity-name" required className="wt-span-all" hint="Telle qu'elle figure sur les documents officiels.">
            <input id="identity-name" className="wt-input" data-autofocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          </Field>
          <Field label="Forme juridique" htmlFor="identity-legal" required hint="SARL, SA, SNC, auto-entrepreneur…">
            <input id="identity-legal" className="wt-input" value={form.legalForm} onChange={(event) => setForm((current) => ({ ...current, legalForm: event.target.value }))} />
          </Field>
          <Field label="Ville" htmlFor="identity-city" required>
            <input id="identity-city" className="wt-input" value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} />
          </Field>
          <Field label="ICE" htmlFor="identity-ice" tip="Identifiant Commun de l'Entreprise : le numéro à 15 chiffres obligatoire sur les factures marocaines." hint="15 chiffres exactement.">
            <input id="identity-ice" className="wt-input" inputMode="numeric" maxLength={15} value={form.ice} onChange={(event) => setForm((current) => ({ ...current, ice: event.target.value.replace(/\D/g, "").slice(0, 15) }))} />
          </Field>
          <Field label="Identifiant fiscal" htmlFor="identity-tax" tip="Le numéro attribué par la Direction Générale des Impôts, utilisé sur les déclarations.">
            <input id="identity-tax" className="wt-input" value={form.taxId} onChange={(event) => setForm((current) => ({ ...current, taxId: event.target.value }))} />
          </Field>
          <Field label="Périodicité de la TVA" htmlFor="identity-vat" required>
            <WheatSelect
              id="identity-vat"
              options={vatOptions}
              value={form.vatFrequency}
              onChange={(value) => setForm((current) => ({ ...current, vatFrequency: value as "MONTHLY" | "QUARTERLY" }))}
              ariaLabel="Périodicité de la TVA"
              searchable={false}
            />
          </Field>
        </div>
        {error && <Callout tone="danger" title="L'identité n'a pas été enregistrée">{error}</Callout>}
      </form>
    </Dialog>
  );
}

function CompanyModal({ onClose, onCreate }: any) {
  const [busy, setBusy] = useState(false);
  const dialogRef = useAccessibleDialog<HTMLFormElement>(() => {
    if (!busy) onClose();
  });
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({
    name: "",
    legalForm: "SARL",
    ice: "",
    taxId: "",
    city: "Casablanca",
    fiscalYear: currentYear,
    vatFrequency: "MONTHLY" as "MONTHLY" | "QUARTERLY",
  });
  const [error, setError] = useState("");

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setError("");
    if (!form.name.trim()) {
      setError("Le nom de la société est obligatoire.");
      return;
    }
    setBusy(true);
    try {
      await onCreate(form);
    } finally {
      setBusy(false);
    }
  };

  const yearOptions: WheatSelectOption[] = [currentYear - 1, currentYear, currentYear + 1].map((year) => ({
    value: String(year),
    label: String(year),
    note: year === currentYear ? "Exercice en cours" : year < currentYear ? "Exercice précédent" : "Exercice suivant",
  }));
  const vatOptions: WheatSelectOption[] = [
    { value: "MONTHLY", label: "Mensuelle", note: "Declaration chaque mois" },
    { value: "QUARTERLY", label: "Trimestrielle", note: "Declaration tous les trois mois" },
  ];

  return (
    <Dialog
      title="Créer un dossier"
      note="Un dossier représente une société. Wheat y installé le plan comptable marocain (PCGE), les journaux usuels et l'exercice choisi."
      icon={<Building2 size={18} aria-hidden="true" />}
      onClose={() => { if (!busy) onClose(); }}
      footerNote="Vous pourrez modifier ces informations plus tard dans Contrôles & imports > Référentiels."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" form="company-form" variant="primary" icon={<CheckCircle2 size={15} />} busy={busy}>
            Créer le dossier
          </Button>
        </>
      }
    >
      <form id="company-form" ref={dialogRef} onSubmit={submit} className="wt-stack">
        <div className="wt-form-grid">
          <Field label="Nom de la société" htmlFor="company-name" required className="wt-span-all" hint="Tel qu'il figure sur les documents officiels.">
            <input
              id="company-name"
              className="wt-input"
              data-autofocus
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Ex : EL AMANA SARL"
            />
          </Field>
          <Field label="Forme juridique" htmlFor="company-legal" hint="SARL, SA, SNC, auto-entrepreneur…">
            <input id="company-legal" className="wt-input" value={form.legalForm} onChange={(event) => setForm((current) => ({ ...current, legalForm: event.target.value }))} />
          </Field>
          <Field label="Ville" htmlFor="company-city">
            <input id="company-city" className="wt-input" value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} />
          </Field>
          <Field label="ICE" htmlFor="company-ice" optional tip="Identifiant Commun de l'Entreprise : le numéro a 15 chiffres obligatoire sur les factures marocaines.">
            <input id="company-ice" className="wt-input" value={form.ice} onChange={(event) => setForm((current) => ({ ...current, ice: event.target.value }))} placeholder="15 chiffres" />
          </Field>
          <Field label="Identifiant fiscal" htmlFor="company-tax" optional tip="Le numéro attribué par la Direction Générale des Impôts, utilisé sur les déclarations.">
            <input id="company-tax" className="wt-input" value={form.taxId} onChange={(event) => setForm((current) => ({ ...current, taxId: event.target.value }))} />
          </Field>
          <Field label="Exercice comptable" htmlFor="company-year" required hint="La période de douze mois sur laquelle le résultat est calculé.">
            <WheatSelect
              id="company-year"
              options={yearOptions}
              value={String(form.fiscalYear)}
              onChange={(value) => setForm((current) => ({ ...current, fiscalYear: Number(value) }))}
              ariaLabel="Exercice comptable"
              searchable={false}
            />
          </Field>
          <Field label="Périodicité de la TVA" htmlFor="company-vat" required tip="Le rythme auquel la société declare sa TVA. Il depend du chiffré d'affaires et figure sur l'attestation fiscale.">
            <WheatSelect
              id="company-vat"
              options={vatOptions}
              value={form.vatFrequency}
              onChange={(value) => setForm((current) => ({ ...current, vatFrequency: value as "MONTHLY" | "QUARTERLY" }))}
              ariaLabel="Périodicité de la TVA"
              searchable={false}
            />
          </Field>
        </div>

        {error && <Callout tone="danger" title="Le dossier n'a pas été créé">{error}</Callout>}
      </form>
    </Dialog>
  );
}

/**
 * Command palette (Ctrl+K).
 *
 * A shortcut, never the only path: every destination it lists also has a
 * visible entry in the navigation rail, and every action a visible button.
 */
function CommandPalette({ open, onClose, setPage, openEntryModal, setCompanyModalOpen, createBackup, language }: any) {
  const copy = shellCopy[language as AppLanguage] ?? shellCopy.fr;
  const labels = pageCopy[language as AppLanguage] ?? pageCopy.fr;
  const [commandQuery, setCommandQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useAccessibleDialog<HTMLDivElement>(onClose, open);
  const listRef = useRef<HTMLDivElement>(null);

  const navigationActions = navItems.map((item) => ({
    group: "Aller a",
    label: navLabel(item.page, language),
    hint: pageShortHelp[item.page],
    icon: item.icon,
    run: () => setPage(item.page),
  }));

  const quickActions = [
    { group: "Actions", label: copy.newEntry, hint: "Créer un brouillon d'écriture", icon: Plus, run: openEntryModal },
    { group: "Actions", label: copy.newCompany, hint: "Ouvrir un nouveau dossier", icon: Building2, run: () => setCompanyModalOpen(true) },
    { group: "Actions", label: labels.documentCommand ?? pageCopy.fr.documentCommand, hint: "Importer une pièce a lire", icon: FileUp, run: () => setPage("documents") },
    { group: "Actions", label: labels.vatDeclaration ?? pageCopy.fr.vatDeclaration, hint: "Preparer la déclaration", icon: Percent, run: () => setPage("vat") },
    { group: "Actions", label: labels.createBackupCommand ?? pageCopy.fr.createBackupCommand, hint: "Copier la base comptable", icon: DatabaseBackup, run: createBackup },
  ];

  const actions = [...quickActions, ...navigationActions];
  const needle = commandQuery.trim().toLocaleLowerCase("fr-FR");
  const visibleActions = needle
    ? actions.filter((action) => `${action.label} ${action.hint}`.toLocaleLowerCase("fr-FR").includes(needle))
    : actions;

  useEffect(() => {
    if (open) {
      setCommandQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  /*
   * The arrow keys move a selection the pointer never touched, so nothing
   * scrolls on its own. Without this the highlight walks past the bottom of
   * the list and the person is choosing a command they cannot see.
   */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, commandQuery]);

  if (!open) return null;

  const run = (index: number) => {
    const action = visibleActions[index];
    if (!action) return;
    action.run();
    onClose();
  };

  let lastGroup = "";

  return (
    <div className="wt-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <motion.div
        ref={dialogRef}
        className="wt-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Palette de commandes"
        tabIndex={-1}
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="wt-palette__search">
          <Command size={18} aria-hidden="true" />
          <input
            data-autofocus
            value={commandQuery}
            aria-label={labels.commandPlaceholder ?? pageCopy.fr.commandPlaceholder}
            aria-controls="wt-palette-list"
            onChange={(event) => {
              setCommandQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % Math.max(1, visibleActions.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => (current - 1 + visibleActions.length) % Math.max(1, visibleActions.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(activeIndex);
              }
            }}
            placeholder={labels.commandPlaceholder ?? pageCopy.fr.commandPlaceholder}
          />
        </div>

        <div ref={listRef} className="wt-palette__list" id="wt-palette-list" role="listbox" aria-label="Commandes disponibles">
          {visibleActions.map((action, index) => {
            const Icon = action.icon;
            const showGroup = action.group !== lastGroup;
            lastGroup = action.group;
            return (
              <div key={`${action.group}-${action.label}`}>
                {showGroup && <div className="wt-palette__group-label">{action.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "wt-palette__item is-active" : "wt-palette__item"}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(index)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span className="wt-palette__item-text">
                    <strong>{action.label}</strong>
                    <span>{action.hint}</span>
                  </span>
                </button>
              </div>
            );
          })}
          {!visibleActions.length && (
            <EmptyState
              icon={<Search size={22} aria-hidden="true" />}
              title="Aucune commande ne correspond"
              text={`Rien ne correspond a « ${commandQuery} ». Toutes les fonctions restent accessibles depuis le menu de gauche.`}
            />
          )}
        </div>

        <div className="wt-palette__foot">
          <span><span className="wt-kbd">↑</span> <span className="wt-kbd">↓</span> naviguer</span>
          <span><span className="wt-kbd">Entrée</span> ouvrir</span>
          <span><span className="wt-kbd">Echap</span> fermer</span>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * What Wheat is working on, while it works on it.
 *
 * Deliberately a label and an indeterminate indicator, never a percentage:
 * none of the operations that use this reports how far along it is, and a bar
 * that fills at a rate nobody measured is a lie that people plan around. It is
 * a `status` region rather than an `alert` — this is not an interruption, and
 * it must not steal focus from whatever somebody is typing.
 */
function RunningTaskBanner({ label }: { label: string }) {
  return (
    <div className="wt-running-task" role="status" aria-live="polite">
      <AnimatePresence>
        {label && (
          <motion.div
            className="wt-running-task__body"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <LoaderCircle size={15} className="wt-running-task__spin" aria-hidden="true" />
            <span>{label}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToastStack({ toasts }: { toasts: Toast[] }) {
  const icon = (tone: Toast["tone"]) =>
    tone === "success" ? <CheckCircle2 size={17} aria-hidden="true" /> : tone === "warning" ? <AlertTriangle size={17} aria-hidden="true" /> : <HelpCircle size={17} aria-hidden="true" />;
  return (
    <div className="wt-toasts toast-stack" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`wt-toast toast wt-toast--${toast.tone}`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
          >
            {icon(toast.tone)}
            <span>{toast.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Startup screen. It names the step in progress so a slow first launch never
 * looks like a freeze.
 */
function LoadingShell() {
  const steps = [
    "Ouverture de la base comptable locale",
    "Vérification de l'intégrité des écritures",
    "Preparation de l'espace de travail",
  ];
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setStep((current) => Math.min(current + 1, steps.length - 1)), 900);
    return () => window.clearInterval(timer);
  }, [steps.length]);

  return (
    <div className="wt-fullscreen">
      <div className="wt-boot">
        <WheatMark size={72} className="wt-boot__mark" />
        <span className="wt-boot__title wheat-wordmark">Wheat</span>
        <span className="wt-rail__brand-note">{WHEAT_RELEASE_LABEL}</span>
        <div className="wt-boot__steps" role="status" aria-live="polite">
          <span>{steps[step]}…</span>
        </div>
        <div className="wt-progress wt-boot__bar">
          <div className="wt-progress__bar" style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
        </div>
        <span className="wt-hint">Vos données restent sur cet ordinateur.</span>
      </div>
    </div>
  );
}

function buildBalanceRows(entries: any[]) {
  const map = new Map<string, any>();
  for (const entry of ledgerEntries(entries)) {
    for (const line of entry.lines) {
      const key = line.account?.code ?? line.accountId;
      const previous = map.get(key) ?? { Compte: key, Libellé: line.account?.label ?? line.label, Débit: 0, Crédit: 0, Solde: 0 };
      previous.Débit += parseMoneyValue(line.debit);
      previous.Crédit += parseMoneyValue(line.credit);
      previous.Solde = previous.Débit - previous.Crédit;
      map.set(key, previous);
    }
  }
  return [...map.values()].sort((a, b) => a.Compte.localeCompare(b.Compte));
}

function collectBankMovements(data: any) {
  return (data?.bankAccounts ?? []).flatMap((account: any) =>
    (account.movements ?? []).map((movement: any) => ({
      ...movement,
      bankName: account.bankName,
      iban: account.iban,
    })),
  );
}

function buildDelayDeclarationRows(invoices: any[]) {
  return invoices.map((invoice) => {
    const delayDays = invoice.paymentDate ? Math.max(0, daysBetween(invoice.dueDate, invoice.paymentDate)) : Math.max(0, daysBetween(invoice.dueDate));
    return {
      Date: date(invoice.invoiceDate ?? invoice.date ?? new Date()),
      Tiers: invoice.counterparty,
      Reference: invoice.number,
      Échéance: date(invoice.dueDate),
      Paiement: invoice.paymentDate ? date(invoice.paymentDate) : "",
      "Jours de retard": delayDays,
      HT: invoice.ht,
      TVA: invoice.vat,
      TTC: invoice.ttc,
      Statut: statusLabel(invoice.status),
    };
  });
}

const smartTypeOptions = [
  { value: "INVOICE", label: "Factures" },
  { value: "BANK_STATEMENT", label: "Relevés bancaires" },
  { value: "RECEIPT", label: "Recus" },
  { value: "CONTRACT", label: "Contrats" },
  { value: "PAYROLL", label: "Paie" },
  { value: "IDENTITY", label: "Identité" },
  { value: "TAX", label: "Fiscal" },
  { value: "LETTER", label: "Courriers" },
  { value: "TABLE", label: "Tableaux" },
  { value: "UNKNOWN", label: "Inconnus" },
];


function makeScanPreview(filePath?: string, title?: string) {
  const safePath = String(filePath ?? "");
  const name = title || safePath.split(/[\\/]/).filter(Boolean).pop() || "Document";
  const extension = (name.includes(".") ? (name.split(".").pop() ?? "") : (safePath.split(".").pop() ?? "")).toLowerCase();
  return {
    name,
    path: safePath,
    extension,
    image: ["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(extension),
    spreadsheet: ["xlsx", "xls", "csv"].includes(extension),
  };
}

function fileUrlFromPath(filePath: string) {
  if (!filePath) return "";
  return `file:///${filePath.replace(/\\/g, "/").split("/").map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join("/")}`;
}

/**
 * The document itself, beside the values Wheat read from it.
 *
 * Checking an extraction is a comparison, and a comparison needs both things in
 * view. Wheat used to show a stylised paper icon where the document should be
 * and leave the person to open the real file in another application — at which
 * point the comparison stops happening, because the two halves are no longer on
 * the same screen.
 *
 * Pages arrive from the main process as image bytes, which is what the content
 * policy permits and, more to the point, what keeps the renderer from being
 * able to load arbitrary local paths. Rendering is a read: paging and zooming
 * cannot re-run recognition, and a correction in progress is untouched by
 * either. A file Wheat cannot draw says so plainly instead of showing an empty
 * frame — the fields on the right stay editable either way.
 */
function DocumentSourceViewer({ documentId, companyId, title }: { documentId: string; companyId?: string; title?: string }) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState<{ page: number; pageCount: number; mimeType: string; base64: string; rendered: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const requestId = useRef(0);

  useEffect(() => { setPage(1); setZoom(1); setPreview(null); setFailure(""); }, [documentId]);

  useEffect(() => {
    if (!documentId || !window.wheat?.getDocumentPagePreview) return;
    const mine = ++requestId.current;
    setLoading(true);
    setFailure("");
    window.wheat.getDocumentPagePreview({ documentId, companyId, page, scale: 1.5 })
      .then((result) => { if (requestId.current === mine) setPreview(result); })
      .catch((error) => { if (requestId.current === mine) setFailure(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (requestId.current === mine) setLoading(false); });
  }, [documentId, companyId, page]);

  const pageCount = preview?.pageCount ?? 0;
  const reason = failure || (preview && !preview.rendered ? preview.reason : "");

  return (
    <div className="ocr-source" data-testid="ocr-source-viewer">
      <div className="ocr-source__bar">
        <span className="ocr-source__title" title={title}>{title || "Document d'origine"}</span>
        <span className="ocr-source__controls">
          <IconButton label="Page précédente" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            <ChevronLeft size={15} aria-hidden="true" />
          </IconButton>
          <span className="wt-hint wt-num" data-testid="ocr-source-page">{pageCount ? `Page ${preview?.page ?? page} / ${pageCount}` : `Page ${page}`}</span>
          <IconButton label="Page suivante" size="sm" disabled={loading || (pageCount > 0 && page >= pageCount)} onClick={() => setPage((current) => current + 1)}>
            <ChevronRight size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Réduire" size="sm" disabled={zoom <= 0.5} onClick={() => setZoom((current) => Math.max(0.5, Math.round((current - 0.25) * 100) / 100))}>
            <Minus size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Ajuster à la largeur" size="sm" onClick={() => setZoom(1)}>
            <Maximize2 size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Agrandir" size="sm" disabled={zoom >= 3} onClick={() => setZoom((current) => Math.min(3, Math.round((current + 0.25) * 100) / 100))}>
            <Plus size={15} aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      <div className="ocr-source__stage">
        {loading && !preview && <LoadingState label="Rendu de la page…" />}
        {reason ? (
          <Callout tone="info" title="Aperçu indisponible">{reason}</Callout>
        ) : preview?.rendered ? (
          <img
            className="ocr-source__page"
            style={{ width: `${zoom * 100}%` }}
            src={`data:${preview.mimeType};base64,${preview.base64}`}
            alt={`Page ${preview.page} de ${title || "la pièce"}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function DocumentScanPreview({ preview, busy, compact = false }: any) {
  if (!preview) return null;
  return (
    <div className={compact ? "scan-preview compact" : "scan-preview"}>
      <div className="scan-stage">
        <div className={preview.image ? "scan-document image-doc" : "scan-document"}>
          {preview.image ? (
            <img src={fileUrlFromPath(preview.path)} alt="" />
          ) : (
            <div className="scan-paper">
              <span>{preview.spreadsheet ? "XLSX" : preview.extension?.toUpperCase() || "PDF"}</span>
              <i />
              <i />
              <i />
              <b />
              <i />
              <i />
            </div>
          )}
          <div className="scan-target target-a" />
          <div className="scan-target target-b" />
          <div className="scan-target target-c" />
          {busy && <div className="scan-sweep" />}
        </div>
      </div>
      <div className="scan-caption">
        <strong>{preview.name}</strong>
        <span>{busy ? "Lecture du document en cours" : "Aperçu du document"}</span>
      </div>
    </div>
  );
}

function MiniTable({ rows }: { rows: any[] }) {
  const preview = Array.isArray(rows) ? rows.slice(0, 6) : [];
  if (!preview.length) return <p className="muted-note">Aucune table fiable détectée.</p>;
  return (
    <div className="mini-table">
      {preview.map((row, rowIndex) => {
        const cells = Array.isArray(row) ? row : Object.values(row);
        return (
          <div key={rowIndex}>
            {cells.slice(0, 6).map((cell, cellIndex) => <span key={cellIndex}>{String(cell ?? "")}</span>)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Why the extraction landed where it did.
 *
 * When a field comes out wrong there are exactly two possibilities, and they
 * need opposite fixes: the recogniser misread the page, or it read it correctly
 * and Wheat mapped the reading to the wrong field. Answering that used to mean
 * re-running the document by hand. Everything needed to answer it is recorded
 * during extraction and shown here — the readings that were rejected and why,
 * the arithmetic each candidate satisfied, and how each party was identified.
 *
 * It stays collapsed: an accountant correcting a supplier name never has to
 * open it, and the person diagnosing a bad extraction always can.
 */
function OcrDiagnostics({ extracted }: { extracted: any }) {
  const diagnostics = extracted?.diagnostics ?? null;
  const checks: any[] = extracted?.accountingChecks ?? [];
  const parties = extracted?.parties ?? null;
  if (!diagnostics && !checks.length && !parties) return null;

  const candidates: any[] = diagnostics?.candidates ?? [];
  const alternatives: any[] = diagnostics?.totalsAlternatives ?? [];
  const elements: any[] = diagnostics?.recognizedElements ?? [];

  return (
    <HelpDisclosure summary="Diagnostic d'extraction (avancé)">
      <div className="wt-stack">
        <p className="muted-note">
          Ce panneau montre ce que le moteur a lu, ce qu'il a retenu, et ce qu'il a écarté. Il sert à distinguer une
          erreur de reconnaissance d'une erreur d'interprétation.
        </p>

        {parties && (
          <div>
            <p className="muted-note"><strong>PARTIES IDENTIFIÉES</strong></p>
            {(["issuer", "recipient"] as const).map((role) => {
              const party = parties[role];
              if (!party) return null;
              return (
                <div key={role} className="mini-table">
                  <div>
                    <span>{role === "issuer" ? "Émetteur" : "Destinataire"}</span>
                    <span>{party.name ?? "—"}</span>
                    <span>ICE {party.ice ?? "—"}</span>
                    <span>IF {party.taxId ?? "—"}</span>
                    <span>{party.nameSource}</span>
                  </div>
                  {(party.reasons ?? []).slice(0, 4).map((reason: string, index: number) => (
                    <div key={index}><span>{reason}</span></div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {checks.length > 0 && (
          <div>
            <p className="muted-note"><strong>CONTRÔLES COMPTABLES</strong></p>
            <div className="mini-table">
              {checks.map((check, index) => (
                <div key={index}>
                  <span>{check.status}</span>
                  <span>{check.label}</span>
                  <span>{check.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {alternatives.length > 0 && (
          <div>
            <p className="muted-note"><strong>
              LECTURES DES TOTAUX — retenue : {String(diagnostics?.totalsStrategy ?? "—")} ({String(diagnostics?.accountingScore ?? 0)} / 100)
            </strong></p>
            <div className="mini-table">
              {alternatives.map((alternative, index) => (
                <div key={index}>
                  <span>{alternative.strategy}</span>
                  <span>{alternative.consistent ? "cohérente" : "incohérente"}</span>
                  <span>{alternative.score}/100</span>
                  <span>{JSON.stringify(alternative.assignment)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {candidates.length > 0 && (
          <div>
            <p className="muted-note"><strong>CANDIDATS PAR CHAMP</strong></p>
            <div className="mini-table">
              {candidates.slice(0, 40).map((candidate, index) => (
                <div key={index}>
                  <span>{candidate.accepted ? "retenu" : "écarté"}</span>
                  <span>{candidate.field}</span>
                  <span>{candidate.value || "—"}</span>
                  <span>{candidate.source}</span>
                  <span>{candidate.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {elements.length > 0 && (
          <div>
            <p className="muted-note"><strong>ÉLÉMENTS RECONNUS (texte, confiance, position)</strong></p>
            <pre tabIndex={0} aria-label="Éléments OCR avec coordonnées" className="wt-code" style={{ display: "block", whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", padding: "var(--space-5)" }}>
              {elements.slice(0, 200).map((element) => {
                const box = element.bbox
                  ? `[${Math.round(element.bbox.x0)},${Math.round(element.bbox.y0)},${Math.round(element.bbox.x1)},${Math.round(element.bbox.y1)}]`
                  : "[sans coordonnées]";
                return `p${element.page} ${String(element.confidence).padStart(3)}% ${box} ${element.text}`;
              }).join("\n")}
            </pre>
          </div>
        )}
      </div>
    </HelpDisclosure>
  );
}




function smartTypeLabel(type: string, fallback: string) {
  return smartTypeOptions.find((item) => item.value === type)?.label ?? fallback ?? "Document";
}

function readSmartConfidence(extracted: any) {
  const value = Number(extracted?.confidence ?? extracted?.ocrConfidence ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 40;
}

function smartOcrStatusMeta(status: string, uncertainFields: unknown[], copy: Record<string, string>) {
  if (status === "POSTED") return { label: copy.ocrPosted ?? "Comptabilisé", tone: "success" };
  if (status === "TO_REVIEW" || uncertainFields.length > 0) return { label: copy.ocrNeedsReview ?? "A vérifier", tone: "warning" };
  return { label: copy.ocrDone ?? "Termine", tone: "success" };
}

function buildSmartOcrStats(documents: any[]) {
  const confidences = documents.map((doc) => readSmartConfidence(safeJson(doc.extracted))).filter(Boolean);
  const needsReview = documents.filter((doc) => doc.status === "TO_REVIEW" || (safeJson(doc.extracted).uncertainFields ?? []).length).length;
  const duplicates = documents.filter((doc) => (safeJson(doc.extracted).duplicateIds ?? []).length).length;
  return {
    averageConfidence: confidences.length ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length) : 0,
    needsReview,
    duplicates,
  };
}

async function buildSmartOcrWorkbook(documents: any[], companyName: string) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Wheat Smart OCR";
  workbook.created = new Date();

  const summaries = buildSmartOcrRows(documents, companyName);

  addSmartSheet(workbook, "Summary", summaries);
  addSmartSheet(workbook, "Invoices", documents.filter((doc) => readSmartType(safeJson(doc.extracted), doc.type) === "INVOICE").map((doc) => {
    const fields = readSmartFields(safeJson(doc.extracted));
    return {
      Date: fields.date,
      Supplier: fields.supplier || fields.counterparty,
      IF: fields.if,
      ICE: fields.ice,
      HT: numberOrBlank(fields.ht),
      TVA: numberOrBlank(fields.tva),
      TTC: numberOrBlank(fields.ttc),
      Ref: fields.reference || fields.invoiceNumber,
      Confidence: readSmartConfidence(safeJson(doc.extracted)),
    };
  }));

  addSmartSheet(workbook, "Bank statements", documents.flatMap((doc) => {
    const extracted = safeJson(doc.extracted);
    return (extracted.bankTransactions ?? []).map((row: any) => ({
      Document: doc.title,
      Date: row.Date,
      Description: row.Description,
      Debit: numberOrBlank(row.Debit),
      Credit: numberOrBlank(row.Credit),
      Balance: numberOrBlank(row.Balance),
    }));
  }));

  addSmartSheet(workbook, "Payroll", documents.filter((doc) => readSmartType(safeJson(doc.extracted), doc.type) === "PAYROLL").map((doc) => {
    const fields = readSmartFields(safeJson(doc.extracted));
    return {
      Employee: fields.employee || fields.counterparty,
      Gross: numberOrBlank(fields.gross),
      CNSS: numberOrBlank(fields.cnss),
      AMO: numberOrBlank(fields.amo),
      IR: numberOrBlank(fields.ir),
      Net: numberOrBlank(fields.net),
      Document: doc.title,
    };
  }));

  addSmartSheet(workbook, "Detected tables", documents.flatMap((doc) => {
    const extracted = safeJson(doc.extracted);
    return (extracted.tableRows ?? []).map((row: any, index: number) => {
      const cells = Array.isArray(row) ? row : Object.values(row);
      return Object.fromEntries([
        ["Document", doc.title],
        ["Row", index + 1],
        ...cells.slice(0, 20).map((cell: unknown, cellIndex: number) => [`Column ${cellIndex + 1}`, cell]),
      ]);
    });
  }));

  addSmartSheet(workbook, "Free text index", documents.map((doc) => ({
    Document: doc.title,
    Type: doc.type,
    Text: String(doc.ocrText ?? "").slice(0, 32000),
  })));

  return workbook;
}

function buildSmartOcrRows(documents: any[], companyName: string) {
  return documents.map((doc) => {
    const extracted = safeJson(doc.extracted);
    const fields = readSmartFields(extracted);
    return {
      Company: companyName,
      Title: doc.title,
      Type: smartTypeLabel(readSmartType(extracted, doc.type), doc.type),
      Date: fields.date,
      Counterparty: fields.counterparty || fields.supplier || fields.client,
      IF: fields.if,
      ICE: fields.ice,
      HT: numberOrBlank(fields.ht),
      TVA: numberOrBlank(fields.tva),
      TTC: numberOrBlank(fields.ttc),
      Currency: fields.currency || "MAD",
      Confidence: readSmartConfidence(extracted),
      Status: doc.status,
      OrganizedPath: extracted.organizedPath ?? doc.storedPath,
    };
  });
}

function addSmartSheet(workbook: import("exceljs").Workbook, name: string, rows: Array<Record<string, any>>) {
  const worksheet = workbook.addWorksheet(name.slice(0, 31));
  const data: Array<Record<string, any>> = rows.length ? rows : [{ Message: "No data" }];
  const headers = Array.from(data.reduce<Set<string>>((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  worksheet.addRow(headers);
  data.forEach((row) => worksheet.addRow(headers.map((header) => row[header] ?? "")));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns.forEach((column) => {
    column.width = Math.min(34, Math.max(14, String(column.header ?? "").length + 6));
  });
  headers.forEach((header, index) => {
    if (["HT", "TVA", "TTC", "Debit", "Credit", "Balance", "Gross", "CNSS", "AMO", "IR", "Net"].includes(header)) {
      worksheet.getColumn(index + 1).numFmt = '#,##0.00 "MAD"';
    }
    if (header.toLowerCase().includes("date")) {
      worksheet.getColumn(index + 1).numFmt = "yyyy-mm-dd";
    }
  });
}

function numberOrBlank(value: unknown) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined || value === "") return "";
  const parsed = parseMoneyValue(value);
  return Number.isFinite(parsed) ? parsed : "";
}

function rowsToCsv(rows: Array<Record<string, unknown>>) {
  const data = rows.length ? rows : [{ Message: "No data" }];
  const headers = Array.from(data.reduce<Set<string>>((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));
  return [
    headers.join(","),
    ...data.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function detectDelimitedSeparator(text: string) {
  const counts = new Map([[";", 0], [",", 0], ["\t", 0]]);
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\r" || char === "\n")) break;
    if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ";";
}

function parseDelimitedRows(text: string) {
  const separator = detectDelimitedSeparator(text);
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const finishCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const finishRow = () => {
    finishCell();
    if (row.some((value) => value !== "")) table.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && char === separator) finishCell();
    else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else cell += char;
  }
  if (cell || row.length) finishRow();
  if (quoted) throw new Error("Le fichier CSV contient un champ entre guillemets non fermé.");
  return table;
}

function uniqueImportHeaders(values: unknown[]) {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value ?? "").replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

async function sha256Base64(bytesBase64: string) {
  const bytes = bytesFromBase64(bytesBase64);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readImportRows(file: { extension: string; bytesBase64: string }) {
  if (file.extension === ".csv") {
    const text = textFromBase64(file.bytesBase64);
    const [headerRow = [], ...dataRows] = parseDelimitedRows(text);
    const headers = uniqueImportHeaders(headerRow);
    return dataRows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytesFromBase64(file.bytesBase64).buffer as ArrayBuffer);
  const worksheet = workbook.worksheets[0];
  let headers: string[] = [];
  const rows: Record<string, unknown>[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const width = Math.max(worksheet.columnCount, row.cellCount, headers.length);
    const values = Array.from({ length: width }, (_, index) => row.getCell(index + 1).text.trim());
    if (rowNumber === 1) headers = uniqueImportHeaders(values);
    else rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  });

  return rows;
}

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function parseMoneyValue(value: unknown) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(/[A-Za-z]/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildAnalysisScope(data: any) {
  const entries = ledgerEntries(data?.entries ?? []);
  const invoices = data?.invoices ?? [];
  const documents = data?.documents ?? [];
  const movements = collectBankMovements(data);
  return `${entries.length} écriture(s) comptabilisée(s) · ${invoices.length} facture(s) · ${documents.length} document(s) · ${movements.length} mouvement(s)`;
}

function buildLocalAnalysisAnswer(question: string, data: any): AnalysisResult {
  const lower = question.toLowerCase();
  const invoices = data?.invoices ?? [];
  const entries = ledgerEntries(data?.entries ?? []);
  const documents = data?.documents ?? [];
  const movements = collectBankMovements(data);

  if (lower.includes("unpaid") || lower.includes("impay")) {
    const supplierOnly = lower.includes("fournisseur") || lower.includes("supplier");
    const candidates = supplierOnly ? invoices.filter((invoice: any) => invoice.kind === "PURCHASE") : invoices;
    const old = candidates.filter((invoice: any) => ["UNPAID", "OVERDUE"].includes(invoice.status) && daysBetween(invoice.dueDate) > 90);
    return {
      text: old.length
        ? old.map((invoice: any) => `${invoice.counterparty}: ${money(invoice.ttc)} · échéance ${date(invoice.dueDate)} · ${daysBetween(invoice.dueDate)} jours`).join("\n")
        : `Aucun ${supplierOnly ? "fournisseur" : "tiers"} impayé de plus de 90 jours dans les factures chargées.`,
      source: `${candidates.length} facture(s) ${supplierOnly ? "d'achat" : "client/fournisseur"}`,
    };
  }

  if (lower.includes("vat") || lower.includes("tva")) {
    const tax = data?.taxPeriods?.[0];
    return tax
      ? {
        text: `${tax.label}: TVA collectée ${money(tax.collectedVat)}, déductible ${money(tax.deductibleVat)}, à décaisser ${money(tax.dueVat)}. Échéance ${date(tax.declarationDue)}.`,
        source: `1 période de TVA · ${entries.length} écriture(s) comptabilisée(s) dans le périmètre du grand livre`,
      }
      : { text: "Aucune période de TVA n'est chargée pour la société active.", source: "0 période de TVA" };
  }

  if (lower.includes("duplicate") || lower.includes("doubl")) {
    const byPiece = new Map<string, any[]>();
    for (const entry of entries) {
      const key = String(entry.pieceNumber ?? "").trim().toLocaleUpperCase();
      if (!key) continue;
      byPiece.set(key, [...(byPiece.get(key) ?? []), entry]);
    }
    const duplicates = [...byPiece.entries()].filter(([, matches]) => matches.length > 1);
    return {
      text: duplicates.length
        ? duplicates.map(([pièce, matches]) => `${pièce}: ${matches.length} écritures (${matches.map((entry) => entry.journal?.code ?? "journal inconnu").join(", ")})`).join("\n")
        : "Aucun numéro de pièce répété dans les écritures comptabilisées chargées.",
      source: `${entries.length} écriture(s) comptabilisée(s) · comparaison des numéros de pièce`,
    };
  }

  if (lower.includes("balance")) {
    let debit = 0n;
    let credit = 0n;
    for (const entry of entries) {
      for (const line of entry.lines ?? []) {
        debit += exactCents(line.debitCents, line.debit);
        credit += exactCents(line.creditCents, line.credit);
      }
    }
    const difference = debit - credit;
    return {
      text: `${difference === 0n ? "La balance chargée est équilibrée" : "La balance chargée présente un écart"}. Débit ${formatExactCentsForUi(debit)} · crédit ${formatExactCentsForUi(credit)} · écart ${formatExactCentsForUi(difference)}.`,
      source: `${entries.length} écriture(s) comptabilisée(s), brouillons exclus`,
    };
  }

  if (lower.includes("banque") || lower.includes("bank") || lower.includes("rapproch")) {
    const unmatched = movements.filter((movement: any) => movement.status !== "MATCHED");
    const amount = unmatched.reduce((sum: bigint, movement: any) => {
      const value = exactCents(movement.amountCents, movement.amount);
      return sum + (value < 0n ? -value : value);
    }, 0n);
    return {
      text: `${unmatched.length} mouvement(s) restent à rapprocher, pour un montant absolu cumulé de ${formatExactCentsForUi(amount)}.`,
      source: `${movements.length} mouvement(s) sur ${(data?.bankAccounts ?? []).length} compte(s) bancaire(s)`,
    };
  }

  if (lower.includes("document") || lower.includes("ocr")) {
    const pending = documents.filter((document: any) => document.status !== "POSTED");
    return {
      text: `${pending.length} document(s) ne sont pas encore comptabilisés sur ${documents.length} document(s) chargé(s).`,
      source: `${documents.length} enregistrement(s) du dossier documentaire`,
    };
  }

  return {
    text: `Données disponibles : ${entries.length} écriture(s) comptabilisée(s), ${invoices.length} facture(s), ${documents.length} document(s) et ${movements.length} mouvement(s) bancaire(s). Essayez « balance », « TVA », « doublons », « impayés » ou « banque ».`,
    source: buildAnalysisScope(data),
  };
}

export default App;
