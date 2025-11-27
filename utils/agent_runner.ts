import { resolve } from "@std/path";
import { DockerRunner } from "./docker.ts";
import { AgentToolConfig } from "./project_config.ts";

const CLAUDE_SETTINGS_PATH = "/root/.claude/settings.json";
const CLAUDE_SETTINGS = {
  sandbox: {
    enabled: false,
  },
  permissions: {
    deny: [],
  },
  env: {
    BASH_DEFAULT_TIMEOUT_MS: "120000",
    BASH_MAX_OUTPUT_LENGTH: "65536",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    MAX_THINKING_TOKENS: "16384",
    USE_BUILTIN_RIPGREP: "0",
  },
};

export type AgentExecutionContext = {
  anthropicApiKey?: string;
  codexAuthPath?: string;
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

async function runClaudeCodeAgent(
  { anthropicApiKey, prompt, runner, workingDir }: AgentExecutionContext,
  config: AgentToolConfig,
): Promise<string> {
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude Code agent.");
  }
  await writeClaudeSettingsFile(runner);
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
  const model = normalizeClaudeModel(config.model);
  const base = config.command && config.command.trim().length > 0 ? config.command.trim() : [
    "claude",
    "--dangerously-skip-permissions",
    `--model ${model}`,
    "--output-format stream-json",
    "--verbose",
    "--print",
    `"$(cat ${promptPath})"`,
  ].join(" ");
  return base;
}

function normalizeClaudeModel(model?: string): string {
  const fallback = "sonnet";
  if (!model || model.trim().length === 0) return fallback;
  const raw = model.trim().toLowerCase();
  const baseAliases = new Set(["haiku", "sonnet", "opus"]);
  const versionedAliases = new Set(["haiku-4.5", "sonnet-4.5", "opus-4.5"]);
  if (baseAliases.has(raw)) return raw;
  if (versionedAliases.has(raw)) return raw.replace("-4.5", "");
  throw new Error(
    "Invalid Claude Code model. Allowed: haiku, sonnet, opus (versionless; -4.5 suffix accepted but stripped).",
  );
}

function buildCodexCommand(config: AgentToolConfig, promptPath: string): string {
  const model = config.model ?? "gpt-5.1-codex-max";
  const reasoningEffort = config.reasoningEffort ?? "high";
  const base = config.command && config.command.trim().length > 0 ? config.command.trim() : [
    "codex exec --json",
    "--dangerously-bypass-approvals-and-sandbox",
    `--model ${model}`,
    `-c shell_environment_policy.ignore_default_excludes=true`,
    `-c shell_environment_policy.inherit=\"all\"`,
    `-c project_doc_max_bytes=131072`,
    `-c tool_output_token_limit=16384`,
    `-c model_reasoning_effort=\"${reasoningEffort}\"`,
    `-c model_reasoning_summary=\"detailed\"`,
    `-c model_verbosity=\"high\"`,
    `-c features.web_search_request=true`,
    `-c features.apply_patch_freeform=true`,
    `-c features.view_image_tool=true`,
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

async function writeClaudeSettingsFile(runner: DockerRunner) {
  const tempFile = await Deno.makeTempFile({
    prefix: "skribulat-claude-settings-",
    suffix: ".json",
  });
  await Deno.writeTextFile(tempFile, JSON.stringify(CLAUDE_SETTINGS));
  try {
    const mkdirResult = await runner.runBashCommand("mkdir -p /root/.claude");
    if (mkdirResult.code !== 0) {
      const reason = mkdirResult.stderr.trim() || `exit code ${mkdirResult.code}`;
      throw new Error(`Failed to create /root/.claude in container: ${reason}`);
    }
    await runner.copyFromHost(tempFile, CLAUDE_SETTINGS_PATH);
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
      // TODO: these are hardcoded for gpt-5.1-codex-max; make configurable
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
  | ClaudeEventSystem
  | ClaudeEventAssistant
  | ClaudeEventUser
  | ClaudeEventResult;

type ClaudeEventSystem = {
  type: "system";
  subtype: "init";
  model: string;
  tools?: string[];
};

type ContentThinking = { type: "thinking"; thinking: string };
type ContentToolUse = {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
};
type ContentText = { type: "text"; text: string };
type ClaudeContent = ContentThinking | ContentToolUse | ContentText;

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: Record<string, unknown>;
  service_tier?: string;
  server_tool_use?: Record<string, unknown>;
};

type ClaudeEventAssistant = {
  type: "assistant";
  message: {
    role: "assistant";
    content: ClaudeContent[];
    usage?: ClaudeUsage;
  };
};

type ClaudeToolUseResult = {
  stdout?: string;
  stderr?: string;
  is_error?: boolean;
  interrupted?: boolean;
  type?: "text";
  file?: { filePath: string; numLines?: number; startLine?: number; totalLines?: number };
  filenames?: string[];
  numFiles?: number;
};

type ClaudeEventUser = {
  type: "user";
  message?: Record<string, unknown>;
  tool_use_result?: ClaudeToolUseResult;
};

type ClaudeEventResult = {
  type: "result";
  subtype: "success" | "failure";
  result: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
};

async function streamClaudeCodeOutput(
  runner: DockerRunner,
  command: string,
  workingDir: string,
  apiKey: string,
): Promise<string> {
  console.log(`Running Claude Code agent with command: ${command}`);
  const envCommand = `IS_SANDBOX=1 ANTHROPIC_API_KEY="${apiKey}" ${command}`;
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
      console.log(
        prefix(),
        `initialized claude-code session (model: ${event.model})`,
      );
      if (event.tools && event.tools.length > 0) {
        console.log(prefix(), `tools: ${event.tools.join(", ")}`);
      }
      break;
    case "assistant": {
      for (const content of event.message.content) {
        if (content.type === "text") {
          console.log(prefix(), `assistant:\n${truncateClaudeOutput(content.text)}`);
        } else if (content.type === "thinking") {
          console.log(prefix(), `thinking:\n${truncateClaudeOutput(content.thinking)}`);
        } else if (content.type === "tool_use") {
          console.log(prefix(), `tool use: ${content.name}`);
          logClaudeToolInput(content.name, content.input);
        }
      }
      break;
    }
    case "user":
      if (event.tool_use_result) {
        logClaudeToolResult(event.tool_use_result);
      }
      break;
    case "result":
      logClaudeResult(event);
      break;
    default:
      console.log(lineToString(event));
      break;
  }
}

function logClaudeToolInput(name: string, input: Record<string, unknown>) {
  const command = typeof input.command === "string" ? input.command : null;
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  const pattern = typeof input.pattern === "string" ? input.pattern : null;
  if (name === "Bash" && command) {
    console.log(prefix(), `  command: ${command}`);
    return;
  }
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name) && filePath) {
    console.log(prefix(), `  file: ${filePath}`);
    return;
  }
  if (name === "Grep" && pattern) {
    console.log(prefix(), `  pattern: ${pattern}`);
    return;
  }
  if (name === "Glob" && pattern) {
    console.log(prefix(), `  glob: ${pattern}`);
    return;
  }
  const summary = truncateClaudeOutput(JSON.stringify(input));
  if (summary.length > 0) {
    console.log(prefix(), `  input: ${summary}`);
  }
}

