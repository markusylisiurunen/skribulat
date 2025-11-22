import { estimateTokenCount } from "tokenx";
import {
  buildFilteredFileEntries,
  countLines,
  type FileEntry,
} from "../utils/codebase_snapshot.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { resolveRepoRoot } from "../utils/git.ts";
import { generateCompletion } from "../utils/llm.ts";
import { type GrepFragmentConfig, loadProjectConfig } from "../utils/project_config.ts";

type ModelAlias = keyof typeof MODEL_ALIASES;

type ParsedArgs = {
  prompt: string;
  fragmentNames: string[];
  model: ModelAlias;
  mode: "search" | "fragments";
  allFragments: boolean;
};

type Fragment = {
  name: string;
  include: RegExp[];
  exclude: RegExp[];
};

type Attachment = {
  path: string;
  content: string;
};

type FragmentStats = {
  name: string;
  files: number;
  totalLines: number;
  totalChars: number;
  totalTokens: number;
  samplePaths: string[];
};

const MODEL_ALIASES = {
  "gemini-3-pro": "google/gemini-3-pro-preview",
  "gemini-2.5-flash": "google/gemini-2.5-flash-preview-09-2025",
  "gpt-5.1": "openai/gpt-5.1",
  "qwen3-32b": "qwen/qwen3-32b",
} as const;

const MODEL_CONFIG: Record<
  ModelAlias,
  {
    maxTokens: number;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    provider?: { order?: string[]; allowFallbacks?: boolean };
  }
> = {
  "gemini-3-pro": {
    maxTokens: 8192,
    reasoningEffort: "low",
  },
  "gemini-2.5-flash": {
    maxTokens: 8192,
    reasoningEffort: "low",
  },
  "gpt-5.1": {
    maxTokens: 8192,
    reasoningEffort: "none",
  },
  "qwen3-32b": {
    maxTokens: 8192,
    provider: { order: ["cerebras", "groq"], allowFallbacks: false },
  },
};

const DEFAULT_MODEL: ModelAlias = "gemini-2.5-flash";

const PER_FILE_LINE_LIMIT = 5_000;
const PER_FILE_CHAR_LIMIT = 100_000;
const TOTAL_LINE_LIMIT = 50_000;
const TOTAL_CHAR_LIMIT = 1_000_000;

function usage() {
  console.log(
    [
      "Usage: skribulat grep [options]",
      "       skribulat grep fragments",
      "",
      "Examples:",
      '  skribulat grep -p "find all React components opening a dialog"',
      '  skribulat grep -f entity -f repository -p "which queries produce entity.User objects"',
      '  skribulat grep -a -p "search across all fragments"',
      "  skribulat grep fragments",
      "",
      "Options:",
      "  -p, --prompt <text>    Query to run against the codebase (required)",
      "  -f, --fragment <name>  Fragment to search (repeatable; defaults to all)",
      "  -a, --all-fragments    Search all fragments (ignores any -f flags)",
      "  -m, --model <alias>    Model alias: gemini-2.5-flash | gemini-3-pro | gpt-5.1 | qwen3-32b",
      "  -h, --help             Show this help message",
    ].join("\n"),
  );
}

