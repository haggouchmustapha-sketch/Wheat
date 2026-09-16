/**
 * Wheat working, and looking like it.
 *
 * Several things Wheat does on demand take seconds or minutes: a full dossier
 * backup, a restore, reading a scanned statement through the local OCR
 * sidecar, recognising a batch of documents, reading every book for a Sage
 * export. An operation that shows nothing while it runs is indistinguishable
 * from a frozen application, and the ordinary response to a frozen application
 * is to press the button again.
 *
 * Two rules are pinned here, because both were broken somewhere:
 *
 *   1. Every slow surface says *what* it is doing, not merely that something
 *      is happening. The strings are asserted literally so that deleting the
 *      status text is a test failure rather than a silent regression.
 *   2. A loading flag that is raised is lowered in a `finally`. A failure must
 *      resolve the loading state; otherwise a refused operation leaves the
 *      screen busy forever over an error the person has already dismissed.
 *
 * And one thing that must stay absent: an invented percentage. None of these
 * operations reports how far along it is, so none of them draws a bar.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

/*
 * Everything that still runs when the operation failed: a `finally` block, and
 * the promise form `.finally(...)`. Both discharge the obligation; only
 * clearing a flag on the success path does not.
 */
function failureSafeBodies(source) {
  const blocks = [...source.matchAll(/finally\s*\{([\s\S]{0,600}?)\n\s*\}/g)].map((match) => match[1]);
  const promises = [...source.matchAll(/\.finally\(([\s\S]{0,600}?)\n\s*\}\)/g)].map((match) => match[1]);
  return [...blocks, ...promises].join("\n");
}

const APP = read("src", "App.tsx");
const OPERATIONAL = read("src", "components", "OperationalAccounting.tsx");

test("the slow surfaces say what Wheat is doing", () => {
  // A dossier backup copies the database and every stored document; a restore
  // replaces them. Both used to run behind a button that never changed.
  expect(APP).toContain("Sauvegarde du dossier en cours…");
  expect(APP).toContain("Restauration de la sauvegarde…");
  // Reading a scanned statement goes through the OCR sidecar and can take a
  // minute with nothing on screen at all.
  expect(APP).toContain("Analyse du relevé bancaire…");
  // Already present before this pass; asserted so they cannot quietly go away.
  expect(APP).toContain("Lecture complète des livres comptables…");
  expect(OPERATIONAL).toContain("Recherche de rapprochements possibles…");
});

test("the shared indicator is a status region, not an alert that steals focus", () => {
  const banner = APP.slice(APP.indexOf("function RunningTaskBanner"), APP.indexOf("function ToastStack"));
  expect(banner.length).toBeGreaterThan(200);
  expect(banner).toContain('role="status"');
  expect(banner).toContain('aria-live="polite"');
  expect(banner).not.toContain('role="alert"');
});

test("no surface invents progress it does not measure", () => {
  const banner = APP.slice(APP.indexOf("function RunningTaskBanner"), APP.indexOf("function ToastStack"));
  // No percentage and no width-driven bar. The banner may show a count of real
  // units of work \u2014 pages read, documents filed \u2014 because those are things the
  // main process reports as they happen; it may never show a fraction of a
  // whole nobody measured, which is what a percentage or a filling bar claims.
  expect(banner).not.toMatch(/%/);
  expect(banner).not.toContain("<progress");
  expect(banner).not.toMatch(/\bmax=|value=/);

  // What it does show is passed in, never computed here, and never shown at
  // all unless the count it came from is real.
  expect(banner).toContain("progress.completed}/${progress.total}");
  expect(banner).toContain("progress.total > 0");

  // And both sources of that count are event streams the main process actually
  // emits \u2014 one event per document filed, one per statement page read.
  expect(APP).toContain("onSmartOcrProgress");
  expect(APP).toContain("onBankStatementProgress");
  expect(APP).toMatch(/completed: Number\(event\.completed/);
  expect(APP).toMatch(/const completed = Number\(event\?\.completed/);
});

/*
 * The rule that outlives any particular screen. A raised flag that is lowered
 * only on the success path is the bug: the person sees an error, dismisses it,
 * and the button stays disabled with a spinner beside it.
 */
test("every loading flag is lowered in a finally", () => {
  for (const [name, source] of [["App.tsx", APP], ["OperationalAccounting.tsx", OPERATIONAL]]) {
    // Setters raised with a truthy value somewhere in the file.
    const raised = new Set(
      [...source.matchAll(/\bset([A-Za-z0-9]*(?:Busy|Loading|Importing|Saving))\(\s*true\s*\)/g)].map((match) => match[1]),
    );
    expect(raised.size, `${name} raises no loading flag`).toBeGreaterThan(0);

    // Everything that appears inside a finally block in this file.
    const finallyBodies = failureSafeBodies(source);

    for (const flag of raised) {
      expect(
        new RegExp(`set${flag}\\(\\s*(?:false|"")\\s*\\)`).test(finallyBodies),
        `${name}: set${flag} is raised but never lowered in a finally`,
      ).toBe(true);
    }
  }
});

test("the shared task label is cleared on the failure path too", () => {
  // `setRunningTask("")` is the reset. Every raise of it must be paired with a
  // reset that a thrown error still reaches.
  const raises = [...APP.matchAll(/setRunningTask\("([^"]+)"\)/g)].map((match) => match[1]);
  expect(raises.length).toBeGreaterThan(2);
  const finallyBodies = [...APP.matchAll(/finally\s*\{([\s\S]{0,600}?)\n\s*\}/g)].map((match) => match[1]).join("\n");
  expect(finallyBodies).toContain('setRunningTask("")');
  // Every label ends in an ellipsis: it names work in progress, not a result.
  for (const label of raises) expect(label, label).toMatch(/…$/);
});

/*
 * The brief is explicit that a loading surface is never a reason to invoke the
 * reviewer. The reviewer runs when the deterministic pass found something, when
 * the workflow is risky, or when somebody asked for it — never to have a
 * spinner to show.
 */
test("nothing triggers the AI reviewer merely to have something to display", () => {
  const banner = APP.slice(APP.indexOf("function RunningTaskBanner"), APP.indexOf("function ToastStack"));
  expect(banner).not.toMatch(/review|wheatAi|reviewBeforeMutation/i);
  const backup = APP.slice(APP.indexOf("const createBackup = async"), APP.indexOf("const recoverLocalLockFromBackup"));
  expect(backup).not.toMatch(/reviewBeforeMutation/);
});
