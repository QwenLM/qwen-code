# Craft Agents

Craft Agents is a desktop and headless agent workspace built around the Qwen Code backend. It provides multi-session chat, source connections, skills, file previews, automations, and permission modes in a local-first application.

## Backend

This fork is Qwen-only:

- Agent sessions run through Qwen Code over ACP.
- The app does not store third-party LLM API keys.
- The built-in LLM connection is `qwen-code`.
- Legacy multi-provider backends and package/runtime wiring have been removed.

## Installation

```bash
bun install
bun run electron:start
```

## Common Commands

```bash
bun run typecheck:all
bun run test:shared
bun run electron:start
bun run server:start
```

## CLI

```bash
bun run apps/cli/src/index.ts run "Hello from Qwen"
bun run apps/cli/src/index.ts run --workspace-dir ./project "Summarize this repo"
```

The `run` command spawns a headless server, creates a temporary session, streams the response, and exits. Provider flags are accepted only for compatibility; the backend remains Qwen Code.

## Repository Layout

```text
apps/
  electron/     Desktop app
  cli/          Terminal client
  webui/        Web adapter
packages/
  shared/       Agent, config, prompts, sessions, sources
  server-core/  RPC handlers and session manager
  core/         Shared types
  ui/           Shared UI components
  session-tools-core/
  session-mcp-server/
scripts/        Build and packaging helpers
```

## Capabilities

- Multi-session inbox with streaming responses and tool visualization
- Qwen Code model discovery through ACP
- MCP, REST API, and local filesystem sources
- Skills stored per workspace
- Permission modes for planning, asking before edits, and autonomous execution
- File attachments and in-app previews for images, PDFs, Office files, and diffs
- Event-driven automations and messaging integrations

## License

Apache 2.0. Third-party dependencies are listed in package manifests and are subject to their respective licenses.
