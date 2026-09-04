import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, Lock, LockOpen, Sparkles } from "lucide-react";
import "./DossierSetupGate.css";

/**
 * Initial preparation of a dossier, before it is opened for work.
 *
 * This is a gate, and it is the only one in Wheat. Until a dossier has an
 * exercise, a chart and journals, an entry cannot be made in it coherently, so
 * the application keeps the accountant here rather than letting them build on a
 * foundation that is not there yet. That is the whole justification, and it is
 * said on screen in those terms: the point is not to withhold features, it is
 * that Wheat will not pretend a dossier is ready when its own records say
 * otherwise.
 *
 * What blocks and what merely waits are shown differently, and the difference
 * is load-bearing. A VAT regime belongs in setup and is prepared here, but a
 * company that is not VAT-registered has none to configure — gating on it would
 * shut such a dossier permanently, which is a trap rather than a gate.
 *
 * Everything about the surface follows from that. Each requirement states *why*
 * it is required, because "you may not proceed" without a reason is the kind of
 * software people learn to resent. Nothing here creates the missing pieces —
 * guided work below does that, prepares them, and asks for approval one by one.
 * And the moment the accountant approves the foundation, this disappears
 * permanently: the gate cannot come back and shut somebody out of a dossier
 * they are working in.
 */

export function DossierSetupGate({
  companyId,
  onUnlocked,
  onNotify,
}: {
  companyId: string | null;
  /** Called once the accountant has approved the foundation. */
  onUnlocked: () => void;
  onNotify?: (message: string, tone: "info" | "success" | "warning") => void;
}) {
  const [setup, setSetup] = useState<WheatDossierSetup | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId || !window.wheat?.getDossierSetup) return;
    try {
      setSetup(await window.wheat.getDossierSetup({ companyId }));
    } catch {
      // A dossier whose state cannot be read is not a dossier to lock somebody
      // out of: the gate fails open, and the rest of Wheat still validates.
      setSetup(null);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  if (!setup || setup.mode === "UNLOCKED") return null;

  const chooseSituation = async (situation: string) => {
    if (!companyId || !window.wheat?.setDossierSituation) return;
    setBusy(true);
    try {
      setSetup(await window.wheat.setDossierSituation({ companyId, situation }));
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : "Choix impossible", "warning");
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    if (!companyId || !window.wheat?.unlockDossier) return;
    setBusy(true);
    try {
      const next = await window.wheat.unlockDossier({ companyId });
      setSetup(next);
      if (next.mode === "UNLOCKED") {
        onNotify?.("Dossier prêt. Wheat reste disponible, mais ne vous impose plus de parcours.", "success");
        onUnlocked();
      }
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : "Ouverture impossible", "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="wt-setup-gate" aria-labelledby="wt-setup-gate-title">
      <header className="wt-setup-gate__head">
        <Lock size={18} aria-hidden="true" />
        <div>
          <h2 id="wt-setup-gate-title">Préparation du dossier</h2>
          <p>
            Wheat prépare d'abord la base comptable de ce dossier. Ce n'est pas une restriction : tant que l'exercice,
            le plan comptable et les journaux n'existent pas, toute écriture saisie devra être reprise.
          </p>
        </div>
      </header>

      {setup.question && (
        <div className="wt-setup-gate__question">
          <h3>{setup.question.prompt}</h3>
          <p className="wt-setup-gate__why">{setup.question.why}</p>
          <p className="wt-setup-gate__where">{setup.question.whereToFind}</p>
          <div className="wt-setup-gate__choices">
            {setup.situationOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className="wt-setup-gate__choice"
                disabled={busy}
                onClick={() => chooseSituation(option.value)}
              >
                <strong>{option.title}</strong>
                <span>{option.detail}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <ol className="wt-setup-gate__stages">
        {setup.stages.map((stage) => (
          <li key={stage.id} data-done={stage.done ? "true" : "false"} data-blocking={stage.blocking ? "true" : "false"}>
            {stage.done
              ? <CheckCircle2 size={16} aria-hidden="true" />
              : <CircleDashed size={16} aria-hidden="true" />}
            <div>
              <strong>
                {stage.title}
                {/* Said plainly, so nobody waits on something that is not in the way. */}
                {!stage.blocking && !stage.done && <em> — recommandé, n'empêche pas l'ouverture</em>}
              </strong>
              {/* Why, not just what: a requirement without a reason is an obstacle. */}
              <span>{stage.why}</span>
            </div>
          </li>
        ))}
      </ol>

      <footer className="wt-setup-gate__foot">
        {setup.readyToUnlock ? (
          <>
            <div className="wt-setup-gate__summary">
              <Sparkles size={15} aria-hidden="true" />
              <div>
                <strong>Wheat a préparé ce dossier.</strong>
                <ul>{setup.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
              </div>
            </div>
            <button type="button" className="wt-setup-gate__unlock" onClick={unlock} disabled={busy}>
              {busy ? <Loader2 size={15} className="wt-setup-gate__spin" aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}
              Approuver et ouvrir le dossier
            </button>
          </>
        ) : (
          <p className="wt-setup-gate__blocking" role="status">
            {setup.blockingReason} Utilisez le travail guidé ci-dessous : il prépare chaque élément et vous le soumet.
          </p>
        )}
      </footer>
    </section>
  );
}
