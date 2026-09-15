const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { root, builtEdition, freePort, waitForCdp, connectPage, launchWheat, stopWheat } = require("./wheat-electron-harness.cjs");

/**
 * The edition, in a real running Wheat.
 *
 * Every other edition test reads source or configuration. This one starts the
 * application that was actually built and asks it what it is — from the main
 * process, from the renderer, and from the document element the visual profile
 * hangs off. It is the check that the compiled constant survives three
 * different bundles and arrives intact in all of them.
 *
 * It asserts against **whichever edition is currently built**, so the same spec
 * proves both:
 *
 *   npm run build:standard     && npx playwright test tests/wheat-edition-electron.spec.cjs
 *   npm run build:lightweight  && npx playwright test tests/wheat-edition-electron.spec.cjs
 */

test("the built edition reaches the main process, the renderer and the document", async () => {
  test.setTimeout(150_000);
  const edition = builtEdition();
  test.skip(!edition, "no build to inspect; run npm run build:standard or build:lightweight first");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-edition-run-"));
  const port = await freePort();
  const launched = launchWheat({ port, profile, label: "edition" });
  let browser;
  try {
    await waitForCdp(port, true);
    ({ browser } = await connectPage(port));
    const page = browser.contexts()[0].pages()[0];

    // 1. The main process, through the one controlled channel.
    const reported = await page.evaluate(() => window.wheat.getAppEdition());
    expect(reported.edition).toBe(edition);
    expect(reported.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(reported.label).toMatch(edition === "standard" ? /Standard/ : /Lightweight/);

    // 2. The renderer bundle, which compiled the same constant independently.
    const stamped = await page.evaluate(() => document.documentElement.dataset.wheatEdition);
    expect(stamped).toBe(edition);

    // 3. And they agree, which is what actually matters: a renderer built as
    //    one edition inside a main process built as another would look correct
    //    from either side alone.
    expect(stamped).toBe(reported.edition);

    // 4. The recognition plan the running build will actually use.
    const ocr = await page.evaluate(() => window.wheat.getPaddleOcrStatus());
    expect(ocr.edition).toBe(edition);
    if (edition === "standard") {
      expect(ocr.engineOrder[0]).toBe("paddle");
      expect(reported.hasBundledLocalOcr).toBe(true);
    } else {
      // No local recognition runtime is packaged, so the first engine is the
      // cloud and the local Tesseract fallback is behind it.
      expect(ocr.engineOrder[0]).toBe("cloud");
      expect(ocr.engineOrder).toContain("tesseract");
      expect(ocr.available).toBe(false);
      expect(ocr.reason).toMatch(/n'embarque pas le moteur de reconnaissance local/i);
      expect(reported.hasBundledLocalOcr).toBe(false);
    }

    // 5. Accounting is reachable and identical in either edition: the dossier
    //    bootstrap answers, which is the whole application behind it.
    const bootstrap = await page.evaluate(() => window.wheat.getBootstrap());
    expect(bootstrap).toBeTruthy();
    expect(bootstrap.appVersion).toBe(reported.version);
  } finally {
    await stopWheat({ browser, ...launched });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
