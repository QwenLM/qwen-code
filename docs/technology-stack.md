# Qwen Code Technology Stack

## Overview

Qwen Code is a TypeScript-based monorepo containing 8 packages that implement an AI-powered coding assistant. The project uses Node.js >= 20.0 and is built with TypeScript for type safety.

## Technology Stack by Part

### 1. CLI (`packages/cli`)

| Category            | Technology                | Version | Justification             |
| ------------------- | ------------------------- | ------- | ------------------------- |
| Runtime             | Node.js                   | >= 20   | Specified in engines      |
| Language            | TypeScript                | 5.3.3   | Used for all source files |
| UI Framework        | React                     | 19.1.0  | Ink-based terminal UI     |
| UI Library          | Ink                       | 6.2.3   | React-based CLI rendering |
| CLI Utilities       | Yargs                     | 17.7.2  | Argument parsing          |
| API Client          | @google/genai             | 1.30.0  | Google AI integration     |
| MCP SDK             | @modelcontextprotocol/sdk | 1.25.1  | Model Context Protocol    |
| Validation          | Zod                       | 3.23.8  | Schema validation         |
| Git Integration     | simple-git                | 3.28.0  | Git operations            |
| File Operations     | glob                      | 10.5.0  | File finding              |
| Syntax Highlighting | highlight.js              | 11.11.1 | Code syntax highlighting  |
| Testing             | Vitest                    | 3.1.1   | Unit testing framework    |

### 2. Core (`packages/core`)

| Category        | Technology                | Version | Justification             |
| --------------- | ------------------------- | ------- | ------------------------- |
| Runtime         | Node.js                   | >= 20   | Specified in engines      |
| Language        | TypeScript                | 5.3.3   | Used for all source files |
| AI SDKs         | OpenAI                    | 5.11.0  | OpenAI API integration    |
| AI SDKs         | @anthropic-ai/sdk         | 0.36.1  | Anthropic API integration |
| AI SDKs         | @google/genai             | 1.30.0  | Google AI integration     |
| MCP SDK         | @modelcontextprotocol/sdk | 1.25.1  | Model Context Protocol    |
| Telemetry       | OpenTelemetry             | 0.203.0 | Tracing and metrics       |
| Terminal        | @xterm/headless           | 5.5.0   | xterm integration         |
| File Watching   | chokidar                  | 4.0.3   | File system watching      |
| Git Integration | simple-git                | 3.28.0  | Git operations            |
| File Operations | glob                      | 10.5.0  | File finding              |
| HTML Processing | marked                    | 15.0.12 | Markdown rendering        |
| HTTP Client     | undici                    | 6.22.0  | HTTP requests             |
| WebSocket       | ws                        | 8.18.0  | WebSocket support         |
| Testing         | Vitest                    | 3.1.1   | Unit testing framework    |
| Mocking         | msw                       | 2.3.4   | Mock Service Worker       |

### 3. Web UI (`packages/webui`)

| Category        | Technology   | Version     | Justification         |
| --------------- | ------------ | ----------- | --------------------- |
| Framework       | React        | 18.x / 19.x | Peer dependency       |
| Build Tool      | Vite         | 5.0.0       | Fast build tool       |
| Type Checking   | TypeScript   | 5.0.0       | Language support      |
| Styling         | Tailwind CSS | 3.4.0       | Utility-first CSS     |
| UI Components   | Storybook    | 10.1.11     | Component development |
| Testing         | Vitest       | 3.2.4       | Unit testing          |
| Browser Testing | Playwright   | 1.57.0      | E2E browser testing   |
| Markdown        | markdown-it  | 14.1.0      | Markdown rendering    |

### 4. TypeScript SDK (`packages/sdk-typescript`)

| Category   | Technology                | Version   | Justification             |
| ---------- | ------------------------- | --------- | ------------------------- |
| Runtime    | Node.js                   | >= 18.0.0 | Specified in engines      |
| Language   | TypeScript                | 5.4.5     | Used for all source files |
| MCP SDK    | @modelcontextprotocol/sdk | 1.25.1    | Model Context Protocol    |
| Validation | Zod                       | 3.25.0    | Schema validation         |
| Build Tool | esbuild                   | 0.25.12   | Fast bundler              |
| Testing    | Vitest                    | 1.6.0     | Unit testing framework    |

### 5. Java SDK (`packages/sdk-java`)

