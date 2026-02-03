# Qwen Code Source Tree Analysis

## Project Root Structure

```
qwen-code/
├── _bmad/                    # BMad framework (agentic workflow system)
├── _bmad-output/             # Output artifacts from workflows
├── .github/                  # GitHub Actions CI/CD
├── .vscode/                  # VS Code settings
├── docs/                     # Documentation
│   ├── developers/          # Developer documentation
│   └── users/               # User documentation
├── docs-site/                # Documentation website
├── hello/                    # Example/hello world
├── integration-tests/        # Integration tests
├── packages/                 # Monorepo packages (8 packages)
│   ├── cli/                 # Terminal CLI application
│   ├── core/                # Core library (backend)
│   ├── sdk-typescript/      # TypeScript SDK
│   ├── sdk-java/            # Java SDK
│   ├── webui/               # React UI components
│   ├── vscode-ide-companion/ # VS Code extension
│   ├── zed-extension/       # Zed editor extension
│   └── test-utils/         # Testing utilities
├── scripts/                  # Build and utility scripts
├── eslint-rules/             # Custom ESLint rules
├── integration-tests/        # E2E test suite
├── Dockerfile               # Container definition
├── Makefile                 # Build commands
├── package.json             # Root workspace config
├── tsconfig.json            # TypeScript config
├── vitest.config.ts         # Test configuration
└── eslint.config.js         # ESLint configuration
```

## Packages Detailed Structure

### CLI Package (`packages/cli/`)

```
packages/cli/
├── src/
│   ├── acp-integration/     # AI Companion Protocol integration
│   ├── commands/            # Slash commands (/help, /clear, etc.)
│   ├── config/              # Configuration handling
│   ├── core/                # Core CLI logic
│   ├── i18n/               # Internationalization
│   ├── nonInteractive/     # Headless mode implementation
│   ├── patches/            # Dependency patches
│   ├── services/           # Service layer
│   ├── test-utils/        # Testing utilities
│   ├── ui/                 # Terminal UI components
│   │   ├── components/     # React components for UI
│   │   ├── hooks/         # Custom React hooks
│   │   ├── themes/        # UI themes
│   │   └── utils/         # UI utilities
│   ├── utils/              # CLI utilities
│   ├── gemini.tsx          # Main component
│   └── index.ts            # Entry point
├── package.json
└── dist/                    # Built output
```

**Purpose**: User-facing terminal interface that handles:

- User input processing (text, slash commands, @file references)
- History management
- Response rendering with syntax highlighting
- Theme and UI customization

### Core Package (`packages/core/`)

```
packages/core/src/
├── config/                 # Configuration management
├── core/                  # Core orchestration
├── extension/             # Extension handling
├── ide/                   # IDE integration
├── lsp/                   # Language Server Protocol
├── mcp/                   # Model Context Protocol
│   ├── servers/          # MCP server implementations
│   └── utils/            # MCP utilities
├── models/               # Data models and types
├── output/               # Output formatting
├── prompts/              # Prompt templates
├── qwen/                 # Qwen-specific implementations
├── services/             # Core services
├── skills/               # Built-in skills
├── subagents/            # Sub-agent implementations
├── telemetry/            # Telemetry and metrics
├── tools/                # Built-in tools
│   ├── bash/            # Shell execution
│   ├── fetch/           # Web fetching
│   ├── file-ops/        # File operations
│   ├── glob/            # File finding
│   ├── grep/            # Content search
│   ├── web-search/      # Web search
│   └── mcp/             # MCP tool wrapper
├── utils/               # Core utilities
└── index.ts             # Entry point
```

**Purpose**: Backend orchestration that:

- Manages AI model API communication
- Registers and executes tools
- Maintains conversation state
- Handles prompt construction

### WebUI Package (`packages/webui/`)

```
packages/webui/src/
├── adapters/            # Framework adapters
├── components/          # React UI components
│   ├── buttons/        # Button components
│   ├── chat/           # Chat interface
│   ├── common/         # Shared components
│   ├── feedback/       # Loading, error states
│   ├── forms/          # Form elements
│   ├── icons/          # Icon components
│   ├── layout/         # Layout components
│   └── modal/          # Modal dialogs
├── context/            # React context providers
├── hooks/              # Custom React hooks
├── styles/             # Global styles
├── types/              # TypeScript types
├── utils/              # UI utilities
├── index.ts            # Entry point
└── tailwind.preset.cjs # Tailwind configuration
```

**Purpose**: Shared React UI components used by:

- VS Code extension
- Web-based interfaces
- Documentation site

### SDK TypeScript (`packages/sdk-typescript/`)

```
packages/sdk-typescript/
├── src/                 # SDK source
│   ├── client/         # SDK client
│   ├── types/          # TypeScript types
│   └── index.ts        # Entry point
├── test/               # Tests
├── scripts/            # Build scripts
└── package.json
```

**Purpose**: Programmatic access to Qwen Code functionality for Node.js applications

