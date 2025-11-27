import { listPrompts, loadPrompt as loadPromptFile } from "../prompts/index.ts";

export { listPrompts };

export function loadPrompt(name: string): Promise<string> {
  return loadPromptFile(name);
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
