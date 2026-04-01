<div align="center">

```
                    __
                   /\ \__
 _____   _ __   ___\ \ ,_\   ___
/\ '__`\/\`'__\/ __`\ \ \/  / __`\
\ \ \L\ \ \ \//\ \L\ \ \ \_/\ \L\ \
 \ \ ,__/\ \_\\ \____/\ \__\ \____/
  \ \ \/  \/_/ \/___/  \/__/\/___/
   \ \_\
    \/_/
```

**proto** — a multi-model AI agent for the terminal.

[![License](https://img.shields.io/github/license/QwenLM/qwen-code.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

</div>

proto is a fork of [Qwen Code](https://github.com/QwenLM/qwen-code) (itself forked from [Gemini CLI](https://github.com/google-gemini/gemini-cli)), rebuilt as a model-agnostic coding agent. It connects to any OpenAI-compatible, Anthropic, or Gemini API endpoint and adds features from the [protoLabs Studio](https://proto-labs.studio) ecosystem.

## What's Different

| Feature          | Qwen Code          | proto                                                                          |
| ---------------- | ------------------ | ------------------------------------------------------------------------------ |
| Default model    | Qwen3-Coder        | Any (configurable)                                                             |
| Task management  | In-memory JSON     | [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (SQLite + JSONL) |
| MCP servers      | None               | Configurable via `~/.qwen/settings.json`                                       |
| Plugin discovery | Qwen only          | Auto-discovers Claude Code plugins from `~/.claude/plugins/`                   |
| Skills           | Nested superpowers | Flat bundled skills (16 skills, all discoverable)                              |

## Installation

Requires Node.js 20+ and Rust toolchain (for beads_rust).

```bash
# Clone and build
git clone https://github.com/protoLabsAI/quad-code.git
cd quad-code
npm install
npm run build

# Link globally
npm link

# Install beads_rust task manager (optional but recommended)
cargo install beads_rust
```

## Quick Start

```bash
# Start proto
proto

# One-shot mode
proto -p "explain this codebase"
```

On first launch, run `/auth` to configure your model provider.

## Configuration

proto uses `~/.qwen/settings.json` for global config and `.qwen/settings.json` for per-project overrides.

### Model Providers

Connect any OpenAI-compatible endpoint, Anthropic, or Gemini:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6 (via gateway)",
        "baseUrl": "http://your-gateway:4000/v1",
        "envKey": "GATEWAY_API_KEY"
      }
    ]
  },
  "env": {
    "GATEWAY_API_KEY": "sk-..."
  },
  "security": {
    "auth": { "selectedType": "openai" }
  },
  "model": { "name": "claude-sonnet-4-6" }
}
```

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

| Command     | Description                     |
| ----------- | ------------------------------- |
| `/help`     | Show available commands         |
| `/auth`     | Configure authentication        |
| `/model`    | Switch models                   |
| `/skills`   | List available skills           |
| `/clear`    | Clear conversation              |
| `/compress` | Compress history to save tokens |
| `/stats`    | Session info                    |
| `/exit`     | Exit proto                      |

## Keyboard Shortcuts

| Shortcut  | Action                   |
| --------- | ------------------------ |
| `Ctrl+C`  | Cancel current operation |
| `Ctrl+D`  | Exit (on empty line)     |
| `Up/Down` | Navigate command history |

## IDE Integration

proto works with VS Code, Zed, and JetBrains IDEs. See the upstream [Qwen Code docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview) for setup instructions.

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
