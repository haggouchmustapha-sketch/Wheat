import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  Brain,
  CheckCircle2,
  HelpCircle,
  Info,
  Laptop,
  Cloud,
  Loader2,
  ShieldQuestion,
} from "lucide-react";
import { Badge, Button, Callout, Dialog } from "./ui";
import "./WheatReview.css";

/**
 * The shared pre-submission review surface.
 *
 * One dialog for every reviewed workflow in Wheat, so a person learns its
 * shape once. It answers, in this order and always in these words:
 *
 *   what was checked, what appears correct, what may be wrong, why it matters,
 *   what to do next, and whether a model ran locally, remotely, or not at all.
 *
 * It never mutates anything. A proposed correction is applied to the *form*
 * the caller owns, through `onApplyFix`, and only for a finding the pipeline
 * already marked as a safe draft-level autofix. Blockers have no continue
 * button at all: the deterministic rule is the authority there, not a nudge.
 */

export type ReviewDecision = "cancel" | "continue";

/**
 * What is on screen while the review runs.
 *
 * This is not decoration. The review is the only thing standing between a click
 * and an accounting write, it can take ten seconds against a remote provider,
 * and it used to render nothing at all until it finished — so the honest
 * reading of the interface, for the whole of that wait, was that Wheat had
 * stopped working. What appears here is deliberately limited to what Wheat
 * actually knows: which operation is being reviewed, which model is answering,
 * and — after a while — that it is still waiting. There is no progress bar,
 * because Wheat cannot know how far through a model's answer it is, and a
 * fabricated percentage is a worse lie than an honest spinner.
 *
 * It carries no buttons but "Annuler". A person who did not mean to start the
 * review can leave; nobody can approve anything from here, because there is
 * nothing yet to approve.
 */
export function WheatReviewPending({
  label,
  stage,
  model,
  slow,
  onAbandon,
}: {
  label: string;
  stage: string;
  model: WheatReviewModelDescriptor | null;
  slow: boolean;
  onAbandon: () => void;
}) {
  return (
    <Dialog
      title="Relecture en cours"
      note={label}
      icon={<Loader2 size={18} className="wt-review__spin" aria-hidden="true" />}
      size="sm"
      // Deliberately not `wt-review`: waiting and deciding are different states
      // and must stay separately addressable. Sharing the result dialog's root
      // class made "the review dialog is gone" ambiguous — it matched a review
      // that had not started answering yet just as well as one that had.
      className="wt-review-pending"
      // Closing abandons the wait, not the review: the main process finishes
      // what it started and the answer is discarded, because it no longer
      // answers anything anybody is asking. Nothing was saved either way.
      onClose={onAbandon}
      closeLabel="Abandonner la relecture"
      footerNote="Rien n'a été enregistré : la relecture précède toujours l'écriture."
    >
      <div className="wt-review__pending" role="status" aria-live="polite" data-testid="review-pending">
        <Loader2 size={26} className="wt-review__spin" aria-hidden="true" />
        <p className="wt-review__pending-stage" data-testid="review-pending-stage">{stage}</p>
        {model?.available && (
          <p className="wt-review__pending-model" data-testid="review-pending-model">
            {model.locality === "LOCAL"
              ? <><Laptop size={13} aria-hidden="true" /> Sur cette machine — rien n'est envoyé</>
              : <><Cloud size={13} aria-hidden="true" /> Fournisseur distant, avec votre accord</>}
          </p>
        )}
        {slow && (
          <p className="wt-review__pending-slow" data-testid="review-pending-slow">
            La relecture prend plus de temps que d'habitude. Wheat attend toujours la réponse du modèle ; les contrôles
            comptables, eux, sont déjà faits. Vous pouvez fermer cette fenêtre et réessayer.
          </p>
        )}
      </div>
    </Dialog>
  );
}

const OUTCOME_META: Record<WheatReviewResult["outcome"], { label: string; tone: "success" | "warning" | "danger"; icon: ReactNode }> = {
  PASS: { label: "Contrôle passé", tone: "success", icon: <CheckCircle2 size={18} aria-hidden="true" /> },
  WARNING: { label: "À vérifier", tone: "warning", icon: <AlertTriangle size={18} aria-hidden="true" /> },
  ATTENTION_REQUIRED: { label: "Correction nécessaire", tone: "danger", icon: <Ban size={18} aria-hidden="true" /> },
};

