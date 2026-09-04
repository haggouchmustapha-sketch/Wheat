import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import semver from "semver";
import { UPDATE_SCHEMA_VERSION, type InstalledUpdateNotice, type PersistedUpdateState, type UpdateStatus } from "./types";

export class UpdateStateStore {
  readonly statePath: string;
  private readonly stateDirectory: string;
  private readonly currentVersion: string;
  private readonly source: string;
  private readonly automaticInstallationEnabled: boolean;

  constructor(stateDirectory: string, currentVersion: string, source: string, automaticInstallationEnabled: boolean) {
    this.stateDirectory = stateDirectory;
    this.currentVersion = currentVersion;
    this.source = source;
    this.automaticInstallationEnabled = automaticInstallationEnabled;
    this.statePath = path.join(stateDirectory, "state.json");
  }

  defaultState(): PersistedUpdateState {
    return {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      status: {
        phase: "idle",
        source: this.source,
        currentVersion: this.currentVersion,
        automaticInstallationEnabled: this.automaticInstallationEnabled,
      },
    };
  }

  async read(): Promise<PersistedUpdateState> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.statePath, "utf8")) as PersistedUpdateState;
      if (parsed?.schemaVersion !== UPDATE_SCHEMA_VERSION || !parsed.status || typeof parsed.status !== "object") throw new Error("Unsupported updater state schema.");
      parsed.status.currentVersion = this.currentVersion;
      parsed.status.source = this.source;
      parsed.status.automaticInstallationEnabled = this.automaticInstallationEnabled;
      if (parsed.notification && !parsed.notification.consumed) parsed.status.installedUpdate = noticeFromState(parsed.notification);
      else delete parsed.status.installedUpdate;
      // `offered.postponed` is the record; `status.postponed` is the view of it,
      // so a "later" cannot survive in the status after the offer it belonged to
      // has been replaced by a newer version.
      if (parsed.offered?.postponed) parsed.status.postponed = true;
      else delete parsed.status.postponed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.defaultState();
      const corruptPath = path.join(this.stateDirectory, `state-corrupt-${Date.now()}.json`);
      await fs.promises.mkdir(this.stateDirectory, { recursive: true });
      await fs.promises.rename(this.statePath, corruptPath).catch(() => undefined);
      return {
        ...this.defaultState(),
        status: {
          ...this.defaultState().status,
          phase: "error",
          error: "Updater state was malformed and has been safely reset.",
          message: "Updater state recovered",
        },
      };
    }
  }

  async write(state: PersistedUpdateState) {
    await fs.promises.mkdir(this.stateDirectory, { recursive: true });
    const temporaryPath = path.join(this.stateDirectory, `state-${randomUUID()}.tmp`);
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(temporaryPath, this.statePath);
  }

  async updateStatus(patch: Partial<UpdateStatus>) {
    const state = await this.read();
    state.status = { ...state.status, ...patch, currentVersion: this.currentVersion, source: this.source, automaticInstallationEnabled: this.automaticInstallationEnabled };
    await this.write(state);
    return state;
  }

  async confirmSuccessfulStartup() {
    const state = await this.read();
    if (!state.pending) return state;
    if (semver.eq(state.pending.release.version, this.currentVersion) && ["installing", "awaiting-confirmation"].includes(state.status.phase)) {
      const installedAt = new Date().toISOString();
      state.lastSuccessfullyInstalledVersion = this.currentVersion;
      state.notification = {
        version: state.pending.release.version,
        releaseDate: state.pending.release.releaseDate,
        notes: state.pending.release.notes,
        installedAt,
        consumed: false,
      };
      state.status = {
        ...state.status,
        phase: "updated",
        currentVersion: this.currentVersion,
        availableVersion: undefined,
        message: `Updated to ${this.currentVersion}`,
        error: undefined,
        installedUpdate: noticeFromState(state.notification),
      };
      delete state.pending;
      delete state.offered;
      delete state.status.availableRelease;
      delete state.status.postponed;
      delete state.status.download;
      await this.write(state);
      return state;
    }
    if (state.status.phase === "installing" && semver.neq(state.pending.release.version, this.currentVersion)) {
      state.status = {
        ...state.status,
        phase: "error",
        error: `Update ${state.pending.release.version} did not complete; Wheat ${this.currentVersion} is still running.`,
        message: "Previous version recovered",
      };
      await this.write(state);
    }
    return state;
  }

  /**
   * Records that the person chose "later" for the version currently on offer.
   *
   * Deliberately not a dismissal of the update: the offer, its notes and any
   * verified artifact all stay exactly where they were. Only the interruption
   * stops.
   */
  async postponeOffer() {
    const state = await this.read();
    if (state.offered) state.offered.postponed = true;
    state.status = { ...state.status, postponed: true };
    await this.write(state);
    return state;
  }

  async acknowledgeInstalledUpdate() {
    const state = await this.read();
    if (state.notification) state.notification.consumed = true;
    delete state.status.installedUpdate;
    if (state.status.phase === "updated") state.status.phase = "up-to-date";
    delete state.status.availableRelease;
    delete state.status.download;
    await this.write(state);
    return state;
  }
}

function noticeFromState(notification: InstalledUpdateNotice & { consumed: boolean }): InstalledUpdateNotice {
  return {
    version: notification.version,
    releaseDate: notification.releaseDate,
    notes: [...notification.notes],
    installedAt: notification.installedAt,
  };
}
