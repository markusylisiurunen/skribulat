This repository hosts the Skribulat CLI: a Deno-based toolkit for automating repo workflows with LLM
support via OpenRouter, OpenAI Codex, and Anthropic Claude Code agents.

## Scripts

All scripts live under the `scripts` folder (e.g., `scripts/commit.ts`).

- `build_agent_runner.ts`: Builds the Docker image used by agents. Installs Ubuntu base with
  Node.js, Go, Deno, apt packages (git, ripgrep, fd-find, jq, etc.), and npm globals (defaults to
  `@openai/codex` and `@anthropic-ai/claude-code`). Supports `--base-image`, `--node-version`,
  `--go-version`, `--deno-version`, `--npm-packages`, `--apt-packages`, `--no-node`, `--no-go`,
  `--no-deno` flags. Reads `AGENT_RUNNER_*` env vars. Final image tagged via `--image` or
  `AGENT_RUNNER_IMAGE`.
- `commit.ts`: Generates three AI-powered commit subject proposals from staged changes using
  OpenRouter (defaults to `google/gemini-2.5-flash-preview-09-2025`). Collects staged diff +
  optional branch diff (vs default branch) as context. Supports `-A` to stage all changes first,
  `codex` flag to commit with Codex agent author credentials, and free-form additional guidance
  appended to prompt. Prompts user to select or edit before committing. Subject validation: single
  line, ≤90 chars, imperative mood, lowercase unless proper nouns, no scope prefixes or trailing
  punctuation.
- `exec.ts`: Translates natural language instructions into executable shell commands. Supports
  `--model` (aliases: claude, gemini, gpt) to select model (defaults to
  `anthropic/claude-sonnet-4.5`). Gathers environment context (OS, shell, cwd, HOME). Generates
  single-line command proposal, prompts for confirmation (editable). Executes via user's `$SHELL`
  (zsh only supported). Records command to zsh history (`$HISTFILE` or `~/.zsh_history`).
- `markdown_codebase.ts`: Emits markdown snapshot of git-visible files (tracked plus untracked,
  non-ignored) under current directory based on the live working tree. Files that are gitignored or
  deleted from the working tree are excluded; new unignored files are included. Runs `git ls-files`
  from repo root, filters to files within cwd (excludes `..` paths), converts paths to POSIX format.
  Supports `-i`/`--include` and `-e`/`--exclude` regex filters (repeatable). Default output:
  directory structure section (grouped by directory) + file contents section (each file wrapped in
  `<file path="...">` tags). With `--stats` flag: prints lines and estimated token count per file
  (via `tokenx` library), plus total token estimate. Useful for preparing codebase context for LLM
  prompts or assessing context window requirements.
- `oracle.ts`: CLI for oracle-style Q&A. Supports prompts (`-p`) or piped stdin (when `-p` is
  omitted), regex file attachments/excludes (`-i`/`-e`), continuation by UUID (`-c`), model override
  (`-m`, default `google/gemini-3-pro-preview`), detached background runs (`-d`), waiting
  (`-w`/`-t`), dry-run inspection (`--dry-run`), and always prints the session UUID. Uses OpenRouter
  to answer, persisting session JSON under `~/.skribulat/oracle`. Attachment limits: per file max
  5,000 lines or 100k characters; per turn total max 50k lines or 1M characters. Non-UTF8 (likely
  binary) files are skipped with a warning; oversized files/turns error before sending to the model.
- `plan_issue.ts`: Analyzes GitHub issues and posts comprehensive implementation plans. Supports
  `--issue <number>` or interactive selection plus optional `--agent <tool>`, `--model <name>`, and
  `--codex-auth <path>` to copy a host Codex `auth.json` into the container before running (falls
  back to API key login if missing). Uses the same agent config resolution as other work commands:
  global `agent` defaults from `.skribulat/config.yaml` → command-specific `plan_issue.agent`
  override → CLI flags (highest). Structured prompt includes issue metadata, all comments
  (paginated), and relevant AGENTS.md guidance (discovered via label→directory mapping from
  `.skribulat/config.yaml`). Agent explores codebase and returns markdown plan with sections:
  summary, background, implementation steps, relevant files, open questions. Posts result as issue
  comment.
- `plan_and_work_on_issue.ts`: Convenience wrapper that first runs the plan flow (same behavior as
  `plan_issue.ts`, including posting the comment) and immediately follows up with the implementation
  flow from `work_on_issue.ts`. Supports `--issue <number>` or interactive selection, optional
  `--agent`/`--model` overrides for the work step, and `--codex-auth <path>` which is forwarded to
  both plan and work phases.
- `review.ts`: Generates an optimized code review prompt by consuming a git diff from stdin. Parses
  the diff to identify modified files and includes their full content along with the diff itself in
  the prompt. Designed to be piped to an LLM.
- `work_on_issue.ts`: End-to-end issue implementation via agent (Codex, Claude Code, or shell).
  Supports `--issue <number>`, `--agent <tool>` (codex, claude-code, shell), `--model <name>` (e.g.,
  gpt-5.1-codex-max, sonnet, haiku), and `--codex-auth <path>` for copying host Codex credentials
  into the container instead of logging in with an API key. Generates kebab-case branch name from
  issue metadata (LLM-powered, max 50 chars, a-z/0-9/hyphens only). Fetches/creates branch. Clones
  repo into isolated Docker workspace at `/root/agent`. Runs pre-work hook. Agent implements
  changes, commits, pushes. Generates PR body from issue context + diff. Creates pull request
  against default branch. Preserves git patches to `.skribulat/patches/` with periodic checkpointing
  (every 30s during agent run).
