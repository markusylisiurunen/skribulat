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
  it.
- `review` – generate an optimized code review prompt from a git diff (piped via stdin), including
  full content of modified files.
- `markdown-codebase` – render git-visible files (tracked plus untracked, non-ignored) as Markdown
  or emit stats.
- `ask-codebase` – capture the same filtered snapshot and forward it, along with your question, to
  an OpenRouter model (no snapshot is echoed to stdout).
- `oracle` – ask free-form questions with optional file attachments (same include/exclude filters).
  Per-file attachments capped at 5,000 lines/100k chars and 50k lines/1M chars per turn; non-UTF8
  files are skipped with warnings. Supports continuation by session UUID, detached/background runs,
  wait mode, and dry-run inspection.
- `plan-issue` – post a structured implementation plan for a GitHub issue. Supports `--agent`,
  `--model`, and `--codex-auth <path>` to copy an existing host `auth.json` into the container
  before falling back to API-key login.
- `plan-and-work-on-issue` – run the planning workflow and immediately hand off to the
  implementation workflow with optional `--agent`/`--model` overrides for the work phase. Accepts
  `--codex-auth` and forwards it to both steps.
- `work-on-issue` – spin up an agent (Codex, Claude Code, or shell) to implement a selected issue
  end-to-end. Supports `--agent`, `--model`, and `--codex-auth` for supplying a host Codex
  credential file instead of logging in with an API key.
- `work-on-pr` – apply reviewer feedback to an open pull request via an agent run. Supports
  `--agent`, `--model`, and `--codex-auth` for the same credential-file workflow.

Each script lives in `scripts/` and can be imported or executed directly with Deno if needed.

### Configuration

Skribulat reads `.skribulat/config.yaml` to figure out how each command should run its agent. The
file starts with a top-level `agent` block that defines global defaults, and optional sections such
as `plan_issue`, `work_on_issue`, and `work_on_pr` that override those defaults for a single
workflow. Each of these sections may include a nested `agent` block plus any command-specific
fields—Plan Issue, for example, understands `agents_directory_map`, `label_explanations`, and
`tool_guidance`. At runtime the merge order is:

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
    env_passthrough:
      - REVIEW_WEBHOOK_TOKEN
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

- `.skribulat/hooks/<hook>.sh` – optional pre/post hooks invoked during agent runs.
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

You can compile the CLI into an executable that bundles the prompt templates:

```bash
deno compile --allow-all --output=skribulat main.ts
```

Run the resulting `./skribulat` binary from inside a Git checkout so it can resolve repository
metadata, read `.skribulat/config.yaml`, and interact with Docker/Git as expected. Prompt templates
are embedded at build time, so no additional assets are required.
