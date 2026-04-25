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

## Codex Alignment Progress

### Completed Slice: Terminal Attach-to-Composer Workflow

Status: completed in iteration 5.

Goal: change terminal output follow-up from an immediate `Send to AI` action
into an explicit attach-to-composer flow, so users can review and edit command
output before deciding whether to send it to the agent.

User-visible value: terminal output becomes contextual material in the task
composer rather than a hidden second send path that can unexpectedly trigger a
new agent turn. This keeps the conversation-first workbench aligned with
`home.jpg` while preserving the terminal as a supporting tool.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/api/websocket.ts`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/terminal-drawer.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The expanded Terminal action is labeled as attaching output to the composer,
  not sending directly to AI.
- Attaching terminal output appends a bounded terminal transcript to the
  existing composer text and shows a clear success notice.
- The attach action works whenever terminal output exists, including before a
  thread is selected, and does not require or write to the session WebSocket.
- The user must still click Send from the composer before a new agent turn is
  created.
- Copy, clear, kill, run command, stdin, expand, and collapse behavior is
  unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, create a composer-first thread,
  approve the fake command, review and commit changes, expand Terminal, run
  stdout and stdin commands, attach the resulting output to the composer,
  assert no fake ACP follow-up happens until Send is clicked, then send the
  composer text and approve the fake command request.
- E2E assertions: attach button is present and `Send to AI` is absent; composer
  contains the terminal transcript after attach; terminal notice confirms the
  attachment; the output stays editable in the composer; console errors and
  failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, terminal layout JSON, composer attach
  JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained terminal
  action wording and compact composer-centric hierarchy; `electron-desktop-dev`
  for renderer changes and real Electron CDP verification.

Notes and decisions:

- The prototype keeps the composer as the task control center, so terminal
  output should land there for user review rather than bypassing it.
- This slice intentionally preserves the transcript formatting and bounding
  logic from the existing send path, but changes the destination from WebSocket
  send to composer draft text.
- The WebSocket helper no longer needs a separate terminal-output send method
  because the final send is the same explicit user-message path as any other
  composer submit.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 5 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-08-17-022Z/`.

Next work:

- Improve review safety by replacing `Accept`/`Revert` terminology with
  Stage/Unstage/Discard and confirming destructive discard paths.
- Continue prototype fidelity work in the conversation timeline by hiding
  protocol/session noise and adding inline changed-file summaries.

### Completed Slice: Collapsed Terminal Status Strip Alignment

Status: completed in iteration 4.

Goal: collapse the terminal into a compact bottom status strip by default, so
the first viewport keeps the conversation as the dominant surface while still
making terminal access discoverable.

User-visible value: users see the active project, conversation, composer, and
Git/review controls without the terminal permanently consuming a large block of
height. Terminal commands remain available through an explicit expand/collapse
control.

Expected files:

- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/terminal-drawer.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The default workbench renders a compact terminal strip rather than a full
  terminal drawer.
- The strip shows project/status context and an accessible Expand Terminal
  control.
- Expanding the terminal reveals command, stdin, output, copy, send, clear, and
  kill controls without replacing the conversation.
- Collapsing the terminal after use hides the large output region and restores
  first-viewport conversation dominance.
- Settings still replaces chat/review/terminal as before.
- Existing terminal run, stdin, copy, kill, clear, and send-to-AI behavior keeps
  working.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert the first viewport terminal strip is collapsed, open the
  fake Git project, send from the composer, approve the fake command, review
  and commit changes, open settings, return to conversation, expand Terminal,
  run commands including stdin, send output to the fake ACP session, collapse
  Terminal again, and assert the final layout returns to a compact strip.
- E2E assertions: initial and completed terminal heights stay compact; expanded
  terminal height stays supporting and docked; conversation remains wider and
  taller than terminal by default; console errors and failed local requests are
  absent.
- Diagnostic artifacts: CDP screenshots, collapsed/expanded layout JSON,
  Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained bottom
  strip hierarchy, compact controls, and conversation-first density;
  `electron-desktop-dev` for renderer changes and real Electron CDP
  verification.

Notes and decisions:

- This slice follows `home.jpg` over the older always-visible terminal panel:
  terminal remains a supporting workbench tool, not a permanent third major
  viewport region.
- The terminal strip remains in the workbench rather than moving into settings
  or review, because running commands in the active project is part of the
  coding-agent loop.
