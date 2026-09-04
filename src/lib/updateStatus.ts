/**
 * The shape and the wording of Wheat's update state.
 *
 * Separated from the dialogs in `src/components/WheatUpdate.tsx` because the
 * Settings card needs the same label and the same units without pulling in the
 * dialogs, and because a module that exports both components and helpers cannot
 * be hot-reloaded.
 */

export type WheatUpdateStatusView = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "verifying" | "ready" | "installing" | "awaiting-confirmation" | "updated" | "error";
  source: string;
  currentVersion: string;
  availableVersion?: string;
  availableRelease?: { version: string; releaseDate: string; notes: string[] };
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  automaticInstallationEnabled: boolean;
  download?: { transferredBytes: number; totalBytes: number | null; percent: number | null };
  postponed?: boolean;
  installedUpdate?: { version: string; releaseDate: string; notes: string[]; installedAt: string };
};

export type WheatUpdateActions = {
  /** Fetch and verify the offered release. */
  download: () => void;
  /** Flush drafts, then restart into the installer. */
  install: () => void;
  /** "Plus tard" — keep the offer, stop interrupting. */
  postpone: () => void;
  /** Dismiss the "Wheat a été mis à jour" notice. */
  acknowledge: () => void;
};

const BYTES_PER_MB = 1024 * 1024;

/** Megabytes, because that is the unit an installer is discussed in. */
export function formatUpdateSize(bytes: number) {
  const megabytes = bytes / BYTES_PER_MB;
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} Mo`;
}

export function formatUpdateDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("fr-FR");
}

/** The one-line state shown on the Settings card and in the status badge. */
export function updateStatusLabel(status?: WheatUpdateStatusView | null) {
  if (!status) return "Initialisation du service de mise à jour";
  const labels: Record<WheatUpdateStatusView["phase"], string> = {
    idle: "Prêt à vérifier",
    checking: "Recherche d'une mise à jour…",
    "up-to-date": "Wheat est à jour",
    available: `Version ${status.availableVersion ?? "plus récente"} disponible`,
    downloading: "Téléchargement de la mise à jour…",
    verifying: "Vérification de la mise à jour…",
    ready: status.automaticInstallationEnabled
      ? "La mise à jour est prête"
      : "Mise à jour vérifiée (installation désactivée dans cette version)",
    installing: "Installation de la mise à jour…",
    "awaiting-confirmation": "Vérification de la nouvelle version…",
    updated: `Mise à jour vers ${status.currentVersion} réussie`,
    error: "La mise à jour n'a pas pu être installée",
  };
  // A status file written by an older Wheat can name a phase this build no
  // longer has. An unknown phase is reported as unknown, never as blank.
  return labels[status.phase] ?? "État de mise à jour inconnu";
}
