# Qwen Code Architecture

## Executive Summary

Qwen Code is an open-source AI coding assistant that operates from the terminal. It provides an interactive agentic workflow optimized for Qwen3-Coder, enabling developers to understand large codebases, automate tedious work, and ship faster. The system supports multiple AI providers (OpenAI, Anthropic, Google), IDE integrations (VS Code, Zed), and programmatic access via TypeScript and Java SDKs.

## Technology Stack

| Layer          | Technology                      | Version    | Purpose                |
| -------------- | ------------------------------- | ---------- | ---------------------- |
| Runtime        | Node.js                         | >= 20      | JavaScript runtime     |
| Language       | TypeScript                      | 5.3.x      | Type-safe development  |
| CLI UI         | React + Ink                     | 19.x / 6.x | Terminal-based UI      |
| Core Framework | React                           | 18.x-19.x  | UI components          |
| AI SDKs        | OpenAI, Anthropic, Google GenAI | Latest     | Model API integration  |
| Protocol       | MCP                             | 1.25.x     | Model Context Protocol |
| Testing        | Vitest                          | 3.x        | Unit testing           |
| Build          | esbuild                         | 0.25.x     | Fast bundling          |

## Architecture Pattern

### Monorepo Structure with Workspace Isolation

```
qwen-code/ (root workspace)
├── package.json (workspace config)
├── packages/
│   ├── cli/          → Terminal application
│   ├── core/         → Backend orchestration (library)
│   ├── webui/        → Shared React components
│   ├── sdk-typescript/ → Node.js SDK
│   ├── sdk-java/     → Java SDK
│   ├── vscode-ide-companion/ → VS Code extension
│   ├── zed-extension/ → Zed editor extension
│   └── test-utils/   → Testing utilities
```

Each package:

- Has independent `package.json`
- Can be published independently
- Maintains its own build pipeline
- Uses hoisted shared dependencies

### Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Interface Layer                      │
├─────────────────┬─────────────────┬─────────────────────────┤
│   CLI (Ink)     │   VS Code       │     TypeScript SDK      │
│   Terminal UI   │   Extension     │     Programmatic        │
├─────────────────┴─────────────────┴─────────────────────────┤
│                    Service Layer                            │
├─────────────────┬─────────────────┬─────────────────────────┤
│   Commands      │   Services      │     API Client          │
│   History       │   Config        │     Session Manager     │
├─────────────────┴─────────────────┴─────────────────────────┤
│                   Core Orchestration                         │
├─────────────────────────────────────────────────────────────┤
│   Prompt Builder  │  Tool Registry  │  Model Connector       │
├─────────────────────────────────────────────────────────────┤
│                    AI Integration Layer                      │
├─────────────────┬─────────────────┬─────────────────────────┤
│   OpenAI        │   Anthropic     │    Google GenAI         │
├─────────────────┴─────────────────┴─────────────────────────┤
│                   Tool Execution Layer                       │
├─────────────────────────────────────────────────────────────┤
│   File Operations  │  Shell Exec  │  Web Fetch  │  MCP      │
└─────────────────────────────────────────────────────────────┘
```

## Component Overview

### CLI Package (`packages/cli`)

**Responsibility**: User-facing terminal interface

**Key Components**:

| Component          | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `InputProcessor`   | Handles text, slash commands, @file references |
| `SessionManager`   | Maintains conversation history                 |
| `ResponseRenderer` | Formats output with syntax highlighting        |
| `ThemeManager`     | UI customization                               |
| `ConfigLoader`     | JSON/EV settings management                    |

**Entry Point**: `packages/cli/src/index.ts`

### Core Package (`packages/core`)

**Responsibility**: Backend orchestration and AI communication

**Key Modules**:

| Module           | Purpose                         |
| ---------------- | ------------------------------- |
| `PromptBuilder`  | Constructs prompts with context |
| `ModelConnector` | Manages AI API connections      |
| `ToolRegistry`   | Registers and executes tools    |
| `SessionState`   | Maintains conversation state    |
| `Telemetry`      | Metrics and observability       |

**Entry Point**: `packages/core/src/index.ts`

### Built-in Tools

Located in `packages/core/src/tools/`:

| Tool        | Description                    |
| ----------- | ------------------------------ |
| `FileOps`   | Read, write, edit files        |
| `Bash`      | Execute shell commands         |
| `Glob`      | Find files by pattern          |
| `Grep`      | Search file content            |
| `WebFetch`  | HTTP GET requests              |
| `WebSearch` | Search the web                 |
| `MCP`       | Model Context Protocol clients |

### WebUI Package (`packages/webui`)

**Responsibility**: Shared React components for IDE extensions

**Component Categories**:

| Category | Examples                                 |
| -------- | ---------------------------------------- |
| Chat     | `ChatWindow`, `MessageList`, `InputArea` |
| Common   | `Button`, `Input`, `Modal`               |
| Icons    | `SendIcon`, `SettingsIcon`               |
| Feedback | `LoadingSpinner`, `ErrorMessage`         |

### SDK Packages

**TypeScript SDK** (`packages/sdk-typescript`):

- Programmatic access to Qwen Code
- MCP protocol support
- Node.js >= 18

**Java SDK** (`packages/sdk-java`):

- Maven-based distribution
- Java >= 1.8 compatibility
- Minimal experimental SDK

### IDE Extensions

**VS Code** (`packages/vscode-ide-companion`):

- Webview-based chat interface
- Diff preview and acceptance
- Commands palette integration

**Zed** (`packages/zed-extension`):

- Native Zed extension
- In-editor AI assistance

## Data Architecture

### Conversation State

```typescript
interface ConversationState {
  id: string;
  messages: Message[];
  context: ContextFile[];
  model: string;
  tools: ToolDefinition[];
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
}
```

### Tool Execution Flow

```
1. User Input
   ↓