- The existing Send to AI behavior is preserved for this slice; changing that
  to attach output to the composer is still the next terminal workflow
  refinement.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 4 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-00-08-461Z/`.

Next work:

- Rename terminal Send to AI into an attach-to-composer flow so command output
  does not unexpectedly trigger another agent turn.
- Continue review safety work by replacing Accept/Revert terminology with
  Stage/Unstage/Discard and adding confirmations for destructive discard
  paths.

### Completed Slice: Review Drawer and Compact Topbar Alignment

Status: completed in iteration 3.

Goal: make review a supporting drawer that opens beside the conversation, and
replace the heavy topbar tabs with compact icon-led workbench actions.

User-visible value: the first viewport keeps the conversation as the main
workspace while still exposing changed files, settings, Git refresh, and status
from a slim topbar that better matches `home.jpg`.

Expected files:

- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/review-drawer-topbar.md`

Acceptance criteria:

- Opening Changes renders `ChatThread` and `ReviewPanel` together; review no
  longer replaces the conversation.
- The default first viewport has no review drawer, and the conversation spans
  the workbench.
- Topbar action controls are compact icon buttons with accessible labels and
  tooltips; the previous Chat/Changes/Settings segmented text tabs are removed.
- The topbar title remains the active thread/project identity instead of
  changing to `Changes` when review opens.
- Settings still opens as a full workbench page and hides the terminal.
- Existing review actions, comments, staging, and commit workflow keep working.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send from the project composer,
  approve the fake command, open Changes from the compact topbar action, review
  and comment on the README diff while chat remains mounted, stage all changes,
  commit, return to chat, open settings, and run terminal paths.
- E2E assertions: default layout has no review drawer; opening Changes creates
  a drawer without unmounting chat; drawer width stays supporting rather than
  dominant; topbar has compact action buttons; console errors and failed local
  requests are absent.
- Diagnostic artifacts: CDP screenshots, layout JSON, DOM text, Electron log,
  summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained topbar
  density and drawer hierarchy; `electron-desktop-dev` for renderer changes and
  real Electron CDP verification.

Notes and decisions:

- This slice deliberately keeps Settings as a full page because that behavior
  was already implemented and verified; only review moves into the supporting
  drawer pattern.
- The review drawer remains closed by default to preserve the first viewport
  emphasis from `home.jpg`; Git dirty count and the Changes action are the
  visible entry points.
- `frontend-design` guidance is applied with the project prompt constraint that
  the prototype wins: compact utility controls, restrained borders, and no new
  decorative art direction.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 4 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T16-51-33-353Z/`.

Next work:

- Improve review terminology and safety by replacing `Accept`/`Revert` with
  Stage/Unstage/Discard language and adding confirmations for destructive
  discard paths.
- Collapse the terminal into a status strip by default so the first viewport
  gets closer to `home.jpg`.

### Completed Slice: Composer-First Thread Creation Alignment

Status: completed in iteration 2.

Goal: let a user open a project and type immediately, without first learning
that they must create or select a session.

User-visible value: the default path becomes
`Open project -> type request -> agent works`; the composer explains the active
project context and creates the backing desktop session on first send.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-first-thread-creation.md`

Acceptance criteria:

- Composer is enabled whenever a project is active, even when no session is
  selected.
- With no project, composer remains disabled and gives a clear disabled reason.
- First send from a project with no selected session creates a desktop session,
  sends the message, clears the composer, and publishes the created thread.
- Existing explicit `New Thread` behavior continues to work.
- The composer visibly carries compact project/branch, permission, and model
  context so it reads as the task control center rather than a plain textarea.
- `Enter` send and `Shift+Enter` newline behavior are preserved.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, type a prompt into the project-scoped
  composer without clicking `New Thread`, send it, approve the fake command
  request, and assert the created thread/message/response appear.
- E2E assertions: first viewport landmarks stay present; composer is enabled
  after project open; no `New Thread` click is required; fake ACP response is
  received; console errors and failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, layout JSON, DOM text, Electron log,
  summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for composer layout/control
  hierarchy with the prototype as the strict visual contract; `electron-desktop-dev`
  for renderer changes and real Electron CDP verification.

Notes and decisions:

- The prototype wins over earlier tab/dashboard guidance. This slice keeps the
  conversation as the default surface and upgrades the bottom composer without
  opening review, terminal, or settings by default.
- Model and permission controls are compact context controls in the composer.
  They use existing session runtime state when available and safe fallback
  labels before a session exists; changing values still requires a live session
  until the server API supports project-level defaults.
- Implementation changed first-send behavior so any active project with no
  active session creates a session on submit. The explicit `New Thread` button
  still creates a draft thread for users who want to start intentionally from
  the sidebar.
- CDP smoke now sends the first prompt immediately after opening the fake
  project and before clicking `Changes`, proving the `New Thread` click is no
  longer required.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 4 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T16-41-09-752Z/`.

Next work:

- Continue prototype fidelity by reducing topbar tab weight and moving review
  access toward compact icon/drawer behavior.
- Follow-up model configuration work should make composer model/permission
  controls editable before a session exists by persisting project-level
  defaults, rather than only reflecting live session runtime state.
