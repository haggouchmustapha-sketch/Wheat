const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDossierForWork, switchCompany, assertIsolatedProfile } = require("./wheat-ui-helpers.cjs");
const { startOllamaFixture } = require("./fixtures/ollama-server.cjs");
const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

test("switching dossiers isolates AI drafts and late replies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ai-isolation-"));
  const provider = await startOllamaFixture();
  let app;
  try {
    app = await electron.launch({ executablePath: path.join(root, "node_modules/electron/dist/electron.exe"), args: [root], cwd: root, env: { ...process.env, WHEAT_USER_DATA_DIR: directory, OLLAMA_HOST: provider.url } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat));
    await assertIsolatedProfile(page, directory);
    const companies = await page.evaluate(async () => {
      const result = [];
      for (const name of ["AUDIT DOSSIER A", "AUDIT DOSSIER B"]) {
        const company = await window.wheat.createCompany({ name, legalForm: "SARL", city: "Casablanca", fiscalYearStart: "2026-01-01", fiscalYearEnd: "2026-12-31", vatFrequency: "MONTHLY" });
        await window.wheat.selectWheatAiModel({ companyId: company.id, modelId: "ollama:wheat-test-text" });
        result.push(company);
      }
      return result;
    });
    for (const company of companies) await openDossierForWork(page, { companyId: company.id, reload: false });
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await switchCompany(page, "AUDIT DOSSIER A");
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Votre question à Wheat AI" });
    await composer.fill("Brouillon confidentiel du dossier A");
    await switchCompany(page, "AUDIT DOSSIER B");
    await expect(composer).toHaveValue("");
    await composer.fill("Brouillon du dossier B");
    await switchCompany(page, "AUDIT DOSSIER A");
    await expect(composer).toHaveValue("Brouillon confidentiel du dossier A");

    provider.hold();
    await page.locator(".wheat-ai-composer").getByRole("button", { name: /Envoyer/ }).click();
    await expect.poll(() => provider.requests.length).toBe(1);
    await switchCompany(page, "AUDIT DOSSIER B");
    provider.release();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("Brouillon du dossier B");
    await expect(page.locator(".wheat-ai-chat")).not.toContainText("Réponse synthétique du dossier A.");
    await expect(page.locator(".wheat-ai-chat")).not.toContainText("Brouillon confidentiel");
    await page.locator(".wheat-ai-composer").getByRole("button", { name: /Envoyer/ }).click();
    await expect.poll(() => provider.requests.length).toBe(2);
    expect(JSON.stringify(provider.requests[1].messages)).not.toContain("Brouillon confidentiel du dossier A");
    expect(JSON.stringify(provider.requests[1].messages)).toContain("Brouillon du dossier B");
  } finally {
    provider.release();
    await app?.close();
    await provider.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
