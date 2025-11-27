import { basename, fromFileUrl, join, resolve as resolvePath } from "@std/path";
import {
  buildFilteredFileEntries,
  countLines,
  type FileEntry,
} from "../utils/codebase_snapshot.ts";
import { loadEnv } from "../utils/env.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { resolveRepoRoot } from "../utils/git.ts";
import { generateCompletion } from "../utils/llm.ts";
import { loadProjectConfig, type OracleFragmentConfig } from "../utils/project_config.ts";
import { loadPrompt } from "../utils/prompts.ts";

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
  fragmentNames: string[];
  prompt?: string;
  showId?: string;
  copyId?: string;
  copyResponseIndex?: number;
  stdinText?: string;
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
const DISPLAY_PREVIEW_CHARS = 200;
const COPY_NEWLINE = "\n";
const MODEL_ALIASES = {
  "gemini-3-pro": "google/gemini-3-pro-preview",
  "gemini-2.5-flash": "google/gemini-2.5-flash-preview-09-2025",
  "claude-opus-4.5": "anthropic/claude-opus-4.5",
  "gpt-5.1": "openai/gpt-5.1",
  "gpt-5.1-pro": "openai/gpt-5.1-pro",
} as const;
type ModelAlias = keyof typeof MODEL_ALIASES;
const DEFAULT_MODEL_ALIAS: ModelAlias = "gemini-3-pro";

type Fragment = {
  name: string;
  include: RegExp[];
  exclude: RegExp[];
};

const MODEL_CONFIG: Record<
  ModelAlias,
  {
    maxTokens: number;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    reasoningMaxTokens?: number;
  }
> = {
  "gemini-3-pro": { maxTokens: 32_768, reasoningEffort: "high" },
  "gemini-2.5-flash": { maxTokens: 32_768, reasoningEffort: "medium" },
  "claude-opus-4.5": { maxTokens: 32_768, reasoningEffort: "high" },
  "gpt-5.1": { maxTokens: 32_768, reasoningEffort: "high" },
  "gpt-5.1-pro": { maxTokens: 32_768, reasoningEffort: "high" },
};

function printSessionId(id: string) {
  console.log(`Session: ${id}`);
}

