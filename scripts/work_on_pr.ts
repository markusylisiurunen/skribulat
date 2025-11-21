import { join } from "@std/path";
import { checkbox, select } from "@inquirer/prompts";
import { loadEnv } from "../utils/env.ts";
import { config } from "../utils/config.ts";
import {
  createGitHubClient,
  GitHubAssociatedIssue,
  GitHubPullRequestIssueComment,
  GitHubPullRequestSummary,
  GitHubReviewComment,
} from "../utils/github.ts";
import { fitInConsoleWidth } from "../utils/text.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import { explainIssueLabels, formatAgentsGuidance } from "../utils/guidance.ts";
import { readFlag } from "../utils/flags.ts";
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

function usage() {
  console.log(
    "Usage: skribulat work-on-pr [options]\n\n" +
      "Options:\n" +
      "  --agent <tool>       Agent tool to use (codex, claude-code, shell)\n" +
      "  --model <name>       Model name (e.g., gpt-5.1-codex-max, sonnet, haiku)\n" +
      "  --codex-auth <path>  Copy Codex auth.json into the agent container before running\n" +
      "  -h, --help           Show this help message",
  );
}

async function choosePullRequest(pullRequests: GitHubPullRequestSummary[]) {
  if (pullRequests.length === 0) {
    console.log("No open pull requests found.");
    Deno.exit(0);
  }
  try {
    const value = await select({
      message: "Select a pull request:",
      choices: pullRequests.map((pr) => ({
        name: fitInConsoleWidth(`#${pr.number} ${pr.title}`, 2),
        value: pr.number,
      })),
    });
    return value as number;
  } catch {
    console.log("No pull request selected.");
    Deno.exit(0);
  }
}

async function selectCommentFocus(
  issueComments: GitHubPullRequestIssueComment[],
  reviewComments: GitHubReviewComment[],
) {
  if ((issueComments.length + reviewComments.length) === 0) {
    console.log("No comments found on this pull request.");
    Deno.exit(0);
  }
  try {
    let focusIssue: number[] = [];
    if (issueComments.length > 0) {
      focusIssue = await checkbox({
        message: "Select issue comments to focus on:",
        choices: issueComments.map((comment) => ({
          name: fitInConsoleWidth(`[${comment.author}] ${comment.body}`, 3),
          value: comment.id,
        })),
      });
    }
    let focusReview: number[] = [];
    if (reviewComments.length > 0) {
      focusReview = await checkbox({
        message: "Select review comments to focus on:",
        choices: reviewComments.map((comment) => ({
          name: fitInConsoleWidth(`[${comment.author}] ${comment.body}`, 3),
          value: comment.id,
        })),
      });
    }
    if ((focusIssue.length + focusReview.length) === 0) {
      console.log("No comments selected.");
      Deno.exit(0);
    }
    return { focusIssue, focusReview };
  } catch {
    console.log("No comments selected.");
    Deno.exit(0);
  }
}

type ReviewThread = {
  root: GitHubReviewComment;
  replies: GitHubReviewComment[];
};

function threadReviewComments(comments: GitHubReviewComment[]): ReviewThread[] {
  const threads: ReviewThread[] = [];
  const byParent = new Map<number, GitHubReviewComment[]>();
  for (const comment of comments) {
    if (comment.inReplyToId) {
      if (!byParent.has(comment.inReplyToId)) byParent.set(comment.inReplyToId, []);
      byParent.get(comment.inReplyToId)!.push(comment);
    }
  }
  for (const comment of comments) {
    if (!comment.inReplyToId) {
      const replies = (byParent.get(comment.id) ?? []).slice().sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      threads.push({ root: comment, replies });
    }
  }
  return threads.sort((a, b) =>
    new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime()
  );
}

function renderAssociatedIssues(issues: GitHubAssociatedIssue[]) {
  if (issues.length === 0) return "<associated_issues />";
  const parts = issues.map((issue) => {
    const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "No labels.";
    const comments = issue.comments.length > 0
      ? issue.comments.map((comment) => {
        return `<comment id="${comment.id}" time="${comment.createdAt}" user="${comment.author}">\n${comment.body}\n</comment>`;
      }).join("\n")
      : "<comment_summary>No issue comments.</comment_summary>";
    return [
      `<associated_issue number="${issue.number}">`,
      `<created>${issue.createdAt}</created>`,
      `<updated>${issue.updatedAt}</updated>`,
      `<labels>${labels}</labels>`,
      `<title>\n${issue.title}\n</title>`,
      `<body>\n${issue.body.length > 0 ? issue.body : "No body."}\n</body>`,
      comments,
      `</associated_issue>`,
    ].join("\n");
  });
  return `<associated_issues>\n${parts.join("\n")}\n</associated_issues>`;
}

function renderIssueComments(comments: GitHubPullRequestIssueComment[]) {
  if (comments.length === 0) return "<comments>No comments.</comments>";
  return comments.map((comment) => {
    return `<pr_comment id="${comment.id}" time="${comment.createdAt}" user="${comment.author}">\n${comment.body}\n</pr_comment>`;
  }).join("\n");
}

