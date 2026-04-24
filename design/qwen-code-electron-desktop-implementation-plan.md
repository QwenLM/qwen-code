# Qwen Code Electron Desktop Implementation Plan

This plan tracks the incremental MVP implementation for the Electron desktop
client described in
`docs/design/qwen-code-electron-desktop/qwen-code-electron-desktop-architecture.md`.
The architecture document is the source of truth; this file records execution
order, verification, decisions, and remaining work.

## Ground Rules

- Use Electron only; do not introduce Tauri.
- Keep the desktop shell thin: Electron main owns windows, native IPC, and the
  local server lifecycle.
- Reuse Qwen Code ACP, core services, and shared web UI as later slices reach
  those layers.
- Renderer must run with `nodeIntegration: false`, context isolation enabled,
  and a preload whitelist.
- The local server must bind only `127.0.0.1`, use a random token, and reject
  unauthorized requests.
- Every completed slice must leave passing targeted checks and a conventional
  commit.

## Task Breakdown

### Slice 1: Desktop Workspace Skeleton and Health Service

- Status: complete
- Goal: add the first runnable desktop package with Electron main/preload,
  React renderer, and a local authenticated `/health` endpoint.
- Files:
  - `packages/desktop/package.json`
  - `packages/desktop/tsconfig*.json`
  - `packages/desktop/vite.config.ts`
  - `packages/desktop/src/main/**`
  - `packages/desktop/src/preload/**`
  - `packages/desktop/src/server/**`
  - `packages/desktop/src/renderer/**`
  - `scripts/build.js`
  - `package-lock.json`
- Acceptance criteria:
  - `packages/desktop` is recognized as an npm workspace.
  - Main starts `DesktopServer` before creating the window.
  - Preload exposes only typed `qwenDesktop` methods.
  - Renderer fetches server info through preload and calls `/health` with a
    bearer token.
  - `/health` returns success only for valid token and allowed origin.
  - Desktop build is included after reusable packages in the root build order.
- Verification:
  - `npm install --workspace=packages/desktop`
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - `npm run build --workspace=packages/desktop`

### Slice 2: Desktop Server Runtime Surface

- Status: complete
- Goal: add `/api/runtime` and typed error responses that expose CLI path,
  platform, desktop version, and auth/account placeholders without spawning ACP.
- Files:
  - `packages/desktop/src/server/http/router.ts`
  - `packages/desktop/src/server/services/runtimeService.ts`
  - `packages/desktop/src/renderer/api/client.ts`
  - `packages/desktop/src/renderer/App.tsx`
- Acceptance criteria:
  - Runtime route is token protected.
  - Renderer shows runtime summary without exposing secrets.
  - Tests cover success, unauthorized, and unknown route errors.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - `npm run build --workspace=packages/desktop`

### Slice 3: ACP Process Client Wrapper

- Status: complete
- Goal: implement a desktop-local ACP child-process client around
  `qwen --acp --channel=Desktop`.
- Files:
  - `packages/desktop/src/server/acp/AcpProcessClient.ts`
  - `packages/desktop/src/server/acp/AcpEventRouter.ts`
  - `packages/desktop/src/server/services/sessionService.ts`
- Acceptance criteria:
  - Development mode can spawn the repository CLI ACP entrypoint.
  - Production path is isolated behind a resolver for packaged `dist/cli.js`.
  - Tests mock ACP transport and cover initialize, list, new, load, and close.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - targeted ACP smoke command when credentials are not required

### Slice 4: Session REST API

- Status: complete
- Goal: add session create/list/load/delete/rename endpoints backed by ACP.
- Files:
  - `packages/desktop/src/server/http/router.ts`
  - `packages/desktop/src/server/services/sessionService.ts`
  - `packages/desktop/src/renderer/stores/sessionStore.ts`
- Acceptance criteria:
  - Session routes enforce token and origin rules.
  - Renderer can create a session for a selected cwd and list existing sessions.
  - Failed ACP operations return typed retryable/non-retryable errors.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - manual DesktopServer smoke with fake ACP client

### Slice 5: WebSocket Chat Loop

- Status: complete
- Goal: add per-session WS connections and send user prompts through ACP.
- Files:
  - `packages/desktop/src/server/ws/SessionSocketHub.ts`
  - `packages/desktop/src/server/acp/AcpEventRouter.ts`
  - `packages/desktop/src/renderer/api/websocket.ts`
  - `packages/desktop/src/renderer/stores/chatStore.ts`
