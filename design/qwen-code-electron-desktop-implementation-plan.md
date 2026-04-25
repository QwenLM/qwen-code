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

Slices 1-11 established the desktop package, Electron main/preload/renderer
startup, authenticated health/runtime/settings/session APIs, ACP process
wrapper, WebSocket chat loop, permission bridge, settings/model/mode controls,
packaging configuration, package smoke verification, project/Git status,
renderer asset/CDP startup support, and the componentized workspace shell.

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

### Slice 10: Renderer Asset Loading and CDP Port

- Status: complete in iteration 7
- Goal: make the built renderer load reliably from Electron main and expose a
  local-only Chrome DevTools Protocol endpoint when explicitly requested for
  tests/debugging.
- Files:
  - `packages/desktop/src/main/main.ts`
  - `packages/desktop/src/main/lifecycle/remoteDebugging.ts`
  - `packages/desktop/src/main/lifecycle/remoteDebugging.test.ts`
  - `packages/desktop/src/main/windows/MainWindow.ts`
  - `packages/desktop/vite.config.ts`
- Acceptance criteria:
  - `QWEN_DESKTOP_CDP_PORT=<port>` appends Electron remote debugging switches
    for `127.0.0.1` and the requested numeric port only.
  - Invalid ports do not enable remote debugging.
  - Built renderer assets use relative URLs so `file://.../dist/renderer` can
    load CSS/JS.
  - MainWindow resolves preload and renderer paths correctly from
    `dist/main/windows`.
- Verification:
  - `npm run test --workspace=packages/desktop`
  - `npm run typecheck --workspace=packages/desktop`
  - `npm run lint --workspace=packages/desktop`
  - `npm run build --workspace=packages/desktop`
  - `QWEN_DESKTOP_CDP_PORT=9339 npm run start --workspace=packages/desktop`
    exposed `http://127.0.0.1:9339/json/version` and `/json/list`; process was
    terminated after endpoint verification.
- E2E coverage:
  - Record in
    `.qwen/e2e-tests/electron-desktop/cdp-renderer-observability.md`.
  - Later Playwright/DevTools MCP coverage must connect to the page websocket,
    assert DOM text and console/network health, and save a screenshot.

### Slice 11: Workspace Review Shell

- Status: complete in iteration 8
- Goal: split the renderer into explicit TopBar, ProjectSidebar, ThreadList,
  ChatThread, ReviewPanel, and TerminalDrawer components while preserving the
  current server-backed project/session/chat/settings behavior.
- Files:
  - `packages/desktop/src/renderer/App.tsx`
  - `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
  - `packages/desktop/src/renderer/components/layout/TopBar.tsx`
  - `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
  - `packages/desktop/src/renderer/components/layout/ThreadList.tsx`
  - `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
  - `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
  - `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
  - `packages/desktop/src/renderer/components/layout/StatusPill.tsx`
  - `packages/desktop/src/renderer/components/layout/formatters.ts`
  - `packages/desktop/src/renderer/components/layout/types.ts`
  - `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
  - `packages/desktop/vitest.config.ts`
- Acceptance criteria:
  - First workspace viewport visibly contains top bar, project/thread sidebar,
    central thread, right review tabs, and bottom terminal drawer structure.
  - No renderer Node access or IPC broadening.
  - Existing desktop tests and typecheck still pass.
- Completed:
  - Kept `App.tsx` as the server/state coordinator and moved visible shell
    regions into explicit renderer layout components.
  - Added stable `data-testid` landmarks for future Electron E2E and DevTools
    MCP assertions.
  - Added a jsdom renderer smoke test that renders fake project/session/diff
    data and asserts the workbench landmarks.
