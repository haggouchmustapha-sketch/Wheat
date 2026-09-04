const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
let updater;

test.beforeAll(() => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
});

function temporaryWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-updater-"));
  return {
    directory,
    feed: path.join(directory, "updates"),
    state: path.join(directory, "profile", "updater"),
    dataFile: path.join(directory, "profile", "wheat.sqlite"),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeRelease(feed, overrides = {}, artifactBytes = Buffer.from("valid Wheat installer")) {
  const version = overrides.version ?? "2.2.0";
  const artifactName = `AtlasLedgerSetup-${version}.exe`;
  const releaseDirectory = path.join(feed, version);
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(releaseDirectory, artifactName), artifactBytes);
  const release = {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-28",
    notes: ["Added automatic updates", "Fixed a startup issue"],
    artifact: `${version}/${artifactName}`,
    sha256: sha256(artifactBytes),
    artifactSize: artifactBytes.length,
    ...overrides,
  };
  fs.mkdirSync(feed, { recursive: true });
  fs.writeFileSync(path.join(feed, "latest.json"), JSON.stringify(release));
  fs.writeFileSync(path.join(releaseDirectory, "release.json"), JSON.stringify(release));
  return release;
}

function serviceFor(workspace, currentVersion = "2.1.0", automaticInstallationEnabled = false, provider) {
  return new updater.UpdateService({
    currentVersion,
    provider: provider ?? new updater.LocalUpdateProvider(workspace.feed),
    stateDirectory: workspace.state,
    automaticInstallationEnabled,
  });
}

/**
 * The whole accepted path, as the person walks it: the check offers a version,
 * and the download happens only because they asked for it. Wheat never gets
 * from "a new version exists" to "bytes on disk" on its own.
 */
async function offerThenDownload(service) {
  const offered = await service.checkForUpdates();
  expect(offered.status.phase).toBe("available");
  return service.downloadOfferedUpdate();
}

test("semantic versions compare numerically, including 2.10.0 versus 2.9.0", () => {
  expect(updater.assertUpdateCompatibility("2.9.0", writeReleaseObject("2.10.0"))).toBe(true);
  expect(() => updater.assertUpdateCompatibility("2.10.0", writeReleaseObject("2.9.0"))).toThrow(/Downgrade rejected/);
});

