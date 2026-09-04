import packageMetadata from "../../package.json";

/**
 * Where a released Wheat comes from.
 *
 * One repository holds both the source and the published builds:
 *
 *     https://github.com/haggouchmustapha-sketch/Wheat
 *
 * Git history holds the source. GitHub Releases holds the installers — a
 * release asset is never a commit, so cloning the repository never drags a
 * hundred megabytes of past installers with it.
 *
 * The address is configured in exactly one place: the `repository` field of
 * package.json. Everything else derives from it — this module for the running
 * application, `scripts/lib/releaseRepository.mjs` for the release tooling — so
 * moving Wheat to another repository is a one-line change that cannot leave a
 * stale owner or URL behind in a second file.
 */

const REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export type GitHubRepository = {
  owner: string;
  repo: string;
  /** Canonical browse URL, without the `.git` suffix. Used in logs and docs. */
  url: string;
};

/**
 * The branch releases are cut from. Not used by the running application — an
 * installed Wheat only ever reads Releases, never a branch — but named here so
 * the release tooling and the documentation agree on one value.
 */
export const WHEAT_RELEASE_BRANCH = "main";

export function parseGitHubRepository(repositoryUrl: string): GitHubRepository | null {
  const match = REPOSITORY_URL_PATTERN.exec(repositoryUrl.trim());
  if (!match) return null;
  const [, owner, repo] = match;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

function readConfiguredRepository(): GitHubRepository | null {
  const field = (packageMetadata as { repository?: unknown }).repository;
  const url = typeof field === "string" ? field : (field as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? parseGitHubRepository(url) : null;
}

/**
 * The production release repository, or `null` if package.json names none.
 *
 * `null` is a supported state rather than a crash: a fork or a private build
 * that publishes nothing simply has no GitHub channel, and falls back to the
 * local update folder exactly as Wheat behaved before releases existed.
 */
export const WHEAT_RELEASE_REPOSITORY: GitHubRepository | null = readConfiguredRepository();

/** Where the signed release manifest lives inside a GitHub Release. */
export const RELEASE_MANIFEST_ASSET = "latest.json";

/**
 * The tag a version is published under. `v` + SemVer, which is what
 * `releases/latest/download/…` and `gh release create` both expect.
 */
export function releaseTagFor(version: string) {
  return `v${version}`;
}

/**
 * The manifest URL for a repository.
 *
 * `releases/latest/download/<asset>` is GitHub's permalink to an asset of
 * whichever release is currently marked latest. It is deliberately not the REST
 * API: the API costs one of sixty unauthenticated requests per hour per IP,
 * which a shared office address can exhaust, while this path is served like any
 * other download and carries no such budget.
 */
export function releaseManifestUrl(repository: GitHubRepository) {
  return `https://github.com/${repository.owner}/${repository.repo}/releases/latest/download/${RELEASE_MANIFEST_ASSET}`;
}

/** The download URL of one asset of one published release. */
export function releaseAssetUrl(repository: GitHubRepository, version: string, assetName: string) {
  return `https://github.com/${repository.owner}/${repository.repo}/releases/download/${releaseTagFor(version)}/${encodeURIComponent(assetName)}`;
}

/**
 * The repository's own page, used only to tell "nothing published yet" apart
 * from "this repository is not readable" — see `githubProvider.ts`.
 */
export function repositoryProbeUrl(repository: GitHubRepository) {
  return `${repository.url}/releases`;
}
