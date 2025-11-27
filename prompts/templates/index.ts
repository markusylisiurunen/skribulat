const DIR = import.meta.dirname ?? ".";

function stripFrontMatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const remainder = text.slice(end + 4);
  return remainder.replace(/^\s*\n/, "");
}

export async function listTemplates(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      names.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return names.sort();
}

export async function loadTemplate(id: string): Promise<string> {
  const path = `${DIR}/${id}.md`;
  const content = await Deno.readTextFile(path);
  return stripFrontMatter(content).trim();
}
