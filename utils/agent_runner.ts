import { resolve } from "@std/path";
import { DockerRunner } from "./docker.ts";
import { AgentToolConfig } from "./project_config.ts";

export type AgentExecutionContext = {
  anthropicApiKey?: string;
  codexAuthPath?: string;
  geminiApiKey?: string;
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
    case "claude-code":
      return await runClaudeCodeAgent(context, config);
    case "gemini":
      return await runGeminiAgent(context, config);
    case "shell":
      return await runShellAgent(context, config);
    default:
      throw new Error(`Unsupported agent tool '${tool}'.`);
  }
}

async function runGeminiAgent(
  { geminiApiKey, prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for Gemini agent.");
  }

  // Inject system defaults
  const systemDefaults = {
    apiKey: geminiApiKey,
    context: {
      fileName: "AGENTS.md",
      discoveryMaxDirs: 512,
    },
    experimental: {
      useModelRouter: false,
      codebaseInvestigatorSettings: {
        enabled: true,
        maxNumTurns: 32,
        maxTimeMinutes: 10,
        model: "gemini-3-pro-preview",
      },
    },
    model: {
      name: "gemini-3-pro-preview",
      maxSessionTurns: -1,
    },
    tools: {
      useRipgrep: true,
    },
  };
  const tempFile = await Deno.makeTempFile({ prefix: "gemini-defaults-", suffix: ".json" });
  await Deno.writeTextFile(tempFile, JSON.stringify(systemDefaults, null, 2));
  try {
    await runner.runBashCommand("mkdir -p /etc/gemini-cli");
    await runner.copyFromHost(tempFile, "/etc/gemini-cli/system-defaults.json");
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }

  const promptPath = "/tmp/skribulat-plan-prompt.txt";
  await copyPromptToContainer(prompt, runner, promptPath);

  const baseCommand = config.command && config.command.trim().length > 0
    ? config.command.trim()
    : `gemini -o stream-json --yolo -p -`;

  const command = buildCommand(baseCommand, promptPath);
  console.log(`${prefix()} user prompt:\n${prompt}`);
  return await streamGeminiOutput(runner, command, workingDir);
}

type GeminiEvent =
  | { type: "init"; timestamp: string; session_id: string; model: string }
  | { type: "message"; role: "user" | "assistant"; content: string; delta?: boolean }
  | { type: "tool_use"; tool_name: string; tool_id: string; parameters: unknown }
  | { type: "tool_result"; tool_id: string; status: string; output: string }
  | {
    type: "result";
    status: string;
    stats: {
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      duration_ms: number;
      tool_calls: number;
    };
  };

async function streamGeminiOutput(
  runner: DockerRunner,
  command: string,
  workingDir: string,
): Promise<string> {
  console.log(`Running Gemini agent with command: ${command}`);
  const stream = runner.streamBashCommand(command, { cwd: workingDir });
  let finalMessage = "";
  let buffered = "";

  for await (const chunk of stream) {
    buffered += chunk.data;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const result = processGeminiLine(line);
      if (result) finalMessage += result;
    }
  }
  if (buffered.trim().length > 0) {
    const result = processGeminiLine(buffered);
    if (result) finalMessage += result;
  }

  // If we captured no text but the command finished, it might be a tool-only run,
  // but usually there's some output.
  // Unlike Codex/Claude, Gemini stream chunks are deltas we accumulated.
  return finalMessage.trim();
}

function processGeminiLine(line: string): string | null {
  if (line.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(line) as GeminiEvent;
    logGeminiEvent(parsed);
    if (parsed.type === "message" && parsed.role === "assistant") {
      return parsed.content;
    }
    return null;
  } catch {
    console.log(line);
    return null;
  }
}

