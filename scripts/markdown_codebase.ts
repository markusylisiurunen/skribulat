import { estimateTokenCount } from "tokenx";
import {
  buildFilteredFileEntries,
  countLines,
  type FileEntry,
  renderDirectoryStructure,
  renderFileBlocks,
} from "../utils/codebase_snapshot.ts";
import { CliError, printCliError } from "../utils/errors.ts";

const textEncoder = new TextEncoder();

type ParsedArgs = {
  include: RegExp[];
  exclude: RegExp[];
  dryRun: boolean;
};

function usage() {
  console.log(
    [
      "Usage: skribulat markdown-codebase [options]",
      "",
      "Options:",
      "  -i, --include <pattern>   Regex for files to include (can be repeated)",
      "  -e, --exclude <pattern>   Regex for files to exclude (can be repeated)",
      "      --dry-run             List matching files with line/token counts instead of file contents",
      "  -h, --help                Show this help message",
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
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  return { include, exclude, dryRun };
}

async function printFileStats(entries: FileEntry[]) {
  type Stat = { path: string; lines: number; tokens: number };
  const stats: Stat[] = [];
  let totalTokens = 0;
  for (const entry of entries) {
    const content = await Deno.readTextFile(entry.absolutePath);
    const lines = countLines(content);
    const tokens = Math.round(estimateTokenCount(content));
    totalTokens += tokens;
    stats.push({ path: entry.cwdRelativePosix, lines, tokens });
  }
  if (stats.length === 0) {
    console.log("No git-visible files matched under the current directory.");
    return;
  }
  const maxPathLength = Math.max(...stats.map((stat) => stat.path.length));
  const maxLinesDigits = Math.max(...stats.map((stat) => stat.lines)).toString().length;
  const maxTokensDigits = Math.max(...stats.map((stat) => stat.tokens)).toString().length;

  for (const stat of stats) {
    const pathPadding = " ".repeat(maxPathLength - stat.path.length + 3);
    const linesText = `${stat.lines}`.padStart(maxLinesDigits);
    const tokensText = `${stat.tokens}`.padStart(maxTokensDigits);
    console.log(
      `${stat.path}${pathPadding}${linesText} lines   ${tokensText} tokens`,
    );
  }
  console.log();
  console.log(`Total estimated tokens: ~${totalTokens}`);
}

export async function runMarkdownCodebase(argv: string[]) {
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return;
  }
  const { include, exclude, dryRun } = parseArgs(argv);
  const entries = buildFilteredFileEntries({ include, exclude });
  if (entries.length === 0) {
    console.log("No git-visible files matched under the current directory.");
    return;
  }
  if (dryRun) {
    await printFileStats(entries);
    return;
  }
  console.log(renderDirectoryStructure(entries));
  await Deno.stdout.write(textEncoder.encode(await renderFileBlocks(entries)));
}

if (import.meta.main) {
  runMarkdownCodebase(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
