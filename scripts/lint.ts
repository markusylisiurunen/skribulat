import { estimateTokenCount } from "tokenx";
import { loadPrompt } from "../prompts/index.ts";
import {
  buildFilteredFileEntries,
  countLines,
  type FileEntry,
} from "../utils/codebase_snapshot.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { resolveDefaultBranch, resolveRepoRoot, runGitSync } from "../utils/git.ts";
import {
  type CompletionUsage,
  generateCompletionWithUsage,
  unwrapJsonFence,
} from "../utils/llm.ts";
import { type LintRuleConfig, loadProjectConfig } from "../utils/project_config.ts";

type ModelAlias = keyof typeof MODEL_ALIASES;

type ParsedArgs = {
  ruleNames: string[];
  include: RegExp[];
  exclude: RegExp[];
  model: ModelAlias;
  mode: "lint" | "rules";
  dryRun: boolean;
  changed: boolean;
  effort?: "none" | "minimal" | "low" | "medium" | "high";
};

type Rule = {
  name: string;
  description: string;
  include: RegExp[];
  exclude: RegExp[];
};

type FileWithRules = {
  entry: FileEntry;
  rules: Rule[];
};

type RuleStats = {
  name: string;
  description: string;
  files: number;
  totalLines: number;
  totalTokens: number;
  samplePaths: string[];
};

type Violation = {
  line: number;
  rule: string;
  message: string;
};

type LintResult = {
  path: string;
  violations: Violation[];
  usage: CompletionUsage;
};

const WORKER_POOL_SIZE = 16;

const MODEL_ALIASES = {
  "gpt-5-mini": "openai/gpt-5-mini",
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite-preview-09-2025",
  "gemini-2.5-flash": "google/gemini-2.5-flash-preview-09-2025",
  "claude-haiku-4.5": "anthropic/claude-haiku-4.5",
  "gpt-5.1": "openai/gpt-5.1",
} as const;

const MODEL_CONFIG: Record<
  ModelAlias,
  {
    maxTokens: number;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  }
> = {
  "gpt-5-mini": { maxTokens: 16384, reasoningEffort: "minimal" },
  "gemini-2.5-flash-lite": { maxTokens: 16384, reasoningEffort: "low" },
  "gemini-2.5-flash": { maxTokens: 16384, reasoningEffort: "low" },
  "claude-haiku-4.5": { maxTokens: 16384, reasoningEffort: "low" },
  "gpt-5.1": { maxTokens: 16384, reasoningEffort: "none" },
};

const DEFAULT_MODEL: ModelAlias = "gemini-2.5-flash-lite";

const PER_FILE_LINE_LIMIT = 5_000;
const PER_FILE_CHAR_LIMIT = 100_000;

function isModelAlias(value: string): value is ModelAlias {
  return value in MODEL_ALIASES;
}