function logGeminiEvent(event: GeminiEvent) {
  switch (event.type) {
    case "init":
      console.log(prefix(), `session started: ${event.session_id} (${event.model})`);
      break;
    case "message":
      if (event.role === "assistant" && event.content) {
        // Stream content to stdout to mimic real-time typing without excessive newlines
        Deno.stdout.writeSync(new TextEncoder().encode(event.content));
      }
      break;
    case "tool_use":
      // Ensure we start on a new line if we were streaming text
      console.log("\n" + prefix(), `tool use: ${event.tool_name}`);
      if (event.parameters) {
        console.log(JSON.stringify(event.parameters, null, 2));
      }
      break;
    case "tool_result":
      console.log(prefix(), `tool result (${event.status})`);
      break;
    case "result": {
      console.log("\n" + prefix(), `execution completed (${event.status})`);
      if (event.stats) {
        const { input_tokens, output_tokens } = event.stats;
        console.log(prefix(), "usage:");
        console.log(`  input tokens: ${input_tokens}`);
        console.log(`  output tokens: ${output_tokens}`);

        // Cost estimation
        // Assumptions:
        // - Input: $2.00 / 1M
        // - Output: $12.00 / 1M
        // - Cache hit rate: 94%
        // - Cache discount: 90% (price is 10% of base input)

        const cacheHitRate = 0.94;
        const cachedTokens = input_tokens * cacheHitRate;
        const uncachedTokens = input_tokens * (1 - cacheHitRate);

        const priceInputBase = 2.00;
        const priceInputCached = 2.00 * 0.10; // 90% discount
        const priceOutput = 12.00;

        const costInput = (uncachedTokens * priceInputBase + cachedTokens * priceInputCached) /
          1_000_000;
        const costOutput = (output_tokens * priceOutput) / 1_000_000;
        const estimatedCost = costInput + costOutput;

        console.log(`  estimated cost: $${estimatedCost.toFixed(6)}`);
      }
      break;
    }
    default:
      // Log unknown events exactly as they are
      console.log("\n" + lineToString(event));
      break;
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

async function runClaudeCodeAgent(
  { anthropicApiKey, prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude Code agent.");
  }
  const promptPath = "/tmp/skribulat-plan-prompt.txt";
  await copyPromptToContainer(prompt, runner, promptPath);
  const command = buildClaudeCodeCommand(config, promptPath);
  console.log(`${prefix()} user prompt:\n${prompt}`);
  return await streamClaudeCodeOutput(runner, command, workingDir, anthropicApiKey);
}

async function runCodexAgent(
  { codexAuthPath, openAIApiKey, prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  let usingAuthFile = false;
  if (codexAuthPath && codexAuthPath.trim().length > 0) {
    usingAuthFile = await copyCodexAuthFileToContainer(runner, codexAuthPath);
  }
  if (!usingAuthFile) {
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
  }
  const promptPath = "/tmp/skribulat-plan-prompt.txt";
  await copyPromptToContainer(prompt, runner, promptPath);
  const command = buildCodexCommand(config, promptPath);
  console.log(`${prefix()} user prompt:\n${prompt}`);
  return await streamCodexOutput(runner, command, workingDir);
}

function buildClaudeCodeCommand(config: AgentToolConfig, promptPath: string): string {
  const model = config.model ?? "sonnet";
  const base = config.command && config.command.trim().length > 0 ? config.command.trim() : [
    "claude -p",
    "--dangerously-skip-permissions",
    `--model ${model}`,
    "--output-format stream-json",
    `"$(cat ${promptPath})"`,
  ].join(" ");
  return base;
}

function buildCodexCommand(config: AgentToolConfig, promptPath: string): string {
  const model = config.model ?? "gpt-5.1-codex";
  const reasoningEffort = config.reasoningEffort ?? "low";
  const base = config.command && config.command.trim().length > 0 ? config.command.trim() : [
    "codex exec --json",
    "--dangerously-bypass-approvals-and-sandbox",
    `--model ${model}`,
    `-c shell_environment_policy.ignore_default_excludes=true`,
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

async function copyCodexAuthFileToContainer(
  runner: DockerRunner,
  hostPath: string,
): Promise<boolean> {
  const resolvedPath = resolve(expandHomeDirectory(hostPath));
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(resolvedPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.warn(`Codex auth file not found at ${resolvedPath}. Falling back to API key.`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Unable to access Codex auth file at ${resolvedPath}: ${message}`);
    }
    return false;
  }
  if (!stat.isFile) {
    console.warn(`Codex auth path is not a file: ${resolvedPath}. Falling back to API key.`);
    return false;
  }
  const containerDir = "/root/.codex";
  const mkdirResult = await runner.runBashCommand(`mkdir -p ${containerDir}`);
  if (mkdirResult.code !== 0) {
    console.warn(
      `Failed to create Codex auth directory in container: ${mkdirResult.stderr.trim()}`,
    );
    return false;
  }
  try {
    await runner.copyFromHost(resolvedPath, `${containerDir}/auth.json`);
    console.log(`Copied Codex auth file into container from ${resolvedPath}.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to copy Codex auth file into container: ${message}`);
    return false;
  }
}

function expandHomeDirectory(path: string) {
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home && home.length > 0) {
      return `${home}${path.slice(1)}`;
    }
  } else if (path === "~") {
    const home = Deno.env.get("HOME");
    if (home && home.length > 0) {
      return home;
    }
  }
  return path;
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
    case "turn.started":
      break;
    case "item.started":
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
        if (status === "failed") {
          console.log(
            prefix(),
            `command failed (exit code ${event.item.exit_code}): ${event.item.command}`,
          );
        } else {
          console.log(prefix(), `command succeeded: ${event.item.command}`);
        }
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
    case "turn.completed": {
      const { input_tokens, cached_input_tokens, output_tokens } = event.usage;
      console.log(prefix(), "usage:");
      console.log(`  input tokens: ${input_tokens} (cached: ${cached_input_tokens})`);
      console.log(`  output tokens: ${output_tokens}`);
      // TODO: these are hardcoded for gpt-5.1-codex; make configurable
      const per1MInputTokens = 1.25;
      const per1MCachedInputTokens = 0.125;
      const per1MOutputTokens = 10.0;
      const estimatedCost = ((input_tokens - cached_input_tokens) / 1_000_000) *
          per1MInputTokens +
        (cached_input_tokens / 1_000_000) * per1MCachedInputTokens +
        (output_tokens / 1_000_000) * per1MOutputTokens;
      console.log(`  estimated cost: $${estimatedCost.toFixed(6)}`);
      break;
    }
    default:
      console.log(lineToString(event));
      break;
  }
}

function prefix() {
  return `[${new Date().toTimeString().slice(0, 8)}]`;
}

type ClaudeCodeEvent =
  | { type: "system"; subtype: string }
  | {
    type: "assistant";
    message: {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; name: string; input: Record<string, unknown> }
      >;
    };
  }
  | { type: "user"; message: Record<string, unknown> }
  | { type: "result"; subtype: string; result?: string; is_error: boolean };

async function streamClaudeCodeOutput(
  runner: DockerRunner,
  command: string,
  workingDir: string,
  apiKey: string,
): Promise<string> {
  console.log(`Running Claude Code agent with command: ${command}`);
  const envCommand = `ANTHROPIC_API_KEY="${apiKey}" ${command}`;
  const stream = runner.streamBashCommand(envCommand, { cwd: workingDir });
  let finalMessage = "";
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk.data;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const result = processClaudeCodeLine(line);
      if (result) finalMessage = result;
    }
  }
  if (buffered.trim().length > 0) {
    const result = processClaudeCodeLine(buffered);
    if (result) finalMessage = result;
  }
  if (finalMessage.trim().length === 0) {
    throw new Error("Claude Code agent did not return a final message.");
  }
  return finalMessage.trim();
}

function processClaudeCodeLine(line: string): string | null {
  if (line.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(line) as ClaudeCodeEvent;
    logClaudeCodeEvent(parsed);
    if (parsed.type === "result" && !parsed.is_error && parsed.result) {
      return parsed.result;
    }
    return null;
  } catch {
    console.log(line);
    return null;
  }
}

function logClaudeCodeEvent(event: ClaudeCodeEvent) {
  switch (event.type) {
    case "system":
      console.log(prefix(), `system event: ${event.subtype}`);
      break;
    case "assistant": {
      for (const content of event.message.content) {
        if (content.type === "text") {
          console.log(
            prefix(),
            `assistant: ${content.text.substring(0, 100)}${content.text.length > 100 ? "..." : ""}`,
          );
        } else if (content.type === "tool_use") {
          console.log(prefix(), `tool used: ${content.name}`);
        }
      }
      break;
    }
    case "user":
      break;
    case "result":
      if (event.is_error) {
        console.log(prefix(), "execution failed");
      } else {
        console.log(prefix(), "execution completed");
      }
      break;
    default:
      console.log(lineToString(event));
      break;
  }
}

function lineToString(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
