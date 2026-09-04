import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps a form's contents until the person decides what happens to them.
 *
 * One hook for every create-and-edit surface in Wheat, so the rule is written
 * once instead of re-derived per screen. What it guarantees:
 *
 *   - typing is persisted, debounced, without blocking the keystroke;
 *   - unmounting persists nothing new and destroys nothing;
 *   - re-mounting offers back what was there, scoped to this dossier;
 *   - a submission the domain service confirmed clears the draft, and a
 *     submission that failed does not.
 *
 * The last point is the one worth stating twice. `clear()` is called *after*
 * the service returns, never before and never in a `finally`: a posting that
 * fails validation, or a database that is briefly unavailable, must leave the
 * person exactly what they had typed. Punishing an error by deleting the work
 * is how the original bug felt from the outside.
 *
 * Usage:
 *
 * ```ts
 * const draft = useFormDraft({ companyId, entity: "invoice", draftKey: "new" });
 * useEffect(() => {
 *   draft.load().then((held) => { if (held) setForm(held.payload); });
 * }, [draft.load]);
 * useEffect(() => { draft.save(form); }, [form, draft.save]);
 * // after a confirmed submit:
 * await draft.clear();
 * ```
 */

export type FormDraftStatus = "idle" | "saving" | "saved" | "error";

export type HeldFormDraft<T> = {
  payload: T;
  updatedAt: string;
  /** The underlying record moved on since this draft was started. */
  stale: boolean;
};

/**
 * Long enough that ordinary typing does not write on every character, short
 * enough that the work is safe well before somebody can reach for the mouse.
 */
const AUTOSAVE_DELAY_MS = 700;

/**
 * Every mounted draft hook, so an imminent restart can write what is queued.
 *
 * Autosave already runs 700ms behind the keystroke, which is safe against the
 * ways Wheat normally closes. It is not safe against a restart the person
 * triggers deliberately — pressing "Redémarrer et installer" one keystroke
 * after typing would otherwise drop that last edit. `flushAllFormDrafts` closes
 * that window, and does it through the draft system that already exists rather
 * than a second one built for updates.
 */
const liveDrafts = new Set<() => Promise<void>>();

/**
 * Writes every queued draft now. Resolves when they have all settled.
 *
 * Never rejects: a draft that cannot be written is already reported in its own
 * form, and a failure here must not become a reason not to install an update.
 */
export async function flushAllFormDrafts() {
  await Promise.allSettled([...liveDrafts].map((flush) => flush()));
}

export function useFormDraft<T>({
  companyId,
  entity,
  draftKey,
  currentVersion = null,
  enabled = true,
}: {
  companyId: string | undefined;
  /** Form family: "invoice", "entry", "payment", "counterparty", … */
  entity: string;
  /** Identity within the family: "new", or the id of the record being edited. */
  draftKey: string;
  /** Version of the underlying record right now, for stale detection. */
  currentVersion?: number | null;
  enabled?: boolean;
}) {
  const [status, setStatus] = useState<FormDraftStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const pendingValue = useRef<unknown>(undefined);
  /**
   * What was last written, serialized. Autosave compares against it so that
   * re-rendering with an unchanged form — which React does constantly — does
   * not produce a write, and so that seeding a form from its own draft does
   * not immediately write that draft back.
   */
  const lastWritten = useRef<string | null>(null);
  const active = Boolean(enabled && companyId && typeof window !== "undefined" && window.wheat?.saveFormDraft);

  const cancelPending = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const flush = useCallback(async () => {
    if (!active || pendingValue.current === undefined) return;
    const value = pendingValue.current;
    pendingValue.current = undefined;
    const serialized = JSON.stringify(value ?? null);
    if (serialized === lastWritten.current) return;
    setStatus("saving");
    try {
      const saved = await window.wheat!.saveFormDraft!({ companyId, entity, draftKey, payload: value, baseVersion: currentVersion });
      lastWritten.current = serialized;
      setSavedAt(saved?.updatedAt ?? new Date().toISOString());
      setStatus("saved");
    } catch {
      // A draft that could not be written is reported, not thrown: the person
      // is mid-sentence, and the form in front of them still holds everything.
      setStatus("error");
    }
  }, [active, companyId, entity, draftKey, currentVersion]);

  /** Queues the current form contents. Safe to call on every change. */
  const save = useCallback((value: T) => {
    if (!active) return;
    pendingValue.current = value;
    cancelPending();
    timer.current = window.setTimeout(() => { void flush(); }, AUTOSAVE_DELAY_MS);
  }, [active, cancelPending, flush]);

  /** Reads back what was held, or null when there is nothing. */
  const load = useCallback(async (): Promise<HeldFormDraft<T> | null> => {
    if (!active || !window.wheat?.loadFormDraft) return null;
    try {
      const held = await window.wheat.loadFormDraft({ companyId, entity, draftKey, currentVersion });
      if (!held) return null;
      // Seeded state is not a change to write back.
      lastWritten.current = JSON.stringify(held.payload ?? null);
      setSavedAt(held.updatedAt ?? null);
      return { payload: held.payload as T, updatedAt: held.updatedAt, stale: Boolean(held.stale) };
    } catch {
      return null;
    }
  }, [active, companyId, entity, draftKey, currentVersion]);

  /**
   * Throws the draft away. For a confirmed submission, or an explicit discard —
   * never for navigation, and never before a write has actually succeeded.
   */
  const clear = useCallback(async () => {
    cancelPending();
    pendingValue.current = undefined;
    lastWritten.current = null;
    setSavedAt(null);
    setStatus("idle");
    if (!active || !window.wheat?.discardFormDraft) return;
    try {
      await window.wheat.discardFormDraft({ companyId, entity, draftKey });
    } catch {
      // Nothing to tell the person: the work they asked to be rid of is gone
      // from in front of them either way, and a stale row is harmless.
    }
  }, [active, cancelPending, companyId, entity, draftKey]);

  /**
   * On unmount, write what is queued rather than dropping it.
   *
   * This is the moment the original bug happened — a route change unmounts the
   * component — so it is the moment that must persist rather than discard. The
   * timer is cleared and its payload written immediately instead.
   */
  useEffect(() => () => {
    cancelPending();
    void flush();
  }, [cancelPending, flush]);

  // Registered for the whole life of the hook so `flushAllFormDrafts` always
  // holds the current `flush`, which closes over the latest form identity.
  useEffect(() => {
    liveDrafts.add(flush);
    return () => { liveDrafts.delete(flush); };
  }, [flush]);

  return { save, load, clear, flush, status, savedAt };
}


