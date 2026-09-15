import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Cloud, CloudOff, ShieldCheck } from "lucide-react";
import { Badge, Button, Callout, Card, ConfirmDialog, Dialog, HelpDisclosure, Switch } from "./ui";

/**
 * Wheat Cloud AI — the accountant's half of the cloud story.
 *
 * There are two surfaces for cloud providers in Wheat and they are deliberately
 * different audiences. `WheatAiProviderSettings` is the advanced one: API keys,
 * model pinning, free-tier attestation, failover. It keeps every capability it
 * has. This is the other one, and the only one a normal user ever needs to see:
 *
 *     Wheat Cloud AI
 *     Connecté · Lecture des pièces disponible
 *     [ Gérer la connexion ]
 *
 * No key, no model identifier, no endpoint, no token. "Activer" opens the
 * provider's own authorisation page in the user's browser; what comes back is a
 * credential belonging to *their* account, stored by the operating system's
 * credential vault, which the renderer never sees.
 */

export type CloudStatus = {
  connected: boolean;
  providers: string[];
  authorizationProvider: string;
  canAuthorize: boolean;
  secureStorageAvailable: boolean;
  documentOcrEnabled: boolean;
  consentGiven: boolean;
  localRecognitionAvailable: boolean;
};

type CloudBridge = {
  getCloudStatus?: () => Promise<CloudStatus>;
  authorizeCloud?: () => Promise<CloudStatus>;
  disconnectCloud?: () => Promise<CloudStatus>;
  setCloudPreferences?: (payload: { documentOcrEnabled?: boolean; consentGiven?: boolean }) => Promise<CloudStatus>;
};

function bridge(): CloudBridge | undefined {
  return window.wheat as CloudBridge | undefined;
}

/**
 * What Wheat tells somebody before their first document leaves the machine.
 *
 * Plain, specific and complete: which document, to whom, and why. It is shown
 * once, before anything is sent, and the only way past it is an explicit "oui".
 * Nothing about it is designed to be clicked through — there is no pre-ticked
 * box, no "recommandé" badge, and refusing is a plain button, not a link.
 */
const CLOUD_DISCLOSURE = [
  "Pour lire une pièce scannée, Wheat envoie l'image de cette pièce au fournisseur d'IA que vous autorisez, qui la retranscrit et renvoie le texte.",
  "Seules les pièces que vous importez sont envoyées. Votre comptabilité — écritures, journaux, balances, soldes, sauvegardes — reste sur cet ordinateur et n'est jamais transmise.",
  "Une pièce comptable peut contenir des noms de clients, des adresses, un ICE, un IF, un RC et des montants. Le fournisseur les traite selon ses propres conditions.",
  "Le texte reconnu vous est toujours soumis avant toute écriture comptable : rien n'est enregistré sans votre vérification.",
] as const;

/* -------------------------------------------------------------- the gate */

export type CloudGate = {
  /** Why the import stopped: no connection yet, or no consent yet. */
  reason: "NOT_CONNECTED" | "CONSENT_REQUIRED";
  /** The documents the person already chose. They never choose them again. */
  filePaths: string[];
};

/**
 * The interruption, and the way back to what the person was doing.
 *
 * An accountant importing thirty invoices did not set out to configure an AI
 * service. So this dialog asks for exactly what is missing, in their language,
 * and then *resumes their import* — same files, same dossier, no second
 * selection, no second click on "Importer".
 */
