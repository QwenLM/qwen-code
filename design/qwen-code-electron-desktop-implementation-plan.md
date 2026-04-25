# Qwen Code Electron Desktop Implementation Plan

This plan tracks the incremental MVP implementation for the Electron desktop
client described in
`docs/design/qwen-code-electron-desktop/qwen-code-electron-desktop-architecture.md`.
The architecture document remains the source of truth; this file records
execution order, verification, decisions, and remaining work.

## Ground Rules

- Use Electron only; do not introduce Tauri.
- Keep Electron main thin: windows, native IPC, local server lifecycle, and ACP
  process lifecycle.
- Reuse Qwen Code ACP, core configuration/auth/session/permission behavior, and
  shared web UI surfaces where practical.
- Renderer must use `nodeIntegration: false`, context isolation, and a preload
  whitelist.
- The local server must bind only `127.0.0.1`, use a random token, and reject
  unauthorized requests.
- Every completed slice must leave targeted verification and a conventional
  commit.

## Current Status

Slices 1-8 established the desktop package, Electron main/preload/renderer
startup, authenticated health/runtime/settings/session APIs, ACP process
wrapper, WebSocket chat loop, permission bridge, settings/model/mode controls,
packaging configuration, and package smoke verification.

Important correction from iteration 7: the previous plan text called the MVP
complete after packaging smoke, but the architecture P0 also requires project
registry, recent projects, Git status, diff review, terminal, commit flow,
desktop E2E, and Chrome DevTools renderer observability. Those items remain in
scope before a DONE marker can be created.

## Task Breakdown

### Slice 1: Desktop Workspace Skeleton and Health Service

- Status: complete
- Goal: runnable desktop package with Electron main/preload, React renderer,
  and authenticated `/health`.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 2: Desktop Server Runtime Surface

- Status: complete
- Goal: authenticated `/api/runtime` with CLI/platform/auth summary.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 3: ACP Process Client Wrapper

- Status: complete
- Goal: desktop-local ACP child-process client for
  `qwen --acp --channel=Desktop`.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 4: Session REST API

- Status: complete
- Goal: ACP-backed session create/list/load/delete/rename endpoints.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 5: WebSocket Chat Loop

- Status: complete
- Goal: authenticated per-session WebSocket prompt/cancel/update stream.
- Verification: desktop tests, lint, typecheck, build.

### Slice 6: Permission Bridge

- Status: complete
- Goal: route ACP permission and ask-user-question callbacks to renderer and
  resolve responses with timeout cancellation.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 7: Settings, Auth, Model, and Mode UI

- Status: complete
- Goal: expose Qwen settings/auth/model/mode controls without returning secrets.
- Verification: desktop tests, lint, typecheck, build, root typecheck/build.

### Slice 8: Packaging and Smoke Test

- Status: complete
- Goal: package a desktop app that can launch with bundled CLI resources.
- Verification: desktop tests, lint, typecheck, build, bundle,
  `package:dir`, package smoke, package launch smoke, root typecheck/build.

### Slice 9: Project Registry and Git Status

- Status: complete in iteration 7
- Goal: make opened projects first-class desktop server data and surface Git
  branch/status in the workbench.
- Files:
  - `packages/desktop/src/server/services/projectService.ts`
  - `packages/desktop/src/server/index.ts`
  - `packages/desktop/src/server/index.test.ts`
  - `packages/desktop/src/server/types.ts`
  - `packages/desktop/src/renderer/api/client.ts`
  - `packages/desktop/src/renderer/App.tsx`
  - `packages/desktop/src/renderer/styles.css`
- Acceptance criteria:
  - `GET /api/projects` returns recent projects from a Qwen global desktop
    store.
  - `POST /api/projects/open` validates a directory, persists it as recent,
    and returns name/path/branch/status.
  - `GET /api/projects/:id/git/status` refreshes Git status for a registered
    project.
  - Renderer Open Project flow registers the selected directory through the
    server, lists recent projects, scopes thread creation/listing to the active
    project, and shows branch/status in the top bar and review panel.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - `npm run lint --workspace=packages/desktop`
  - `npm run build --workspace=packages/desktop`
- E2E coverage:
  - Record in
    `.qwen/e2e-tests/electron-desktop/project-git-status.md`.
  - Later Playwright Electron coverage must use a temporary Git workspace,
    choose it through the preload dialog hook/fake native bridge, assert recent
    project visibility, branch/status chips, and no black screen.

