This repository hosts the Skribulat CLI: a Deno-based toolkit for automating repo workflows with LLM
support. Treat this document as the single source for setup, guardrails, and expected behaviors.

## Current scriptd

- `commit`: summarizes staged diffs and proposes git commit subjects.
- `exec`: turns a free-form instruction into a single-line shell command, confirms before running.
- `plan-issue`: analyzes a GitHub issue (plus comments) and posts an implementation plan.
- `work-on-issue`: provisions a Docker runner and drives Codex to implement an issue end-to-end.
- `work-on-pr`: applies requested changes on an existing pull request branch via Codex.

## Model & prompt defaults

- All text generation flows through OpenRouter models (see `utils/llm.ts`). Required API key:
  `OPENROUTER_API_KEY`.
- Codex-powered agents (`plan-issue`, `work-on-issue`, `work-on-pr`) additionally need
  `OPENAI_API_KEY`.
- Prompt templates live in `prompts/*.ts` and export string literals. Always retrieve them via
  `utils/prompts.ts` so bundling/compilation keeps working; avoid embedding raw prompt text
  directly.

## Repository expectations

- Keep code formatted and linted:
  ```bash
  deno fmt --check
  deno lint
  ```
- Automated CI lives in `.github/workflows/deno.yml` and executes the same checks.

_Extend this guide when adding new scripts, changing guardrails, or updating required tooling._
