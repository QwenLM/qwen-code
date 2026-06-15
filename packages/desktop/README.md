# Qwen Code

Qwen Code is a desktop and headless agent workspace. It provides multi-session chat, source connections, skills, file previews, automations, and permission modes in a local-first application.

## Backend

This fork is Qwen-only:

- Agent sessions run through Qwen Code over ACP.
- The app does not store third-party LLM API keys.
- The built-in LLM connection is `qwen-code`.
- Legacy multi-provider backends and package/runtime wiring have been removed.

## Qwen Code CLI Runtime

The desktop app talks to the Qwen Code CLI over ACP. Treat the CLI as a
runtime artifact, not as desktop source code. A packaged app must bundle a
known CLI build so users can launch it without installing `qwen` separately.

Use one of these workflows depending on what you are developing:

| Workflow                    | Use it when                                                               | Commands                                                             |
| --------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Default desktop development | You are developing desktop only.                                          | `bun run dev`                                                        |
| Published npm package       | You want a specific published CLI version for dev, CI, or release builds. | `QWEN_CODE_VERSION=0.15.12-acp.0 bun run dev`                        |
| Local npm tarball           | You need to verify the exact package contents before publishing.          | `QWEN_CODE_TARBALL=/path/to/qwen-code-0.15.12-acp.0.tgz bun run dev` |
| Local qwen-code checkout    | You are changing ACP or other CLI behavior while testing desktop.         | `QWEN_CODE_ROOT=/path/to/qwen-code bun run dev`                      |
| Explicit CLI entry          | You need to point at a specific CLI file.                                 | `QWEN_CODE_CLI=/path/to/qwen-code/scripts/dev.js bun run dev`        |

`electron:dev` uses local overrides first. If no override is set and this
repository is not inside the qwen-code monorepo, it vendors the default version
from `qwenCodeRuntime.version` in `package.json` and points Electron at the
vendored CLI automatically.

If you are preparing a package without publishing it, create the tarball from
the Qwen Code repository and point desktop at it:

```bash
cd /path/to/qwen-code
npm run build
npm run bundle
npm run prepare:package
npm pack

cd /path/to/desktop
QWEN_CODE_TARBALL=/path/to/qwen-code/qwen-code-0.15.12-acp.0.tgz bun run dist:mac
```

Distribution builds run `electron:vendor:qwen` automatically. Set
`QWEN_CODE_VERSION` or `QWEN_CODE_TARBALL` when you want the packaged app to use
a published or packed CLI artifact. If neither is set, this monorepo builds
from the local checkout; a standalone desktop checkout uses
`qwenCodeRuntime.version` from `package.json`.

Development runtime resolution checks sources in this order:

```text
QWEN_CODE_CLI / QWEN_CODE_ROOT / QWEN_CODE_PATH
QWEN_CODE_TARBALL
QWEN_CODE_VERSION
local monorepo checkout
existing vendored CLI
qwenCodeRuntime.version from package.json
```

Distribution vendoring checks sources in this order:

```text
QWEN_CODE_TARBALL
QWEN_CODE_VERSION
QWEN_CODE_ROOT / QWEN_CODE_PATH
local monorepo checkout
qwenCodeRuntime.version from package.json
```

## Installation

```bash
bun install
bun run dev
```

## Common Commands

```bash
bun run typecheck:all
bun run test:shared
bun run dev
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

| Platform | Artifact                                                                 |
| -------- | ------------------------------------------------------------------------ |
| macOS    | `Qwen-Code-Desktop-{arm64,x64}.dmg`, `Qwen-Code-Desktop-{arm64,x64}.zip` |
| Windows  | `Qwen-Code-Desktop-x64.exe`                                              |
| Linux    | `Qwen-Code-Desktop-x64.AppImage`                                         |

### What the Build Does

Each `electron:dist:*` command runs three stages:

1. **`electron:vendor:qwen`** — vendors a Qwen Code CLI runtime into `vendor/qwen-code/`. Set `QWEN_CODE_VERSION` to download a published npm version, or `QWEN_CODE_TARBALL` to use a local `npm pack` tarball. If neither is set in this monorepo, it builds from the local checkout.
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
