/**
 * A document whose own arithmetic does not hold, explained where it is seen.
 *
 * The extraction pipeline has always scored the reading against the rules an
 * invoice must satisfy, and recorded a verdict per rule. Those verdicts were
 * only ever rendered inside a collapsed panel called "Diagnostic d'extraction
 * (avancé)", as a status word and a terse detail — so the person correcting the
 * fields never learnt that the totals did not add up, and the person who opened
 * the panel got no explanation of what to change.
 *
 * What is pinned here is the same discipline as everywhere else in this family:
 * every rule explained is a rule the pipeline really produces, an unrecognised
 * verdict is left alone rather than dressed up, and the figures the check
 * compared are preserved in the check's own words instead of paraphrased.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { ocrCheckIssues } = tsxRequire(path.join(root, "src", "lib", "ocrCheckIssues.ts"), __filename);
const { issueExplanation } = tsxRequire(path.join(root, "src", "lib", "wheatIssues.ts"), __filename);

/** Every check id the extraction pipeline can emit. */
const PRODUCED_IDS = [...new Set(
  ["ocrAmounts.ts", "ocrDocumentUnderstanding.ts"]
    .map((file) => fs.readFileSync(path.join(root, "electron", file), "utf8"))
    .join("\n")
    .matchAll(/id: "([a-z0-9-]+)"/g),
)].map((match) => match[1]);

test("every explained rule is a check the pipeline really produces", () => {
  const source = fs.readFileSync(path.join(root, "src", "lib", "ocrCheckIssues.ts"), "utf8");
  const explained = [...source.matchAll(/^ {2}"([a-z0-9-]+)": \{$/gm)].map((match) => match[1]);
  expect(explained.length).toBeGreaterThan(8);
  for (const id of explained) {
    expect(PRODUCED_IDS, `no check in the pipeline emits id "${id}"`).toContain(id);
  }
});

test("a failed check becomes a finding with a rule, a reason and a next step", () => {
  const [issue] = ocrCheckIssues([
    { id: "ht-plus-tva-equals-ttc", label: "HT + TVA = TTC", status: "FAILED", detail: "1 000,00 + 200,00 ≠ 1 250,00" },
  ]);
  expect(issue.code).toBe("ht-plus-tva-equals-ttc");
  expect(issue.context).toBe("HT + TVA = TTC");
  // The figures the check compared, in its own words, never paraphrased.
  expect(issue.technical).toBe("1 000,00 + 200,00 ≠ 1 250,00");

  const explanation = issueExplanation(issue);
  expect(explanation).toContain("Règle attendue :");
  expect(explanation).toContain("À faire :");
  expect(explanation).toContain("demande une vérification");
});

test("a failed arithmetic check never blocks the correction", () => {
  // Wheat cannot know whether the page or the reading is wrong. Refusing here
  // would strand a document whose scan is simply poor.
  for (const id of PRODUCED_IDS) {
    for (const issue of ocrCheckIssues([{ id, status: "FAILED", label: id, detail: "x" }])) {
      expect(issue.blocking, id).toBe(false);
      expect(issue.severity, id).not.toBe("BLOCKER");
    }
  }
});

test("checks that passed or were skipped are not findings", () => {
  expect(ocrCheckIssues([
    { id: "ht-plus-tva-equals-ttc", status: "PASSED", label: "x", detail: "y" },
    { id: "vat-matches-rate", status: "SKIPPED", label: "x", detail: "y" },
  ])).toEqual([]);
});

test("an unrecognised verdict is left alone rather than dressed up", () => {
  expect(ocrCheckIssues([{ id: "some-future-check", status: "FAILED", label: "x", detail: "y" }])).toEqual([]);
  expect(ocrCheckIssues([{ status: "FAILED" }])).toEqual([]);
  expect(ocrCheckIssues(undefined)).toEqual([]);
  expect(ocrCheckIssues([])).toEqual([]);
});

test("no rule claims more than it knows", () => {
  for (const id of PRODUCED_IDS) {
    for (const issue of ocrCheckIssues([{ id, status: "FAILED", label: id, detail: "d" }])) {
      expect(issue.what, id).toBeTruthy();
      expect(issue.reason, id).toBeTruthy();
      expect(issue.remedy, id).toBeTruthy();
      // Nothing invents a value it was never handed.
      expect(issue.value, id).toBeUndefined();
    }
  }
});

test("the review screen shows them outside the advanced panel", () => {
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  expect(app).toContain("ocrCheckIssues(selectedExtracted.accountingChecks)");
  // Rendered through the shared list, so the explanation affordance cannot be
  // present on one screen and missing on the next.
  expect(app).toContain('data-testid="ocr-check-issues"');
  const surface = app.slice(app.indexOf('data-testid="ocr-check-issues"'));
  expect(surface.slice(0, 400)).toContain("<IssueList issues={documentCheckIssues} />");
  // And above the collapsed diagnostics panel, not inside it.
  expect(app.indexOf('data-testid="ocr-check-issues"')).toBeLessThan(app.indexOf("<OcrDiagnostics extracted="));
});
