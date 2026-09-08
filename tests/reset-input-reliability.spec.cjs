const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption } = require("./wheat-ui-helpers.cjs");

test("emptying the app keeps text fields, dropdowns and focus usable without a restart", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ledger-reset-input-"));
  const rendererErrors = [];
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "userData") },
  });

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (entry) => { if (entry.type() === "error") rendererErrors.push(entry.text()); });
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });

    await page.evaluate(async () => {
      await window.wheat.createCompany({
        name: "RESET INPUT SOURCE SARL",
        legalForm: "SARL",
        ice: "001111111111111",
        taxId: "IF 111111",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
    });
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });

    await page.locator(".topbar-search input").fill("before reset");
    await expect(page.locator(".topbar-search input")).toHaveValue("before reset");
    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    await expect(page.getByRole("button", { name: "Vider l'application" })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Vider l'application" }).click();
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 20000 });

    const cleanState = await page.evaluate(() => ({
      inert: document.body.hasAttribute("inert"),
      ariaHidden: document.body.getAttribute("aria-hidden"),
      overflow: document.body.style.overflow,
      pointerEvents: document.body.style.pointerEvents,
      modalBackdrops: document.querySelectorAll(".modal-backdrop, .op-confirm-backdrop").length,
      disabledInputs: document.querySelectorAll("input:disabled, textarea:disabled, select:disabled").length,
      activeLabel: (document.activeElement?.labels?.[0]?.textContent
        ?? document.activeElement?.closest("label")?.textContent
        ?? document.activeElement?.getAttribute("aria-label")
        ?? "").trim(),
    }));
    expect(cleanState).toMatchObject({ inert: false, ariaHidden: null, overflow: "", pointerEvents: "", modalBackdrops: 0, disabledInputs: 0 });
    expect(cleanState.activeLabel).toContain("Nom de la société");

    const onboarding = page.locator(".onboarding-form");
    await onboarding.locator("#onboarding-name").click();
    await page.keyboard.type("RESET INPUT RESULT SARL");
    await onboarding.locator("#onboarding-city").click();
    await page.keyboard.type("Rabat");
    await onboarding.locator("#onboarding-ice").click();
    await page.keyboard.type("002222222222222");
    await onboarding.locator("#onboarding-tax").click();
    await page.keyboard.type("IF 222222");
    // Both pickers are Wheat comboboxes: open, drive with the keyboard, commit.
    await onboarding.locator("#onboarding-legal").click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await onboarding.locator("#onboarding-vat").click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(onboarding.locator("#onboarding-name")).toHaveValue("RESET INPUT RESULT SARL");
    await expect(onboarding.locator("#onboarding-legal")).toContainText("Auto-entrepreneur");
    await expect(onboarding.locator("#onboarding-vat")).toContainText("Trimestrielle");
    await onboarding.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });

    const search = page.locator(".topbar-search input");
    await search.click();
    await page.keyboard.type("after reset");
    await expect(search).toHaveValue("after reset");
    await search.evaluate((element) => element.blur());
    await page.keyboard.press("Control+N");
    const entryDialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await expect(entryDialog).toBeVisible();
    await entryDialog.getByPlaceholder("Référence de la pièce").click();
    await page.keyboard.type("RESET-001");
    await entryDialog.getByPlaceholder("Ex : Facture client mars 2026").click();
    await page.keyboard.type("Saisie après remise à zéro");
    await entryDialog.locator("#entry-journal").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(entryDialog.getByPlaceholder("Ex : Facture client mars 2026")).toHaveValue("Saisie après remise à zéro");
    await page.keyboard.press("Escape");
    await expect(entryDialog).toHaveCount(0);

    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    const language = page.locator("#settings-language");
    await chooseOption(page, language, { value: "en" });
    await expect(page.locator(".wt-rail").getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await chooseOption(page, language, { value: "fr" });
    await expect(page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true })).toBeVisible();
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/**
 * Resetting the workspace reloads the window, and the reload's first read can
 * land inside the tail of the reset that caused it. That read must wait for the
 * maintenance to finish rather than refuse — an accountant who resets the
 * workspace should get a loaded window, never "réessayez dans un instant".
 */
test("a read racing the tail of a workspace reset waits for it instead of refusing", async () => {
  test.setTimeout(120000);

  const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const electronExe = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-reset-race-"));
  const rendererErrors = [];
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "userData") },
  });

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (entry) => { if (entry.type() === "error") rendererErrors.push(entry.text()); });
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });

    // Reads fired against the reset itself, not merely after it: the window
    // that used to be refused is the one between the reset starting and its
    // last write landing.
    const outcomes = await page.evaluate(async () => {
      const api = window.wheat;
      const results = [];
      const record = async (label, run) => {
        try { await run(); results.push({ label, ok: true }); }
        catch (error) { results.push({ label, ok: false, message: String(error?.message ?? error) }); }
      };
      const reset = record("reset", () => api.resetWorkspace({ mode: "demo" }));
      const reads = [
        record("bootstrap-during", () => api.getBootstrap()),
        record("bootstrap-during-2", () => api.getBootstrap()),
      ];
      await Promise.all([reset, ...reads]);
      await record("bootstrap-after", () => api.getBootstrap());
      return results;
    });

    for (const outcome of outcomes) {
      expect(outcome.message ?? "", `${outcome.label} was refused`).not.toMatch(/maintenance/i);
      expect(outcome.ok, `${outcome.label} failed: ${outcome.message ?? ""}`).toBe(true);
    }

    // And the reload the reset triggers in the real app loads cleanly.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    expect(rendererErrors.filter((message) => /maintenance/i.test(message))).toEqual([]);
  } finally {
    await app.close();
  }
});
