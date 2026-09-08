import { AlertTriangle, CheckCircle2, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { Button, Callout, Dialog } from "./ui";
import {
  type WheatUpdateActions,
  type WheatUpdateStatusView,
  formatUpdateSize,
} from "../lib/updateStatus";
import "./WheatUpdate.css";

/**
 * Everything the accountant sees about an update.
 *
 * Three dialogs, because there are three decisions and Wheat makes none of
 * them: a version is *offered*, the download is *asked for*, and the restart is
 * *chosen*. Between them Wheat keeps working normally — someone halfway through
 * a VAT return is not interrupted by a program that decided to close itself.
 *
 * Nothing here invents reassurance. The progress figures are the bytes actually
 * written; when the release did not declare a size there is no percentage and
 * no bar, only the amount received so far.
 */

function ReleaseNotes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <>
      <span className="wt-eyebrow">Nouveautés</span>
      <ul className="wheat-update__notes">
        {notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
      </ul>
    </>
  );
}

/**
 * Real bytes only.
 *
 * With no declared size there is no bar and no percentage — an animated gauge
 * that does not track anything is a lie told to look busy, and the honest
 * alternative (how much has arrived) is information the person can actually use.
 */
export function UpdateDownloadProgress({ download }: { download: NonNullable<WheatUpdateStatusView["download"]> }) {
  const received = formatUpdateSize(download.transferredBytes);
  return (
    <div className="wheat-update__progress" aria-live="polite">
      {download.percent === null ? (
        <p className="wheat-update__progress-figure">{received} reçus</p>
      ) : (
        <>
          <div
            className="wheat-update__bar"
            role="progressbar"
            aria-valuenow={download.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progression du téléchargement"
          >
            <span className="wheat-update__bar-fill" style={{ width: `${download.percent}%` }} />
          </div>
          <p className="wheat-update__progress-figure">
            <strong>{download.percent} %</strong>
            <span>{received} / {formatUpdateSize(download.totalBytes ?? 0)}</span>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The dialogs, as one component so the shell wires updates in one place.
 *
 * Returns nothing at all in the states that must not interrupt: idle, checking,
 * up to date, and any state the person has already postponed.
 */
export function WheatUpdateNotices({
  status,
  actions,
  busy,
}: {
  status: WheatUpdateStatusView | null;
  actions: WheatUpdateActions;
  /** True while a download or install request is in flight from this window. */
  busy?: boolean;
}) {
  if (status?.installedUpdate) {
    return <UpdateInstalledDialog update={status.installedUpdate} onClose={actions.acknowledge} />;
  }
  if (!status) return null;

  const release = status.availableRelease;

  if (status.phase === "available" && release && !status.postponed) {
    return (
      <Dialog
        title="Une mise à jour de Wheat est disponible"
        note={`Version ${release.version}`}
        icon={<Download size={18} aria-hidden="true" />}
        size="sm"
        onClose={actions.postpone}
        footer={
          <>
            <Button variant="ghost" onClick={actions.postpone}>Plus tard</Button>
            <Button variant="primary" busy={busy} icon={<Download size={15} />} onClick={actions.download}>
              Mettre à jour
            </Button>
          </>
        }
        footerNote="Vos dossiers, écritures et documents ne sont pas touchés."
      >
        <ReleaseNotes notes={release.notes} />
      </Dialog>
    );
  }

  if (status.phase === "downloading" || status.phase === "verifying") {
    const downloading = status.phase === "downloading";
    return (
      <Dialog
        title={downloading ? "Téléchargement de la mise à jour…" : "Vérification de la mise à jour…"}
        note={status.availableVersion ? `Version ${status.availableVersion}` : undefined}
        icon={downloading ? <Download size={18} aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
        size="sm"
        onClose={() => undefined}
        closeLabel="Fermer"
        footerNote="Vous pouvez continuer à travailler pendant le téléchargement."
      >
        {downloading && status.download
          ? <UpdateDownloadProgress download={status.download} />
          : (
            <p className="wheat-update__progress-figure">
              Wheat contrôle la signature et l'empreinte du fichier avant de l'accepter.
            </p>
          )}
      </Dialog>
    );
  }

  if (status.phase === "ready" && status.automaticInstallationEnabled && !status.postponed) {
    // The same phase covers two situations, because they are the same
    // situation: a verified update sitting on disk waiting to be applied. The
    // difference is whether an attempt has already failed, and saying so is
    // what turns a repeated dialog into an explanation.
    const failed = Boolean(status.error);
    return (
      <Dialog
        title={failed ? "L'installation n'a pas pu démarrer" : "La mise à jour est prête"}
        note={status.availableVersion ? `Version ${status.availableVersion}` : undefined}
        icon={failed ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
        size="sm"
        onClose={actions.postpone}
        footer={
          <>
            <Button variant="ghost" onClick={actions.postpone}>Plus tard</Button>
            <Button variant="primary" busy={busy} icon={<RefreshCw size={15} />} onClick={actions.install}>
              {failed ? "Réessayer l'installation" : "Redémarrer et installer"}
            </Button>
          </>
        }
      >
        {failed ? (
          <Callout tone="danger" title={`Wheat ${status.currentVersion} n'a pas été modifié`} icon={<AlertTriangle size={17} aria-hidden="true" />}>
            {status.error}
          </Callout>
        ) : (
          <p className="wheat-update__lead">
            Wheat doit redémarrer pour terminer l'installation. Vous choisissez le moment : la mise à jour reste prête tant
            que vous ne l'avez pas lancée.
          </p>
        )}
        {release && <ReleaseNotes notes={release.notes} />}
        <Callout tone="warning" title="Avant de redémarrer" icon={<AlertTriangle size={17} aria-hidden="true" />}>
          Wheat enregistre les formulaires en cours de saisie, mais pas les fenêtres d'import ou d'analyse en cours.
          Terminez ce que vous avez commencé avant de redémarrer.
        </Callout>
      </Dialog>
    );
  }

  if (status.phase === "installing") {
    return (
      <Dialog
        title="Installation de la mise à jour…"
        note={status.availableVersion ? `Version ${status.availableVersion}` : undefined}
        icon={<RefreshCw size={18} aria-hidden="true" />}
        size="sm"
        onClose={() => undefined}
      >
        <p className="wheat-update__lead">
          Wheat prépare l'installation, puis va se fermer et se rouvrir automatiquement. N'éteignez pas l'ordinateur.
        </p>
        {/* Indeterminate on purpose: the Windows installer reports no progress
            of its own, so there is no figure to show. A bar that says only
            "something is happening" is the whole of what is actually known. */}
        <div
          className="wheat-update__bar wheat-update__bar--indeterminate"
          role="progressbar"
          aria-label="Installation en cours"
          aria-valuetext="Installation en cours"
        >
          <span className="wheat-update__bar-fill" />
        </div>
        <p className="wheat-update__lead">
          L'installateur Windows n'indique pas d'avancement chiffré. Cette étape dure généralement moins d'une minute.
        </p>
      </Dialog>
    );
  }

  return null;
}

/** Shown once, on the first launch after a successful update. */
export function UpdateInstalledDialog({
  update,
  onClose,
}: {
  update: NonNullable<WheatUpdateStatusView["installedUpdate"]>;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Wheat a été mis à jour"
      note={`Version ${update.version}, installée le ${new Date(update.installedAt).toLocaleDateString("fr-FR")}.`}
      icon={<CheckCircle2 size={18} aria-hidden="true" />}
      size="sm"
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Continuer</Button>}
    >
      <Callout tone="success" title="Vos données comptables sont intactes">
        Une mise à jour ne touche que le programme. Les dossiers, écritures et documents de ce poste sont inchangés.
      </Callout>
      <ReleaseNotes notes={update.notes} />
    </Dialog>
  );
}
