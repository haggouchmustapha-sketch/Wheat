/**
 * Unfinished work, kept until the person decides what happens to it.
 *
 * The rule this module exists to enforce is one sentence long: navigating is
 * not consent to delete. Wheat used to hold every in-progress form in React
 * state and nowhere else, so opening the suppliers list to check a name, and
 * coming back, discarded a half-entered invoice — not as a bug in one screen
 * but as the default behaviour of every screen, because unmounting a component
 * is what a router does and component state is what unmounting destroys.
 *
 * What is stored here is form contents, not accounting data, and the
 * distinction is the whole design. A half-typed invoice is not an `Invoice`:
 * putting one in the ledger tables to keep it safe would place a record nobody
 * has decided on into the books, which is a worse failure than the one being
 * fixed. So drafts live in their own table, are never read by any accounting
 * service, and become accounting data only when the person submits them
 * through the service that owns that decision — unchanged, still reviewed,
 * still validated inside its own transaction.
 *
 * Three properties the callers depend on.
 *
 * *A draft belongs to one dossier.* Every read and write is scoped by company
 * and the row cascades with it. A draft begun in one dossier cannot appear in
 * another, and switching dossiers cannot merge two pieces of unfinished work.
 *
 * *Drafts do not overwrite each other.* `(company, entity, draftKey)` is the
 * identity. An unfinished purchase invoice, an unfinished sale invoice and an
 * unfinished journal entry are three drafts; so are edits to two different
 * existing records.
 *
 * *A stale draft is shown, never silently applied.* An edit draft records the
 * version of the record it was started from. If that record has moved on since
 * — posted, corrected elsewhere — the draft is returned marked stale so the
 * interface can ask, instead of quietly writing old values over new ones.
 *
 * Deliberately not audit-chained. The SHA-256 chain records what happened to
 * the books; typing is not something that happened to the books. Appending a
 * chain event per autosave would bury the events that matter under keystroke
 * noise and change what the chain means. Submission is audited exactly as it
 * was, by the service that performs it.
 */

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };

export const WHEAT_FORM_DRAFT_CHANNELS = {
  save: "wheat:draft:save",
  load: "wheat:draft:load",
  list: "wheat:draft:list",
  discard: "wheat:draft:discard",
} as const;

/**
 * A cap on one draft, generous for a form and small enough that a runaway
 * writer cannot fill the disk. A form that genuinely exceeds this is not a
 * form; refusing it loudly beats truncating somebody's work silently.
 */
const MAX_PAYLOAD_BYTES = 256_000;
const MAX_ENTITY_LENGTH = 64;
const MAX_KEY_LENGTH = 200;
/** Enough for every unfinished item a person can plausibly be holding. */
const MAX_DRAFTS_PER_COMPANY = 200;

export type FormDraftRecord = {
  entity: string;
  draftKey: string;
  payload: unknown;
  baseVersion: number | null;
  revision: number;
  updatedAt: string;
  /** The underlying record changed since this draft was started. */
  stale: boolean;
};

function identifier(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} est requis.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} est trop long.`);
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) throw new Error(`${label} contient des caractères non autorisés.`);
  return text;
}

function optionalVersion(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} doit être un entier positif.`);
  return value as number;
}

function serializePayload(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    throw new Error("Ce brouillon contient une valeur qui ne peut pas être enregistrée.");
  }
  if (typeof text !== "string") throw new Error("Ce brouillon est vide.");
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Ce brouillon dépasse la taille maximale d'un formulaire.");
  }
  return text;
}

