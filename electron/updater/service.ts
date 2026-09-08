import fs from "node:fs";
import path from "node:path";
import {
  UpdateNetworkError,
  type PersistedUpdateState,
  type StagedUpdate,
  type UpdateProvider,
  type UpdateRelease,
  type UpdateStatus,
} from "./types";
import { assertUpdateCompatibility } from "./validation";
import { UpdateStateStore } from "./state";
import { UpdateLogger } from "./logger";
import { verifyReleaseSignature } from "./signature";

export type UpdateServiceOptions = {
  currentVersion: string;
  provider: UpdateProvider;
  stateDirectory: string;
  automaticInstallationEnabled: boolean;
  /**
   * Pinned Ed25519 release key, in SPKI PEM. `null` means no key is configured,
   * which a provider that requires signatures treats as a refusal to proceed.
   */
  publicKey?: string | null;
  onStatus?: (status: UpdateStatus) => void;
};

/**
 * Finding, fetching and applying an update — as three decisions, not one.
 *
 * The accountant is the one who decides. A check may run unattended and may
 * report that a new version exists; it downloads nothing. A download happens
 * because somebody pressed "Mettre à jour"; it installs nothing. An install
 * happens because somebody pressed "Redémarrer et installer" — which is the
 * only moment Wheat closes, and never a moment it chooses for itself. Somebody
 * halfway through an invoice does not lose it to a background update.
 *
 * Each step is idempotent under repeated calls: a second click while a download
 * is running joins the first rather than starting a rival one.
 */
