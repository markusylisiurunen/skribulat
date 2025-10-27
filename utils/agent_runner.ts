import { DockerRunner } from "./docker.ts";
import { AgentToolConfig } from "./project_config.ts";

export type AgentExecutionContext = {
  openAIApiKey?: string;
  prompt: string;
  runner: DockerRunner;
  workingDir: string;
};

export async function runAgent(
  context: AgentExecutionContext,
  config: AgentToolConfig = {},
): Promise<string> {
  const tool = config.tool ?? "codex";
  switch (tool) {
    case "codex":
      return await runCodexAgent(context, config);
    case "shell":
      return await runShellAgent(context, config);
    default:
      throw new Error(`Unsupported agent tool '${tool}'.`);
  }
}

async function runShellAgent(
  { prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  if (!config.command || config.command.trim().length === 0) {
    throw new Error("Shell agent requires a non-empty command in configuration.");
  }
  const promptPath = "/tmp/skribulat-plan-prompt.txt";
  await copyPromptToContainer(prompt, runner, promptPath);
  const command = buildCommand(config.command, promptPath);
  const { code, stdout, stderr } = await runner.runBashCommand(command, { cwd: workingDir });
  if (code !== 0) {
    throw new Error(`Shell agent command failed (exit code ${code}).\n${stderr}`);
  }
  return stdout.trim();
}

async function runCodexAgent(
  { openAIApiKey, prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  if (!openAIApiKey) {
    throw new Error("OPENAI_API_KEY is required for Codex agent.");
  }
  const login = await runner.runBashCommand(
    `echo "${openAIApiKey}" | codex login --with-api-key`,
    { cwd: workingDir },
  );
  if (login.code !== 0) {
    throw new Error(`Failed to login to Codex.\n${login.stderr}`);
  }
  const promptPath = "/tmp/skribulat-plan-prompt.txt";
  await copyPromptToContainer(prompt, runner, promptPath);
  const command = buildCodexCommand(config, promptPath);
  return await streamCodexOutput(runner, command, workingDir);
}

function buildCodexCommand(config: AgentToolConfig, promptPath: string): string {
  const model = config.model ?? "gpt-5-codex";
  const reasoningEffort = config.reasoningEffort ?? "low";
  const base = config.command && config.command.trim().length > 0 ? config.command.trim() : [
    "codex exec --json",
    "--dangerously-bypass-approvals-and-sandbox",
    `--model ${model}`,
    `-c model_reasoning_effort=\"${reasoningEffort}\"`,
    `-c model_reasoning_summary=\"auto\"`,
  ].join(" ");
  return buildCommand(base, promptPath);
}

function buildCommand(command: string, promptPath: string): string {
  if (command.includes("{{PROMPT_PATH}}")) {
    return command.replaceAll("{{PROMPT_PATH}}", promptPath);
  }
  return `cat ${promptPath} | ${command}`;
}

async function copyPromptToContainer(prompt: string, runner: DockerRunner, containerPath: string) {
  const tempFile = await Deno.makeTempFile({ prefix: "skribulat-plan-", suffix: ".txt" });
  await Deno.writeTextFile(tempFile, prompt);
  try {
    await runner.copyFromHost(tempFile, containerPath);
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }
}

type CodexEvent =
  | { type: "error"; message: string }
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started" }
  | {
    type: "item.updated";
    item: { type: "todo_list"; items: { text: string; completed: boolean }[] };
  }
  | {
    type: "item.completed";
    item:
      | { type: "reasoning"; text?: string }
      | { type: "file_change"; changes: { kind: string; path: string }[] }
      | {
        type: "command_execution";
        command: string;
        aggregated_output: string;
        exit_code: number;
      }
      | { type: "todo_list"; items: { text: string; completed: boolean }[] }
      | { type: "agent_message"; text: string };
  }
  | {
    type: "turn.completed";
    usage: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    };
  };

async function streamCodexOutput(
  runner: DockerRunner,
  command: string,
  workingDir: string,
): Promise<string> {
  console.log(`Running Codex agent with command: ${command}`);
  const stream = runner.streamBashCommand(command, { cwd: workingDir });
  let finalMessage = "";
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk.data;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      processCodexLine(line, (message) => {
        if (message) finalMessage = message;
      });
    }
  }
  if (buffered.trim().length > 0) {
    processCodexLine(buffered, (message) => {
      if (message) finalMessage = message;
    });
  }
  if (finalMessage.trim().length === 0) {
    throw new Error("Codex agent did not return a final message.");
  }
  return finalMessage.trim();
}

function processCodexLine(line: string, onMessage: (message: string | null) => void) {
  if (line.trim().length === 0) return;
  try {
    const parsed = JSON.parse(line) as CodexEvent;
    logCodexEvent(parsed);
    if (parsed.type === "item.completed" && parsed.item.type === "agent_message") {
      onMessage(parsed.item.text);
    } else {
      onMessage(null);
    }
  } catch {
    console.log(line);
    onMessage(null);
  }
}

function logCodexEvent(event: CodexEvent) {
  switch (event.type) {
    case "error":
      console.error(prefix(), "error:", event.message);
      break;
    case "thread.started":
      console.log(prefix(), "thread started:", event.thread_id);
      break;
    case "item.updated":
      console.log(prefix(), "plan updated:");
      for (const item of event.item.items) {
        console.log(`  [${item.completed ? "x" : " "}] ${item.text}`);
      }
      break;
    case "item.completed":
      if (event.item.type === "reasoning" && event.item.text) {
        console.log(prefix(), "reasoning:\n" + event.item.text);
      }
      if (event.item.type === "command_execution") {
        const status = event.item.exit_code === 0 ? "succeeded" : "failed";
        console.log(prefix(), `command ${status}: ${event.item.command}`);
        if (event.item.exit_code !== 0) {
          console.log(event.item.aggregated_output);
        }
      }
      if (event.item.type === "file_change") {
        for (const change of event.item.changes) {
          console.log(prefix(), `file ${change.kind}: ${change.path}`);
        }
      }
      if (event.item.type === "todo_list") {
        console.log(prefix(), "plan completed:");
        for (const item of event.item.items) {
          console.log(`  [${item.completed ? "x" : " "}] ${item.text}`);
        }
      }
      if (event.item.type === "agent_message" && event.item.text) {
        console.log(prefix(), "agent message:\n" + event.item.text);
      }
      break;
    case "turn.completed":
      const { input_tokens, cached_input_tokens, output_tokens } = event.usage;
      console.log(prefix(), "usage:");
      console.log(`  input tokens: ${input_tokens} (cached: ${cached_input_tokens})`);
      console.log(`  output tokens: ${output_tokens}`);
      break;
    default:
      console.log(prefix(), lineToString(event));
      break;
  }
}

function prefix() {
  return `[${new Date().toTimeString().slice(0, 8)}]`;
}

function lineToString(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
