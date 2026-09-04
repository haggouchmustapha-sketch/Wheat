import { useCallback, useEffect, useState } from "react";

/**
 * Reads the derived dossier journey from the main process.
 *
 * Lives beside the other renderer hooks rather than in the component file so
 * that file exports components only.
 */
export function useGuidedJourney(companyId?: string) {
  const [journey, setJourney] = useState<WheatJourneyState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!window.wheat?.getGuidedJourney) return;
    try {
      setJourney(await window.wheat.getGuidedJourney({ companyId }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [companyId]);

  useEffect(() => { void reload(); }, [reload]);

  return { journey, error, reload };
}
