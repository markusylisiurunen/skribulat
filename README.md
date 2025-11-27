## Skribulat CLI

Skribulat is a Deno-based command-line toolkit for AI-assisted repo workflows.

### Quick start

- Install Deno and Docker (for agent runners).
- Create `.env`/`.env.secret` if you have them; the CLI auto-loads these files from the repo root
  and any sub-directories.
- Run commands with:
  ```bash
  deno run -A main.ts <command> [...flags]
  ```

### Available commands

- `build-agent-runner` – bake the Docker image that agents use (installs Node, Go, Deno, and agent
  CLIs like `codex` and `claude`). Supports flags like `--image`, `--node-version`,
  `--npm-packages`.
- `commit` – propose staged-change commit subjects using OpenRouter models.
- `exec` – translate a free-form instruction into a single shell command, then optionally execute
  it. Supports `--model` with aliases `claude`, `gemini`, and `gpt`.
- `review` – generate an optimized code review prompt from a git diff (piped via stdin), including
  full content of modified files. Supports `-i/--include <regex>` to force-add files,
  `-e/--exclude
  <regex>` to drop files, and `--dry-run` to list which files would be included
  without emitting the prompt.
- `markdown-codebase` – render git-visible files (tracked plus untracked, non-ignored) from the
  current working tree as Markdown. Deleted files are skipped; new unignored files are included. Use
  `--dry-run` to list matching files with line and estimated token counts instead of emitting file
  contents.
- `grep` – fragment-aware, model-powered grep. Provide `-p/--prompt` with either fragment selection
  (`-f/--fragment`, repeatable; or `-a/--all-fragments`) **or** ad-hoc regex filters
  (`-i/--include`, `-e/--exclude`, repeatable); fragments and ad-hoc filters are mutually exclusive.
  Use `--dry-run` to list matched files with line/token counts without calling the model. Each
  fragment (or the ad-hoc selection) is searched in its own LLM call; fragments may declare
  regex-based `splits` to fan their files into multiple calls for smaller contexts, with any
  unmatched files automatically bundled into a final remainder split. Model aliases:
  gemini-2.5-flash-lite (default), gemini-2.5-flash, gemini-3-pro, gpt-5.1, qwen3-32b.
  `skribulat grep fragments` lists configured fragments, their splits (with file/line/char counts),
  and file/line/token stats (limited to 50k lines or 1M chars per split call).
- `oracle` – ask free-form questions with optional file attachments; accepts `-p` or piped stdin
  when `-p` is omitted. You can attach files via fragments configured under `oracle.fragments`
  (`-f/--fragment`) and/or ad-hoc regex filters (`-i/--include`, `-e/--exclude`); ad-hoc filters do
  not filter fragment files. Per-file attachments capped at 5,000 lines/100k chars and 50k lines/1M
  chars per turn; non-UTF8 files are skipped with warnings. Supports continuation by session UUID,
  detached/background runs, wait mode, dry-run inspection, and a configurable default model
  (`oracle.default_model`, fallback `gemini-3-pro`).
- `plan-issue` – post a structured implementation plan for an issue. Supports `--agent`, `--model`,
  and `--codex-auth <path>` to copy an existing host `auth.json` into the container before falling
  back to API-key login. Issues can come from GitHub (default) or a filesystem backend configured in
  `.skribulat/config.yaml` (see Configuration).
- `plan-and-work-on-issue` – run the planning workflow and immediately hand off to the
  implementation workflow with optional `--agent`/`--model` overrides for the work phase. Accepts
  `--codex-auth` and forwards it to both steps.
- `prompt` – print a stored prompt template from `prompts/templates`. Example:
  `skribulat prompt rewrite-prompt`.
- `work-on-issue` – spin up an agent (Codex, Claude Code, or shell) to implement a selected issue
  end-to-end. Supports `--agent`, `--model`, and `--codex-auth` for supplying a host Codex
  credential file instead of logging in with an API key. Works with GitHub or the filesystem issue
  backend based on config.
- `work-on-pr` – apply reviewer feedback to an open pull request via an agent run. Supports
  `--agent`, `--model`, and `--codex-auth` for the same credential-file workflow.

Each script lives in `scripts/` and can be imported or executed directly with Deno if needed.

### Configuration

Skribulat reads `.skribulat/config.yaml` to figure out how each command should run its agent. The
file starts with a top-level `agent` block that defines global defaults, and optional sections such
as `plan_issue`, `work_on_issue`, and `work_on_pr` that override those defaults for a single
workflow. Each of these sections may include a nested `agent` block plus any command-specific
fields—Plan Issue, for example, understands `agents_directory_map`, `label_explanations`, and
`tool_guidance`; Grep optionally understands `grep.default_model` (one of the model aliases) and
`grep.fragments` (named include/exclude regex lists, optionally further split via `splits`); Oracle
supports `oracle.default_model` plus `oracle.fragments` (named include/exclude regex lists without
splits). At runtime the merge order is:

1. global `agent`
2. command-specific `<command>.agent` (if present)
3. CLI flags (`--agent`, `--model`)

Later layers override earlier ones; env/env_passthrough keys are unioned so you keep committed
defaults while letting command scopes or CLI add more.

