import { WHEAT_EDITION, type WheatEdition } from "../../src/wheatEdition";
import { verifyEditionsSignature } from "./signature";
import type { UpdateRelease } from "./types";

/**
 * Choosing this installation's own installer out of a release that publishes
 * several.
 *
 * Wheat Standard updates to Wheat Standard and Wheat Lightweight updates to
 * Wheat Lightweight — always, and never by reading a file name. The running
 * build states its edition from a value compiled into it (`src/wheatEdition.ts`),
 * and the release states, under signature, which artifact belongs to which
 * edition. Those two facts meet here and nowhere else.
 *
 * Crossing editions during an update would be a serious failure rather than a
 * cosmetic one: a Lightweight machine would receive two gigabytes of local
 * recognition runtime it has no room for, and a Standard machine would silently
 * lose the local recognition it was using. So every path that cannot name the
 * right artifact with certainty refuses.
 */

export class UpdateEditionError extends Error {
  readonly edition: WheatEdition;

  constructor(message: string, edition: WheatEdition) {
    super(message);
    this.name = "UpdateEditionError";
    this.edition = edition;
  }
}

export type EditionProjectionOptions = {
  edition?: WheatEdition;
  /** The pinned release key. Required whenever an editions map is consulted. */
  publicKey: string | null;
  /**
   * Whether this channel demands signatures. The editions map is verified
   * whenever it is present *and* the channel requires signatures — the same
   * rule the manifest itself follows, so a local rehearsal folder stays usable
   * while nothing arriving over a network is ever trusted unsigned.
   */
  requiresSignature: boolean;
};

/**
 * Returns the release as this edition should act on it.
 *
 * The result differs from its input only in `artifact`, `sha256` and
 * `artifactSize`: everything downstream — the download, the SHA-256 check, the
 * installer hand-off — is unchanged and simply operates on the right file.
 *
 *  - A release with an editions map is projected onto this edition, after its
 *    editions signature has been verified.
 *  - A release *without* one predates editions. Its single artifact is the
 *    Standard installer, so Standard proceeds exactly as it always has and any
 *    other edition refuses rather than installing Standard over itself.
 */
export function projectReleaseForEdition(release: UpdateRelease, options: EditionProjectionOptions): UpdateRelease {
  const edition = options.edition ?? WHEAT_EDITION;

  if (!release.editions) {
    if (edition === "standard") return release;
    throw new UpdateEditionError(
      `La version ${release.version} ne publie pas d'installateur pour l'édition ${edition}. ` +
      "Wheat n'installe jamais l'autre édition à la place.",
      edition,
    );
  }

  if (options.requiresSignature || release.editionsSignature) {
    verifyEditionsSignature(release, options.publicKey);
  }

  const entry = release.editions[edition];
  if (!entry) {
    throw new UpdateEditionError(
      `La version ${release.version} ne publie pas d'installateur pour l'édition ${edition}. ` +
      "Wheat n'installe jamais l'autre édition à la place.",
      edition,
    );
  }

  // `artifactSize` is rebuilt rather than overridden: an edition entry that
  // declares no size must not inherit the *other* edition's, which the download
  // would then enforce against the wrong file and reject every time.
  const projected: UpdateRelease = { ...release, artifact: entry.artifact, sha256: entry.sha256 };
  delete projected.artifactSize;
  if (entry.artifactSize !== undefined) projected.artifactSize = entry.artifactSize;
  return projected;
}
