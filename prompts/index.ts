const DIR = import.meta.dirname ?? ".";

function normalizeName(name: string): string {
  return name.replace(/\.(txt|md)$/, "");
}

export async function listPrompts(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      names.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return names.sort();
}

export async function loadPrompt(name: string): Promise<string> {
  const id = normalizeName(name);
  const path = `${DIR}/${id}.md`;
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
