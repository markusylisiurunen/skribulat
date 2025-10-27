import { join } from "@std/path";
import { loadEnv } from "../utils/env.ts";
import { generateCompletion } from "../utils/llm.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";

const ALLOWED_MODELS = [
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.5-flash-preview-09-2025",
  "openai/gpt-5",
] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];
const DEFAULT_MODEL: AllowedModel = "anthropic/claude-sonnet-4.5";

const MODEL_ALIASES: Record<string, AllowedModel> = {
  "claude": "anthropic/claude-sonnet-4.5",
  "gemini": "google/gemini-2.5-flash-preview-09-2025",
  "gpt": "openai/gpt-5",
};

type ModelConfig = {
  maxTokens: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  reasoningMaxTokens?: number;
};
const MODEL_CONFIG: Record<AllowedModel, ModelConfig> = {
  "anthropic/claude-sonnet-4.5": { maxTokens: 512 },
  "google/gemini-2.5-flash-preview-09-2025": { maxTokens: 512, reasoningEffort: "low" },
  "openai/gpt-5": { maxTokens: 512, reasoningEffort: "minimal" },
};

function usage() {
  console.error(
    "Usage: skribulat exec [-m <model>] <free-form instruction>\n" +
      `Allowed models: ${ALLOWED_MODELS.join(", ")}`,
  );
  Deno.exit(1);
}

function gatherEnvironmentContext() {
  const shell = Deno.env.get("SHELL") ?? "(unknown)";
  const term = Deno.env.get("TERM") ?? "(unknown)";
  const termProgram = Deno.env.get("TERM_PROGRAM") ?? "(unknown)";
  const os = `${Deno.build.os} ${Deno.build.arch}`;
  const osRelease = (() => {
    try {
      return Deno.osRelease();
    } catch {
      return "(unavailable)";
    }
  })();
  const home = Deno.env.get("HOME") ?? "(unknown)";
  return `
Operating system: ${os}
OS release: ${osRelease}
Shell: ${shell}
Terminal: ${term}
Terminal program: ${termProgram}
Current working directory: ${Deno.cwd()}
Home directory: ${home}
`.trim();
}

async function buildPrompt(instruction: string, context: string) {
  const template = await loadPrompt("exec_command_user.txt");
  return renderPrompt(template, {
    ENV_CONTEXT: context,
    USER_INSTRUCTION: instruction,
  }).trim();
}

async function extractCommandResponse(instruction: string, model: AllowedModel) {
  const systemInstructions = await loadPrompt("exec_command_system.txt");
  const context = gatherEnvironmentContext();
  const prompt = await buildPrompt(instruction, context);
  return await generateCompletion({
    maxTokens: MODEL_CONFIG[model].maxTokens,
    model,
    prompt,
    reasoningEffort: MODEL_CONFIG[model].reasoningEffort,
    reasoningMaxTokens: MODEL_CONFIG[model].reasoningMaxTokens,
    systemInstructions,
    temperature: 0.2,
  });
}

function extractCommand(response: string) {
  const lines = response
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  if (lines.length === 0) {
    throw new Error("LLM response did not contain a command to run.");
  }
  const first = lines[0];
  const match = first.match(/^(?:[0-9]+[.)]\s*)?(.+)$/);
  const command = match ? match[1].trim() : first;
  if (!command) {
    throw new Error("Extracted command is empty.");
  }
  return command;
}

async function proposeCommand(instruction: string, model: AllowedModel) {
  const response = await extractCommandResponse(instruction, model);
  return extractCommand(response);
}

async function executeShellCommand(command: string) {
  const shellEnv = Deno.env.get("SHELL") ?? "/bin/zsh";
  if (!shellEnv.includes("zsh")) {
    throw new Error(`Unsupported shell "${shellEnv}". Only zsh is supported.`);
  }
  const process = new Deno.Command(shellEnv, {
    args: ["-lc", command],
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).spawn();
  const status = await process.status;
  if (!status.success) {
    throw new Error(`Command exited with code ${status.code ?? 1}.`);
  }
}

function resolveHistoryFile() {
  const histEnv = Deno.env.get("HISTFILE");
  if (histEnv && histEnv.trim().length > 0) return histEnv.trim();
  const home = Deno.env.get("HOME");
  if (!home) return null;
  const shell = Deno.env.get("SHELL") ?? "";
  if (!shell.includes("zsh")) {
    return null;
  }
  return join(home, ".zsh_history");
}

async function recordCommandInHistory(command: string) {
  const historyFile = resolveHistoryFile();
  if (!historyFile) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const entry = `: ${timestamp}:0;${command}\n`;
  try {
    await Deno.writeTextFile(historyFile, entry, { append: true });
  } catch (error) {
    const strErr = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: failed to append command to history file (${historyFile}): ${strErr}`);
  }
}

export async function runExec(argv: string[]) {
  await loadEnv();
  if (argv.length === 0) usage();

  let model: AllowedModel = DEFAULT_MODEL;
  const instructionParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m" || arg === "--model") {
      const next = argv[++i];
      if (!next) usage();
      const resolvedModel = MODEL_ALIASES[next] || next;
      if (!ALLOWED_MODELS.includes(resolvedModel as AllowedModel)) {
        const allowed = ALLOWED_MODELS.join(", ");
        const aliases = Object.keys(MODEL_ALIASES).join(", ");
        console.error(`Invalid model "${next}". Allowed values: ${allowed} or aliases: ${aliases}`);
        Deno.exit(1);
      }
      model = resolvedModel as AllowedModel;
      continue;
    }
    instructionParts.push(arg);
  }

  const instruction = instructionParts.join(" ").trim();
  if (instruction.length === 0) usage();

  const proposed = await proposeCommand(instruction, model);
  const singleLine = proposed.replace(/\s+/g, " ").trim();
  if (singleLine.includes("`") || singleLine.includes("\n")) {
    throw new Error("LLM response must be a single-line command without markdown code fences.");
  }
  console.log(`Proposed command (${model}):\n`);
  console.log(`  ${singleLine}\n`);
  const confirmPrompt = prompt("Press Enter to run or Ctrl+C to cancel:\n>", singleLine);
  if (confirmPrompt === null) {
    console.log("Cancelled.");
    return;
  }
  const finalCommand = confirmPrompt.trim().length > 0 ? confirmPrompt.trim() : singleLine;
  if (finalCommand.includes("\n")) {
    throw new Error("Only single-line commands are supported.");
  }
  try {
    await recordCommandInHistory(finalCommand);
    await executeShellCommand(finalCommand);
  } catch (error) {
    console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await runExec(Deno.args);
}
