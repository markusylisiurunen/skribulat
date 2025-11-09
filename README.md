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
- `markdown-codebase` – render git-tracked files (with optional include/exclude filters) as Markdown
  or emit stats.
- `plan-issue` – post a structured implementation plan for a GitHub issue.
- `work-on-issue` – spin up an agent (Codex, Claude Code, or shell) to implement a selected issue
  end-to-end. Supports `--agent` and `--model` flags.
- `work-on-pr` – apply reviewer feedback to an open pull request via an agent run. Supports
  `--agent` and `--model` flags.

Each script lives in `scripts/` and can be imported or executed directly with Deno if needed.

### Configuration

- Place repository-specific settings in `.skribulat/config.yaml`.
- Hooks and agent artifacts live under `.skribulat/`:
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
