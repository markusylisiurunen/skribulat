import {
  buildFilteredFileEntries,
  renderDirectoryStructure,
  renderFileBlocks,
} from "../utils/codebase_snapshot.ts";
import { loadEnv } from "../utils/env.ts";
import { CliError, printCliError } from "../utils/errors.ts";
import { generateCompletion } from "../utils/llm.ts";

const DEFAULT_MODEL = "google/gemini-2.5-flash-preview-09-2025";
const MAX_TOKENS = 4096;

type ParsedArgs = {
  exclude: RegExp[];
  include: RegExp[];
  model: string;
  question: string;
};

function usage() {
  console.log(
    [
      "Usage: skribulat ask-codebase [options] <question>",
      "",
      "Options:",
      "  -i, --include <pattern>   Regex for files to include (repeatable)",
      "  -e, --exclude <pattern>   Regex for files to exclude (repeatable)",
      "  -m, --model <name>        Model name to send to OpenRouter",
      "  --question <text>         Explicit question text (otherwise use positional args)",
      "  -h, --help                Show this help message",
    ].join("\n"),
  );
}

function compileRegex(flag: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid regex for ${flag}: ${message}`);
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  let model = DEFAULT_MODEL;
  const questionParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-i" || arg === "--include") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} flag requires a value.`);
      include.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--include=")) {
      const pattern = arg.slice("--include=".length);
      if (!pattern) throw new CliError("--include flag requires a value.");
      include.push(compileRegex("--include", pattern));
      continue;
    }
    if (arg === "-e" || arg === "--exclude") {
      const pattern = argv[++i];
      if (!pattern) throw new CliError(`${arg} flag requires a value.`);
      exclude.push(compileRegex(arg, pattern));
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      const pattern = arg.slice("--exclude=".length);
      if (!pattern) throw new CliError("--exclude flag requires a value.");
      exclude.push(compileRegex("--exclude", pattern));
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new CliError(`${arg} flag requires a value.`);
      model = value;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) throw new CliError("--model flag requires a value.");
      model = value;
      continue;
    }
    if (arg === "--question") {
      const value = argv[++i];
      if (!value) throw new CliError("--question flag requires a value.");
      questionParts.push(value);
      continue;
    }
    if (arg.startsWith("--question=")) {
      const value = arg.slice("--question=".length);
      if (!value) throw new CliError("--question flag requires a value.");
      questionParts.push(value);
      continue;
    }
    questionParts.push(arg);
  }

  return {
    exclude,
    include,
    model,
    question: questionParts.join(" ").trim(),
  };
}

function buildPrompt(question: string, snapshot: string): string {
  return [
    "You are an expert software engineer.",
    "Answer the user's question using only the provided codebase snapshot.",
    "If the answer is not present, explain what is missing instead of guessing.",
    "When answering, always reference the specific file(s) where relevant information is found.",
    "When referencing a file, include only very small code snippets from that file when feasible to help locate the relevant parts.",
    "Do not include extensive amounts of code in your response unless the user specifically asks for it.",
    "Keep your response concise and to the point.",
    "Use very plain markdown formatting in your response. Prefer simple lists over tables or other visual formatting. Keep formatting minimal and simple.",
    "",
    `Question: ${question}`,
    "",
    "Codebase snapshot:",
    snapshot,
  ].join("\n");
}

export async function runAskCodebase(argv: string[]) {
  await loadEnv();
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return;
  }
  const { include, exclude, model, question } = parseArgs(argv);
  if (!question) {
    throw new CliError("A question or prompt is required.");
  }
  const entries = buildFilteredFileEntries({ include, exclude });
  if (entries.length === 0) {
    console.log("No git-tracked files matched under the current directory.");
    return;
  }
  const directorySection = renderDirectoryStructure(entries).trimEnd();
  const fileSection = (await renderFileBlocks(entries)).trimEnd();
  const snapshot = [directorySection, fileSection].filter((section) => section.length > 0).join(
    "\n\n",
  );
  const prompt = buildPrompt(question, snapshot);
  const answer = await generateCompletion({
    maxTokens: MAX_TOKENS,
    model: model,
    prompt: prompt,
    reasoningMaxTokens: Math.round(0.8 * MAX_TOKENS),
    temperature: 0.2,
  });
  const response = answer.trim();
  if (response.length === 0) {
    console.log("Model returned an empty response.");
    return;
  }
  console.log(response);
}

if (import.meta.main) {
  runAskCodebase(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
