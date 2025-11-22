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
  include: RegExp[];
  exclude: RegExp[];
  model: ModelAlias;
  mode: "search" | "fragments";
  allFragments: boolean;
};

type Fragment = {
  name: string;
  include: RegExp[];
  exclude: RegExp[];
  splits?: FragmentSplit[];
};

type FragmentSplit = {
  name: string;
  include: RegExp[];
  exclude: RegExp[];
};

type Attachment = {
  path: string;
  content: string;
  lines: number;
  chars: number;
};

type FragmentStats = {
  name: string;
  files: number;
  totalLines: number;
  totalChars: number;
  totalTokens: number;
  samplePaths: string[];
  splits: number;
  splitNames: string[];
  splitDetails: {
    name: string;
    files: number;
    lines: number;
    chars: number;
  }[];
};

const MODEL_ALIASES = {
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite-preview-09-2025",
  "gemini-2.5-flash": "google/gemini-2.5-flash-preview-09-2025",
  "gemini-3-pro": "google/gemini-3-pro-preview",
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
  "gemini-2.5-flash-lite": {
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

const DEFAULT_MODEL: ModelAlias = "gemini-2.5-flash-lite";

const PER_FILE_LINE_LIMIT = 5_000;
const PER_FILE_CHAR_LIMIT = 100_000;
const TOTAL_LINE_LIMIT = 50_000;
const TOTAL_CHAR_LIMIT = 1_000_000;

function isModelAlias(value: string): value is ModelAlias {
  return value in MODEL_ALIASES;
}

function usage(defaultModel: ModelAlias) {
  console.log(
    [
      "Usage: skribulat grep [options]",
      "       skribulat grep fragments",
      "",
      "Examples:",
      '  skribulat grep -p "find all React components opening a dialog"',
      '  skribulat grep -f entity -f repository -p "which queries produce entity.User objects"',
      '  skribulat grep -a -p "search across all fragments"',
      `  skribulat grep -i '^src/.+\\.ts' -e '\\.test\\.ts$' -p "inspect services"`,
      "  skribulat grep fragments",
      "",
      "Options:",
      "  -p, --prompt <text>    Query to run against the codebase (required)",
      "  -f, --fragment <name>  Fragment to search (repeatable; defaults to all)",
      "  -a, --all-fragments    Search all fragments (ignores any -f flags)",
      "  -i, --include <regex>  Regex for files to include (repeatable; conflicts with -f/-a)",
      "  -e, --exclude <regex>  Regex for files to exclude (repeatable; conflicts with -f/-a)",
      `  -m, --model <alias>    Model alias: gemini-2.5-flash-lite | gemini-2.5-flash | gemini-3-pro | gpt-5.1 | qwen3-32b (default ${defaultModel})`,
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

function parseArgs(argv: readonly string[], defaultModel: ModelAlias): ParsedArgs {
  if (argv[0] === "fragments") {
    if (argv.length > 1) {
      throw new CliError("`grep fragments` does not accept additional arguments.");
    }
    return {
      prompt: "",
      fragmentNames: [],
      include: [],
      exclude: [],
      model: defaultModel,
      mode: "fragments",
      allFragments: true,
    };
  }

  let prompt: string | undefined;
  const fragmentNames: string[] = [];
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  let model: ModelAlias = defaultModel;
  let allFragments = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage(defaultModel);
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
    if (arg === "-i" || arg === "--include") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} requires a value.`);
      include.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--include=")) {
      const pattern = arg.slice("--include=".length);
      if (!pattern) throw new CliError("--include requires a value.");
      include.push(compileRegex("--include", pattern));
      continue;
    }
    if (arg === "-e" || arg === "--exclude") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} requires a value.`);
      exclude.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      const pattern = arg.slice("--exclude=".length);
      if (!pattern) throw new CliError("--exclude requires a value.");
      exclude.push(compileRegex("--exclude", pattern));
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} requires a value.`);
      if (!isModelAlias(value)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-pro, gpt-5.1, qwen3-32b.",
        );
      }
      model = value as ModelAlias;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new CliError("--model requires a value.");
      if (!isModelAlias(value)) {
        throw new CliError(
          "Invalid model alias. Allowed: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-pro, gpt-5.1, qwen3-32b.",
        );
      }
      model = value as ModelAlias;
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  if (!prompt || prompt.trim().length === 0) {
    usage(defaultModel);
    throw new CliError("Prompt (-p/--prompt) is required.");
  }

  return { prompt, fragmentNames, include, exclude, model, mode: "search", allFragments };
}

function resolveDefaultModelAlias(configModel?: string): ModelAlias {
  if (!configModel) return DEFAULT_MODEL;
  if (!isModelAlias(configModel)) {
    throw new CliError(
      `Invalid grep.default_model "${configModel}". Allowed: ${
        Object.keys(MODEL_ALIASES).join(", ")
      }`,
    );
  }
  return configModel;
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
  const splits = (config.splits ?? [])
    .map((split, index): FragmentSplit | null => {
      const splitInclude = (split.include ?? []).map((pattern) =>
        compileRegex(split.name || `${config.name}-split-${index + 1}`, pattern)
      );
      if (splitInclude.length === 0) return null;
      const splitExclude = (split.exclude ?? []).map((pattern) =>
        compileRegex(split.name || `${config.name}-split-${index + 1}`, pattern)
      );
      return {
        name: split.name || `split-${index + 1}`,
        include: splitInclude,
        exclude: splitExclude,
      };
    })
    .filter(Boolean) as FragmentSplit[];
  if (include.length === 0) return null;
  return { name: config.name, include, exclude, splits: splits.length > 0 ? splits : undefined };
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
    attachments.push({
      path: entry.cwdRelativePosix,
      content: decoded.content,
      lines: decoded.lines,
      chars: decoded.chars,
    });
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
  entriesOverride?: FileEntry[],
): Promise<{ name: string; response: string; warnings: string[] }> {
  const repoRoot = resolveRepoRoot();
  const entries = entriesOverride ??
    buildFilteredFileEntries({
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

  const cfg = MODEL_CONFIG[model];
  // When no splits are configured, process the fragment as a single batch.
  if (!fragment.splits || fragment.splits.length === 0) {
    const { attachments, warnings } = await collectAttachments(entries);
    if (attachments.length === 0) {
      return { name: fragment.name, response: "No files matched this fragment.", warnings };
    }
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

  // Manual splits: process each split's matching files separately.
  const warnings: string[] = [];
  const used = new Set<string>();
  const splitJobs: { label: string; attachments: Attachment[] }[] = [];

  for (const [index, split] of fragment.splits.entries()) {
    const matches = entries.filter((entry) => {
      if (used.has(entry.cwdRelativePosix)) return false;
      const inSplit = split.include.some((regex) => regex.test(entry.cwdRelativePosix));
      const excluded = split.exclude.some((regex) => regex.test(entry.cwdRelativePosix));
      return inSplit && !excluded;
    });

    matches.forEach((entry) => used.add(entry.cwdRelativePosix));

    const { attachments, warnings: splitWarnings } = await collectAttachments(matches);
    warnings.push(...splitWarnings);

    const label = split.name || `split-${index + 1}`;
    splitJobs.push({ label, attachments });
  }

  const remaining = entries.filter((entry) => !used.has(entry.cwdRelativePosix));
  if (remaining.length > 0) {
    const { attachments, warnings: splitWarnings } = await collectAttachments(remaining);
    warnings.push(...splitWarnings);
    splitJobs.push({ label: "remainder", attachments });
  }

  const completionResults = await Promise.all(
    splitJobs.map(async (job) => {
      if (job.attachments.length === 0) {
        return `Split ${job.label}: No files matched this split.`;
      }
      const completion = await generateCompletion({
        maxTokens: cfg.maxTokens,
        model: MODEL_ALIASES[model],
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(prompt, job.attachments) },
        ],
        reasoningEffort: cfg.reasoningEffort,
        provider: cfg.provider,
      });
      return `Split ${job.label}:\n${completion.trim()}`;
    }),
  );

  const response = completionResults.length > 0
    ? completionResults.join("\n\n")
    : "No files matched any configured split for this fragment.";
  return { name: fragment.name, response, warnings };
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
    const perFile: Record<string, { lines: number; chars: number }> = {};
    for (const entry of entries) {
      try {
        const content = await Deno.readTextFile(entry.absolutePath);
        const lines = countLines(content);
        const chars = content.length;
        perFile[entry.cwdRelativePosix] = { lines, chars };
        totalLines += lines;
        totalChars += chars;
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

    const splitDetails: {
      name: string;
      files: number;
      lines: number;
      chars: number;
    }[] = [];
    const used = new Set<string>();
    if (fragment.splits && fragment.splits.length > 0) {
      fragment.splits.forEach((split, index) => {
        const matches = entries.filter((entry) => {
          if (used.has(entry.cwdRelativePosix)) return false;
          const inSplit = split.include.some((regex) => regex.test(entry.cwdRelativePosix));
          const excluded = split.exclude.some((regex) => regex.test(entry.cwdRelativePosix));
          return inSplit && !excluded;
        });
        matches.forEach((entry) => used.add(entry.cwdRelativePosix));
        const stats = matches.reduce(
          (acc, entry) => {
            const info = perFile[entry.cwdRelativePosix];
            if (info) {
              acc.lines += info.lines;
              acc.chars += info.chars;
            }
            acc.files += 1;
            return acc;
          },
          { files: 0, lines: 0, chars: 0 },
        );
        splitDetails.push({
          name: split.name || `split-${index + 1}`,
          ...stats,
        });
      });
      // remainder bucket
      const remainder = entries.filter((entry) => !used.has(entry.cwdRelativePosix));
      if (remainder.length > 0) {
        const stats = remainder.reduce(
          (acc, entry) => {
            const info = perFile[entry.cwdRelativePosix];
            if (info) {
              acc.lines += info.lines;
              acc.chars += info.chars;
            }
            acc.files += 1;
            return acc;
          },
          { files: 0, lines: 0, chars: 0 },
        );
        splitDetails.push({
          name: "remainder",
          ...stats,
        });
      }
    }

    stats.push({
      name: fragment.name,
      files: entries.length,
      totalLines,
      totalChars,
      totalTokens,
      samplePaths: entries.slice(0, 5).map((entry) => entry.cwdRelativePosix),
      splits: fragment.splits?.length ?? 0,
      splitNames: fragment.splits?.map((split) => split.name) ?? [],
      splitDetails,
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
    if (fragment.splits > 0) {
      console.log("  splits:");
      fragment.splitDetails.forEach((split) => {
        console.log(
          `    - ${split.name}: files=${split.files}, lines=${split.lines}, chars=${split.chars}`,
        );
      });
    }
    if (fragment.samplePaths.length > 0) {
      console.log(`  sample: ${fragment.samplePaths.join(", ")}`);
    }
    console.log("");
  }
}

export async function runGrep(argv: string[]) {
  try {
    const projectConfig = loadProjectConfig();
    const defaultModel = resolveDefaultModelAlias(projectConfig.grep?.defaultModel);
    const args = parseArgs(argv, defaultModel);
    const adHocPatternsProvided = args.include.length > 0 || args.exclude.length > 0;

    if (adHocPatternsProvided && (args.fragmentNames.length > 0 || args.allFragments)) {
      throw new CliError(
        "Choose fragments (-f/--fragment or -a/--all-fragments) OR ad-hoc filters (-i/-e), not both.",
      );
    }

    const repoRoot = resolveRepoRoot();

    const searchTargets = adHocPatternsProvided
      ? [{
        fragment: {
          name: "ad-hoc",
          include: args.include,
          exclude: args.exclude,
        } satisfies Fragment,
        entries: args.include.length === 0 ? [] : buildFilteredFileEntries({
          include: args.include,
          exclude: args.exclude,
          cwd: repoRoot,
          repoRoot,
        }),
      }]
      : resolveFragments(
        args.fragmentNames,
        projectConfig.grep?.fragments,
        args.allFragments,
      ).map((fragment) => ({ fragment, entries: undefined as FileEntry[] | undefined }));

    if (args.mode === "fragments") {
      const stats = await describeFragments(
        searchTargets.map((target) => target.fragment),
      );
      printFragmentStats(stats);
      return;
    }

    const results = await Promise.all(
      searchTargets.map((target) =>
        searchFragment(args.prompt, target.fragment, args.model, target.entries)
      ),
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
