import path from "node:path";
import {
  type AcquiredUpdate,
  type UpdateDownloadProgress,
  type UpdateProvider,
  type UpdateRelease,
} from "./types";
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
import {
  releaseAssetUrl,
  releaseManifestUrl,
  repositoryProbeUrl,
  type GitHubRepository,
} from "./releaseSource";

/**
 * Updates published as GitHub Releases.
 *
 * The release assets of one repository are the distribution channel, so there
 * is no server to run and nothing for the accountant to configure. What arrives
 * is nevertheless treated exactly as hostile as anything else off a network:
 *
 *  1. every hop stays HTTPS, and lands on a host GitHub actually serves
 *     downloads from — nowhere else;
 *  2. `latest.json` parses and satisfies `validateReleaseManifest`;
 *  3. the manifest carries a valid Ed25519 signature from the pinned release
 *     key (the service enforces this; `requiresSignature` below asks for it);
 *  4. the artifact URL is *constructed by Wheat* from the manifest's version and
 *     asset name — the manifest never supplies a URL, so it cannot point
 *     anywhere but at this repository's release for that version;
 *  5. the downloaded bytes match the signed size and SHA-256.
 *
 * Step 3 is what makes GitHub infrastructure rather than authority. GitHub can
 * serve the bytes; it cannot choose them. Anyone who took over the account, the
 * repository or the CDN could publish a release, and an installed Wheat would
 * still refuse it for want of a signature from the offline release key.
 */

/**
 * The hosts GitHub redirects release downloads to.
 *
 * A release asset URL on github.com answers 302 to blob storage, historically
 * `objects.githubusercontent.com` and more recently
 * `release-assets.githubusercontent.com`. Both are matched by suffix so a
 * future rename of that bucket does not brick every installed Wheat, while
 * still excluding every host outside GitHub's own domains.
 */
const ALLOWED_DOWNLOAD_HOSTS = ["github.com", ".githubusercontent.com", ".github.com"] as const;

function isGitHubDownloadHost(hostname: string) {
  const host = hostname.toLowerCase();
  return ALLOWED_DOWNLOAD_HOSTS.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

export type GitHubUpdateProviderOptions = {
  fetchImpl?: FetchLike;
  maxArtifactBytes?: number;
  manifestTimeoutMs?: number;
  artifactTimeoutMs?: number;
};

export class GitHubReleasesUpdateProvider implements UpdateProvider {
  readonly name = "github";
  readonly requiresSignature = true;
  readonly description: string;

  private readonly repository: GitHubRepository;
  private readonly fetchImpl: FetchLike;
  private readonly maxArtifactBytes: number;
  private readonly manifestTimeoutMs: number;
  private readonly artifactTimeoutMs: number;

  constructor(repository: GitHubRepository, options: GitHubUpdateProviderOptions = {}) {
    this.repository = repository;
    this.description = `${repository.url}/releases`;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
    this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    this.manifestTimeoutMs = options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
    this.artifactTimeoutMs = options.artifactTimeoutMs ?? ARTIFACT_TIMEOUT_MS;
  }

  private request(url: string, timeoutMs: number) {
    return requestRelease(new URL(url), {
      fetchImpl: this.fetchImpl,
      timeoutMs,
      allowRedirectTo: (destination) => isGitHubDownloadHost(destination.hostname),
    });
  }

  async getLatestRelease(): Promise<UpdateRelease | null> {
    const response = await this.request(releaseManifestUrl(this.repository), this.manifestTimeoutMs);
    if (!response) {
      // GitHub answers 404 both for "this repository has published no release
      // yet" and for "you may not read this repository" — a private repository
      // is indistinguishable from a missing one, by design, so that its
      // existence is not disclosed. Silently reading that as "up to date" would
      // leave a wrongly-configured or private channel looking healthy forever,
      // so the repository itself is probed once to tell the two apart.
      await this.assertRepositoryIsReadable();
      return null;
    }
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
   * Distinguishes "no release published" from "cannot read this repository".
   *
   * Only ever runs on the 404 path, so a healthy channel never pays for it.
   * A network failure here is left as a network failure: not being able to ask
   * is not evidence either way, and an unattended check stays quiet about it.
   */
  private async assertRepositoryIsReadable() {
    const probe = await this.request(repositoryProbeUrl(this.repository), this.manifestTimeoutMs);
    if (probe) return;
    throw new Error(
      `Wheat could not read the releases of ${this.repository.url}. ` +
      "The repository is private or does not exist, so this Wheat cannot receive updates from it.",
    );
  }

  /**
   * The artifact URL, built from the repository and the signed manifest.
   *
   * Only the *file name* comes from the manifest, and `validateReleaseManifest`
   * has already rejected absolute paths and `..`; the directory part of a
   * manifest written for the local folder channel (`<version>/Setup.exe`) is
   * dropped, because a GitHub release is a flat set of assets. The origin, the
   * repository and the tag are Wheat's own, so a manifest cannot redirect the
   * download even if it were signed by a compromised key holder.
   */
  private resolveAssetName(release: UpdateRelease): string {
    const assetName = path.posix.basename(release.artifact.replaceAll("\\", "/"));
    if (!assetName || assetName.startsWith(".")) throw new Error("The update manifest names an invalid release asset.");
    return assetName;
  }

  async acquireUpdate(
    release: UpdateRelease,
    stagingDirectory: string,
    onProgress?: (progress: UpdateDownloadProgress) => void,
  ): Promise<AcquiredUpdate> {
    const assetName = this.resolveAssetName(release);
    const artifactUrl = releaseAssetUrl(this.repository, release.version, assetName);
    const response = await this.request(artifactUrl, this.artifactTimeoutMs);
    if (!response) {
      // The manifest was signed and accepted, but the asset it names is not in
      // the release. A half-published release must fail loudly rather than be
      // retried forever against a version that will never appear.
      throw new Error(`The update installer is missing from release ${release.version} on GitHub.`);
    }
    const artifactPath = await downloadArtifact(response, {
      stagingDirectory,
      fileName: assetName,
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

/** Exposed for the tests that assert the redirect policy directly. */
export const __githubDownloadHostAllowed = isGitHubDownloadHost;
