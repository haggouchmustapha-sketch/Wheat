/**
 * Which Wheat this is.
 *
 * Wheat ships as one product in two editions built from this one source tree:
 *
 *   - **Standard** — the complete local-oriented desktop experience. The local
 *     recognition runtime is packaged with it, more work happens on the
 *     machine, and the interface keeps every effect it has always had.
 *   - **Lightweight** — the same Wheat, the same accounting engine, the same
 *     database and the same features, executed so that an old office computer
 *     is not asked to do work it cannot afford. The two-gigabyte local
 *     recognition runtime is not packaged; recognition is performed by the
 *     configured cloud provider instead, and the interface spends less of the
 *     machine on presentation.
 *
 * **The edition never changes accounting.** It selects an execution strategy —
 * what is packaged, what runs locally, how much of the machine is used, how
 * much the interface animates. Posting, balances, VAT, journals, reports,
 * period locks and the database schema are identical in both, and a dossier
 * created by one opens unchanged in the other.
 *
 * ## Where the value comes from
 *
 * It is compiled into the build. `npm run build:<edition>` sets `WHEAT_EDITION`,
 * `vite.config.ts` turns it into the `__WHEAT_EDITION__` define, and a packaged
 * Wheat therefore states its own identity from its own bytes: no variable in a
 * user's shell can change what an installed build believes it is, which is the
 * same rule `securityBoundary.ts` applies to the renderer location and the
 * update source.
 *
 * `WHEAT_EDITION` in the environment is honoured only where nothing is
 * compiled in: an unbundled `tsx` run (the unit tests) and `npm run dev`.
 *
 * Shared by the main process and the renderer, exactly like `appVersion.ts`.
 */

export const WHEAT_EDITIONS = ["standard", "lightweight"] as const;

export type WheatEdition = (typeof WHEAT_EDITIONS)[number];

export function isWheatEdition(value: unknown): value is WheatEdition {
  return typeof value === "string" && (WHEAT_EDITIONS as readonly string[]).includes(value);
}

/**
 * The value `define` replaces at build time.
 *
 * Read through `typeof` so an unbundled run — where the identifier does not
 * exist at all — reads as absent instead of throwing a ReferenceError.
 */
declare const __WHEAT_EDITION__: string | undefined;

function compiledEdition(): string | null {
  return typeof __WHEAT_EDITION__ === "string" ? __WHEAT_EDITION__ : null;
}

function environmentEdition(): string | null {
  const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = globalProcess?.env?.WHEAT_EDITION ?? globalProcess?.env?.npm_config_wheat_edition;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Resolves the edition, or throws.
 *
 * A build that declares an edition Wheat does not know is a build mistake, and
 * the safe answer is to refuse to start rather than to silently behave as
 * Standard while an installer, an updater asset and a website download button
 * all say Lightweight. There is no valid state in which this guess is better
 * than a stop.
 */
export function resolveWheatEdition(candidate: string | null = compiledEdition() ?? environmentEdition()): WheatEdition {
  if (candidate === null) return "standard";
  const normalized = candidate.trim().toLowerCase();
  if (!isWheatEdition(normalized)) {
    throw new Error(
      `Wheat was built with an unknown edition "${candidate}". Valid editions are ${WHEAT_EDITIONS.join(", ")}.`,
    );
  }
  return normalized;
}

export const WHEAT_EDITION: WheatEdition = resolveWheatEdition();

/**
 * How aggressively an edition may use the machine, and what it was packaged
 * with.
 *
 * Everything edition-dependent in Wheat resolves through one of these fields.
 * Components and services ask the profile a question about capability —
 * "is a local recognition runtime packaged with me", "how many documents may I
 * recognise at once" — rather than comparing edition strings, so adding a third
 * edition later is a new row here and not a search through the source.
 */
export type WheatEditionProfile = {
  edition: WheatEdition;
  /** Shown in About and in diagnostics. Never a different product name. */
  label: string;
  /** One sentence, in French, for the About panel. */
  summary: string;
  /**
   * Whether the PaddleOCR runtime and its models are packaged with this build.
   * False does not mean "no OCR": it means recognition is performed by the
   * configured cloud provider, with the local Tesseract engine as the offline
   * fallback both editions carry.
   */
  hasBundledLocalOcr: boolean;
  /**
   * Whether cloud recognition is the expected path rather than an opt-in.
   * Only the *default* of a user-owned preference; it is never a lock.
   */
  cloudOcrByDefault: boolean;
  /** How much presentation work the interface may spend on a frame. */
  visualProfile: "full" | "economical";
  resource: {
    /**
     * Ceiling on documents recognised at once, on top of whatever the machine
     * itself can support. Lightweight keeps one document in flight: the work is
     * remote, so parallelism buys throughput the accountant did not ask for at
     * the price of memory the machine does not have.
     */
    maxOcrConcurrency: number;
    /** Entries kept in the on-disk recognition cache. */
    recognitionCacheLimit: number;
    /**
     * Whether the local recognition pool is built at startup. Only ever true
     * where that runtime is packaged, and even then it is a warm-up, not a
     * requirement.
     */
    warmLocalOcrAtStartup: boolean;
  };
};

const PROFILES: Record<WheatEdition, WheatEditionProfile> = {
  standard: {
    edition: "standard",
    label: "Édition Standard",
    summary: "Toutes les fonctionnalités comptables, avec la reconnaissance locale des pièces installée sur cet ordinateur.",
    hasBundledLocalOcr: true,
    cloudOcrByDefault: false,
    visualProfile: "full",
    resource: {
      maxOcrConcurrency: 4,
      recognitionCacheLimit: 400,
      warmLocalOcrAtStartup: true,
    },
  },
  lightweight: {
    edition: "lightweight",
    label: "Édition Lightweight",
    summary: "Toutes les fonctionnalités comptables, optimisées pour les ordinateurs moins puissants. La lecture des pièces et les traitements IA lourds peuvent utiliser le cloud sécurisé.",
    hasBundledLocalOcr: false,
    cloudOcrByDefault: true,
    visualProfile: "economical",
    resource: {
      maxOcrConcurrency: 1,
      recognitionCacheLimit: 120,
      warmLocalOcrAtStartup: false,
    },
  },
};

export function wheatEditionProfile(edition: WheatEdition = WHEAT_EDITION): WheatEditionProfile {
  return PROFILES[edition];
}

export const WHEAT_EDITION_PROFILE: WheatEditionProfile = wheatEditionProfile();

/**
 * The installer file name for one edition of one version.
 *
 * Both editions are the same Wheat release and carry the same version; the
 * edition is a separate word in the name, never a separate version number.
 * One implementation, shared by the packaging config, the release manifest, the
 * updater's asset selection and the website's download links, so a rename can
 * never leave one of the four pointing at a file that does not exist.
 */
export function wheatInstallerFileName(edition: WheatEdition, version: string): string {
  const name = edition === "standard" ? "Standard" : "Lightweight";
  return `Wheat-${name}-${version}-Setup.exe`;
}