/**
 * Who read this, and where.
 *
 * The heading names Wheat and states the locality, because whether the dossier
 * left the machine is a fact the reader is entitled to without asking. The
 * provider and model identifiers sit behind a disclosure: they matter when
 * something is being diagnosed and never during ordinary bookkeeping, and
 * putting them in the running text was how "remote:openrouter:google/
 * gemma-4-26b-a4b-it:free" ended up in front of somebody trying to save an
 * invoice.
 */
function ModelProvenance({
  model,
  onRetry,
  onOpenModelSettings,
}: {
  model: WheatReviewResult["model"];
  onRetry?: () => void;
  onOpenModelSettings?: () => void;
}) {
  /*
   * Nothing at all when no reading was owed.
   *
   * `NOT_NEEDED` means Wheat's own checks accepted the operation and a model
   * had nothing to add, which is the ordinary case. Announcing it — "Contrôles
   * Wheat uniquement", "Relecture Wheat AI non exécutée" — put a notice about
   * an absent second opinion on top of a dialog the person opened to read a
   * real finding, and taught them that Wheat AI is something that keeps failing.
   */
  if (model.status === "NOT_NEEDED" || model.status === "NOT_APPLICABLE") return null;

  const icon = model.locality === "LOCAL"
    ? <Laptop size={15} aria-hidden="true" />
    : model.locality === "REMOTE"
      ? <Cloud size={15} aria-hidden="true" />
      : <ShieldQuestion size={15} aria-hidden="true" />;
  const failed = !model.ran;
  const heading = model.ran
    ? model.locality === "LOCAL" ? "Relu par Wheat AI, sur cette machine" : "Relu par Wheat AI, à distance"
    : "Relecture par Wheat AI non aboutie";
  return (
    <div className="wt-review__provenance" data-locality={model.locality} data-ran={model.ran ? "true" : "false"} data-status={model.status}>
      <p>
        {icon}
        <span><strong>{heading}</strong>{" — "}{model.message}</span>
      </p>
      {failed && (onRetry || onOpenModelSettings) && (
        <div className="wt-review__provenance-actions">
          {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Réessayer la relecture</Button>}
          {onOpenModelSettings && <Button variant="ghost" size="sm" onClick={onOpenModelSettings}>Changer de modèle</Button>}
        </div>
      )}
      {model.detail && (
        <details className="wt-review__provenance-detail">
          <summary>Détails techniques</summary>
          <code>{model.detail}</code>
        </details>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  onApplyFix,
}: {
  finding: WheatReviewFinding;
  onApplyFix?: (finding: WheatReviewFinding) => void;
}) {
  const tone = finding.severity === "BLOCKER" ? "danger" : finding.severity === "WARNING" ? "warning" : "info";
  return (
    <li className="wt-review__finding" data-severity={finding.severity} data-origin={finding.origin}>
      <div className="wt-review__finding-head">
        <Badge tone={tone === "danger" ? "danger" : tone === "warning" ? "warning" : "info"}>
          {finding.severity === "BLOCKER" ? "Bloquant" : finding.severity === "WARNING" ? "Avertissement" : "Information"}
        </Badge>
        <strong>{finding.title}</strong>
        <span className="wt-review__finding-origin">
          {finding.origin === "MODEL"
            ? <><Brain size={13} aria-hidden="true" /> Modèle{finding.confidence !== null ? ` · confiance ${finding.confidence}%` : ""}</>
            : <><BadgeCheck size={13} aria-hidden="true" /> Règle Wheat</>}
        </span>
      </div>
      <p className="wt-review__finding-text">{finding.explanation}</p>
      {finding.accountingReason && (
        <p className="wt-review__finding-why"><Info size={13} aria-hidden="true" /> {finding.accountingReason}</p>
      )}
      {(finding.currentValue || finding.proposedValue) && (
        <p className="wt-review__diff">
          <span className="wt-review__diff-before">Actuel : {finding.currentValue ?? "—"}</span>
          <span className="wt-review__diff-after">Proposé : {finding.proposedValue ?? "—"}</span>
        </p>
      )}
      {finding.evidence.length > 0 && (
        <ul className="wt-review__evidence">
          {finding.evidence.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      )}
      {finding.safeAutofix && finding.proposedValue && onApplyFix && (
        <Button variant="soft" size="sm" onClick={() => onApplyFix(finding)}>
          Appliquer la correction au brouillon
        </Button>
      )}
      {finding.target && <p className="wt-review__target">Champ concerné : <code>{finding.target}</code></p>}
    </li>
  );
}

export function WheatReviewDialog({
  review,
  busy = false,
  onDecision,
  onApplyFix,
  onRetry,
  onOpenModelSettings,
  continueLabel = "Continuer",
}: {
  review: WheatReviewResult;
  busy?: boolean;
  onDecision: (decision: ReviewDecision, note: string) => void;
  onApplyFix?: (finding: WheatReviewFinding) => void;
  /** Re-runs the same review. Offered only when a reading was owed and failed. */
  onRetry?: () => void;
  onOpenModelSettings?: () => void;
  continueLabel?: string;
}) {
  const meta = OUTCOME_META[review.outcome];
  const [acknowledged, setAcknowledged] = useState(false);
  const [override, setOverride] = useState("");
  const seriousModelFinding = review.findings.some((item) => item.origin === "MODEL" && item.severity === "WARNING");
  // A serious model finding is not a blocker, but continuing past it is a
  // decision the person makes in writing rather than by clicking through.
  const overrideRequired = seriousModelFinding && override.trim().length < 8;
  const canContinue = !review.blocked && (!review.acknowledgementRequired || acknowledged) && !overrideRequired;

  return (
    <Dialog
      title={`Relecture avant enregistrement — ${review.workflowLabel}`}
      note={review.nextAction}
      icon={meta.icon}
      size="lg"
      className="wt-review"
      onClose={() => onDecision("cancel", override)}
      footerNote={review.blocked ? "Une règle comptable bloque cette action." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDecision("cancel", override)} disabled={busy}>
            Revenir au formulaire
          </Button>
          <Button
            variant={review.outcome === "PASS" ? "primary" : "danger-outline"}
            onClick={() => onDecision("continue", override)}
            disabled={!canContinue || busy}
            busy={busy}
          >
            {continueLabel}
          </Button>
        </>
      }
    >
      <div className="wt-review__summary" data-outcome={review.outcome}>
        <Badge tone={meta.tone === "success" ? "success" : meta.tone === "warning" ? "warning" : "danger"}>{meta.label}</Badge>
        <span>{review.entity} · niveau de risque {review.riskLevel}</span>
      </div>

      <ModelProvenance model={review.model} onRetry={onRetry} onOpenModelSettings={onOpenModelSettings} />

      {review.question && (
        <Callout tone="info" title={review.question.prompt}>
          <p>{review.question.why}</p>
          <p><strong>Où trouver la réponse :</strong> {review.question.whereToFind}</p>
        </Callout>
      )}

      <section className="wt-review__section">
        <h3>Ce qui a été vérifié</h3>
        {review.checked.length
          ? <ul className="wt-review__list">{review.checked.map((item, index) => <li key={index}>{item}</li>)}</ul>
          : <p className="wt-review__muted">Aucun contrôle spécifique ne s'applique à cette opération.</p>}
      </section>

      {review.confirmed.length > 0 && (
        <section className="wt-review__section">
          <h3>Ce qui paraît correct</h3>
          <ul className="wt-review__list wt-review__list--ok">
            {review.confirmed.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </section>
      )}

      <section className="wt-review__section">
        <h3>Ce qui peut poser problème</h3>
        {review.findings.length
          ? <ul className="wt-review__findings">{review.findings.map((item, index) => <FindingCard key={`${item.code}-${index}`} finding={item} onApplyFix={onApplyFix} />)}</ul>
          : <p className="wt-review__muted">Rien à signaler.</p>}
      </section>

      {review.acknowledgementRequired && !review.blocked && (
        <label className="wt-review__ack">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>J'ai lu les points signalés et je maintiens cette saisie.</span>
        </label>
      )}

      {seriousModelFinding && !review.blocked && (
        <label className="wt-review__override">
          <span>Motif du passage outre (obligatoire, conservé dans l'audit)</span>
          <textarea
            className="wt-input"
            rows={2}
            value={override}
            onChange={(event) => setOverride(event.target.value)}
            placeholder="Ex. : le montant est bien celui de la pièce, la remise figure en pied de facture."
          />
        </label>
      )}

      <p className="wt-review__footnote">
        <HelpCircle size={13} aria-hidden="true" /> Wheat vous assiste : il n'est pas certifié par la DGI, ne dépose aucune
        déclaration et ne remplace pas la revue d'un comptable ou d'un fiscaliste qualifié. Vous restez l'auteur de la saisie.
      </p>
    </Dialog>
  );
}
