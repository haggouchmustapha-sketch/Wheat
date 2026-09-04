import path from "node:path";
import type { AcquiredUpdate, UpdateDownloadProgress, UpdateProvider, UpdateRelease } from "./types";
import { validateReleaseManifest, verifyStagedArtifact } from "./validation";
import {
  ARTIFACT_TIMEOUT_MS,
  MANIFEST_TIMEOUT_MS,
  MAX_ARTIFACT_BYTES,
  downloadArtifact,
  readManifestText,
  requestRelease,
  type FetchLike,
} from "./releaseTransport";

/**
 * Updates fetched from a plain release directory over HTTPS.
 *
 * The self-hosted channel: a directory holding `latest.json` and per-version
 * artifact folders, served by any web server. Wheat's own releases go through
 * `githubProvider.ts` instead, but this channel remains supported for a
 * deployment that cannot reach GitHub — a fiduciaire serving updates from its
 * own intranet host — and it is the channel the HTTPS tests exercise.
 *
 * Everything it downloads is treated as hostile until proven otherwise:
 *
 *  1. transport is HTTPS, and stays HTTPS on the same host across redirects;
 *  2. the manifest parses and satisfies `validateReleaseManifest`;
 *  3. the manifest carries a valid signature from the pinned release key
 *     (enforced by the service — `requiresSignature` below is what asks for it);
 *  4. the artifact URL resolves underneath the configured feed, never beside or
 *     above it;
 *  5. the downloaded bytes match the signed size and SHA-256.
 *
 * Only then does the artifact reach the installer path, which is the same
 * verified-staging path a local update goes through.
 */

export type HttpsUpdateProviderOptions = {
  fetchImpl?: FetchLike;
  maxArtifactBytes?: number;
  manifestTimeoutMs?: number;
  artifactTimeoutMs?: number;
};

export class HttpsUpdateProvider implements UpdateProvider {
  readonly name = "https";
  /**
   * Non-negotiable. Over a network the manifest decides which bytes get
   * installed, so an unsigned manifest is an unauthenticated instruction to run
   * an executable as the user.
   */
  readonly requiresSignature = true;
  readonly description: string;

  private readonly feedUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly maxArtifactBytes: number;
  private readonly manifestTimeoutMs: number;
  private readonly artifactTimeoutMs: number;

  constructor(feedUrl: string, options: HttpsUpdateProviderOptions = {}) {
    let parsed: URL;
    try {
      // A trailing slash makes the feed a directory for `new URL(relative, base)`;
      // without it the last path segment would be replaced rather than extended.
      parsed = new URL(feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/`);
    } catch (error) {
      throw new Error(`The Wheat update feed URL is not a valid URL: ${feedUrl}`, { cause: error });
    }
    if (parsed.protocol !== "https:") throw new Error("The Wheat update feed must be served over HTTPS.");
    if (parsed.username || parsed.password) throw new Error("The Wheat update feed URL must not embed credentials.");
    this.feedUrl = parsed;
    this.description = parsed.toString();
    this.fetchImpl = options.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
    this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    this.manifestTimeoutMs = options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
    this.artifactTimeoutMs = options.artifactTimeoutMs ?? ARTIFACT_TIMEOUT_MS;
  }

  /**
   * A release host that redirects to another origin — a CDN with a different
   * certificate, an http:// mirror, a captive portal's login page — must not
   * silently become the source of the next Wheat. Only same-origin hops follow.
   */
  private request(url: URL, timeoutMs: number) {
    return requestRelease(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs,
      allowRedirectTo: (destination) => destination.origin === this.feedUrl.origin,
    });
  }

  async getLatestRelease(): Promise<UpdateRelease | null> {
    const response = await this.request(new URL("latest.json", this.feedUrl), this.manifestTimeoutMs);
    // A feed that has published nothing yet is not an error, exactly as an
    // absent local manifest is not.
    if (!response) return null;
    const text = await readManifestText(response);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("The Wheat update manifest is not valid JSON.", { cause: error });
    }
    return validateReleaseManifest(parsed);
  }

  /**
   * Turns the manifest's artifact path into a URL under the feed.
   *
   * `validateReleaseManifest` already rejects absolute and `..` paths, and
   * rewrites separators for Windows; both are undone here and the result is
   * re-checked against the feed prefix. The manifest is attacker-controlled
   * until its signature is verified, and a path check is cheap enough to keep
   * even where it should be redundant.
   */
  private resolveArtifactUrl(release: UpdateRelease): URL {
    const relative = release.artifact.replaceAll("\\", "/");
    const resolved = new URL(relative, this.feedUrl);
    if (resolved.origin !== this.feedUrl.origin || !resolved.pathname.startsWith(this.feedUrl.pathname)) {
      throw new Error("The update artifact resolves outside the configured update feed.");
    }
    return resolved;
  }

  async acquireUpdate(
    release: UpdateRelease,
    stagingDirectory: string,
    onProgress?: (progress: UpdateDownloadProgress) => void,
  ): Promise<AcquiredUpdate> {
    const artifactUrl = this.resolveArtifactUrl(release);
    const response = await this.request(artifactUrl, this.artifactTimeoutMs);
    if (!response) throw new Error(`Update artifact is missing on the update server: ${path.basename(artifactUrl.pathname)}.`);
    const artifactPath = await downloadArtifact(response, {
      stagingDirectory,
      fileName: path.basename(artifactUrl.pathname),
      maxArtifactBytes: this.maxArtifactBytes,
      expectedSize: release.artifactSize,
      onProgress,
    });
    return { release, artifactPath };
  }

  async validateUpdate(update: AcquiredUpdate) {
    await verifyStagedArtifact(update.artifactPath, update.release);
  }
}
