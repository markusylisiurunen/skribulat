import { loadEnv } from "../utils/env.ts";
import { config } from "../utils/config.ts";
import { generateCompletion } from "../utils/llm.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";
import { runGit } from "../utils/git.ts";
import { printCliError } from "../utils/errors.ts";

const GENERATION_MODEL = "google/gemini-2.5-flash-preview-09-2025";
const DIFF_CHAR_LIMIT = 32_000;

function usage() {
  console.log(
    "Usage: skribulat commit [options] [additional guidance]\n\n" +
      "Options:\n" +
      "  -A           Stage all changes before generating suggestions\n" +
      "  codex        Use the configured Codex author for the final commit\n" +
      "  -h, --help   Show this help message",
  );
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

async function ensureStagedChanges(repoPath: string) {
  const { stdout } = await runGit(["diff", "--cached", "--name-only"], { cwd: repoPath });
  if (stdout.trim().length === 0) {
    throw new Error("No staged changes detected. Stage files before running this script.");
  }
}

async function getCurrentBranch(repoPath: string) {
  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  return stdout.trim();
}

async function getDiff(repoPath: string, args: string[]) {
  const result = await runGit(args, { cwd: repoPath, allowFailure: true });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

type CollectedDiffs = {
  branchPatch: string;
  branchStat: string;
  stagedPatch: string;
  stagedStat: string;
};

async function collectDiffs(
  repoPath: string,
  defaultBranch: string,
  currentBranch: string,
): Promise<CollectedDiffs> {
  const stagedStat = await getDiff(repoPath, ["diff", "--cached", "--stat"]);
  const stagedPatch = await getDiff(repoPath, ["diff", "--cached"]);
  let branchStat = "";
  let branchPatch = "";
  if (currentBranch !== defaultBranch) {
    const comparisonTargets = [
      `origin/${defaultBranch}...HEAD`,
      `${defaultBranch}...HEAD`,
      `origin/${defaultBranch}`,
      defaultBranch,
    ];
    for (const target of comparisonTargets) {
      try {
        branchStat = await getDiff(repoPath, ["diff", "--stat", target]);
        branchPatch = await getDiff(repoPath, ["diff", target]);
        if (branchStat.trim().length > 0 || branchPatch.trim().length > 0) {
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return {
    branchPatch,
    branchStat,
    stagedPatch,
    stagedStat,
  };
}

function sanitizeSubject(subject: string) {
  const trimmed = subject.trim();
  if (!trimmed) {
    throw new Error("Commit message is empty.");
  }
  const withoutPrefix = trimmed.replace(/^[^ ]+:\s*/, "").trim();
  if (!withoutPrefix) {
    throw new Error("Commit message is empty after removing prefixes.");
  }
  if (withoutPrefix.includes("\n")) {
    throw new Error("Commit message must be a single line.");
  }
  if (withoutPrefix.length > 100) {
    console.warn("Warning: commit subject exceeds 100 characters.");
  }
  return withoutPrefix;
}

async function buildPrompt(
  defaultBranch: string,
  currentBranch: string,
  diffs: CollectedDiffs,
  extraInstructions?: string,
) {
  const template = await loadPrompt("commit_subject_user.txt");
  const branchContext = (() => {
    if (currentBranch === defaultBranch) return "";
    const stat = diffs.branchStat.trim();
    const patch = diffs.branchPatch.trim();
    if (!stat && !patch) return "";
    const statSection = truncate(stat || "(no summary)", DIFF_CHAR_LIMIT);
    const patchSection = truncate(patch || "(no patch)", DIFF_CHAR_LIMIT);
    return `Branch context vs default branch (for awareness only, do not describe these directly):\n` +
      `git diff --stat origin/${defaultBranch}...HEAD (fallbacks applied if unavailable):\n${statSection}\n\n` +
      `git diff origin/${defaultBranch}...HEAD (fallbacks applied if unavailable):\n${patchSection}\n`;
  })();
  const additionalGuidance = extraInstructions && extraInstructions.trim().length > 0
    ? `\nAdditional user guidance (follow when drafting the subject):\n${extraInstructions.trim()}\n`
    : "";
  const prompt = renderPrompt(template, {
    ADDITIONAL_GUIDANCE: additionalGuidance,
    BRANCH_CONTEXT: branchContext ? `\n${branchContext}` : "",
    CURRENT_BRANCH: currentBranch,
    DEFAULT_BRANCH: defaultBranch,
    STAGED_PATCH: truncate(diffs.stagedPatch.trim() || "(no patch)", DIFF_CHAR_LIMIT),
    STAGED_STAT: truncate(diffs.stagedStat.trim() || "(no summary)", DIFF_CHAR_LIMIT),
  });
  return prompt.trim();
}

async function generateCommitSubject(
  defaultBranch: string,
  currentBranch: string,
  diffs: CollectedDiffs,
  extraInstructions?: string,
) {
  const systemInstructions = await loadPrompt("commit_subject_system.txt");
  const prompt = await buildPrompt(defaultBranch, currentBranch, diffs, extraInstructions);
  const completion = await generateCompletion({
    maxTokens: 512,
    model: GENERATION_MODEL,
    prompt,
    reasoningMaxTokens: 128,
    systemInstructions,
    temperature: 0.2,
  });
  const lines = completion
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const uniqueSanitized = new Map<string, string>();
  for (const line of lines) {
    if (line.toUpperCase() === "NO_CHANGES") {
      continue;
    }
    try {
      const match = line.match(/^(?:([0-9]+)[\).\s]+)?(.+)$/);
      const content = match ? match[2].trim() : line;
      const sanitized = sanitizeSubject(content);
      if (!uniqueSanitized.has(sanitized)) {
        uniqueSanitized.set(sanitized, line);
      }
      if (uniqueSanitized.size >= 3) break;
    } catch {
      continue;
    }
  }
  const results = Array.from(uniqueSanitized.keys());
  if (results.length === 0) {
    throw new Error("Failed to generate commit message proposals.");
  }
  if (results.length < 3) {
    console.warn("Model returned fewer than three unique proposals.");
  }
  return results.slice(0, 3);
}

async function commitChanges(
  repoPath: string,
  message: string,
  useCodexAuthor: boolean,
  agentAuthor: { name: string; email: string },
) {
  const args = ["commit"];
  if (useCodexAuthor) {
    console.log(`Using Codex author: ${agentAuthor.name} <${agentAuthor.email}>`);
    args.push(`--author=${agentAuthor.name} <${agentAuthor.email}>`);
  }
  args.push("-m", message);
  await runGit(args, { cwd: repoPath });
}

export async function runCommit(argv: string[]) {
  await loadEnv();
  const cfg = config();
  const repoPath = cfg.repoRoot;
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return;
  }
  let useCodexAuthor = false;
  let stageAll = false;
  const extraInstructions: string[] = [];
  for (const arg of argv) {
    if (arg === "codex") {
      useCodexAuthor = true;
    } else if (arg === "-A") {
      stageAll = true;
    } else {
      extraInstructions.push(arg);
    }
  }

  if (stageAll) {
    await runGit(["add", "-A"], { cwd: repoPath });
  }

  await ensureStagedChanges(repoPath);
  const currentBranch = await getCurrentBranch(repoPath);
  const diffs = await collectDiffs(repoPath, cfg.githubDefaultBranch, currentBranch);
  const additionalGuidance = extraInstructions.join(" ").trim();
  const proposals = await generateCommitSubject(
    cfg.githubDefaultBranch,
    currentBranch,
    diffs,
    additionalGuidance.length > 0 ? additionalGuidance : undefined,
  );
  const proposalList = proposals.map((p, idx) => `  ${idx + 1}. ${p}`).join("\n");
  console.log("Generated commit message proposals:\n\n" + proposalList + "\n");
  let subject = "";
  while (true) {
    const range = proposals.length > 1 ? `1-${proposals.length}` : "1";
    const choice = prompt(
      `Select proposal (${range}), type a custom message, or 'cancel' to abort.\n>`,
    );
    if (choice === null) {
      console.log("Commit aborted.");
      Deno.exit(1);
    }
    const trimmedChoice = choice.trim();
    if (trimmedChoice.length === 0) {
      console.log("Please enter a choice.");
      continue;
    }
    if (trimmedChoice.toLowerCase() === "cancel") {
      console.log("Commit aborted.");
      Deno.exit(1);
    }
    const numeric = Number.parseInt(trimmedChoice, 10);
    if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= proposals.length) {
      subject = proposals[numeric - 1];
      break;
    }
    try {
      subject = sanitizeSubject(trimmedChoice);
      break;
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      continue;
    }
  }
  await commitChanges(repoPath, subject, useCodexAuthor, cfg.agentGitAuthor);
  console.log(subject);
}

if (import.meta.main) {
  runCommit(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