An `agent` block accepts the following knobs: `tool` (`"codex"`, `"claude-code"`, or `"shell"`),
`model`, `command` (used mainly when `tool: shell`), `reasoning_effort` (passed through to Codex),
`env` for committed key/value pairs, and `env_passthrough` for the names of secrets you want copied
from your current shell into the Docker container. When a command runs, Skribulat builds the runner
environment by combining its built-in defaults (GitHub auth, DEBIAN_FRONTEND, etc.), the committed
`env` values, and any pass-through variables that are set locally. This keeps secrets uncommitted
while still documenting which ones are required.

Example `.skribulat/config.yaml`:

```yaml
grep:
  default_model: gemini-2.5-flash-lite
  fragments:
    - name: backend
      include:
        - "^services/api/"
        - "^libs/backend/"
      exclude:
        - "\\.test\\.ts$"
      splits:
        - name: controllers
          include: ["^services/api/controllers/"]
        - name: services
          include: ["^services/api/services/"]
        - name: misc-backend
          include: ["^libs/backend/"]
      # any files under the fragment that don't match a split go to an implicit "remainder" split
    - name: frontend
      include:
        - "^apps/web/"
      exclude:
        - "\\.stories\\.tsx$"

oracle:
  default_model: gemini-3-pro
  fragments:
    - name: apis
      include: ["^services/api/"]
      exclude: ["\\.test\\.ts$"]
    - name: frontend
      include: ["^apps/web/"]

agent:
  tool: codex
  model: gpt-5.1-codex-max
  reasoning_effort: low
  env:
    AGENT_PROMPT_STYLE: "codex-default" # toggle shared by every command
  env_passthrough:
    - OPENAI_API_KEY # pulled from the caller's env at runtime
    - ANTHROPIC_API_KEY # likewise, keeps secrets out of git
    - GITHUB_TOKEN # documented requirement without storing the secret

plan_issue:
  agents_directory_map:
    backend: ["services/api", "libs/backend"]
    frontend: ["apps/web"]
  label_explanations: "backend=API layer, frontend=React app."
  agent:
    tool: claude-code # override tool just for plan-issue
    model: sonnet
    reasoning_effort: medium
    env:
      PLAN_TEMPERATURE: "0.2" # extra toggle only this command needs
    env_passthrough:
      - OPENROUTER_API_KEY # forwarded in addition to global keys

work_on_issue:
  agent:
    tool: shell
    command: "./scripts/custom-shell-agent.sh {{PROMPT_PATH}}"
    env:
      CUSTOM_AGENT_MODE: "fast"

work_on_pr:
  agent:
    tool: codex
    model: gpt-5.1-codex-max

# Issue backend (GitHub default; filesystem optional)
issues:
  backend: github # or fs
  path: .skribulat/issues # optional when backend=fs
```

The snippet shows global defaults plus per-command overrides that swap tools, models, committed
environment values, and pass-through secrets. Only the key names for sensitive data are committed,
so you can safely keep their values in `.env.secret` or your shell.

CLI overrides sit on top of the YAML. Examples:

- `deno run -A main.ts plan-issue --agent codex --model gpt-5.1-codex-max`
- `deno run -A main.ts work-on-issue --agent shell --model ""` (falls back to shell command from
  config)
- `deno run -A main.ts work-on-pr --model sonnet`

Hooks and agent artifacts live under `.skribulat/`:

- `.skribulat/hooks/pre-work.sh` – setup inside the container before any agent work; aborts the run
  on failure. Example: install toolchain and print instructions.
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  apt-get update && apt-get install -y shellcheck
  echo "Run lint with: deno lint"
  ```
- `.skribulat/hooks/post-work.sh` – verification before push/PR; aborts on failure. Example: run
  tests and format check.
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  deno fmt --check
  deno test
  ```
- `.skribulat/hooks/on-failure.sh` – best-effort recovery/logging when the run errors. Example: send
  a webhook and collect logs.
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  curl -X POST -H "Content-Type: application/json" \
    -d '{"text":"Skribulat run failed"}' "$SLACK_WEBHOOK_URL" || true
  tar czf /root/agent/.skribulat/patches/latest-logs.tgz /root/agent/.git/logs || true
  ```
- `.skribulat/patches/` – git diff snapshots captured after agent activity.

### Environment variables

- `OPENROUTER_API_KEY` _(required)_ – used for all LLM completions.
- `OPENAI_API_KEY` _(required for Codex runs)_ – passed into the Docker runner.
- `ANTHROPIC_API_KEY` _(required for Claude Code runs)_ – passed into the Docker runner.
- `GITHUB_TOKEN` _(required)_ – lets scripts call GitHub GraphQL/REST APIs.
- `OPENROUTER_*`, `AGENT_RUNNER_*`, and other overrides can be exported in `.env` or `.env.secret`.

When you run `deno run -A main.ts <command>`, Skribulat loads env files, reads
`.skribulat/config.yaml`, and executes the script with sensible defaults. Build the agent runner
image before the first `work-on-*` command to ensure agent CLIs (Codex, Claude Code) are available
inside the container.

### Building a standalone binary

Prompt templates live in two places:

- Embedded TypeScript prompts under `prompts/*.ts` (loaded via `utils/prompts.ts`).
- Markdown prompts under `prompts/templates/*.md` (front matter stripped); view them with
  `skribulat prompt <name>`.

You can compile the CLI into an executable that bundles the embedded prompt templates:

```bash
deno compile --allow-all --output=skribulat main.ts
```

Run the resulting `./skribulat` binary from inside a Git checkout so it can resolve repository
metadata, read `.skribulat/config.yaml`, and interact with Docker/Git as expected. Prompt templates
are embedded at build time, so no additional assets are required.