### Slice 10: Workspace Review Shell

- Status: pending
- Goal: split the renderer into explicit TopBar, ProjectSidebar, ThreadList,
  ChatThread, ReviewPanel, and TerminalDrawer components while preserving the
  current server-backed project/session/chat/settings behavior.
- Acceptance criteria:
  - First workspace viewport visibly contains top bar, project/thread sidebar,
    central thread, right review tabs, and bottom terminal drawer structure.
  - No renderer Node access or IPC broadening.
  - Existing desktop tests and typecheck still pass.
- E2E coverage:
  - Launch renderer with fake server/preload data and assert layout landmarks.

### Slice 11: Diff Review and Commit

- Status: pending
- Goal: add Git diff/status review APIs and UI actions for accept/revert and
  commit.
- Acceptance criteria:
  - Right Changes tab shows changed files and unified diff.
  - Stage/unstage/revert/commit routes are token protected and scoped to a
    registered project.
  - Commit errors are visible in the UI.
- E2E coverage:
  - Temporary Git workspace with a fake file change, accept/stage, commit, and
    error diagnostics.

### Slice 12: Scoped Terminal

- Status: pending
- Goal: add a current-project/current-thread terminal drawer with spawn, output,
  clear, kill, and send-output-to-AI plumbing.
- Acceptance criteria:
  - Terminal cwd is constrained to the active project.
  - Terminal output is visible and copyable; kill and clear work.
  - Agent command permission remains separate from user terminal execution.
- E2E coverage:
  - Run a harmless command in a temporary workspace and assert output appears.

### Slice 13: Desktop E2E and CDP Observability

- Status: pending
- Goal: add repeatable Electron E2E harness with fake ACP, temporary HOME and
  workspace, screenshot/console/network diagnostics, and CDP renderer access.
- Acceptance criteria:
  - `QWEN_DESKTOP_CDP_PORT` enables renderer inspection on `127.0.0.1`.
  - E2E asserts first screen is not black, service is connected, project open
    works, thread creation works, permission response works, settings save
    works, and package smoke still passes.
  - Failures write screenshots, console errors, failed requests, and main logs
    under `.qwen/e2e-tests/electron-desktop/`.

## Decision Log

- 2026-04-25: Use a main-process hosted `DesktopServer` for MVP, matching the
  architecture recommendation while keeping HTTP/WS boundaries explicit.
- 2026-04-25: Use Electron 41.3.0, whose embedded Node satisfies the repository
  runtime requirement.
- 2026-04-25: Use Node built-in HTTP for the current server surface instead of
  adding Express/Fastify.
- 2026-04-25: Keep ACP update normalization inside `packages/desktop` until the
  desktop protocol stabilizes.
- 2026-04-25: Package the root `dist/` bundle as `resources/qwen-cli` and
  launch it with `ELECTRON_RUN_AS_NODE=1` in packaged apps.
- 2026-04-25: Store desktop recent projects in the Qwen global directory as
  `desktop-projects.json`, separate from `settings.json`, because it is app UI
  state rather than model/auth configuration.
- 2026-04-25: Use `git status --porcelain=v1 --branch` for Slice 9 instead of
  introducing a desktop `simple-git` dependency. This keeps the server surface
  small and returns conservative status metadata for both clean and dirty repos.

## Verification Log

- 2026-04-25 Slices 1-8:
  - Prior iterations passed desktop tests, lint, typecheck, build, root
    typecheck/build, bundle, package dir, package smoke, and package launch
    smoke. Electron-builder warnings were non-fatal metadata/signing warnings.
- 2026-04-25 Slice 9:
  - `npm run test --workspace=packages/desktop` passed: 7 files, 45 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.

## Self Review Notes

- Slice 9 keeps project registration behind the existing bearer-token and
  origin gates.
- Project open validates that the path exists and is a directory before
  persisting it.
- Git status failures are non-fatal and render as non-repository metadata,
  avoiding a broken workspace for projects without Git.
- Renderer still obtains the token only from preload and does not gain Node
  integration.

## Remaining Work

- Commit Slice 9.
- Implement real workspace review shell, diff review, commit flow, scoped
  terminal, Electron E2E, CDP observability verification, and final package
  smoke before creating the DONE marker.
