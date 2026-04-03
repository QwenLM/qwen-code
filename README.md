# proto

A multi-model AI agent for the terminal. Part of the [protoLabs Studio](https://protolabs.studio) ecosystem.

[![License](https://img.shields.io/github/license/QwenLM/qwen-code.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

proto is a fork of [Qwen Code](https://github.com/QwenLM/qwen-code) (itself forked from [Gemini CLI](https://github.com/google-gemini/gemini-cli)), rebuilt as a model-agnostic coding agent. It connects to any OpenAI-compatible, Anthropic, or Gemini API endpoint.

## What's Different

| Feature          | Qwen Code               | proto                                                                          |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Default model    | Qwen3-Coder             | Any (configurable)                                                             |
| Task management  | In-memory JSON          | [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (SQLite + JSONL) |
| Memory           | Single append-only file | File-per-memory with YAML frontmatter, 4-type taxonomy, auto-extraction        |
| MCP servers      | None                    | Configurable via `~/.proto/settings.json`                                      |
| Plugin discovery | Qwen only               | Auto-discovers Claude Code plugins from `~/.claude/plugins/`                   |
| Skills           | Nested superpowers      | Flat bundled skills (16 skills, all discoverable)                              |

## Installation

Requires Node.js 20+ and Rust toolchain (for beads_rust).

```bash
# Install from npm (recommended)
npm install -g @protolabsai/proto
proto --version

# Or install from source
git clone https://github.com/protoLabsAI/protoCLI.git
cd protoCLI
npm install && npm run build && npm link

# Optional: task manager for persistent task tracking
cargo install beads_rust
```

## Quick Start

### 1. Configure your endpoint

proto connects to any OpenAI-compatible API. Create `~/.proto/settings.json`:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "my-model",
        "name": "My Model",
        "baseUrl": "http://localhost:8000/v1",
        "envKey": "MY_API_KEY"
      }
    ]
  },
  "security": {
    "auth": { "selectedType": "openai" }
  },
  "model": { "name": "my-model" }
}
```

### 2. Set your API key

Create `~/.proto/.env`:

```
MY_API_KEY=sk-your-key-here
```

Or export it in your shell: `export MY_API_KEY=sk-your-key-here`

### 3. Run proto

```bash
proto                            # interactive mode
proto -p "explain this codebase" # one-shot mode
```

No auth screen — proto connects directly to your endpoint.

### Example: Multiple models via a gateway

If you run a gateway like [LiteLLM](https://github.com/BerriAI/litellm) in front of multiple providers, register them all under `modelProviders.openai` and switch between them with `/model`:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "local/qwen-122b",
        "name": "Qwen3.5-122B (local vLLM)",
        "baseUrl": "http://my-gateway:4000/v1",
        "envKey": "GATEWAY_KEY",
        "generationConfig": { "contextWindowSize": 65536 }
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "baseUrl": "http://my-gateway:4000/v1",
        "envKey": "GATEWAY_KEY",
        "capabilities": { "vision": true },
        "generationConfig": { "contextWindowSize": 200000 }
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "baseUrl": "http://my-gateway:4000/v1",
        "envKey": "GATEWAY_KEY",
        "capabilities": { "vision": true },
        "generationConfig": { "contextWindowSize": 200000 }
      }
    ]
  },
  "security": {
    "auth": { "selectedType": "openai" }
  },
  "model": { "name": "local/qwen-122b" }
}
```

### Model config reference

| Field                                | Required | Description                                                      |
| ------------------------------------ | -------- | ---------------------------------------------------------------- |
| `id`                                 | yes      | Model ID sent to the API (must match what your endpoint expects) |
| `name`                               | no       | Display name in proto UI (defaults to `id`)                      |
| `baseUrl`                            | no       | API base URL (defaults to OpenAI's)                              |
| `envKey`                             | no       | Environment variable name for the API key                        |
| `description`                        | no       | Shown in model picker                                            |
| `capabilities.vision`                | no       | Enable image/vision inputs                                       |
| `generationConfig.contextWindowSize` | no       | Context window in tokens                                         |

## Configuration

proto uses `~/.proto/settings.json` for global config and `.proto/settings.json` for per-project overrides.

### MCP Servers

Add MCP servers directly in settings:

```json
{
  "mcpServers": {
    "my_server": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": { "API_KEY": "..." },
      "trust": true
    }
  }
}
```

Tools are exposed as `mcp__<server_name>__<tool_name>` and available to the agent immediately.

### Plugin Discovery

proto auto-discovers Claude Code plugins installed at `~/.claude/plugins/`. Any plugin's `commands/` directory is automatically loaded as slash commands — no additional config needed.

## Observability

proto supports [Langfuse](https://langfuse.com) tracing out of the box. Set three environment variables and every session is fully traced — LLM calls (all providers), tool executions, subagent lifecycles, and turn hierarchy.

### Setup

Add to the `env` block in `~/.proto/settings.json`:

```json
{
  "env": {
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

`LANGFUSE_BASE_URL` is optional and defaults to `https://cloud.langfuse.com`. For a self-hosted instance, set it to your deployment URL.

> **Why `settings.json` and not `.env`?** proto walks up from your CWD loading `.env` files, so a project-level `.env` with Langfuse keys would bleed into proto's tracing and mix your traces into the wrong dataset. The `env` block in `settings.json` is proto-namespaced and completely isolated from your projects.

### What gets traced

| Span                  | Attributes                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `turn`                | `session.id`, `turn.id` — root span per user prompt                                                  |
| `gen_ai chat {model}` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.model` — one per LLM call |
| `tool/{name}`         | `tool.name`, `tool.type`, `tool.duration_ms` — one per tool execution                                |
| `agent/{name}`        | `agent.name`, `agent.status`, `agent.duration_ms` — one per subagent                                 |

All three provider backends are covered: OpenAI-compatible, Anthropic, and Gemini.

### Prompt content logging

Full prompt messages and response text are included in traces by default. To disable:

```json
// ~/.proto/settings.json
{
  "telemetry": { "logPrompts": false }
}
```

> **Privacy note:** `logPrompts` is enabled by default. When enabled, full prompt and response content is sent to your Langfuse instance. Set to `false` if you want traces without message content.

### Langfuse activates independently

Langfuse tracing activates from env vars alone — it does not require `telemetry.enabled: true` in settings. The general telemetry pipeline (OTLP/GCP) and Langfuse are independent.

## Task Management

proto integrates [beads_rust](https://github.com/Dicklesworthstone/beads_rust) for persistent, SQLite-backed task tracking. When `br` is on PATH, the 6 task tools (`task_create`, `task_get`, `task_list`, `task_update`, `task_stop`, `task_output`) use it as the backend. Tasks persist across sessions in `.beads/` within the project directory.

If `br` is not installed, tasks fall back to the original in-memory JSON store.

```bash
# The agent uses these automatically, but you can also use br directly:
br list              # See all tasks
br list --json       # Machine-readable output
br create --title "Fix auth bug" --type task --priority 1
br close <id> --reason "Fixed in commit abc123"
```

## Memory

proto has a persistent memory system inspired by Claude Code. Memories are individual markdown files with YAML frontmatter, organized by type and stored per-project or globally.

### Memory types

| Type        | Purpose                               | Example                                        |
| ----------- | ------------------------------------- | ---------------------------------------------- |
| `user`      | Preferences, role, knowledge          | "prefers tabs over spaces"                     |
| `feedback`  | Approach corrections or confirmations | "don't mock the database in integration tests" |
| `project`   | Deadlines, decisions, ongoing work    | "merge freeze starts April 5"                  |
| `reference` | Pointers to external systems          | "bugs tracked in Linear project INGEST"        |

### How it works

Each memory is a `.md` file in `.proto/memory/` (project) or `~/.proto/memory/` (global):

```markdown
---
name: prefer-dark-theme
description: User prefers dark themes in all editors
type: user
---

User explicitly stated they prefer dark themes.
```

A `MEMORY.md` index is auto-generated and loaded into the system prompt at the start of each session. The agent can create memories via the `save_memory` tool, or you can use slash commands:

```
/memory add --project I prefer dark themes
/memory list
/memory forget prefer-dark-theme
/memory show
/memory refresh
```

After each conversation turn, a background extraction agent reviews recent messages and auto-creates memories for notable facts. This runs fire-and-forget with restricted tools (read/write/glob in the memory directory only).

## Skills

proto ships with 16 bundled skills for agentic workflows:

- **brainstorming** — Structured ideation
- **dispatching-parallel-agents** — Fan-out/fan-in subagent patterns
- **executing-plans** — Step-by-step plan execution
- **finishing-a-development-branch** — Pre-merge cleanup
- **qc-helper** — Quality control checks
- **receiving-code-review** — Process review feedback
- **requesting-code-review** — Generate review requests
- **review** — Code review workflow
- **subagent-driven-development** — Delegate to specialized subagents
- **systematic-debugging** — Structured debug methodology
- **test-driven-development** — TDD workflow
- **using-git-worktrees** — Isolated branch work
- **using-superpowers** — Advanced agent capabilities
- **verification-before-completion** — Pre-commit verification
- **writing-plans** — Plan authoring
- **writing-skills** — Skill authoring

Use `/skills` to list available skills in a session.

## Commands

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `/help`                 | Show available commands                   |
| `/auth`                 | Configure authentication                  |
| `/model`                | Switch models                             |
| `/skills`               | List available skills                     |
| `/memory show`          | Display loaded memory content             |
| `/memory list`          | List all memories with type, scope, age   |
| `/memory add <fact>`    | Save a memory (`--global` or `--project`) |
| `/memory forget <name>` | Delete a memory                           |
| `/memory refresh`       | Reload memories from disk                 |
| `/clear`                | Clear conversation                        |
| `/compress`             | Compress history to save tokens           |
| `/stats`                | Session info                              |
| `/exit`                 | Exit proto                                |

## Keyboard Shortcuts

| Shortcut  | Action                   |
| --------- | ------------------------ |
| `Ctrl+C`  | Cancel current operation |
| `Ctrl+D`  | Exit (on empty line)     |
| `Up/Down` | Navigate command history |

## Voice Integration

proto supports push-to-talk voice input. Press the mic button in the footer or use `/voice` to toggle.

### Requirements

Voice capture requires a system audio backend:

| OS    | Backend | Install                               |
| ----- | ------- | ------------------------------------- |
| macOS | sox     | `brew install sox`                    |
| Linux | sox     | `apt install sox` / `dnf install sox` |
| Linux | arecord | `apt install alsa-utils` (fallback)   |

Verify detection: `/voice status`

### STT backend

Voice input transcribes audio via a Whisper-compatible `/v1/audio/transcriptions` endpoint.

**Option A — protoLabs hosted** (no setup):

```json
// ~/.proto/settings.json
{
  "voice": {
    "enabled": true,
    "sttEndpoint": "https://ai.proto-labs.ai/v1/audio/transcriptions"
  }
}
```

**Option B — self-hosted** (e.g. [faster-whisper-server](https://github.com/fedirz/faster-whisper-server)):

```bash
docker run --gpus all -p 8000:8000 fedirz/faster-whisper-server:latest-cuda
```

```json
// ~/.proto/settings.json
{
  "voice": {
    "enabled": true,
    "sttEndpoint": "http://localhost:8000/v1/audio/transcriptions"
  }
}
```

The default endpoint is `http://localhost:8000/v1/audio/transcriptions` if none is configured.

## Architecture

```
packages/
├── cli/           # Terminal UI (Ink + React)
├── core/          # Agent engine, tools, skills, MCP client
├── sdk-typescript/# TypeScript SDK
├── web-templates/ # Shared web templates
├── webui/         # Shared UI components
└── test-utils/    # Testing utilities
```

## Acknowledgments

Built on [Qwen Code](https://github.com/QwenLM/qwen-code) (Apache 2.0), which is built on [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Apache 2.0). Task management powered by [beads_rust](https://github.com/Dicklesworthstone/beads_rust).

## License

Apache 2.0 — see [LICENSE](./LICENSE).
