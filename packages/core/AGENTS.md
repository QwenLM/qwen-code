# Qwen Code Core (`@qwen-code/core`)

Backend logic for Qwen Code: API orchestration, prompt construction, tool
execution, and agent management.

## Architecture

- `src/agents/`: Agent definitions, registry, discovery, execution, and teams.
- `src/engine/`, `src/core/`, and `src/context/`: Conversation execution,
  shared runtime types, and context management.
- `src/provider/` and `src/model-request/`: Model providers, transports, and
  inference requests. Custom provider configuration and management live in
  `src/provider/custom/`.
- `src/auth/`, `src/qwen/`, and `src/qoder/`: Shared authentication/provider
  integration and account/model API clients. Account connection UI and CLI
  provider composition live in `packages/cli/src/ui/auth/` and
  `packages/cli/src/auth/`.
- `src/config/` and `src/config-service/`: Runtime configuration and config
  service integration. File-backed settings parsing, validation, and scoped
  resources live in `@qwen-code/resource`.
- `src/prompts/`, `src/input/`, and `src/compression-v2/`: Prompt construction,
  incoming content handling, and conversation compression.
- `src/tools/`, `src/tool-executor/`, and `src/permissions/`: Tool definitions,
  execution lifecycle, and authorization. Permission prompts are rendered by
  the CLI rather than Core.
- `src/mcp/`, `src/hooks/`, `src/plugins/`, and `src/builtin-plugins/`: MCP
  connections, hooks, plugin management, and host extension contracts.
- `src/skills/`: Runtime skill discovery, activation, and content handling;
  user/project file discovery and parsing use `@qwen-code/resource`.
- `src/sessions/`, `src/thread-manager/`, `src/services/`, and `src/memory/`:
  Shared session state, persistence, services, and memory.
- `src/tasks/`, `src/cron/`, and `src/workflows/`: Background task, scheduling,
  and workflow support.
- `src/messaging/`, `src/protocol/`, and `src/host-action/`: Peer messaging,
  protocol schemas, and host action correlation.
- `src/output/` and `src/io/`: Output formatting and stream handling.
- `src/utils/`: Shared utilities, paths, and persistent diagnostic logging.
- `src/test-utils/`: Shared test helpers and `TestRig`; not production runtime.

The public facades are `index.ts`, `sessions.ts`, and `plugin-management.ts`.
Keep their exports and `package.json` subpaths aligned when moving modules.
Core must not import CLI or Qoder product implementations.

## Logging

Use the correct logger for the scope of information being recorded:

- **`runLogger`** — Process-level persistent logs. Writes to
  `~/.qwen/logs/runs/<runId>/qwen.log` via `DiagnosticLogger` (the config root
  and log file name follow the build brand). Use for
  anything that should survive across sessions for diagnosing a process-level
  issue: startup/shutdown events, configuration errors, service initialization,
  unexpected failures, etc.

- **`sessionLogger`** — Session-loop event logs. Writes structured JSONL
  segments to
  `~/.qwen/logs/sessions/<projectId>/<sessionId>/segments/<runId>.jsonl`. Use
  for events tied to a specific session's lifecycle: turn start/end, tool calls,
  model requests, permission prompts, hook execution, etc.

Do **not** use `console.log/warn/error` for diagnostic information — it is not
persisted and will be lost when the process exits. Use `runLogger` instead.

## Coding Conventions

- **Style:** Follow existing backend logic patterns. This package has no UI
  dependencies — keep it framework-agnostic.

## Testing

- Run only the tests related to your change, from `packages/core`:
  `npx vitest run src/path/to/file.test.ts` (add `-t "<name>"` for one case).
- Do not run the whole package suite unless the user explicitly asks. Run
  Vitest from this package, not the repository root.
- Tests normally live beside the implementation as `src/**/*.test.ts`.
  Shared test support lives in `src/test-utils/`, with Vitest setup in
  `src/test-utils/setup.ts`. Other workspaces use `@qwen-code/core/test-utils`;
  keep the source aliases and compiled package export aligned.
- For a specific slow test, set `QWEN_RUN_SLOW_TESTS=1` when invoking Vitest.
  JUnit output is written to `coverage/junit.xml`.
