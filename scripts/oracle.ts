import { basename, fromFileUrl, join, resolve as resolvePath } from "@std/path";
import {
  buildFilteredFileEntries,
  countLines,
  type FileEntry,
} from "../utils/codebase_snapshot.ts";
import { loadEnv } from "../utils/env.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { generateCompletion } from "../utils/llm.ts";

type SessionStatus = "pending" | "running" | "completed" | "failed";

type Attachment = {
  path: string;
  content: string;
};

type SessionMessage = {
  prompt: string;
  attachments: Attachment[];
  createdAt: string;
  response?: string;
};

type SessionState = {
  id: string;
  model: ModelAlias;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messages: SessionMessage[];
  error?: string;
};

type ParsedArgs = {
  include: RegExp[];
  exclude: RegExp[];
  prompt?: string;
  detached: boolean;
  continueId?: string;
  waitId?: string;
  timeoutSeconds: number;
  internalProcessId?: string;
  model: ModelAlias;
  modelProvided: boolean;
  dryRun: boolean;
};

const PER_FILE_LINE_LIMIT = 5_000;
const PER_FILE_CHAR_LIMIT = 100_000;
const TOTAL_LINE_LIMIT = 50_000;
const TOTAL_CHAR_LIMIT = 1_000_000;
const DEFAULT_TIMEOUT = 30;
const POLL_INTERVAL_MS = 500;
const MODEL_ALIASES = {
  "gemini-3-pro": "google/gemini-3-pro-preview",
  "gemini-2.5-flash": "google/gemini-2.5-flash-preview-09-2025",
  "gpt-5.1": "openai/gpt-5.1",
  "gpt-5.1-pro": "openai/gpt-5.1-pro",
} as const;
type ModelAlias = keyof typeof MODEL_ALIASES;
const DEFAULT_MODEL_ALIAS: ModelAlias = "gemini-3-pro";

const MODEL_CONFIG: Record<
  ModelAlias,
  {
    maxTokens: number;
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    reasoningMaxTokens?: number;
  }
> = {
  "gemini-3-pro": { maxTokens: 32_768, reasoningEffort: "high" },
  "gemini-2.5-flash": { maxTokens: 32_768, reasoningEffort: "medium" },
  "gpt-5.1": { maxTokens: 32_768, reasoningEffort: "high" },
  "gpt-5.1-pro": { maxTokens: 32_768, reasoningEffort: "high" },
};

function printSessionId(id: string) {
  console.log(`Session: ${id}`);
}

function usage() {
  console.log(
    [
      "Usage: skribulat oracle [options]",
      "",
      "Examples:",
      '  skribulat oracle -p "what is 1+2?"',
      "  skribulat oracle -i '^src/.+\\.ts' -e '\\.test\\.ts$' -p \"which components open a dialog?\"",
      '  skribulat oracle -d -p "analyze in background"',
      '  skribulat oracle -w "<uuid>" -t 45',
      '  skribulat oracle -c "<uuid>" -i "^package\\.json$" -p "continue existing session with a new prompt"',
      '  skribulat oracle --dry-run -i "^src/api" -p "inspect without calling the model"',
      "",
      "Options:",
      "  -p, --prompt <text>      Question or instruction for the oracle",
      "  -i, --include <pattern>  Regex for files to attach (repeatable)",
      "  -e, --exclude <pattern>  Regex for files to exclude (repeatable)",
      "  -d, --detached           Run query in a detached background process (prints session UUID)",
      "  -c, --continue <uuid>    Append a follow-up message to an existing session",
      "  -w, --wait <uuid>        Wait for a detached session to finish",
      "  -t, --timeout <seconds>  Maximum seconds to wait with -w (default 30)",
      "  -m, --model <name>       Model alias: gemini-3-pro | gemini-2.5-flash | gpt-5.1 | gpt-5.1-pro",
      "      --dry-run            Show what would be sent without calling the model",
      "  -h, --help               Show this help message",
    ].join("\n"),
  );
}

