/**
 * Shared helpers for driving the Wheat 2.0 interface from Playwright.
 *
 * Wheat replaced its large native `<select>` elements with a searchable
 * combobox (`WheatSelect`). The value handed to the application is unchanged,
 * but the interaction is now: open the trigger, optionally type into the
 * integrated search bar, then click the matching `role="option"`.
 *
 * `chooseOption` covers both shapes, so a spec can keep expressing intent
 * ("pick this counterparty") without caring which control renders it.
 */

/**
 * Selects a value in either a Wheat combobox or a native `<select>`.
 *
 * @param page Playwright page.
 * @param control Locator for the combobox trigger or the `<select>`.
 * @param option `{ value }`, `{ label }`, `{ index }` or a plain string value.
 */
async function chooseOption(page, control, option) {
  const request = typeof option === "string" ? { value: option } : option;
  const tagName = await control.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");

  if (tagName === "select") {
    if (request.value !== undefined) return control.selectOption(request.value);
    if (request.label !== undefined) return control.selectOption({ label: request.label });
    return control.selectOption({ index: request.index });
  }

  await control.click();
  const listbox = page.locator('[role="listbox"]').last();
  await listbox.waitFor({ state: "visible", timeout: 10000 });

  if (request.value !== undefined) {
    // Every option carries its submitted value, so a spec can target the exact
    // record without depending on the rendered label.
    const byValue = listbox.locator(`[role="option"][data-value="${request.value}"]`);
    if (await byValue.count()) return byValue.first().click();
    // Long lists render a capped window; the search bar brings the rest in.
    const search = page.locator(".wt-select__search input");
    if (await search.count()) {
      await search.fill(String(request.value));
      if (await byValue.count()) return byValue.first().click();
      await search.fill("");
    }
    throw new Error(`No option matching value ${request.value}`);
  }

  if (request.label !== undefined) {
    const search = page.locator(".wt-select__search input");
    if (await search.count()) await search.fill(String(request.label));
    return listbox.locator('[role="option"]').filter({ hasText: request.label }).first().click();
  }

  return listbox.locator('[role="option"]').nth(request.index).click();
}

/**
 * Reads the submitted values a control offers, for either shape.
 *
 * The combobox renders its options in a portal, so the list only exists while
 * the panel is open; the panel is closed again so the caller is left with the
 * control exactly as it found it.
 */
async function optionValues(page, control) {
  const tagName = await control.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tagName === "select") {
    return control.locator("option").evaluateAll((options) => options.map((option) => option.value));
  }
  await control.click();
  const panel = page.locator(".wt-select__panel").last();
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const values = await panel
    .locator('[role="option"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-value")));
  await page.keyboard.press("Escape");
  return values;
}

/** Opens a dossier from the workspace header. */
async function switchCompany(page, companyName) {
  await chooseOption(page, page.locator('.company-switcher [role="combobox"]'), { label: companyName });
}

/** Reads the label currently shown by a Wheat combobox. */
async function selectedLabel(control) {
  return (await control.locator(".wt-select__value").first().innerText()).trim();
}

/**
 * Refuses to run a mutating spec against a profile that is not the temporary
 * one the spec created.
 *
 * A packaged Wheat resolves its profile from the Windows known folder for
 * AppData and then pins it to `%APPDATA%\Atlas Ledger` in the main process, on
 * purpose: the packaged runtime must not let an environment variable relocate
 * a user's books. The consequence for testing is that setting `APPDATA` in the
 * child environment isolates an unpackaged run but NOT a packaged one, where
 * the spec would quietly write test companies into the developer's real
 * accounting profile. This check turns that into an immediate, loud failure
 * before the first mutation instead of a silent one afterwards.
 *
 * @param page Playwright page with the Wheat bridge available.
 * @param temporaryDirectory The directory the spec owns.
 */
async function assertIsolatedProfile(page, temporaryDirectory) {
  const databasePath = await page.evaluate(() => window.wheat?.getDatabasePath?.() ?? null);
  if (!databasePath) throw new Error("Wheat did not report a database path; refusing to mutate an unknown profile.");
  const normalize = (value) => String(value).replace(/[\\/]+/g, "\\").toLowerCase();
  if (!normalize(databasePath).startsWith(normalize(temporaryDirectory))) {
    throw new Error(
      `This spec mutates accounting data and is not isolated: Wheat opened ${databasePath}, outside ${temporaryDirectory}. `
      + "A packaged Wheat ignores APPDATA by design, so run this spec against the unpackaged app (omit WHEAT_EXE).",
    );
  }
  return databasePath;
}


/**
 * Leaves the active dossier open for ordinary work.
 *
 * A newly created dossier stays in guided preparation until its accounting
 * foundation is approved, which is the product behaviour and is covered by
 * `wheat-dossier-setup.spec.cjs`. Suites that are about something else need a
 * dossier that is simply ready, and this is how they say so — through the same
 * bridge the gate's own button uses, so the fixture cannot drift from it.
 *
 * The reload is what a person approving through the gate would not need: the
 * gate refreshes its own state on approval, whereas a bridge call made from
 * outside the interface leaves the window holding the pre-approval view.
 */
async function openDossierForWork(page, { reload = true, companyId: target = null } = {}) {
  await page.evaluate(async (target) => {
    const boot = await window.wheat.getBootstrap();
    const companyId = target ?? boot.activeCompanyId;
    if (!companyId || !window.wheat.getDossierSetup) return;
    const setup = await window.wheat.getDossierSetup({ companyId });
    if (setup.mode === "UNLOCKED") return;
    if (!setup.situation) await window.wheat.setDossierSituation({ companyId, situation: "NEW" });
    await window.wheat.unlockDossier({ companyId });
  }, target);
  if (reload) {
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
  }
}

module.exports = { assertIsolatedProfile, chooseOption, openDossierForWork, optionValues, switchCompany, selectedLabel };