- Acceptance criteria:
  - WS handshake validates session id and token.
  - One active prompt per session is enforced.
  - Renderer receives normalized assistant/tool/usage events.
- Progress:
  - 2026-04-25: authenticated `/ws/:sessionId` handshake, `ping`/`pong`,
    `user_message` to ACP `prompt`, `stop_generation` to ACP `cancel`, and
    one-active-prompt guard are implemented on the server.
  - 2026-04-25: added `AcpEventRouter` normalization for ACP message, tool,
    plan, mode, commands, and usage updates; routed session updates into the
    per-session socket hub; added a renderer WebSocket client, chat reducer,
    and basic workbench wiring for session selection, streaming messages,
    tool updates, plan updates, usage, stop, and send.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - fake ACP integration test for prompt and stream completion

### Slice 6: Permission Bridge

- Status: pending
- Goal: route ACP permission and ask-user-question callbacks to renderer and
  resolve responses with timeout cancellation.
- Files:
  - `packages/desktop/src/server/acp/permissionBridge.ts`
  - `packages/desktop/src/server/ws/SessionSocketHub.ts`
  - `packages/desktop/src/renderer/stores/chatStore.ts`
- Acceptance criteria:
  - Permission requests are visible to the active session.
  - Closing a WS connection cancels pending requests.
  - Timeout defaults to deny/cancel.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - renderer store tests for allow, deny, and timeout state

### Slice 7: Settings, Auth, Model, and Mode UI

- Status: pending
- Goal: expose settings/auth/model/mode controls while reusing Qwen Code
  configuration semantics.
- Files:
  - `packages/desktop/src/server/services/settingsService.ts`
  - `packages/desktop/src/server/services/runtimeService.ts`
  - `packages/desktop/src/renderer/stores/settingsStore.ts`
  - `packages/desktop/src/renderer/stores/modelStore.ts`
- Acceptance criteria:
  - Settings writes target the existing Qwen settings locations.
  - Auth actions go through ACP or shared settings writer logic.
  - Approval mode values remain `plan/default/auto-edit/yolo`.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - temp HOME/QWEN_RUNTIME_DIR settings tests

### Slice 8: Packaging and Smoke Test

- Status: pending
- Goal: package a desktop app that can launch the bundled CLI ACP child.
- Files:
  - `packages/desktop/electron-builder.*`
  - `scripts/build.js`
  - `scripts/copy_bundle_assets.js`
- Acceptance criteria:
  - Packaged app starts renderer and DesktopServer.
  - Production ACP launch uses `ELECTRON_RUN_AS_NODE=1`.
  - Required CLI bundle and native/vendor resources are present.
- Verification:
  - `npm run build`
  - `npm run typecheck`
  - desktop packaging smoke command

## Decision Log

- 2026-04-25: Use a main-process hosted `DesktopServer` for MVP, matching the
  architecture recommendation and keeping the HTTP/WS boundary ready for a
  future `utilityProcess` move.
- 2026-04-25: Use the latest stable Electron line available during this slice.
  Electron releases list Electron 41.3.0 with Node.js 24.15.0, satisfying the
  repository runtime requirement of Node >=20.
- 2026-04-25: Implement the first server routes with Node built-ins instead of
  adding Express/Fastify. The current surface is small and this avoids
  committing to an HTTP framework before the ACP routing shape is known.
- 2026-04-25: Allow CORS preflight without bearer auth, but only for allowed
  app origins. Actual REST requests remain bearer-token protected.
- 2026-04-25: Keep ACP update normalization inside `packages/desktop` for now
  instead of importing the VS Code session update handler. The desktop protocol
  needs WebSocket message shapes, while the VS Code handler is callback/UI
  oriented; shared extraction can happen after permission and settings slices
  stabilize the common surface.

## Verification Log

