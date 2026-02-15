# Qwen Code Documentation Index

## Project Overview

**Qwen Code** is an open-source AI agent that lives in your terminal. It helps developers understand large codebases, automate tedious work, and ship faster.

- **Repository**: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)
- **Version**: 0.9.0
- **License**: Apache 2.0 / MIT
- **Primary Language**: TypeScript
- **Runtime**: Node.js >= 20.0.0

## Quick Reference

| Attribute       | Value                     |
| --------------- | ------------------------- |
| Repository Type | Monorepo (npm workspaces) |
| Packages        | 8 packages                |
| Architecture    | Layered (CLI → Core → AI) |
| Test Framework  | Vitest                    |
| Build Tool      | esbuild                   |

## Tech Stack Summary

| Layer        | Technology                      |
| ------------ | ------------------------------- |
| CLI UI       | React 19 + Ink                  |
| Web UI       | React 18/19 + Tailwind CSS      |
| Backend      | Node.js 20+                     |
| AI Providers | OpenAI, Anthropic, Google GenAI |
| Protocol     | Model Context Protocol (MCP)    |
| Testing      | Vitest, Playwright              |
| Bundling     | esbuild                         |

## Documentation Sections

### Getting Started

- [README](../README.md) - Project overview and quick start
- [Installation Guide](users/overview.md) - Setup instructions
- [Quick Start](users/quickstart.md) - First-time usage

### Developer Guide

- [Architecture](./developers/architecture.md) - System architecture
- [Development Guide](./development-guide.md) - Setup and workflow
- [Source Tree Analysis](./source-tree-analysis.md) - Directory structure
- [Component Inventory](./component-inventory.md) - UI components catalog
- [Technology Stack](./technology-stack.md) - Dependencies and versions

### SDK Documentation

- [TypeScript SDK](./developers/sdk-typescript.md) - Node.js SDK guide
- [Java SDK](./developers/sdk-java.md) - Java SDK guide

### Contributing

