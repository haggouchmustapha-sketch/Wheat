const { test, expect, chromium } = require("@playwright/test");
const { openDossierForWork } = require("./wheat-ui-helpers.cjs");
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
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      available = response.ok;
    } catch {}
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
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}.`);
  const targets = await response.json();
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
  throw new Error("Electron did not expose a new renderer runtime after relaunch.");
}

test("a real Electron relaunch clears stale modal focus and restores keyboard input", async () => {
  test.setTimeout(120000);
  const port = await freePort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-21-real-restart-"));
  const token = `atlas-restart-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(electronExe, [root, `--remote-debugging-port=${port}`, `--${token}`], {
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "profile") },
    stdio: "ignore",
    windowsHide: true,
  });
  let browser;
  try {
    await waitForCdp(port, true, 30000);
    let connected = await connectPage(port);
    browser = connected.browser;
    let page = connected.page;
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("RESTART TEST SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".topbar .primary-button").click();
    const focusedBefore = page.getByPlaceholder("Référence de la pièce");
    await expect(focusedBefore).toBeFocused();
    await focusedBefore.fill("RESTART-PRE-1");

    const previousTargetId = await runtimeTargetId(port);
    await page.evaluate(() => { void window.wheat.restartApp().catch(() => undefined); return true; });
    connected = await connectNewRuntime(port, previousTargetId);
    browser = connected.browser;
    page = connected.page;
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".entry-modal")).toHaveCount(0);
    const focusState = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inert: document.body.hasAttribute("inert"), overflow: document.body.style.overflow, pointerEvents: document.body.style.pointerEvents }));
    expect(focusState.inert).toBe(false);
    expect(focusState.pointerEvents).toBe("");

    const globalSearch = page.locator(".topbar-search input");
    await globalSearch.fill("capital");
    await expect(globalSearch).toHaveValue("capital");
    await page.keyboard.press("Control+K");
    await expect(page.locator(".command-input input")).toBeFocused();
    await page.keyboard.type("atlas 2.1");
    await expect(page.locator(".command-input input")).toHaveValue("atlas 2.1");
    await page.keyboard.press("Escape");

    await page.locator(".wt-rail").getByRole("button", { name: "Comptes & états", exact: true }).click();
    await expect(page.locator(".fiscal-ws")).toBeVisible();
    const pcgeSearch = page.getByPlaceholder("Rechercher numéro, libellé ou arabe…");
    await pcgeSearch.fill("amortissement");
    await expect(pcgeSearch).toHaveValue("amortissement");
    await expect(page.locator(".fiscal-ws-table tbody tr").first()).toBeVisible();

    await page.locator(".topbar .primary-button").click();
    const labelAfter = page.getByPlaceholder("Ex : Facture client mars 2026");
    await labelAfter.fill("Saisie après redémarrage");
    await expect(labelAfter).toHaveValue("Saisie après redémarrage");
    await page.getByRole("button", { name: "Annuler" }).click();
  } finally {
    try {
      if (browser?.isConnected()) {
        const context = browser.contexts()[0];
        const page = context?.pages()[0];
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
