export const UPDATE_SCHEMA_VERSION = 1 as const;

export type UpdateRelease = {
  schemaVersion: typeof UPDATE_SCHEMA_VERSION;
  version: string;
  releaseDate: string;
  notes: string[];
  artifact: string;
  sha256: string;
  minimumVersion?: string;
  artifactSize?: number;
  signature?: {
    algorithm: string;
    value: string;
  };
};

export type AcquiredUpdate = {
  release: UpdateRelease;
  artifactPath: string;
};

export type StagedUpdate = AcquiredUpdate & {
  stagedAt: string;
  source: string;
};

/**
 * Real bytes, never an animation.
 *
 * `totalBytes` is null when neither the signed manifest nor the server declared
 * a length, and `percent` is null with it: a progress bar invented from nothing
 * tells the person less than an honest byte count does.
 */
export type UpdateDownloadProgress = {
  transferredBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

/**
 * What Wheat is doing about updates, at any moment.
 *
 * The phases follow the accountant's decisions rather than the machine's steps.
 * Nothing is downloaded before `available` is answered, and nothing is
 * installed before `ready` is answered:
 *
 *   idle → checking → up-to-date
 *                   → available     ← the person decides whether to download
 *                     → downloading → verifying → ready
 *                                                 ← the person decides when to restart
 *                                                 → installing → (restart) → updated
 *
 * `error` is reachable from any of them and is never terminal: the next check
 * starts again from `checking`.
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "awaiting-confirmation"
  | "updated"
  | "error";

export type InstalledUpdateNotice = Pick<UpdateRelease, "version" | "releaseDate" | "notes"> & {
  installedAt: string;
};

/** What the update dialogs show about a version that has been offered. */
export type OfferedUpdate = Pick<UpdateRelease, "version" | "releaseDate" | "notes">;

export type UpdateStatus = {
  phase: UpdatePhase;
  source: string;
  currentVersion: string;
  availableVersion?: string;
  /** The offered version's notes and date, so the prompt can be shown before any download. */
  availableRelease?: OfferedUpdate;
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  /**
   * Whether this build can actually replace program files — a packaged, non-portable
   * Windows Wheat. Elsewhere an update is still found and verified, but never applied.
   */
  automaticInstallationEnabled: boolean;
  /** Set while `phase` is `downloading`. */
  download?: UpdateDownloadProgress;
  /**
   * True once the person has said "later" to this version. The prompt stops
   * reappearing; Settings still shows the update and still offers it.
   */
  postponed?: boolean;
  installedUpdate?: InstalledUpdateNotice;
};

export type PersistedUpdateState = {
  schemaVersion: typeof UPDATE_SCHEMA_VERSION;
  status: UpdateStatus;
  /**
   * A version found by a check and offered to the person, before any bytes have
   * been fetched. Kept so the decision survives a restart: an update offered on
   * Friday is still offered on Monday without re-downloading the manifest.
   */
  offered?: {
    release: UpdateRelease;
    offeredAt: string;
    postponed?: boolean;
  };
  /** A downloaded, verified artifact waiting for permission to install. */
  pending?: {
    release: UpdateRelease;
    artifactPath: string;
    previousVersion: string;
    stagedAt: string;
    installStartedAt?: string;
    rollbackPath?: string;
  };
  lastSuccessfullyInstalledVersion?: string;
  notification?: InstalledUpdateNotice & { consumed: boolean };
};

/**
 * A failure to reach the update source, as opposed to a failure of the update.
 *
 * Part of the provider vocabulary rather than of any one provider: Wheat is a
 * local-first application that must work with no connection at all, so the
 * service needs to tell "could not ask" apart from "asked, and the answer was
 * bad" — whichever provider is installed.
 */
export class UpdateNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpdateNetworkError";
  }
}

export interface UpdateProvider {
  readonly name: string;
  /**
   * Whether a manifest from this source must carry a valid release signature.
   *
   * A property of the *channel*, not of the manifest: a manifest cannot be
   * allowed to declare how thoroughly it will be checked. A local folder in the
   * user's own profile is already as trusted as the application; anything
   * arriving over a network is not.
   */
  readonly requiresSignature: boolean;
  /** Human-readable origin, for the log and the settings screen. Never a credential. */
  readonly description: string;
  getLatestRelease(): Promise<UpdateRelease | null>;
  acquireUpdate(
    release: UpdateRelease,
    stagingDirectory: string,
    onProgress?: (progress: UpdateDownloadProgress) => void,
  ): Promise<AcquiredUpdate>;
  validateUpdate(update: AcquiredUpdate): Promise<void>;
}
