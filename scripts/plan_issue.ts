import { select } from "@inquirer/prompts";
import { buildRunnerEnv } from "../utils/agent_env.ts";
import { runAgent } from "../utils/agent_runner.ts";
import {
  AGENT_WORKDIR,
  HOST_REPO_MOUNT,
  setupAgentWorkspace,
  verifyGithubHttps,
} from "../utils/agent_workspace.ts";
import { config } from "../utils/config.ts";
import { DockerRunner } from "../utils/docker.ts";
import { loadEnv } from "../utils/env.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { readFlag } from "../utils/flags.ts";
import {
  explainIssueLabels,
  formatAgentsGuidance,
  instructEfficientToolUse,
  listAllAgentsFiles,
} from "../utils/guidance.ts";
import { runAgentHook } from "../utils/hooks.ts";
import { IssueComment, IssueSummary } from "../utils/issue_provider.ts";
import { createIssueProvider } from "../utils/issues.ts";
import {
  AgentCliOverrides,
  AgentToolConfig,
  loadProjectConfig,
  PlanIssueConfig,
  resolveAgentConfig,
} from "../utils/project_config.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import { fitInConsoleWidth } from "../utils/text.ts";

function usage() {
  console.log(
    "Usage: skribulat plan-issue [options]\n\n" +
      "Options:\n" +
      "  --issue <number>     Analyze a specific issue by number\n" +
      "  --agent <tool>       Agent tool to use (codex, claude-code, shell)\n" +
      "  --model <name>       Model name (e.g., gpt-5.1-codex-max, haiku, sonnet, opus)\n" +
      "  --codex-auth <path>  Copy Codex auth.json into the agent container before running\n" +
      "  -h, --help           Show this help message",
  );
}

async function chooseIssue(issueSummaries: IssueSummary[]) {
  if (issueSummaries.length === 0) {
    console.log("No open issues found.");
    Deno.exit(0);
  }
  try {
    const value = await select({
      message: "Select an issue:",
      choices: issueSummaries.map((issue) => ({
        name: fitInConsoleWidth(`#${issue.id} ${issue.title}`, 2),
        value: issue.id,
      })),
    });
    return value as string;
  } catch {
    console.log("No issue selected.");
    Deno.exit(0);
  }
}

function buildCommentsBlock(comments: IssueComment[]) {
  return comments
    .map((comment) => {
      const body = comment.body?.trim() ?? "No content.";
      return `<comment id="${comment.id}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
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
  codexAuthPath: string | undefined,
) {
  const githubUsername = Deno.env.get("GITHUB_USERNAME") ?? envConfig.githubOwner;
  const baseRunnerEnv: Record<string, string> = {
    DEBIAN_FRONTEND: "noninteractive",
    GITHUB_TOKEN: envConfig.githubToken,
    GIT_CREDENTIAL_USERNAME: githubUsername,
  };
  const runnerEnv = buildRunnerEnv(baseRunnerEnv, agentConfig);
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
    await runAgentHook(runner, "pre-work");
    await verifyGithubHttps(runner);
    const plan = await runAgent({
      anthropicApiKey: envConfig.anthropicApiKey,
      codexAuthPath,
      openAIApiKey: envConfig.openAIApiKey,
      prompt,
      runner,
      workingDir: AGENT_WORKDIR,
    }, agentConfig);
    if (!plan || plan.trim().length === 0) {
      throw new Error("Agent returned an empty plan.");
    }
    return plan.trim();
  } catch (error) {
    try {
      await runAgentHook(runner, "on-failure");
    } catch (hookError) {
      const message = hookError instanceof Error ? hookError.message : String(hookError);
      console.warn(`on-failure hook failed: ${message}`);
    }
    throw error;
  } finally {
    await runner.remove();
  }
}

export async function runPlanIssue(argv: string[]) {
  await loadEnv();
  const cfg = config();
  let restArgs = argv;
  let issueIdArg: string | undefined;
  let cliAgent: AgentCliOverrides["tool"];
  let cliModel: AgentCliOverrides["model"];
  let codexAuthPath: string | undefined;
  try {
    ({ rest: restArgs, value: issueIdArg } = readFlag(restArgs, "--issue"));
    ({ rest: restArgs, value: cliAgent } = readFlag(restArgs, "--agent"));
    ({ rest: restArgs, value: cliModel } = readFlag(restArgs, "--model"));
    ({ rest: restArgs, value: codexAuthPath } = readFlag(restArgs, "--codex-auth"));
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
  const projectConfig = loadProjectConfig();
  const issueProvider = createIssueProvider(projectConfig);
  const planConfig = projectConfig.planIssue ?? {};
  const agentConfig = resolveAgentConfig(projectConfig, "plan_issue", {
    tool: cliAgent,
    model: cliModel,
  });
  const issueId = issueIdArg ?? await chooseIssue(
    await issueProvider.listOpenIssues(),
  );
  const { issue, comments } = await issueProvider.fetchIssueWithComments(issueId);
  const agentsGuidance = fallbackAgentsGuidance(
    await formatAgentsGuidance({ labels: issue.labels, repoRoot: cfg.repoRoot }, {
      directoryMap: planConfig.agentsDirectoryMap,
    }),
  );
  const allAgentsFiles = await listAllAgentsFiles(cfg.repoRoot);
  const allAgentsFilesBlock = allAgentsFiles.length > 0
    ? allAgentsFiles.map((path) => `- ${path}`).join("\n")
    : "None found.";
  const systemInstructions = await loadPrompt("plan_issue_system.txt");
  const promptTemplate = await loadPrompt("plan_issue_user.txt");
  const issueLabels = issue.labels.length > 0 ? issue.labels.join(", ") : "No labels.";
  const commentsBlock = buildCommentsBlock(comments);
  const userPrompt = renderPrompt(promptTemplate, {
    "{{CURRENT_TIME}}": new Date().toISOString(),
    "{{REPO_OWNER}}": cfg.githubOwner,
    "{{REPO_NAME}}": cfg.githubRepo,
    "{{ISSUE_URL}}": issue.url ?? "N/A",
    "{{ISSUE_NUMBER}}": issue.number?.toString() ?? issue.id,
    "{{GUIDE_TOOL_USE}}": instructEfficientToolUse(planConfig.toolGuidance),
    "{{AGENTS_GUIDANCE}}": agentsGuidance,
    "{{LABEL_EXPLANATIONS}}": explainIssueLabels(planConfig.labelExplanations),
    "{{ISSUE_CREATED}}": issue.createdAt ?? "",
    "{{ISSUE_UPDATED}}": issue.updatedAt ?? "",
    "{{ISSUE_LABELS}}": issueLabels,
    "{{ISSUE_TITLE}}": issue.title,
    "{{ISSUE_BODY}}": issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
    "{{ISSUE_COMMENTS}}": commentsBlock.length > 0
      ? commentsBlock
      : "<comments>No comments.</comments>",
    "{{ALL_AGENTS_FILES}}": allAgentsFilesBlock,
  });
  const fullPrompt = composePrompt(systemInstructions, userPrompt);
  const plan = await generatePlanViaAgent(fullPrompt, planConfig, agentConfig, cfg, codexAuthPath);
  await issueProvider.addComment(issue.id, plan);
  console.log(`Posted implementation plan to issue ${issue.number ?? issue.id}.`);
}

if (import.meta.main) {
  await runPlanIssue(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
