const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption, optionValues } = require("./wheat-ui-helpers.cjs");

async function launchIsolatedAtlas() {
  const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-fiscal-inputs-"));
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "profile") },
  });
  return { app, temporary };
}

async function createCompanyWithKeyboard(page, name) {
  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
  const form = page.locator(".onboarding-form");
  await form.locator("#onboarding-name").click();
  await page.keyboard.type(name);
  await form.locator("#onboarding-city").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Rabat");
  await form.locator("#onboarding-ice").click();
  await page.keyboard.type("003333333333333");
  await form.locator("#onboarding-tax").click();
  await page.keyboard.type("IF 333333");
  // Forme juridique and Déclaration de TVA are Wheat searchable comboboxes.
  await form.locator("#onboarding-legal").click();
  await page.getByRole("option", { name: /^SAS/ }).click();
  await form.locator("#onboarding-vat").click();
  await page.getByRole("option", { name: /Trimestrielle/ }).click();
  await expect(form.locator("#onboarding-name")).toHaveValue(name);
  await expect(form.locator("#onboarding-city")).toHaveValue("Rabat");
  await expect(form.locator("#onboarding-legal")).toContainText("SAS");
  await form.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
}

test("one font, company inputs, fiscal package and Wheat AI model input remain usable", async () => {
  test.setTimeout(180000);
  const { app, temporary } = await launchIsolatedAtlas();
  const rendererErrors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (entry) => { if (entry.type() === "error") rendererErrors.push(entry.text()); });
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await createCompanyWithKeyboard(page, "INPUT RELIABILITY SAS");

    const fonts = await page.locator("body *").evaluateAll((elements) => [...new Set(elements.filter((element) => element.getClientRects().length > 0).map((element) => getComputedStyle(element).fontFamily))]);
    expect(fonts).toEqual(["Inter", 'Georgia, "Times New Roman", "Noto Serif", serif']);

    await page.getByRole("button", { name: "Nouveau dossier" }).click();
    const companyDialog = page.getByRole("dialog", { name: "Créer un dossier" });
    await companyDialog.locator("#company-name").click();
    await page.keyboard.type("SECOND COMPANY SARL");
    await companyDialog.getByLabel("Forme juridique").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SARL AU");
    await chooseOption(page, companyDialog.locator("#company-year"), { index: 2 });
    await chooseOption(page, companyDialog.locator("#company-vat"), { value: "QUARTERLY" });
    await expect(companyDialog.locator("#company-name")).toHaveValue("SECOND COMPANY SARL");
    await expect(companyDialog.getByLabel("Forme juridique")).toHaveValue("SARL AU");
    await page.keyboard.press("Escape");
    await expect(companyDialog).toHaveCount(0);

    // A dossier stays in guided preparation until its accounting foundation is
    // approved, so the fiscal package is not reachable before that. This test
    // is about input reliability rather than the setup gate, so it approves the
    // foundation through the same bridge the gate's own button uses.
    await page.evaluate(async () => {
      const boot = await window.wheat.getBootstrap();
      await window.wheat.setDossierSituation({ companyId: boot.activeCompanyId, situation: "NEW" });
      await window.wheat.unlockDossier({ companyId: boot.activeCompanyId });
    });
    // Approving through the bridge rather than the gate's own button leaves the
    // window holding the pre-approval state; a reload is the honest way to pick
    // it up in a test that is not exercising the gate itself.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Liasse fiscale", exact: true }).click();
    await expect(page.getByRole("heading", { name: "25 tableaux traçables" })).toBeVisible();
    await chooseOption(page, page.getByRole("combobox", { name: "Régime fiscal" }), { value: "SIMPLIFIED" });
    await page.getByRole("button", { name: "Préparer la liasse fiscale" }).click();
    await expect(page.getByText("Résultat fiscal calculé")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Libellé de l'ajustement").click();
    await page.keyboard.type("Charge à vérifier");
    await page.getByLabel("Montant de l'ajustement").click();
    await page.keyboard.type("125,50");
    await page.getByLabel("Référence légale").click();
    await page.keyboard.type("Référence de test à valider");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Ajouter au brouillon" }).click();
    await expect(page.getByRole("cell", { name: "Charge à vérifier" })).toBeVisible({ timeout: 15000 });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Vérifier" }).click();
    await expect(page.locator(".fiscal-ws-adjustment-verified")).toContainText("Vérifié");

    await page.getByRole("button", { name: "Wheat AI" }).click();
    const modelPicker = page.getByLabel("Modèle Wheat AI");
    await expect(modelPicker).toBeVisible({ timeout: 20000 });
    // Model discovery probes the local runtime first; the picker stays disabled
    // until that probe settles, which takes longer on a machine without Ollama.
    await expect(modelPicker).toBeEnabled({ timeout: 30000 });
    // The picker lists whatever Wheat AI can actually reach on this machine:
    // local Ollama models when a runtime is installed, remote free models when
    // a provider key is configured. The control has to stay usable and honest
    // in both cases, so the test drives whatever is offered instead of
    // requiring a local model server.
    const modelIds = await optionValues(page, modelPicker);
    if (modelIds.length) {
      const chosenModelId = modelIds.find((value) => value.startsWith("ollama:")) ?? modelIds[0];
      await chooseOption(page, modelPicker, { value: chosenModelId });
      await expect(modelPicker).toContainText(/\S/);
    } else {
      await modelPicker.click();
      await expect(page.locator(".wt-select__panel")).toContainText("Aucun modèle disponible sur ce poste");
      await page.keyboard.press("Escape");
    }
    const prompt = page.getByLabel("Votre question à Wheat AI");
    await prompt.click();
    await page.keyboard.type("Explique la différence entre balance et bilan.");
    await expect(prompt).toHaveValue("Explique la différence entre balance et bilan.");
    // Sending stays blocked until a model is actually ready, which is the
    // honest state on a machine with no model installed and no provider key.
    const send = page.getByRole("button", { name: "Envoyer" });
    await expect(send).toBeVisible();
    if (modelIds.length) await expect(send).toBeEnabled();
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Wheat AI completes a real local Ollama response and exposes only final content", async () => {
  test.skip(process.env.WHEAT_OLLAMA_LIVE_TEST !== "1", "Set WHEAT_OLLAMA_LIVE_TEST=1 to exercise an installed Ollama model.");
  test.setTimeout(10 * 60 * 1000);
  const { app, temporary } = await launchIsolatedAtlas();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await createCompanyWithKeyboard(page, "OLLAMA LIVE TEST SARL");
    const result = await page.evaluate(async () => {
      const api = window.wheat;
      const companyId = (await api.getBootstrap()).companies[0].id;
      const status = await api.getWheatAiStatus({ companyId });
      const model = status.models.find((item) => item.id === "ollama:qwen3.5:9b-q8_0") ?? status.models.find((item) => item.provider === "OLLAMA");
      if (!model) throw new Error("No Ollama model was discovered.");
      await api.selectWheatAiModel({ companyId, modelId: model.id });
      const chat = await api.chatWithWheatAi({ companyId, modelId: model.id, messages: [{ role: "user", content: "Réponds uniquement par OK." }] });
      return { model, chat };
    });
    expect(result.model.provider).toBe("OLLAMA");
    expect(result.chat).toMatchObject({ local: true, provider: "OLLAMA", modelId: result.model.id });
    expect(result.chat.text.trim().length).toBeGreaterThan(0);
    expect(result.chat.text).not.toMatch(/<think>|<analysis>|Thinking:/i);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