function compileRegex(flag: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid regex for ${flag}: ${message}`);
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  let prompt: string | undefined;
  let detached = false;
  let continueId: string | undefined;
  let waitId: string | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT;
  let internalProcessId: string | undefined;
  let model: ModelAlias = DEFAULT_MODEL_ALIAS;
  let modelProvided = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      Deno.exit(0);
    }
    if (arg === "-p" || arg === "--prompt") {
      prompt = argv[++i];
      if (!prompt) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      if (!prompt) throw new CliError("--prompt flag requires a value.");
      continue;
    }
    if (arg === "-i" || arg === "--include") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} flag requires a value.`);
      include.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--include=")) {
      const pattern = arg.slice("--include=".length);
      if (!pattern) throw new CliError("--include flag requires a value.");
      include.push(compileRegex("--include", pattern));
      continue;
    }
    if (arg === "-e" || arg === "--exclude") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} flag requires a value.`);
      exclude.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      const pattern = arg.slice("--exclude=".length);
      if (!pattern) throw new CliError("--exclude flag requires a value.");
      exclude.push(compileRegex("--exclude", pattern));
      continue;
    }
    if (arg === "-d" || arg === "--detached") {
      detached = true;
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      continueId = argv[++i];
      if (!continueId) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--continue=")) {
      continueId = arg.slice("--continue=".length);
      if (!continueId) throw new CliError("--continue flag requires a value.");
      continue;
    }
    if (arg === "-w" || arg === "--wait") {
      waitId = argv[++i];
      if (!waitId) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--wait=")) {
      waitId = arg.slice("--wait=".length);
      if (!waitId) throw new CliError("--wait flag requires a value.");
      continue;
    }
    if (arg === "-t" || arg === "--timeout") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} flag requires a value.`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliError("Timeout must be a positive number of seconds.");
      }
      timeoutSeconds = parsed;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const value = arg.slice("--timeout=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliError("Timeout must be a positive number of seconds.");
      }
      timeoutSeconds = parsed;
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} flag requires a value.`);
      if (!(value in MODEL_ALIASES)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-3-pro, gemini-2.5-flash, gpt-5.1, gpt-5.1-pro.",
        );
      }
      model = value as ModelAlias;
      modelProvided = true;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new CliError("--model flag requires a value.");
      if (!(value in MODEL_ALIASES)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-3-pro, gemini-2.5-flash, gpt-5.1, gpt-5.1-pro.",
        );
      }
      model = value as ModelAlias;
      modelProvided = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--process-session") {
      internalProcessId = argv[++i];
      if (!internalProcessId) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--process-session=")) {
      internalProcessId = arg.slice("--process-session=".length);
      if (!internalProcessId) throw new CliError("--process-session flag requires a value.");
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  return {
    include,
    exclude,
    prompt,
    detached,
    continueId,
    waitId,
    timeoutSeconds,
    internalProcessId,
    model,
    modelProvided,
    dryRun,
  };
}

function resolveSessionsDir(): string {
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new CliError("HOME is not set; cannot resolve ~/.skribulat directory.");
  }
  const dir = join(home, ".skribulat", "oracle");
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFilePath(id: string): string {
  return join(resolveSessionsDir(), `${id}.json`);
}

async function loadSession(id: string): Promise<SessionState> {
  const path = sessionFilePath(id);
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as SessionState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to load session ${id}: ${message}`);
  }
}

async function saveSession(state: SessionState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const path = sessionFilePath(state.id);
  const content = JSON.stringify(state, null, 2);
  await Deno.writeTextFile(path, content);
}