/**
 * The whole pattern, for a form that opens, is typed into, and is submitted.
 *
 * Wraps `useFormDraft` so a screen states its intent once instead of writing
 * the same three effects per composer:
 *
 *   - while the form is open, its contents are autosaved;
 *   - when it opens, anything held for that identity is offered back;
 *   - a draft started against a record that has since changed is reported
 *     rather than applied.
 *
 * `onRestore` receives the held contents and decides what to do with them —
 * usually setting the form state. It is called only on the transition into an
 * open form, never on every render, so it cannot fight the person's typing.
 */
export function useDraftedForm<T>({
  companyId,
  entity,
  draftKey,
  currentVersion = null,
  open,
  value,
  onRestore,
  onStale,
}: {
  companyId: string | undefined;
  entity: string;
  draftKey: string;
  currentVersion?: number | null;
  /** Whether the form is on screen. Autosave runs only while it is. */
  open: boolean;
  /** Current form contents. */
  value: T;
  /** Called once, on opening, when unfinished work was held for this identity. */
  onRestore: (payload: T, meta: { updatedAt: string }) => void;
  /**
   * Called instead of `onRestore` when the underlying record moved on while the
   * draft sat. The held work is not applied over newer data without asking.
   */
  onStale?: (payload: T, meta: { updatedAt: string }) => void;
}) {
  const draft = useFormDraft<T>({ companyId, entity, draftKey, currentVersion, enabled: open });
  const { load, save } = draft;
  /** The identity currently restored, so re-opening the same form does not re-seed. */
  const restoredFor = useRef<string | null>(null);
  /**
   * The identity autosave is allowed to write under.
   *
   * A form does not empty itself the instant the dossier changes: for one
   * render its state still holds what somebody typed against the *previous*
   * dossier, while `companyId` already names the new one. Autosaving in that
   * render filed one dossier's unfinished work under another — which is the one
   * thing a per-dossier draft must never do.
   *
   * So writing is armed per identity, and only once the read for that identity
   * has come back. Until then the contents on screen belong to whatever was
   * there before, and belong to no draft at all.
   */
  const [armedFor, setArmedFor] = useState<string | null>(null);
  // Held in refs so that a screen passing inline callbacks — which is every
  // screen — does not re-run the restore effect on each render and re-seed the
  // form over what somebody is typing.
  const restoreHandler = useRef(onRestore);
  const staleHandler = useRef(onStale);
  useEffect(() => {
    restoreHandler.current = onRestore;
    staleHandler.current = onStale;
  });

  useEffect(() => {
    const identity = `${companyId ?? ""}|${entity}|${draftKey}`;
    if (!open || !companyId) {
      // Closing releases the latch so the next opening offers the work again.
      if (!open) {
        restoredFor.current = null;
        setArmedFor(null);
      }
      return;
    }
    if (restoredFor.current === identity) return;
    restoredFor.current = identity;
    setArmedFor(null);
    let cancelled = false;
    void load().then((held) => {
      if (cancelled) return;
      if (held?.stale) staleHandler.current?.(held.payload, { updatedAt: held.updatedAt });
      else if (held) restoreHandler.current(held.payload, { updatedAt: held.updatedAt });
      // Armed after the read, whether or not anything was held: from here on,
      // what is on screen is this identity's work.
      setArmedFor(identity);
    });
    return () => { cancelled = true; };
  }, [open, companyId, entity, draftKey, load]);

  useEffect(() => {
    if (!open || !companyId) return;
    if (armedFor !== `${companyId}|${entity}|${draftKey}`) return;
    save(value);
  }, [open, value, save, armedFor, companyId, entity, draftKey]);

  return draft;
}
