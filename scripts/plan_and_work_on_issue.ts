import { select } from "@inquirer/prompts";
import { config } from "../utils/config.ts";
import { loadEnv } from "../utils/env.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { readFlag, readPositiveIntegerFlag } from "../utils/flags.ts";
import { createGitHubClient, GitHubIssueSummary } from "../utils/github.ts";
import { fitInConsoleWidth } from "../utils/text.ts";
import { runPlanIssue } from "./plan_issue.ts";
import { runWorkOnIssue } from "./work_on_issue.ts";

function usage() {
  console.log(
    "Usage: skribulat plan-and-work-on-issue [options]\n\n" +
      "Options:\n" +
      "  --issue <number>     Plan and work on a specific issue\n" +
      "  --agent <tool>       Agent tool to use for implementation (codex, claude-code, shell)\n" +
      "  --model <name>       Model name passed to the work-on-issue step (e.g., haiku, sonnet, opus, gpt-5.1-codex-max)\n" +
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

export async function runPlanAndWorkOnIssue(argv: string[]) {
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
  const issueNumber = issueNumberArg ?? await chooseIssue(
    await github.listOpenIssues(cfg.githubOwner, cfg.githubRepo),
  );
  console.log(`Planning implementation approach for issue #${issueNumber}...`);
  const planArgs = ["--issue", issueNumber.toString()];
  if (codexAuthPath) {
    planArgs.push("--codex-auth", codexAuthPath);
  }
  await runPlanIssue(planArgs);
  console.log(`Planning complete. Starting work on issue #${issueNumber}...`);
  const workArgs = ["--issue", issueNumber.toString()];
  if (agentArg) {
    workArgs.push("--agent", agentArg);
  }
  if (modelArg) {
    workArgs.push("--model", modelArg);
  }
  if (codexAuthPath) {
    workArgs.push("--codex-auth", codexAuthPath);
  }
  await runWorkOnIssue(workArgs);
}

if (import.meta.main) {
  await runPlanAndWorkOnIssue(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