test("no local manifest continues as up to date without an error", async () => {
  const workspace = temporaryWorkspace();
  try {
    const result = await serviceFor(workspace).checkForUpdates();
    expect(result.status.phase).toBe("up-to-date");
    expect(result.status.error).toBeUndefined();
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("a newer release is acquired, checksum-validated, and staged", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const result = await offerThenDownload(serviceFor(workspace));
    expect(result.status).toMatchObject({ phase: "ready", availableVersion: "2.2.0", automaticInstallationEnabled: false });
    expect(result.pending.artifactPath).toContain(path.join("staging", "2.2.0"));
    expect(fs.existsSync(result.pending.artifactPath)).toBe(true);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("same-version metadata reports no update", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed, { version: "2.1.0" });
    expect((await serviceFor(workspace).checkForUpdates()).status.phase).toBe("up-to-date");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

for (const scenario of [
  {
    name: "malformed manifest",
    arrange(workspace) { fs.mkdirSync(workspace.feed, { recursive: true }); fs.writeFileSync(path.join(workspace.feed, "latest.json"), "{broken"); },
    message: /valid JSON/,
  },
  {
    name: "missing artifact",
    arrange(workspace) { const release = writeRelease(workspace.feed); fs.rmSync(path.join(workspace.feed, release.version, path.basename(release.artifact))); },
    message: /artifact is missing/,
  },
  {
    name: "invalid SHA-256 metadata",
    arrange(workspace) { writeRelease(workspace.feed, { sha256: "not-a-hash" }); },
    message: /invalid SHA-256/,
  },
  {
    name: "corrupt update artifact",
    arrange(workspace) { const release = writeRelease(workspace.feed); fs.appendFileSync(path.join(workspace.feed, release.version, path.basename(release.artifact)), "corruption"); },
    message: /size does not match|SHA-256 verification/,
  },
  {
    name: "downgrade attempt",
    arrange(workspace) { writeRelease(workspace.feed, { version: "2.0.9" }); },
    message: /Downgrade rejected/,
  },
  {
    name: "incompatible release",
    arrange(workspace) { writeRelease(workspace.feed, { minimumVersion: "2.1.5" }); },
    message: /requires Wheat 2.1.5/,
  },
]) {
  test(`${scenario.name} is rejected and logged`, async () => {
    const workspace = temporaryWorkspace();
    try {
      scenario.arrange(workspace);
      const service = serviceFor(workspace);
      // A bad manifest is refused at the check; bad *bytes* can only be refused
      // once they have been fetched, which happens after the person consents.
      let result = await service.checkForUpdates();
      if (result.status.phase === "available") result = await service.downloadOfferedUpdate();
      expect(result.status.phase).toBe("error");
      expect(result.status.error).toMatch(scenario.message);
      expect(fs.readFileSync(path.join(workspace.state, "updater.log"), "utf8")).toContain("update-rejected");
    } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
  });
}

test("successful staged installation is confirmed only by the updated version after restart", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const oldService = serviceFor(workspace, "2.1.0", true);
    await offerThenDownload(oldService);
    let launched = 0;
    const installing = await oldService.installStagedUpdate(async (state) => {
      launched += 1;
      expect(state.pending.release.version).toBe("2.2.0");
    });
    expect(launched).toBe(1);
    expect(installing.status.phase).toBe("installing");
    expect(installing.status.installedUpdate).toBeUndefined();

    const updatedService = serviceFor(workspace, "2.2.0", true);
    const confirmed = await updatedService.confirmSuccessfulStartup();
    expect(confirmed.phase).toBe("updated");
    expect(confirmed.installedUpdate.notes).toEqual(["Added automatic updates", "Fixed a startup issue"]);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("failed installation launch records recovery-safe error and leaves user data untouched", async () => {
  const workspace = temporaryWorkspace();
  try {
    fs.mkdirSync(path.dirname(workspace.dataFile), { recursive: true });
    fs.writeFileSync(workspace.dataFile, "precious accounting data");
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", true);
    await offerThenDownload(service);
    const failed = await service.installStagedUpdate(async () => { throw new Error("helper could not start"); });
    // The installer never started, so the verified artifact and the working
    // Wheat are both untouched: back to "ready", not to a dead end.
    expect(failed.status).toMatchObject({ phase: "ready", message: "Update installation could not start" });
    expect(failed.status.error).toMatch(/helper could not start/);
    expect(fs.existsSync(failed.pending.artifactPath)).toBe(true);
    expect(fs.readFileSync(workspace.dataFile, "utf8")).toBe("precious accounting data");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("update success state survives restart and the modal notice is consumable exactly once", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", true);
    await offerThenDownload(service);
    await service.installStagedUpdate(async () => undefined);
    const restarted = serviceFor(workspace, "2.2.0", true);
    await restarted.confirmSuccessfulStartup();
    expect((await restarted.getStatus()).installedUpdate.version).toBe("2.2.0");
    await restarted.acknowledgeInstalledUpdate();
    expect((await restarted.getStatus()).installedUpdate).toBeUndefined();
    expect((await serviceFor(workspace, "2.2.0", true).getStatus()).installedUpdate).toBeUndefined();
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("manual checks and concurrent automatic checks share one provider operation", async () => {
  const workspace = temporaryWorkspace();
  try {
    const release = writeRelease(workspace.feed);
    const local = new updater.LocalUpdateProvider(workspace.feed);
    let calls = 0;
    const provider = {
      name: "test-local",
      description: workspace.feed,
      requiresSignature: false,
      async getLatestRelease() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return release; },
      acquireUpdate: (...args) => local.acquireUpdate(...args),
      validateUpdate: (...args) => local.validateUpdate(...args),
    };
    const service = serviceFor(workspace, "2.1.0", false, provider);
    const [automatic, manual] = await Promise.all([service.checkForUpdates(), service.checkForUpdates()]);
    expect(calls).toBe(1);
    expect(automatic.status.phase).toBe("available");
    expect(manual.status.phase).toBe("available");

    // A second click while the download runs joins the first rather than
    // starting a rival one against the same staging directory.
    const [first, second] = await Promise.all([service.downloadOfferedUpdate(), service.downloadOfferedUpdate()]);
    expect(first.status.phase).toBe("ready");
    expect(second.status.phase).toBe("ready");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("a build that cannot install says so instead of quietly doing nothing", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", false);
    const ready = await offerThenDownload(service);
    expect(ready.status.phase).toBe("ready");

    // A development or portable Wheat verifies the update and refuses to touch
    // program files. Refusing out loud beats a button that appears to work.
    let invoked = false;
    await expect(service.installStagedUpdate(async () => { invoked = true; }))
      .rejects.toThrow(/does not install them/);
    expect(invoked).toBe(false);
    expect((await service.getStatus()).phase).toBe("ready");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("development and packaged local feed paths are isolated and deterministic", () => {
  const project = path.join("D:\\", "atlas-project");
  const userData = path.join("C:\\", "Users", "Atlas", "AppData", "Roaming", "Wheat");
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: false, getPath: () => userData }, project, {})).toBe(path.resolve(project, "updates"));
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: false, getPath: () => userData }, project, { WHEAT_UPDATES_DIR: path.join(project, "test-feed") })).toBe(path.resolve(project, "test-feed"));
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: true, getPath: () => userData }, project, { WHEAT_UPDATES_DIR: "untrusted" })).toBe(path.join(userData, "updates"));
  expect(updater.resolveUpdaterStateDirectory({ isPackaged: true, getPath: () => userData })).toBe(path.join(userData, "updater"));
});

test("Wheat names itself Wheat and takes its profile from the migration, not a fixed path", () => {
  const mainSource = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  expect(mainSource).toContain('app.setName("Wheat");');
  // The profile directory is whatever the migration resolves, so an existing
  // Atlas Ledger profile is carried across instead of being left behind.
  expect(mainSource).toContain("const profileMigration = resolveProfileDirectory(app.getPath(\"appData\"));");
  expect(mainSource).toContain('app.setPath("userData", profileMigration.profileDirectory);');
  expect(mainSource).not.toContain('LEGACY_PROFILE_DIRECTORY_NAME');
  // The Windows install identity is not branding and must not be renamed.
  expect(mainSource).toContain('const WINDOWS_INSTALL_IDENTITY = "ma.atlasledger.desktop";');
});

test("the release packaging command generates matching manifests and SHA-256 automatically", () => {
  const workspace = temporaryWorkspace();
  try {
    // The packaging script reads the product version from package.json, so the
    // expectation follows it instead of pinning a release number here.
    const productVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    const artifact = path.join(workspace.directory, `WheatSetup-${productVersion}.exe`);
    const notes = path.join(workspace.directory, "notes.md");
    fs.writeFileSync(artifact, "test NSIS bytes");
    fs.writeFileSync(notes, `# Wheat ${productVersion}\n- Added local updates\n- Fixed recovery\n`);
    execFileSync(process.execPath, [
      path.join(root, "scripts", "package-update.mjs"),
      "--artifact", artifact,
      "--notes-file", notes,
      "--output", workspace.feed,
      "--no-publish",
    ], { cwd: root, stdio: "pipe" });
    const latest = JSON.parse(fs.readFileSync(path.join(workspace.feed, "latest.json"), "utf8"));
    const release = JSON.parse(fs.readFileSync(path.join(workspace.feed, productVersion, "release.json"), "utf8"));
    expect(latest).toEqual(release);
    expect(latest).toMatchObject({
      schemaVersion: 1,
      version: productVersion,
      notes: ["Added local updates", "Fixed recovery"],
      artifact: `${productVersion}/WheatSetup-${productVersion}.exe`,
      sha256: sha256(Buffer.from("test NSIS bytes")),
    });
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

/**
 * Builds a directory that looks the way an NSIS install of Wheat looks on disk,
 * plus the updater state the helper reads. `withUninstaller: false` produces the
 * shape the helper must refuse: a Wheat the installer did not put there.
 */
function installedFixture(workspace, { withUninstaller = true, installerName = "broken-installer.exe", installerBody = "not an executable" } = {}) {
  const installDirectory = path.join(workspace.directory, "installed");
  const currentExecutable = path.join(installDirectory, "Wheat.exe");
  const installer = path.join(workspace.directory, installerName);
  const statePath = path.join(workspace.state, "state.json");
  fs.mkdirSync(installDirectory, { recursive: true });
  fs.mkdirSync(workspace.state, { recursive: true });
  fs.writeFileSync(currentExecutable, "old executable bytes");
  if (withUninstaller) fs.writeFileSync(path.join(installDirectory, "Uninstall Wheat.exe"), "uninstaller");
  fs.writeFileSync(path.join(installDirectory, "program.txt"), "old working program");
  fs.writeFileSync(installer, installerBody);
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    status: { phase: "installing", source: "local", currentVersion: "2.1.0", automaticInstallationEnabled: true },
    pending: {
      release: writeReleaseObject("2.2.0"),
      artifactPath: installer,
      previousVersion: "2.1.0",
      stagedAt: new Date().toISOString(),
      installStartedAt: new Date().toISOString(),
    },
  }));
  return {
    installDirectory,
    currentExecutable,
    installer,
    statePath,
    rollback: path.join(workspace.state, "rollback", "2.1.0"),
    logPath: path.join(workspace.state, "updater.log"),
  };
}

function runUpdateHelper(fixture) {
  try {
    execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(root, "resources", "updater", "update-helper.ps1"),
      "-ParentPid", "999999",
      "-InstallerPath", fixture.installer,
      "-CurrentExecutable", fixture.currentExecutable,
      "-StatePath", fixture.statePath,
      "-RollbackDirectory", fixture.rollback,
      "-LogPath", fixture.logPath,
    ], { windowsHide: true, stdio: "pipe", timeout: 60000 });
    return { code: 0 };
  } catch (error) {
    return { code: error.status ?? -1, stderr: error.stderr?.toString() ?? error.message };
  }
}

test("the Windows helper snapshots program files and records recovery after installer failure", () => {
  test.skip(process.platform !== "win32", "Windows update helper test");
  const workspace = temporaryWorkspace();
  try {
    const fixture = installedFixture(workspace);
    const result = runUpdateHelper(fixture);
    const helperState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    if (helperState.status.phase !== "error") {
      throw new Error(`Update helper did not record recovery. ${result.stderr ?? "No helper error was captured."}`);
    }
    expect(fs.readFileSync(path.join(fixture.rollback, "program.txt"), "utf8")).toBe("old working program");
    expect(fs.readFileSync(path.join(fixture.installDirectory, "program.txt"), "utf8")).toBe("old working program");
    expect(fs.readFileSync(fixture.logPath, "utf8")).toContain("rollback-restored");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("the helper refuses a directory the installer did not create, and says so in the log", () => {
  test.skip(process.platform !== "win32", "Windows update helper test");
  const workspace = temporaryWorkspace();
  try {
    const fixture = installedFixture(workspace, { withUninstaller: false });
    const result = runUpdateHelper(fixture);
    expect(result.code).toBe(2);
    const log = fs.readFileSync(fixture.logPath, "utf8");
    // The refusal happens above the old throw-only guards, so it is recorded.
    expect(log).toContain("helper-started");
    expect(log).toContain("installation-refused");
    expect(log).toMatch(/was not put there by the installer/);
    expect(JSON.parse(fs.readFileSync(fixture.statePath, "utf8")).status).toMatchObject({ phase: "error" });
    // A refusal changes nothing, so no snapshot should have been taken.
    expect(fs.existsSync(fixture.rollback)).toBe(false);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("an installer that exits zero without changing the executable is a failure, not a success", () => {
  test.skip(process.platform !== "win32", "Windows update helper test");
  const workspace = temporaryWorkspace();
  try {
    // Succeeds immediately and writes nothing: the shape of an installer that
    // deployed to a different directory than the one being replaced.
    const fixture = installedFixture(workspace, { installerName: "elsewhere-installer.cmd", installerBody: "@echo off\r\nexit /b 0\r\n" });
    const result = runUpdateHelper(fixture);
    expect(result.code).not.toBe(0);
    const log = fs.readFileSync(fixture.logPath, "utf8");
    expect(log).toContain("installer-completed");
    expect(log).toMatch(/is unchanged/);
    expect(log).toContain("rollback-restored");
    expect(log).not.toContain("installation-verified");
    expect(JSON.parse(fs.readFileSync(fixture.statePath, "utf8")).status).toMatchObject({ phase: "error" });
    expect(fs.readFileSync(path.join(fixture.installDirectory, "program.txt"), "utf8")).toBe("old working program");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("the helper launcher resolves only once the child process has actually started", async () => {
  test.skip(process.platform !== "win32", "Windows spawn semantics");
  const workspace = temporaryWorkspace();
  try {
    const fixture = installedFixture(workspace);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    const helperPath = path.join(workspace.directory, "noop-helper.ps1");
    fs.writeFileSync(helperPath, "exit 0\n");
    let resolved = false;
    const launch = updater.launchWindowsUpdateHelper(state, {
      stateDirectory: workspace.state,
      helperPath,
      currentExecutable: fixture.currentExecutable,
      parentPid: process.pid,
    }).then((pid) => { resolved = true; return pid; });
    // spawn() returns synchronously but the OS process does not exist yet. If
    // this resolved already, app.exit(0) could outrun CreateProcess and the
    // helper would never run at all.
    expect(resolved).toBe(false);
    expect(await launch).toBeGreaterThan(0);
    expect(resolved).toBe(true);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("a helper that cannot be spawned rejects instead of reporting a restart", async () => {
  test.skip(process.platform !== "win32", "Windows spawn semantics");
  const workspace = temporaryWorkspace();
  const previousSystemRoot = process.env.SystemRoot;
  try {
    const fixture = installedFixture(workspace);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    // A powershell.exe that exists but is not a valid executable, so the file
    // checks pass and CreateProcess is what fails.
    const fakeRoot = path.join(workspace.directory, "fakewin");
    const shellDirectory = path.join(fakeRoot, "System32", "WindowsPowerShell", "v1.0");
    fs.mkdirSync(shellDirectory, { recursive: true });
    fs.writeFileSync(path.join(shellDirectory, "powershell.exe"), "not a real executable");
    process.env.SystemRoot = fakeRoot;
    await expect(updater.launchWindowsUpdateHelper(state, {
      stateDirectory: workspace.state,
      helperPath: path.join(root, "resources", "updater", "update-helper.ps1"),
      currentExecutable: fixture.currentExecutable,
      parentPid: process.pid,
      spawnTimeoutMs: 5000,
    })).rejects.toThrow(/could not be started|did not start/);
  } finally {
    process.env.SystemRoot = previousSystemRoot;
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test("the app exits only after the update helper launch has been awaited", () => {
  const source = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  const body = source.slice(source.indexOf("async function launchStagedUpdateAndExit"));
  const launch = body.indexOf("await launchWindowsUpdateHelper");
  const exit = body.indexOf("app.exit(0)");
  expect(launch).toBeGreaterThan(-1);
  expect(exit).toBeGreaterThan(launch);
  // A launch that never started must be reported and must not close the app.
  expect(body).toContain('"helper-launch-failed"');
  expect(body.slice(0, exit)).toContain('"helper-started-confirmed"');
});

function writeReleaseObject(version) {
  return {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-28",
    notes: ["Test"],
    artifact: `${version}/AtlasLedgerSetup-${version}.exe`,
    sha256: "a".repeat(64),
  };
}
