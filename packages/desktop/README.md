# Qwen Code

Qwen Code is a desktop and headless agent workspace. It provides multi-session chat, source connections, skills, file previews, automations, and permission modes in a local-first application.

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

## Building for Distribution

All build commands run from `packages/desktop/`.

### Prerequisites

- [Bun](https://bun.sh) (see `.bun-version` for exact version)
- `bun install` — install all workspace dependencies

### Developer Build (no code signing)

Use this for local testing. Produces an ad-hoc signed app.

```bash
# macOS (arm64 + x64)
bun run electron:dist:dev:mac

# Windows
bun run electron:dist:dev:win

# Linux
bun run electron:dist:dev:linux
```

### Release Build (with code signing)

```bash
bun run electron:dist:mac
bun run electron:dist:win
bun run electron:dist:linux
```

Release builds require signing credentials via environment variables:

| Variable                      | Purpose                     |
| ----------------------------- | --------------------------- |
| `CSC_LINK`                    | Path to signing certificate |
| `APPLE_ID`                    | Apple ID for notarization   |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password       |
| `APPLE_TEAM_ID`               | Team ID for notarization    |

### Build Output

All artifacts are written to `apps/electron/release/`:

| Platform | Artifact                                                 |
| -------- | -------------------------------------------------------- |
| macOS    | `Qwen-Code-{arm64,x64}.dmg`, `Qwen-Code-{arm64,x64}.zip` |
| Windows  | `Qwen-Code-x64.exe`                                      |
| Linux    | `Qwen-Code-x64.AppImage`                                 |

### What the Build Does

Each `electron:dist:*` command runs three stages:

1. **`electron:vendor:qwen`** — builds the Qwen Code CLI from the local checkout and bundles it into `vendor/qwen-code/`. Set `QWEN_CODE_VERSION` to download a published npm version instead.
2. **`electron:build`** — compiles the app via esbuild (main + preload), Vite (renderer), and copies resources/assets.
3. **`electron-builder`** — downloads the Electron runtime, packages the app, signs it, and produces distributable installers (DMG, NSIS, AppImage).

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
