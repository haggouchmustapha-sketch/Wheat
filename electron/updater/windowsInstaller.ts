import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { PersistedUpdateState } from "./types";

export type WindowsInstallerOptions = {
  stateDirectory: string;
  helperPath: string;
  currentExecutable: string;
  parentPid: number;
  /** Maximum time to wait for the script to validate its inputs and acknowledge readiness. */
  spawnTimeoutMs?: number;
};

/** Resolves only after this attempt's helper passes its guards, before any program files change. */
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
  fs.mkdirSync(options.stateDirectory, { recursive: true });
  const attempt = randomUUID();
  const readyPath = path.join(options.stateDirectory, `helper-${attempt}.ready`);
  const diagnosticPath = path.join(options.stateDirectory, `helper-${attempt}-startup.log`);
  const stdoutPath = path.join(options.stateDirectory, `helper-${attempt}-stdout.log`);
  const stderrPath = path.join(options.stateDirectory, `helper-${attempt}-stderr.log`);
  const pidPath = path.join(options.stateDirectory, `helper-${attempt}.pid`);
  const helperArgs = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", options.helperPath,
    "-ParentPid", String(options.parentPid),
    "-InstallerPath", state.pending.artifactPath,
    "-CurrentExecutable", options.currentExecutable,
    "-StatePath", path.join(options.stateDirectory, "state.json"),
    "-RollbackDirectory", rollbackDirectory,
    "-LogPath", path.join(options.stateDirectory, "updater.log"),
    "-ReadyPath", readyPath,
  ].map(value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(" ");
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // DETACHED_PROCESS makes Windows PowerShell 5.1 silently exit before -File.
  // An ordinary child instead shares the parent's console lifetime. Start-Process
  // creates a separate hidden console, so the worker both starts and survives us.
  const bootstrap = [
    '$ErrorActionPreference = "Stop"',
    `$worker = Start-Process -FilePath ${literal(powershell)} -ArgumentList ${literal(helperArgs)} -WindowStyle Hidden -PassThru -RedirectStandardOutput ${literal(stdoutPath)} -RedirectStandardError ${literal(stderrPath)}`,
    `[IO.File]::WriteAllText(${literal(pidPath)}, [string]$worker.Id)`,
    '$worker.WaitForExit()',
    'exit $worker.ExitCode',
  ].join("; ");
  // File-backed output survives Electron shutdown and captures even parser/binding errors.
  const output = fs.openSync(diagnosticPath, "wx");
  let child: ChildProcess;
  try {
    child = spawn(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64"),
    ], { detached: false, stdio: ["ignore", output, output], windowsHide: true });
  } catch (error) {
    throw new Error(`The update helper could not be started: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    fs.closeSync(output);
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let failure: string | undefined;
    const timeoutMs = options.spawnTimeoutMs ?? 15_000;
    const timeout = setTimeout(() => {
      stop(`The update helper did not become ready within ${timeoutMs}ms.`);
    }, timeoutMs);
    const poll = setInterval(() => {
      if (failure || child.exitCode !== null || child.signalCode !== null) return;
      try {
        const helperPid = Number(fs.readFileSync(pidPath, "utf8").trim());
        if (!Number.isSafeInteger(helperPid) || helperPid <= 0) return;
        if (fs.readFileSync(readyPath, "utf8").trim() !== String(helperPid)) return;
        process.kill(helperPid, 0);
        finish();
        child.unref();
        resolve(helperPid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          stop(`Cannot read update helper readiness: ${String(error)}`);
        }
      }
    }, 50);
    function finish() {
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      fs.rmSync(readyPath, { force: true });
      fs.rmSync(pidPath, { force: true });
    }
    function stop(reason: string) {
      if (failure || settled) return;
      failure = reason;
      // Terminate the entire bootstrap/worker tree before allowing another try,
      // including a worker created just as the readiness deadline expired.
      const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        fail(`${reason}${error ? ` Helper termination failed: ${error.message}` : ""}`);
      });
    }
    function fail(reason: string) {
      if (settled) return;
      finish();
      let details = "";
      for (const file of [diagnosticPath, stdoutPath, stderrPath]) {
        try { details += fs.readFileSync(file, "utf8").trim().slice(-4000); } catch { /* The log path still identifies the attempt. */ }
      }
      reject(new Error(`${reason} Wheat was not changed. Diagnostics: ${diagnosticPath}${details ? `\n${details}` : ""}`));
    }
    child.once("error", (error) => fail(`The update helper could not be started: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (!failure) fail(`The update helper exited before readiness (code ${code}, signal ${signal}).`);
    });
  });
}
