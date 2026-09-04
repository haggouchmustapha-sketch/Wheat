/**
 * Wheat 2.1 release-blocking regressions.
 *
 * Every test here corresponds to a defect that shipped in 2.0 and had to be
 * fixed before 2.1. They are deliberately close to the root cause rather than
 * to the symptom, so a future refactor that reintroduces the cause fails here
 * even if the visible symptom happens to look different.
 */
const { test, expect, _electron: electron } = require("@playwright/test");
const { openDossierForWork } = require("./wheat-ui-helpers.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// The electron/ modules are TypeScript; `tsx` loads them in-process the same
// way every other Wheat unit spec does.
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

const loadModule = (name) => tsxRequire(path.join(root, "electron", `${name}.ts`), __filename);

function launch(extraEnv = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-21-"));
  return electron
    .launch({
      executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
      args: [root],
      cwd: root,
      env: {
        ...process.env,
        APPDATA: path.join(temporary, "appData"),
        LOCALAPPDATA: path.join(temporary, "localAppData"),
        WHEAT_USER_DATA_DIR: path.join(temporary, "userData"),
        ...extraEnv,
      },
    })
    .then((app) => ({ app, temporary }));
}

/* ------------------------------------------------------------------- TVA */

test("a valid TVA configuration saves, and only canonical rate directions are accepted", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });

    const outcome = await page.evaluate(async () => {
      const api = window.wheat;
      const company = await api.createCompany({
        name: "TVA DIRECTION SARL",
        legalForm: "SARL",
        city: "Casablanca",
        ice: "001589742000063",
        taxId: "IF 48291073",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
      const companyId = company.id;
      const base = {
        companyId,
        name: "TVA 2026",
        accountingBasis: "COLLECTION",
        filingFrequency: "MONTHLY",
        effectiveFrom: "2026-01-01",
        sourceReference: "CGI art. 95 - regime encaissement",
      };

      const results = {};
      // The three canonical directions the compliance service declares.
      for (const direction of ["COLLECTED", "DEDUCTIBLE", "BOTH"]) {
        try {
          const saved = await api.saveTaxConfigurationDraft({
            ...base,
            name: `TVA 2026 ${direction}`,
            rates: [{ code: `TVA20${direction.slice(0, 3)}`, label: "TVA 20 %", rateBps: 2000, direction, deductibilityBps: 10000 }],
          });
          results[direction] = { ok: true, id: saved?.id ?? saved?.configuration?.id ?? null };
        } catch (error) {
          results[direction] = { ok: false, message: String(error?.message ?? error) };
        }
      }

      // The localized label must NOT be accepted: it is what the renderer used
      // to send, and silently accepting it would hide the same class of bug.
      try {
        await api.saveTaxConfigurationDraft({
          ...base,
          name: "TVA 2026 LABEL",
          rates: [{ code: "TVALBL", label: "TVA 20 %", rateBps: 2000, direction: "Déductible", deductibilityBps: 10000 }],
        });
        results.localizedLabel = { ok: true };
      } catch (error) {
        results.localizedLabel = { ok: false, message: String(error?.message ?? error) };
      }
      return results;
    });

    expect(outcome.COLLECTED.ok, `COLLECTED: ${outcome.COLLECTED.message}`).toBe(true);
    expect(outcome.DEDUCTIBLE.ok, `DEDUCTIBLE: ${outcome.DEDUCTIBLE.message}`).toBe(true);
    expect(outcome.BOTH.ok, `BOTH: ${outcome.BOTH.message}`).toBe(true);
    expect(outcome.localizedLabel.ok).toBe(false);
    expect(outcome.localizedLabel.message).toMatch(/direction du taux/i);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("no renderer control submits a localized label where the service expects an enum", () => {
  // The 2.0 TVA failure was a find-and-replace that turned the canonical value
  // `DEDUCTIBLE` into its French label inside `<option value=...>`. An enum
  // value carrying an accent is the fingerprint of that mistake.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated" && entry.name !== "node_modules") walk(target);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(target, "utf8");
      for (const match of source.matchAll(/<option\s+value="([^"]*)"/g)) {
        if (/[À-ɏ]/.test(match[1])) offenders.push(`${path.relative(root, target)} → ${match[1]}`);
      }
    }
  };
  walk(path.join(root, "src"));
  expect(offenders).toEqual([]);
});

