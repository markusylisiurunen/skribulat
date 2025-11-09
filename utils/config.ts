import {
  parseGitHubRemote,
  resolveDefaultBranch,
  resolveRepoCoordinates,
  resolveRepoRoot,
} from "./git.ts";

export type RepoInfo = {
  githubDefaultBranch: string;
  githubOwner: string;
  githubRepo: string;
  repoRoot: string;
};

export type Config = RepoInfo & {
  agentGitAuthor: { email: string; name: string };
  agentRunnerImage: string;
  anthropicApiKey: string;
  githubToken: string;
  openAIApiKey: string;
  openRouterApiKey: string;
};

let cachedRepoInfo: RepoInfo | null = null;
let cachedConfig: Config | null = null;

function repoInfo(): RepoInfo {
  if (cachedRepoInfo) return cachedRepoInfo;
  const repoRoot = resolveRepoRoot();
  const { owner, repo } = resolveRepoCoordinates(repoRoot);
  const defaultBranch = resolveDefaultBranch(repoRoot);
  cachedRepoInfo = {
    githubDefaultBranch: defaultBranch,
    githubOwner: owner,
    githubRepo: repo,
    repoRoot,
  };
  return cachedRepoInfo;
}

export function repositoryRoot(): string {
  return repoInfo().repoRoot;
}

export function config(): Config {
  if (cachedConfig) return cachedConfig;
  const info = repoInfo();
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const githubToken = Deno.env.get("GITHUB_TOKEN") ?? "";
  const openAIApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const openRouterApiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  const runnerImageEnv = Deno.env.get("AGENT_RUNNER_IMAGE") ?? Deno.env.get("CODEX_RUNNER_IMAGE");
  const agentRunnerImage = runnerImageEnv ?? "agent-runner:latest";
  const agentGitName = Deno.env.get("CODEX_AGENT_GIT_NAME") ?? "Codex Agent";
  const agentGitEmail = Deno.env.get("CODEX_AGENT_GIT_EMAIL") ?? "codex-agent@example.com";

  cachedConfig = {
    ...info,
    agentGitAuthor: {
      email: agentGitEmail,
      name: agentGitName,
    },
    agentRunnerImage,
    anthropicApiKey,
    githubToken,
    openAIApiKey,
    openRouterApiKey,
  };
  return cachedConfig;
}

export function parseGitHubRemoteUrl(remoteUrl: string) {
  return parseGitHubRemote(remoteUrl);
}
