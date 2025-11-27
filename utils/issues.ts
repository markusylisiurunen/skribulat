import { config } from "./config.ts";
import { CliError } from "./errors.ts";
import { FileSystemIssueProvider } from "./fs_provider.ts";
import { createGitHubIssueProvider } from "./github.ts";
import { IssueProvider } from "./issue_provider.ts";
import { ProjectConfig } from "./project_config.ts";

export type IssuesConfig = {
  backend?: "github" | "fs";
  path?: string;
};

function resolveIssuesConfig(projectConfig: ProjectConfig): IssuesConfig {
  return projectConfig.issues ?? {};
}

export function createIssueProvider(projectConfig: ProjectConfig): IssueProvider {
  const cfg = config();
  const issuesConfig = resolveIssuesConfig(projectConfig);
  const backend = issuesConfig.backend ?? "github";
  if (backend === "fs") {
    return new FileSystemIssueProvider({
      repoRoot: cfg.repoRoot,
      issuesPath: issuesConfig.path,
    });
  }
  if (!cfg.githubToken) {
    throw new CliError("GITHUB_TOKEN is not set. Provide a GitHub token in the environment.");
  }
  return createGitHubIssueProvider(cfg.githubToken, cfg.githubOwner, cfg.githubRepo);
}
