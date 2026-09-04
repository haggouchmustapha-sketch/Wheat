const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("one-click Wheat AI Lite download verifies, infers, chats and uninstalls locally", async () => {
  test.skip(process.env.WHEAT_AI_LIVE_TEST !== "1", "Set WHEAT_AI_LIVE_TEST=1 to run the pinned multi-gigabyte model download.");
  test.setTimeout(30 * 60 * 1000);
  const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const suppliedProfile = process.env.WHEAT_AI_LIVE_PROFILE ? path.resolve(process.env.WHEAT_AI_LIVE_PROFILE) : null;
  const temporary = suppliedProfile ? path.dirname(suppliedProfile) : fs.mkdtempSync(path.join(os.tmpdir(), "atlas-21-ai-live-"));
  const profile = suppliedProfile ?? path.join(temporary, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: profile },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("ATLAS AI LIVE TEST SARL");
    await page.getByLabel("Ville").fill("Rabat");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });

    const result = await page.evaluate(async () => {
      const api = window.wheat;
      const companyId = (await api.getBootstrap()).companies[0].id;
      const before = await api.getWheatAiStatus({ companyId });
      const lite = before.models.find((model) => model.tier === "LITE");
      const installed = await api.installWheatAiModel({ companyId, modelId: lite.id, confirmed: true });
      const after = await api.getWheatAiStatus({ companyId });
      const chat = await api.chatWithWheatAi({ companyId, sessionId: "live-download", messages: [{ role: "user", content: "Réponds uniquement par OK." }] });
      const removed = await api.uninstallWheatAiModel({ companyId, modelId: lite.id, confirmed: true });
      const finalStatus = await api.getWheatAiStatus({ companyId });
      return {
        installed,
        chat,
        removed,
        runtimeInstalled: after.runtime.installed,
        modelInstalled: after.models.find((model) => model.id === lite.id)?.installed,
        settingsEnabled: after.settings?.enabled,
        finalModelInstalled: finalStatus.models.find((model) => model.id === lite.id)?.installed,
      };
    });

    expect(result.installed).toMatchObject({ installed: true, modelId: "qwen3-1.7b-q8-0" });
    expect(result.installed.runtimeHealth).toMatch(/version|b10516/i);
    expect(result.installed.testInference.length).toBeGreaterThan(0);
    expect(result.runtimeInstalled).toBe(true);
    expect(result.modelInstalled).toBe(true);
    expect(result.settingsEnabled).toBe(true);
    expect(result.chat).toMatchObject({ local: true, modelId: "qwen3-1.7b-q8-0", toolBoundary: "TYPED_TOOLS_ONLY" });
    expect(result.chat.text.length).toBeGreaterThan(0);
    expect(result.removed).toEqual({ uninstalled: true, recoverable: true });
    expect(result.finalModelInstalled).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    const approvedWorkspaceCleanup = path.resolve(temporary) === path.join(path.resolve(root), ".atlas-ai-live");
    if (!suppliedProfile || (process.env.WHEAT_AI_LIVE_CLEANUP === "1" && approvedWorkspaceCleanup)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});
