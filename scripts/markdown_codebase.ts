import { join, relative, SEPARATOR } from "@std/path";
import * as posix from "@std/path/posix";
import { CliError, printCliError } from "../utils/errors.ts";
import { resolveRepoRoot, runGitSync } from "../utils/git.ts";
import { estimateTokenCount } from "tokenx";

type ParsedArgs = {
  include: RegExp[];
  exclude: RegExp[];
  statsOnly: boolean;
};

type FileEntry = {
  absolutePath: string;
  cwdRelativePath: string;
  cwdRelativePosix: string;
  directory: string;
  fileName: string;
};

const textEncoder = new TextEncoder();

function usage() {
  console.log(
    [
      "Usage: skribulat markdown-codebase [options]",
      "",
      "Options:",
      "  -i, --include <pattern>   Regex for files to include (can be repeated)",
      "  -e, --exclude <pattern>   Regex for files to exclude (can be repeated)",
      "      --stats               Print line/character counts instead of file contents",
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
  let statsOnly = false;

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
    if (arg === "--stats") {
      statsOnly = true;
      continue;
    }
    throw new CliError(`Unknown argument: ${arg}`);
  }

  return { include, exclude, statsOnly };
}

function toPosixPath(value: string): string {
  return value.split(SEPARATOR).join("/");
}

function isWithinCwd(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") {
    return false;
  }
  const parts = relativePath.split(SEPARATOR);
  return parts.every((segment) => segment !== "..");
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function collectTrackedFiles(repoRoot: string): string[] {
  const trackedRaw = runGitSync(["ls-files"], { cwd: repoRoot });
  if (!trackedRaw) return [];
  return trackedRaw.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function buildFileEntries(repoRoot: string): FileEntry[] {
  const cwd = Deno.cwd();
  return collectTrackedFiles(repoRoot)
    .map((repoRelativePath) => {
      const absolutePath = join(repoRoot, repoRelativePath);
      const cwdRelativePath = relative(cwd, absolutePath);
      return { absolutePath, cwdRelativePath };
    })
    .filter((entry) => isWithinCwd(entry.cwdRelativePath))
    .map((entry) => {
      const cwdRelativePosix = toPosixPath(entry.cwdRelativePath);
      const directoryRaw = posix.dirname(cwdRelativePosix);
      const directory = directoryRaw === "." ? "." : directoryRaw;
      return {
        absolutePath: entry.absolutePath,
        cwdRelativePath: entry.cwdRelativePath,
        cwdRelativePosix,
        directory,
        fileName: posix.basename(cwdRelativePosix),
      };
    })
    .sort((a, b) => a.cwdRelativePosix.localeCompare(b.cwdRelativePosix));
}

function filterEntries(entries: FileEntry[], include: RegExp[], exclude: RegExp[]): FileEntry[] {
  return entries.filter((entry) => {
    const path = entry.cwdRelativePosix;
    if (include.length > 0 && !matchesAny(path, include)) {
      return false;
    }
    if (exclude.length > 0 && matchesAny(path, exclude)) {
      return false;
    }
    return true;
  });
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlineMatches = content.match(/\r\n|\n|\r/g);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  if (content.endsWith("\n") || content.endsWith("\r")) {
    return newlineCount;
  }
  return newlineCount + 1;
}

function printDirectoryStructure(entries: FileEntry[]) {
  console.log("## Directory structure\n");
  const byDirectory = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byDirectory.get(entry.directory) ?? [];
    list.push(entry.fileName);
    byDirectory.set(entry.directory, list);
  }
  for (
    const [directory, files] of Array.from(byDirectory.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  ) {
    files.sort((a, b) => a.localeCompare(b));
    console.log(`${directory}: ${files.join(", ")}`);
  }
  console.log();
}

async function printFileContents(entries: FileEntry[]) {
  await Deno.stdout.write(textEncoder.encode("## Files\n\n"));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const content = await Deno.readTextFile(entry.absolutePath);
    await Deno.stdout.write(textEncoder.encode(`<file path="${entry.cwdRelativePosix}">\n`));
    if (content.length > 0) {
      await Deno.stdout.write(textEncoder.encode(content));
      if (!content.endsWith("\n") && !content.endsWith("\r")) {
        await Deno.stdout.write(textEncoder.encode("\n"));
      }
    }
    await Deno.stdout.write(textEncoder.encode("</file>"));
    const suffix = index === entries.length - 1 ? "\n" : "\n\n";
    await Deno.stdout.write(textEncoder.encode(suffix));
  }
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
    console.log("No git-tracked files matched under the current directory.");
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
  const { include, exclude, statsOnly } = parseArgs(argv);
  const repoRoot = resolveRepoRoot();
  const entries = filterEntries(buildFileEntries(repoRoot), include, exclude);
  if (entries.length === 0) {
    console.log("No git-tracked files matched under the current directory.");
    return;
  }
  if (statsOnly) {
    await printFileStats(entries);
    return;
  }
  printDirectoryStructure(entries);
  await printFileContents(entries);
}

if (import.meta.main) {
  runMarkdownCodebase(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
