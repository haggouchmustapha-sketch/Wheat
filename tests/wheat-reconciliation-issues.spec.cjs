/**
 * A refused reconciliation, explained.
 *
 * The reconciliation service refuses in one short English sentence thrown from
 * the main process. That sentence used to be the whole of what an accountant
 * saw: no rule, no reason, no way forward, and not in their language. This
 * suite pins the two properties that make the explanation trustworthy —
 * every rule it claims is a rule the service really enforces, and a refusal it
 * does not recognise is never dressed up in an invented one.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const { reconciliationIssue } = tsxRequire(path.join(root, "src", "lib", "reconciliationIssues.ts"), __filename);
const { issueExplanation } = tsxRequire(path.join(root, "src", "lib", "wheatIssues.ts"), __filename);
const serviceSource = fs.readFileSync(path.join(root, "electron", "reconciliation.ts"), "utf8");

/** Every message the service can actually throw. */
const thrown = [...serviceSource.matchAll(/throw new Error\("([^"]+)"\)/g)].map((match) => match[1]);

test("every explained rule is a refusal the service really has", () => {
  expect(thrown.length).toBeGreaterThan(20);
  const source = fs.readFileSync(path.join(root, "src", "lib", "reconciliationIssues.ts"), "utf8");
  const patterns = [...source.matchAll(/match: \/(.+?)\/i,/g)].map((match) => new RegExp(match[1], "i"));
  expect(patterns.length).toBeGreaterThan(10);
  for (const pattern of patterns) {
    expect(
      thrown.some((message) => pattern.test(message)),
      `no refusal in reconciliation.ts matches ${pattern}`,
    ).toBe(true);
  }
});

test("a recognised refusal is stated in the language of the person reading it", () => {
  const issue = reconciliationIssue("At least one accounting-line allocation is required.");
  expect(issue).not.toBeNull();
  expect(issue.code).toBe("ALLOCATION_REQUIRED");
  expect(issue.severity).toBe("BLOCKER");
  expect(issue.blocking).toBe(true);
  expect(issue.message).toBe("Sélectionnez la ligne comptable que ce mouvement règle.");
  // The service's own wording survives, for a support conversation.
  expect(issue.technical).toBe("At least one accounting-line allocation is required.");

  const explanation = issueExplanation(issue);
  expect(explanation).toContain("Règle attendue :");
  expect(explanation).toContain("À faire :");
  expect(explanation).toContain("bloque l'opération");
});

test("a refusal that is not about a broken rule is not treated as a blocker", () => {
  const issue = reconciliationIssue("This bank movement changed in another window. Refresh and try again.");
  expect(issue.severity).toBe("REVIEW");
  expect(issue.blocking).toBe(false);
  expect(issueExplanation(issue)).toContain("demande une vérification");
});

test("an unrecognised message is never dressed up in an invented rule", () => {
  for (const message of [
    "A Prisma-compatible transaction client is required.",
    "Something nobody has written a rule for",
    "",
    null,
    undefined,
    { message: "not a string" },
  ]) {
    expect(reconciliationIssue(message), `${String(message)} was explained`).toBeNull();
  }
});

test("no rule claims more than it knows", () => {
  for (const message of thrown) {
    const issue = reconciliationIssue(message);
    if (!issue) continue;
    // A named rule always says what it is, why, and what to do next. A rule
    // that cannot say those three things is not worth an information bubble.
    expect(issue.code, message).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(issue.what, message).toBeTruthy();
    expect(issue.reason, message).toBeTruthy();
    expect(issue.remedy, message).toBeTruthy();
    // Nothing invents a value it was never given.
    expect(issue.value, message).toBeUndefined();
  }
});

test("each recognised refusal maps to exactly one rule", () => {
  const seen = new Map();
  for (const message of thrown) {
    const issue = reconciliationIssue(message);
    if (!issue) continue;
    const previous = seen.get(message);
    expect(previous === undefined || previous === issue.code, `${message} matches two rules`).toBe(true);
    seen.set(message, issue.code);
  }
  expect(seen.size).toBeGreaterThan(10);
});
