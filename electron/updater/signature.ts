import { createPublicKey, verify } from "node:crypto";
import { readWheatEnv } from "../runtimeEnvironment";
import type { UpdateRelease } from "./types";

/**
 * Release-manifest signatures.
 *
 * The SHA-256 in a manifest only proves the artifact matches *that manifest*.
 * It says nothing about who wrote the manifest. For a local folder on the
 * user's own machine that is an acceptable boundary. The moment a manifest
 * arrives over a network it is not: whoever can serve the manifest chooses the
 * checksum, and therefore chooses which bytes Wheat installs. HTTPS narrows who
 * can do that to whoever controls the host and its certificate — a signature
 * narrows it to whoever holds the release key, which is the property actually
 * wanted.
 *
 * Ed25519 via Node's own crypto: no dependency, small keys, and no algorithm
 * negotiation to get wrong. The algorithm name is pinned rather than read from
 * the manifest, so a forged manifest cannot talk Wheat into a weaker one.
 */

export const UPDATE_SIGNATURE_ALGORITHM = "ed25519";

/**
 * The exact bytes a release signature covers.
 *
 * Built from the **normalised** release — the shape `validateReleaseManifest`
 * returns — because that is what Wheat acts on. Signing the raw file instead
 * would leave a gap between the bytes that were signed and the values that get
 * used.
 *
 * A JSON array of fields in a fixed order, so it is unambiguous whatever the
 * notes contain: no key ordering to agree on, no delimiter a release note could
 * contain, and every field length-delimited by JSON's own escaping. The signing
 * script reimplements this in `scripts/sign-update.mjs`; a test signs with one
 * and verifies with the other so the two cannot drift apart.
 */
export function canonicalReleasePayload(release: UpdateRelease): string {
  return JSON.stringify([
    release.schemaVersion,
    release.version,
    release.releaseDate,
    // Normalised back to forward slashes: `validateReleaseManifest` rewrites
    // the artifact path for Windows, and that rewrite must not change what was
    // signed on a build machine that may not be Windows at all.
    release.artifact.replaceAll("\\", "/"),
    release.sha256.toLowerCase(),
    release.artifactSize ?? null,
    release.minimumVersion ?? null,
    release.notes,
  ]);
}

export class UpdateSignatureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpdateSignatureError";
  }
}

/**
 * Verifies a manifest against the pinned release key.
 *
 * Throws on every failure path, including the ones that look like absence
 * rather than attack: an unsigned manifest, an unconfigured key, an unexpected
 * algorithm. Stripping the signature is the cheapest possible forgery, so
 * "no signature" must never read as "nothing to check".
 */
export function verifyReleaseSignature(release: UpdateRelease, publicKeyPem: string | null): void {
  if (!publicKeyPem) {
    throw new UpdateSignatureError("No Wheat release signing key is configured, so a signed update cannot be verified.");
  }
  if (!release.signature) {
    throw new UpdateSignatureError("Update metadata is not signed and was rejected.");
  }
  if (release.signature.algorithm.trim().toLowerCase() !== UPDATE_SIGNATURE_ALGORITHM) {
    throw new UpdateSignatureError(`Unsupported update signature algorithm: ${release.signature.algorithm}.`);
  }

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new UpdateSignatureError("The configured Wheat release signing key could not be read.", { cause: error });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new UpdateSignatureError("The configured Wheat release signing key is not an Ed25519 key.");
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(release.signature.value, "base64");
  } catch {
    throw new UpdateSignatureError("The update signature is not valid base64.");
  }
  // Ed25519 signatures are exactly 64 bytes; base64 decoding is lenient enough
  // that a malformed value would otherwise reach verify() as short garbage.
  if (signatureBytes.length !== 64) {
    throw new UpdateSignatureError("The update signature is malformed.");
  }

  const payload = Buffer.from(canonicalReleasePayload(release), "utf8");
  // Ed25519 takes no separate digest algorithm — hence the null first argument.
  if (!verify(null, payload, key, signatureBytes)) {
    throw new UpdateSignatureError(`Update ${release.version} failed signature verification and was rejected.`);
  }
}

/**
 * The pinned public key, in SPKI PEM.
 *
 * Compiled into the application on purpose. A key read from a file beside the
 * executable could be replaced by anyone who can write there — which is exactly
 * the person a signature is meant to stop.
 *
 * Generated with `npm run update:keygen`. Must be the whole SPKI PEM including
 * its BEGIN/END lines — `createPublicKey` refuses a bare base64 body, and a key
 * that cannot be read means every update is refused at runtime rather than at
 * build time. Empty means unsigned updates cannot be verified and a provider
 * that requires signatures refuses to run at all: unconfigured fails closed.
 */
export const WHEAT_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZc3KqSZJr43jjJi6dOWlv/kzDIkQ3kjMf7CkVA+BVIc=
-----END PUBLIC KEY-----`;

/**
 * Resolves the key to verify against.
 *
 * The environment override exists for development and for the test suite, and
 * is honoured only in an unpackaged build. In a packaged Wheat the compiled-in
 * key is the only key, so a variable in a user's shell can never redirect trust.
 */
export function resolveUpdatePublicKey(
  options: { isPackaged: boolean; env?: NodeJS.ProcessEnv } = { isPackaged: true },
): string | null {
  if (!options.isPackaged) {
    const override = readWheatEnv("WHEAT_UPDATE_PUBLIC_KEY", options.env ?? process.env)?.trim();
    if (override) return override.replaceAll("\\n", "\n");
  }
  return WHEAT_UPDATE_PUBLIC_KEY.trim() || null;
}
