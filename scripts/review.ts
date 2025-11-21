import { join, relative } from "@std/path";
import { estimateTokenCount } from "tokenx";
import { buildFilteredFileEntries, countLines } from "../utils/codebase_snapshot.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { resolveRepoRoot } from "../utils/git.ts";
import { loadPrompt, renderPrompt } from "../utils/prompts.ts";

type ParsedArgs = {
  include: RegExp[];
  exclude: RegExp[];
  dryRun: boolean;
};

function usage() {
  console.log(
    [
      "Usage: skribulat review [options]",
      "",
      "Reads git diff from stdin and generates a code review prompt.",
      "",
      "Options:",
      "  -i, --include <pattern>  Regex for files to include (can be repeated)",
      "  -e, --exclude <pattern>  Regex for files to exclude (can be repeated)",
      "      --dry-run            Show files that would be included without generating the prompt",
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

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

function parseFilesFromDiff(diff: string): Set<string> {
  const files = new Set<string>();
  // match "diff --git a/path b/path"
  const regex = /^diff --git a\/.* b\/(.*)$/gm;
  let match;
  while ((match = regex.exec(diff)) !== null) {
    if (match[1]) {
      files.add(match[1]);
    }
  }
  return files;
}

async function getFileContent(repoRoot: string, filePath: string): Promise<string | null> {
  try {
    // resolve path relative to repo root
    const fullPath = `${repoRoot}/${filePath}`;
    const stat = await Deno.stat(fullPath);
    if (!stat.isFile) return null;
    const content = await Deno.readTextFile(fullPath);
    return `<file path="${filePath}">\n${content}\n</file>`;
  } catch {
    // file might be deleted or not accessible
    return null;
  }
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

export async function runReview(argv: string[]) {
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return;
  }

  const { include, exclude, dryRun } = parseArgs(argv);

  // check if stdin is tty, and if so, warn or show usage?
  if (Deno.stdin.isTerminal()) {
    console.error("Error: No input provided. Pipe a git diff into this command.");
    console.error("Example: git diff main | skribulat review");
    Deno.exit(1);
  }

  const diff = await readStdin();
  if (!diff.trim()) {
    console.error("Error: Empty diff received.");
    Deno.exit(1);
  }

  const repoRoot = resolveRepoRoot();
  const cwd = Deno.cwd();

  const diffFiles = parseFilesFromDiff(diff);
  const includeFiles = new Set<string>();
  const allCandidates = new Set<string>(diffFiles);

  // if include flags are present, search the codebase for matching files and add them
  if (include.length > 0) {
    const extraEntries = buildFilteredFileEntries({ include });
    for (const entry of extraEntries) {
      const repoRelative = relative(repoRoot, entry.absolutePath);
      includeFiles.add(repoRelative);
      allCandidates.add(repoRelative);
    }
  }

  const finalFiles: string[] = [];
  const excludedFiles: string[] = [];

  for (const file of allCandidates) {
    // check exclusion
    if (exclude.length > 0) {
      const absolutePath = join(repoRoot, file);
      const cwdRelative = relative(cwd, absolutePath);
      const cwdRelativePosix = cwdRelative.replaceAll("\\", "/");
      if (matchesAny(cwdRelativePosix, exclude)) {
        excludedFiles.push(file);
        continue;
      }
    }
    finalFiles.push(file);
  }

  // sort for consistent output
  finalFiles.sort();
  excludedFiles.sort();

  if (dryRun) {
    console.log(`Git diff size: ${diff.length} characters\n`);

    if (diffFiles.size > 0) {
      console.log("Files from git diff:");
      Array.from(diffFiles).sort().forEach((f) => console.log(`  ${f}`));
      console.log("");
    }

    if (includeFiles.size > 0) {
      console.log("Files matched by --include:");
      Array.from(includeFiles).sort().forEach((f) => console.log(`  ${f}`));
      console.log("");
    }

    if (excludedFiles.length > 0) {
      console.log("Files excluded by --exclude:");
      excludedFiles.forEach((f) => console.log(`  ${f}`));
      console.log("");
    }

    console.log("Final files for prompt context:");
    let totalTokens = 0;

    if (finalFiles.length === 0) {
      console.log("  (None)");
    } else {
      for (const file of finalFiles) {
        try {
          const fullPath = join(repoRoot, file);
          const content = await Deno.readTextFile(fullPath);
          const lines = countLines(content);
          const tokens = Math.round(estimateTokenCount(content));
          totalTokens += tokens;
          console.log(
            `  ${file.padEnd(40)} ${lines.toString().padStart(5)} lines  ${
              tokens.toString().padStart(6)
            } tokens`,
          );
        } catch {
          console.log(`  ${file.padEnd(40)} (deleted or inaccessible)`);
        }
      }
    }

    console.log(`\nTotal estimated tokens from files: ~${totalTokens}`);
    return;
  }

  const fileContents: string[] = [];
  for (const file of finalFiles) {
    const content = await getFileContent(repoRoot, file);
    if (content) {
      fileContents.push(content);
    }
  }

  const template = await loadPrompt("review_user.txt");
  const prompt = renderPrompt(template, {
    DIFF: diff,
    FILES: fileContents.join("\n\n"),
  });

  console.log(prompt);
}

if (import.meta.main) {
  runReview(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