| Category        | Technology      | Version  | Justification       |
| --------------- | --------------- | -------- | ------------------- |
| Runtime         | Java            | >= 1.8   | Specified in README |
| Build Tool      | Maven           | >= 3.6.0 | Build system        |
| JSON Processing | fastjson2       | Latest   | JSON serialization  |
| Logging         | logback-classic | Latest   | SLF4J logging       |
| Utilities       | commons-lang3   | Latest   | Apache Commons      |
| Testing         | JUnit 5         | Latest   | Testing framework   |

### 6. VS Code Extension (`packages/vscode-ide-companion`)

| Category      | Technology                | Version | Justification          |
| ------------- | ------------------------- | ------- | ---------------------- |
| Platform      | VS Code                   | ^1.85.0 | Target IDE             |
| Language      | TypeScript                | 5.8.3   | Used for source files  |
| Web UI        | @qwen-code/webui          | \*      | Shared UI components   |
| MCP SDK       | @modelcontextprotocol/sdk | 1.25.1  | Model Context Protocol |
| Web Framework | Express                   | 5.1.0   | Local server           |
| React         | react                     | 19.2.4  | UI components          |
| Validation    | Zod                       | 3.25.76 | Schema validation      |
| Markdown      | markdown-it               | 14.1.0  | Markdown rendering     |
| Testing       | Vitest                    | 3.2.4   | Unit testing framework |
| Build Tool    | esbuild                   | 0.25.3  | Fast bundler           |
| Packaging     | vsce                      | 3.6.0   | VS Code packaging      |

### 7. Zed Extension (`packages/zed-extension`)

| Category | Technology                | Version | Justification          |
| -------- | ------------------------- | ------- | ---------------------- |
| Platform | Zed                       | Latest  | Target IDE             |
| Language | TypeScript                | Latest  | Source language        |
| MCP SDK  | @modelcontextprotocol/sdk | Latest  | Model Context Protocol |

### 8. Test Utils (`packages/test-utils`)

| Category        | Technology           | Version | Justification         |
| --------------- | -------------------- | ------- | --------------------- |
| Runtime         | Node.js              | >= 20   | Inherited from root   |
| Language        | TypeScript           | Latest  | Used for source files |
| Testing         | Vitest               | Latest  | Testing utilities     |
| Testing Library | @testing-library/dom | 10.4.1  | DOM testing           |

## Shared Infrastructure

### Build System

| Tool       | Purpose         | Version       |
| ---------- | --------------- | ------------- |
| npm        | Package manager | 10+           |
| TypeScript | Type checker    | 5.3.3 - 5.8.3 |
| esbuild    | Bundler         | 0.25.x        |
| Vitest     | Test runner     | 1.6.0 - 3.2.4 |
| ESLint     | Linting         | 9.x           |
| Prettier   | Formatting      | 3.x           |

### Development Tools

| Tool         | Purpose              |
| ------------ | -------------------- |
| Husky        | Git hooks            |
| lint-staged  | Staged file linting  |
| npm-run-all2 | Script running       |
| tsx          | TypeScript execution |

### CI/CD

| Tool           | Purpose         |
| -------------- | --------------- |
| GitHub Actions | CI/CD pipelines |
| Vitest         | Test execution  |
| ESLint         | Code quality    |

## Architecture Patterns

### Monorepo Structure

The project uses npm workspaces to manage multiple packages in a single repository:

- **Root**: Configuration, scripts, and workspace metadata
- **packages/**: Individual packages with their own package.json
- **Shared dependencies**: Hoisted to root for consistency

### Component Architecture

- **CLI Package**: React-based terminal UI using Ink
- **Core Package**: Backend orchestration of AI models and tools
- **Web UI**: React components with Tailwind CSS
- **SDKs**: Type-safe programmatic interfaces

### AI Integration Pattern

```
User Input (CLI/API)
        ↓
Core Package (Orchestration)
        ↓
    ┌────┴────┐
    ↓         ↓
OpenAI    Anthropic
Google    MCP Servers
        ↓
Tool Execution
        ↓
Response to User
```

## Data Flow

1. **User Input**: Terminal UI or API call
2. **Prompt Construction**: Core package builds prompts with context
3. **Model API Call**: Request sent to configured AI provider
4. **Tool Execution**: If model requests tools, Core executes them
5. **Response**: Final response formatted and displayed

## Dependencies Summary

### Key Runtime Dependencies

- `@google/genai` - Google AI integration
- `@anthropic-ai/sdk` - Anthropic Claude integration
- `openai` - OpenAI API integration
- `@modelcontextprotocol/sdk` - MCP support
- `react` / `ink` - CLI UI framework
- `zod` - Schema validation

### Key Dev Dependencies

- `typescript` - Type safety
- `vitest` - Testing
- `eslint` - Code quality
- `prettier` - Code formatting
- `husky` - Git hooks