- [Contributing Guidelines](../CONTRIBUTING.md) - How to contribute
- [Code Style](developers/contributing.md) - Linting and formatting
- [Testing Guide](developers/contributing.md#testing) - Test standards
- [Pull Request Process](../CONTRIBUTING.md#pull-request-guidelines)

### Existing Documentation

- [Architecture Overview](./developers/architecture.md)
- [Roadmap](./developers/roadmap.md)
- [SDK TypeScript](./developers/sdk-typescript.md)
- [SDK Java](./developers/sdk-java.md)

## Generated Documentation

| Document                                          | Description                      | Status     |
| ------------------------------------------------- | -------------------------------- | ---------- |
| [Architecture](./architecture.md)                 | System architecture and patterns | ✓ Complete |
| [Technology Stack](./technology-stack.md)         | Dependencies and versions        | ✓ Complete |
| [Source Tree Analysis](./source-tree-analysis.md) | Directory structure              | ✓ Complete |
| [Component Inventory](./component-inventory.md)   | UI components catalog            | ✓ Complete |
| [Development Guide](./development-guide.md)       | Setup and workflow               | ✓ Complete |

## Package Structure

```
qwen-code/
├── packages/
│   ├── cli/                      # Terminal CLI application
│   │   ├── Entry: dist/index.js
│   │   ├── Command: qwen
│   │   └── UI: React + Ink
│   │
│   ├── core/                     # Backend orchestration
│   │   ├── AI: OpenAI, Anthropic, Google
│   │   ├── Tools: File, Shell, Fetch, MCP
│   │   └── Models: Message, Session, Tool
│   │
│   ├── webui/                    # Shared React components
│   │   ├── Components: Button, Input, Modal
│   │   ├── Chat: MessageList, Input
│   │   └── Export: @qwen-code/webui
│   │
│   ├── sdk-typescript/           # Node.js SDK
│   │   └── Import: @qwen-code/sdk
│   │
│   ├── sdk-java/                 # Java SDK
│   │   └── Import: com.alibaba:qwencode-sdk
│   │
│   ├── vscode-ide-companion/     # VS Code extension
│   │   └── Marketplace: qwen-code-vscode
│   │
│   ├── zed-extension/            # Zed editor extension
│   │   └── Marketplace: Zed
│   │
│   └── test-utils/               # Testing utilities
│       └── Import: @qwen-code/qwen-code-test-utils
│
├── scripts/                      # Build scripts
├── integration-tests/             # E2E tests
└── docs/                         # Documentation
```

## Entry Points

| Package        | Entry Point                              | Usage                                       |
| -------------- | ---------------------------------------- | ------------------------------------------- |
| CLI            | `packages/cli/dist/index.js`             | `qwen` command                              |
| Core           | `packages/core/dist/index.js`            | `import from '@qwen-code/qwen-code-core'`   |
| SDK TypeScript | `packages/sdk-typescript/dist/index.mjs` | `import { Qwen } from '@qwen-code/sdk'`     |
| WebUI          | `packages/webui/dist/index.js`           | `import { Button } from '@qwen-code/webui'` |

## Key Concepts

### Agentic Workflow

1. **User Input**: Terminal command or API call
2. **Prompt Construction**: Context + history + tools
3. **Model API**: Send to configured AI provider
4. **Tool Execution**: If model requests tools
5. **Response**: Formatted output to user

### Tools System

Built-in tools available to the AI:

| Tool         | Capability              |
| ------------ | ----------------------- |
| `file-ops`   | Read, write, edit files |
| `bash`       | Execute shell commands  |
| `glob`       | Find files by pattern   |
| `grep`       | Search file content     |
| `fetch`      | HTTP GET requests       |
| `web-search` | Search the web          |
| `mcp`        | Connect to MCP servers  |

### Configuration Layers

Precedence (highest to lowest):

1. Command-line arguments
2. Environment variables
3. Project settings (`.qwen/settings.json`)
4. User settings (`~/.qwen/settings.json`)
5. System settings
6. Default values

## IDE Integration

### VS Code

- **Extension**: `qwen-code-vscode-ide-companion`
- **Features**: Chat interface, diff preview, commands
- **Activation**: On startup or command palette

### Zed

- **Extension**: `zed-extension`
- **Features**: Native Zed integration
- **Activation**: Editor command

## AI Provider Support

| Provider  | Model Support        | Configuration       |
| --------- | -------------------- | ------------------- |
| OpenAI    | GPT-4, GPT-4o, etc.  | `OPENAI_API_KEY`    |
| Anthropic | Claude 3.5, Claude 3 | `ANTHROPIC_API_KEY` |
| Google    | Gemini Pro           | `GOOGLE_API_KEY`    |
| Qwen      | Qwen3-Coder          | OAuth or API key    |

## Development Commands

| Command             | Purpose               |
| ------------------- | --------------------- |
| `npm install`       | Install dependencies  |
| `npm run build`     | Build all packages    |
| `npm start`         | Run CLI interactively |
| `npm test`          | Run all tests         |
| `npm run lint`      | Lint code             |
| `npm run format`    | Format code           |
| `npm run typecheck` | TypeScript checking   |
| `npm run preflight` | Full quality check    |

## Getting Help

- **Discord**: https://discord.gg/ycKBjdNd
- **GitHub Issues**: Report bugs
- **CLI Help**: Run `/help` in interactive mode
- **Documentation**: See [Users Guide](users/overview.md)

## Next Steps

1. **New Users**: Read the [Quick Start](users/quickstart.md)
2. **Contributors**: Read [Contributing Guidelines](../CONTRIBUTING.md)
3. **SDK Users**: See [TypeScript SDK](./developers/sdk-typescript.md)
4. **Architecture**: See [Architecture Overview](./developers/architecture.md)

## Metadata

| Field               | Value            |
| ------------------- | ---------------- |
| Generated           | 2026-02-03       |
| Workflow            | document-project |
| Scan Level          | exhaustive       |
| Total Parts         | 8                |
| Documentation Files | 10+              |
