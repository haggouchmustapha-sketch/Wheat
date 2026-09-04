import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, CircleDashed, Clock,
  ExternalLink, HelpCircle, Lock, Play, RefreshCw, ShieldCheck, Sparkles,
} from "lucide-react";
import { Badge, Button, Callout, Card, EmptyState, LoadingState } from "./ui";
import "./GuidedWork.css";

/**
 * Guided work: what Wheat prepared, and what the accountant decides about it.
 *
 * The screen this replaces listed fifteen stages and a button per stage that
 * navigated somewhere else. Everything here is the opposite arrangement: the
 * step Wheat is on occupies the page, its prepared operations are listed one by
 * one with what Wheat read and how sure it is, and the single primary button
 * executes exactly the ones that are ticked.
 *
 * Three details carry most of the design.
 *
 * *Only `READY` operations are ticked when a proposal arrives.* Everything Wheat
 * wants a person to look at starts unticked, so approving without reading can
 * never post something Wheat itself flagged. Ticking one is a deliberate act.
 *
 * *Every operation can be opened.* The arrow beside a row leaves guided work for
 * the ordinary screen that owns the record. That is the escape hatch that keeps
 * this a shortcut rather than a mode you get trapped in.
 *
 * *Failures are shown next to what succeeded.* A batch of thirty where two fail
 * reports twenty-eight created and names the two, because that is the state the
 * dossier is actually in.
 */

type GuidedOperationStatus = "READY" | "REVIEW" | "BLOCKED";

type GuidedFieldEdit = {
  field: string;
  label: string;
  kind: "CHOICE" | "AMOUNT" | "TEXT" | "DATE";
  value: string;
  choices?: Array<{ value: string; label: string }>;
  note: string | null;
  required: boolean;
};

type GuidedOperation = {
  id: string;
  kind: string;
  label: string;
  detail: string;
  status: GuidedOperationStatus;
  confidence: number;
  reasons: string[];
  attention: string[];
  target: { page: string; recordId: string | null } | null;
  edits: GuidedFieldEdit[];
  suggestion: { explanation: string; fields: Record<string, string | number> } | null;
};

type GuidedProposal = {
  stepId: string;
  title: string;
  summary: string;
  detected: Array<{ label: string; value: string }>;
  operations: GuidedOperation[];
  findings: Array<{ severity: "INFO" | "WARNING" | "BLOCKER"; message: string }>;
  readyCount: number;
  reviewCount: number;
  blockedCount: number;
  approveLabel: string;
  approvable: boolean;
};

type GuidedStep = {
  id: string;
  order: number;
  title: string;
  status: "DONE" | "READY" | "BLOCKED" | "NEEDS_ANSWER";
  why: string;
  state: string;
  action: { label: string; target: string } | null;
  question: { prompt: string; why: string; whereToFind: string } | null;
  blockedBy: string | null;
  automatable: boolean;
  decision: { kind: string; note: string | null; decidedAt: string } | null;
};

type GuidedState = {
  companyId: string | null;
  companyName: string | null;
  steps: GuidedStep[];
  completed: number;
  total: number;
  next: GuidedStep | null;
  proposal: GuidedProposal | null;
  inferred: string[];
};

type GuidedExecution = {
  executed: Array<{ operationId: string; label: string; recordId: string | null }>;
  failed: Array<{ operationId: string; label: string; reason: string }>;
  message: string;
};

const STATUS_META: Record<GuidedStep["status"], { label: string; tone: "success" | "info" | "warning" | "neutral"; icon: typeof Play }> = {
  DONE: { label: "Terminé", tone: "success", icon: CheckCircle2 },
  READY: { label: "À faire maintenant", tone: "info", icon: Play },
  NEEDS_ANSWER: { label: "Une réponse attendue", tone: "warning", icon: HelpCircle },
  BLOCKED: { label: "Bloqué", tone: "neutral", icon: Lock },
};

