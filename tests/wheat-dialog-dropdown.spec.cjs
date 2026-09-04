const { test, expect, _electron: electron } = require("@playwright/test");
const { openDossierForWork } = require("./wheat-ui-helpers.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption } = require("./wheat-ui-helpers.cjs");

/**
 * A Wheat combobox renders its option panel through a portal on <body>, so the
 * panel is outside the dialog element that opened it. A dialog's focus
 * containment must recognise the panel as part of its own surface: if it does
 * not, the integrated search bar loses focus on its first keystroke and the
 * dropdown becomes unusable inside every dialog in the application.
 */
test("a searchable dropdown stays usable inside a modal dialog", async () => {
  test.setTimeout(120000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-dialog-dropdown-"));
  let app;
  try {
    app = await electron.launch({
      executablePath: require("electron"),
      args: [process.cwd()],
      cwd: process.cwd(),
      env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(root, "userData") },
    });
    const page = await app.firstWindow();

    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 20000 });
    await page.getByLabel("Nom de la société").fill("DIALOGUE SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("textbox", { name: "ICE", exact: true }).fill("001234567890123");
    await page.getByRole("textbox", { name: "Identifiant fiscal", exact: true }).fill("IF-DIALOGUE");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this suite is about something else, so it opens it for work.
    await openDossierForWork(page);

    await page.locator(".wt-rail").getByRole("button", { name: "Écritures", exact: true }).click();
    await page.getByRole("banner").getByRole("button", { name: "Nouvelle écriture" }).click();
    const dialog = page.getByRole("dialog", { name: "Nouvelle écriture" });
    await expect(dialog).toBeVisible();

    // Typing in the panel's search bar must filter the list, and the keystrokes
    // must not leak into the dialog field that holds the initial focus.
    const account = dialog.getByRole("combobox", { name: "Compte de la ligne 1" });
    await account.click();
    const listbox = page.locator('[role="listbox"]').last();
    await expect(listbox).toBeVisible({ timeout: 10000 });
    const search = page.locator(".wt-select__search input");
    await search.fill("514100");
    await expect(search).toHaveValue("514100");
    await expect(listbox.locator('[role="option"]')).toHaveCount(1);
    await expect(listbox.locator('[role="option"]').first()).toContainText("514100");
    await expect(dialog.locator("#entry-piece")).toHaveValue("");

    // The keyboard path has to reach the same option, and the chosen value must
    // land on the field the dialog will submit.
    await search.press("Enter");
    await expect(listbox).toHaveCount(0);
    await expect(account).toContainText("514100");

    // A second combobox in the same dialog behaves identically.
    await chooseOption(page, dialog.getByRole("combobox", { name: "Compte de la ligne 2" }), { label: "711100" });
    await expect(dialog.getByRole("combobox", { name: "Compte de la ligne 2" })).toContainText("711100");

    // Escape closes the panel only, leaving the dialog open and focused.
    await account.click();
    await expect(page.locator('[role="listbox"]').last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await expect(dialog).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