- 2026-04-25 Slice 1:
  - `npm install --ignore-scripts --workspace=@qwen-code/desktop` passed.
  - `npx prettier --check design/qwen-code-electron-desktop-implementation-plan.md scripts/build.js packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run test --workspace=packages/desktop` passed: 1 file, 4 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm exec --workspace=packages/desktop -- electron --version` passed:
    `v41.3.0`.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 2:
  - `npx prettier --check design/qwen-code-electron-desktop-implementation-plan.md scripts/build.js packages/desktop` passed.
  - `npm run test --workspace=packages/desktop` passed: 1 file, 6 tests.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm exec --workspace=packages/desktop -- electron --version` passed:
    `v41.3.0`.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 3:
  - `npm install --ignore-scripts --workspace=@qwen-code/desktop` passed.
  - `npx prettier --check design/qwen-code-electron-desktop-implementation-plan.md scripts/build.js packages/desktop` passed.
  - `npm run test --workspace=packages/desktop` passed: 2 files, 12 tests.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm exec --workspace=packages/desktop -- electron --version` passed:
    `v41.3.0`.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 4:
  - `npx prettier --check design/qwen-code-electron-desktop-implementation-plan.md scripts/build.js packages/desktop` passed.
  - `npm run test --workspace=packages/desktop` passed: 2 files, 17 tests.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm exec --workspace=packages/desktop -- electron --version` passed:
    `v41.3.0`.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 5a:
  - `npm install --ignore-scripts --workspace=@qwen-code/desktop` passed.
  - `npx prettier --check design/qwen-code-electron-desktop-implementation-plan.md scripts/build.js packages/desktop` passed.
  - `npm run test --workspace=packages/desktop` passed: 2 files, 21 tests.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm exec --workspace=packages/desktop -- electron --version` passed:
    `v41.3.0`.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 5b:
  - `npm run test --workspace=packages/desktop` passed: 3 files, 26 tests.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.

## Self Review Notes

- 2026-04-25 Slice 1:
  - Security boundary checked: renderer uses `nodeIntegration: false`,
    context isolation, a bundled preload whitelist, and no arbitrary IPC.
  - Local server checked: binds `127.0.0.1`, generates a random token by
    default, requires bearer auth for real routes, and rejects non-local
    origins.
  - CORS preflight intentionally remains unauthenticated but origin-gated so
    packaged `file://` and dev `127.0.0.1` renderers can send authorization
    headers.
  - Fixed self-review issues before completion: guarded app startup behind the
    Electron single-instance lock, tightened bearer parsing, and removed unused
    direct WebSocket dependencies until the WS slice.
- 2026-04-25 Slice 2:
  - Runtime route remains behind the same token and origin checks as `/health`.
  - Runtime payload does not expose secrets; auth/account are explicit
    placeholders until ACP is connected.
  - Renderer displays runtime summary from REST only and still obtains the
    server token only through preload.
- 2026-04-25 Slice 3:
  - `AcpProcessClient` follows the existing Qwen ACP boundary:
    `ClientSideConnection`, `ndJsonStream`, and `qwen --acp`.
  - The wrapper defaults permission requests to cancellation until the
    permission bridge slice supplies a UI-backed resolver.
  - Startup failures race initialize against child exit; later process exits
    clear connection state without leaving a rejected startup promise.
- 2026-04-25 Slice 4:
  - Session REST routes share the same origin and bearer-token gate as health
    and runtime routes.
  - The route layer is ACP-backed through an injected client so tests cover the
    Qwen ACP method contracts without requiring credentials or a live model.
  - Electron main intentionally does not auto-start real ACP yet; CLI path
    resolution and packaged `ELECTRON_RUN_AS_NODE=1` behavior remain for the
    packaging/runtime integration slices.
- 2026-04-25 Slice 5a:
  - WebSocket upgrade uses the same local-origin policy and random token as the
    REST API.
  - The hub defaults to an `acp_unavailable` error when no ACP client is
    injected, rather than silently dropping user messages.
  - Session update broadcasting is intentionally a follow-up; this keeps the
    prompt/cancel transport independently testable before event normalization.
- 2026-04-25 Slice 5b:
  - ACP session updates now broadcast only to sockets for the matching session;
    tests cover a second session socket receiving only its own `pong`.
  - Renderer chat state consumes the shared desktop WebSocket protocol without
    Node access and keeps the server token in memory from preload-provided
    server info.
  - Main still does not auto-start a real ACP child process; the chat loop is
    verified with an injected fake ACP client and remains ready for the runtime
    integration slice.

## Remaining Work

- Commit Slice 5b.
- Start Slice 6 permission bridge: route ACP permission and ask-user-question
  callbacks through the existing per-session WebSocket channel with timeout
  cancellation.
- Continue through permission, settings/auth/model/mode, real ACP runtime
  startup, and packaging slices until the architecture MVP is fully verified.
