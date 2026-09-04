import { CheckCircle2, CircleDashed, HelpCircle, Lock, Play } from "lucide-react";
import { Badge, Button, Card, NextStep } from "./ui";
import "./WheatReview.css";

/**
 * The guided dossier journey, rendered from the state the main process derives.
 *
 * There is no local checklist here and no stored progress: every status comes
 * from `wheat:journey:state`, which reads the dossier's own records. That is
 * what makes the "next action" trustworthy — it cannot claim a step is done
 * when the ledger says otherwise.
 */

const STATUS_META: Record<WheatJourneyStage["status"], { label: string; tone: "success" | "info" | "warning" | "neutral"; icon: typeof Play }> = {
  DONE: { label: "Terminé", tone: "success", icon: CheckCircle2 },
  READY: { label: "À faire maintenant", tone: "info", icon: Play },
  NEEDS_ANSWER: { label: "Une réponse attendue", tone: "warning", icon: HelpCircle },
  BLOCKED: { label: "Bloqué", tone: "neutral", icon: Lock },
};

export function GuidedJourney({
  journey,
  onOpen,
  compact = false,
}: {
  journey: WheatJourneyState | null;
  onOpen: (target: string) => void;
  compact?: boolean;
}) {
  if (!journey) return null;
  const stages = compact ? journey.stages.filter((stage) => stage.status !== "DONE").slice(0, 4) : journey.stages;

  return (
    <Card
      title="Parcours guidé du dossier"
      note={`${journey.completed} étape(s) terminées sur ${journey.total}. L'avancement est calculé à partir du dossier lui-même, pas d'une liste à cocher.`}
    >
      {journey.next && (
        <NextStep
          title={journey.next.title}
          text={`${journey.next.state} ${journey.next.why}`}
          action={journey.next.action
            ? <Button variant="primary" onClick={() => onOpen(journey.next!.action!.target)}>{journey.next.action.label}</Button>
            : undefined}
        />
      )}

      <div className="wt-journey" data-testid="wheat-journey">
        {stages.map((stage) => {
          const meta = STATUS_META[stage.status];
          const Icon = meta.icon;
          return (
            <div key={stage.id} className="wt-journey__stage" data-status={stage.status} data-stage={stage.id}>
              <span className="wt-journey__order" aria-hidden="true">{stage.order}</span>
              <span className="wt-journey__body">
                <span className="wt-journey__title">
                  <Icon size={14} aria-hidden="true" /> {stage.title}
                </span>
                <span className="wt-journey__state">{stage.state}</span>
                <span className="wt-journey__why">{stage.why}</span>
                {stage.status === "BLOCKED" && stage.blockedBy && (
                  <span className="wt-journey__why">Commencez d'abord par : {journey.stages.find((item) => item.id === stage.blockedBy)?.title ?? stage.blockedBy}.</span>
                )}
                {stage.question && (
                  <span className="wt-journey__question">
                    <strong>{stage.question.prompt}</strong>
                    <span>{stage.question.why}</span>
                    <span>Où trouver la réponse : {stage.question.whereToFind}</span>
                  </span>
                )}
              </span>
              <span className="wt-journey__actions">
                <Badge tone={meta.tone === "neutral" ? "neutral" : meta.tone}>{meta.label}</Badge>
                {stage.action && stage.status !== "BLOCKED" && (
                  <Button variant="ghost" size="sm" onClick={() => onOpen(stage.action!.target)}>{stage.action.label}</Button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {journey.inferred.length > 0 && (
        <ul className="wt-journey__inferred">
          <li><CircleDashed size={12} aria-hidden="true" /> Ce que Wheat a déduit tout seul, sans vous le demander :</li>
          {journey.inferred.map((item, index) => <li key={index}>— {item}</li>)}
        </ul>
      )}
    </Card>
  );
}
