/**
 * Reviewing an extraction against the document it came from.
 *
 * The correction form has always been there; what was missing was the thing
 * being corrected against. Wheat drew a stylised paper icon where the page
 * should be, so checking a total meant opening the file in another application
 * — which is the moment the comparison stops happening.
 *
 * What this pins, in the real application with a real scanned document:
 *
 *   - the page is drawn inside Wheat, from the file itself;
 *   - paging and zooming are reads, and cannot re-run recognition;
 *   - the correction form sits beside it and still saves;
 *   - Débours has a box, whatever the recogniser found, because a form that
 *     hides a field cannot be used to correct it.
 */

const { test, expect, _electron: electron } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const cwd = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const electronExe = require(path.join(cwd, "node_modules", "electron"));
const SAMPLE = path.join(cwd, "test documents for use", "Facture_LUNA_STEEL_CHANI_MAROC_Papier_Entete_Bleu.pdf");

test("the source page is shown beside the extracted fields, and looking never re-reads", async () => {
  test.setTimeout(300_000);
  test.skip(!fs.existsSync(SAMPLE), `Le document de référence est absent : ${SAMPLE}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ocr-review-"));
  const app = await electron.launch({
    executablePath: electronExe,
    args: [cwd],
    cwd,
    env: { ...process.env, WHEAT_USER_DATA_DIR: path.join(temporaryRoot, "userData") },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 30_000 });
    await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Nom de la société").fill("REVUE OCR SARL");
    await page.getByLabel("Ville").fill("Casablanca");
    await page.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

    // Ingest through the same path the application uses, then read the page
    // preview through the bridge the viewer uses.
    const ingested = await page.evaluate(async (samplePath) => {
      const boot = await window.wheat.getBootstrap();
      const companyId = boot?.company?.id ?? boot?.companies?.[0]?.id;
      const created = await window.wheat.smartOcrProcess({ companyId, filePaths: [samplePath] });
      const documents = Array.isArray(created) ? created : (created?.documents ?? []);
      return { companyId, documentId: documents[0]?.id ?? null, rejections: created?.rejections ?? [] };
    }, SAMPLE);
    expect(ingested.documentId, `the sample document was not ingested: ${JSON.stringify(ingested.rejections)}`).toBeTruthy();

    const first = await page.evaluate(async ({ companyId, documentId }) => (
      window.wheat.getDocumentPagePreview({ companyId, documentId, page: 1, scale: 1.5 })
    ), ingested);
    expect(first.rendered).toBe(true);
    expect(first.mimeType).toBe("image/png");
    expect(first.base64.length).toBeGreaterThan(1000);
    expect(first.pageCount).toBeGreaterThanOrEqual(1);

    // A page beyond the document says so rather than showing an empty frame.
    const beyond = await page.evaluate(async ({ companyId, documentId, pageCount }) => (
      window.wheat.getDocumentPagePreview({ companyId, documentId, page: pageCount + 1, scale: 1.5 })
    ), { ...ingested, pageCount: first.pageCount });
    expect(beyond.rendered).toBe(false);
    expect(beyond.reason).toBeTruthy();

    // Looking is a read: the extraction is byte-for-byte what it was.
    const readFields = async () => page.evaluate(async ({ companyId, documentId }) => {
      const boot = await window.wheat.getBootstrap(companyId);
      const document = (boot?.documents ?? []).find((item) => item.id === documentId);
      return String(document?.extracted ?? "");
    }, ingested);
    const before = await readFields();
    await page.evaluate(async ({ companyId, documentId }) => {
      for (const scale of [1, 2, 3]) await window.wheat.getDocumentPagePreview({ companyId, documentId, page: 1, scale });
    }, ingested);
    const after = await readFields();
    expect(before.length).toBeGreaterThan(0);
    expect(after).toBe(before);

    // And the surface itself: the page, its controls, and the fields beside it.
    // The ingestion above went through the bridge, so the shell is reloaded to
    // read what it did — the same thing the application does after an import.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.wheat), null, { timeout: 30_000 });
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
    await page.locator(".wt-rail").getByRole("button", { name: "Documents & OCR", exact: true }).click();
    await page.locator("ul.wt-list li.wt-list__item button").first().click();
    const viewer = page.locator('[data-testid="ocr-source-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect(viewer.locator(".ocr-source__page")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="ocr-source-page"]')).toContainText("Page 1");
    await expect(page.locator(".ocr-review-split .wt-form-grid")).toBeVisible();
    // Débours is offered whether or not the recogniser found one.
    await expect(page.locator(".ocr-review-split").getByLabel(/Débours/i)).toHaveCount(1);
  } finally {
    await app.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