### SDK Java (`packages/sdk-java/`)

```
packages/sdk-java/
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/
│   │   │       └── qwen/
│   │   │           └── sdk/
│   │   │               ├── client/      # Java client
│   │   │               ├── models/     # Data models
│   │   │               └── util/       # Utilities
│   │   └── resources/
│   └── test/
│       └── java/
│           └── com/
│               └── qwen/
│                   └── sdk/
├── pom.xml            # Maven configuration
└── README.md
```

**Purpose**: Java SDK for programmatic access

### VS Code Extension (`packages/vscode-ide-companion/`)

```
packages/vscode-ide-companion/
├── src/
│   ├── extension.ts    # Extension entry point
│   ├── server/         # Express server for communication
│   ├── webview/        # Webview UI components
│   └── utils/          # Extension utilities
├── assets/            # Icons and resources
├── scripts/           # Build scripts
├── package.json       # VS Code manifest
└── dist/             # Built output
```

**Purpose**: VS Code IDE integration providing:

- In-editor chat interface
- Diff preview and acceptance
- Qwen Code commands

### Zed Extension (`packages/zed-extension/`)

```
packages/zed-extension/
├── src/
│   └── extension.ts   # Extension entry point
├── package.json       # Zed manifest
└── README.md
```

**Purpose**: Zed editor integration

### Test Utils (`packages/test-utils/`)

```
packages/test-utils/
├── src/              # Testing utilities
│   ├── cli/          # CLI testing helpers
│   ├── core/         # Core testing utilities
│   └── index.ts      # Entry point
└── package.json
```

**Purpose**: Shared testing utilities for all packages

## Entry Points

| Part           | Entry Point                                        | Command                                 |
| -------------- | -------------------------------------------------- | --------------------------------------- |
| CLI            | `packages/cli/dist/index.js`                       | `qwen`                                  |
| Core           | `packages/core/dist/index.js`                      | Library import                          |
| SDK TypeScript | `packages/sdk-typescript/dist/index.mjs`           | `import { Qwen } from '@qwen-code/sdk'` |
| SDK Java       | Maven artifact                                     | Maven import                            |
| VS Code        | `packages/vscode-ide-companion/dist/extension.cjs` | VS Code activation                      |
| Zed            | `packages/zed-extension/`                          | Zed extension                           |

## Integration Points

### Between Packages

```
CLI (packages/cli)
    ↓
    ↑ (requests/responses)
    ↓
Core (packages/core)
    ↓
    ├─→ SDK TypeScript (packages/sdk-typescript) ← External apps
    ├─→ SDK Java (packages/sdk-java) ← External Java apps
    ├─→ WebUI (packages/webui) ← VS Code Extension
    └─→ MCP Servers (via @modelcontextprotocol/sdk)
```

### External Integrations

- **AI Providers**: OpenAI, Anthropic, Google GenAI
- **IDE Platforms**: VS Code, Zed, JetBrains (via SDKs)
- **Version Control**: Git (simple-git)
- **File System**: Local filesystem via Node.js
- **Web**: HTTP requests via fetch/undici

## Critical Directories

| Directory                            | Purpose            | Part    |
| ------------------------------------ | ------------------ | ------- |
| `packages/cli/src/ui/`               | Terminal interface | CLI     |
| `packages/core/src/tools/`           | Built-in tools     | Core    |
| `packages/core/src/services/`        | Core services      | Core    |
| `packages/core/src/models/`          | Data models        | Core    |
| `packages/webui/src/components/`     | React components   | WebUI   |
| `packages/sdk-typescript/src/`       | SDK implementation | SDK     |
| `packages/vscode-ide-companion/src/` | Extension code     | VS Code |

## Build Output Structure

```
dist/
├── cli/              # Built CLI package
│   └── index.js
├── core/             # Built core package
│   └── index.js
├── sdk-typescript/   # Built SDK
│   ├── index.mjs
│   └── index.cjs
├── webui/            # Built UI components
│   ├── index.js
│   └── components/
└── vscode-ide-companion/ # VS Code extension
    └── extension.cjs
```

## Configuration Files

| File               | Purpose                       |
| ------------------ | ----------------------------- |
| `package.json`     | Workspace configuration       |
| `tsconfig.json`    | TypeScript configuration      |
| `vitest.config.ts` | Test runner configuration     |
| `eslint.config.js` | Linting rules                 |
| `Makefile`         | Build shortcuts               |
| `Dockerfile`       | Container image               |
| `.nvmrc`           | Node.js version specification |
| `eslint-rules/`    | Custom linting rules          |

## File Organization Patterns

- **TypeScript first**: All packages use TypeScript for type safety
- **Component-based UI**: React components with hooks
- **Service layer**: Core functionality separated into services
- **Tool pattern**: Tools registered and invoked dynamically
- **Test co-location**: Tests alongside source files (`*.test.ts`, `*.spec.ts`)
