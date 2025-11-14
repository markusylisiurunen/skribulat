import { join } from "@std/path";
import { select } from "@inquirer/prompts";
import { loadEnv } from "../utils/env.ts";
import { config } from "../utils/config.ts";
import { createGitHubClient, GitHubIssueComment, GitHubIssueSummary } from "../utils/github.ts";
import { fitInConsoleWidth } from "../utils/text.ts";
import { generateCompletion } from "../utils/llm.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import {
  explainIssueLabels,
  formatAgentsGuidance,
  instructEfficientToolUse,
} from "../utils/guidance.ts";
import { readFlag, readPositiveIntegerFlag } from "../utils/flags.ts";
import { AgentToolConfig, loadProjectConfig } from "../utils/project_config.ts";
import { DockerRunner } from "../utils/docker.ts";
import { buildRunnerEnv } from "../utils/agent_env.ts";
import {
  AGENT_WORKDIR,
  HOST_REPO_MOUNT,
  setupAgentWorkspace,
  verifyGithubHttps,
} from "../utils/agent_workspace.ts";
import { runAgent } from "../utils/agent_runner.ts";
import { runAgentHook } from "../utils/hooks.ts";
import { preserveGitPatch, startPatchCheckpoint } from "../utils/agent_patch.ts";
import { SKRIBULAT_PATCHES_SUBDIR, skribulatPath } from "../utils/paths.ts";
import { CliError, printCliError } from "../utils/errors.ts";

const BRANCH_MODEL = "google/gemini-2.5-flash-preview-09-2025";
const PR_BODY_MODEL = "google/gemini-2.5-flash-preview-09-2025";

