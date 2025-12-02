import { runBuildAgentRunner } from "./scripts/build_agent_runner.ts";
import { runCommit } from "./scripts/commit.ts";
import { runExec } from "./scripts/exec.ts";
import { runGrep } from "./scripts/grep.ts";
import { runLint } from "./scripts/lint.ts";
import { runMarkdownCodebase } from "./scripts/markdown_codebase.ts";
import { runOracle } from "./scripts/oracle.ts";
import { runPlanAndWorkOnIssue } from "./scripts/plan_and_work_on_issue.ts";
import { runPlanIssue } from "./scripts/plan_issue.ts";
import { runPrompt } from "./scripts/prompt.ts";
import { runReview } from "./scripts/review.ts";
import { runWorkOnIssue } from "./scripts/work_on_issue.ts";
import { runWorkOnPr } from "./scripts/work_on_pr.ts";
import { CliError, printCliError } from "./utils/errors.ts";

type CommandHandler = (args: string[]) => Promise<void> | void;

const COMMANDS: Record<string, CommandHandler> = {
  "build-agent-runner": runBuildAgentRunner,
  "commit": runCommit,
  "exec": runExec,
  "grep": runGrep,
  "lint": runLint,
  "markdown-codebase": runMarkdownCodebase,
  "oracle": runOracle,
  "plan-and-work-on-issue": runPlanAndWorkOnIssue,
  "plan-issue": runPlanIssue,
  "prompt": runPrompt,
  "review": runReview,
  "work-on-issue": runWorkOnIssue,
  "work-on-pr": runWorkOnPr,
};

function printUsage() {
  console.log(
    `Usage: skribulat <command> [options]\n\n` +
      `Commands:\n` +
      `  build-agent-runner      Build a Docker image for running local agents.\n` +
      `  commit                  Generate and apply AI-assisted commit messages.\n` +
      `  exec                    Propose and optionally run an AI-generated shell command.\n` +
      `  grep                    Run a concise, fragment-aware code grep via the model.\n` +
      `  lint                    Run AI-powered lint rules against matching files.\n` +
      `  markdown-codebase       Emit a markdown snapshot of the tracked files under the current directory.\n` +
      `  oracle                  Ask questions, optionally detached, with file attachments.\n` +
      `  plan-and-work-on-issue  Run planning and implementation for an issue sequentially.\n` +
      `  plan-issue              Analyze an issue and post an implementation plan.\n` +
      `  prompt                  Print a stored prompt template by name.\n` +
      `  review                  Generate a code review prompt from a git diff.\n` +
      `  work-on-issue           Spin up an agent to implement an issue branch and PR.\n` +
      `  work-on-pr              Address feedback on an existing pull request via agent.\n` +
      `\nRun 'skribulat <command> --help' for command-specific options.`,
  );
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === "-h" || command === "--help") {
    printUsage();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    throw new CliError(`Unknown command: ${command}`);
  }
  await handler(rest);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    printCliError(error);
    if (error instanceof CliError && error.message.startsWith("Unknown command")) {
      printUsage();
    }
    Deno.exit(1);
  }
}
