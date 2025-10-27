import { runCommand } from "./process.ts";

const textDecoder = new TextDecoder();

export type GitRunOptions = {
  allowFailure?: boolean;
  cwd?: string;
};

export async function runGit(
  args: string[],
  { allowFailure = false, cwd }: GitRunOptions = {},
) {
  return await runCommand("git", args, { allowFailure, cwd });
}

export function runGitSync(args: string[], { cwd }: { cwd?: string } = {}) {
  const command = new Deno.Command("git", {
    args,
    cwd,
    stderr: "piped",
    stdout: "piped",
  });
  const { code, stderr, stdout } = command.outputSync();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (code ${code}).\n${textDecoder.decode(stderr)}`,
    );
  }
  return textDecoder.decode(stdout).trim();
}

export function resolveRepoRoot(cwd: string = Deno.cwd()): string {
  return runGitSync(["rev-parse", "--show-toplevel"], { cwd });
}

export type RepoCoordinates = {
  owner: string;
  repo: string;
};

export function parseGitHubRemote(remoteUrl: string): RepoCoordinates {
  const cleaned = remoteUrl
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/\.git$/, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) {
    throw new Error(`Unable to parse GitHub remote URL \"${remoteUrl}\".`);
  }
  return { owner, repo };
}

export function resolveRepoCoordinates(repoRoot: string, remote = "origin"): RepoCoordinates {
  const remoteUrl = runGitSync(["remote", "get-url", remote], { cwd: repoRoot });
  return parseGitHubRemote(remoteUrl);
}

export function resolveDefaultBranch(repoRoot: string, remote = "origin"): string {
  try {
    const ref = runGitSync(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], {
      cwd: repoRoot,
    });
    const parts = ref.split("/");
    return parts.at(-1) ?? "main";
  } catch {
    try {
      const output = runGitSync(["remote", "show", remote], { cwd: repoRoot });
      const match = output.match(/HEAD branch:\s*(.+)/);
      if (match?.[1]) return match[1].trim();
    } catch {
      // Fall through to default.
    }
    return "main";
  }
}