function parsePayload(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createFormDraftService(getPrisma: GetPrisma) {
  async function company(companyId: unknown): Promise<string> {
    const id = identifier(companyId, "Le dossier", 200);
    const prisma = await getPrisma();
    const found = await prisma.company.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new Error("Le dossier actif n'existe plus.");
    return id;
  }

  /**
   * Writes or replaces one draft.
   *
   * Idempotent per identity, so an autosave that fires twice costs one row and
   * one revision bump rather than two competing drafts.
   */
  async function save(payloadValue: unknown): Promise<FormDraftRecord> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = await company(input.companyId);
    const entity = identifier(input.entity, "Le type de brouillon", MAX_ENTITY_LENGTH);
    const draftKey = identifier(input.draftKey, "L'identifiant du brouillon", MAX_KEY_LENGTH);
    const baseVersion = optionalVersion(input.baseVersion, "La version de référence");
    const payload = serializePayload(input.payload);

    const prisma = await getPrisma();
    const existing = await prisma.formDraft.findUnique({
      where: { companyId_entity_draftKey: { companyId, entity, draftKey } },
      select: { id: true, revision: true },
    });

    if (!existing) {
      const held = await prisma.formDraft.count({ where: { companyId } });
      if (held >= MAX_DRAFTS_PER_COMPANY) {
        throw new Error(`Ce dossier détient déjà ${MAX_DRAFTS_PER_COMPANY} brouillons non terminés. Terminez-en ou supprimez-en avant d'en commencer un autre.`);
      }
    }

    const row = await prisma.formDraft.upsert({
      where: { companyId_entity_draftKey: { companyId, entity, draftKey } },
      create: { companyId, entity, draftKey, payload, baseVersion, revision: 1 },
      update: { payload, baseVersion, revision: (existing?.revision ?? 0) + 1 },
    });

    return {
      entity: row.entity,
      draftKey: row.draftKey,
      payload: parsePayload(row.payload),
      baseVersion: row.baseVersion ?? null,
      revision: row.revision,
      updatedAt: new Date(row.updatedAt).toISOString(),
      stale: false,
    };
  }

  /**
   * Reads one draft back.
   *
   * `currentVersion` is what the caller knows about the underlying record right
   * now. When it is supplied and differs from the version the draft was started
   * against, the draft comes back marked `stale`: still returned, because it is
   * the person's work and discarding it unasked is the very thing this module
   * exists to prevent, but flagged so the interface asks before applying it.
   */
  async function load(payloadValue: unknown): Promise<FormDraftRecord | null> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = await company(input.companyId);
    const entity = identifier(input.entity, "Le type de brouillon", MAX_ENTITY_LENGTH);
    const draftKey = identifier(input.draftKey, "L'identifiant du brouillon", MAX_KEY_LENGTH);
    const currentVersion = optionalVersion(input.currentVersion, "La version courante");

    const prisma = await getPrisma();
    const row = await prisma.formDraft.findUnique({
      where: { companyId_entity_draftKey: { companyId, entity, draftKey } },
    });
    if (!row) return null;

    return {
      entity: row.entity,
      draftKey: row.draftKey,
      payload: parsePayload(row.payload),
      baseVersion: row.baseVersion ?? null,
      revision: row.revision,
      updatedAt: new Date(row.updatedAt).toISOString(),
      stale: currentVersion !== null && row.baseVersion !== null && row.baseVersion !== currentVersion,
    };
  }

  /** Everything unfinished in this dossier, newest first. */
  async function list(payloadValue: unknown): Promise<FormDraftRecord[]> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = await company(input.companyId);
    const prisma = await getPrisma();
    const rows = await prisma.formDraft.findMany({
      where: { companyId },
      orderBy: { updatedAt: "desc" },
      take: MAX_DRAFTS_PER_COMPANY,
    });
    return rows.map((row: any) => ({
      entity: row.entity,
      draftKey: row.draftKey,
      payload: parsePayload(row.payload),
      baseVersion: row.baseVersion ?? null,
      revision: row.revision,
      updatedAt: new Date(row.updatedAt).toISOString(),
      stale: false,
    }));
  }

  /**
   * Throws one draft away.
   *
   * Called on an explicit discard and after a submission the domain service
   * confirmed — never before it, and never because a component unmounted.
   * Deleting a draft that was never persisted is not an error: the caller
   * asking for the work to be gone gets that outcome either way.
   */
  async function discard(payloadValue: unknown): Promise<{ discarded: boolean }> {
    const input = (payloadValue ?? {}) as Record<string, unknown>;
    const companyId = await company(input.companyId);
    const entity = identifier(input.entity, "Le type de brouillon", MAX_ENTITY_LENGTH);
    const draftKey = identifier(input.draftKey, "L'identifiant du brouillon", MAX_KEY_LENGTH);
    const prisma = await getPrisma();
    const result = await prisma.formDraft.deleteMany({ where: { companyId, entity, draftKey } });
    return { discarded: (result?.count ?? 0) > 0 };
  }

  return { save, load, list, discard };
}

export function registerFormDraftIpc(ipcMain: IpcLike, service: ReturnType<typeof createFormDraftService>) {
  ipcMain.handle(WHEAT_FORM_DRAFT_CHANNELS.save, async (_event, payload) => service.save(payload));
  ipcMain.handle(WHEAT_FORM_DRAFT_CHANNELS.load, async (_event, payload) => service.load(payload));
  ipcMain.handle(WHEAT_FORM_DRAFT_CHANNELS.list, async (_event, payload) => service.list(payload));
  ipcMain.handle(WHEAT_FORM_DRAFT_CHANNELS.discard, async (_event, payload) => service.discard(payload));
}
