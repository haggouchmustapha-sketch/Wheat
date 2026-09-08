/**
 * Driving a real Wheat window from Playwright.
 *
 * Electron is started as an ordinary child process with a remote debugging
 * port, and Playwright attaches to it over CDP. That is the only way to observe
 * the shipped renderer against the shipped main process — there is no DOM
 * harness in this repository, so anything that must be true *on screen* is
 * proven here or not at all.
 *
 * The awkward parts are the ones every such spec needs and none of them should
 * own privately:
 *
 *  - a relaunch replaces the renderer, so the old CDP target dies and a new one
 *    has to be waited for by identity rather than by sleeping;
 *  - `child.kill()` reaches the launcher, not always the Electron tree beneath
 *    it, so each run is tagged with a unique argument and any survivor bearing
 *    that tag is swept afterwards. A leaked Wheat holds the temporary profile
 *    open and the next spec fails for reasons that have nothing to do with it.
 */

const { chromium } = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const net = require("node:net");
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

/**
 * Starts Wheat against a throwaway profile. `env` adds to the inherited
 * environment; `WHEAT_USER_DATA_DIR` is set from `profile` so a spec can never
 * run against the developer's real `%APPDATA%\Wheat`.
 */
function launchWheat({ port, profile, env = {}, label = "wheat" }) {
  const token = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(electronExe, [root, `--remote-debugging-port=${port}`, `--${token}`], {
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: profile, ...env },
    stdio: "ignore",
    windowsHide: true,
  });
  return { child, token };
}

/** Closes the window politely, then makes sure nothing tagged with `token` survives. */
async function stopWheat({ browser, child, token }) {
  try {
    if (browser?.isConnected()) {
      const page = browser.contexts()[0]?.pages()[0];
      await page?.evaluate(() => window.wheat.windowControl("close")).catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  } catch {}
  try { child?.kill(); } catch {}
  try {
    const cleanup = `$token='${token.replace(/'/g, "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*--'+$token+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cleanup], { windowsHide: true, timeout: 15000 });
  } catch {}
}

module.exports = { root, freePort, waitForCdp, connectPage, runtimeTargetId, connectNewRuntime, launchWheat, stopWheat };
