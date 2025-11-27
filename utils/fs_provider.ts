import { isAbsolute, join } from "@std/path";
import {
  Issue,
  IssueBackendKind,
  IssueComment,
  IssueProvider,
  IssueSummary,
} from "./issue_provider.ts";

type Frontmatter = {
  title: string;
  labels: string[];
  status?: string;
  created?: string;
  updated?: string;
  url?: string;
};

function parseFrontmatter(contents: string): { meta: Frontmatter; body: string } {
  const trimmed = contents.trimStart();
  if (!trimmed.startsWith("---\n")) {
    return { meta: { title: "", labels: [] }, body: contents.trim() };
  }
  const end = trimmed.indexOf("\n---", 4);
  if (end === -1) {
    return { meta: { title: "", labels: [] }, body: contents.trim() };
  }
  const yamlBlock = trimmed.slice(4, end);
  const body = trimmed.slice(end + 4).trim();
  const meta: Frontmatter = { title: "", labels: [] };
  for (const line of yamlBlock.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim();
    const value = rest.join(":").trim();
    if (key === "title") meta.title = value;
    if (key === "status") meta.status = value;
    if (key === "created") meta.created = value;
    if (key === "updated") meta.updated = value;
    if (key === "url") meta.url = value;
    if (key === "labels") {
      const matches = value.match(/\[(.*)\]/);
      if (matches && matches[1]) {
        meta.labels = matches[1].split(",").map((item) => item.trim()).filter((item) => item);
      }
    }
  }
  return { meta, body };
}

function serializeComment(timestamp: string, body: string): string {
  return `\n\n---\n**Comment** (${timestamp}):\n${body}\n`;
}

function parseComments(body: string): { description: string; comments: IssueComment[] } {
  const commentPattern =
    /\n---\n\*\*Comment\*\* \(([^)]+)\):\n([\s\S]*?)(?=\n---\n\*\*Comment\*\* |$)/g;
  const comments: IssueComment[] = [];
  let description = body.trim();
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(body)) !== null) {
    const [, timestamp, commentBody] = match;
    const start = match.index;
    if (start === 0) {
      description = body.slice(0, start).trim();
    }
    comments.push({
      id: `${timestamp}-${comments.length}`,
      author: "filesystem",
      body: commentBody.trim(),
      createdAt: timestamp,
    });
    description = body.slice(0, match.index).trim();
  }
  return { description: description || body.trim(), comments };
}

export class FileSystemIssueProvider implements IssueProvider {
  readonly kind: IssueBackendKind = "filesystem";
  #issuesDir: string;

  constructor(options: { repoRoot: string; issuesPath?: string }) {
    const targetPath = options.issuesPath ?? ".skribulat/issues";
    this.#issuesDir = isAbsolute(targetPath) ? targetPath : join(options.repoRoot, targetPath);
  }

  async listOpenIssues(): Promise<IssueSummary[]> {
    const entries: IssueSummary[] = [];
    try {
      for await (const entry of Deno.readDir(this.#issuesDir)) {
        if (!entry.isFile || !entry.name.endsWith(".md")) continue;
        const id = entry.name.replace(/\.md$/, "");
        const fullPath = join(this.#issuesDir, entry.name);
        const contents = await Deno.readTextFile(fullPath);
        const { meta } = parseFrontmatter(contents);
        const status = meta.status?.toLowerCase() ?? "open";
        if (status === "closed") continue;
        const stat = await Deno.stat(fullPath);
        entries.push({
          id,
          title: meta.title || id,
          labels: meta.labels ?? [],
          createdAt: meta.created ?? stat.birthtime?.toISOString(),
          updatedAt: meta.updated ?? stat.mtime?.toISOString(),
          status,
          url: meta.url,
        });
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
    entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return entries;
  }

  async fetchIssueWithComments(id: string): Promise<{ issue: Issue; comments: IssueComment[] }> {
    const filePath = join(this.#issuesDir, `${id}.md`);
    const contents = await Deno.readTextFile(filePath);
    const { meta, body } = parseFrontmatter(contents);
    const { description, comments } = parseComments(body);
    const stat = await Deno.stat(filePath);
    const issue: Issue = {
      id,
      title: meta.title || id,
      body: description,
      labels: meta.labels ?? [],
      createdAt: meta.created ?? stat.birthtime?.toISOString(),
      updatedAt: meta.updated ?? stat.mtime?.toISOString(),
      status: meta.status ?? "open",
      url: meta.url,
    };
    return { issue, comments };
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const filePath = join(this.#issuesDir, `${issueId}.md`);
    const timestamp = new Date().toISOString();
    const block = serializeComment(timestamp, body.trim());
    await Deno.writeTextFile(filePath, block, { append: true });
  }
}