function logClaudeToolResult(result: ClaudeToolUseResult) {
  const hasStdout = typeof result.stdout === "string" && result.stdout.length > 0;
  const hasStderr = typeof result.stderr === "string" && result.stderr.length > 0;
  if (hasStdout || hasStderr || result.is_error !== undefined || result.interrupted !== undefined) {
    if (hasStdout) {
      console.log(prefix(), "command output:\n" + truncateClaudeOutput(result.stdout ?? ""));
    }
    if (hasStderr) {
      console.log(prefix(), "command stderr:\n" + truncateClaudeOutput(result.stderr ?? ""));
    }
    if (result.is_error) {
      console.log(prefix(), "command failed");
    }
    if (result.interrupted) {
      console.log(prefix(), "command interrupted");
    }
    return;
  }
  if (result.file?.filePath) {
    const lines = result.file.numLines ?? result.file.totalLines;
    const linesLabel = lines !== undefined ? ` (${lines} lines)` : "";
    console.log(prefix(), `read file ${result.file.filePath}${linesLabel}`);
    return;
  }
  if (result.filenames || result.numFiles !== undefined) {
    const count = result.numFiles ?? result.filenames?.length ?? 0;
    const numLines = result.file?.numLines ?? result.file?.totalLines;
    const linesLabel = numLines !== undefined ? ` (${numLines} lines)` : "";
    const label = result.filenames && result.filenames.length > 0
      ? ` (${result.filenames.join(", ")})`
      : "";
    console.log(prefix(), `found ${count} files${label}${linesLabel}`);
    return;
  }
  console.log(prefix(), "tool execution completed");
}

function logClaudeResult(event: ClaudeEventResult) {
  const status = event.subtype === "success" && !event.is_error ? "completed" : "failed";
  console.log(prefix(), `session ${status}`);
  if (typeof event.duration_ms === "number") {
    console.log(prefix(), `duration: ${event.duration_ms}ms`);
  }
  if (typeof event.total_cost_usd === "number") {
    console.log(prefix(), `cost: $${event.total_cost_usd.toFixed(6)}`);
  }
  if (event.usage) {
    const inputTokens = event.usage.input_tokens ?? 0;
    const outputTokens = event.usage.output_tokens ?? 0;
    const cacheTokens = event.usage.cache_read_input_tokens ?? 0;
    console.log(
      prefix(),
      `tokens: ${inputTokens} input (cached: ${cacheTokens}), ${outputTokens} output`,
    );
  }
}

function truncateClaudeOutput(text: string, max = 8192) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function lineToString(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