const OPERATION_META: Record<GuidedOperationStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  READY: { label: "Prêt", tone: "success" },
  REVIEW: { label: "À relire", tone: "warning" },
  BLOCKED: { label: "À corriger", tone: "danger" },
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The decisions Wheat will not make on this row until a person does. */
const unanswered = (operation: GuidedOperation, corrections: Record<string, Record<string, string>>) =>
  operation.edits.filter((edit) => edit.required && !(corrections[operation.id]?.[edit.field] ?? edit.value));

export function GuidedWork({
  companyId,
  onOpen,
  refreshToken,
  onChanged,
  notify,
}: {
  companyId: string | null;
  /** Leaves guided work for the ordinary screen that owns a record. */
  onOpen: (target: string, recordId?: string | null) => void;
  /**
   * Bumped by the shell when something outside this screen changed the dossier
   * — the identity editor guided work itself sends people to, for instance.
   * Guided work reads the dossier rather than being told about it, so it has to
   * be told when to read it again.
   */
  refreshToken?: number;
  /** Lets the shell refresh the rest of the application after an execution. */
  onChanged?: () => void | Promise<void>;
  notify: (message: string, tone: "success" | "info" | "warning") => void;
}) {
  const [state, setState] = useState<GuidedState | null>(null);
  const [proposal, setProposal] = useState<GuidedProposal | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [execution, setExecution] = useState<GuidedExecution | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllSteps, setShowAllSteps] = useState(false);
  /**
   * What the reviewer has changed on the rows, keyed by operation then field.
   *
   * Held here rather than pushed into `proposal` because a proposal is what
   * Wheat prepared and these are what the person answered: keeping them apart
   * is what lets every keystroke be re-sent for revalidation without the
   * screen ever inventing a status of its own.
   */
  const [corrections, setCorrections] = useState<Record<string, Record<string, string>>>({});
  const [revalidating, setRevalidating] = useState(false);

  const bridge = () => (window as any).wheat;

  /** A fresh proposal ticks exactly what Wheat found clean, and nothing else. */
  const adoptProposal = useCallback((next: GuidedProposal | null) => {
    setProposal(next);
    setSelected(new Set(next?.operations.filter((operation) => operation.status === "READY").map((operation) => operation.id) ?? []));
    setCorrections({});
  }, []);

  const correctionList = useCallback(
    (source: Record<string, Record<string, string>>) =>
      Object.entries(source)
        .map(([operationId, fields]) => ({ operationId, fields }))
        .filter((item) => Object.values(item.fields).some((value) => value !== "")),
    [],
  );

  /**
   * Re-prepares the step with the corrections applied.
   *
   * The screen never recomputes a status itself: it sends what the person
   * answered back to the same preparation code and shows what that returns. An
   * edit therefore costs exactly what preparing costs, and a correction that
   * still does not add up comes back saying so, in Wheat's own words.
   */
  const revalidate = useCallback(async (next: Record<string, Record<string, string>>) => {
    if (!companyId || !proposal) return;
    setRevalidating(true);
    try {
      const updated: GuidedProposal = await bridge().prepareGuidedStep({
        companyId,
        stepId: proposal.stepId,
        corrections: correctionList(next),
      });
      setProposal(updated);
      // A row that has become clean is ticked; one that is still under review
      // stays for the person to tick deliberately, and a row they had already
      // ticked keeps their decision.
      setSelected((current) => {
        const kept = new Set([...current].filter((id) => updated.operations.some((operation) => operation.id === id && operation.status !== "BLOCKED")));
        for (const operation of updated.operations) if (operation.status === "READY") kept.add(operation.id);
        return kept;
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRevalidating(false);
    }
  }, [companyId, correctionList, proposal]);

  const correct = useCallback((operationId: string, field: string, value: string) => {
    setCorrections((current) => {
      const next = { ...current, [operationId]: { ...(current[operationId] ?? {}), [field]: value } };
      void revalidate(next);
      return next;
    });
  }, [revalidate]);

  /** Accepts, as one action, the reading Wheat's own arithmetic determined. */
  const acceptSuggestion = useCallback((operation: GuidedOperation) => {
    if (!operation.suggestion) return;
    setCorrections((current) => {
      const fields = { ...(current[operation.id] ?? {}) };
      for (const [field, value] of Object.entries(operation.suggestion!.fields)) fields[field] = String(value);
      const next = { ...current, [operation.id]: fields };
      void revalidate(next);
      return next;
    });
  }, [revalidate]);

  const load = useCallback(async () => {
    if (!companyId || !bridge()?.getGuidedWork) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next: GuidedState = await bridge().getGuidedWork({ companyId });
      setState(next);
      adoptProposal(next.proposal);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [adoptProposal, companyId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const prepareStep = useCallback(async (stepId: string) => {
    if (!companyId) return;
    setWorking(true);
    setError("");
    setExecution(null);
    try {
      const next: GuidedProposal = await bridge().prepareGuidedStep({ companyId, stepId });
      adoptProposal(next);
      setState((current) => (current ? { ...current, next: current.steps.find((step) => step.id === stepId) ?? current.next } : current));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }, [adoptProposal, companyId]);

  const approve = useCallback(async () => {
    if (!companyId || !proposal || !selected.size) return;
    setWorking(true);
    setError("");
    try {
      const result: GuidedExecution = await bridge().approveGuidedStep({
        companyId,
        stepId: proposal.stepId,
        operationIds: [...selected],
        corrections: correctionList(corrections),
      });
      setExecution(result);
      notify(result.message, result.failed.length ? "warning" : "success");
      await onChanged?.();
      // NEXT: the journey is recomputed from the dossier the execution changed.
      await load();
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, "warning");
    } finally {
      setWorking(false);
    }
  }, [companyId, correctionList, corrections, load, notify, onChanged, proposal, selected]);

  const decide = useCallback(async (stepId: string, decision: "POSTPONED" | "RESUMED" | "NOT_APPLICABLE") => {
    if (!companyId) return;
    setWorking(true);
    try {
      await bridge().decideGuidedStep({ companyId, stepId, decision });
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }, [companyId, load]);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectable = useMemo(
    () => proposal?.operations.filter((operation) => operation.status !== "BLOCKED") ?? [],
    [proposal],
  );
  const allSelected = selectable.length > 0 && selectable.every((operation) => selected.has(operation.id));

  if (!companyId) {
    return (
      <EmptyState
        icon={<Sparkles size={22} />}
        title="Aucun dossier ouvert"
        text="Le travail guidé porte sur un dossier : créez-en un ou ouvrez-en un pour que Wheat prépare la suite."
        actions={<Button variant="primary" onClick={() => onOpen("companies")}>Ouvrir les dossiers</Button>}
      />
    );
  }
  if (loading && !state) return <LoadingState label="Wheat analyse le dossier…" rows={4} />;

  const next = state?.next ?? null;
  const visibleSteps = showAllSteps ? state?.steps ?? [] : (state?.steps ?? []).filter((step) => step.status !== "DONE");

  return (
    <div className="wt-guided" data-testid="guided-work">
      {error && <Callout tone="danger" title="Wheat n'a pas pu poursuivre">{error}</Callout>}

      {/* ------------------------------------------------ the current step */}
      {next ? (
        <Card
          title={next.title}
          note={next.why}
          icon={<Sparkles size={18} aria-hidden="true" />}
          actions={
            <div className="wt-guided__head-actions">
              <Button variant="ghost" size="sm" onClick={() => void load()} disabled={working}>
                <RefreshCw size={14} aria-hidden="true" /> Réanalyser
              </Button>
              {next.action && (
                <Button variant="ghost" size="sm" onClick={() => onOpen(next.action!.target)}>
                  {next.action.label} <ExternalLink size={14} aria-hidden="true" />
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => void decide(next.id, "POSTPONED")} disabled={working}>
                <Clock size={14} aria-hidden="true" /> Reporter
              </Button>
            </div>
          }
        >
          <p className="wt-guided__state">{next.state}</p>

          {next.question && (
            <Callout tone="warning" title={next.question.prompt}>
              <p>{next.question.why}</p>
              <p><strong>Où trouver la réponse :</strong> {next.question.whereToFind}</p>
              {next.action && (
                <Button variant="primary" size="sm" onClick={() => onOpen(next.action!.target)}>
                  {next.action.label}
                </Button>
              )}
            </Callout>
          )}

          {!next.automatable && !next.question && (
            <Callout tone="info" title="Cette étape se fait dans son écran">
              Wheat ne prépare pas encore d'opérations pour cette étape : elle demande des informations que seul le dossier
              détient. Ouvrez l'écran correspondant, puis revenez ici pour la suite.
            </Callout>
          )}

          {next.automatable && !proposal && !working && (
            <Button variant="primary" onClick={() => void prepareStep(next.id)}>
              Analyser et préparer <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
          {working && !proposal && <LoadingState label="Wheat prépare les opérations…" />}
        </Card>
      ) : (
        <EmptyState
          icon={<ShieldCheck size={22} />}
          title="Le dossier est à jour"
          text="Wheat n'a rien à préparer pour le moment. Importez des pièces ou un relevé pour relancer le travail guidé."
          actions={<Button variant="primary" onClick={() => onOpen("documents")}>Importer des pièces</Button>}
        />
      )}

      {/* ---------------------------------------------------- the proposal */}
      {proposal && (
        <Card
          title={`Ce que Wheat propose — ${proposal.title}`}
          note={proposal.summary}
          actions={selectable.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((operation) => operation.id)))}
            >
              {allSelected ? "Tout décocher" : "Tout cocher"}
            </Button>
          )}
        >
          {proposal.detected.length > 0 && (
            <dl className="wt-guided__detected" data-testid="guided-detected">
              {proposal.detected.map((item) => (
                <div className="wt-guided__detected-item" key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {proposal.findings.map((finding, index) => (
            <Callout
              key={index}
              tone={finding.severity === "BLOCKER" ? "danger" : finding.severity === "WARNING" ? "warning" : "info"}
            >
              {finding.message}
            </Callout>
          ))}

          {proposal.operations.length > 0 && (
            <ul className="wt-guided__ops" data-testid="guided-operations">
              {proposal.operations.map((operation) => {
                const meta = OPERATION_META[operation.status];
                const blocked = operation.status === "BLOCKED";
                const open = expanded.has(operation.id);
                return (
                  <li className="wt-guided__op" data-status={operation.status} key={operation.id}>
                    <label className="wt-guided__op-check">
                      <input
                        type="checkbox"
                        checked={selected.has(operation.id)}
                        // A row whose unanswered question Wheat refuses to
                        // answer for you cannot be ticked. Saying so on the
                        // control itself is better than accepting the tick and
                        // reporting a failure after the batch has run.
                        disabled={blocked || working || unanswered(operation, corrections).length > 0}
                        onChange={() => toggle(operation.id)}
                        aria-label={`Approuver : ${operation.label}`}
                      />
                    </label>
                    <div className="wt-guided__op-body">
                      <span className="wt-guided__op-title">{operation.label}</span>
                      <span className="wt-guided__op-detail">{operation.detail}</span>
                      {operation.attention.length > 0 && (
                        <span className="wt-guided__op-attention">
                          <AlertTriangle size={12} aria-hidden="true" /> À vérifier : {operation.attention.join(", ")}
                        </span>
                      )}

                      {/* Correcting the one thing Wheat could not settle, here,
                          without leaving the batch. Each change re-runs the
                          same preparation, so the row's status and amounts come
                          back from Wheat rather than from this screen. */}
                      {operation.suggestion && (
                        <div className="wt-guided__op-suggestion">
                          <p>{operation.suggestion.explanation}</p>
                          <Button variant="soft" size="sm" disabled={working} onClick={() => acceptSuggestion(operation)}>
                            Reprendre la lecture proposée par Wheat
                          </Button>
                        </div>
                      )}
                      {operation.edits.length > 0 && (
                        <div className="wt-guided__op-edits" data-testid={`guided-edits-${operation.id}`}>
                          {operation.edits.map((edit) => {
                            const value = corrections[operation.id]?.[edit.field] ?? edit.value;
                            const inputId = `${operation.id}:${edit.field}`;
                            return (
                              <label className="wt-guided__op-edit" key={edit.field} data-required={edit.required ? "true" : "false"}>
                                <span className="wt-guided__op-edit-label">
                                  {edit.label}
                                  {edit.required && !value && <em> — à renseigner</em>}
                                </span>
                                {edit.kind === "CHOICE" ? (
                                  <select
                                    className="wt-input"
                                    value={value}
                                    disabled={working}
                                    aria-label={`${edit.label} : ${operation.label}`}
                                    data-testid={`guided-edit-${inputId}`}
                                    onChange={(event) => correct(operation.id, edit.field, event.target.value)}
                                  >
                                    <option value="">À choisir…</option>
                                    {(edit.choices ?? []).map((choice) => (
                                      <option key={choice.value} value={choice.value}>{choice.label}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    className="wt-input"
                                    type="text"
                                    inputMode={edit.kind === "AMOUNT" ? "decimal" : undefined}
                                    defaultValue={value}
                                    disabled={working}
                                    aria-label={`${edit.label} : ${operation.label}`}
                                    data-testid={`guided-edit-${inputId}`}
                                    // Committed on blur rather than on every
                                    // keystroke: revalidation is a round trip
                                    // that re-plans the whole step, and firing
                                    // it per character would make typing an
                                    // amount unusable.
                                    onBlur={(event) => {
                                      if (event.target.value !== value) correct(operation.id, edit.field, event.target.value);
                                    }}
                                  />
                                )}
                                {edit.note && <span className="wt-guided__op-edit-note">{edit.note}</span>}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {open && (
                        <ul className="wt-guided__op-reasons">
                          {operation.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                        </ul>
                      )}
                      {operation.reasons.length > 0 && (
                        <button type="button" className="wt-guided__op-more" onClick={() => toggleExpanded(operation.id)}>
                          {open ? "Masquer le détail" : "Pourquoi Wheat propose cela"}
                        </button>
                      )}
                    </div>
                    <div className="wt-guided__op-side">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {operation.confidence > 0 && <span className="wt-guided__op-confidence">{operation.confidence} %</span>}
                      {operation.target && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpen(operation.target!.page, operation.target!.recordId)}
                          title="Ouvrir la pièce d'origine"
                        >
                          Ouvrir <ChevronRight size={14} aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {revalidating && (
            <p className="wt-guided__revalidating" role="status">
              <RefreshCw size={13} aria-hidden="true" /> Wheat recalcule la proposition avec votre correction…
            </p>
          )}

          {proposal.approvable ? (
            <div className="wt-guided__approve">
              <Button variant="primary" onClick={() => void approve()} disabled={working || selected.size === 0}>
                {selected.size === proposal.operations.length || selected.size === 0
                  ? proposal.approveLabel
                  : `Approuver ${selected.size} opération(s)`}
                <ArrowRight size={15} aria-hidden="true" />
              </Button>
              <span className="wt-guided__approve-note">
                {selected.size === 0
                  // A disabled primary button has to say what would enable it.
                  // Nothing is ticked here because Wheat flagged every line for
                  // review, and ticking one is meant to be a deliberate act.
                  ? "Aucune ligne n'est cochée : Wheat a signalé chacune d'elles pour relecture. Cochez celles que vous approuvez."
                  : "Rien n'est enregistré tant que vous n'avez pas approuvé. Seules les lignes cochées seront exécutées."}
              </span>
            </div>
          ) : (
            proposal.operations.length === 0 && !proposal.findings.length && (
              <p className="wt-guided__state">Rien à préparer pour cette étape.</p>
            )
          )}
        </Card>
      )}

      {/* --------------------------------------------------- what happened */}
      {execution && (
        <Card title="Résultat" note={execution.message}>
          {execution.executed.length > 0 && (
            <ul className="wt-guided__result" data-testid="guided-executed">
              {execution.executed.map((item) => (
                <li key={item.operationId}><CheckCircle2 size={14} aria-hidden="true" /> {item.label}</li>
              ))}
            </ul>
          )}
          {execution.failed.length > 0 && (
            <ul className="wt-guided__result wt-guided__result--failed" data-testid="guided-failed">
              {execution.failed.map((item) => (
                <li key={item.operationId}>
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span><strong>{item.label}</strong> — {item.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------ the parcours */}
      <Card
        title="Parcours du dossier"
        note={`${state?.completed ?? 0} étape(s) terminées sur ${state?.total ?? 0}. L'avancement est calculé à partir du dossier lui-même, jamais d'une liste à cocher.`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => setShowAllSteps((current) => !current)}>
            {showAllSteps ? "Masquer les étapes terminées" : "Afficher tout le parcours"}
          </Button>
        }
      >
        <div className="wt-guided__steps" data-testid="guided-steps">
          {visibleSteps.map((step) => {
            const meta = STATUS_META[step.status];
            const Icon = meta.icon;
            return (
              <div className="wt-guided__step" data-status={step.status} data-step={step.id} key={step.id}>
                <span className="wt-guided__step-order" aria-hidden="true">{step.order}</span>
                <span className="wt-guided__step-body">
                  <span className="wt-guided__step-title">
                    <Icon size={14} aria-hidden="true" /> {step.title}
                    {step.automatable && <Badge tone="info">Wheat prépare</Badge>}
                    {step.decision && <Badge tone="neutral">Reportée</Badge>}
                  </span>
                  <span className="wt-guided__step-state">{step.state}</span>
                  {step.status === "BLOCKED" && step.blockedBy && (
                    <span className="wt-guided__step-why">
                      Commencez d'abord par : {state?.steps.find((item) => item.id === step.blockedBy)?.title ?? step.blockedBy}.
                    </span>
                  )}
                  {step.decision?.note && <span className="wt-guided__step-why">Note : {step.decision.note}</span>}
                </span>
                <span className="wt-guided__step-actions">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {step.decision ? (
                    /* Named for what it resumes. "Reprendre" alone shares its
                       name with the setup gate's "…à reprendre" choices and
                       with the proposal's "Reprendre la lecture proposée par
                       Wheat", all of which can be on screen at once. */
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`guided-resume-${step.id}`}
                      onClick={() => void decide(step.id, "RESUMED")}
                      disabled={working}
                    >
                      Reprendre l'étape
                    </Button>
                  ) : (
                    step.automatable && step.status !== "BLOCKED" && step.status !== "DONE" && (
                      <Button variant="ghost" size="sm" onClick={() => void prepareStep(step.id)} disabled={working}>Préparer</Button>
                    )
                  )}
                  {step.action && step.status !== "BLOCKED" && (
                    <Button variant="ghost" size="sm" onClick={() => onOpen(step.action!.target)}>{step.action.label}</Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {(state?.inferred.length ?? 0) > 0 && (
          <ul className="wt-guided__inferred">
            <li><CircleDashed size={12} aria-hidden="true" /> Ce que Wheat a déduit tout seul, sans vous le demander :</li>
            {state!.inferred.map((item, index) => <li key={index}>— {item}</li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
