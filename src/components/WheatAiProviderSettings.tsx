import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  KeyRound,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Explainer,
  Field,
  HelpDisclosure,
  LoadingState,
  Switch,
} from "./ui";
import { WheatSelect, type WheatSelectOption } from "./ui/WheatSelect";
import { WheatAiMark } from "./ui/brand";

/**
 * Réglages > Wheat AI — provider, API key and free-model selection.
 *
 * Security posture visible from this file alone:
 *   - the key is typed into a password field and handed straight to the main
 *     process; it is never held in component state after submission, never
 *     written to `localStorage`, and never read back;
 *   - what comes back is masked metadata (`sk-or…4f2a`) produced in the main
 *     process, so the renderer never holds the real value;
 *   - "Tester la connexion" lists models rather than sending a prompt, so a
 *     test can never consume the user's free quota.
 */

type ProviderId = "openrouter" | "groq";

const PROVIDER_HELP: Record<ProviderId, { blurb: string; keyHint: string; console: string }> = {
  openrouter: {
    blurb: "Passerelle vers de nombreux modèles. Wheat n'y retient que ceux dont les métadonnées officielles confirment un tarif de zéro, en entrée comme en sortie.",
    keyHint: "Une clé OpenRouter commence par « sk-or- ».",
    console: "openrouter.ai/keys",
  },
  groq: {
    blurb: "Fournisseur rapide avec un palier gratuit. Wheat n'utilisé que les modèles que votre clé expose réellement — aucun identifiant n'est inventé.",
    keyHint: "Une clé Groq commence par « gsk_ ».",
    console: "console.groq.com/keys",
  },
};

function bridge() {
  return window.wheat as WheatBridge | undefined;
}

