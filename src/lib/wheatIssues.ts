/**
 * Structured explanation for anything Wheat refuses, questions or silently
 * repairs.
 *
 * An error message on its own tells an accountant that something is wrong; it
 * rarely tells them which value caused it, which rule it broke, or what to do
 * next. Those four things are what the person actually needs, and every screen
 * that used to hand-write them into a sentence wrote a different sentence.
 *
 * So a check produces a `WheatIssue` — the concise line it always produced,
 * plus the facts it already knew while producing it. The concise line stays in
 * the primary UI; the facts go behind the small information affordance next to
 * it. Nothing here is generated at display time and nothing here asks a model:
 * the check that found the problem is the only thing that knows why.
 */

export type WheatIssueSeverity =
  /** Refuses the operation. */
  | "BLOCKER"
  /** Does not refuse, but a person must decide before the result is trusted. */
  | "REVIEW"
  /** Worth knowing; the operation stands. */
  | "WARNING";

export type WheatIssue = {
  /** Stable identifier for the rule, for tests and for support. */
  code: string;
  severity: WheatIssueSeverity;
  /** The concise sentence shown in the primary UI. */
  message: string;
  /** Where it was found — "Ligne 12", "Facture FA-2026/0001". */
  context?: string;
  /** What happened, in plain language, when the message alone is terse. */
  what?: string;
  /** The offending value, exactly as Wheat received it. */
  value?: string;
  /** Why Wheat considers it invalid or risky. */
  reason?: string;
  /** The rule or constraint that was expected. */
  expected?: string;
  /** What the person can do next. */
  remedy?: string;
  /** What Wheat can safely repair on its own, if anything. */
  autoFix?: string;
  /** Whether it blocks execution — kept explicit so the bubble can say so. */
  blocking?: boolean;
  /** Error codes, provider names, paths. Secondary disclosure only. */
  technical?: string;
};

const SEVERITY_SENTENCE: Record<WheatIssueSeverity, string> = {
  BLOCKER: "Ce point bloque l'opération tant qu'il n'est pas résolu.",
  REVIEW: "Ce point ne bloque pas l'opération mais demande une vérification.",
  WARNING: "Ce point n'empêche pas l'opération ; il est signalé pour information.",
};

/**
 * The body of the information bubble: the facts the check knew, in the order a
 * person reads them — what, on what value, why, against which rule, and what to
 * do. Absent facts are simply absent; nothing is invented to fill the shape.
 */
export function issueExplanation(issue: WheatIssue): string {
  const parts: string[] = [];
  if (issue.what) parts.push(issue.what);
  if (issue.value) parts.push(`Valeur concernée : ${issue.value}`);
  if (issue.reason) parts.push(issue.reason);
  if (issue.expected) parts.push(`Règle attendue : ${issue.expected}`);
  if (issue.autoFix) parts.push(`Wheat peut corriger automatiquement : ${issue.autoFix}`);
  if (issue.remedy) parts.push(`À faire : ${issue.remedy}`);
  parts.push(SEVERITY_SENTENCE[issue.severity]);
  return parts.join(" ");
}

export function issueMessage(issue: WheatIssue): string {
  return issue.context ? `${issue.context} — ${issue.message}` : issue.message;
}

export function issuesOfSeverity(issues: WheatIssue[], severity: WheatIssueSeverity): WheatIssue[] {
  return issues.filter((issue) => issue.severity === severity);
}

/**
 * Flat sentences for the callers that still speak in strings — existing
 * validation contracts, audit payloads, toasts. The structured issue stays the
 * single source; this is only its projection.
 */
export function issueSentences(issues: WheatIssue[], severity: WheatIssueSeverity): string[] {
  return Array.from(new Set(issuesOfSeverity(issues, severity).map(issueMessage)));
}