function renderReviewThreads(threads: ReviewThread[]) {
  if (threads.length === 0) return "<review_threads />";
  return threads.map((thread) => {
    const root = thread.root;
    const replies = thread.replies.map((reply) => {
      return `<pr_review_comment id="${reply.id}" time="${reply.createdAt}" user="${reply.author}" path="${
        reply.path ?? ""
      }" line="${reply.line ?? reply.originalLine ?? ""}">\n${reply.body}\n</pr_review_comment>`;
    }).join("\n");
    return [
      `<pr_review_thread>`,
      `<pr_review_comment id="${root.id}" time="${root.createdAt}" user="${root.author}" path="${
        root.path ?? ""
      }" line="${root.line ?? root.originalLine ?? ""}">\n${root.body}\n</pr_review_comment>`,
      replies,
      `</pr_review_thread>`,
    ].join("\n");
  }).join("\n");
}

function resolveAgentConfig(
  projectConfig: ReturnType<typeof loadProjectConfig>,
  cliOverrides?: { agent?: string; model?: string },
): AgentToolConfig {
  const base = projectConfig.workOnPr?.agent ?? projectConfig.agent ?? {};
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

export async function runWorkOnPr(argv: string[]) {
  await loadEnv();
  const cfg = config();
  let restArgs = argv;
  let agentArg: string | undefined;
  let modelArg: string | undefined;
  let codexAuthPath: string | undefined;
  ({ rest: restArgs, value: agentArg } = readFlag(restArgs, "--agent"));
  ({ rest: restArgs, value: modelArg } = readFlag(restArgs, "--model"));
  ({ rest: restArgs, value: codexAuthPath } = readFlag(restArgs, "--codex-auth"));
  if (restArgs.includes("-h") || restArgs.includes("--help")) {
    usage();
    return;
  }
  if (!cfg.githubToken) {
    throw new CliError("GITHUB_TOKEN is not set. Provide a GitHub token in the environment.");
  }
  const github = createGitHubClient(cfg.githubToken);
  const projectConfig = loadProjectConfig();
  const prNumber = await choosePullRequest(
    await github.listOpenPullRequests(cfg.githubOwner, cfg.githubRepo),
  );
  const pr = await github.fetchPullRequest(cfg.githubOwner, cfg.githubRepo, prNumber);
  const { issueComments, reviewComments } = await github.fetchPullRequestComments(
    cfg.githubOwner,
    cfg.githubRepo,
    prNumber,
  );
  const associatedIssues = await github.fetchAssociatedIssues(
    cfg.githubOwner,
    cfg.githubRepo,
    prNumber,
  );
  const focus = await selectCommentFocus(issueComments, reviewComments);
  const agentsGuidance = await formatAgentsGuidance(
    { labels: pr.labels, repoRoot: cfg.repoRoot },
    { directoryMap: projectConfig.planIssue?.agentsDirectoryMap },
  );
  const agentsGuidanceBlock = agentsGuidance.trim().length > 0
    ? agentsGuidance
    : "<agents_guidance />";
  const promptTemplate = await loadPrompt("work_on_pr.txt");
  const prompt = renderPrompt(promptTemplate, {
    "{{CURRENT_TIME}}": new Date().toISOString(),
    "{{LABEL_EXPLANATIONS}}": explainIssueLabels(projectConfig.planIssue?.labelExplanations),
    "{{AGENTS_GUIDANCE}}": agentsGuidanceBlock,
    "{{COMMENT_IDS}}": [...focus.focusIssue, ...focus.focusReview].join(", "),
    "{{PR_BASE_REF}}": pr.baseRef,
    "{{PR_HEAD_REF}}": pr.headRef,
    "{{PR_BASE_SHA}}": pr.baseSha,
    "{{PR_HEAD_SHA}}": pr.headSha,
    "{{PR_TITLE}}": pr.title,
    "{{PR_BODY}}": pr.body.length > 0 ? pr.body : "No description.",
    "{{ASSOCIATED_ISSUES}}": renderAssociatedIssues(associatedIssues),
    "{{PR_ISSUE_COMMENTS}}": renderIssueComments(issueComments),
    "{{PR_REVIEW_COMMENT_THREADS}}": renderReviewThreads(threadReviewComments(reviewComments)),
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
    const checkoutCommands = [
      `cd ${AGENT_WORKDIR} && git fetch --prune origin`,
      `cd ${AGENT_WORKDIR} && git switch -C ${pr.headRef} origin/${pr.headRef}`,
      `cd ${AGENT_WORKDIR} && git reset --hard origin/${pr.headRef}`,
    ];
    for (const cmd of checkoutCommands) {
      const { code, stdout, stderr } = await runner.runBashCommand(cmd, { cwd: "/root" });
      if (code !== 0) {
        throw new Error(`Git command failed: ${cmd}\n${stdout}\n${stderr}`);
      }
    }
    await runAgentHook(runner, "pre-work");
    await verifyGithubHttps(runner);
    stopCheckpoint = startPatchCheckpoint(runner, {
      diffRange,
      hostTargetPath: patchOutputPath,
    });
    await runAgent({
      anthropicApiKey: cfg.anthropicApiKey,
      codexAuthPath,
      openAIApiKey: cfg.openAIApiKey,
      prompt,
      runner,
      workingDir: AGENT_WORKDIR,
    }, agentConfig);
    agentRan = true;
    const pushResult = await runner.runBashCommand(`git push -u origin ${pr.headRef}`, {
      cwd: AGENT_WORKDIR,
    });
    if (pushResult.code !== 0) {
      console.warn("Failed to push branch:\n", pushResult.stdout, pushResult.stderr);
      Deno.exit(1);
    }
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
  await runWorkOnPr(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