export function WheatAiProviderSettings({ notify, activeCompanyId }: { notify?: (message: string, tone: "success" | "info" | "warning") => void; activeCompanyId?: string }) {
  const [status, setStatus] = useState<WheatAiProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({ openrouter: "", groq: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProviderId, string>>>({});
  const [reveal, setReveal] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [removing, setRemoving] = useState<ProviderId | null>(null);
  const [models, setModels] = useState<WheatAiProviderModelList | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Local Ollama models are offered for document review alongside the provider
  // models: reviewing an invoice with a local model keeps the document on the
  // machine, which is the option most Wheat users should be choosing.
  const [localModels, setLocalModels] = useState<Array<{ id: string; label: string; vision: boolean }>>([]);

  const available = Boolean(bridge()?.getWheatAiProviderStatus);

  const load = useCallback(async () => {
    const api = bridge();
    if (!api?.getWheatAiProviderStatus) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await api.getWheatAiProviderStatus());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadModels = useCallback(async (refresh = false) => {
    const api = bridge();
    if (!api?.listWheatAiProviderModels) return;
    setModelsLoading(true);
    setModelsError(null);
    try {
      setModels(await api.listWheatAiProviderModels({ refresh }));
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status?.providers.some((provider) => provider.configured)) void loadModels(false);
  }, [status?.providers, loadModels]);

  useEffect(() => {
    const api = bridge() as any;
    if (!api?.getWheatAiStatus) return;
    let active = true;
    api.getWheatAiStatus({ companyId: activeCompanyId })
      .then((result: any) => {
        if (!active) return;
        setLocalModels((result?.models ?? [])
          .filter((model: any) => model.provider === "OLLAMA" && model.installed)
          .map((model: any) => ({ id: String(model.id), label: String(model.displayName), vision: model.supportsVision === true })));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [activeCompanyId]);

  const saveKey = async (provider: ProviderId) => {
    const api = bridge();
    if (!api?.setWheatAiProviderKey) return;
    const apiKey = drafts[provider];
    if (!apiKey.trim()) {
      setFieldErrors((current) => ({ ...current, [provider]: "Entrez une clé d'API." }));
      return;
    }
    setBusyProvider(provider);
    setFieldErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      const next = await api.setWheatAiProviderKey({ provider, apiKey });
      setStatus(next);
      // The draft is cleared immediately: the plaintext key never lingers in
      // renderer memory once the main process has stored it.
      setDrafts((current) => ({ ...current, [provider]: "" }));
      notify?.(`Clé ${PROVIDER_LABEL[provider]} enregistrée et chiffrée sur ce poste.`, "success");
      void loadModels(true);
    } catch (error) {
      setFieldErrors((current) => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusyProvider(null);
    }
  };

  const deleteKey = async (provider: ProviderId) => {
    const api = bridge();
    if (!api?.deleteWheatAiProviderKey) return;
    setBusyProvider(provider);
    try {
      setStatus(await api.deleteWheatAiProviderKey({ provider }));
      notify?.(`Clé ${PROVIDER_LABEL[provider]} supprimée de ce poste.`, "success");
      void loadModels(true);
    } catch (error) {
      notify?.(error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setBusyProvider(null);
      setRemoving(null);
    }
  };

  const testProvider = async (provider: ProviderId) => {
    const api = bridge();
    if (!api?.testWheatAiProvider) return;
    setTesting(provider);
    try {
      const result = await api.testWheatAiProvider({ provider });
      notify?.(result.message, result.ok ? "success" : "warning");
      await load();
    } catch (error) {
      notify?.(error instanceof Error ? error.message : String(error), "warning");
    } finally {
      setTesting(null);
    }
  };

  const savePreferences = async (patch: Partial<WheatAiProviderPreferences>) => {
    const api = bridge();
    if (!api?.setWheatAiProviderPreferences) return;
    try {
      setStatus(await api.setWheatAiProviderPreferences(patch));
    } catch (error) {
      notify?.(error instanceof Error ? error.message : String(error), "warning");
    }
  };

  if (!available) {
    return (
      <Card title="Wheat AI — fournisseur et clé d'API" note="Disponible uniquement dans l'application desktop Wheat." icon={<WheatAiMark size={20} />}>
        <Callout tone="info">
          La configuration des fournisseurs Wheat AI nécessite l'application desktop : les clés d'API sont chiffrées par le coffre-fort du système d'exploitation, ce qu'un navigateur ne permet pas.
        </Callout>
      </Card>
    );
  }

  if (loading && !status) {
    return (
      <Card title="Wheat AI — fournisseur et clé d'API" icon={<WheatAiMark size={20} />}>
        <LoadingState label="Lecture de la configuration Wheat AI…" rows={3} />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card title="Wheat AI — fournisseur et clé d'API" icon={<WheatAiMark size={20} />}>
        <ErrorState
          title="La configuration Wheat AI n'a pas pu être lue"
          cause={loadError}
          fix="Aucune clé n'a été modifiée. Réessayez ; si le problème persiste, redémarrez Wheat."
          onRetry={() => void load()}
        />
      </Card>
    );
  }

  const preferences = status?.preferences;
  const configuredCount = status?.providers.filter((provider) => provider.configured).length ?? 0;

  const providerOptions: WheatSelectOption[] = [
    { value: "auto", label: "Automatique — le meilleur des deux", note: "Classe ensemble les modèles gratuits de tous les fournisseurs configures" },
    ...(status?.providers ?? []).map((provider) => ({
      value: provider.id,
      label: provider.label,
      note: provider.configured ? "Clé configuree" : "Aucune clé enregistrée",
      disabled: !provider.configured,
    })),
  ];

  const modelOptions: WheatSelectOption[] = (models?.models ?? []).map((model) => ({
    value: model.selectionId,
    label: model.label,
    note: `${PROVIDER_LABEL[model.provider]} · ${Math.round(model.contextTokens / 1000)}k contexte · ${model.rankingReason}`,
    keywords: model.id,
    group: PROVIDER_LABEL[model.provider],
    badge: model.supportsTools ? <Badge tone="success">Actions</Badge> : <Badge tone="neutral">Reponses</Badge>,
  }));

  // Review models: the recognised TEXT is what gets reviewed, so every chat
  // model qualifies and none is filtered out for lacking vision. Local models
  // come first — reviewing an invoice locally keeps it on this machine.
  const reviewModelOptions: WheatSelectOption[] = [
    ...localModels.map((model) => ({
      value: model.id,
      label: model.label,
      note: model.vision ? "Ollama local · lit aussi les images" : "Ollama local · texte reconnu",
      group: "Local — rien ne quitte ce poste",
      badge: <Badge tone="success">Local</Badge>,
    })),
    ...(models?.models ?? []).map((model) => ({
      value: model.selectionId,
      label: model.label,
      note: `${PROVIDER_LABEL[model.provider]} · ${Math.round(model.contextTokens / 1000)}k contexte`,
      group: "Fournisseur — le texte est transmis sur internet",
      badge: <Badge tone="warning">Distant</Badge>,
    })),
  ];

  // A stored review model is only honoured while it is still offered. It is
  // never erased on its own: an Ollama service that is momentarily stopped must
  // not silently throw away the user's choice.
  const reviewModelKnown = Boolean(
    preferences?.documentAiReviewModelId
    && reviewModelOptions.some((option) => option.value === preferences.documentAiReviewModelId),
  );
  const reviewModelMissing = Boolean(preferences?.documentAiReviewModelId) && !reviewModelKnown && reviewModelOptions.length > 0;

  // The same rule for the shared reviewer's own model: a choice is kept while
  // it is still offered, reported when it is not, and never quietly swapped.
  const assistedReviewModelKnown = Boolean(
    preferences?.assistedReviewModelId
    && reviewModelOptions.some((option) => option.value === preferences.assistedReviewModelId),
  );
  const assistedReviewModelMissing = Boolean(preferences?.assistedReviewModelId) && !assistedReviewModelKnown && reviewModelOptions.length > 0;

  return (
    <Card
      title="Wheat AI — fournisseur et clé d'API"
      note="Choisissez d'ou viennent les reponses de Wheat AI. Sans clé, Wheat AI continue de fonctionner avec les modèles installés localement."
      icon={<WheatAiMark size={20} />}
      actions={
        <Badge tone={configuredCount ? "success" : "neutral"} dot>
          {configuredCount ? `${configuredCount} fournisseur(s) configure(s)` : "Aucun fournisseur configure"}
        </Badge>
      }
    >
      <Callout tone={status?.secureStorageAvailable ? "success" : "danger"} icon={<ShieldCheck size={17} />} title={status?.secureStorageAvailable ? "Vos clés sont chiffrées" : "Enregistrement impossible"}>
        {status?.secureStorageNote}
      </Callout>

      <HelpDisclosure summary="Que fait exactement un fournisseur Wheat AI ?">
        <p>
          Wheat AI a besoin d'un <strong>modèle de langage</strong> pour répondre. Ce modèle peut tourner <strong>sur votre ordinateur</strong> (rien ne sort du poste) ou chez un <strong>fournisseur distant</strong> comme OpenRouter ou Groq.
        </p>
        <p>
          Avec un fournisseur distant, seule votre question et un résumé borné du dossier ouvert sont envoyes. Wheat n'envoie jamais la base comptable, les fichiers PDF ou les documents scannes.
        </p>
        <p>
          Wheat n'utilisé que des modèles <strong>gratuits vérifiés</strong> : un modèle dont le tarif n'est pas confirme à zéro par le fournisseur lui-même est écarté. Vous ne pouvez donc pas être facture à votre insu.
        </p>
      </HelpDisclosure>

      <div className="wt-grid wt-grid--wide">
        {(status?.providers ?? []).map((provider) => {
          const help = PROVIDER_HELP[provider.id];
          const busy = busyProvider === provider.id;
          return (
            <div className="wt-fieldset" key={provider.id}>
              <div className="wt-row wt-row--between">
                <span className="wt-row" style={{ gap: "var(--space-4)" }}>
                  <Plug size={17} aria-hidden="true" style={{ color: "var(--brand)" }} />
                  <strong>{provider.label}</strong>
                </span>
                {provider.configured ? (
                  <Badge tone="success" dot>Clé enregistrée</Badge>
                ) : (
                  <Badge tone="neutral" dot>Non configure</Badge>
                )}
              </div>

              <p className="wt-hint">{help.blurb}</p>

              {provider.configured ? (
                <>
                  <Field
                    label="Clé enregistrée"
                    htmlFor={`wheat-ai-${provider.id}-masked`}
                    hint={provider.keyUpdatedAt ? `Enregistrée le ${new Date(provider.keyUpdatedAt).toLocaleString("fr-FR")}` : undefined}
                  >
                    <div className="wt-input-affix">
                      <KeyRound size={15} aria-hidden="true" />
                      <input
                        id={`wheat-ai-${provider.id}-masked`}
                        readOnly
                        value={reveal[provider.id] ? (provider.maskedKey ?? "") : "••••••••••••••••"}
                        aria-label={`Clé ${provider.label}, affichee masquee`}
                      />
                      <button
                        type="button"
                        className="wt-icon-btn wt-icon-btn--sm"
                        aria-label={reveal[provider.id] ? "Masquer l'empreinte de la clé" : "Afficher l'empreinte de la clé"}
                        onClick={() => setReveal((current) => ({ ...current, [provider.id]: !current[provider.id] }))}
                      >
                        <Eye size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </Field>
                  <p className="wt-hint">
                    Wheat n'affiche jamais la clé complète, même a vous : seule une empreinte (debut et fin) est conservée pour la reconnaitre.
                  </p>
                </>
              ) : (
                <Field
                  label="Clé d'API"
                  htmlFor={`wheat-ai-${provider.id}-key`}
                  hint={`${help.keyHint} Creez-la sur ${help.console}.`}
                  error={fieldErrors[provider.id]}
                >
                  <input
                    id={`wheat-ai-${provider.id}-key`}
                    className="wt-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={provider.id === "openrouter" ? "sk-or-…" : "gsk_…"}
                    value={drafts[provider.id]}
                    aria-invalid={Boolean(fieldErrors[provider.id]) || undefined}
                    onChange={(event) => setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveKey(provider.id);
                    }}
                  />
                </Field>
              )}

              {provider.lastTestedAt && (
                <Callout tone={provider.lastTestOk ? "success" : "warning"} icon={provider.lastTestOk ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}>
                  {provider.lastTestMessage}
                </Callout>
              )}

              <div className="wt-row">
                {provider.configured ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RefreshCw size={14} />}
                      busy={testing === provider.id}
                      onClick={() => void testProvider(provider.id)}
                    >
                      Tester la connexion
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<KeyRound size={14} />}
                      onClick={() => {
                        setDrafts((current) => ({ ...current, [provider.id]: "" }));
                        void deleteKey(provider.id).then(() => notify?.("Saisissez la nouvelle clé.", "info"));
                      }}
                      disabled={busy}
                    >
                      Remplacer la clé
                    </Button>
                    <span className="wt-spacer" />
                    <Button variant="danger-outline" size="sm" icon={<Trash2 size={14} />} onClick={() => setRemoving(provider.id)} disabled={busy}>
                      Supprimer
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<KeyRound size={14} />}
                    busy={busy}
                    disabled={!status?.secureStorageAvailable}
                    onClick={() => void saveKey(provider.id)}
                  >
                    Enregistrer la clé
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {configuredCount > 0 && preferences && (
        <>
          <hr className="wt-divider" />

          <Explainer icon={<Sparkles size={16} aria-hidden="true" />}>
            <strong>Automatique — modèles gratuits</strong> est le mode conseille : Wheat classe les modèles gratuits vérifiés selon leur compatibilité avec les actions Wheat AI, leur capacité de contexte et leur fiabilité, puis bascule automatiquement sur le suivant si l'un est indisponible ou limite (au plus {status?.maxFailoverAttempts} tentatives).
          </Explainer>

          <div className="wt-form-grid">
            <Field label="Fournisseur préféré" htmlFor="wheat-ai-provider" hint="« Automatique » compare les modèles gratuits de tous les fournisseurs configures.">
              <WheatSelect
                id="wheat-ai-provider"
                options={providerOptions}
                value={preferences.activeProvider}
                onChange={(value) => void savePreferences({ activeProvider: value as WheatAiProviderPreferences["activeProvider"] })}
                ariaLabel="Fournisseur préféré"
                searchable={false}
              />
            </Field>

            <Field label="Selection du modèle" htmlFor="wheat-ai-auto">
              <Switch
                checked={preferences.automaticFreeModels}
                onChange={(next) => void savePreferences({ automaticFreeModels: next, pinnedModelId: next ? null : preferences.pinnedModelId })}
                label="Automatique — modèles gratuits"
                hint="Recommande. Désactivez-le seulement pour imposer un modèle precis."
              />
            </Field>

            {!preferences.automaticFreeModels && (
              <Field
                label="Modèle impose"
                htmlFor="wheat-ai-model"
                hint="Wheat bascule quand même sur un autre modèle gratuit si celui-ci devient indisponible."
                className="wt-span-all"
              >
                <WheatSelect
                  id="wheat-ai-model"
                  options={modelOptions}
                  value={preferences.pinnedModelId ?? ""}
                  onChange={(value) => void savePreferences({ pinnedModelId: value || null })}
                  ariaLabel="Modèle impose"
                  placeholder="Choisir un modèle gratuit vérifié…"
                  searchPlaceholder="Rechercher un modèle…"
                  loading={modelsLoading}
                  error={modelsError}
                  onRetry={() => void loadModels(true)}
                  noOptionsLabel="Aucun modèle gratuit vérifié"
                  allowClear
                  footerNote={`${models?.models.length ?? 0} modèle(s) vérifié(s)`}
                />
              </Field>
            )}
          </div>

          <Card
            title="Modèle actif"
            note="Ce que Wheat AI utilisera pour votre prochaine question."
            icon={<Sparkles size={18} aria-hidden="true" />}
            className="wt-card--sunken"
            actions={
              <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} busy={modelsLoading} onClick={() => { void loadModels(true); void load(); }}>
                Actualiser
              </Button>
            }
          >
            <dl className="wt-kv">
              <div><dt>Fournisseur</dt><dd>{status?.activeSelection.provider ? PROVIDER_LABEL[status.activeSelection.provider] : "—"}</dd></div>
              <div><dt>Modèle</dt><dd>{status?.activeSelection.label}</dd></div>
            </dl>
            <p className="wt-hint">{status?.activeSelection.reason}</p>
          </Card>

          {models && models.errors.length > 0 && (
            <Callout tone="warning" title="Certains fournisseurs n'ont pas repondu">
              <ul>
                {models.errors.map((entry) => (
                  <li key={entry.provider}>{PROVIDER_LABEL[entry.provider]} : {entry.message}</li>
                ))}
              </ul>
            </Callout>
          )}

          <HelpDisclosure summary={`Modèles écartés par Wheat (${models?.rejected.length ?? 0})`}>
            <p>Wheat refuse tout modèle dont la gratuite n'est pas confirmée par les métadonnées officielles du fournisseur. Voici pourquoi chacun a été écarté :</p>
            {models?.rejected.length ? (
              <ul>
                {models.rejected.slice(0, 40).map((entry) => (
                  <li key={`${entry.provider}-${entry.id}`}>
                    <span className="wt-code">{entry.id}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Aucun modèle écarté pour le moment.</p>
            )}
          </HelpDisclosure>
        </>
      )}

      {preferences && (
        <Card
          title="Relecture IA des documents scannés"
          note="Optionnelle. L'OCR local de Wheat continue de fonctionner sans elle."
          icon={<Sparkles size={18} aria-hidden="true" />}
          className="wt-card--sunken"
        >
          <Callout tone="warning" title="Ce que cela envoie">
            Une fois activée, le <strong>texte reconnu</strong> de chaque document importé est soumis au modèle choisi pour vérification.
            Un modèle <strong>Ollama local</strong> traite le document sur ce poste, sans aucune sortie réseau. Un modèle de
            fournisseur (OpenRouter, Groq) reçoit ce texte sur internet. La relecture ne peut que compléter ou contester un champ :
            elle ne remplace jamais une valeur lue avec certitude, et toute valeur absente du document est rejetée.
          </Callout>

          {/* The review reads recognised TEXT, so any chat model qualifies —
              vision is never required here. A model is offered as soon as it can
              hold a conversation, local models first. */}
          <Field
            label="Modèle de relecture"
            htmlFor="wheat-ocr-review-model"
            hint="La relecture porte sur le texte reconnu : un modèle de texte suffit. Choisissez de préférence un modèle local pour que les documents comptables ne quittent pas ce poste."
          >
            <WheatSelect
              id="wheat-ocr-review-model"
              options={reviewModelOptions}
              value={reviewModelKnown ? preferences.documentAiReviewModelId ?? "" : ""}
              onChange={(value) => void savePreferences({ documentAiReviewModelId: value || null, documentAiReview: value ? preferences.documentAiReview : false })}
              ariaLabel="Modèle de relecture des documents"
              placeholder="Aucune relecture IA"
              noOptionsLabel="Aucun modèle local ni fournisseur disponible"
              loading={modelsLoading && !reviewModelOptions.length}
              allowClear
              footerNote={`${reviewModelOptions.length} modèle(s) utilisable(s) pour la relecture`}
            />
          </Field>

          {/* A model can legitimately disappear between two sessions — an Ollama
              model deleted, a provider key removed. The stored choice is kept so
              nothing is lost if it comes back, and the reason is stated instead
              of leaving an empty selector that looks broken. */}
          {reviewModelMissing && (
            <Callout tone="warning" icon={<AlertTriangle size={16} />} title="Le modèle de relecture choisi n'est plus disponible">
              Wheat avait retenu « {preferences.documentAiReviewModelId?.replace(/^(ollama|remote):/, "")} ». Il n'est plus proposé sur ce poste :
              la relecture IA reste inactive tant qu'un autre modèle n'est pas choisi. L'OCR local, lui, continue de fonctionner normalement.
            </Callout>
          )}

          {!reviewModelOptions.length && !modelsLoading && (
            <Callout tone="info" title="Aucun modèle utilisable pour l'instant">
              Installez un modèle avec Ollama sur ce poste, ou enregistrez une clé d'API ci-dessus, pour pouvoir faire relire vos documents.
            </Callout>
          )}

          <Field label="Activation" htmlFor="wheat-ocr-review-toggle">
            <Switch
              checked={preferences.documentAiReview}
              disabled={!reviewModelKnown}
              onChange={(next) => void savePreferences({ documentAiReview: next })}
              label="Relire chaque document importé avec ce modèle"
              hint={reviewModelKnown
                ? (preferences.documentAiReviewModelId?.startsWith("ollama:")
                  ? "Traitement local : le document ne quitte pas cet ordinateur."
                  : "Le texte du document sera transmis au fournisseur choisi.")
                : "Choisissez d'abord un modèle de relecture."}
            />
          </Field>
        </Card>
      )}

      <Card
        title="Relecture avant enregistrement"
        note="Avant chaque enregistrement comptable, Wheat contrôle la saisie. Les contrôles de règle — équilibre débit/crédit, HT + TVA = TTC, périodes verrouillées, imputations — sont toujours exécutés et ne dépendent d'aucun modèle."
        icon={<ShieldCheck size={18} aria-hidden="true" />}
      >
        <Field label="Relecture assistée" htmlFor="wheat-assisted-review-toggle">
          <Switch
            checked={preferences?.assistedReview !== false}
            onChange={(next) => void savePreferences({ assistedReview: next })}
            label="Ajouter une relecture par un modèle, quand un modèle est disponible"
            hint="Désactivée, Wheat exécute uniquement ses contrôles de règle. Il ne prétend jamais qu'une relecture a eu lieu si aucun modèle n'a répondu."
          />
        </Field>

        <Field label="Relecture par un fournisseur distant" htmlFor="wheat-assisted-review-remote">
          <Switch
            checked={preferences?.assistedReviewRemoteConsent === true}
            disabled={preferences?.assistedReview === false}
            onChange={(next) => void savePreferences({ assistedReviewRemoteConsent: next })}
            label="J'autorise l'envoi d'extraits du dossier à un fournisseur distant, faute de modèle local"
            hint="Wheat privilégie toujours un modèle installé sur ce poste, avec lequel aucune donnée ne sort de l'ordinateur. Sans modèle local et sans cette autorisation, la relecture assistée est simplement annoncée comme indisponible."
          />
        </Field>

        {/* Which model reviews the accounting work is a question an accountant
            is entitled to a straight answer to. It is its own setting, not a
            reuse of the assistant's or the scan-reader's, because those answer
            different questions and sharing one control made this one
            unanswerable. */}
        <Field
          label="Modèle de relecture"
          htmlFor="wheat-assisted-review-model"
          hint={
            assistedReviewModelMissing
              ? undefined
              : "Automatique choisit d'abord un modèle installé sur ce poste, puis — avec votre autorisation ci-dessus — un modèle gratuit d'un fournisseur configuré. Un modèle choisi explicitement est toujours celui qui relit : s'il ne répond pas, Wheat vous le dit au lieu d'en prendre un autre."
          }
        >
          <WheatSelect
            id="wheat-assisted-review-model"
            value={assistedReviewModelKnown ? preferences?.assistedReviewModelId ?? "" : ""}
            disabled={preferences?.assistedReview === false}
            onChange={(value) => void savePreferences({ assistedReviewModelId: value || null })}
            placeholder="Automatique — meilleur modèle gratuit disponible"
            options={reviewModelOptions}
            emptyLabel="Aucun modèle disponible : installez un modèle local ou configurez un fournisseur."
          />
        </Field>
        {assistedReviewModelMissing && (
          <Callout tone="warning" title="Le modèle de relecture choisi n'est plus proposé">
            Wheat avait retenu « {preferences?.assistedReviewModelId?.replace(/^(ollama|remote):/, "")} ». Il n'apparaît plus sur ce poste :
            Ollama est peut-être arrêté, ou le fournisseur ne le propose plus. Wheat ne le remplace pas de sa propre initiative —
            choisissez-en un autre, ou repassez en mode automatique. Vos contrôles de règle continuent de s'exécuter dans tous les cas.
          </Callout>
        )}

        <Explainer icon={<ShieldCheck size={15} aria-hidden="true" />}>
          Une observation d'un modèle ne bloque jamais un enregistrement et ne modifie jamais une valeur : elle est présentée avec sa preuve et sa confiance, et vous décidez. Wheat n'est pas certifié par la DGI et ne remplace pas la revue d'un professionnel qualifié.
        </Explainer>
      </Card>

      {configuredCount === 0 && (
        <EmptyState
          icon={<Plug size={22} aria-hidden="true" />}
          title="Aucun fournisseur distant configure"
          text="Wheat AI fonctionne déjà avec les modèles installés localement. Ajoutez une clé ci-dessus pour utiliser en plus les modèles gratuits d'OpenRouter ou de Groq."
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Supprimer la clé ${PROVIDER_LABEL[removing]} ?`}
          question="La clé sera effacee du coffre-fort de ce poste."
          consequence="Wheat AI cessera d'utiliser ce fournisseur. Les modèles installés localement restent disponibles, et vos données comptables ne sont pas touchees."
          reversible="Vous pourrez saisir une nouvelle clé à tout moment."
          confirmLabel="Supprimer la clé"
          tone="danger"
          busy={busyProvider === removing}
          onClose={() => setRemoving(null)}
          onConfirm={() => deleteKey(removing)}
        />
      )}
    </Card>
  );
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
};

export { ExternalLink as WheatAiProviderExternalIcon };
