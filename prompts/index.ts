const SYSTEM_DIR = `${import.meta.dirname ?? "."}/system`;
const TEMPLATE_DIR = `${import.meta.dirname ?? "."}/templates`;

function normalizeName(name: string): string {
  return name.replace(/\.(txt|md)$/, "");
}

function stripFrontMatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const remainder = text.slice(end + 4);
  return remainder.replace(/^\s*\n/, "");
}

async function listMarkdown(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      names.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return names.sort();
}

export async function listPrompts(): Promise<string[]> {
  return listMarkdown(SYSTEM_DIR);
}

export async function loadPrompt(name: string): Promise<string> {
  const id = normalizeName(name);
  const path = `${SYSTEM_DIR}/${id}.md`;
  try {
    const content = await Deno.readTextFile(path);
    return content.replace(/\\\n/g, "\n").trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Unknown prompt template: ${name}`);
    }
    throw error;
  }
}

export async function listTemplates(): Promise<string[]> {
  return listMarkdown(TEMPLATE_DIR);
}

export async function loadTemplate(id: string): Promise<string> {
  const name = normalizeName(id);
  const path = `${TEMPLATE_DIR}/${name}.md`;
  try {
    const content = await Deno.readTextFile(path);
    return stripFrontMatter(content).replace(/\\\n/g, "\n").trim();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Unknown prompt template: ${id}`);
    }
    throw error;
  }
}