- `work_on_pr.ts`: Addresses PR review feedback via agent (Codex, Claude Code, or shell). Supports
  `--agent <tool>` (codex, claude-code, shell), `--model <name>` (e.g., gpt-5.1-codex-max, sonnet,
  haiku), and `--codex-auth <path>` for copying Codex `auth.json` from the host. Interactive
  selection of PR, then checkbox selection of specific issue comments and review comment threads to
  focus on. Fetches associated issues (via `closingIssuesReferences`). Checks out PR branch in
  Docker workspace. Runs pre-work hook. Agent applies requested changes, commits, pushes. Preserves
  patches.

## Utility files

All utility files live under the `utils` folder.

- `agent_patch.ts`: Captures and preserves git diffs from agent runs for audit and rollback.
  Supports periodic checkpointing during execution (default 30s intervals).
- `agent_runner.ts`: Orchestrates agent execution with three modes: Codex (OpenAI CLI), Claude Code
  (Anthropic CLI), or shell (custom command). Handles authentication, streams execution progress,
  returns final agent output.
- `agent_workspace.ts`: Prepares isolated git workspace in Docker for agent runs. Clones repo to
  `/root/agent`, configures git credentials for HTTPS operations, validates GitHub authentication.
- `config.ts`: Central configuration loader for repo metadata and environment variables.
  Auto-detects repo root, GitHub owner/repo, default branch. Reads required env vars and caches
  results.
- `docker.ts`: Docker container lifecycle management with automatic cleanup on exit/signals.
  Provides command execution, file copying, container committing, and streaming output.
- `env.ts`: Hierarchical .env file loading from repo root down to cwd. Handles both `.env` and
  `.env.secret` files, skipping already-loaded paths. Respects `SKRIBULAT_ENV_FILES=0` to disable
  reading env files entirely.
- `errors.ts`: CLI error handling with `CliError` class and `AggregateError` formatting support.
- `flags.ts`: CLI flag parsing utilities supporting `--flag=value` and `--flag value` syntaxes.
  Includes integer validation helpers.
- `git.ts`: Git command wrappers (sync/async). Resolves repo root, parses GitHub remotes from
  various URL formats, determines default branch.
- `github.ts`: GitHub API client wrapping Octokit. Handles issues, PRs, comments (both issue and
  review threads), and associated issue fetching via GraphQL.
- `guidance.ts`: Discovers and formats AGENTS.md files based on issue label→directory mappings from
  config. Returns XML-wrapped content for prompt injection. Provides overrideable prompt guidance
  helpers.
- `hooks.ts`: Executes bash hooks from `.skribulat/hooks/` directory with streaming output.
  Currently supports `pre-work.sh` before agent execution.
- `llm.ts`: OpenRouter API client for LLM completions. Supports reasoning configuration (effort
  levels or max tokens). Requires `OPENROUTER_API_KEY`.
- `paths.ts`: Path constants and helper functions for `.skribulat/` directory structure (config,
  hooks, patches subdirectories).
- `process.ts`: Generic command execution wrapper returning stdout/stderr/exit code with optional
  failure tolerance.
- `project_config.ts`: Parses `.skribulat/config.yaml` for agent tool configuration and workflow
  settings. Supports hierarchical overrides per command (`plan_issue`, `work_on_issue`,
  `work_on_pr`). Normalizes label mappings to lowercase.
- `prompts.ts`: Loads embedded prompt templates (compiled into binary) and renders them with
  `{{VARIABLE}}` substitution (case-insensitive).
- `template.ts`: Generic template rendering utility (currently unused; `prompts.ts` is the active
  implementation).
- `text.ts`: Terminal text formatting utilities (console width truncation).

## Configuration

- `.skribulat/config.yaml`: Defines agent defaults consumed by `utils/project_config.ts`. Each
  `agent` block (global or command-specific) can provide:
  - `tool`: `"codex"`, `"claude-code"`, or `"shell"` (default `codex` if omitted).
  - `model`, `command`, and `reasoning_effort` overrides passed to the selected agent CLI.
  - `env`: committed key/value pairs that are injected into the Docker runner environment.
  - `env_passthrough`: a list of environment variable names that should be copied from the caller's
    environment into the container when present. Use this for secrets you prefer to set locally
    (e.g., `OPENAI_API_KEY`, `GITHUB_TOKEN`) while keeping the keys documented in version control.
- Downstream scripts call `buildRunnerEnv` to merge base variables, committed overrides, and any
  pass-through keys before starting the container, ensuring flags and secrets are consistently
  available during agent execution.

## Prompt templates

The `prompts/` folder contains LLM prompt templates embedded into the compiled binary. Templates use
`{{VARIABLE}}` placeholder syntax and are loaded via `utils/prompts.ts`. Most commands use paired
system/user prompts (e.g., `commit_subject_system.ts` + `commit_subject_user.ts`). The
`templates.ts` file exports all prompts as a centralized map for compilation.

## How to work

- Do not write tests or documentation unless explicitly asked.
- Keep code formatted and linted:
  ```bash
  deno fmt && deno lint && deno check main.ts
  ```
- Make sure this file stays up to date with changes made in the codebase.
