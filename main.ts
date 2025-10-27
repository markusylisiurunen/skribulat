import { runBuildAgentRunner } from "./scripts/build_agent_runner.ts";
import { runCommit } from "./scripts/commit.ts";
import { runExec } from "./scripts/exec.ts";
import { runPlanIssue } from "./scripts/plan_issue.ts";
import { runWorkOnIssue } from "./scripts/work_on_issue.ts";
import { runWorkOnPr } from "./scripts/work_on_pr.ts";

type CommandHandler = (args: string[]) => Promise<void> | void;

const COMMANDS: Record<string, CommandHandler> = {
  "build-agent-runner": runBuildAgentRunner,
  "commit": runCommit,
  "exec": runExec,
  "plan-issue": runPlanIssue,
  "work-on-issue": runWorkOnIssue,
  "work-on-pr": runWorkOnPr,
};

function printUsage() {
  console.log(
    `Usage: skribulat <command> [options]\n\n` +
      `Commands:\n` +
      `  build-agent-runner  Build a Docker image for running local agents.\n` +
      `  commit              Generate and apply AI-assisted commit messages.\n` +
      `  exec                Propose and optionally run an AI-generated shell command.\n` +
      `  plan-issue          Analyze an issue and post an implementation plan.\n` +
      `  work-on-issue       Spin up an agent to implement an issue branch and PR.\n` +
      `  work-on-pr          Address feedback on an existing pull request via agent.\n` +
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
    console.error(`Unknown command: ${command}`);
    printUsage();
    Deno.exit(1);
  }
  await handler(rest);
}

if (import.meta.main) {
  await main(Deno.args);
}
