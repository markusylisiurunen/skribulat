import { select } from "@inquirer/prompts";
import { loadEnv } from "../utils/env.ts";
import { config } from "../utils/config.ts";
import { createGitHubClient, GitHubIssueComment, GitHubIssueSummary } from "../utils/github.ts";
import { fitInConsoleWidth } from "../utils/text.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import {
  explainIssueLabels,
  formatAgentsGuidance,
  instructEfficientToolUse,
} from "../utils/guidance.ts";
import { readPositiveIntegerFlag } from "../utils/flags.ts";
import { AgentToolConfig, loadProjectConfig, PlanIssueConfig } from "../utils/project_config.ts";
import { DockerRunner } from "../utils/docker.ts";
import {
  AGENT_WORKDIR,
  HOST_REPO_MOUNT,
  setupAgentWorkspace,
  verifyGithubHttps,
} from "../utils/agent_workspace.ts";
import { runAgent } from "../utils/agent_runner.ts";
import { CliError, printCliError } from "../utils/errors.ts";

function usage() {
  console.log(
    "Usage: skribulat plan-issue [options]\n\n" +
      "Options:\n" +
      "  --issue <number>   Analyze a specific issue by number\n" +
      "  -h, --help         Show this help message",
  );
}

async function chooseIssue(issueSummaries: GitHubIssueSummary[]) {
  if (issueSummaries.length === 0) {
    console.log("No open issues found.");
    Deno.exit(0);
  }
  try {
    const value = await select({
      message: "Select an issue:",
      choices: issueSummaries.map((issue) => ({
        name: fitInConsoleWidth(`#${issue.number} ${issue.title}`, 2),
        value: issue.number,
      })),
    });
    return value as number;
  } catch {
    console.log("No issue selected.");
    Deno.exit(0);
  }
}

function buildCommentsBlock(comments: GitHubIssueComment[]) {
  return comments
    .map((comment) => {
      const body = comment.body?.trim() ?? "No content.";
      return `<comment id="${comment.databaseId}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
    })
    .join("\n");
}

function fallbackAgentsGuidance(value: string) {
  return value.trim().length > 0 ? value : "<agents_guidance />";
}

function composePrompt(systemInstructions: string, userPrompt: string) {
  return [systemInstructions.trim(), userPrompt.trim()].filter((part) => part.length > 0).join(
    "\n\n",
  );
}

async function generatePlanViaAgent(
  prompt: string,
  _planConfig: PlanIssueConfig,
  agentConfig: AgentToolConfig | undefined,
  envConfig: ReturnType<typeof config>,
) {
  const githubUsername = Deno.env.get("GITHUB_USERNAME") ?? envConfig.githubOwner;
  const runnerEnv: Record<string, string> = {
    DEBIAN_FRONTEND: "noninteractive",
    GITHUB_TOKEN: envConfig.githubToken,
    GIT_CREDENTIAL_USERNAME: githubUsername,
  };
  const agentEnv = agentConfig?.env;
  if (agentEnv) {
    for (const [key, value] of Object.entries(agentEnv)) {
      runnerEnv[key] = value;
    }
  }
  const runner = new DockerRunner({
    envs: runnerEnv,
    imageName: envConfig.agentRunnerImage,
    mounts: [{ hostPath: envConfig.repoRoot, containerPath: HOST_REPO_MOUNT }],
    workingDir: "/root",
  });
  try {
    await setupAgentWorkspace(runner, {
      agentGitAuthor: envConfig.agentGitAuthor,
      defaultBranch: envConfig.githubDefaultBranch,
      githubOwner: envConfig.githubOwner,
      githubRepo: envConfig.githubRepo,
    });
    await verifyGithubHttps(runner);
    const plan = await runAgent({
      openAIApiKey: envConfig.openAIApiKey,
      prompt,
      runner,
      workingDir: AGENT_WORKDIR,
    }, agentConfig);
    if (!plan || plan.trim().length === 0) {
      throw new Error("Agent returned an empty plan.");
    }
    return plan.trim();
  } finally {
    await runner.remove();
  }
}

export async function runPlanIssue(argv: string[]) {
  await loadEnv();
  const cfg = config();
  let restArgs = argv;
  let issueNumberArg: number | undefined;
  try {
    ({ rest: restArgs, value: issueNumberArg } = readPositiveIntegerFlag(restArgs, "--issue"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(message);
  }
  if (restArgs.includes("-h") || restArgs.includes("--help")) {
    usage();
    return;
  }
  if (!cfg.githubToken) {
    throw new CliError("GITHUB_TOKEN is not set. Provide a GitHub token in the environment.");
  }
  const github = createGitHubClient(cfg.githubToken);
  const projectConfig = loadProjectConfig();
  const planConfig = projectConfig.planIssue ?? {};
  const agentConfig = planConfig.agent ?? projectConfig.agent;
  const issueNumber = issueNumberArg ?? await chooseIssue(
    await github.listOpenIssues(cfg.githubOwner, cfg.githubRepo),
  );
  const { issue, comments } = await github.fetchIssueWithComments(
    cfg.githubOwner,
    cfg.githubRepo,
    issueNumber,
  );
  const agentsGuidance = fallbackAgentsGuidance(
    await formatAgentsGuidance({ labels: issue.labels, repoRoot: cfg.repoRoot }, {
      directoryMap: planConfig.agentsDirectoryMap,
    }),
  );
  const systemInstructions = await loadPrompt("plan_issue_system.txt");
  const promptTemplate = await loadPrompt("plan_issue_user.txt");
  const issueLabels = issue.labels.length > 0 ? issue.labels.join(", ") : "No labels.";
  const commentsBlock = buildCommentsBlock(comments);
  const userPrompt = renderPrompt(promptTemplate, {
    "{{CURRENT_TIME}}": new Date().toISOString(),
    "{{REPO_OWNER}}": cfg.githubOwner,
    "{{REPO_NAME}}": cfg.githubRepo,
    "{{ISSUE_URL}}": issue.url,
    "{{ISSUE_NUMBER}}": issue.number.toString(),
    "{{GUIDE_TOOL_USE}}": instructEfficientToolUse(planConfig.toolGuidance),
    "{{AGENTS_GUIDANCE}}": agentsGuidance,
    "{{LABEL_EXPLANATIONS}}": explainIssueLabels(planConfig.labelExplanations),
    "{{ISSUE_CREATED}}": issue.createdAt,
    "{{ISSUE_UPDATED}}": issue.updatedAt,
    "{{ISSUE_LABELS}}": issueLabels,
    "{{ISSUE_TITLE}}": issue.title,
    "{{ISSUE_BODY}}": issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
    "{{ISSUE_COMMENTS}}": commentsBlock.length > 0
      ? commentsBlock
      : "<comments>No comments.</comments>",
  });
  const fullPrompt = composePrompt(systemInstructions, userPrompt);
  const plan = await generatePlanViaAgent(fullPrompt, planConfig, agentConfig, cfg);
  await github.addIssueComment(issue.id, plan);
  console.log(`Posted implementation plan to issue #${issue.number}.`);
}

if (import.meta.main) {
  await runPlanIssue(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
