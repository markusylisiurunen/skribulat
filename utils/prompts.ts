import { join } from "@std/path";
import { resolveRepoRoot } from "./git.ts";

const cache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;
  const repoRoot = resolveRepoRoot();
  const path = join(repoRoot, "prompts", name);
  const content = await Deno.readTextFile(path);
  cache.set(name, content);
  return content;
}

export function renderPrompt(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/gi, (_match, key) => {
    const wrappedKey = `{{${key}}}`;
    const resolved = variables[key] ??
      variables[key.toUpperCase()] ??
      variables[wrappedKey] ??
      variables[wrappedKey.toUpperCase()] ??
      "";
    return resolved;
  });
}
