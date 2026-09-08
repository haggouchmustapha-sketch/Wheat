import { readWheatEnv } from "../runtimeEnvironment";
import { GitHubReleasesUpdateProvider } from "./githubProvider";
import { HttpsUpdateProvider } from "./httpsProvider";
import { LocalUpdateProvider } from "./localProvider";
import { WHEAT_RELEASE_REPOSITORY, parseGitHubRepository } from "./releaseSource";
import { resolveUpdatePublicKey } from "./signature";
import type { UpdateProvider } from "./types";

/**
 * Which update source this Wheat listens to.
 *
 * Three exist, chosen by configuration rather than by trial:
 *
 *  - **github** — the production channel. The GitHub Releases of the repository
 *    named in package.json. This is what an installed Wheat uses, and the only
 *    channel an accountant ever sees.
 *  - **https** — a self-hosted release directory, for a deployment that cannot
 *    reach GitHub. Off unless `WHEAT_UPDATE_FEED_URL` is set.
 *  - **local** — a folder in the user's own profile, filled by
 *    `npm run update:package`. How a release is rehearsed before publication,
 *    and how a machine with no connection at all is serviced.
 *
 * A packaged Wheat resolves this from what it was *built* with, never from the
 * environment: a variable in a user's shell must not be able to point an
 * installed application at another release host. The environment overrides
 * below therefore apply only to an unpackaged build.
 */

/**
 * A self-hosted release directory baked into the build. Empty in Wheat's own
 * builds, which publish through GitHub instead.
 */
export const WHEAT_UPDATE_FEED_URL = "";

export function resolveUpdateFeedUrl(options: { isPackaged: boolean; env?: NodeJS.ProcessEnv }): string | null {
  if (!options.isPackaged) {
    const override = readWheatEnv("WHEAT_UPDATE_FEED_URL", options.env ?? process.env)?.trim();
    if (override) return override;
  }
  return WHEAT_UPDATE_FEED_URL.trim() || null;
}

export type UpdateSourceDescriptor =
  | { kind: "github"; owner: string; repo: string; url: string }
  | { kind: "https"; feedUrl: string }
  | { kind: "local"; directory: string };

/**
 * Decides the source before anything is constructed, so the decision is one
 * readable ordering rather than a chain of fallbacks inside a factory.
 *
 * A packaged build published from a GitHub repository always uses it. An
 * unpackaged build defaults to the local folder — that is the developer and
 * rehearsal channel, and it is what `updates/README.md` documents — but either
 * network channel can be selected explicitly for testing.
 */
export function resolveUpdateSource(options: {
  isPackaged: boolean;
  localDirectory: string;
  env?: NodeJS.ProcessEnv;
}): UpdateSourceDescriptor {
  const env = options.env ?? process.env;
  const feedUrl = resolveUpdateFeedUrl({ isPackaged: options.isPackaged, env });
  if (feedUrl) return { kind: "https", feedUrl };

  if (!options.isPackaged) {
    // Development and the test suite may aim the GitHub channel at a fixture
    // repository. A packaged Wheat ignores this entirely.
    const override = readWheatEnv("WHEAT_UPDATE_REPOSITORY", env)?.trim();
    const overridden = override ? parseGitHubRepository(override) : null;
    if (overridden) return { kind: "github", ...overridden };
    return { kind: "local", directory: options.localDirectory };
  }

  if (WHEAT_RELEASE_REPOSITORY) return { kind: "github", ...WHEAT_RELEASE_REPOSITORY };
  return { kind: "local", directory: options.localDirectory };
}

export type ResolvedUpdateChannel = {
  provider: UpdateProvider;
  publicKey: string | null;
  source: UpdateSourceDescriptor;
  /** Set when the channel is configured but unusable, for the log and the UI. */
  misconfiguration?: string;
};

/**
 * Builds the provider this installation should use.
 *
 * A network channel with no signing key is a misconfiguration, not a reason to
 * quietly fall back to the local folder: falling back would turn a deployment
 * mistake into a silently weaker update path. Wheat keeps the network provider,
 * which then refuses every manifest for want of a key, and says why.
 */
export function resolveUpdateChannel(options: {
  isPackaged: boolean;
  localDirectory: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedUpdateChannel {
  const publicKey = resolveUpdatePublicKey({ isPackaged: options.isPackaged, env: options.env });
  const source = resolveUpdateSource(options);
  const unsignedChannel = publicKey
    ? undefined
    : "An online update channel is configured but no release signing key is compiled in; updates cannot be verified and will be refused.";

  try {
    if (source.kind === "github") {
      return { provider: new GitHubReleasesUpdateProvider(source), publicKey, source, misconfiguration: unsignedChannel };
    }
    if (source.kind === "https") {
      return { provider: new HttpsUpdateProvider(source.feedUrl), publicKey, source, misconfiguration: unsignedChannel };
    }
    return { provider: new LocalUpdateProvider(source.directory), publicKey, source };
  } catch (error) {
    // An unusable configuration must not leave Wheat with no updater at all;
    // the local channel still works, and the reason is recorded.
    const fallback: UpdateSourceDescriptor = { kind: "local", directory: options.localDirectory };
    return {
      provider: new LocalUpdateProvider(options.localDirectory),
      publicKey,
      source: fallback,
      misconfiguration: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether this build may replace its own program files.
 *
 * True only for an installed Windows Wheat: a portable copy lives wherever the
 * user put it and is theirs to replace, and an unpackaged build has no program
 * files to replace at all. Everywhere else an update is still found, downloaded
 * and verified — it is simply never applied, and the UI says so.
 *
 * The development override exists so the install path can be driven in a real
 * window by the updater tests, and follows the same rule as the update source
 * and the signing key: honoured only in an unpackaged build, so no variable in
 * a user's shell can change what an installed Wheat does. It grants no new
 * powers — the helper, its signature and checksum guards and the staged
 * artifact are unchanged, and a development build has no packaged helper to
 * run, so the attempt fails at the readiness gate rather than touching
 * anything.
 */
export function resolveAutomaticInstallationEnabled(options: {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return false;
  if (!options.isPackaged) return readWheatEnv("WHEAT_UPDATE_ALLOW_INSTALL", env)?.trim() === "1";
  return !env.PORTABLE_EXECUTABLE_DIR;
}
