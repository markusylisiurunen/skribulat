import { select } from "@inquirer/prompts";
import { join } from "@std/path";
import { buildRunnerEnv } from "../utils/agent_env.ts";
import { preserveGitPatch, startPatchCheckpoint } from "../utils/agent_patch.ts";
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
import { createGitHubIssueProvider } from "../utils/github.ts";
import { generateCompletion } from "../utils/llm.ts";
import { SKRIBULAT_PATCHES_SUBDIR, skribulatPath } from "../utils/paths.ts";
import {
  AgentCliOverrides,
  loadProjectConfig,
  resolveAgentConfig,
} from "../utils/project_config.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import { fitInConsoleWidth } from "../utils/text.ts";

const BRANCH_MODEL = "google/gemini-2.5-flash-preview-09-2025";
const PR_BODY_MODEL = "google/gemini-2.5-flash-preview-09-2025";

function usage() {
  console.log(
    "Usage: skribulat work-on-issue [options]\n\n" +
      "Options:\n" +
      "  --issue <number>     Start working on a specific issue\n" +
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

async function generateBranchName(
  issueTitle: string,
  issueBody: string,
  comments: IssueComment[],
  labels: string[],
) {
  const systemInstructions = await loadPrompt("branch_name_system.txt");
  const template = await loadPrompt("branch_name_user.txt");
  const commentsBlock = comments.map((comment) => {
    const body = comment.body?.trim() ?? "No content.";
    return `<comment id="${comment.id}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
  }).join("\n");
  const prompt = renderPrompt(template, {
    "{{labels}}": labels.length > 0 ? labels.join(", ") : "No labels.",
    "{{title}}": issueTitle,
    "{{description}}": issueBody.length > 0 ? issueBody : "No description.",
    "{{comments}}": commentsBlock,
  });
  const MAX_ATTEMPTS = 3;
  let lastBranchName = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await generateCompletion({
      maxTokens: 128,
      model: BRANCH_MODEL,
      prompt,
      reasoningMaxTokens: 64,
      responseFormat: { type: "json_object" },
      systemInstructions,
      temperature: 0.2,
    });
    const branchName = parseBranchName(raw);
    lastBranchName = branchName;
    const isValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(branchName);
    if (isValid) return branchName;
  }
  const sanitized = sanitizeBranchName(lastBranchName);
  if (sanitized.length === 0) {
    throw new Error(`Generated branch name is empty after sanitization: ${lastBranchName}`);
  }
  return sanitized;
}

function parseBranchName(response: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM response is not valid JSON: ${message}`);
  }
  let branchName: unknown = parsed;
  if (parsed && typeof parsed === "object" && "branch_name" in parsed) {
    branchName = (parsed as Record<string, unknown>).branch_name;
  }
  if (typeof branchName !== "string") {
    throw new Error("Model JSON response must contain a string 'branch_name' field.");
  }
  const trimmed = branchName.trim();
  if (trimmed.length === 0) {
    throw new Error("Generated branch name is empty.");
  }
  return trimmed;
}

function buildIssueCommentsBlock(comments: IssueComment[]) {
  if (comments.length === 0) return "<comments>No comments.</comments>";
  return comments
    .map((comment) => {
      const body = comment.body?.trim() ?? "No content.";
      return `<comment id="${comment.id}" time="${comment.createdAt}" user="${comment.author}">\n${body}\n</comment>`;
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

function sanitizeBranchName(name: string) {
  let sanitized = name.trim().toLowerCase();
  sanitized = sanitized.replace(/[_/]+/g, "-");
  sanitized = sanitized.replace(/[^a-z0-9-]+/g, "-");
  sanitized = sanitized.replace(/^-+/, "").replace(/-+$/, "");
  sanitized = sanitized.replace(/-+/g, "-");
  return sanitized;
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
  issueRef: string,
  issueTitle: string,
  issueBody: string,
  labels: string[],
  comments: IssueComment[],
  diff: string,
) {
  const prBodySystemPrompt = await loadPrompt("pr_body_system.txt");
  const labelsText = labels.length > 0 ? labels.join(", ") : "No labels.";
  const formattedComments = comments.length > 0
    ? comments.map((comment) => {
      const body = (comment.body ?? "No content.").replace(/\s+/g, " ").trim();
      return `- [${comment.author} @ ${comment.createdAt}] ${body}`;
    }).join("\n")
    : "No discussion comments.";
  const diffForPrompt = diff.trim().length > 0 ? diff.trim() : "No diff detected.";
  const systemInstructions = prBodySystemPrompt.replaceAll("{{ISSUE_NUMBER}}", `${issueRef}`);
  const prompt = `
Issue number: #${issueRef}
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
  return body.trim().length > 0 ? body.trim() : `Fixes #${issueRef}`;
}

export async function runWorkOnIssue(argv: string[]) {
  await loadEnv();
  const cfg = config();
  let restArgs = argv;
  let issueIdArg: string | undefined;
  let agentArg: AgentCliOverrides["tool"];
  let modelArg: AgentCliOverrides["model"];
  let codexAuthPath: string | undefined;
  try {
    ({ rest: restArgs, value: issueIdArg } = readFlag(restArgs, "--issue"));
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
  const projectConfig = loadProjectConfig();
  const issueProvider = createIssueProvider(projectConfig);
  const issueId = issueIdArg ?? await chooseIssue(
    await issueProvider.listOpenIssues(),
  );
  const { issue, comments } = await issueProvider.fetchIssueWithComments(issueId);
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
  const allAgentsFiles = await listAllAgentsFiles(cfg.repoRoot);
  const allAgentsFilesBlock = allAgentsFiles.length > 0
    ? allAgentsFiles.map((path) => `- ${path}`).join("\n")
    : "None found.";
  const issueCommentsBlock = buildIssueCommentsBlock(comments);
  const promptTemplate = await loadPrompt("work_on_issue.txt");
  const labelExplanations = await explainIssueLabels(
    projectConfig.planIssue?.labelExplanations,
  );
  const prompt = renderPrompt(promptTemplate, {
    "{{CURRENT_TIME}}": new Date().toISOString(),
    "{{BRANCH_NAME}}": branchName,
    "{{ISSUE_NUMBER}}": issue.number?.toString() ?? issue.id,
    "{{AGENTS_GUIDANCE}}": agentsGuidanceBlock,
    "{{ALL_AGENTS_FILES}}": allAgentsFilesBlock,
    "{{LABEL_EXPLANATIONS}}": labelExplanations,
    "{{ISSUE_CREATED}}": issue.createdAt ?? "",
    "{{ISSUE_UPDATED}}": issue.updatedAt ?? "",
    "{{ISSUE_LABELS}}": issue.labels.length > 0 ? issue.labels.join(", ") : "No labels.",
    "{{ISSUE_TITLE}}": issue.title,
    "{{ISSUE_BODY}}": issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
    "{{ISSUE_COMMENTS}}": issueCommentsBlock,
  });
  const agentConfig = resolveAgentConfig(projectConfig, "work_on_issue", {
    tool: agentArg,
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
    const toolGuidance = await instructEfficientToolUse(projectConfig.planIssue?.toolGuidance);
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
    await runAgentHook(runner, "post-work");
    const pushResult = await runner.runBashCommand(`git push -u origin ${branchName}`, {
      cwd: AGENT_WORKDIR,
    });
    if (pushResult.code !== 0) {
      console.warn("Failed to push branch:\n", pushResult.stdout, pushResult.stderr);
      Deno.exit(1);
    }
    const diff = await collectDiffForPrompt(runner, diffRange);
    const issueRef = issue.number?.toString() ?? issue.id;
    const prBody = await generatePullRequestBody(
      issueRef,
      issue.title,
      issue.body.trim().length > 0 ? issue.body.trim() : "No description.",
      issue.labels,
      comments,
      diff,
    );
    const prProvider = issueProvider.createPullRequest
      ? issueProvider
      : createGitHubIssueProvider(cfg.githubToken, cfg.githubOwner, cfg.githubRepo);
    if (!prProvider.createPullRequest) {
      throw new Error("Pull request creation is unavailable; ensure GitHub credentials are set.");
    }
    const pr = await prProvider.createPullRequest({
      base: cfg.githubDefaultBranch,
      head: branchName,
      title: issue.title,
      body: prBody,
    });
    if (!pr) {
      throw new Error("Pull request creation failed: provider returned null.");
    }
    console.log(`Pull request created: ${pr.url}`);
  } catch (error) {
    try {
      await runAgentHook(runner, "on-failure");
    } catch (hookError) {
      const message = hookError instanceof Error ? hookError.message : String(hookError);
      console.warn(`on-failure hook failed: ${message}`);
    }
    throw error;
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
