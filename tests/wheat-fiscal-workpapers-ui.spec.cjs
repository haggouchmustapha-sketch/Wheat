const { test, expect, _electron: electron } = require("@playwright/test");
const { openDossierForWork } = require("./wheat-ui-helpers.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("normal liasse selector, editing, locks, N/A, persistence, responsive layout and dark mode", async () => {
  test.setTimeout(180000);
  const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fiscal-ui-"));
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporary, "profile") },
  });
  try {
    const page = await app.firstWindow();
    const rendererErrors = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 15000 });
    await page.getByLabel("Nom de la société").fill("ATLAS LIASSE UI SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".wt-rail").getByRole("button", { name: "Liasse fiscale", exact: true }).click();
    await page.getByRole("button", { name: "Préparer la liasse fiscale" }).click();
    await expect(page.getByRole("heading", { name: /tableaux complets sur 25/i })).toBeVisible({ timeout: 30000 });

    const selector = page.locator('.fiscal-ws-liasse-picker [role="combobox"]');
    await selector.focus();
    await page.keyboard.press("ArrowDown");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option")).toHaveCount(28);
    await expect(listbox.getByRole("group", { name: "1 - Bilan" })).toBeVisible();
    await expect(listbox.getByRole("group", { name: "2 - CPC" })).toBeVisible();
    await page.keyboard.press("End");
    await expect(listbox.getByRole("option", { name: /25 - Principales méthodes/ })).toHaveClass(/is-active/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "25 - Principales méthodes d'évaluation spécifiques à l'entreprise" })).toBeVisible({ timeout: 30000 });

    await page.getByRole("button", { name: "Ajouter une ligne" }).click();
    await page.getByLabel("Nature ligne 1").fill("Stocks");
    await page.getByLabel("Description de la méthode ligne 1").fill("Coût moyen documenté");
    await page.getByLabel("Source / référence ligne 1").fill("PV inventaire 2026");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Marquer revu" }).click();
    await expect(page.locator(".fiscal-ws-workpaper-status")).toHaveText("Revu");
    await expect(page.getByLabel("Nature ligne 1")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Réouvrir avec motif" })).toBeEnabled();

    await page.getByRole("button", { name: "Réouvrir avec motif" }).click();
    await page.getByLabel("Motif de réouverture").fill("Correction de méthode");
    await page.getByRole("button", { name: "Confirmer la réouverture" }).click();
    await expect(page.locator(".fiscal-ws-workpaper-status")).toHaveText("Brouillon");
    await page.getByRole("button", { name: "Non applicable" }).click();
    await page.getByLabel("Motif de non-applicabilité").fill("Aucune méthode spécifique applicable");
    await page.getByRole("button", { name: "Confirmer la non-applicabilité" }).click();
    await expect(page.locator(".fiscal-ws-workpaper-status")).toHaveText("Non applicable");
    await expect(page.getByRole("button", { name: "Réouvrir avec motif" })).toBeEnabled();

    await expect(page.getByRole("tab", { name: /Wheat AI/ })).toHaveCount(0);
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    await expect(page.locator(".wheat-ai-workspace")).toBeVisible();
    await page.locator(".wt-rail").getByRole("button", { name: "Liasse fiscale", exact: true }).click();
    await page.getByRole("button", { name: "Préparer la liasse fiscale" }).click();
    await expect(page.getByRole("heading", { name: "25 - Principales méthodes d'évaluation spécifiques à l'entreprise" })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Réouvrir avec motif" }).click();
    await page.getByLabel("Motif de réouverture").fill("Réactivation documentée");
    await page.getByRole("button", { name: "Confirmer la réouverture" }).click();
    await expect(page.locator(".fiscal-ws-workpaper-status")).toHaveText("Brouillon");

    await selector.click();
    await expect(listbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(selector).toBeFocused();

    await page.setViewportSize({ width: 640, height: 760 });
    await selector.click();
    const menuBox = await listbox.boundingBox();
    expect(menuBox.width).toBeLessThanOrEqual(608);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /le mode sombre/ }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator(".fiscal-ws-liasse-workspace")).toBeVisible();
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
