import { config } from "../utils/config.ts";
import { loadEnv } from "../utils/env.ts";
import { printCliError } from "../utils/errors.ts";
import { runGit } from "../utils/git.ts";
import { generateCompletion } from "../utils/llm.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";

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

async function getDiff(repoPath: string, args: string[]) {
  const result = await runGit(args, { cwd: repoPath, allowFailure: true });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

type CollectedDiffs = {
  stagedPatch: string;
  stagedStat: string;
};

async function collectDiffs(repoPath: string): Promise<CollectedDiffs> {
  const stagedStat = await getDiff(repoPath, ["diff", "--cached", "--stat"]);
  const stagedPatch = await getDiff(repoPath, ["diff", "--cached"]);
  return {
    stagedPatch,
    stagedStat,
  };
}

function parseSubjectsFromJson(completion: string): string[] {
  const jsonText = completion.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Model response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let subjects: unknown;
  if (Array.isArray(parsed)) {
    subjects = parsed;
  } else if (parsed && typeof parsed === "object" && "subjects" in parsed) {
    subjects = (parsed as Record<string, unknown>).subjects;
  } else {
    throw new Error("Model JSON response must be an array or contain a 'subjects' array.");
  }
  if (!Array.isArray(subjects)) {
    throw new Error("Model JSON response 'subjects' must be an array.");
  }
  return subjects
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

async function buildPrompt(diffs: CollectedDiffs, extraInstructions?: string) {
  const template = await loadPrompt("commit_subject_user.txt");
  const additionalGuidance = extraInstructions && extraInstructions.trim().length > 0
    ? `\nAdditional user guidance (follow when drafting the subject):\n${extraInstructions.trim()}\n`
    : "";
  const prompt = renderPrompt(template, {
    ADDITIONAL_GUIDANCE: additionalGuidance,
    STAGED_PATCH: truncate(diffs.stagedPatch.trim() || "(no patch)", DIFF_CHAR_LIMIT),
    STAGED_STAT: truncate(diffs.stagedStat.trim() || "(no summary)", DIFF_CHAR_LIMIT),
  });
  return prompt.trim();
}

async function generateCommitSubject(diffs: CollectedDiffs, extraInstructions?: string) {
  const systemInstructions = await loadPrompt("commit_subject_system.txt");
  const prompt = await buildPrompt(diffs, extraInstructions);
  const completion = await generateCompletion({
    maxTokens: 512,
    model: GENERATION_MODEL,
    prompt,
    reasoningMaxTokens: 128,
    responseFormat: { type: "json_object" },
    systemInstructions,
    temperature: 0.2,
  });
  const candidates = parseSubjectsFromJson(completion);
  const results: string[] = [];
  for (const candidate of candidates) {
    if (candidate.toUpperCase() === "NO_CHANGES") {
      continue;
    }
    try {
      const sanitized = sanitizeSubject(candidate);
      if (!results.includes(sanitized)) {
        results.push(sanitized);
      }
      if (results.length >= 3) break;
    } catch {
      continue;
    }
  }
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
  const diffs = await collectDiffs(repoPath);
  const additionalGuidance = extraInstructions.join(" ").trim();
  const proposals = await generateCommitSubject(
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
