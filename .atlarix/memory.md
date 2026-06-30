# Qwen-Code Project Memory

## Identity

- **Repository**: `QwenLM/qwen-code` (GitHub)
- **Package**: `@qwen-code/qwen-code` v0.19.3
- **Description**: CLI harness for Qwen models, with agentic coding capabilities
- **Language**: TypeScript (ES modules, `"type": "module"`)
- **Runtime**: Node.js >= 22
- **Build**: `tsc` compiles each package to `dist/`, then `esbuild` bundles into `dist/cli.js`

## Monorepo Structure (workspaces)

- `packages/core` — Core engine: agents, tools, config, permissions, telemetry, subagent runtime
- `packages/cli` — Terminal UI (Ink-based React), ACP integration, non-interactive mode
- `packages/acp-bridge` — Agent Client Protocol bridge
- `packages/sdk-typescript` / `packages/sdk-python` / `packages/sdk-java` — Language SDKs
- `packages/web-shell` / `packages/webui` / `packages/web-templates` — Web interfaces
- `packages/channels/*` — Chat platform integrations (Telegram, WeChat/Weixin, DingTalk, Feishu, QQ Bot)
- `packages/desktop` — Electron desktop app
- `packages/vscode-ide-companion` / `packages/zed-extension` — IDE integrations
- `packages/cua-driver` — Computer-use agent driver
- `packages/chrome-extension` — Browser extension
- `packages/audio-capture` — Audio input support

## Agent Architecture

- **AgentCore** (`packages/core/src/agents/runtime/agent-core.ts`): Shared execution engine for the model reasoning loop, tool scheduling, stats, and event emission. Stateless per-call.
- **AgentHeadless** (`packages/core/src/agents/runtime/agent-headless.ts`): One-shot task executor wrapping AgentCore.
- **AgentInteractive** (`packages/core/src/agents/runtime/agent-interactive.ts`): Persistent interactive agent.
- **AgentTool** (`packages/core/src/tools/agent/agent.ts`): Tool for delegating work to subagents. Handles fork subagents, approval mode overrides, context isolation.
- **WorkflowOrchestrator** (`packages/core/src/agents/runtime/workflow-orchestrator.ts`): Executes workflow scripts.

## Tool System

- Tools extend `BaseDeclarativeTool` (declaration) + `BaseToolInvocation` (execution).
- **ToolRegistry** (`packages/core/src/tools/tool-registry.ts`): Manages registration, deferred tools, function declaration generation.
- **Tool names**: `ToolNames` / `ToolDisplayNames` in `packages/core/src/tools/tool-names.ts`.
- **Deferred tools**: `shouldDefer: true` hides the tool schema until revealed. `shouldDefer: false` makes it always visible. `alwaysLoad: true` forces schema declaration regardless.

## Testing

- **Runner**: Vitest
- **Location**: Tests live alongside source files as `*.test.ts`
- **Critical**: Tests MUST be run from within the specific package directory, not project root.
  ```bash
  cd packages/core && npx vitest run src/path/to/file.test.ts
  ```
- **Avoid**: `npm run test -- --filter=...` (doesn't filter), `npx vitest` from project root (fails due to package-specific vitest configs)

## Common Commands

```bash
npm install                  # Install all dependencies
npm run build                # Build all packages (tsc)
npm run bundle               # Bundle dist/ into dist/cli.js via esbuild (requires build)
npm run dev                  # Run CLI from TS source (no build needed, tsx + DEV=true)
npm run lint                 # ESLint check
npm run lint:fix             # Auto-fix lint issues
npm run format               # Prettier formatting
npm run typecheck            # TypeScript type checking
npm run test:ci              # Full CI test suite
```

## Coding Conventions

- **Simplicity first**: Minimum code that solves the problem. No speculative features, no single-use abstractions, no unrequested configurability.
- **Comment only the non-obvious**: Match surrounding comment density. Comment the "why", not the "what".
- **Reuse existing patterns**: Match naming, error handling, idioms. Prefer extending existing utilities over writing parallel ones.
- **Pre-commit hook**: Runs prettier + eslint on staged files. Max warnings 0.
- **License headers**: Apache-2.0, `Copyright 2025 Qwen`.