export class UpdateService {
  readonly store: UpdateStateStore;
  readonly logger: UpdateLogger;
  private readonly options: UpdateServiceOptions;
  private checkPromise: Promise<PersistedUpdateState> | null = null;
  private downloadPromise: Promise<PersistedUpdateState> | null = null;
  private installPromise: Promise<PersistedUpdateState> | null = null;
  /** True when any caller sharing the in-flight check asked for it explicitly. */
  private pendingCheckIsManual = false;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.store = new UpdateStateStore(options.stateDirectory, options.currentVersion, options.provider.name, options.automaticInstallationEnabled);
    this.logger = new UpdateLogger(options.stateDirectory);
  }

  async getStatus() {
    return (await this.store.read()).status;
  }

  async confirmSuccessfulStartup() {
    const state = await this.store.confirmSuccessfulStartup();
    if (state.status.phase === "updated") await this.logger.log("update-success", { version: this.options.currentVersion });
    this.emit(state.status);
    return state.status;
  }

  async acknowledgeInstalledUpdate() {
    const state = await this.store.acknowledgeInstalledUpdate();
    this.emit(state.status);
    return state.status;
  }

  async hasUnresolvedInstallationFailure() {
    const state = await this.store.read();
    return state.status.phase === "error" && Boolean(state.pending?.installStartedAt);
  }

  /**
   * "Plus tard". The offer stays on record and stays visible in Settings; it
   * simply stops interrupting. A later check for the *same* version will not
   * prompt again, and a newer version will.
   */
  async postponeUpdate() {
    const state = await this.store.postponeOffer();
    await this.logger.log("update-postponed", { availableVersion: state.status.availableVersion });
    this.emit(state.status);
    return state.status;
  }

  /**
   * `automatic` marks the unattended check that runs shortly after launch.
   * It only changes how a *network* failure is reported: nobody asked, so
   * nobody is told. Everything else is reported identically either way.
   */
  checkForUpdates(options: { automatic?: boolean } = {}) {
    if (this.installPromise) return this.installPromise;
    if (this.downloadPromise) return this.downloadPromise;
    if (!options.automatic) this.pendingCheckIsManual = true;
    if (!this.checkPromise) {
      this.pendingCheckIsManual = !options.automatic;
      this.checkPromise = this.performCheck().finally(() => { this.checkPromise = null; });
    }
    return this.checkPromise;
  }

  private async performCheck() {
    const checkedAt = new Date().toISOString();
    await this.logger.log("check-started", { source: this.options.provider.name, origin: this.options.provider.description, installedVersion: this.options.currentVersion });
    await this.setStatus({ phase: "checking", lastCheckedAt: checkedAt, message: "Checking for updates", error: undefined, download: undefined });
    try {
      const release = await this.options.provider.getLatestRelease();
      if (!release) {
        await this.logger.log("check-complete", { result: "no-release-published", installedVersion: this.options.currentVersion });
        return this.clearOffer(checkedAt);
      }
      await this.logger.log("metadata-valid", { availableVersion: release.version, schemaVersion: release.schemaVersion });

      // Authenticity before anything is acted on: the version comparison, the
      // download and the installer all take their instructions from this
      // manifest, so it is checked before any of them run. A provider that
      // requires signatures always verifies; one that does not still verifies a
      // signature that is present, so a signed release can never be silently
      // accepted on a broken signature.
      if (this.options.provider.requiresSignature || release.signature) {
        verifyReleaseSignature(release, this.options.publicKey ?? null);
        await this.logger.log("signature-valid", { availableVersion: release.version, algorithm: release.signature?.algorithm });
      }

      const isNewer = assertUpdateCompatibility(this.options.currentVersion, release);
      if (!isNewer) {
        await this.logger.log("check-complete", { result: "up-to-date", availableVersion: release.version, installedVersion: this.options.currentVersion });
        return this.clearOffer(checkedAt);
      }

      const state = await this.store.read();
      // Bytes already downloaded and verified for exactly this version are not
      // fetched twice: a check that runs after a postponed restart finds the
      // update still ready, and the person is asked to restart, not to download.
      if (state.pending && state.pending.release.version === release.version && await artifactStillPresent(state.pending.artifactPath)) {
        state.status = {
          ...state.status,
          phase: "ready",
          lastCheckedAt: checkedAt,
          availableVersion: release.version,
          availableRelease: offerFrom(release),
          message: `Update ${release.version} is ready to install`,
          error: undefined,
          download: undefined,
        };
        await this.store.write(state);
        await this.logger.log("check-complete", { result: "already-staged", availableVersion: release.version });
        this.emit(state.status);
        return state;
      }

      // The update is offered, and nothing more happens until somebody says so.
      const alreadyPostponed = state.offered?.release.version === release.version && Boolean(state.offered.postponed);
      state.offered = { release, offeredAt: checkedAt, ...(alreadyPostponed ? { postponed: true } : {}) };
      delete state.pending;
      state.status = {
        ...state.status,
        phase: "available",
        lastCheckedAt: checkedAt,
        availableVersion: release.version,
        availableRelease: offerFrom(release),
        postponed: alreadyPostponed || undefined,
        message: `Update ${release.version} available`,
        error: undefined,
        download: undefined,
      };
      await this.store.write(state);
      await this.logger.log("update-available", { availableVersion: release.version, installedVersion: this.options.currentVersion });
      this.emit(state.status);
      return state;
    } catch (error) {
      return this.reportFailure(error, checkedAt, "Update check failed");
    }
  }

  /**
   * Downloads and verifies the offered update. Called because the person asked.
   *
   * Refuses rather than improvises when there is nothing on offer: a download
   * with no signed manifest behind it would be an unverifiable download.
   */
  downloadOfferedUpdate() {
    if (this.installPromise) return this.installPromise;
    if (!this.downloadPromise) {
      this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = null; });
    }
    return this.downloadPromise;
  }

  private async performDownload() {
    const checkedAt = new Date().toISOString();
    // A download only ever happens because somebody pressed a button, so its
    // failures are always reported. The quiet-when-offline rule belongs to the
    // unattended check alone.
    this.pendingCheckIsManual = true;
    const initial = await this.store.read();
    if (initial.status.phase === "ready" && initial.pending) return initial;
    const offered = initial.offered;
    if (!offered) throw new Error("No Wheat update has been offered to download.");
    const release = offered.release;

    try {
      // Re-verified rather than trusted from disk: the state file has sat in
      // the profile since the check, and a manifest is only ever acted on while
      // its signature is known good.
      if (this.options.provider.requiresSignature || release.signature) {
        verifyReleaseSignature(release, this.options.publicKey ?? null);
      }
      assertUpdateCompatibility(this.options.currentVersion, release);

      const stagingDirectory = path.join(this.options.stateDirectory, "staging", release.version);
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      await this.logger.log("download-started", { availableVersion: release.version, artifact: path.basename(release.artifact), declaredSize: release.artifactSize ?? null });
      const downloading = await this.setStatus({
        phase: "downloading",
        availableVersion: release.version,
        availableRelease: offerFrom(release),
        message: `Downloading update ${release.version}`,
        error: undefined,
        download: { transferredBytes: 0, totalBytes: release.artifactSize ?? null, percent: release.artifactSize ? 0 : null },
      });

      let lastLoggedPercent = -1;
      const acquired = await this.options.provider.acquireUpdate(release, stagingDirectory, (progress) => {
        // Emit in transfer order. Async state reads could finish after verification
        // began and silently discard the final progress event on fast downloads.
        this.emit({ ...downloading.status, download: progress });
        // Logged in tenths so a long download leaves a readable trace rather
        // than a thousand near-identical lines.
        const decile = progress.percent === null ? -1 : Math.floor(progress.percent / 10) * 10;
        if (decile > lastLoggedPercent) {
          lastLoggedPercent = decile;
          void this.logger.log("download-progress", { availableVersion: release.version, percent: decile, transferredBytes: progress.transferredBytes });
        }
      });
      await this.logger.log("download-complete", { availableVersion: release.version });

      await this.setStatus({ phase: "verifying", message: `Verifying update ${release.version}`, download: undefined });
      await this.options.provider.validateUpdate(acquired);
      await this.logger.log("artifact-valid", { availableVersion: release.version, artifact: path.basename(acquired.artifactPath), sha256: release.sha256 });

      const staged: StagedUpdate = { ...acquired, stagedAt: new Date().toISOString(), source: this.options.provider.name };
      const state = await this.store.read();
      state.pending = {
        release,
        artifactPath: acquired.artifactPath,
        previousVersion: this.options.currentVersion,
        stagedAt: staged.stagedAt,
      };
      state.status = {
        ...state.status,
        phase: "ready",
        availableVersion: release.version,
        availableRelease: offerFrom(release),
        postponed: undefined,
        message: this.options.automaticInstallationEnabled
          ? `Update ${release.version} is ready to install`
          : `Update ${release.version} validated; installation is disabled in this build`,
        error: undefined,
        download: undefined,
      };
      await this.store.write(state);
      await this.logger.log("update-ready", { availableVersion: release.version });
      this.emit(state.status);
      return state;
    } catch (error) {
      // A failed or interrupted download leaves nothing installable behind: the
      // partial file is already gone, and the offer stays so the person can
      // simply try again.
      await fs.promises.rm(path.join(this.options.stateDirectory, "staging", release.version), { recursive: true, force: true }).catch(() => undefined);
      return this.reportFailure(error, checkedAt, "Update download failed");
    }
  }

  installStagedUpdate(launch: (state: PersistedUpdateState) => Promise<void>) {
    if (!this.installPromise) this.installPromise = this.performInstall(launch).finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  private async performInstall(launch: (state: PersistedUpdateState) => Promise<void>) {
    const state = await this.store.read();
    if (!state.pending || state.status.phase !== "ready") throw new Error("No validated Wheat update is ready to install.");
    if (!this.options.automaticInstallationEnabled) {
      // A development or portable build has verified the update and will not
      // touch program files. Saying so is better than a button that appears to
      // work and silently does nothing.
      throw new Error("This Wheat build validates updates but does not install them. Run the downloaded installer manually.");
    }
    state.status = { ...state.status, phase: "installing", message: `Installing update ${state.pending.release.version}`, error: undefined, download: undefined };
    state.pending.installStartedAt = new Date().toISOString();
    await this.store.write(state);
    this.emit(state.status);
    await this.logger.log("installation-started", { availableVersion: state.pending.release.version });
    try {
      await launch(state);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The installer never started, so the working Wheat is untouched and the
      // verified artifact is still on disk: back to "ready", not to a dead end.
      state.status = { ...state.status, phase: "ready", message: "Update installation could not start", error: message };
      delete state.pending.installStartedAt;
      await this.store.write(state);
      await this.logger.log("installation-launch-failed", { reason: message });
      this.emit(state.status);
      return state;
    }
  }

  /** Back to a clean "nothing on offer", used by both no-release outcomes. */
  private async clearOffer(checkedAt: string) {
    const state = await this.store.read();
    delete state.offered;
    delete state.pending;
    state.status = {
      ...state.status,
      phase: "up-to-date",
      lastCheckedAt: checkedAt,
      availableVersion: undefined,
      availableRelease: undefined,
      postponed: undefined,
      message: "Up to date",
      error: undefined,
      download: undefined,
    };
    await this.store.write(state);
    this.emit(state.status);
    return state;
  }

  /**
   * One failure path for the check and the download.
   *
   * An unattended check that could not reach the server has learned nothing, so
   * it says nothing: raising an error there would put a permanent warning in
   * front of every user with an intermittent connection, about a condition they
   * did not cause and cannot act on. The reason still reaches the updater log.
   */
  private async reportFailure(error: unknown, checkedAt: string, summary: string) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UpdateNetworkError && !this.pendingCheckIsManual) {
      await this.logger.log("check-unreachable", { reason: message, automatic: true });
      const current = await this.store.read();
      return this.setStatus({
        phase: current.status.phase === "checking" || current.status.phase === "downloading" ? "idle" : current.status.phase,
        lastCheckedAt: checkedAt,
        message: "Update server unreachable",
        error: undefined,
        download: undefined,
      });
    }
    await this.logger.log("update-rejected", { reason: message });
    return this.setStatus({ phase: "error", lastCheckedAt: checkedAt, message: summary, error: message, download: undefined });
  }

  private async setStatus(patch: Partial<UpdateStatus>) {
    const state = await this.store.updateStatus(patch);
    this.emit(state.status);
    return state;
  }

  private emit(status: UpdateStatus) {
    this.options.onStatus?.(status);
  }
}

function offerFrom(release: UpdateRelease) {
  return { version: release.version, releaseDate: release.releaseDate, notes: [...release.notes] };
}

async function artifactStillPresent(artifactPath: string) {
  try {
    const stat = await fs.promises.stat(artifactPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