function usage(defaultModel: ModelAlias) {
  console.log(
    [
      "Usage: skribulat lint [options]",
      "       skribulat lint rules",
      "",
      "Examples:",
      "  skribulat lint",
      "  skribulat lint --changed",
      "  skribulat lint -r no-console-log -r require-jsdoc",
      "  skribulat lint --dry-run",
      "  skribulat lint rules",
      "",
      "Options:",
      "  -r, --rule <name>      Run only specific rules (repeatable; defaults to all)",
      "  -i, --include <regex>  Additional file filter (repeatable)",
      "  -e, --exclude <regex>  Additional file exclusion (repeatable)",
      "      --changed          Only lint changed files (vs default branch + uncommitted; just uncommitted on main)",
      "      --dry-run          List files and matching rules without calling the model",
      `  -m, --model <alias>    Model alias: gpt-5-mini | gemini-2.5-flash-lite | gemini-2.5-flash | claude-haiku-4.5 | gpt-5.1 (default ${defaultModel})`,
      "      --effort <level>   Override reasoning effort: none | minimal | low | medium | high",
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

function getChangedFiles(repoRoot: string): Set<string> {
  const defaultBranch = resolveDefaultBranch(repoRoot);
  const currentBranch = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  const isOnDefaultBranch = currentBranch === defaultBranch;

  const changedPaths = new Set<string>();

  // Get uncommitted changes (staged + unstaged + untracked)
  const uncommittedDiff = runGitSync(["diff", "--name-only", "HEAD"], { cwd: repoRoot });
  const stagedDiff = runGitSync(["diff", "--name-only", "--cached"], { cwd: repoRoot });
  const untrackedFiles = runGitSync(["ls-files", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });

  for (const line of uncommittedDiff.split("\n").filter(Boolean)) changedPaths.add(line);
  for (const line of stagedDiff.split("\n").filter(Boolean)) changedPaths.add(line);
  for (const line of untrackedFiles.split("\n").filter(Boolean)) changedPaths.add(line);

  // If not on default branch, also include committed changes vs default branch
  if (!isOnDefaultBranch) {
    try {
      const branchDiff = runGitSync(
        ["diff", "--name-only", `origin/${defaultBranch}...HEAD`],
        { cwd: repoRoot },
      );
      for (const line of branchDiff.split("\n").filter(Boolean)) changedPaths.add(line);
    } catch {
      // Fallback if origin/defaultBranch doesn't exist
      try {
        const branchDiff = runGitSync(
          ["diff", "--name-only", `${defaultBranch}...HEAD`],
          { cwd: repoRoot },
        );
        for (const line of branchDiff.split("\n").filter(Boolean)) changedPaths.add(line);
      } catch {
        // If default branch comparison fails, just use uncommitted changes
      }
    }
  }

  return changedPaths;
}

function parseArgs(argv: readonly string[], defaultModel: ModelAlias): ParsedArgs {
  if (argv[0] === "rules") {
    if (argv.length > 1) {
      throw new CliError("`lint rules` does not accept additional arguments.");
    }
    return {
      ruleNames: [],
      include: [],
      exclude: [],
      model: defaultModel,
      mode: "rules",
      dryRun: false,
      changed: false,
      effort: undefined,
    };
  }

  const ruleNames: string[] = [];
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  let model: ModelAlias = defaultModel;
  let dryRun = false;
  let changed = false;
  let effort: ParsedArgs["effort"];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage(defaultModel);
      Deno.exit(0);
    }
    if (arg === "-r" || arg === "--rule") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} requires a value.`);
      ruleNames.push(value.trim());
      continue;
    }
    if (arg.startsWith("--rule=")) {
      const value = arg.slice("--rule=".length);
      if (!value) throw new CliError("--rule requires a value.");
      ruleNames.push(value.trim());
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
          "Invalid model alias. Allowed: gpt-5-mini, gemini-2.5-flash-lite, gemini-2.5-flash, claude-haiku-4.5, gpt-5.1.",
        );
      }
      model = value;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new CliError("--model requires a value.");
      if (!isModelAlias(value)) {
        throw new CliError(
          "Invalid model alias. Allowed: gpt-5-mini, gemini-2.5-flash-lite, gemini-2.5-flash, claude-haiku-4.5, gpt-5.1.",
        );
      }
      model = value;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--changed") {
      changed = true;
      continue;
    }
    if (arg === "--effort") {
      const value = argv[++i];
      if (!value) throw new CliError("--effort requires a value.");
      if (!["none", "minimal", "low", "medium", "high"].includes(value)) {
        throw new CliError(
          "Invalid effort level. Allowed: none, minimal, low, medium, high.",
        );
      }
      effort = value as typeof effort;
      continue;
    }
    if (arg.startsWith("--effort=")) {
      const value = arg.slice("--effort=".length);
      if (!value) throw new CliError("--effort requires a value.");
      if (!["none", "minimal", "low", "medium", "high"].includes(value)) {
        throw new CliError(
          "Invalid effort level. Allowed: none, minimal, low, medium, high.",
        );
      }
      effort = value as typeof effort;
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  return { ruleNames, include, exclude, model, mode: "lint", dryRun, changed, effort };
}

function resolveDefaultModelAlias(configModel?: string): ModelAlias {
  if (!configModel) return DEFAULT_MODEL;
  if (!isModelAlias(configModel)) {
    throw new CliError(
      `Invalid lint.default_model "${configModel}". Allowed: ${
        Object.keys(MODEL_ALIASES).join(", ")
      }`,
    );
  }
  return configModel;
}

function compileRuleConfig(config: LintRuleConfig): Rule {
  const include = config.include.map((pattern) => compileRegex(config.name, pattern));
  const exclude = (config.exclude ?? []).map((pattern) => compileRegex(config.name, pattern));
  return { name: config.name, description: config.description, include, exclude };
}

function resolveRules(
  ruleNames: string[],
  configured: LintRuleConfig[] | undefined,
): Rule[] {
  if (!configured || configured.length === 0) {
    throw new CliError(
      "No lint rules configured. Add rules under `lint.rules` in .skribulat/config.yaml.",
    );
  }

  const available = configured.map(compileRuleConfig);

  if (ruleNames.length === 0) {
    return available;
  }

  const byName = new Map(available.map((rule) => [rule.name, rule]));
  const selected: Rule[] = [];

  for (const name of ruleNames) {
    const rule = byName.get(name);
    if (!rule) {
      const known = available.map((r) => r.name).join(", ");
      throw new CliError(`Unknown rule "${name}". Known rules: ${known || "none"}.`);
    }
    selected.push(rule);
  }

  return selected;
}

function fileMatchesRule(path: string, rule: Rule): boolean {
  const included = rule.include.some((regex) => regex.test(path));
  if (!included) return false;
  const excluded = rule.exclude.some((regex) => regex.test(path));
  return !excluded;
}

function collectFilesWithRules(
  rules: Rule[],
  adHocInclude: RegExp[],
  adHocExclude: RegExp[],
  changedFiles?: Set<string>,
): FileWithRules[] {
  const repoRoot = resolveRepoRoot();

  const allIncludePatterns = rules.flatMap((r) => r.include);
  const entries = buildFilteredFileEntries({
    include: allIncludePatterns,
    exclude: [],
    cwd: repoRoot,
    repoRoot,
  });

  const filesWithRules: FileWithRules[] = [];

  for (const entry of entries) {
    const path = entry.cwdRelativePosix;

    // If --changed flag is set, skip files not in the changed set
    if (changedFiles && !changedFiles.has(path)) {
      continue;
    }

    if (adHocInclude.length > 0 && !adHocInclude.some((re) => re.test(path))) {
      continue;
    }
    if (adHocExclude.some((re) => re.test(path))) {
      continue;
    }

    const matchingRules = rules.filter((rule) => fileMatchesRule(path, rule));
    if (matchingRules.length > 0) {
      filesWithRules.push({ entry, rules: matchingRules });
    }
  }

  return filesWithRules.sort((a, b) =>
    a.entry.cwdRelativePosix.localeCompare(b.entry.cwdRelativePosix)
  );
}

async function buildSystemPrompt(): Promise<string> {
  const prompt = await loadPrompt("lint_system");
  return prompt.trim();
}

function buildUserPromptPrefix(rules: Rule[]): string {
  const parts = ["Rules to check:"];
  for (const rule of rules) {
    parts.push(`<rule name="${rule.name}">`);
    parts.push(rule.description.trim());
    parts.push("</rule>");
  }
  parts.push("");
  return parts.join("\n");
}

function buildUserPrompt(path: string, content: string, rules: Rule[]): string {
  const parts = [`File: ${path}`, ""];
  parts.push(buildUserPromptPrefix(rules));
  parts.push(`<file path="${path}">`);
  parts.push(content);
  parts.push("</file>");
  return parts.join("\n");
}

function computePrefixKey(rules: Rule[]): string {
  return rules.map((r) => r.name).sort().join("|");
}

async function lintFile(
  fileWithRules: FileWithRules,
  model: ModelAlias,
  systemPrompt: string,
  effort?: "none" | "minimal" | "low" | "medium" | "high",
): Promise<LintResult> {
  const { entry, rules } = fileWithRules;

  let content: string;
  try {
    content = await Deno.readTextFile(entry.absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to read ${entry.cwdRelativePosix}: ${message}`);
  }

  const lines = countLines(content);
  const chars = content.length;

  if (lines > PER_FILE_LINE_LIMIT || chars > PER_FILE_CHAR_LIMIT) {
    throw new CliError(
      `File ${entry.cwdRelativePosix} exceeds limits (${lines} lines, ${chars} chars; ` +
        `max ${PER_FILE_LINE_LIMIT} lines or ${PER_FILE_CHAR_LIMIT} chars).`,
    );
  }

  const cfg = MODEL_CONFIG[model];
  const result = await generateCompletionWithUsage({
    maxTokens: cfg.maxTokens,
    model: MODEL_ALIASES[model],
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserPrompt(entry.cwdRelativePosix, content, rules) },
    ],
    reasoningEffort: effort ?? cfg.reasoningEffort,
    responseFormat: { type: "json_object" },
  });

  let violations: Violation[] = [];
  try {
    const parsed = JSON.parse(unwrapJsonFence(result.content)) as { violations?: Violation[] };
    violations = parsed.violations ?? [];
  } catch {
    // If JSON parsing fails, treat as no violations
  }

  return { path: entry.cwdRelativePosix, violations, usage: result.usage };
}