- Verification:
  - `npm run test --workspace=packages/desktop` passed: 9 files, 53 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm run build` passed. Existing VS Code companion lint warnings remain
    warnings only and unrelated to desktop.
  - `npm run typecheck` passed.
- E2E coverage:
  - Recorded in
    `.qwen/e2e-tests/electron-desktop/workspace-review-shell.md`.
  - Current coverage is a jsdom renderer landmark smoke test; Slice 14 must
    launch Electron and assert the same landmarks through CDP with screenshot,
    console, and network diagnostics.

### Slice 12: Diff Review and Commit

- Status: partial complete in iteration 7
- Goal: add Git diff/status review APIs and UI actions for accept/revert and
  commit.
- Files:
  - `packages/desktop/src/server/services/gitReviewService.ts`
  - `packages/desktop/src/server/index.ts`
  - `packages/desktop/src/server/index.test.ts`
  - `packages/desktop/src/server/services/projectService.ts`
  - `packages/desktop/src/renderer/api/client.ts`
  - `packages/desktop/src/renderer/App.tsx`
  - `packages/desktop/src/renderer/styles.css`
- Acceptance criteria:
  - Right Changes tab shows changed files and unified diff.
  - Stage/unstage/revert/commit routes are token protected and scoped to a
    registered project.
  - Commit errors are visible in the UI.
- Completed:
  - Token-protected diff, stage, revert, and commit routes scoped to registered
    projects.
  - Basic right Review panel changed-file list, textual diff preview, Stage
    All, Revert All, commit message input, and Commit action.
  - Server tests for diff, stage, commit, revert, invalid project path, and Git
    status metadata.
- Remaining:
  - Hunk-level accept/revert, inline comments, Open in Editor, richer file tree,
    and renderer E2E coverage.
- E2E coverage:
  - Record in `.qwen/e2e-tests/electron-desktop/diff-review-commit.md`.
  - Later Electron E2E must use a temporary Git workspace with a fake file
    change, accept/stage, commit, and error diagnostics.

### Slice 13: Scoped Terminal

- Status: partial complete in iteration 7
- Goal: add a current-project/current-thread terminal drawer with spawn, output,
  clear, kill, and send-output-to-AI plumbing.
- Files:
  - `packages/desktop/src/server/services/terminalService.ts`
  - `packages/desktop/src/server/index.ts`
  - `packages/desktop/src/server/index.test.ts`
  - `packages/desktop/src/renderer/api/client.ts`
  - `packages/desktop/src/renderer/App.tsx`
  - `packages/desktop/src/renderer/styles.css`
- Acceptance criteria:
  - Terminal cwd is constrained to the active project.
  - Terminal output is visible and copyable; kill and clear work.
  - Agent command permission remains separate from user terminal execution.
- Completed:
  - Token-protected terminal run/get/kill routes resolve cwd from the
    registered project id.
  - Bottom drawer runs project-scoped commands, polls output while running,
    supports Kill and Clear, and does not use renderer Node APIs.
  - Server tests cover command output and killing a running command.
- Remaining:
  - Interactive PTY resize/write, output selection/copy polish, send output to
    AI, terminal tabs/history, and Electron renderer E2E.
- E2E coverage:
  - Record in `.qwen/e2e-tests/electron-desktop/terminal-drawer.md`.
  - Later Electron E2E must run a harmless command in a temporary workspace and
    assert output appears in the drawer.

### Slice 14: Desktop E2E Harness

- Status: complete in iteration 9
- Goal: add repeatable Electron E2E harness with fake ACP, temporary HOME and
  workspace, screenshot/console/network diagnostics, and CDP renderer access.
- Files:
  - `packages/desktop/package.json`
  - `packages/desktop/scripts/e2e-cdp-smoke.mjs`
  - `packages/desktop/src/main/acp/createE2eAcpClient.ts`
  - `packages/desktop/src/main/main.ts`
  - `packages/desktop/src/main/native/dialogs.ts`
- Acceptance criteria:
  - `QWEN_DESKTOP_CDP_PORT` is used by the harness to inspect the renderer on
    `127.0.0.1`.
  - E2E asserts first screen is not black, service is connected, project open
    works, thread creation works, permission response works, settings save
    works, and package smoke still passes.
  - Failures write screenshots, console errors, failed requests, and main logs
    under `.qwen/e2e-tests/electron-desktop/`.
- Completed:
  - Added `npm run e2e:cdp --workspace=packages/desktop`.
  - Harness launches Electron with `QWEN_DESKTOP_CDP_PORT`, a temporary HOME,
    temporary runtime/userData directories, a temporary Git workspace, and a
    fake ACP client enabled only through E2E environment variables.
  - CDP checks stable workbench landmarks, opens the test project through the
    preload dialog path, creates a fake local thread, sends a prompt, responds
    to a command approval request, saves model settings, runs a scoped terminal
    command, and captures initial/final screenshots.
  - Failure diagnostics include screenshots, DOM text, renderer console errors,
    failed network requests, Electron stdout/stderr, and Git status/diff.
- Verification:
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm run e2e:cdp --workspace=packages/desktop` passed. Success artifacts
    were written under ignored
    `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T02-54-48-799Z/`.
  - `npm run typecheck` passed.
  - `npm run build` passed.
  - Bundle/package smoke passed:
    `npm run bundle && npm run package:dir --workspace=packages/desktop && npm run smoke:package --workspace=packages/desktop`.
  - After tightening the E2E fake ACP gate, package dir, package smoke, and
    packaged launch smoke passed again.
- E2E coverage:
  - Recorded in
    `.qwen/e2e-tests/electron-desktop/cdp-renderer-observability.md`.

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
- 2026-04-25: Keep the CDP switch opt-in through `QWEN_DESKTOP_CDP_PORT` and
  always pair it with `remote-debugging-address=127.0.0.1`; production remains
  closed unless the environment variable is set.
- 2026-04-25: Implement desktop Git review with `git` via `execFile` and
  explicit relative path validation. This avoids broad shell execution and
  keeps review operations scoped to projects registered through the desktop
  project service.
