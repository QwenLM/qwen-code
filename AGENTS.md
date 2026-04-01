# AGENTS.md - proto Project Context

## Project Overview

**proto** is a multi-model AI agent for the terminal. It connects to any OpenAI-compatible, Anthropic, or Gemini API endpoint. It's a fork of Qwen Code (which is based on Gemini CLI), rebuilt as a model-agnostic coding agent with features from the protoLabs Studio ecosystem.

### Key Features

- **Multi-model**: Connect any OpenAI-compatible, Anthropic, or Gemini endpoint
- **beads_rust task management**: SQLite-backed persistent tasks via `br` CLI with task claiming
- **MCP support**: Configure MCP servers in settings for tool extensions
- **Plugin discovery**: Auto-discovers Claude Code plugins from `~/.claude/plugins/`
- **Agentic workflow**: Rich built-in tools (Skills, SubAgents, Plan Mode)
- **Agent teams**: Background agent spawning, shared task list, inter-agent mailbox, `/team` command
- **Hooks system**: Command, HTTP, and prompt hook types with async execution and fine-grained `if` filtering
- **Harness engineering**: Pre-flight baseline check, post-edit verification, 9-section compression, memory consolidation
- **Terminal-first, IDE-friendly**: Built for developers who live in the command line

## Technology Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.3+
- **Package Manager**: npm with workspaces
- **Build Tool**: esbuild
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **UI Framework**: Ink (React for CLI)
- **React Version**: 19.x
- **Task Management**: beads_rust (`br` CLI, SQLite + JSONL)

## Project Structure

```
├── packages/
│   ├── cli/              # Command-line interface (main entry point)
│   ├── core/             # Core backend logic and tool implementations
│   ├── sdk-typescript/   # TypeScript SDK
│   ├── test-utils/       # Shared testing utilities
│   ├── vscode-ide-companion/  # VS Code extension companion
│   ├── webui/            # Web UI components
│   └── zed-extension/    # Zed editor extension
├── scripts/              # Build and utility scripts
├── docs/                 # Documentation source
├── docs-site/            # Documentation website (Next.js)
├── integration-tests/    # End-to-end integration tests
└── eslint-rules/         # Custom ESLint rules
```

### Package Details

#### `@qwen-code/qwen-code` (packages/cli/)

The main CLI package providing:

- Interactive terminal UI using Ink/React
- Non-interactive/headless mode
- Authentication handling (OAuth, API keys)
- Configuration management
- Command system (`/help`, `/clear`, `/compress`, etc.)

#### `@qwen-code/qwen-code-core` (packages/core/)

Core library containing:

- **Tools**: File operations (read, write, edit, glob, grep), shell execution, web fetch, LSP integration, MCP client, task management (beads_rust)
- **Memory**: File-per-memory system with YAML frontmatter, 4-type taxonomy (user/feedback/project/reference), auto-extraction agent, MEMORY.md index
- **Subagents**: Task delegation with `disallowedTools`, `permissionMode`, background execution
- **Agent Teams**: Coordinator agent, TeamMailbox, shared task claiming, team config + lifecycle
- **Skills**: 18 bundled skills for agentic workflows (incl. adversarial-verification, coding-agent-standards)
- **Hooks**: Command, HTTP, prompt hook types; async execution; `if` field for arg filtering; team lifecycle events
- **Models**: Model configuration and registry for any OpenAI-compatible API
- **Services**: Git integration, file discovery, session management
- **LSP Support**: Language Server Protocol integration
- **MCP**: Model Context Protocol client for tool extensions

## Building and Running

### Prerequisites

- **Node.js**: ~20.19.0 for development (use nvm to manage versions)
- **Git**
- **Rust toolchain** (optional, for beads_rust task management)

### Setup

```bash
git clone https://github.com/protoLabsAI/protoCLI.git
cd protoCLI
npm install
```

### Build Commands

```bash
# Build and link globally (recommended)
npm run ship

# Build all packages
npm run build

# Development mode (runs from source, no build needed)
npm run dev
```

### Running

```bash
# Start interactive CLI
proto

# One-shot mode
proto -p "your question"

# Or from the repo
npm start
```

### Testing

```bash
npm run test          # Unit tests
npm run test:e2e      # Integration tests
```

### Code Quality

```bash
npm run preflight     # All checks (lint, format, build, test)
npm run lint          # ESLint
npm run format        # Prettier
npm run typecheck     # Type check
```

## Configuration

Settings live in `~/.proto/settings.json` (global) and `.proto/settings.json` (per-project).

Key config sections:

- `modelProviders` — API endpoints and model definitions
- `mcpServers` — MCP server configurations
- `env` — API keys and environment variables
- `model.name` — Default model

## Memory System

Proto uses a file-per-memory architecture with YAML frontmatter. Each memory is a `.md` file in `.proto/memory/` (project) or `~/.proto/memory/` (global). Four types: user, feedback, project, reference.

A `MEMORY.md` index is auto-generated and loaded into the system prompt. After each turn, a background extraction agent reviews recent messages and auto-creates memories.

## Session Commands (within CLI)

- `/help` - Display available commands
- `/model` - Switch models
- `/skills` - List available skills
- `/memory show` - Display loaded memory content
- `/memory list` - List all memories with metadata
- `/memory add <fact>` - Save a memory
- `/memory forget <name>` - Delete a memory
- `/memory refresh` - Reload from disk
- `/clear` - Clear conversation history
- `/compress` - Compress history to save tokens
- `/stats` - Show session information
- `/exit` or `/quit` - Exit proto
