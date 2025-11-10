import { join, relative, SEPARATOR } from "@std/path";
import * as posix from "@std/path/posix";
import { resolveRepoRoot, runGitSync } from "./git.ts";

export type FileEntry = {
  absolutePath: string;
  cwdRelativePath: string;
  cwdRelativePosix: string;
  directory: string;
  fileName: string;
};

type BuildEntriesOptions = {
  cwd?: string;
  exclude?: RegExp[];
  include?: RegExp[];
  repoRoot?: string;
};

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

function buildFileEntries(repoRoot: string, cwd: string): FileEntry[] {
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
      } satisfies FileEntry;
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

export function buildFilteredFileEntries(options: BuildEntriesOptions = {}): FileEntry[] {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const cwd = options.cwd ?? Deno.cwd();
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const entries = buildFileEntries(repoRoot, cwd);
  return filterEntries(entries, include, exclude);
}

export function renderDirectoryStructure(entries: FileEntry[]): string {
  if (entries.length === 0) return "";
  const byDirectory = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byDirectory.get(entry.directory) ?? [];
    list.push(entry.fileName);
    byDirectory.set(entry.directory, list);
  }
  const lines: string[] = ["## Directory structure", ""];
  for (
    const [directory, files] of Array.from(byDirectory.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  ) {
    files.sort((a, b) => a.localeCompare(b));
    lines.push(`${directory}: ${files.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

type FileBlockStats = {
  content: string;
  totalCharacters: number;
  totalLines: number;
};

export async function renderFileBlocks(entries: FileEntry[]): Promise<string> {
  return (await renderFileBlocksWithStats(entries)).content;
}

export async function renderFileBlocksWithStats(entries: FileEntry[]): Promise<FileBlockStats> {
  if (entries.length === 0) {
    return { content: "", totalCharacters: 0, totalLines: 0 };
  }
  let result = "## Files\n\n";
  let totalLines = 0;
  let totalCharacters = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const content = await Deno.readTextFile(entry.absolutePath);
    totalCharacters += content.length;
    totalLines += countLines(content);
    result += `<file path="${entry.cwdRelativePosix}">\n`;
    if (content.length > 0) {
      result += content;
      if (!content.endsWith("\n") && !content.endsWith("\r")) {
        result += "\n";
      }
    }
    result += "</file>";
    result += index === entries.length - 1 ? "\n" : "\n\n";
  }
  return { content: result, totalCharacters, totalLines };
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlineMatches = content.match(/\r\n|\n|\r/g);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  if (content.endsWith("\n") || content.endsWith("\r")) {
    return newlineCount;
  }
  return newlineCount + 1;
}
