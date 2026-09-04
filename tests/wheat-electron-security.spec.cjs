const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("Electron enforces the renderer boundary and focuses the single trusted instance", async () => {
  test.setTimeout(45_000);
  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-security-"));
  const userDataDir = path.join(tempDir, "userData");
  const env = { ...process.env, WHEAT_USER_DATA_DIR: userDataDir };
  const atlas = await electron.launch({ executablePath: electronExe, args: [cwd], cwd, env });

  try {
    const page = await atlas.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15_000 });
    const originalUrl = page.url();
    await expect(page.getByText("Wheat", { exact: true }).first()).toBeVisible();

    await expect(page.evaluate(async () => Boolean(await window.wheat.getSecurityStatus()))).resolves.toBe(true);
    expect(await page.evaluate(() => window.open("https://example.com") === null)).toBe(true);

    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "https://example.com/atlas-escape";
      link.id = "security-navigation-probe";
      document.body.appendChild(link);
      link.click();
    });
    await page.waitForTimeout(200);
    expect(page.url()).toBe(originalUrl);
    await expect(page.evaluate(async () => Boolean(await window.wheat.getSecurityStatus()))).resolves.toBe(true);

    const geolocationResult = await page.evaluate(() => new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve("allowed"),
        (error) => resolve(`denied:${error.code}`),
        { timeout: 1_000 },
      );
    }));
    expect(geolocationResult).toBe("denied:1");

    await page.evaluate(() => window.wheat.windowControl("minimize"));
    await expect.poll(() => atlas.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true);

    const secondExit = new Promise((resolve, reject) => {
      const second = spawn(electronExe, [cwd], { cwd, env, stdio: "ignore" });
      const timeout = setTimeout(() => {
        second.kill();
        reject(new Error("The second Atlas process did not relinquish the single-instance lock."));
      }, 10_000);
      second.once("error", reject);
      second.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    await expect(secondExit).resolves.toBe(0);
    await expect.poll(() => atlas.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false);
  } finally {
    await atlas.close();
  }
});