/* ---------------------------------------------------------------- Ollama */

test("Ollama discovery separates 'not installed' from 'installed but stopped'", async () => {
  const { listOllamaModels } = loadModule("wheatAi");

  const live = await listOllamaModels();
  expect(typeof live.available).toBe("boolean");
  expect(typeof live.installed).toBe("boolean");
  expect(typeof live.serviceStopped).toBe("boolean");
  // A reachable service can never be reported as stopped, and an unreachable
  // one can never be reported as available.
  expect(live.available && live.serviceStopped).toBe(false);
  if (live.available) {
    expect(live.baseUrl).toMatch(/^http:\/\//);
    for (const model of live.models) {
      expect(model.provider).toBe("OLLAMA");
      // Vision support is read from the provider, so it is always a decided
      // boolean rather than an absent field the UI would have to guess about.
      expect(typeof model.supportsVision).toBe("boolean");
    }
  }

  // An address nothing listens on must degrade, not throw.
  const previousHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "http://127.0.0.1:11";
  try {
    const unreachable = await listOllamaModels();
    expect(unreachable.available).toBe(false);
    expect(unreachable.models).toEqual([]);
    expect(typeof unreachable.error).toBe("string");
  } finally {
    if (previousHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previousHost;
  }
});

/* --------------------------------------------------- document understanding */

test("multi-page documents are read as one document, and the arithmetic is checked", async () => {
  const understanding = loadModule("ocrDocumentUnderstanding");

  const header = "FOURNISSEUR ALPHA SARL\nICE 001589742000063\nFACTURE F-2026-0041";
  const assembled = understanding.assembleDocument([
    { page: 1, text: `${header}\nDesignation Qte PU Total\nCable 10 100,00 1000,00`, confidence: 90, tables: [[["Designation", "Qte", "PU", "Total"], ["Cable", "10", "100,00", "1000,00"]]] },
    { page: 2, text: `${header}\nRouteur 2 500,00 1000,00\nTotal HT 2000,00`, confidence: 90, tables: [[["Routeur", "2", "500,00", "1000,00"]]] },
  ]);
  // The header is read once, not twice.
  expect(assembled.text.match(/FOURNISSEUR ALPHA SARL/g)).toHaveLength(1);
  expect(assembled.pageCount).toBe(2);
  // The table that continued onto page two is one table with one header row.
  expect(assembled.tables).toHaveLength(1);
  expect(assembled.tables[0]).toHaveLength(3);

  const balanced = understanding.reconcileAccountingAmounts({ ht: 1000, tva: 200, ttc: 1200, vatRateBps: 2000 });
  expect(balanced.checks.find((check) => check.id === "ht-plus-tva-equals-ttc").status).toBe("PASSED");
  expect(balanced.checks.find((check) => check.id === "vat-rate-consistent").status).toBe("PASSED");
  expect(balanced.fieldsNeedingReview).toEqual([]);

  const inconsistent = understanding.reconcileAccountingAmounts({ ht: 1000, tva: 200, ttc: 1500 });
  expect(inconsistent.checks.find((check) => check.id === "ht-plus-tva-equals-ttc").status).toBe("FAILED");
  expect(inconsistent.fieldsNeedingReview).toEqual(expect.arrayContaining(["ht", "tva", "ttc"]));

  // A rate Morocco does not levy is reported rather than accepted.
  const badRate = understanding.reconcileAccountingAmounts({ ht: 1000, tva: 130, ttc: 1130, vatRateBps: 1300 });
  expect(badRate.checks.find((check) => check.id === "vat-rate-statutory").status).toBe("FAILED");

  // Nothing is invented when the document only yielded one amount, and an
  // absent value is reported as missing rather than as a contradiction.
  const sparse = understanding.reconcileAccountingAmounts({ ttc: 1200 });
  expect(sparse.derivedFields).toEqual([]);
  expect(sparse.ht).toBeNull();
  expect(sparse.tva).toBeNull();
  expect(sparse.missingFields).toEqual(expect.arrayContaining(["ht", "tva"]));
  expect(sparse.fieldsNeedingReview).toEqual([]);

  // Exactly one amount may be derived, and only from two that were read.
  const derived = understanding.reconcileAccountingAmounts({ ht: 1000, tva: 200 }, { derive: true });
  expect(derived.derivedFields).toEqual(["ttc"]);
  expect(derived.ttc).toBe(1200);
});

test("the AI review may re-read a document but never compose one", async () => {
  const review = loadModule("ocrAiReview");
  const text = "FACTURE F-2026-0041\nFournisseur: ALPHA DISTRIBUTION SARL\nICE 001589742000063\nTotal TTC 1 200,00 MAD";

  const grounded = await review.reviewDocumentWithAi(
    { text, documentType: "INVOICE", fields: { supplier: { value: null, confidence: 0 }, invoiceNumber: { value: null, confidence: 0 } } },
    async () => ({
      text: JSON.stringify({
        supplier: { value: "ALPHA DISTRIBUTION SARL", evidence: "Fournisseur: ALPHA DISTRIBUTION SARL" },
        invoiceNumber: { value: "F-2026-0041", evidence: "FACTURE F-2026-0041" },
        // Present in the reply, absent from the document: must be dropped.
        ice: { value: "999999999999999", evidence: "invented" },
      }),
      provider: "OLLAMA",
      modelId: "ollama:test",
    }),
  );
  expect(grounded.fields.supplier.value).toBe("ALPHA DISTRIBUTION SARL");
  expect(grounded.fields.invoiceNumber.value).toBe("F-2026-0041");
  expect(grounded.fields.ice).toBeUndefined();
  expect(grounded.fields.supplier.source).toBe("ai-review");

  // A confident recognised value is contested, never overwritten.
  const contested = await review.reviewDocumentWithAi(
    { text, documentType: "INVOICE", fields: { invoiceNumber: { value: "F-2026-0041", confidence: 92 } } },
    async () => ({ text: JSON.stringify({ invoiceNumber: { value: "1 200,00" } }), provider: "OLLAMA", modelId: "ollama:test" }),
  );
  expect(contested.fields.invoiceNumber).toBeUndefined();
  expect(contested.disagreements).toHaveLength(1);

  // A provider failure leaves the OCR result untouched.
  const failed = await review.reviewDocumentWithAi(
    { text, documentType: "INVOICE", fields: {} },
    async () => { throw new Error("provider offline"); },
  );
  expect(failed.applied).toBe(false);
  expect(failed.fields).toEqual({});
});

/* ------------------------------------------------------------- Wheat AI UI */

test("the Wheat AI conversation survives navigation and is cleared only on request", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    await page.evaluate(async () => {
      await window.wheat.createCompany({
        name: "WHEAT AI SESSION SARL",
        legalForm: "SARL",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
    });
    // A new dossier stays in guided preparation until its foundation is
    // approved; these tests are about the assistant, so they open it for work.
    await openDossierForWork(page, { reload: false });
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });

    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    await expect(page.locator(".wheat-ai-workspace")).toBeVisible({ timeout: 20000 });

    const composer = page.locator(".wheat-ai-composer textarea");
    await composer.click();
    await page.keyboard.type("Question restee en cours de redaction");
    await expect(composer).toHaveValue("Question restee en cours de redaction");

    // Leave for another workspace and come back: the draft is still there.
    await page.locator(".wt-rail").getByRole("button", { name: "Réglages", exact: true }).click();
    await expect(page.locator(".wheat-ai-workspace")).toHaveCount(0);
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    await expect(page.locator(".wheat-ai-composer textarea")).toHaveValue("Question restee en cours de redaction");

    // "Nouvelle conversation" is the explicit way to clear it.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Nouvelle conversation/ }).click();
    await expect(page.locator(".wheat-ai-composer textarea")).toHaveValue("");
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the empty Wheat AI conversation is a designed empty state, not a chat bubble", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    await page.evaluate(async () => {
      await window.wheat.createCompany({
        name: "WHEAT AI EMPTY SARL",
        legalForm: "SARL",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
    });
    // A new dossier stays in guided preparation until its foundation is
    // approved; these tests are about the assistant, so they open it for work.
    await openDossierForWork(page, { reload: false });
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();

    const welcome = page.locator(".wheat-ai-welcome");
    await expect(welcome).toBeVisible({ timeout: 20000 });

    const look = await welcome.evaluate((node) => {
      const style = getComputedStyle(node);
      const parent = node.parentElement;
      return {
        borderLeftWidth: style.borderLeftWidth,
        background: style.backgroundColor,
        parentBackground: parent ? getComputedStyle(parent).backgroundColor : "",
        widthRatio: node.getBoundingClientRect().width / (parent ? parent.getBoundingClientRect().width : 1),
      };
    });
    // The grey block was a chat bubble's tint, left border and 88% cap applied
    // to the empty state by a selector that did not exclude it.
    expect(look.borderLeftWidth).toBe("0px");
    expect(look.background).toBe(look.parentBackground);
    expect(look.widthRatio).toBeGreaterThan(0.9);

    // The starters and the title are what the user sees instead.
    await expect(page.locator(".wheat-ai-starters .wt-chip").first()).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- viewport */

test("a short window keeps the whole first-run form reachable", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    const window_ = await app.browserWindow(page);
    await window_.evaluate((win) => win.setSize(1120, 760));
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 20000 });

    const reach = await page.evaluate(() => {
      const shell = document.querySelector(".onboarding-shell");
      const submit = document.querySelector(".onboarding-form button[type='submit']");
      const heading = document.querySelector(".wt-onboard__title");
      if (!shell || !submit || !heading) return null;
      // The top of the card must be reachable: a centred flex item that
      // overflows pushes its top above the scroll origin, where nothing can
      // bring it back.
      shell.scrollTop = 0;
      const topVisible = heading.getBoundingClientRect().top >= -1;
      shell.scrollTop = shell.scrollHeight;
      const submitBox = submit.getBoundingClientRect();
      return {
        topVisible,
        submitVisible: submitBox.bottom <= window.innerHeight + 1 && submitBox.top >= 0,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    expect(reach).not.toBeNull();
    expect(reach.topVisible).toBe(true);
    expect(reach.submitVisible).toBe(true);
    expect(reach.horizontalOverflow).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------- version */

test("every version location agrees on 2.1.260901", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  expect(packageMetadata.version).toBe("2.1.260901");
  expect(packageMetadata.build.artifactName).toContain("${version}");

  // electron-builder writes a stripped package.json for the shipped asar, and
  // has been observed writing it back over this file as well, leaving a repo
  // that can no longer build or test itself. The manifest has to still be the
  // development one after a release, not the packaged one.
  expect(Object.keys(packageMetadata.scripts ?? {})).toEqual(
    expect.arrayContaining(["build", "installer", "test:desktop", "db:reset", "lint"]),
  );
  expect(Object.keys(packageMetadata.devDependencies ?? {}).length).toBeGreaterThan(10);
  expect(packageMetadata.build.win.target[0].target).toBe("nsis");

  const appVersion = fs.readFileSync(path.join(root, "src", "appVersion.ts"), "utf8");
  // The renderer must derive its version, never restate it.
  expect(appVersion).toMatch(/packageMetadata\.version/);
  expect(appVersion).not.toMatch(/"2\.\d+\.\d+"/);
});

/* --------------------------------------------------- image attachments */

test("the image attachment control follows the model's declared vision support", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });
    const companyId = await page.evaluate(async () => {
      const created = await window.wheat.createCompany({
        name: "WHEAT AI VISION SARL",
        legalForm: "SARL",
        city: "Casablanca",
        fiscalYearStart: "2026-01-01",
        fiscalYearEnd: "2026-12-31",
        vatFrequency: "MONTHLY",
      });
      return created.id;
    });
    // A new dossier stays in guided preparation until its foundation is
    // approved; this test is about the composer, so it opens it for work.
    await openDossierForWork(page);

    // No model selected: the composer offers no attachment control at all,
    // rather than a disabled button that explains nothing.
    await page.evaluate(async (id) => window.wheat.selectWheatAiModel({ companyId: id, modelId: "" }), companyId);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
    await expect(page.locator(".wheat-ai-composer")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".wheat-ai-composer input[type='file']")).toHaveCount(0);

    const models = await page.evaluate(async (id) => {
      const status = await window.wheat.getWheatAiStatus({ companyId: id });
      return (status.models ?? []).filter((model) => model.installed && model.chatReady);
    }, companyId);

    const vision = models.find((model) => model.supportsVision === true);
    const textOnly = models.find((model) => model.supportsVision !== true);

    if (vision) {
      await page.evaluate(async ({ id, modelId }) => window.wheat.selectWheatAiModel({ companyId: id, modelId }), { id: companyId, modelId: vision.id });
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
      await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
      await expect(page.locator(".wheat-ai-composer input[type='file']")).toHaveCount(1, { timeout: 20000 });
      await expect(page.locator(".wheat-ai-composer").getByRole("button", { name: "Image" })).toBeVisible();
    }

    if (textOnly) {
      await page.evaluate(async ({ id, modelId }) => window.wheat.selectWheatAiModel({ companyId: id, modelId }), { id: companyId, modelId: textOnly.id });
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
      await page.locator(".wt-rail").getByRole("button", { name: "Wheat AI", exact: true }).click();
      await expect(page.locator(".wheat-ai-composer")).toBeVisible({ timeout: 20000 });
      await expect(page.locator(".wheat-ai-composer input[type='file']")).toHaveCount(0);

      // The hidden control is a convenience; the refusal is the boundary.
      const refusal = await page.evaluate(async ({ id, modelId }) => {
        try {
          await window.wheat.chatWithWheatAi({
            companyId: id,
            modelId,
            messages: [{
              role: "user",
              content: "Lis cette image.",
              images: [{ mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }],
            }],
          });
          return null;
        } catch (error) {
          return String(error?.message ?? error);
        }
      }, { id: companyId, modelId: textOnly.id });
      expect(refusal).toMatch(/n'accepte pas d'image/i);
    }

    expect(models.length, "no Ollama or provider model was available to exercise capability gating").toBeGreaterThan(0);

    // Attachment validation is independent of which model is selected: an
    // unsupported format never reaches a provider, whatever its capabilities.
    const rejected = await page.evaluate(async ({ id, modelId }) => {
      try {
        await window.wheat.chatWithWheatAi({
          companyId: id,
          modelId,
          messages: [{ role: "user", content: "Lis ce fichier.", images: [{ mimeType: "image/gif", base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }] }],
        });
        return null;
      } catch (error) {
        return String(error?.message ?? error);
      }
    }, { id: companyId, modelId: (vision ?? textOnly ?? models[0]).id });
    expect(rejected).toMatch(/PNG, JPG ou WebP/i);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ first launch */

test("a cold start produces a visible, keyboard-ready window", async () => {
  const { app, temporary } = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 20000 });

    const window_ = await app.browserWindow(page);
    // The window is created hidden and revealed once the renderer can paint;
    // by the time the bridge answers it must be on screen.
    await expect.poll(async () => window_.evaluate((win) => win.isVisible()), { timeout: 20000 }).toBe(true);

    // Both halves of Windows keyboard focus. `isFocused()` alone was true in
    // 2.0 while `webContents.isFocused()` was false, which is exactly the state
    // where an input can be clicked but not typed into.
    const focus = await window_.evaluate((win) => ({
      window: win.isFocused(),
      contents: win.webContents.isFocused(),
    }));
    if (focus.window) expect(focus.contents).toBe(true);

    // And the renderer agrees that a focused input receives keystrokes.
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 20000 });
    const name = page.getByLabel("Nom de la société");
    await name.click();
    await page.keyboard.type("COLD START SARL");
    await expect(name).toHaveValue("COLD START SARL");
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