async function describeRules(rules: Rule[]): Promise<RuleStats[]> {
  const repoRoot = resolveRepoRoot();
  const stats: RuleStats[] = [];

  for (const rule of rules) {
    const entries = buildFilteredFileEntries({
      include: rule.include,
      exclude: rule.exclude,
      cwd: repoRoot,
      repoRoot,
    });

    let totalLines = 0;
    let totalTokens = 0;

    for (const entry of entries) {
      try {
        const content = await Deno.readTextFile(entry.absolutePath);
        totalLines += countLines(content);
        totalTokens += Math.round(estimateTokenCount(content));
      } catch {
        continue;
      }
    }

    stats.push({
      name: rule.name,
      description: rule.description,
      files: entries.length,
      totalLines,
      totalTokens,
      samplePaths: entries.slice(0, 5).map((e) => e.cwdRelativePosix),
    });
  }

  return stats;
}

function printRuleStats(stats: RuleStats[]) {
  if (stats.length === 0) {
    console.log("No rules configured.");
    return;
  }
  for (const rule of stats) {
    console.log(`Rule: ${rule.name}`);
    console.log(`  description: ${rule.description}`);
    console.log(`  files: ${rule.files}`);
    console.log(`  lines: ${rule.totalLines}`);
    console.log(`  tokens: ~${rule.totalTokens}`);
    if (rule.samplePaths.length > 0) {
      console.log(`  sample: ${rule.samplePaths.join(", ")}`);
    }
    console.log("");
  }
}

