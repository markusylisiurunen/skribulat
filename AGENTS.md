# Agents Overview

This repository provides AI-assisted CLI tooling built around modular scripts. Keep agent-related
notes short and actionable.

## Current Agents

- `commit`: generates staged-change git subjects with OpenRouter models.
- `exec`: proposes single-line shell commands, reusing configured models.

## Model & Prompt Defaults

- Models resolve through OpenRouter; environment variables override defaults.
- Prompts live in `prompts/` per template; reuse and extend rather than embedding strings.

## Operational Checklist

- Ensure `.env` and `.env.secret` contain required API keys before running.
- Run via `deno run -A main.ts <command>` or the compiled CLI once available.

_Add new agents, model notes, or guardrails by extending matching sections above._
