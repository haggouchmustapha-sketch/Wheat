const { test, expect, chromium } = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, expected, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let available = false;
    try { available = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch {}
    if (available === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`CDP endpoint did not become ${expected ? "available" : "unavailable"}.`);
}

async function connectPage(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
  return { browser, page };
}

async function runtimeTargetId(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.find((target) => target.type === "page")?.id ?? null;
}

async function connectNewRuntime(port, previousTargetId, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const targetId = await runtimeTargetId(port);
      if (targetId && targetId !== previousTargetId) return connectPage(port);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Electron did not expose a new renderer after restart.");
}

test("the installed-update modal appears once and Settings can manually check", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-updater-electron-"));
  const profile = path.join(temporary, "profile");
  const updaterDirectory = path.join(profile, "updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(path.join(updaterDirectory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    status: {
      phase: "updated",
      source: "local",
      currentVersion: "2.1.0",
      automaticInstallationEnabled: false,
      message: "Updated to 2.1.0",
    },
    lastSuccessfullyInstalledVersion: "2.1.0",
    notification: {
      version: "2.1.0",
      releaseDate: "2026-08-28",
      notes: ["Added automatic local updates", "Improved update recovery"],
      installedAt: "2026-08-28T00:00:00.000Z",
      consumed: false,
    },
  }));

  const token = `atlas-updater-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(electronExe, [root, `--remote-debugging-port=${port}`, `--${token}`], {
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: profile },
    stdio: "ignore",
    windowsHide: true,
  });
  let browser;
  try {
    await waitForCdp(port, true);
    let connected = await connectPage(port);
    browser = connected.browser;
    let page = connected.page;

    const updateDialog = page.getByRole("dialog", { name: "Wheat a été mis à jour" });
    await expect(updateDialog).toBeVisible({ timeout: 20000 });
    await expect(updateDialog).toContainText("Version 2.1.0");
    await expect(updateDialog).toContainText("Added automatic local updates");
    await updateDialog.getByRole("button", { name: "Fermer" }).click();
    await expect(updateDialog).toHaveCount(0);

    await expect(page.locator(".onboarding-shell")).toBeVisible();
    await page.getByLabel("Nom de la société").fill("UPDATE UI TEST SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    const checkButton = page.getByRole("button", { name: "Rechercher les mises à jour" });
    await checkButton.click();
    await expect(page.getByText("Wheat est à jour", { exact: true })).toBeVisible();

    const previousTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp(); });
    connected = await connectNewRuntime(port, previousTargetId);
    browser = connected.browser;
    page = connected.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("dialog", { name: "Wheat a été mis à jour" })).toHaveCount(0);
  } finally {
    try {
      if (browser?.isConnected()) {
        const page = browser.contexts()[0]?.pages()[0];
        await page?.evaluate(() => window.wheat.windowControl("close")).catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    } catch {}
    try { child.kill(); } catch {}
    try {
      const cleanup = `$token='${token.replace(/'/g, "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*--'+$token+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cleanup], { windowsHide: true, timeout: 15000 });
    } catch {}
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/**
 * The consent flow, in the real window.
 *
 * The property being pinned is that Wheat asks before it acts. A version that
 * has been found is *offered*; nothing is downloaded until the accountant says
 * so, and Wheat never closes itself. "Plus tard" is a first-class answer that
 * keeps the update available without interrupting again.
 */
test("an available update is offered and waits, and Plus tard stops interrupting", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-updater-consent-"));
  const profile = path.join(temporary, "profile");
  const updates = path.join(temporary, "updates");

  // A local feed standing in for a published GitHub release. The installer is
  // a placeholder: this test is about the decision, not about the bytes.
  const version = "99.0.0";
  const artifactName = `WheatSetup-${version}.exe`;
  const artifactBytes = Buffer.from("placeholder NSIS installer");
  fs.mkdirSync(path.join(updates, version), { recursive: true });
  fs.writeFileSync(path.join(updates, version, artifactName), artifactBytes);
  fs.writeFileSync(path.join(updates, "latest.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    releaseDate: "2026-09-03",
    notes: ["Import bancaire amélioré", "OCR amélioré", "Corrections de stabilité"],
    artifact: `${version}/${artifactName}`,
    sha256: require("node:crypto").createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSize: artifactBytes.length,
  }, null, 2));

  const token = `wheat-updater-consent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(electronExe, [root, `--remote-debugging-port=${port}`, `--${token}`], {
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: profile, WHEAT_UPDATES_DIR: updates },
    stdio: "ignore",
    windowsHide: true,
  });
  let browser;
  try {
    await waitForCdp(port, true);
    const connected = await connectPage(port);
    browser = connected.browser;
    const page = connected.page;

    // The launch check runs on its own, beside whatever the person is doing.
    const offer = page.getByRole("dialog", { name: "Une mise à jour de Wheat est disponible" });
    await expect(offer).toBeVisible({ timeout: 30000 });
    await expect(offer).toContainText(`Version ${version}`);
    await expect(offer).toContainText("Import bancaire amélioré");
    await expect(offer).toContainText("Corrections de stabilité");
    await expect(offer.getByRole("button", { name: "Plus tard" })).toBeVisible();
    await expect(offer.getByRole("button", { name: "Mettre à jour" })).toBeVisible();

    // Nothing was downloaded to reach this point: the offer is the whole of what
    // an unattended check is allowed to do.
    const beforeConsent = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(beforeConsent.phase).toBe("available");

    await offer.getByRole("button", { name: "Plus tard" }).click();
    await expect(offer).toHaveCount(0);

    // Still on offer, still not interrupting — and Wheat is still fully usable.
    const postponed = await page.evaluate(() => window.wheat.getUpdateStatus());
    expect(postponed).toMatchObject({ phase: "available", availableVersion: version, postponed: true });

    const rechecked = await page.evaluate(() => window.wheat.checkForUpdates());
    expect(rechecked.postponed).toBe(true);
    await expect(page.getByRole("dialog", { name: "Une mise à jour de Wheat est disponible" })).toHaveCount(0);
  } finally {
    try {
      if (browser?.isConnected()) {
        const page = browser.contexts()[0]?.pages()[0];
        await page?.evaluate(() => window.wheat.windowControl("close")).catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    } catch {}
    try { child.kill(); } catch {}
    try {
      const cleanup = `$token='${token.replace(/'/g, "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*--'+$token+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cleanup], { windowsHide: true, timeout: 15000 });
    } catch {}
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
