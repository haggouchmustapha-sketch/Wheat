/**
 * Every refusal explains itself from what the check already knew.
 *
 * An error message tells an accountant that something is wrong. What they need
 * next is which value caused it, which rule it broke, and what to do — and each
 * screen used to answer those three questions differently, or not at all. There
 * is now one shape for a finding and one control that reveals it, so a screen
 * cannot quietly go back to a bare sentence.
 *
 * Nothing here is produced at display time and nothing asks a model: the check
 * that found the problem is the only thing that knows why it is a problem.
 */

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");
const issues = tsxRequire(path.join(root, "src", "lib", "wheatIssues.ts"), __filename);
const bank = tsxRequire(path.join(root, "src", "lib", "bankImportIssues.ts"), __filename);
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("the explanation states what, on which value, why, against which rule, and what to do", () => {
  const explanation = issues.issueExplanation({
    code: "SAGE_THIRD_PARTY_ACCOUNT_MISSING",
    severity: "REVIEW",
    message: "Compte tiers Sage manquant.",
    what: "Wheat connaît ce tiers mais n'a pas de numéro de compte tiers Sage pour lui.",
    value: "ANOUAL HEALTH SOLUTIONS",
    reason: "Le champ attend un numéro de compte, pas une raison sociale.",
    expected: "Un compte tiers existant dans le dossier Sage.",
    remedy: "Renseignez-le dans les correspondances.",
    blocking: false,
  });
  expect(explanation).toContain("Wheat connaît ce tiers");
  expect(explanation).toContain("Valeur concernée : ANOUAL HEALTH SOLUTIONS");
  expect(explanation).toContain("Règle attendue :");
  expect(explanation).toContain("À faire :");
  // And whether it blocks, said rather than implied by a colour.
  expect(explanation).toMatch(/ne bloque pas l'opération/i);

  const blocker = issues.issueExplanation({ code: "X", severity: "BLOCKER", message: "Non." });
  expect(blocker).toMatch(/bloque l'opération/i);
  const warning = issues.issueExplanation({ code: "X", severity: "WARNING", message: "Pour information." });
  expect(warning).toMatch(/n'empêche pas/i);
});

test("an absent fact is absent, never filled with a plausible one", () => {
  const sparse = issues.issueExplanation({ code: "X", severity: "BLOCKER", message: "Refusé." });
  expect(sparse).not.toMatch(/Valeur concernée/);
  expect(sparse).not.toMatch(/Règle attendue/);
  expect(sparse).not.toMatch(/À faire/);
});

test("technical detail never leaks into the ordinary explanation", () => {
  const issue = {
    code: "X",
    severity: "BLOCKER",
    message: "La relecture n'a pas abouti.",
    technical: "REMOTE · openrouter/some-model · socket hang up",
  };
  expect(issues.issueExplanation(issue)).not.toContain("openrouter");
  // It is still available, for the disclosure that is meant to carry it.
  expect(issue.technical).toContain("openrouter");
});

test("a rejected statement row explains the rule it broke and quotes the row", () => {
  const rows = [
    { DATE: "25 06", LIBELLE: "VIREMENT", DEBIT: "", CREDIT: "18 334,42", __wheatSourcePage: "1" },
    { DATE: "06 2026", LIBELLE: "PAIEMENT", DEBIT: "600,00", CREDIT: "" },
  ];
  const [dateIssue] = bank.bankImportIssues(
    [{ row: 2, reason: "Date de la ligne 2 : La date « 06 2026 » ne contient pas d'année et aucun contexte de relevé fiable ne permet de l'inférer." }],
    rows,
  );
  expect(dateIssue.context).toBe("Ligne 2");
  expect(dateIssue.severity).toBe("BLOCKER");
  expect(dateIssue.expected).toMatch(/année/i);
  expect(dateIssue.remedy).toBeTruthy();
  // The row as the file holds it, so the person sees what Wheat was reading.
  expect(dateIssue.value).toContain("LIBELLE = PAIEMENT");
  expect(dateIssue.value).not.toContain("__wheatSourcePage");

  const [bothSides] = bank.bankImportIssues([{ row: 1, reason: "Statement row 1 contains both a debit and a credit amount." }], rows);
  expect(bothSides.reason).toMatch(/soit un débit, soit un crédit/i);
  expect(bothSides.remedy).toMatch(/colonnes/i);
});

test("a reason Wheat does not recognise keeps its sentence and gains no invented rationale", () => {
  const [unknown] = bank.bankImportIssues([{ row: 4, reason: "Quelque chose d'inattendu." }], []);
  expect(unknown.message).toBe("Quelque chose d'inattendu.");
  expect(unknown.what).toBeUndefined();
  expect(unknown.reason).toBeUndefined();
  expect(unknown.remedy).toBeUndefined();
});

test("the control is one shared component, reachable by hover, focus and click", () => {
  const ui = read("src", "components", "ui", "index.tsx");
  const info = ui.slice(ui.indexOf("export function IssueInfo"), ui.indexOf("export function IssueList"));
  expect(info).toMatch(/onMouseEnter/);
  expect(info).toMatch(/onFocus/);
  expect(info).toMatch(/onClick/);
  expect(info).toMatch(/aria-label/);
  expect(info).toMatch(/role="tooltip"/);
  // A real button, so it is in the tab order rather than hover-only.
  expect(info).toMatch(/<button/);
});

test("the screens that refuse things use it rather than printing bare lists", () => {
  const app = read("src", "App.tsx");
  // Sage export: blockers, review points and warnings all go through it.
  expect(app).toMatch(/<IssueList issues=\{blockingIssues\}/);
  expect(app).toMatch(/<IssueList issues=\{reviewIssues\}/);
  expect(app).toMatch(/<IssueList issues=\{warningIssues\}/);
  // Bank import: the rejected rows.
  expect(app).toMatch(/<IssueList issues=\{bankImportIssues\(/);
});