async function decodeAttachment(
  entry: FileEntry,
  warnings: string[],
): Promise<{ content: string; lines: number; chars: number } | null> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(entry.absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to read ${entry.cwdRelativePosix}: ${message}`);
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (_error) {
    warnings.push(
      `Skipping ${entry.cwdRelativePosix}: file is not valid UTF-8 (possibly binary).`,
    );
    return null;
  }

  const lines = countLines(content);
  const chars = content.length;

  if (lines > PER_FILE_LINE_LIMIT || chars > PER_FILE_CHAR_LIMIT) {
    throw new CliError(
      `Attachment ${entry.cwdRelativePosix} exceeds per-file limit (${lines} lines, ${chars} chars; ` +
        `max ${PER_FILE_LINE_LIMIT} lines or ${PER_FILE_CHAR_LIMIT} chars).`,
    );
  }

  return { content, lines, chars };
}

async function collectAttachments(
  entries: FileEntry[],
): Promise<{ attachments: Attachment[]; warnings: string[] }> {
  const attachments: Attachment[] = [];
  const warnings: string[] = [];
  let totalLines = 0;
  let totalChars = 0;

  for (const entry of entries) {
    const decoded = await decodeAttachment(entry, warnings);
    if (!decoded) continue;

    if (
      totalLines + decoded.lines > TOTAL_LINE_LIMIT ||
      totalChars + decoded.chars > TOTAL_CHAR_LIMIT
    ) {
      throw new CliError(
        `Total attachment size exceeds limit after adding ${entry.cwdRelativePosix} ` +
          `(${totalLines + decoded.lines} lines, ${totalChars + decoded.chars} chars; ` +
          `max ${TOTAL_LINE_LIMIT} lines or ${TOTAL_CHAR_LIMIT} chars).`,
      );
    }

    totalLines += decoded.lines;
    totalChars += decoded.chars;
    attachments.push({ path: entry.cwdRelativePosix, content: decoded.content });
  }

  return { attachments, warnings };
}

function ensurePromptProvided(prompt?: string) {
  if (!prompt || prompt.trim().length === 0) {
    throw new CliError("Prompt (-p/--prompt) is required.");
  }
}

function validateIntent(args: ParsedArgs) {
  const isAsk = !!args.prompt || !!args.include.length || !!args.continueId;
  const isWait = !!args.waitId;
  const isInternal = !!args.internalProcessId;
  const activeModes = [isAsk, isWait, isInternal].filter(Boolean).length;
  if (activeModes === 0) {
    usage();
    throw new CliError("No action specified. Provide a prompt or use --wait.");
  }
  if (activeModes > 1) {
    throw new CliError("Choose one mode at a time: ask, wait, or internal process.");
  }
}

async function buildSessionState(
  prompt: string,
  include: RegExp[],
  exclude: RegExp[],
  continueId?: string,
  modelProvided?: boolean,
  model: ModelAlias = DEFAULT_MODEL_ALIAS,
): Promise<{ state: SessionState; warnings: string[] }> {
  const entries = include.length === 0 ? [] : buildFilteredFileEntries({ include, exclude });
  const { attachments, warnings } = await collectAttachments(entries);
  const now = new Date().toISOString();

  if (continueId) {
    const state = await loadSession(continueId);
    if (modelProvided) {
      state.model = model;
    }
    state.messages.push({ prompt, attachments, createdAt: now });
    state.status = "pending";
    state.error = undefined;
    return { state, warnings };
  }

  const id = crypto.randomUUID();
  return {
    state: {
      id,
      model,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      messages: [{ prompt, attachments, createdAt: now }],
    },
    warnings,
  };
}

function buildOracleSystemPrompt(): string {
  return [
    "You are Oracle, a focused one-shot problem solver. Answer the user's question concisely and directly.",
    "If information or context is missing, explain what is needed rather than guessing.",
    "If you need to see more files before answering, request them explicitly.",
    "Use any attached files as authoritative context. Keep formatting minimal and markdown-friendly.",
    "Cite files you reference in your answer using their paths.",
  ].join(" ");
}

function buildOracleMessages(state: SessionState) {
  const systemContent = buildOracleSystemPrompt();
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemContent },
  ];
  state.messages.forEach((msg) => {
    const parts: string[] = [];
    parts.push(msg.prompt);
    if (msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        parts.push(`<file path="${attachment.path}">\n${attachment.content}\n</file>`);
      }
    }
    messages.push({ role: "user", content: parts.join("\n\n") });
    if (msg.response) {
      messages.push({ role: "assistant", content: msg.response });
    }
  });
  return messages;
}

async function answerWithOracle(state: SessionState) {
  state.status = "running";
  await saveSession(state);
  try {
    const cfg = MODEL_CONFIG[state.model] ?? MODEL_CONFIG[DEFAULT_MODEL_ALIAS];
    const completion = await generateCompletion({
      maxTokens: cfg.maxTokens,
      model: MODEL_ALIASES[state.model],
      messages: buildOracleMessages(state),
      reasoningEffort: cfg.reasoningEffort,
      reasoningMaxTokens: cfg.reasoningMaxTokens,
    });
    const latest = state.messages[state.messages.length - 1];
    latest.response = completion.trim();
    state.status = "completed";
    await saveSession(state);
  } catch (error) {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    await saveSession(state);
    throw error;
  }
}

async function runDetachedBackground(sessionId: string) {
  const execPath = Deno.execPath();
  const isDenoCli = basename(execPath).includes("deno");
  const mainPath = resolvePath(fromFileUrl(Deno.mainModule));
  const args = isDenoCli
    ? ["run", "-A", mainPath, "oracle", `--process-session=${sessionId}`]
    : ["oracle", `--process-session=${sessionId}`];

  try {
    const cmd = new Deno.Command(execPath, {
      args,
      cwd: Deno.cwd(),
      env: { ...Deno.env.toObject(), SKRIBULAT_ENV_FILES: "0" },
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true,
    }).spawn();
    cmd.unref();
  } catch (error) {
    const state = await loadSession(sessionId).catch(() => null);
    if (state) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      await saveSession(state);
    }
    throw error;
  }
}

async function waitForSession(id: string, timeoutSeconds: number): Promise<SessionState | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const state = await loadSession(id);
    if (state.status === "completed" || state.status === "failed") {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

function printSessionResult(state: SessionState) {
  const latest = state.messages[state.messages.length - 1];
  const response = latest.response ?? "(no response recorded)";
  console.log(response);
  if (state.status === "failed" && state.error) {
    console.log(`Status: failed (${state.error})`);
  }
}

async function handleAskFlow(args: ParsedArgs) {
  ensurePromptProvided(args.prompt);
  if (args.dryRun) {
    const entries = args.include.length === 0
      ? []
      : buildFilteredFileEntries({ include: args.include, exclude: args.exclude });
    const warnings: string[] = [];
    let totalLines = 0;
    let totalChars = 0;
    const sessionId = crypto.randomUUID();
    printSessionId(`${sessionId} (dry-run, not saved)`);
    if (entries.length === 0) {
      console.log("No git-visible files matched under the current directory.");
    } else {
      for (const entry of entries) {
        const decoded = await decodeAttachment(entry, warnings);
        if (!decoded) continue;
        if (
          totalLines + decoded.lines > TOTAL_LINE_LIMIT ||
          totalChars + decoded.chars > TOTAL_CHAR_LIMIT
        ) {
          throw new CliError(
            `Total attachment size exceeds limit after adding ${entry.cwdRelativePosix} ` +
              `(${totalLines + decoded.lines} lines, ${totalChars + decoded.chars} chars; ` +
              `max ${TOTAL_LINE_LIMIT} lines or ${TOTAL_CHAR_LIMIT} chars).`,
          );
        }
        const { lines, chars } = decoded;
        totalLines += lines;
        totalChars += chars;
        console.log(
          `${entry.cwdRelativePosix}: ${lines} line${lines === 1 ? "" : "s"} (${chars} chars)`,
        );
      }
      console.log(`Total files: ${entries.length}`);
      console.log(`Total lines: ${totalLines}`);
      console.log(`Total chars: ${totalChars}`);
      if (warnings.length > 0) {
        warnings.forEach((warning) => console.warn(warning));
      }
    }
    console.log();
    console.log("Prompt:");
    console.log(args.prompt);
    console.log();
    console.log(`Would run model: ${args.model}`);
    console.log(`Detached: ${args.detached ? "yes" : "no"}`);
    console.log(`Continue session: ${args.continueId ?? "(new)"}`);
    return;
  }

  const { state, warnings } = await buildSessionState(
    args.prompt!,
    args.include,
    args.exclude,
    args.continueId,
    args.modelProvided,
    args.model,
  );
  await saveSession(state);
  printSessionId(state.id);
  if (warnings.length > 0) {
    warnings.forEach((warning) => console.warn(warning));
  }

  if (args.detached) {
    await runDetachedBackground(state.id);
    return;
  }

  await answerWithOracle(state);
  printSessionResult(state);
}

async function handleWaitFlow(args: ParsedArgs) {
  if (!args.waitId) throw new CliError("Missing session id for --wait.");
  printSessionId(args.waitId);
  const result = await waitForSession(args.waitId, args.timeoutSeconds);
  if (!result) {
    console.log(`Session ${args.waitId} not finished after ${args.timeoutSeconds} seconds.`);
    return;
  }
  printSessionResult(result);
}

async function handleInternalProcess(id: string) {
  try {
    const state = await loadSession(id);
    await answerWithOracle(state);
  } catch (_error) {
    // Suppress errors in detached worker to keep background quiet.
  }
}

export async function runOracle(argv: string[]) {
  await loadEnv();
  const parsed = parseArgs(argv);
  validateIntent(parsed);

  if (parsed.internalProcessId) {
    await handleInternalProcess(parsed.internalProcessId);
    return;
  }

  if (parsed.waitId) {
    await handleWaitFlow(parsed);
    return;
  }

  await handleAskFlow(parsed);
}

if (import.meta.main) {
  runOracle(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