async function printDryRun(filesWithRules: FileWithRules[]): Promise<void> {
  if (filesWithRules.length === 0) {
    console.log("No files match the configured rules.");
    return;
  }

  for (const { entry, rules } of filesWithRules) {
    let lines = 0;
    let tokens = 0;
    try {
      const content = await Deno.readTextFile(entry.absolutePath);
      lines = countLines(content);
      tokens = Math.round(estimateTokenCount(content));
    } catch {
      // skip
    }
    const ruleNames = rules.map((r) => r.name).join(", ");
    console.log(`${entry.cwdRelativePosix}  (${lines} lines, ~${tokens} tokens)`);
    console.log(`  rules: ${ruleNames}`);
  }
  console.log(`\nTotal: ${filesWithRules.length} files`);
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(5)}`;
  }
  return `$${cost.toFixed(3)}`;
}

type AggregatedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
};

async function processFilesWithWorkerPool(
  filesWithRules: FileWithRules[],
  model: ModelAlias,
  systemPrompt: string,
  effort?: "none" | "minimal" | "low" | "medium" | "high",
): Promise<{ results: LintResult[]; usage: AggregatedUsage }> {
  const results: LintResult[] = [];
  const total = filesWithRules.length;
  let completed = 0;
  const usage: AggregatedUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };

  const isTTY = Deno.stderr.isTerminal();

  const updateProgress = () => {
    if (!isTTY) return;
    const pct = Math.round((completed / total) * 100);
    Deno.stderr.writeSync(
      new TextEncoder().encode(`\rLinting: ${completed}/${total} files (${pct}%)`),
    );
  };

  const processItem = async (item: FileWithRules) => {
    const result = await lintFile(item, model, systemPrompt, effort);
    results.push(result);
    usage.inputTokens += result.usage.promptTokens;
    usage.cachedInputTokens += result.usage.cachedTokens;
    usage.outputTokens += result.usage.completionTokens;
    usage.cost += result.usage.cost;
    completed++;
    updateProgress();
  };

  updateProgress();

  // Track prefix states for cache warming
  const warmedPrefixes = new Set<string>();
  const warmingPrefixes = new Set<string>();
  const queue = [...filesWithRules];

  const tryPickItem = (): FileWithRules | undefined => {
    // First pass: prefer items from already-warmed prefixes
    for (let i = 0; i < queue.length; i++) {
      const key = computePrefixKey(queue[i].rules);
      if (warmedPrefixes.has(key)) {
        return queue.splice(i, 1)[0];
      }
    }
    // Second pass: pick item from a prefix not currently warming
    for (let i = 0; i < queue.length; i++) {
      const key = computePrefixKey(queue[i].rules);
      if (!warmingPrefixes.has(key)) {
        return queue.splice(i, 1)[0];
      }
    }
    return undefined;
  };

  const worker = async () => {
    while (queue.length > 0) {
      const item = tryPickItem();
      if (!item) {
        // All remaining items have prefixes currently warming; wait and retry
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      const key = computePrefixKey(item.rules);
      const isWarming = !warmedPrefixes.has(key);
      if (isWarming) warmingPrefixes.add(key);

      await processItem(item);

      if (isWarming) {
        warmingPrefixes.delete(key);
        warmedPrefixes.add(key);
      }
    }
  };

  const workers = Array.from({ length: WORKER_POOL_SIZE }, () => worker());
  await Promise.all(workers);

  if (isTTY) {
    Deno.stderr.writeSync(new TextEncoder().encode("\n"));
  }

  return { results, usage };
}

export async function runLint(argv: string[]) {
  try {
    const projectConfig = loadProjectConfig();
    const defaultModel = resolveDefaultModelAlias(projectConfig.lint?.defaultModel);
    const args = parseArgs(argv, defaultModel);

    const rules = resolveRules(args.ruleNames, projectConfig.lint?.rules);

    if (args.mode === "rules") {
      const stats = await describeRules(rules);
      printRuleStats(stats);
      return;
    }

    const changedFiles = args.changed ? getChangedFiles(resolveRepoRoot()) : undefined;
    const filesWithRules = collectFilesWithRules(rules, args.include, args.exclude, changedFiles);

    if (args.dryRun) {
      await printDryRun(filesWithRules);
      return;
    }

    if (filesWithRules.length === 0) {
      console.log("No files match the configured rules.");
      return;
    }

    console.log(`Linting ${filesWithRules.length} files with ${rules.length} rule(s)...\n`);

    const systemPrompt = await buildSystemPrompt();
    const { results, usage } = await processFilesWithWorkerPool(
      filesWithRules,
      args.model,
      systemPrompt,
      args.effort,
    );

    const allViolations = results
      .flatMap((r) => r.violations.map((v) => ({ path: r.path, ...v })))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

    const fileToViolations = new Map<string, Violation[]>();
    for (const v of allViolations) {
      const existing = fileToViolations.get(v.path) ?? [];
      existing.push({ line: v.line, rule: v.rule, message: v.message });
      fileToViolations.set(v.path, existing);
    }

    const fileCount = fileToViolations.size;

    if (fileCount > 0) {
      console.log("");
      for (const [path, violations] of fileToViolations.entries()) {
        console.log(path);
        for (const v of violations) {
          console.log(`  ${v.line}: ${v.rule}: ${v.message}`);
        }
        console.log("");
      }
    } else {
      console.log("\nNo violations found.\n");
    }

    const issueCount = allViolations.length;
    const summary = [
      `${issueCount} issue${issueCount !== 1 ? "s" : ""}, ${fileCount} file${
        fileCount !== 1 ? "s" : ""
      }`,
      `${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out`,
      formatCost(usage.cost),
    ].join(" | ");
    console.log(summary);
  } catch (error) {
    printCliError(error);
    Deno.exit(1);
  }
}