function usage(defaultModel: ModelAlias) {
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
      '  skribulat oracle -s "<uuid>"',
      '  skribulat oracle --copy "<uuid>" | pbcopy',
      "",
      "Options:",
      "  -p, --prompt <text>      Question or instruction for the oracle",
      "  -f, --fragment <name>    Fragment to attach (repeatable; configured under oracle.fragments)",
      "  -i, --include <pattern>  Regex for files to attach (repeatable)",
      "  -e, --exclude <pattern>  Regex for files to exclude (repeatable)",
      "  -d, --detached           Run query in a detached background process (prints session UUID)",
      "  -c, --continue <uuid>    Append a follow-up message to an existing session",
      "  -w, --wait <uuid>        Wait for a detached session to finish",
      "  -s, --show <uuid>        Print full conversation history for a session",
      "      --copy <uuid>        Print a single assistant response for piping (e.g., to pbcopy)",
      "  -r, --response <n>       Response index to copy (1-based within assistant replies; defaults to last)",
      "  -t, --timeout <seconds>  Maximum seconds to wait with -w (default 30)",
      `  -m, --model <name>       Model alias: gemini-3-pro | gemini-2.5-flash | claude-opus-4.5 | gpt-5.1 | gpt-5.1-pro (default ${defaultModel})`,
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

function resolveDefaultModelAlias(configModel?: string): ModelAlias {
  if (!configModel) return DEFAULT_MODEL_ALIAS;
  if (!(configModel in MODEL_ALIASES)) {
    throw new CliError(
      `Invalid oracle.default_model "${configModel}". Allowed: ${
        Object.keys(MODEL_ALIASES).join(", ")
      }.`,
    );
  }
  return configModel as ModelAlias;
}

function compileFragmentConfig(config: OracleFragmentConfig): Fragment | null {
  const include = config.include.map((pattern) => compileRegex(config.name, pattern));
  const exclude = (config.exclude ?? []).map((pattern) => compileRegex(config.name, pattern));
  if (include.length === 0) return null;
  return { name: config.name, include, exclude };
}

function resolveFragments(
  fragmentNames: string[],
  configured: OracleFragmentConfig[] | undefined,
): Fragment[] {
  if (fragmentNames.length === 0) return [];
  const available = (configured ?? []).map(compileFragmentConfig).filter(Boolean) as Fragment[];
  if (available.length === 0) {
    throw new CliError("No fragments configured. Add oracle.fragments to .skribulat/config.yaml.");
  }
  const byName = new Map(available.map((fragment) => [fragment.name, fragment] as const));
  const selected: Fragment[] = [];
  for (const name of fragmentNames) {
    const fragment = byName.get(name);
    if (!fragment) {
      const known = available.map((frag) => frag.name).join(", ");
      throw new CliError(`Unknown fragment "${name}". Known fragments: ${known || "none"}.`);
    }
    selected.push(fragment);
  }
  return selected;
}

function parseArgs(argv: readonly string[], defaultModel: ModelAlias): ParsedArgs {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  const fragmentNames: string[] = [];
  let prompt: string | undefined;
  let detached = false;
  let showId: string | undefined;
  let copyId: string | undefined;
  let copyResponseIndex: number | undefined;
  let continueId: string | undefined;
  let waitId: string | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT;
  let internalProcessId: string | undefined;
  let model: ModelAlias = defaultModel;
  let modelProvided = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage(defaultModel);
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
    if (arg === "-f" || arg === "--fragment") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} flag requires a value.`);
      fragmentNames.push(value.trim());
      continue;
    }
    if (arg.startsWith("--fragment=")) {
      const value = arg.slice("--fragment=".length);
      if (!value) throw new CliError("--fragment flag requires a value.");
      fragmentNames.push(value.trim());
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
    if (arg === "--copy") {
      copyId = argv[++i];
      if (!copyId) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--copy=")) {
      copyId = arg.slice("--copy=".length);
      if (!copyId) throw new CliError("--copy flag requires a value.");
      continue;
    }
    if (arg === "-r" || arg === "--response") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} flag requires a value.`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliError("Response index must be a positive integer.");
      }
      copyResponseIndex = parsed;
      continue;
    }
    if (arg.startsWith("--response=")) {
      const value = arg.slice("--response=".length);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliError("Response index must be a positive integer.");
      }
      copyResponseIndex = parsed;
      continue;
    }
    if (arg === "-s" || arg === "--show") {
      showId = argv[++i];
      if (!showId) throw new CliError(`${arg} flag requires a value.`);
      continue;
    }
    if (arg.startsWith("--show=")) {
      showId = arg.slice("--show=".length);
      if (!showId) throw new CliError("--show flag requires a value.");
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
          "Invalid model alias. Allowed: gemini-3-pro, gemini-2.5-flash, claude-opus-4.5, gpt-5.1, gpt-5.1-pro.",
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
          "Invalid model alias. Allowed: gemini-3-pro, gemini-2.5-flash, claude-opus-4.5, gpt-5.1, gpt-5.1-pro.",
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
    fragmentNames,
    prompt,
    showId,
    copyId,
    copyResponseIndex,
    stdinText: undefined,
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

function collectSelectedEntries(
  fragments: Fragment[],
  include: RegExp[],
  exclude: RegExp[],
): FileEntry[] {
  const combined: FileEntry[] = [];
  const seen = new Set<string>();
  const repoRoot = fragments.length > 0 ? resolveRepoRoot() : undefined;

  const addEntries = (entries: FileEntry[]) => {
    for (const entry of entries) {
      if (seen.has(entry.cwdRelativePosix)) continue;
      seen.add(entry.cwdRelativePosix);
      combined.push(entry);
    }
  };

  if (repoRoot) {
    for (const fragment of fragments) {
      const entries = buildFilteredFileEntries({
        include: fragment.include,
        exclude: fragment.exclude,
        cwd: repoRoot,
        repoRoot,
      });
      addEntries(entries);
    }
  }

  if (include.length > 0) {
    const entries = buildFilteredFileEntries({ include, exclude });
    addEntries(entries);
  }

  return combined;
}

function ensurePromptProvided(prompt?: string) {
  if (!prompt || prompt.trim().length === 0) {
    throw new CliError("Prompt (-p/--prompt) is required.");
  }
}

function validateIntent(args: ParsedArgs) {
  const isAsk = !!args.prompt || !!args.include.length || !!args.continueId;
  const isWait = !!args.waitId;
  const isShow = !!args.showId;
  const isCopy = !!args.copyId;
  const isInternal = !!args.internalProcessId;
  const activeModes = [isAsk, isWait, isShow, isCopy, isInternal].filter(Boolean).length;
  if (activeModes === 0) {
    usage(DEFAULT_MODEL_ALIAS);
    throw new CliError("No action specified. Provide a prompt or use --wait/--show/--copy.");
  }
  if (activeModes > 1) {
    throw new CliError("Choose one mode at a time: ask, wait, show, copy, or internal process.");
  }
}

async function buildSessionState(
  prompt: string,
  entries: FileEntry[],
  continueId?: string,
  modelProvided?: boolean,
  model: ModelAlias = DEFAULT_MODEL_ALIAS,
): Promise<{ state: SessionState; warnings: string[] }> {
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

async function buildOracleSystemPrompt(): Promise<string> {
  const prompt = await loadPrompt("oracle_system.txt");
  return prompt.trim();
}

async function buildOracleMessages(state: SessionState) {
  const systemContent = await buildOracleSystemPrompt();
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
    const messages = await buildOracleMessages(state);
    const completion = await generateCompletion({
      maxTokens: cfg.maxTokens,
      model: MODEL_ALIASES[state.model],
      messages,
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

async function handleAskFlow(args: ParsedArgs, fragments: Fragment[]) {
  ensurePromptProvided(args.prompt);
  const entries = collectSelectedEntries(fragments, args.include, args.exclude);
  if (args.dryRun) {
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
    entries,
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

async function readPromptFromStdin(): Promise<string | undefined> {
  if (Deno.stdin.isTerminal()) return undefined;
  const raw = await new Response(Deno.stdin.readable).text();
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function appendStdinToPrompt(prompt: string, stdinText?: string): string {
  if (!stdinText) return prompt;
  const lines = countLines(stdinText);
  const chars = stdinText.length;
  if (lines > TOTAL_LINE_LIMIT || chars > TOTAL_CHAR_LIMIT) {
    throw new CliError(
      `Stdin content exceeds limits (${lines} lines, ${chars} chars; max ${TOTAL_LINE_LIMIT} lines or ${TOTAL_CHAR_LIMIT} chars).`,
    );
  }
  return `${prompt}\n\n<stdin>\n${stdinText}\n</stdin>`;
}

function buildTruncatedPreview(content: string): string {
  const preview = content.slice(0, DISPLAY_PREVIEW_CHARS);
  const ellipsis = content.length > DISPLAY_PREVIEW_CHARS ? "..." : "";
  return `${preview}${ellipsis} [content truncated]`;
}

function sanitizeUserPrompt(prompt: string): string {
  const replaceBlock = (
    input: string,
    regex: RegExp,
    builder: (attrs: string, inner: string) => string,
  ): string => {
    return input.replace(regex, (_match, attrs, inner) => builder(attrs ?? "", inner ?? ""));
  };

  let sanitized = replaceBlock(
    prompt,
    /<stdin([^>]*)>([\s\S]*?)<\/stdin>/gi,
    (attrs, inner) => `<stdin${attrs}>${buildTruncatedPreview(inner)}</stdin>`,
  );

  sanitized = replaceBlock(
    sanitized,
    /<file([^>]*)>([\s\S]*?)<\/file>/gi,
    (attrs, inner) => `<file${attrs}>${buildTruncatedPreview(inner)}</file>`,
  );

  return sanitized;
}

function printSessionHistory(state: SessionState) {
  printSessionId(state.id);
  console.log(`Model: ${state.model}`);
  console.log(`Status: ${state.status}${state.error ? ` (${state.error})` : ""}`);
  console.log(`Created: ${state.createdAt}`);
  console.log(`Updated: ${state.updatedAt}`);

  state.messages.forEach((message, index) => {
    console.log();
    console.log(`[${index + 1}] user @ ${message.createdAt}`);
    console.log(sanitizeUserPrompt(message.prompt));
    if (message.attachments.length > 0) {
      console.log("Attachments:");
      message.attachments.forEach((attachment) => {
        const lines = countLines(attachment.content);
        console.log(`- ${attachment.path} (${lines} lines, ${attachment.content.length} chars)`);
      });
    }
    if (message.response) {
      console.log();
      console.log(`assistant:`);
      console.log(message.response);
    }
  });
}

async function handleShowFlow(args: ParsedArgs) {
  if (!args.showId) throw new CliError("Missing session id for --show.");
  const state = await loadSession(args.showId);
  printSessionHistory(state);
}

function findAssistantResponses(state: SessionState): string[] {
  return state.messages
    .map((msg) => msg.response)
    .filter((response): response is string => !!response);
}

async function handleCopyFlow(args: ParsedArgs) {
  if (!args.copyId) throw new CliError("Missing session id for --copy.");
  const state = await loadSession(args.copyId);
  const responses = findAssistantResponses(state);
  if (responses.length === 0) {
    throw new CliError("No assistant responses found for this session.");
  }
  const index = args.copyResponseIndex ?? responses.length;
  if (index < 1 || index > responses.length) {
    throw new CliError(
      `Response index ${index} is out of range (1-${responses.length}).`,
    );
  }
  // Print only the selected response so piping to pbcopy grabs clean text.
  const selected = responses[index - 1];
  // Ensure trailing newline for pbcopy ergonomics.
  Deno.stdout.write(new TextEncoder().encode(selected + COPY_NEWLINE));
}

export async function runOracle(argv: string[]) {
  await loadEnv();
  const projectConfig = loadProjectConfig();
  const defaultModel = resolveDefaultModelAlias(projectConfig.oracle?.defaultModel);
  const parsed = parseArgs(argv, defaultModel);
  const fragments = resolveFragments(parsed.fragmentNames, projectConfig.oracle?.fragments);

  const shouldReadStdin = !parsed.waitId && !parsed.internalProcessId && !parsed.showId &&
    !parsed.copyId;
  if (shouldReadStdin) {
    const stdinPrompt = await readPromptFromStdin();
    if (stdinPrompt) {
      parsed.stdinText = stdinPrompt;
      if (!parsed.prompt) {
        parsed.prompt = stdinPrompt;
      }
    }
  }

  if (parsed.prompt && parsed.stdinText && parsed.prompt !== parsed.stdinText) {
    parsed.prompt = appendStdinToPrompt(parsed.prompt, parsed.stdinText);
  }

  validateIntent(parsed);

  if (parsed.internalProcessId) {
    await handleInternalProcess(parsed.internalProcessId);
    return;
  }

  if (parsed.copyId) {
    await handleCopyFlow(parsed);
    return;
  }

  if (parsed.showId) {
    await handleShowFlow(parsed);
    return;
  }

  if (parsed.waitId) {
    await handleWaitFlow(parsed);
    return;
  }

  await handleAskFlow(parsed, fragments);
}

if (import.meta.main) {
  runOracle(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
