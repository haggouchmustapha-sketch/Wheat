import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The release repository, from the publishing side.
 *
 * Reads the same `repository` field of package.json that
 * `electron/updater/releaseSource.ts` reads, so the application and the tooling
 * can never be pointed at different places. Everything about *where* a Wheat
 * release goes is decided by that one field.
 */

const REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export const RELEASE_BRANCH = "main";

export function repositoryRoot() {
  return path.resolve(import.meta.dirname, "..", "..");
}

export function readPackageMetadata(root = repositoryRoot()) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

export function parseGitHubRepository(repositoryUrl) {
  const match = REPOSITORY_URL_PATTERN.exec(String(repositoryUrl ?? "").trim());
  if (!match) return null;
  const [, owner, repo] = match;
  return { owner, repo, url: `https://github.com/${owner}/${repo}`, slug: `${owner}/${repo}` };
}

export function resolveReleaseRepository(root = repositoryRoot()) {
  const field = readPackageMetadata(root).repository;
  const url = typeof field === "string" ? field : field?.url;
  const repository = parseGitHubRepository(url);
  if (!repository) {
    throw new Error(
      'package.json has no usable "repository" field. Set it to the Wheat release repository, e.g. ' +
      '{ "type": "git", "url": "https://github.com/haggouchmustapha-sketch/Wheat.git" }.',
    );
  }
  return repository;
}

/**
 * Runs the GitHub CLI, and says something useful when it is not there.
 *
 * `gh` is the only credentialed component in the release path. It authenticates
 * the *operator*, on the operator's machine, and nothing it holds is ever
 * compiled into Wheat: an installed Wheat reads public release assets and knows
 * nothing about any token.
 */
export function gh(args, options = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      windowsHide: true,
      stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run `gh auth login`.",
      );
    }
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`);
  }
}

export function ghJson(args) {
  const output = gh(args).trim();
  return output ? JSON.parse(output) : null;
}

/** True when `gh` exists and holds a usable credential. */
export function ghIsAuthenticated() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- source provenance --- */

/**
 * The commit a release is built from, and whether it is provably that commit.
 *
 * A release tag is a claim about which source produced an installer. GitHub
 * creates the tag from whatever the remote branch points at, which is not
 * necessarily what was on this disk when the installer was built — that gap is
 * how a binary ends up tagged against source it did not come from, and it is
 * unrecoverable after the fact: nobody can later tell which code shipped.
 *
 * So provenance is captured at *prepare* time, next to the artifacts, and
 * re-checked at *publish* time. Returns everything needed to prove or disprove
 * the correspondence; the caller decides what is fatal.
 */
export function readSourceProvenance(root = repositoryRoot()) {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  };
  const head = git(["rev-parse", "HEAD"]);
  if (!head) return { isRepository: false, head: null, branch: null, dirty: null, dirtyFiles: [] };
  const status = git(["status", "--porcelain"]) ?? "";
  const dirtyFiles = status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    isRepository: true,
    head,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles.slice(0, 20),
  };
}

/** The commit the remote branch currently points at, or null if unreachable. */
export function remoteBranchHead(repository, branch = RELEASE_BRANCH) {
  try {
    const output = execFileSync("git", ["ls-remote", `${repository.url}.git`, `refs/heads/${branch}`], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output ? output.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}