2. Prompt Construction (context + history)
   ↓
3. Model API Call
   ↓
4a. Text Response → Display to User
   ↓
4b. Tool Request → Execute Tool
   ↓
5. Tool Result → Model API
   ↓
6. Final Response → Display
```

### Configuration Precedence

1. Command-line arguments (highest)
2. Environment variables
3. Project settings (`.qwen/settings.json`)
4. User settings (`~/.qwen/settings.json`)
5. System settings
6. Defaults (lowest)

## API Design

### REST/CLI Interface

```bash
# Interactive mode
qwen

# Headless mode
qwen -p "explain this code"

# Options
--model MODEL_NAME
--context FILE1 FILE2
--no-cache
```

### SDK Interface

**TypeScript**:

```typescript
import { Qwen } from '@qwen-code/sdk';

const client = new Qwen({
  model: 'qwen3-coder',
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.complete({
  prompt: 'Explain this function',
  context: ['src/main.ts'],
});
```

**Java**:

```java
QwenClient client = new QwenClient(config);
Response response = client.execute("Explain this method");
```

### MCP Protocol

```typescript
// MCP Tool Definition
interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Schema>;
    required: string[];
  };
}
```

## Integration Architecture

### AI Provider Integration

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   OpenAI     │     │  Anthropic   │     │ Google GenAI │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                            ↓
                  ┌─────────────────┐
                  │  ModelConnector │
                  │  (Unified API) │
                  └────────┬────────┘
                           │
                  ┌────────┴────────┐
                  │ Prompt Builder  │
                  └─────────────────┘
```

### IDE Integration Flow

```
User in IDE
    ↓
Extension (VS Code/Zed)
    ↓
WebView/Native UI
    ↓
Express Server (local)
    ↓
MCP Protocol
    ↓
Core Package
    ↓
Model API
    ↓
Response → UI → User
```

## Source Tree

```
packages/
├── cli/src/
│   ├── commands/      # Slash commands
│   ├── ui/            # Terminal UI
│   ├── services/      # CLI services
│   └── index.ts       # Entry point
├── core/src/
│   ├── tools/         # Built-in tools
│   ├── services/     # Core services
│   ├── prompts/       # Prompt templates
│   ├── models/       # Data models
│   └── index.ts      # Entry point
├── webui/src/
│   ├── components/    # React components
│   ├── hooks/        # React hooks
│   └── index.ts      # Exports
└── sdk-typescript/src/
    ├── client/       # SDK client
    └── index.ts      # Entry point
```

## Development Workflow

### Build Pipeline

```
Source (TypeScript)
    ↓
TypeScript Compilation (tsc)
    ↓
esbuild Bundling
    ↓
Output (JavaScript + Types)
```

### Test Strategy

| Level       | Framework  | Coverage Target |
| ----------- | ---------- | --------------- |
| Unit        | Vitest     | > 80%           |
| Integration | Vitest     | Core flows      |
| E2E         | Playwright | Critical paths  |

### CI/CD Pipeline

```
Git Push
    ↓
GitHub Actions
    ├─ Lint (ESLint)
    ├─ TypeCheck (tsc)
    ├─ Build (esbuild)
    ├─ Unit Tests (Vitest)
    └─ Integration Tests
    ↓
Publish / Release
```

## Deployment Architecture

### Distribution Methods

| Method              | Target      | Build Output       |
| ------------------- | ----------- | ------------------ |
| npm                 | Node.js CLI | `dist/cli.js`      |
| VS Code Marketplace | VS Code     | `.vsix` package    |
| Zed Marketplace     | Zed Editor  | Extension archive  |
| Maven Central       | Java        | `qwencode-sdk.jar` |

### Sandboxing

Qwen Code supports optional sandboxing for:

- File system isolation
- Shell command containment
- Network access control

**Providers**:

- Docker
- Podman
- macOS Seatbelt

## Security Considerations

### Approval Modes

| Mode              | Behavior                    |
| ----------------- | --------------------------- |
| `approve_all`     | Auto-approve all operations |
| `approve_unknown` | Confirm unknown operations  |
| `approve_some`    | User-defined approvals      |

### Sensitive Operations

- Shell commands require explicit approval
- File modifications are previewed before execution
- Environment variables can be masked

## Extensibility

### Adding New Tools

1. Create tool class in `packages/core/src/tools/`
2. Implement `Tool` interface
3. Register in `ToolRegistry`
4. Document in tools manifest

### Adding New AI Providers

1. Implement `ModelConnector` interface
2. Add provider to configuration
3. Update prompt builder for provider quirks

### Custom UI Extensions

1. Use `@qwen-code/webui` components
2. Follow React component patterns
3. Export via package exports

## Performance Considerations

### Context Management

- Conversation compression
- Token budgeting per model
- Selective context file inclusion

### Caching

- Build artifacts (esbuild)
- npm dependencies
- Model responses (optional)

## Related Documentation

- [SDK TypeScript Documentation](./sdk-typescript.md)
- [SDK Java Documentation](./sdk-java.md)
- [Development Guide](./development-guide.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
