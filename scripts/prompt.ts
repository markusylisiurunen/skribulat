import { listTemplates, loadTemplate } from "../prompts/index.ts";
import { CliError, printCliError } from "../utils/errors.ts";

async function usage(): Promise<never> {
  const names = await listTemplates();
  console.log(
    [
      "Usage: skribulat prompt <prompt-name>",
      "",
      "Print a prompt template.",
      "",
      "Available names:",
      names.length > 0 ? `  ${names.join("\n  ")}` : "  (none found)",
    ].join("\n"),
  );
  Deno.exit(0);
}

async function resolveTemplateName(input: string): Promise<string> {
  if (input.length === 0) throw new CliError("Prompt name must be non-empty.");
  const normalized = input.replace(/\.md$/, "");
  const available = await listTemplates();
  if (available.includes(normalized)) return normalized;
  const hint = available.length > 0
    ? `Known prompts: ${available.join(", ")}`
    : "No templates found.";
  throw new CliError(
    `Unknown prompt "${input}". ${hint}`,
  );
}

export async function runPrompt(args: string[]) {
  const [name, ...rest] = args;
  if (!name || name === "-h" || name === "--help") await usage();
  if (rest.length > 0) throw new CliError("Too many arguments. Expected a single prompt name.");
  const key = await resolveTemplateName(name);
  const content = await loadTemplate(key);
  console.log(content);
}

if (import.meta.main) {
  await runPrompt(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
