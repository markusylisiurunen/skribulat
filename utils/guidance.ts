import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";
import { runCommand } from "./process.ts";
import { loadPrompt } from "./prompts.ts";

const AGENTS_FILE_NAME = "AGENTS.md";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

async function discoverAgentsFiles(
  repoRoot: string,
  directories: ReadonlySet<string>,
): Promise<string[]> {
  const discovered = new Set<string>();
  for (const directory of directories) {
    const absoluteDirectory = join(repoRoot, directory);
    let directoryStat: Deno.FileInfo;
    try {
      directoryStat = await Deno.stat(absoluteDirectory);
    } catch {
      continue;
    }
    if (!directoryStat.isDirectory) continue;
    for await (
      const entry of walk(absoluteDirectory, {
        followSymlinks: false,
        includeDirs: false,
      })
    ) {
      if (!entry.isFile || entry.name !== AGENTS_FILE_NAME) continue;
      discovered.add(entry.path);
    }
  }
  return Array.from(discovered).sort((a, b) =>
    relative(repoRoot, a).localeCompare(relative(repoRoot, b))
  );
}

export type AgentsGuidanceOptions = {
  labels: readonly string[];
  repoRoot: string;
};

export type AgentsDirectoryMap = Record<string, string[]>;

export type AgentsGuidanceConfig = {
  directoryMap?: AgentsDirectoryMap;
};

export async function listAllAgentsFiles(repoRoot: string): Promise<string[]> {
  const command = "rg --files | rg 'AGENTS\\.md$' | sort";
  const { stdout } = await runCommand("sh", ["-c", command], {
    allowFailure: true,
    cwd: repoRoot,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function formatAgentsGuidance(
  { labels, repoRoot }: AgentsGuidanceOptions,
  config: AgentsGuidanceConfig = {},
): Promise<string> {
  const relevantDirectories = new Set<string>();
  const map = config.directoryMap ?? {};
  for (const label of labels) {
    if (!label) continue;
    const normalized = normalizeLabel(label);
    const mapped = map[normalized] ?? map[label] ?? [];
    for (const directory of mapped) {
      if (directory) {
        relevantDirectories.add(directory);
      }
    }
  }
  const agentsFiles = await discoverAgentsFiles(repoRoot, relevantDirectories);
  if (agentsFiles.length === 0) return "";
  const sections: string[] = [];
  for (const absolutePath of agentsFiles) {
    const relativePath = relative(repoRoot, absolutePath) || AGENTS_FILE_NAME;
    const content = (await Deno.readTextFile(absolutePath)).trim();
    sections.push(`<agents_file path="${relativePath}">\n${content}\n</agents_file>`);
  }
  return `<agents_guidance>\n${sections.join("\n")}\n</agents_guidance>`;
}

export async function instructEfficientToolUse(override?: string): Promise<string> {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const prompt = await loadPrompt("tool_use_guidance.txt");
  return prompt.trim();
}

export async function explainIssueLabels(override?: string): Promise<string> {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const prompt = await loadPrompt("label_guidance.txt");
  return prompt.trim();
}