function compileRegex(source: string, value: string): RegExp {
  try {
    return new RegExp(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid regex for ${source}: ${message}`);
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === "fragments") {
    if (argv.length > 1) {
      throw new CliError("`grep fragments` does not accept additional arguments.");
    }
    return {
      prompt: "",
      fragmentNames: [],
      model: DEFAULT_MODEL,
      mode: "fragments",
      allFragments: true,
    };
  }

  let prompt: string | undefined;
  const fragmentNames: string[] = [];
  let model: ModelAlias = DEFAULT_MODEL;
  let allFragments = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      Deno.exit(0);
    }
    if (arg === "-p" || arg === "--prompt") {
      prompt = argv[++i];
      if (!prompt) throw new CliError(`${arg} requires a value.`);
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      if (!prompt) throw new CliError("--prompt requires a value.");
      continue;
    }
    if (arg === "-f" || arg === "--fragment") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} requires a value.`);
      fragmentNames.push(value.trim());
      continue;
    }
    if (arg.startsWith("--fragment=")) {
      const value = arg.slice("--fragment=".length);
      if (!value) throw new CliError("--fragment requires a value.");
      fragmentNames.push(value.trim());
      continue;
    }
    if (arg === "-a" || arg === "--all-fragments") {
      allFragments = true;
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} requires a value.`);
      if (!(value in MODEL_ALIASES)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-2.5-flash, gemini-3-pro, gpt-5.1, qwen3-32b.",
        );
      }
      model = value as ModelAlias;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new CliError("--model requires a value.");
      if (!(value in MODEL_ALIASES)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-2.5-flash, gemini-3-pro, gpt-5.1, qwen3-32b.",
        );
      }
      model = value as ModelAlias;
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  if (!prompt || prompt.trim().length === 0) {
    usage();
    throw new CliError("Prompt (-p/--prompt) is required.");
  }

  return { prompt, fragmentNames, model, mode: "search", allFragments };
}

function buildDefaultFragments(): Fragment[] {
  return [{
    name: "all",
    include: [new RegExp(".*")],
    exclude: [],
  }];
}

function compileFragmentConfig(config: GrepFragmentConfig): Fragment | null {
  const include = config.include.map((pattern) => compileRegex(config.name, pattern));
  const exclude = (config.exclude ?? []).map((pattern) => compileRegex(config.name, pattern));
  if (include.length === 0) return null;
  return { name: config.name, include, exclude };
}

function resolveFragments(
  fragmentNames: string[],
  configured: GrepFragmentConfig[] | undefined,
  allFragments: boolean,
): Fragment[] {
  const available = (configured ?? []).map(compileFragmentConfig).filter(Boolean) as Fragment[];
  const fragments = available.length > 0 ? available : buildDefaultFragments();

  if (allFragments || fragmentNames.length === 0) {
    return fragments;
  }

  const byName = new Map(fragments.map((fragment) => [fragment.name, fragment]));
  const selected: Fragment[] = [];

  for (const name of fragmentNames) {
    const fragment = byName.get(name);
    if (!fragment) {
      const known = fragments.map((frag) => frag.name).join(", ");
      throw new CliError(`Unknown fragment "${name}". Known fragments: ${known || "none"}.`);
    }
    selected.push(fragment);
  }

  return selected;
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
    warnings.push(`Skipping ${entry.cwdRelativePosix}: file is not valid UTF-8 (possibly binary).`);
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

function buildSystemPrompt(): string {
  return [
    "You are a code grep assistant.",
    "Given files, return only concise findings that address the user's query.",
    "Answer with bullet points. Each bullet must cite a file path and include a short code excerpt or line reference.",
    "If nothing relevant is found, reply with 'No matches found.'",
  ].join(" ");
}

function buildUserPrompt(prompt: string, attachments: Attachment[]): string {
  const parts = [`Task: ${prompt}`];
  if (attachments.length > 0) {
    parts.push("Files:");
    for (const attachment of attachments) {
      parts.push(`<file path="${attachment.path}">\n${attachment.content}\n</file>`);
    }
  } else {
    parts.push("No files matched this fragment.");
  }
  return parts.join("\n\n");
}

async function searchFragment(
  prompt: string,
  fragment: Fragment,
  model: ModelAlias,
): Promise<{ name: string; response: string; warnings: string[] }> {
  const repoRoot = resolveRepoRoot();
  const entries = buildFilteredFileEntries({
    include: fragment.include,
    exclude: fragment.exclude,
    cwd: repoRoot,
    repoRoot,
  });

  if (entries.length === 0) {
    return {
      name: fragment.name,
      response: "No files matched this fragment.",
      warnings: [],
    };
  }

  const { attachments, warnings } = await collectAttachments(entries);
  const cfg = MODEL_CONFIG[model];
  const completion = await generateCompletion({
    maxTokens: cfg.maxTokens,
    model: MODEL_ALIASES[model],
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(prompt, attachments) },
    ],
    reasoningEffort: cfg.reasoningEffort,
    provider: cfg.provider,
  });

  return { name: fragment.name, response: completion.trim(), warnings };
}

async function describeFragments(fragments: Fragment[]): Promise<FragmentStats[]> {
  const stats: FragmentStats[] = [];
  for (const fragment of fragments) {
    const repoRoot = resolveRepoRoot();
    const entries = buildFilteredFileEntries({
      include: fragment.include,
      exclude: fragment.exclude,
      cwd: repoRoot,
      repoRoot,
    });
    let totalLines = 0;
    let totalChars = 0;
    let totalTokens = 0;
    for (const entry of entries) {
      try {
        const content = await Deno.readTextFile(entry.absolutePath);
        totalLines += countLines(content);
        totalChars += content.length;
        if (totalLines > TOTAL_LINE_LIMIT || totalChars > TOTAL_CHAR_LIMIT) {
          throw new CliError(
            `Fragment "${fragment.name}" exceeds limits (${totalLines} lines, ${totalChars} chars; ` +
              `max ${TOTAL_LINE_LIMIT} lines or ${TOTAL_CHAR_LIMIT} chars).`,
          );
        }
        totalTokens += Math.round(estimateTokenCount(content));
      } catch (_error) {
        // If a file vanishes during read, skip it to keep stats resilient.
        continue;
      }
    }
    stats.push({
      name: fragment.name,
      files: entries.length,
      totalLines,
      totalChars,
      totalTokens,
      samplePaths: entries.slice(0, 5).map((entry) => entry.cwdRelativePosix),
    });
  }
  return stats;
}

function printFragmentStats(stats: FragmentStats[]) {
  if (stats.length === 0) {
    console.log("No fragments found.");
    return;
  }
  for (const fragment of stats) {
    console.log(`Fragment: ${fragment.name}`);
    console.log(`  files: ${fragment.files}`);
    console.log(`  lines: ${fragment.totalLines}`);
    console.log(`  chars: ${fragment.totalChars}`);
    console.log(`  tokens: ~${fragment.totalTokens}`);
    if (fragment.samplePaths.length > 0) {
      console.log(`  sample: ${fragment.samplePaths.join(", ")}`);
    }
    console.log("");
  }
}

export async function runGrep(argv: string[]) {
  try {
    const args = parseArgs(argv);
    const projectConfig = loadProjectConfig();
    const fragments = resolveFragments(
      args.fragmentNames,
      projectConfig.grep?.fragments,
      args.allFragments,
    );

    if (args.mode === "fragments") {
      const stats = await describeFragments(fragments);
      printFragmentStats(stats);
      return;
    }

    const results = await Promise.all(
      fragments.map((fragment) => searchFragment(args.prompt, fragment, args.model)),
    );

    for (const result of results) {
      console.log(`== ${result.name} ==`);
      console.log(result.response);
      if (result.warnings.length > 0) {
        console.warn(result.warnings.join("\n"));
      }
      console.log("");
    }
  } catch (error) {
    printCliError(error);
    Deno.exit(1);
  }
}
