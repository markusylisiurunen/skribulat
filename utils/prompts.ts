import { PROMPT_TEMPLATES } from "../prompts/templates.ts";

export function loadPrompt(name: string): Promise<string> {
  const template = PROMPT_TEMPLATES[name];
  if (template === undefined) {
    throw new Error(`Unknown prompt template: ${name}`);
  }
  return Promise.resolve(template);
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