- 2026-04-25: Start the scoped terminal as a project-bound command runner
  rather than an interactive PTY. This gives the renderer verifiable output and
  kill behavior now while leaving PTY write/resize and send-output-to-AI as the
  next terminal refinement.
- 2026-04-25: Keep `App.tsx` as the renderer state/effects coordinator and
  extract the visible workspace regions into layout components. This preserves
  server-backed behavior while making the workbench structure testable through
  stable DOM landmarks.
- 2026-04-25: Add a fake ACP client only behind
  `QWEN_DESKTOP_E2E_FAKE_ACP=1` so the Electron E2E harness can cover session,
  prompt, and permission UI without credentials or network calls. Production
  startup still creates the real `AcpProcessClient`.

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
- 2026-04-25 Slice 10:
  - `npm run test --workspace=packages/desktop` passed: 8 files, 48 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `curl --fail --silent http://127.0.0.1:9339/json/version` passed while the
    app was launched with `QWEN_DESKTOP_CDP_PORT=9339`.
  - `curl --fail --silent http://127.0.0.1:9339/json/list` passed and returned
    a `Qwen Code` page at
    `file:///Users/dragon/Documents/qwen-code/packages/desktop/dist/renderer/index.html`.
- 2026-04-25 Slice 12 basic diff review:
  - `npm run test --workspace=packages/desktop` passed: 8 files, 50 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
- 2026-04-25 Slice 13 basic scoped terminal:
  - `npm run test --workspace=packages/desktop` passed: 8 files, 52 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
- 2026-04-25 Iteration 7 final verification:
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
- 2026-04-25 Slice 11 workspace shell:
  - `npm run test --workspace=packages/desktop` passed: 9 files, 53 tests.
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run lint --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm run build` passed across the configured build order. Existing VS Code
    companion lint warnings were reported by its build script, with no errors.
  - `npm run typecheck` passed across workspaces.
- 2026-04-25 Slice 14 desktop E2E harness:
  - `npm run typecheck --workspace=packages/desktop` passed.
  - `npm run build --workspace=packages/desktop` passed.
  - `npm run e2e:cdp --workspace=packages/desktop` passed and reported no
    renderer console errors or failed network requests.
  - `npm run typecheck` passed across workspaces.
  - `npm run build` passed across workspaces. Existing VS Code companion lint
    warnings were reported by its build script, with no errors.
  - Bundle/package smoke passed:
    `npm run bundle && npm run package:dir --workspace=packages/desktop && npm run smoke:package --workspace=packages/desktop`.
    Electron builder reported non-fatal metadata/dependency warnings
    consistent with prior package runs.
  - After tightening the E2E fake ACP gate, package dir, package smoke, and
    packaged launch smoke passed again.

## Self Review Notes

- Slice 9 keeps project registration behind the existing bearer-token and
  origin gates.
- Project open validates that the path exists and is a directory before
  persisting it.
- Git status failures are non-fatal and render as non-repository metadata,
  avoiding a broken workspace for projects without Git.
- Renderer still obtains the token only from preload and does not gain Node
  integration.
- Slice 10 keeps remote debugging off by default, rejects non-numeric/out of
  range ports, and binds only to loopback when enabled.
- The CDP smoke verified endpoint discovery but did not yet drive DOM,
  console, network, or screenshot assertions through MCP; that remains in the
  E2E harness slice.
- Slice 12 review operations resolve the project path from the registered
  project id server-side; renderer cannot submit arbitrary cwd values.
- File-scoped Git operations reject absolute paths and parent-directory
  traversal. The current UI exposes all-scope operations only; file/hunk UI is
  still pending.
- Revert All uses `git restore` and `git clean -fd`, so it is intentionally
  available only as an explicit user review action and remains scoped to the
  active registered project.
- Slice 13 terminal commands resolve cwd from the active registered project id
  on the server. The renderer never sends an arbitrary cwd.
- The current terminal is a command runner, not a full PTY. It does not bypass
  agent tool permission because agent shell execution still flows through ACP
  and core permissions.
- Slice 11 did not broaden preload or IPC. The renderer shell split is a pure
  component refactor with stable DOM landmarks for the future Electron/CDP
  harness.
- Slice 14 E2E hooks are gated by explicit environment variables:
  `QWEN_DESKTOP_E2E`, `QWEN_DESKTOP_E2E_FAKE_ACP`,
  `QWEN_DESKTOP_E2E_USER_DATA_DIR`, and
  `QWEN_DESKTOP_TEST_SELECT_DIRECTORY`. Normal desktop startup still uses the
  native directory picker and real ACP process.

## Remaining Work

- Implement hunk-level diff review, terminal PTY/write/send-output-to-AI
  refinements, final package smoke, and any remaining MVP polish before
  creating the DONE marker.