export function WheatCloudGateDialog({
  gate,
  onResume,
  onCancel,
  notify,
}: {
  gate: CloudGate;
  onResume: (filePaths: string[]) => void;
  onCancel: () => void;
  notify?: (message: string, tone: "success" | "info" | "warning") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    const api = bridge();
    if (!api?.setCloudPreferences) {
      setError("Wheat Cloud AI est disponible dans l'application de bureau Wheat.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Consent first, and recorded before any authorisation begins: agreeing to
      // send documents and connecting an account are two separate decisions, and
      // the first is the one that governs whether anything is ever sent.
      let status = await api.setCloudPreferences({ consentGiven: true, documentOcrEnabled: true });
      if (!status.connected) {
        if (!api.authorizeCloud) throw new Error("La connexion à Wheat Cloud AI n'est pas disponible dans cette version.");
        status = await api.authorizeCloud();
      }
      if (!status.connected) throw new Error("La connexion n'a pas abouti. Relancez l'activation depuis cette fenêtre.");
      notify?.("Wheat Cloud AI est connecté. La lecture de vos pièces reprend.", "success");
      onResume(gate.filePaths);
    } catch (authorizationError) {
      setError(authorizationError instanceof Error ? authorizationError.message : "L'activation n'a pas abouti.");
    } finally {
      setBusy(false);
    }
  };

  const count = gate.filePaths.length;

  return (
    <Dialog
      icon={<Cloud size={18} aria-hidden="true" />}
      title="Activer Wheat Cloud AI pour lire vos pièces"
      note={count === 1
        ? "Votre pièce est prête. Il manque une autorisation, puis la lecture reprend toute seule."
        : `Vos ${count} pièces sont prêtes. Il manque une autorisation, puis la lecture reprend toute seule.`}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Pas maintenant</Button>
          <Button variant="primary" icon={<Cloud size={15} />} busy={busy} onClick={() => void enable()}>
            {gate.reason === "NOT_CONNECTED" ? "Activer Wheat Cloud AI" : "Autoriser et continuer"}
          </Button>
        </>
      }
      footerNote="Vous pouvez désactiver la lecture par le cloud à tout moment dans Réglages."
    >
      <div className="wt-stack">
        <Callout tone="info" icon={<ShieldCheck size={16} aria-hidden="true" />} title="Ce que Wheat envoie, et ce qu'il n'envoie pas">
          <ul className="wt-bullets">
            {CLOUD_DISCLOSURE.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Callout>
        <p className="wt-hint">
          L'activation ouvre la page d'autorisation du fournisseur dans votre navigateur. Le compte et la clé obtenus
          vous appartiennent : Wheat ne fournit aucune clé et ne facture rien. Revenez ensuite à Wheat, la lecture
          continue d'elle-même.
        </p>
        {error && <Callout tone="warning" title="L'activation n'a pas abouti">{error}</Callout>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ the panel */

/**
 * Réglages → Wheat Cloud AI. Status, connection, and the one switch that
 * matters: may a scanned page be read in the cloud?
 */
export function WheatCloudPanel({ notify }: { notify?: (message: string, tone: "success" | "info" | "warning") => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const available = Boolean(bridge()?.getCloudStatus);

  const load = useCallback(async () => {
    const api = bridge();
    if (!api?.getCloudStatus) return;
    try {
      setStatus(await api.getCloudStatus());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "État indisponible.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!available) return null;

  const run = async (action: () => Promise<CloudStatus>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
      notify?.(success, "success");
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : "L'opération n'a pas abouti.";
      setError(message);
      notify?.(message, "warning");
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;

  return (
    <Card
      icon={<Cloud size={18} aria-hidden="true" />}
      title="Wheat Cloud AI"
      note="Lecture des pièces et traitements IA exécutés par le fournisseur que vous autorisez."
      actions={connected
        ? <Badge tone="success"><CheckCircle2 size={13} aria-hidden="true" /> Connecté</Badge>
        : <Badge tone="neutral"><CloudOff size={13} aria-hidden="true" /> Non connecté</Badge>}
    >
      <div className="wt-stack">
        {status && !status.secureStorageAvailable && (
          <Callout tone="warning" title="Le coffre-fort du système est indisponible">
            Wheat refuse d'enregistrer une autorisation qu'il ne peut pas chiffrer. Ouvrez une session Windows normale,
            puis réessayez.
          </Callout>
        )}

        {status && (
          <p className="wt-hint">
            {connected
              ? `Connecté via ${status.providers.join(", ")}. La lecture des pièces et l'assistant peuvent utiliser le cloud.`
              : status.localRecognitionAvailable
                ? "Non connecté. Cette édition lit vos pièces localement ; le cloud reste une option."
                : "Non connecté. Cette édition lit vos pièces via le cloud ; sans connexion, seul le moteur local de repli est utilisé."}
          </p>
        )}

        {status && (
          <Switch
            checked={status.documentOcrEnabled}
            disabled={busy}
            onChange={(next) => void run(
              async () => {
                const api = bridge();
                if (!api?.setCloudPreferences) throw new Error("Réglage indisponible.");
                return api.setCloudPreferences({ documentOcrEnabled: next });
              },
              next ? "Lecture des pièces par le cloud activée." : "Lecture des pièces par le cloud désactivée.",
            )}
            label="Lire les pièces scannées avec Wheat Cloud AI"
            hint={status.localRecognitionAvailable
              ? "Désactivé, Wheat lit vos pièces uniquement sur cet ordinateur."
              : "Désactivé, Wheat se limite au moteur local de repli, moins précis sur les pièces scannées."}
          />
        )}

        <div className="wt-row">
          {connected
            ? (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
                Déconnecter
              </Button>
            )
            : (
              <Button
                variant="primary"
                icon={<Cloud size={15} />}
                busy={busy}
                disabled={busy || !(status?.canAuthorize ?? false)}
                onClick={() => void run(async () => {
                  const api = bridge();
                  if (!api?.authorizeCloud) throw new Error("Activation indisponible.");
                  return api.authorizeCloud();
                }, "Wheat Cloud AI est connecté.")}
              >
                Activer Wheat Cloud AI
              </Button>
            )}
        </div>

        {error && <Callout tone="warning" title="Wheat Cloud AI">{error}</Callout>}

        {confirmingDisconnect && status && (
          <ConfirmDialog
            title="Déconnecter Wheat Cloud AI"
            question={status.providers.length > 1
              ? `L'autorisation conservée sur ce poste pour ${status.providers.join(" et ")} sera effacée.`
              : `L'autorisation conservée sur ce poste pour ${status.providers[0] ?? "le fournisseur"} sera effacée.`}
            consequence={status.localRecognitionAvailable
              ? "La lecture des pièces continuera sur cet ordinateur. Wheat AI en ligne ne sera plus disponible."
              : "Les pièces scannées seront lues par le moteur local de repli, moins précis, tant que Wheat Cloud AI n'est pas reconnecté."}
            reversible="Vous pouvez réactiver Wheat Cloud AI à tout moment. Votre compte chez le fournisseur n'est pas touché."
            confirmLabel="Déconnecter"
            tone="danger"
            busy={busy}
            onClose={() => setConfirmingDisconnect(false)}
            onConfirm={async () => {
              setConfirmingDisconnect(false);
              await run(async () => {
                const api = bridge();
                if (!api?.disconnectCloud) throw new Error("Déconnexion indisponible.");
                return api.disconnectCloud();
              }, "Wheat Cloud AI a été déconnecté de ce poste.");
            }}
          />
        )}

        <HelpDisclosure summary="Où vont mes documents ?">
          <ul className="wt-bullets">
            {CLOUD_DISCLOSURE.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p>
            La connexion utilise l'autorisation officielle du fournisseur : Wheat n'embarque aucune clé et n'a accès à
            aucun compte. Vous pouvez révoquer l'accès depuis votre compte chez le fournisseur à tout moment, et
            « Déconnecter » efface l'autorisation conservée sur ce poste.
          </p>
        </HelpDisclosure>
      </div>
    </Card>
  );
}
