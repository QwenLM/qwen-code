# Qwen Code - Project Context

## Project Overview

**Qwen Code** is an open-source AI agent for the terminal, optimized for [Qwen3-Coder](https://github.com/QwenLM/Qwen3-Coder). It helps developers understand large codebases, automate tedious work, and ship faster.

This project is based on [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) with adaptations to better support Qwen-Coder models.

### Key Features

- **OpenAI-compatible, OAuth free tier**: Use an OpenAI-compatible API, or sign in with Qwen OAuth to get 1,000 free requests/day
- **Agentic workflow, feature-rich**: Rich built-in tools (Skills, SubAgents, Plan Mode) for a full agentic workflow
- **Terminal-first, IDE-friendly**: Built for developers who live in the command line, with optional integration for VS Code, Zed, and JetBrains IDEs

## Technology Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.3+
- **Package Manager**: npm with workspaces
- **Build Tool**: esbuild
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **UI Framework**: Ink (React for CLI)
- **React Version**: 19.x

## Project Structure

```
├── packages/
│   ├── cli/              # Command-line interface (main entry point)
│   ├── core/             # Core backend logic and tool implementations
│   ├── sdk-java/         # Java SDK
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

- **Tools**: File operations (read, write, edit, glob, grep), shell execution, web fetch, LSP integration, MCP client
- **Subagents**: Task delegation to specialized agents
- **Skills**: Reusable skill system
- **Models**: Model configuration and registry for Qwen and OpenAI-compatible APIs
- **Services**: Git integration, file discovery, session management
- **LSP Support**: Language Server Protocol integration
- **MCP**: Model Context Protocol implementation

## Building and Running

### Prerequisites

- **Node.js**: ~20.19.0 for development (use nvm to manage versions)
- **Git**
- For sandboxing: Docker or Podman (optional but recommended)

### Setup

```bash
# Clone and install
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code
npm install
```

### Build Commands

```bash
# Build all packages
npm run build

# Build everything including sandbox and VSCode companion
npm run build:all

# Build only packages
npm run build:packages

# Development mode with hot reload
npm run dev

# Bundle for distribution
npm run bundle
```

### Running

```bash
# Start interactive CLI
npm start

# Or after global installation
qwen

# Debug mode
npm run debug

# With environment variables
DEBUG=1 npm start
```

### Testing

```bash
# Run all unit tests
npm run test

# Run integration tests (no sandbox)
npm run test:e2e

# Run all integration tests with different sandbox modes
npm run test:integration:all

# Terminal benchmark tests
npm run test:terminal-bench
```

### Code Quality

```bash
# Run all checks (lint, format, build, test)
npm run preflight

# Lint only
npm run lint
npm run lint:fix

# Format only
npm run format

# Type check
npm run typecheck
```

## Development Conventions

### Code Style

- **Strict TypeScript**: All strict flags enabled (`strictNullChecks`, `noImplicitAny`, etc.)
- **Module System**: ES modules (`"type": "module"`)
- **Import Style**: Node.js native ESM with `.js` extensions in imports
- **No Relative Imports Between Packages**: ESLint enforces this restriction

### Key Configuration Files

- `tsconfig.json`: Base TypeScript configuration with strict settings
- `eslint.config.js`: ESLint flat config with custom rules
- `esbuild.config.js`: Build configuration
- `vitest.config.ts`: Test configuration

### Import Patterns

```typescript
// Within a package - use relative paths
import { something } from './utils/something.js';

// Between packages - use package names
import { Config } from '@qwen-code/qwen-code-core';
```

### Testing Patterns

- Unit tests co-located with source files (`.test.ts` suffix)
- Integration tests in separate `integration-tests/` directory
- Uses Vitest with globals enabled
- Mocking via `msw` for HTTP, `memfs`/`mock-fs` for filesystem

### Architecture Patterns

#### Tools System

All tools extend `BaseDeclarativeTool` or implement the tool interfaces:

- Located in `packages/core/src/tools/`
- Each tool has a corresponding `.test.ts` file
- Tools are registered in the tool registry

#### Subagents System

Task delegation framework:

- Configuration stored as Markdown + YAML frontmatter
- Supports both project-level and user-level subagents
- Event-driven architecture for UI updates

#### Configuration System

Hierarchical configuration loading:

1. Default values
2. User settings (`~/.qwen/settings.json`)
3. Project settings (`.qwen/settings.json`)
4. Environment variables
5. CLI flags

### Authentication Methods

1. **Qwen OAuth** (recommended): Browser-based OAuth flow
2. **OpenAI-compatible API**: Via `OPENAI_API_KEY` environment variable

Environment variables for API mode:

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional
export OPENAI_MODEL="gpt-4o"                        # optional
```

## Debugging

### VS Code

Press `F5` to launch with debugger attached, or:

```bash
npm run debug  # Runs with --inspect-brk
```

### React DevTools (for CLI UI)

```bash
DEV=true npm start
npx react-devtools@4.28.5
```

### Sandbox Debugging

```bash
DEBUG=1 qwen
```

## Documentation

- User documentation: <https://qwenlm.github.io/qwen-code-docs/>
- Local docs development:

  ```bash
  cd docs-site
  npm install
  npm run link  # Links ../docs to content
  npm run dev   # http://localhost:3000
  ```

## Contributing Guidelines

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines. Key points:

1. Link PRs to existing issues
2. Keep PRs small and focused
3. Use Draft PRs for WIP
4. Ensure `npm run preflight` passes
5. Update documentation for user-facing changes
6. Follow Conventional Commits for commit messages

## Useful Commands Reference

| Command             | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `npm start`         | Start CLI in interactive mode                                        |
| `npm run dev`       | Development mode with hot reload                                     |
| `npm run build`     | Build all packages                                                   |
| `npm run test`      | Run unit tests                                                       |
| `npm run test:e2e`  | Run integration tests                                                |
| `npm run preflight` | Full CI check (clean, install, format, lint, build, typecheck, test) |
| `npm run lint`      | Run ESLint                                                           |
| `npm run format`    | Run Prettier                                                         |
| `npm run clean`     | Clean build artifacts                                                |

## Session Commands (within CLI)

- `/help` - Display available commands
- `/clear` - Clear conversation history
- `/compress` - Compress history to save tokens
- `/stats` - Show session information
- `/bug` - Submit bug report
- `/exit` or `/quit` - Exit Qwen Code

---
