import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { PersistedUpdateState } from "./types";

export type WindowsInstallerOptions = {
  stateDirectory: string;
  helperPath: string;
  currentExecutable: string;
  parentPid: number;
  /** Bounded so a wedged CreateProcess can never hold the app open forever. */
  spawnTimeoutMs?: number;
};

const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;

/**
 * Starts the PowerShell update helper and resolves only once the child process
 * genuinely exists.
 *
 * `spawn()` returns synchronously, but libuv creates the Windows process
 * asynchronously: the "spawn" event is the first moment the child is real. The
 * caller exits the app immediately afterwards, so resolving any earlier means
 * `app.exit(0)` can kill the parent before CreateProcess has run and the helper
 * never starts at all — the failure that left `helper-started` absent from
 * every line of updater.log while the app still closed and reopened unchanged.
 *
 * Resolves with the child pid. Rejects if the process cannot be created, so a
 * failed launch is always visible rather than silently doing nothing. Every
 * failure arrives as a rejection, including the ones Windows raises
 * synchronously out of spawn(), so callers need only one error path.
 */
export async function launchWindowsUpdateHelper(state: PersistedUpdateState, options: WindowsInstallerOptions): Promise<number> {
  if (process.platform !== "win32") throw new Error("Automatic installation is currently supported only on Windows packaged builds.");
  if (!state.pending) throw new Error("No staged update is available.");
  for (const filePath of [state.pending.artifactPath, options.helperPath, options.currentExecutable]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Required update file is missing: ${path.basename(filePath)}.`);
  }
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell)) throw new Error("Windows PowerShell is required to apply this local update.");
  const rollbackDirectory = path.join(options.stateDirectory, "rollback", state.pending.previousVersion);
  state.pending.rollbackPath = rollbackDirectory;
  let child: ChildProcess;
  try {
    child = spawn(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", options.helperPath,
      "-ParentPid", String(options.parentPid),
      "-InstallerPath", state.pending.artifactPath,
      "-CurrentExecutable", options.currentExecutable,
      "-StatePath", path.join(options.stateDirectory, "state.json"),
      "-RollbackDirectory", rollbackDirectory,
      "-LogPath", path.join(options.stateDirectory, "updater.log"),
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    // Windows reports some CreateProcess failures by throwing out of spawn()
    // rather than emitting "error"; normalise both into one rejection.
    throw new Error(`The update helper could not be started: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      settle(() => {
        // The child was never created; make sure a late CreateProcess cannot
        // leave a second helper waiting on a pid we are about to reuse.
        child.kill();
        reject(new Error(`The update helper did not start within ${options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms.`));
      });
    }, options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);

    let settled = false;
    function settle(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      action();
    }
    function onSpawn() {
      settle(() => {
        // Detach only once the process exists, so the parent may exit freely.
        child.unref();
        resolve(child.pid ?? 0);
      });
    }
    function onError(error: Error) {
      settle(() => reject(new Error(`The update helper could not be started: ${error.message}`)));
    }

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