function usage() {
  console.log(
    "Usage: skribulat work-on-issue [options]\n\n" +
      "Options:\n" +
      "  --issue <number>     Start working on a specific issue\n" +
      "  --agent <tool>       Agent tool to use (codex, claude-code, shell)\n" +
      "  --model <name>       Model name (e.g., gpt-5.1-codex, sonnet, haiku)\n" +
      "  --codex-auth <path>  Copy Codex auth.json into the agent container before running\n" +
      "  -h, --help           Show this help message",
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

async function generateBranchName(
  issueTitle: string,
  issueBody: string,
  comments: GitHubIssueComment[],
  labels: string[],
) {
  const systemInstructions = `
You generate concise git branch suffixes (without refs) in kebab-case.
Allowed characters are a-z, 0-9, and hyphens.
Try to keep it descriptive yet short (max. 50 characters).
Avoid generic terms like "feature" or "bug".
Do not mention the app's name in the branch name.
The branch name should solely focus on the issue content.
Respond with exactly one line of text, only containing the branch suffix with no extra commentary.
  `.trim();
  const template = `
Issue metadata:

<labels>{{labels}}</labels>
<title>{{title}}</title>
<description>
{{description}}
</description>
<comments>
{{comments}}
</comments>
  `.trim();
  const commentsBlock = comments.map((comment) => {
    const body = comment.body?.trim() ?? "No content.";
    return `<comment id="${comment.databaseId}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
  }).join("\n");
  const prompt = renderPrompt(template, {
    "{{labels}}": labels.length > 0 ? labels.join(", ") : "No labels.",
    "{{title}}": issueTitle,
    "{{description}}": issueBody.length > 0 ? issueBody : "No description.",
    "{{comments}}": commentsBlock,
  });
  let branchName = await generateCompletion({
    maxTokens: 128,
    model: BRANCH_MODEL,
    prompt,
    reasoningMaxTokens: 64,
    systemInstructions,
    temperature: 0.2,
  });
  branchName = branchName.trim().split("\n").at(0) ?? "";
  const isValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(branchName);
  if (!isValid) {
    throw new Error(`Generated branch name is invalid: ${branchName}`);
  }
  return branchName;
}

function buildIssueCommentsBlock(comments: GitHubIssueComment[]) {
  if (comments.length === 0) return "<comments>No comments.</comments>";
  return comments
    .map((comment) => {
      const body = comment.body?.trim() ?? "No content.";
      return `<comment id="${comment.databaseId}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
    })
    .join("\n");
}

async function prepareIssueBranch(
  runner: DockerRunner,
  branchName: string,
  defaultBranch: string,
) {
  const commands = [
    `cd ${AGENT_WORKDIR} && git fetch --prune origin`,
    `cd ${AGENT_WORKDIR} && if git ls-remote --exit-code origin ${branchName} >/dev/null 2>&1; then git switch -C ${branchName} origin/${branchName} && git reset --hard origin/${branchName}; else git switch -C ${branchName} origin/${defaultBranch} && git reset --hard origin/${defaultBranch}; fi`,
  ];
  for (const cmd of commands) {
    const { code, stdout, stderr } = await runner.runBashCommand(cmd, { cwd: "/root" });
    if (code !== 0) {
      throw new Error(`Git command failed: ${cmd}\n${stdout}\n${stderr}`);
    }
  }
}

async function collectDiffForPrompt(runner: DockerRunner, diffRange: string) {
  const statResult = await runner.runBashCommand(`git diff --stat ${diffRange}`, {
    cwd: AGENT_WORKDIR,
  });
  if (statResult.code !== 0) {
    console.warn("Failed to get git diff stat:", statResult.stderr);
  }
  const patchResult = await runner.runBashCommand(`git diff ${diffRange}`, { cwd: AGENT_WORKDIR });
  if (patchResult.code !== 0) {
    console.warn("Failed to get git diff patch:", patchResult.stderr);
  }
  let combined = [
    `Summary:\n${statResult.stdout.trim() || "No diff summary available."}`,
    `\nDiff:\n${patchResult.stdout.trim() || "No diff available."}`,
  ].join("");
  const maxLength = 32_000;
  if (combined.length > maxLength) {
    combined = `${combined.slice(0, maxLength)}\n\n...[diff truncated for prompt]`;
  }
  return combined.trim();
}

async function generatePullRequestBody(
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  labels: string[],
  comments: GitHubIssueComment[],
  diff: string,
) {
  const labelsText = labels.length > 0 ? labels.join(", ") : "No labels.";
  const formattedComments = comments.length > 0
    ? comments.map((comment) => {
      const body = (comment.body ?? "No content.").replace(/\s+/g, " ").trim();
      return `- [${comment.author} @ ${comment.createdAt}] ${body}`;
    }).join("\n")
    : "No discussion comments.";
  const diffForPrompt = diff.trim().length > 0 ? diff.trim() : "No diff detected.";
  const systemInstructions = `
You are drafting a high-quality GitHub pull request description in Markdown.
Provide a concise overview that helps reviewers understand the changes and why they exist.
Only use information from the supplied issue context and git diff.
Never assume, for example, that tests were run unless the diff shows it.
Always include the following sections:
- ## Summary (bullet list of key changes)
- ## Testing (bullet list; if nothing was tested, state "Not tested")
End with a standalone line: Fixes #${issueNumber}
Keep the PR body under 500 words while remaining informative.
  `.trim();
  const prompt = `
Issue number: #${issueNumber}
Title: ${issueTitle}
Labels: ${labelsText}

Issue body:
${issueBody}

Issue comments:
${formattedComments}

Git diff (origin base..HEAD):
${diffForPrompt}

Write the GitHub pull request body that follows the required format.
Do not output anything besides the pull request body.
Your full response will be used as-is for the PR body.
  `.trim();
  const body = await generateCompletion({
    maxTokens: 4096,
    model: PR_BODY_MODEL,
    prompt,
    reasoningMaxTokens: 2048,
    systemInstructions,
    temperature: 0.2,
  });
  return body.trim().length > 0 ? body.trim() : `Fixes #${issueNumber}`;
}

function resolveAgentConfig(
  projectConfig: ReturnType<typeof loadProjectConfig>,
  cliOverrides?: { agent?: string; model?: string },
): AgentToolConfig {
  const base = projectConfig.workOnIssue?.agent ?? projectConfig.agent ?? {};
  const config: AgentToolConfig = { ...base };
  if (cliOverrides?.agent) {
    const tool = cliOverrides.agent.toLowerCase();
    if (tool === "codex" || tool === "claude-code" || tool === "shell") {
      config.tool = tool;
    }
  }
  if (cliOverrides?.model) {
    config.model = cliOverrides.model;
  }
  return config;
}

export async function runWorkOnIssue(argv: string[]) {
  await loadEnv();
  const cfg = config();
  let restArgs = argv;
  let issueNumberArg: number | undefined;
  let agentArg: string | undefined;
  let modelArg: string | undefined;
  let codexAuthPath: string | undefined;
  try {
    ({ rest: restArgs, value: issueNumberArg } = readPositiveIntegerFlag(restArgs, "--issue"));
    ({ rest: restArgs, value: agentArg } = readFlag(restArgs, "--agent"));
    ({ rest: restArgs, value: modelArg } = readFlag(restArgs, "--model"));
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
  const github = createGitHubClient(cfg.githubToken);
  const projectConfig = loadProjectConfig();
  const issueNumber = issueNumberArg ?? await chooseIssue(
    await github.listOpenIssues(cfg.githubOwner, cfg.githubRepo),
  );
  const { issue, comments } = await github.fetchIssueWithComments(
    cfg.githubOwner,
    cfg.githubRepo,
    issueNumber,
  );
  const branchName = await generateBranchName(
    issue.title,
    issue.body,
    comments,
    issue.labels,
  );
  console.log(`Using branch name: ${branchName}`);
  const agentsGuidance = await formatAgentsGuidance(
    { labels: issue.labels, repoRoot: cfg.repoRoot },
    { directoryMap: projectConfig.planIssue?.agentsDirectoryMap },
  );
  const agentsGuidanceBlock = agentsGuidance.trim().length > 0
    ? agentsGuidance
    : "<agents_guidance />";
  const issueCommentsBlock = buildIssueCommentsBlock(comments);
  const promptTemplate = await loadPrompt("work_on_issue.txt");
  const prompt = renderPrompt(promptTemplate, {
    "{{CURRENT_TIME}}": new Date().toISOString(),
    "{{BRANCH_NAME}}": branchName,
    "{{ISSUE_NUMBER}}": issue.number.toString(),
    "{{AGENTS_GUIDANCE}}": agentsGuidanceBlock,
    "{{LABEL_EXPLANATIONS}}": explainIssueLabels(projectConfig.planIssue?.labelExplanations),
    "{{ISSUE_CREATED}}": issue.createdAt,
    "{{ISSUE_UPDATED}}": issue.updatedAt,
    "{{ISSUE_LABELS}}": issue.labels.length > 0 ? issue.labels.join(", ") : "No labels.",
    "{{ISSUE_TITLE}}": issue.title,
    "{{ISSUE_BODY}}": issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
    "{{ISSUE_COMMENTS}}": issueCommentsBlock,
  });
  const agentConfig = resolveAgentConfig(projectConfig, {
    agent: agentArg,
    model: modelArg,
  });
  const githubUsername = Deno.env.get("GITHUB_USERNAME") ?? cfg.githubOwner;
  const baseRunnerEnv: Record<string, string> = {
    DEBIAN_FRONTEND: "noninteractive",
    GITHUB_TOKEN: cfg.githubToken,
    GIT_CREDENTIAL_USERNAME: githubUsername,
  };
  const runnerEnv = buildRunnerEnv(baseRunnerEnv, agentConfig);
  const runner = new DockerRunner({
    envs: runnerEnv,
    imageName: cfg.agentRunnerImage,
    mounts: [{ hostPath: cfg.repoRoot, containerPath: HOST_REPO_MOUNT }],
    workingDir: "/root",
  });
  const diffRange = `origin/${cfg.githubDefaultBranch}..HEAD`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const patchOutputDir = skribulatPath(SKRIBULAT_PATCHES_SUBDIR);
  const patchOutputPath = join(patchOutputDir, `agent-patch-${timestamp}.patch`);
  let stopCheckpoint: (() => Promise<void>) | undefined;
  let agentRan = false;
  try {
    await setupAgentWorkspace(runner, {
      agentGitAuthor: cfg.agentGitAuthor,
      defaultBranch: cfg.githubDefaultBranch,
      githubOwner: cfg.githubOwner,
      githubRepo: cfg.githubRepo,
    });
    await prepareIssueBranch(runner, branchName, cfg.githubDefaultBranch);
    await runAgentHook(runner, "pre-work");
    await verifyGithubHttps(runner);
    const toolGuidance = instructEfficientToolUse(projectConfig.planIssue?.toolGuidance);
    const fullPrompt = `${toolGuidance}\n\n${prompt}`;
    stopCheckpoint = startPatchCheckpoint(runner, {
      diffRange,
      hostTargetPath: patchOutputPath,
    });
    await runAgent({
      anthropicApiKey: cfg.anthropicApiKey,
      codexAuthPath,
      openAIApiKey: cfg.openAIApiKey,
      prompt: fullPrompt,
      runner,
      workingDir: AGENT_WORKDIR,
    }, agentConfig);
    agentRan = true;
    const pushResult = await runner.runBashCommand(`git push -u origin ${branchName}`, {
      cwd: AGENT_WORKDIR,
    });
    if (pushResult.code !== 0) {
      console.warn("Failed to push branch:\n", pushResult.stdout, pushResult.stderr);
      Deno.exit(1);
    }
    const diff = await collectDiffForPrompt(runner, diffRange);
    const prBody = await generatePullRequestBody(
      issue.number,
      issue.title,
      issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
      issue.labels,
      comments,
      diff,
    );
    const pr = await github.createPullRequest(cfg.githubOwner, cfg.githubRepo, {
      base: cfg.githubDefaultBranch,
      head: branchName,
      title: issue.title,
      body: prBody,
    });
    console.log(`Pull request created: ${pr.url}`);
  } finally {
    if (stopCheckpoint) {
      await stopCheckpoint();
    }
    if (agentRan) {
      try {
        await preserveGitPatch(runner, {
          diffRange,
          hostTargetPath: patchOutputPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to preserve agent patch: ${message}`);
      }
    }
    await runner.remove();
  }
}

if (import.meta.main) {
  await runWorkOnIssue(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
