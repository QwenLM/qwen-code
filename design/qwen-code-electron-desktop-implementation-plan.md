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

### Slice: No-Project Topbar Context Restraint

Status: completed in iteration 95.

Goal: remove repeated no-project placeholders from the startup topbar so the
header stays slim and tool-like while the conversation/composer remain the
primary project-open path.

User-visible value: first-launch users no longer see `No project selected`,
`No Git branch`, and `No project` repeated in the top chrome. The topbar keeps
the app identity and runtime connection visible, while project, branch, and
diff context appear only after a workspace is open.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-topbar-context-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With no active project, the topbar title remains `Qwen Code Desktop` and the
  topbar does not render visible `No project selected`, `No Git branch`, or
  `No project` placeholder copy.
- With no active project, the topbar context renders the connection item only;
  branch switching and Git status controls are absent instead of disabled
  placeholders.
- Project-scoped behavior is unchanged: after opening a Git workspace, branch
  switching, compact dirty diff stats, review entry, settings entry, and the
  project name remain visible and contained.
- Topbar height, one-row alignment, typography, and first-viewport containment
  remain within the existing CDP geometry bounds.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and no active project, assert the restrained no-project topbar text and
  absent disabled branch/Git placeholders, open the fake Git project, then
  continue the existing model, settings, terminal, review, branch, discard
  safety, compact viewport, and commit smoke paths.
- E2E assertions: startup topbar has no repeated no-project placeholder copy,
  only one context item for connection, no branch/Git controls before a project
  opens, project-scoped topbar branch/diff behavior still passes, and no
  console errors or failed local requests are recorded.
- Diagnostic artifacts to collect on failure:
  `initial-layout.json`, `no-project-topbar-context-restraint.json`,
  `initial-workspace.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` compared replacing the placeholders
  with an `Open Project` chip, keeping a shortened disabled branch label, and
  hiding project-only context until a project exists, choosing the last option
  because the composer/sidebar/conversation already expose the project-open
  action; `frontend-design`, constrained by `home.jpg`, keeps the header
  compact and icon-led; and `electron-desktop-dev` requires real Electron CDP
  coverage because this changes renderer behavior and first-viewport geometry.

Notes and decisions:

- The slice intentionally hides branch and Git status controls until an active
  project exists. It does not add another Open Project chip to the topbar
  because the startup viewport already exposes Open Project in the sidebar,
  conversation empty state, and composer.
- Active-project behavior is unchanged: branch switching, dirty diff stats, and
  review/settings actions still render through the existing controls.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T03-05-37-622Z/`.
- `no-project-topbar-context-restraint.json` recorded the startup topbar text
  as `Qwen Code DesktopConnectedConversationChangesSettingsReady`, the title
  project label as `null`, exactly one context item (`Connected`), no branch
  trigger, no Git status control, and no document/topbar overflow.
- `summary.json` recorded zero console errors and zero failed local requests.
- `git diff --check` passed.

Self-review:

- The first viewport moves closer to `home.jpg`: top chrome is slimmer and no
  longer reads like disabled debug state before a project is open.
- The project-open path remains clear through the sidebar, conversation empty
  action, and composer, so removing no-project branch/Git placeholders does not
  hide the primary next action.
- No Electron main/preload security settings, IPC routes, token handling, local
  server behavior, Git operations, settings persistence, terminal workflow, or
  ACP transport changed.

Next work:

- Continue startup fidelity by checking whether the no-project topbar action
  cluster should visually de-emphasize unavailable Changes while preserving the
  project-scoped review entry.
- Continue normal workflow hardening by improving recovery from model/provider
  save failures and invalid provider configuration.

### Slice: No-Project Terminal Strip Restraint

Status: completed in iteration 94.

Goal: reduce the bottom terminal chrome weight in the no-project startup
viewport so it reads as a quiet supporting surface instead of another repeated
project/status row.

User-visible value: first-launch users see the project-open path and composer
as the primary actions. The collapsed terminal remains discoverable, but it no
longer repeats `No project`, `Idle`, and `No recent command` below the composer.

Expected files:

- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-terminal-strip-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With no active project and the terminal collapsed, the strip shows a compact
  `Terminal` identity plus a muted `Open a project to run commands` preview.
- The no-project collapsed strip does not render the separate `Idle` status
  pill or repeated visible `No project` terminal label.
- Project-scoped terminal behavior stays unchanged: collapsed strip still shows
  project, status, preview; expanded terminal command, stdin, copy, attach,
  clear, and kill paths continue to work.
- The terminal strip remains docked below the conversation, contained at default
  and compact Electron viewports, and does not introduce document overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and no active project, assert the no-project terminal strip copy and
  containment, open the fake Git project, verify the project-scoped strip and
  continue the existing model, settings, terminal, review, branch, discard
  safety, compact viewport, and commit smoke paths.
- E2E assertions: initial terminal strip has no visible no-project repetition
  or status pill, preview is muted and contained, the collapsed drawer remains
  supporting, project terminal metrics still pass, and no console errors or
  failed local requests are recorded.
- Diagnostic artifacts to collect on failure:
  `initial-layout.json`, `initial-workspace.png`,
  `no-project-terminal-strip-restraint.json`, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` compared hiding the terminal
  entirely, shrinking the global collapsed strip, and a no-project-specific
  restrained copy treatment, selecting the last option because it preserves the
  terminal affordance while removing repeated startup noise; `frontend-design`,
  constrained by `home.jpg`, keeps bottom chrome secondary to the composer; and
  `electron-desktop-dev` requires real Electron CDP coverage because this
  changes renderer behavior and first-viewport geometry.

Notes and decisions:

- The slice intentionally does not hide the terminal or change the active
  project terminal workflow. It only changes the no-project collapsed summary
  copy and styling.
- Expanded no-project terminal still communicates that a project is required
  through the existing disabled command placeholder.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-56-35-264Z/`.
- `no-project-terminal-strip-restraint.json` recorded the collapsed no-project
  terminal as a `42` px docked strip with `Terminal` identity, no status pill,
  preview `Open a project to run commands`, no repeated visible `No project`,
  `Idle`, or `No recent command` terminal copy, and no document overflow.
- `summary.json` recorded zero console errors and zero failed local requests.

Self-review:

- The no-project first viewport now keeps the project-open path and composer as
  the primary bottom actions while leaving the terminal discoverable as a
  restrained supporting strip.
- Project-scoped terminal behavior is unchanged: the active project strip still
  renders project, status, preview, and the existing expanded command/stdin,
  copy, attach, clear, and kill flows passed the CDP harness.
- The change is limited to renderer markup/style plus component and CDP
  assertions. No Electron main/preload security settings, local server routes,
  token handling, settings persistence, Git operations, or ACP transport
  changed.

Next work:

- Continue no-project prototype fidelity by reducing topbar repetition between
  `No project selected`, `No Git branch`, and `No project` while preserving
  clear startup state.
- Continue normal workflow hardening by improving recovery from model/provider
  save failures and invalid provider configuration.

### Slice: No-Project Conversation Empty Action

Status: completed in iteration 93.

Goal: make the no-project conversation canvas feel intentionally actionable by
adding a compact in-canvas Open Project icon affordance beside the existing
quiet empty-state copy, without turning the first viewport into onboarding or a
landing page.

User-visible value: a first-launch user can start from the conversation area,
composer, or sidebar, and the large empty workbench reads as a usable coding
workspace rather than a blank debug canvas.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-conversation-empty-action.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With no active project, the conversation empty state keeps the exact visible
  copy `Open a project to start` and adds one compact icon-only Open Project
  button with accessible label/title.
- The empty-state button reuses the existing project picker callback and does
  not add a new native IPC path.
- The empty state stays visually quiet, near the composer, and does not add a
  card, marketing copy, feature instructions, duplicate passive rows, or
  document/composer overflow.
- Existing sidebar and composer Open Project actions remain present,
  contained, accessible, and secondary.
- Project-scoped composer, settings, model, branch, review, terminal, discard,
  and commit paths remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and no active project, assert the no-project conversation empty action,
  sidebar action, disabled composer action, and lack of passive noise, click
  the no-project conversation action to open the fake Git project, then continue
  the existing model, settings, terminal, review, branch, discard safety,
  compact viewport, and commit smoke paths.
- E2E assertions: the conversation empty action is icon-only, accessible,
  compact, transparent by default, contained near the empty label, and wired to
  the same project-open flow; no console errors or failed local requests are
  recorded.
- Diagnostic artifacts to collect on failure:
  `no-project-open-project-affordance.json`, `initial-workspace.png`,
  `project-composer.json`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` considered a large empty card, a
  recent-project list, and a compact in-canvas icon action, choosing the icon
  action because it is the smallest prototype-aligned affordance; `frontend-design`,
  constrained by `home.jpg`, keeps the empty state dense and tool-like; and
  `electron-desktop-dev` requires real Electron CDP coverage because this
  changes renderer behavior and the startup project-open workflow.

Notes and decisions:

- The slice intentionally does not add onboarding prose or a central card. The
  prototype contract favors a conversation-first workbench with quiet controls.
- The action is icon-only in the conversation canvas to avoid duplicating the
  larger composer label and to keep visible copy stable for tests and scanning.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-47-11-149Z/`.
- `no-project-open-project-affordance.json` recorded the conversation Open
  Project action as an icon-only `24 x 24` px button with accessible
  label/title, transparent default chrome, no overflow, and the same visible
  empty-state copy.
- `summary.json` recorded zero console errors and zero failed local requests.
- `git diff --check` passed.

Self-review:

- The startup viewport is slightly more actionable without adding a landing
  card, onboarding instructions, large duplicated labels, or new app chrome.
- The change is limited to renderer markup/style plus component and CDP
  assertions. No Electron main/preload security settings, local server routes,
  token handling, settings persistence, Git operations, terminal behavior, or
  ACP workflow changed.
- The conversation, composer, and sidebar now expose the same project-open path
  at different densities while keeping the disabled no-project composer and
  passive sidebar rows quiet.

Next work:

- Continue prototype fidelity by reducing the remaining no-project terminal
  strip weight and checking the first-viewport bottom chrome against `home.jpg`.
- Continue normal workflow hardening by improving recovery from model/provider
  save failures and invalid provider configuration.

### Slice: No-Project Sidebar Open Project Affordance

Status: completed in iteration 92.

Goal: make the no-project startup state expose a compact, actionable Open
Project row in the persistent sidebar instead of a passive empty label, reducing
startup dead space while keeping the composer-first path intact.

User-visible value: a user who opens the desktop app with no recent project can
start from either the left project browser or the composer without decoding a
tiny heading icon. The sidebar still stays quiet and dense like `home.jpg`.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-sidebar-open-project.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With no project selected, the sidebar project browser shows exactly one
  compact Open Project button row with an icon, accessible label, and title.
- The passive `No folder selected` row no longer appears in the no-project
  sidebar, and no duplicate thread/no-session rows appear.
- Clicking the sidebar Open Project row in the real Electron harness opens the
  fake Git project and enables the normal project-scoped composer.
- The existing composer Open Project button remains visible, contained, and
  secondary in the disabled composer state.
- The change does not affect project switching, thread rows, branch controls,
  settings, review, terminal, local server routes, preload, IPC, or ACP
  behavior.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and no active project, assert the no-project sidebar and disabled composer
  affordances, click the sidebar Open Project row, select the fake Git
  workspace through the existing dialog route, then continue the existing model,
  settings, terminal, review, branch, discard safety, compact viewport, and
  commit smoke paths.
- E2E assertions: the sidebar no-project row is an actionable button with icon
  and low chrome, it is contained without overflow, the passive empty row is
  absent, the composer Open Project action remains contained, and no console
  errors or failed local requests are recorded.
- Diagnostic artifacts to collect on failure:
  `no-project-open-project-affordance.json`, `initial-workspace.png`,
  `project-composer.json`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected this as a small vertical
  startup workflow improvement; `frontend-design`, constrained by `home.jpg`,
  keeps the new row compact and tool-like instead of making a landing page; and
  `electron-desktop-dev` requires real Electron CDP coverage because the slice
  changes renderer behavior and a user workflow.

Notes and decisions:

- The slice deliberately reuses the existing project picker callback; it does
  not add a new native IPC path or duplicate recent-project persistence logic.
- The no-project composer remains the primary bottom control center. The new
  sidebar row is a left-rail shortcut for the same action.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-38-25-406Z/`.
- `no-project-open-project-affordance.json` recorded the sidebar Open Project
  row as a `227 x 28` px button with icon, transparent default background, no
  overflow, and no passive `No folder selected` or duplicate thread rows.
- `summary.json` recorded zero console errors and zero failed local requests.
- `git diff --check` passed.

Self-review:

- The startup viewport is closer to the intended workbench flow because the
  persistent project browser now offers the same Open Project path as the
  composer, without adding a landing page or a large card.
- The change is limited to renderer markup/style plus tests and CDP assertions.
  No Electron main/preload security settings, local server routes, token
  handling, settings persistence, Git operations, terminal behavior, or ACP
  workflow changed.
- The new button keeps the existing compact sidebar density, accessible label,
  title, icon, and hover behavior.

Next work:

- Continue prototype fidelity by reducing the no-project main-canvas visual
  emptiness without turning it into a marketing or onboarding page.
- Continue normal workflow hardening by improving model/provider save error
  visibility and recovery inside the settings drawer.

### Slice: Single-Line Topbar Context Alignment

Status: completed in iteration 91.

Goal: make the topbar title, project, connection, branch, and diff context read
as one slim desktop chrome row at normal desktop width, matching `home.jpg`
more closely without losing compact overflow behavior.

User-visible value: the first viewport feels less like a two-line status panel
and more like a desktop workbench title bar. Users still see the active thread,
project, connection, branch, and diff state, but the conversation gets clearer
visual priority.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/topbar-single-line-context.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- At the default CDP viewport, `topbar-title` and `topbar-context` align on the
  same visual row inside the 46-52 px topbar.
- Thread title, project name, connection status, branch control, and diff stat
  stay visible, compact, and non-overflowing.
- Long project and branch names still truncate visibly while preserving full
  metadata in titles/accessible labels.
- Existing branch switching, review drawer, settings overlay, composer,
  terminal, and commit paths remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data,
  open the fake Git project, send and approve the deterministic prompt, assert
  the default topbar title/context geometry, then continue the existing model,
  settings, terminal, review, branch, discard safety, compact viewport, and
  commit smoke paths.
- E2E assertions: topbar remains slim; title/context are row-aligned at normal
  width; title/context/actions/status stay contained; no long branch leaks into
  visible text; diff details stay available through title/aria labels; no
  console errors or failed local requests are recorded.
- Diagnostic artifacts to collect on failure:
  `topbar-context-fidelity.json`, `topbar-context-fidelity.png`,
  `compact-review-drawer.json`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected the smallest visual
  fidelity follow-up from iteration 90's next-work notes; `frontend-design`,
  constrained by `home.jpg`, keeps the title bar dense and tool-like rather
  than adding a new visual direction; and `electron-desktop-dev` requires real
  Electron CDP geometry checks because this slice changes renderer CSS.

Notes and decisions:

- The slice is CSS plus harness assertion only. It does not change React state,
  branch behavior, review/settings/terminal behavior, local server routes,
  preload IPC, Git operations, credential handling, or ACP transport.
- Compact/mobile media rules may still wrap the topbar; the single-line
  contract is for the normal desktop viewport used by the primary workbench.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-29-07-726Z/`.
- `topbar-context-fidelity.json` recorded a 50 px topbar with the title stack
  at `15` px tall, title/context center delta `0`, vertical overlap `14`, no
  visible long-branch leak, no body overflow, and all topbar elements
  contained.
- `compact-review-drawer.json` recorded the compact review viewport with a
  50 px topbar, `28 x 28` topbar actions, no topbar/review/composer overflow,
  and the conversation still wider than the review drawer.
- `branch-create-menu.json` recorded the branch menu as contained and
  visually hit-testable, covering the branch popover clipping regression found
  during self-review.
- `summary.json` recorded zero console errors and zero failed local requests.
- `git diff --check` passed.

Self-review:

- The first viewport moves closer to `home.jpg` by turning the topbar identity
  and context into a single desktop chrome row while keeping the existing slim
  50 px header.
- The change is CSS plus CDP assertion coverage only. No Electron main/preload
  security settings, local server routes, token handling, settings
  persistence, Git operations, terminal behavior, or ACP workflow changed.
- Long branch/project values remain visibly truncated, with full values still
  preserved in titles and accessible labels.
- The branch menu remains visible because the final CSS keeps popover overflow
  visible while truncating only the individual topbar labels.

Next work:

- Continue prototype fidelity by reducing no-project empty-space weight and
  checking the default sidebar/topbar text scale against `home.jpg`.
- Continue normal workflow hardening by improving model/provider save error
  visibility in the settings drawer.

### Slice: Topbar Action Chrome Restraint

Status: completed in iteration 90.

Goal: make the topbar action cluster and runtime status read as quiet desktop
chrome instead of framed toolbar buttons, while preserving the existing
conversation, review, settings, branch, and diff workflows.

User-visible value: the first viewport moves closer to `home.jpg`: the thread
title, project, branch, and diff context remain scannable, but the repeated
topbar actions stop competing with the conversation and composer.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/topbar-action-chrome-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Default topbar icon buttons have transparent or near-transparent chrome with
  compact icon geometry and accessible labels/tooltips unchanged.
- Active/hover topbar actions use a subtle low-alpha surface, not heavy bordered
  button frames.
- The runtime status remains visible and accessible but no longer reads as a
  prominent bordered pill.
- The changed-files badge stays contained and secondary, with no overflow in
  default or compact review Electron viewports.
- Existing branch switching, review drawer, settings overlay, composer,
  terminal, relaunch, and commit paths remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data,
  open the fake Git project, send and approve the deterministic prompt, assert
  the topbar action chrome metrics, open review at default and compact widths,
  and continue the existing settings, terminal, relaunch, branch, discard
  safety, and commit smoke paths.
- E2E assertions: topbar action default backgrounds and borders stay low-alpha,
  active/hover frames stay bounded, runtime status border is removed or
  negligible, badges stay small and contained, and no console errors or failed
  local requests are recorded.
- Diagnostic artifacts to collect on failure:
  `topbar-context-fidelity.json`, `topbar-context-fidelity.png`,
  `compact-review-drawer.json`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected the smallest visual
  fidelity slice from the prior next-work notes; `frontend-design`, constrained
  by `home.jpg`, keeps action controls icon-led and restrained; and
  `electron-desktop-dev` requires real Electron CDP coverage because this slice
  changes renderer CSS and first-viewport geometry.

Notes and decisions:

- The slice is intentionally CSS and harness only. It does not move actions,
  change branch/review/settings behavior, or alter local server, preload, IPC,
  Git, credential, terminal, or ACP contracts.
- The existing action labels and native button semantics stay intact; the
  change reduces visual weight rather than hiding controls.
- The first real Electron run exposed an over-strict harness assertion that
  treated the icon button's inherited computed font size as visible chrome.
  The assertion now checks frame and badge style instead of inherited font size.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed on the inherited
  font-size harness false positive; diagnostics were saved at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-16-01-286Z/`.
- After correcting the assertion,
  `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-16-34-459Z/`.
- `topbar-context-fidelity.json` recorded a 50 px topbar, inactive action
  background/border alpha `0`, active action background alpha `0.07`, active
  border alpha `0.12`, runtime status `58.0546875 x 26` with background alpha
  `0.055` and transparent borders, changed-files badge `13` px tall with
  background alpha `0.72`, no long-branch leakage, and no containment failure.
- `compact-review-drawer.json` recorded the compact review viewport with
  `28 x 28` topbar actions, no topbar/review/composer overflow, and the
  conversation still wider than the review drawer.
- `summary.json` recorded zero console errors and zero failed local requests.
- `git diff --check` passed.

Self-review:

- The first viewport moves closer to the prototype by removing inactive framed
  topbar buttons and softening the runtime pill without hiding project, branch,
  diff, review, settings, or runtime state.
- The change is CSS plus E2E assertion coverage only. No Electron main/preload
  security settings, local server routes, token handling, settings persistence,
  Git operations, terminal behavior, or ACP workflow changed.
- The topbar still exposes accessible labels, titles, active pressed state, and
  the existing compact changed-files affordance.

Next work:

- Continue prototype fidelity by making the topbar title/context layout more
  single-row when space permits, matching `home.jpg` without losing long-label
  containment.
- Continue normal workflow hardening by improving model/provider save error
  visibility in the settings drawer.

### Slice: Composer Missing Key Send Guidance

Status: completed in iteration 89.

Goal: make sends against a saved provider model with a missing API key explain
the likely failure without blocking intentional testing or widening the
composer.

User-visible value: when a user types a first prompt with the selected saved
model still missing its provider key, the composer gives a compact warning at
the send decision point while still letting the user proceed.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-missing-key-send-guidance.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With a saved provider model whose API key is missing, typing a message shows a
  compact warning chip in the composer action cluster.
- The warning explains that the selected model is missing an API key and that
  sending may fail, but the Send button remains enabled when the prompt is
  non-empty.
- The warning reuses the existing compact composer note geometry, replaces the
  lower-value draft `New thread` chip while typing, and does not expose secrets,
  local server URLs, raw provider prefixes, or diagnostics.
- Empty draft composer state still shows `New thread`; configured provider
  models and runtime/default models keep the quiet send affordance.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: seed the isolated E2E HOME with a saved provider model
  lacking a key, open the fake project, type the first prompt, assert the
  composer warning chip and Send title explain the missing-key risk while Send
  remains enabled, then send and continue the existing draft runtime,
  approval, settings, branch, review, terminal, relaunch, and commit paths.
- E2E assertions: warning text/title/class, Send enabled/title, no `New thread`
  chip while the warning is active, no fake secrets or local server URL leakage,
  no composer/control/action overflow, and zero unexpected console errors or
  failed local requests.
- Diagnostic artifacts to collect on failure:
  `composer-missing-key-send-guidance.json`,
  `composer-missing-key-send-guidance.png`, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected a compact warning chip at
  the send decision point over a blocking modal or permanent warning copy;
  `frontend-design`, constrained by `home.jpg`, keeps the warning dense and
  inside the composer controls; and `electron-desktop-dev` requires real
  Electron CDP coverage because the slice depends on seeded settings, renderer
  composer state, lazy session creation, and layout geometry.

Notes and decisions:

- The slice intentionally keeps missing-key sends allowed. Some users may be
  intentionally testing provider setup or relying on an external environment,
  so the warning should inform rather than block.
- The warning appears only after the user has typed a prompt, preserving the
  quieter no-input draft state and the existing icon-only missing-key shortcut.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 40 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-08-03-032Z/`.
- `composer-missing-key-send-guidance.json` recorded the warning chip as
  `API key missing`, 102.0 x 22 px, warning-styled, non-overflowing, and titled
  `Selected model is missing an API key; sending may fail until configured.`;
  the Send action stayed enabled with the matching warning title; the draft
  `New thread` chip was absent while the warning was active; no fake secrets,
  local server URLs, raw Coding Plan labels, composer overflow, action overflow,
  or document overflow were recorded.
- `summary.json` recorded zero console errors and zero failed local requests.

Self-review:

- The first viewport remains composer-first and conversation-dominant; the
  warning only replaces one compact composer chip while the user is actively
  preparing a send against a missing-key model.
- The change is renderer/CSS/harness only. No Electron main/preload IPC,
  local server route, token handling, credential persistence, Git, review,
  terminal, or ACP transport behavior changed.
- Missing-key sends stay non-blocking, and configured provider/default runtime
  models keep the previous quiet Send title and controls.

Next work:

- Continue prototype fidelity by tightening the topbar/action icon weight and
  checking no-project/sidebar typography against `home.jpg`.
- Continue normal workflow hardening by making model/provider save errors more
  discoverable without adding dashboard chrome.

### Slice: No-Project Open Project Composer Affordance

Status: completed in iteration 88.

Goal: make the first no-project viewport immediately actionable from the
composer control center while keeping the empty conversation and sidebar quiet.

User-visible value: a user who launches the desktop app with no recent project
can open a project from the same bottom task area they will use after the
project is active, instead of scanning the mostly empty workbench or relying on
the tiny sidebar heading icon.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-open-project-affordance.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With no active project, the composer remains disabled for text entry but shows
  a compact, clickable `Open Project` action in the composer action cluster.
- The no-project action uses icon-plus-label affordance, accessible label/title,
  and muted secondary styling; the disabled Send action remains visually neutral.
- The conversation empty state remains quiet and near the composer rather than
  becoming a landing page.
- The sidebar no-project state avoids duplicate thread/session noise while
  preserving the normal project/thread browser once a project is selected.
- Clicking the composer `Open Project` action follows the existing native
  project-open path and leaves the project composer enabled afterward.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/user-data and no
  active project, assert the composer-scoped Open Project action is visible,
  compact, accessible, and not overflowing, click it, select the fake project
  through the existing native dialog path, and assert the normal project composer
  is enabled.
- E2E assertions: no-project conversation stays visually quiet, sidebar empty
  state has no duplicate `No sessions` row, the new action is contained in the
  composer action cluster, disabled Send stays neutral, the document has no
  overflow, and zero unexpected console errors or failed local requests are
  recorded.
- Diagnostic artifacts to collect on failure:
  `initial-layout.json`, `no-project-open-project-affordance.json`,
  `initial-workspace.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected the compact composer action
  over a large welcome panel or enabling a text input without a project;
  `frontend-design`, constrained by `home.jpg`, keeps the startup surface dense,
  icon-led, and quiet; and `electron-desktop-dev` requires a real Electron CDP
  path because the slice depends on native project selection, renderer state,
  and layout geometry.

Notes and decisions:

- Brainstormed alternatives: add a large centered empty-state card, make the
  textarea itself trigger project selection, or add a compact action beside the
  disabled Send control. The compact composer action is the smallest
  prototype-faithful path because it keeps the bottom composer as the task
  control center without making the first viewport a landing page.
- This slice intentionally does not change recent-project persistence, native
  dialog behavior, lazy session creation, model/provider persistence, or the
  active-project composer controls.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 39 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-57-00-235Z/`.
- `no-project-open-project-affordance.json` recorded the composer
  `Open Project` button as enabled, icon-led, 109.9 x 26 px, contained in the
  composer action cluster, and non-overflowing; the textarea and Send stayed
  disabled; the sidebar had one quiet `No folder selected` row and no
  `No sessions` row; `summary.json` recorded zero console errors and zero
  failed local requests.

Self-review:

- The first viewport stays conversation-first and avoids a welcome-card/landing
  composition; the only new visible affordance is a compact action in the
  composer control cluster.
- The no-project action reuses the existing native project selection callback;
  no new IPC, server route, local server exposure, credential handling, or
  Electron security setting was added.
- Active-project composer-first thread creation, draft model/mode controls,
  branch/review/settings/terminal, and commit workflows remain covered by the
  CDP smoke.

Next work:

- Continue prototype fidelity by tightening topbar/action icon weight and
  checking the no-project sidebar action typography against `home.jpg`.
- Continue composer-first polish by making missing-key draft sends explain the
  likely provider failure without blocking intentional testing.

### Slice: Draft Runtime Controls Apply On First Send

Status: completed in iteration 87.

Goal: let users choose the draft thread's permission mode and saved model from
the compact composer before the first message, then apply those runtime choices
when the lazy-created session starts.

User-visible value: opening a project feels composer-first and predictable; the
model and permission controls visible in the composer are not inert before a
thread exists.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.test.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/draft-runtime-controls-apply-on-send.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- With an active project and no selected thread, the permission mode control is
  enabled and offers the compact default draft modes.
- With saved provider models, the draft model control is enabled, keeps provider
  grouping/health metadata, and does not expose API keys or diagnostics.
- Changing draft mode/model updates the composer immediately without opening
  Settings or creating a session.
- Sending the first prompt creates a session, applies the selected draft mode
  and model before the prompt is sent, and the active composer reflects those
  applied values.
- Existing active-session model/mode switching behavior stays unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: seed saved provider models in the isolated E2E HOME,
  launch real Electron with fake ACP, open a project with no selected thread,
  assert draft mode/model controls are enabled and compact, switch the draft
  permission mode to Auto Edit, send the first prompt, assert the active
  session composer shows the saved provider model and Auto Edit mode, then
  continue the existing approval, settings, branch, review, terminal, relaunch,
  and commit paths.
- E2E assertions: draft controls are enabled only when a project is active,
  option labels remain compact and provider-grouped, selected draft values
  persist through lazy session creation, the prompt reaches fake ACP after the
  runtime calls, no fake secrets/server URLs appear in normal conversation, no
  composer overflow occurs, and zero unexpected console errors or failed local
  requests are recorded.
- Diagnostic artifacts to collect on failure:
  `draft-runtime-controls.json`, `draft-runtime-controls-applied.json`,
  `draft-composer-saved-model-state.json`, Electron log, screenshots, and
  `summary.json` under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected enabling the existing
  compact draft controls over adding a larger preflight panel or Settings
  detour; `frontend-design`, constrained by `home.jpg`, keeps the composer as
  a dense task control strip; and `electron-desktop-dev` requires real
  Electron CDP interaction because the slice depends on session creation,
  renderer state, local server routes, and fake ACP ordering.

Notes and decisions:

- Brainstormed alternatives: keep selectors disabled and show explanatory copy,
  add a pre-send configuration dialog, or enable the existing compact composer
  controls and apply their choices during lazy session creation. The existing
  controls are the smallest prototype-faithful path because they preserve the
  first viewport and make visible composer state truthful.
- During the first CDP run, Settings > Permissions exposed a stale saved-model
  provider key state after the draft-selected provider model was later
  configured. The fix lets saved provider metadata from current Settings
  refresh duplicate compact ACP model records while preserving unrelated
  runtime metadata.
- The slice intentionally does not add new model provider persistence, live
  credential validation, attachment support, new ACP routes, or a larger
  Settings information architecture change.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 49 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-46-03-770Z/`.
- `draft-runtime-controls.json` recorded enabled draft permission/model
  controls, default mode, selected `qwen-e2e-cdp`, missing-key provider
  metadata, 124 x 24 px runtime controls, no overflow, no secrets, and no local
  server URL leakage.
- `draft-runtime-controls-applied.json` recorded the first-send session with
  `auto-edit` permission mode and `qwen-e2e-cdp` model applied while the inline
  command approval was visible, with no `New thread` notice remaining and no
  overflow/secrets/server URL leakage.
- `summary.json` recorded zero console errors and zero failed local requests.

Self-review:

- The first viewport remains conversation-first and prototype-aligned; the
  change makes the existing compact composer controls truthful instead of
  adding a larger panel.
- Draft runtime state stays renderer-local until lazy session creation; no new
  IPC, preload, local server routes, credentials, or Electron security settings
  were added.
- Missing-key state remains visible and actionable through the existing model
  provider shortcut. The slice does not hide the risk of sending with a missing
  provider key.
- Active-session model/mode switching, Settings persistence, branch/review,
  terminal, commit, and fake ACP workflows stayed covered by the existing CDP
  smoke.

Next work:

- Continue composer-first polish by making missing-key draft sends explain the
  likely provider failure without blocking users from intentionally testing a
  saved provider.
- Continue prototype fidelity by checking the no-project first viewport Open
  Project affordance and sidebar density against `home.jpg`.

### Slice: Composer Missing Provider Key Shortcut

Status: completed in iteration 86.

Goal: make a selected saved model with a missing provider key actionable from
the compact composer controls without adding a larger Settings surface or
exposing secrets.

User-visible value: users who have a saved provider model but no configured
API key can see that the composer model action needs attention and can open
Model Providers directly from the composer.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-missing-provider-key-shortcut.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The composer keeps its compact model status dot and icon-only Configure
  models control.
- When the selected saved provider model reports `API key missing`, the
  Configure models control uses warning styling and an accessible title that
  explains the missing key action.
- Clicking the warning-styled composer action opens Settings directly to Model
  Providers, focuses the provider selector, and keeps diagnostics/secrets out
  of the normal conversation surface.
- Configured provider models and runtime/default models keep the existing
  quiet Configure models appearance.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: seed the isolated E2E HOME with a saved API-key provider
  model that has no stored key, launch real Electron with fake ACP, open the
  project, assert the composer model control shows missing provider metadata
  and the Configure models icon is warning-styled, click it, assert Settings >
  Model Providers opens and focuses the provider selector, then continue the
  existing model, settings, branch, review, terminal, relaunch, and commit
  paths.
- E2E assertions: warning action title/class, status dot metadata,
  containment/no overflow, provider settings focus, no fake secrets or local
  server URLs in visible text or fields, and zero unexpected console errors or
  failed local requests.
- Diagnostic artifacts to collect on failure:
  `composer-missing-provider-key-shortcut.json`,
  `composer-missing-provider-key-shortcut.png`, Settings shortcut artifacts,
  Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected the compact missing-key
  composer shortcut over a larger inline warning or unrelated `.eyebrow`
  cleanup; `frontend-design`, constrained by `home.jpg`, keeps the state as a
  quiet icon accent inside the composer control strip; and
  `electron-desktop-dev` requires real Electron CDP coverage for the shortcut,
  settings focus, and secret/overflow checks.

Notes and decisions:

- Brainstormed alternatives: add visible composer warning copy, make the model
  status dot clickable, or reuse the existing adjacent Configure models icon
  with warning styling and title metadata. The reused icon is the smallest
  prototype-faithful path because it preserves the compact composer geometry
  and gives the existing action clear urgency.
- This slice intentionally does not add draft model persistence, live provider
  validation, new Settings sections, new IPC/server routes, or secret
  persistence behavior.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 39 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-28-52-626Z/`.
- `composer-missing-provider-key-shortcut.json` recorded the selected saved
  provider model as `qwen-e2e-cdp`, missing API-key metadata on the model
  control and status dot, the warning Configure models shortcut title/class,
  124 x 24 px model control geometry, 24 x 24 px shortcut geometry, no
  composer/control/shortcut/document overflow, no fake secrets, no local server
  URL, and `summary.json` recorded zero console errors and zero failed local
  requests.

Self-review:

- The first viewport remains conversation-first and icon-led; the change only
  recolors the existing composer model settings shortcut when the selected
  provider model is missing a key.
- Secret state is still boolean metadata only; API key values are not rendered
  in DOM text, titles, screenshots, or harness JSON.
- The E2E seed writes a provider entry without credentials into the isolated
  test HOME only, then the existing Settings save flow still validates and
  persists fake keys through the normal desktop server route.
- Electron main/preload, IPC exposure, local server binding, token handling,
  Git, terminal, branch, review, commit, and Settings persistence semantics are
  unchanged.

Next work:

- Continue composer-first workflow polish by allowing draft thread model/mode
  choices to be made before the first send, then applying those choices when
  the session is created.
- Continue prototype fidelity by checking whether the no-project first viewport
  needs a more direct Open Project affordance without creating dashboard chrome.

### Slice: Settings Provider Key Guidance

Status: completed in iteration 85.

Goal: make missing and configured provider-key states clear inside Settings >
Model Providers without exposing secrets or adding another dashboard surface.

User-visible value: when users open model provider settings from the sidebar or
composer, they can immediately tell whether the selected provider has a saved
key and what kind of key is required before saving.

Expected files:

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-provider-key-guidance.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Model Providers shows a compact provider-key guidance row for API-key and
  Coding Plan modes, using configured/missing language derived from existing
  Settings metadata.
- The guidance row is accessible, visually contained, and does not expose API
  key values, local server URLs, ACP/session IDs, or raw provider prefixes.
- Existing provider validation, save status, model grouping, composer health,
  Settings Permissions health, branch, review, terminal, relaunch, and commit
  workflows remain unchanged.
- The first viewport remains conversation-first; this guidance appears only
  inside the Settings overlay.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open Settings > Model Providers from the composer and sidebar,
  assert missing-key guidance before saving, save API-key and Coding Plan
  provider settings, assert configured-key guidance for each provider, then
  continue the existing Settings, Permissions, draft composer, review,
  terminal, branch, relaunch, model, and commit paths.
- E2E assertions: guidance text, title, role, and configured/missing classes
  reflect the selected provider; the row remains compact and contained; fake
  secrets and diagnostics are absent from visible text/field values/artifacts;
  and the full CDP smoke records zero unexpected console errors or failed
  local requests.
- Diagnostic artifacts to collect on failure:
  `settings-provider-key-guidance.json`, Settings screenshots, Electron log,
  and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected this focused Settings
  workflow polish over the unused `.eyebrow` cleanup because users still need a
  clearer missing-key state while configuring models; `frontend-design`
  constrained by `home.jpg` keeps the signal as a quiet inline status row; and
  `electron-desktop-dev` requires real Electron CDP verification for the
  Settings workflow and layout containment.

Notes and decisions:

- Brainstormed alternatives: remove the unused `.eyebrow` style, add a larger
  provider health card, or add one compact status row inside the existing
  provider form. The compact row is the smallest user-visible improvement
  because it clarifies missing-key state at the point of action without changing
  server APIs or the first viewport.
- This slice intentionally does not add live provider network validation,
  custom select controls, new Settings sections, Electron main/preload APIs,
  local server changes, or secret persistence behavior.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 39 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-17-46-472Z/`.
- `settings-provider-key-guidance.json` recorded API-key missing, API-key
  ready-to-save, API-key configured, and Coding Plan configured states. Every
  snapshot kept the 24 px status row inside the Model Providers card, retained
  a 6 px dot, and recorded no guidance overflow, visible fake secrets, local
  server URL leakage, or document overflow. `summary.json` recorded zero
  console errors and zero failed local requests.

Self-review:

- The first viewport is unchanged and remains conversation-first; the new
  signal appears only inside the Settings overlay's Model Providers form.
- The guidance row uses only boolean saved-key metadata and typed-key presence;
  API key values are never rendered into labels, titles, DOM text, screenshots,
  or artifact fields.
- The change is renderer/CSS/harness only; Electron main/preload, IPC, local
  server binding, token handling, Git, terminal, branch, review, commit, and
  Settings persistence semantics are unchanged.

Next work:

- Continue prototype fidelity by removing or repurposing the unused generic
  `.eyebrow` style and checking any remaining support labels against
  `home.jpg`.
- Continue model workflow polish by making missing-provider states actionable
  from composer-selected saved models without adding a larger Settings surface.

### Slice: Settings Permissions Provider Health

Status: completed in iteration 84.

Goal: surface saved model-provider health in Settings > Permissions for the
selected thread model with the same compact semantics used by the composer.

User-visible value: users changing the active thread model from Settings can
see whether a saved API-key or Coding Plan model has a configured key without
opening provider setup, while Settings remains a quiet product surface and does
not expose secrets or diagnostics.

Expected files:

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-permissions-provider-health.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings Permissions shows a tiny contained provider-health dot next to the
  Thread model selector only when the selected model has saved-provider
  metadata.
- The Thread model control title, select title, and selected option title
  describe the provider and API-key state without exposing API key values.
- Existing compact model labels, provider grouping, composer health, Settings
  validation, branch, review, terminal, relaunch, and commit workflows remain
  unchanged.
- Settings default and Advanced Diagnostics visibility rules still prevent
  secrets, local server URLs, ACP/session IDs, and raw provider prefixes from
  leaking into normal Settings.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, save API-key and Coding Plan provider settings, open Settings,
  navigate to Permissions, select the saved API-key thread model, assert the
  compact health dot/title/option metadata and containment, then continue the
  existing Advanced Diagnostics, draft composer, review, terminal, branch,
  relaunch, model, and commit paths.
- E2E assertions: Settings Permissions provider health reports configured
  API-key state in title/aria metadata, the dot remains inside the selector
  shell, option labels remain compact, no fake secrets or local server URLs
  appear in normal Settings, and the full CDP smoke records zero unexpected
  console errors or failed local requests.
- Diagnostic artifacts to collect on failure:
  `settings-permissions-provider-health.json`, Settings screenshots, Electron
  log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` chose this focused model-workflow
  polish over unrelated `.eyebrow` cleanup because the previous slice already
  added provider health in the composer; `frontend-design` constrained by
  `home.jpg` keeps the signal as a tiny status dot inside a native Settings
  control; and `electron-desktop-dev` requires real Electron CDP verification
  for the Settings workflow and layout containment.

Notes and decisions:

- Brainstormed alternatives: add larger provider badges to Settings, show
  provider health only in the composer, or reuse the compact dot/title pattern
  in Settings Permissions. The reused pattern is the smallest consistent slice
  because the Settings selector already uses the same model grouping and label
  formatters.
- This slice intentionally does not add live provider network validation,
  custom select popovers, new Settings sections, Electron main/preload APIs,
  local server changes, or secret persistence changes.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 38 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-06-13-119Z/`.
- `settings-permissions-provider-health.json` recorded the selected saved model
  as `qwen-e2e-cdp`, the control/select/option titles as
  `qwen-e2e-cdp · Saved API key provider · API key configured`, a 6 px
  configured provider dot contained inside the Settings Thread model selector,
  no control/shell/select overflow, no raw Coding Plan label leakage, no fake
  secrets, no local server URL, and no document overflow. `summary.json`
  recorded zero console errors and zero failed local requests.

Self-review:

- The first viewport is unchanged and remains conversation-first; the new
  signal appears only in the Settings overlay when users edit the active
  thread model.
- Provider/API-key state is still derived from existing Settings/model
  metadata; API key values are never exposed in labels, titles, DOM text,
  screenshots, or logs.
- The change is renderer/CSS/harness only; Electron main/preload, IPC, local
  server binding, token handling, Git, terminal, branch, review, commit, and
  Settings persistence semantics are unchanged.

Next work:

- Continue prototype fidelity by removing or repurposing the unused generic
  `.eyebrow` style and checking remaining support labels against `home.jpg`.
- Continue model workflow polish by giving missing provider-key states clear,
  non-blocking Settings guidance near the provider form without adding a larger
  dashboard surface.

### Slice: Composer Model Provider Health

Status: completed in iteration 83.

Goal: surface saved model-provider health next to the compact composer model
choice without widening the composer or exposing API key values.

User-visible value: users who save API-key or Coding Plan model providers can
see whether the selected saved model is backed by a configured key directly in
the task control center, while the first viewport stays conversation-first and
compact.

Expected files:

- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.test.ts`
- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-model-provider-health.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Saved API-key and Coding Plan configured models carry provider kind and
  API-key presence metadata derived from existing Settings state.
- The composer model selector shows a tiny contained provider-health dot only
  when the selected model has saved-provider metadata.
- The selected model control and native option titles describe the provider
  and key state, but visible text remains compact and does not include secrets
  or raw provider prefixes.
- Settings Permissions and composer model grouping remain provider-scoped and
  existing model switching, validation, Settings, terminal, branch, review,
  relaunch, and commit workflows remain unchanged.

Verification:

- Unit/component test commands:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
  and
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, save an API-key provider and a Coding Plan provider, create a
  draft thread, switch the active composer to the saved API-key model, assert
  the compact health dot/title/option metadata, then continue existing review,
  settings, terminal, model, branch, relaunch, and commit paths.
- E2E assertions: selected saved-provider model exposes saved API-key provider
  health via title/aria metadata, the dot stays inside
  the existing model control, option labels remain compact, no fake API keys or
  local server URLs appear in visible text or field values, and the full CDP
  smoke records zero unexpected console errors or failed local requests.
- Diagnostic artifacts to collect on failure:
  `composer-model-provider-health.json`, model/composer screenshots,
  Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` selected the provider-health slice
  over the unused `.eyebrow` cleanup because it is visible and workflow
  relevant; `frontend-design` constrained by `home.jpg` keeps the signal as a
  small native-workbench status dot rather than a wider badge; and
  `electron-desktop-dev` requires real Electron CDP verification of the model
  workflow and layout containment.

Notes and decisions:

- Brainstormed alternatives: remove the unused uppercase `.eyebrow` style,
  add provider text badges next to the model picker, or derive compact
  provider-health metadata from existing Settings. The metadata plus dot is the
  smallest user-visible step because it improves the model workflow without
  changing server APIs or widening the composer.
- This slice intentionally does not add live provider network validation,
  custom select controls, new Settings sections, Electron main/preload APIs,
  or secret persistence behavior.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
  passed with 8 tests.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 37 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-54-06-303Z/`.
- `composer-model-provider-health.json` recorded the selected saved model as
  `qwen-e2e-cdp`, the control/select/option titles as
  `qwen-e2e-cdp · Saved API key provider · API key configured`, a 6 px
  configured provider dot contained inside the 124 px model control, no control
  or select overflow, no raw Coding Plan label leakage, no fake secrets, no
  local server URL, and no document overflow. `summary.json` recorded zero
  console errors and zero failed local requests.

Self-review:

- The first viewport remains conversation-first: this adds a tiny status signal
  inside the existing composer model control rather than another visible text
  badge or wider control.
- Provider/API-key state is derived from existing Settings data and carried in
  model `_meta`; API key values are never stored in renderer model metadata,
  titles, DOM text, screenshots, or logs.
- The change is renderer/store/harness only; Electron main/preload, IPC, local
  server binding, token handling, Git, terminal, branch, review, commit, and
  Settings persistence semantics are unchanged.

Next work:

- Continue model workflow polish by exposing the same compact health signal in
  Settings Permissions if users switch models there frequently.
- Continue prototype fidelity by removing or repurposing the unused generic
  `.eyebrow` style and checking remaining support labels against `home.jpg`.

### Slice: Settings Advanced Diagnostics Label Restraint

Status: completed in iteration 82.

Goal: make the opt-in Advanced Diagnostics key/value labels match the quieter
Settings label treatment so diagnostics remain clearly secondary when opened.

User-visible value: users can inspect runtime/session diagnostics from Settings
without the drawer snapping back to uppercase debug-dashboard chrome, while the
diagnostics stay hidden from the default workbench and Settings views.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-advanced-diagnostics-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Advanced Diagnostics session/runtime `dt` labels render in normal case with a
  compact font weight and size.
- Diagnostic values remain readable, contained, and allowed to show the local
  server URL only after the user explicitly opens Advanced Diagnostics.
- Default Settings, composer shortcut Settings, sidebar Models Settings,
  compact Settings, and settings rail navigation still do not expose runtime
  diagnostics, local server URLs, secrets, ACP/session IDs, or overflow.
- Existing Settings model/provider validation, Permissions model grouping,
  terminal, review, branch, relaunch, and commit workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open Settings, assert default diagnostics are hidden, open
  Advanced Diagnostics, assert session/runtime diagnostic labels use normal-case
  compact computed styles and stay contained, then continue existing settings,
  terminal, model, branch, review, relaunch, and commit paths.
- E2E assertions: diagnostic label samples report `text-transform: none`,
  restrained font weights/sizes, no label overflow, expected diagnostic text,
  local server URL only in the runtime diagnostics block after expansion, no
  fake secrets, and zero unexpected console errors or failed local requests.
- Diagnostic artifacts to collect on failure: `settings-advanced-diagnostics.json`,
  Settings screenshots, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` used the current next-work notes to
  choose a targeted diagnostics-fidelity slice; `frontend-design` constrained
  by `home.jpg` to keep opt-in diagnostics quiet and secondary; and
  `electron-desktop-dev` for renderer CSS changes verified through the real
  Electron CDP harness.

Notes and decisions:

- Brainstormed alternatives: hide more diagnostics by default, redesign the
  Advanced section as a separate page, or make the remaining diagnostic label
  chrome match the established Settings style. The targeted style pass is the
  smallest safe slice because default diagnostic hiding and navigation behavior
  already have executable coverage.
- This slice intentionally does not change Settings IA, Electron main/preload
  APIs, local server binding, token handling, secret persistence, or runtime
  diagnostic content.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 36 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-42-07-584Z/`.
- `settings-advanced-diagnostics.json` recorded the Advanced Diagnostics
  toggle expanded, all session/runtime diagnostic labels present, each label at
  `textTransform: "none"`, `fontWeight: 680`, `fontSize: 11.5`, no label
  overflow, no fake secrets, and the local server URL visible only in the
  expanded runtime diagnostics block. `summary.json` recorded zero console
  errors and zero failed local requests.

Self-review:

- The first viewport and default Settings view are unchanged: diagnostics
  remain opt-in and do not leak local server URLs, ACP/session IDs, or secrets
  before expansion.
- The change moves the opt-in Advanced Diagnostics surface closer to the
  prototype by keeping support labels quiet instead of uppercase diagnostic
  chrome.
- The slice changes renderer CSS and CDP assertions only; Electron
  main/preload, IPC, local server binding, token handling, Settings
  persistence, Git, terminal, branch, review, and commit behavior are
  unchanged.

Next work:

- Continue prototype fidelity by reviewing remaining generic `.eyebrow`
  uppercase treatment and any activity/support labels that still compete with
  message content.
- Continue model workflow polish by exposing provider health/validation state
  near model choices without widening the composer.

### Slice: Sidebar Section Label Restraint

Status: completed in iteration 81.

Goal: make the sidebar project-browser heading and count read like quiet
navigation labels instead of uppercase diagnostic chrome.

User-visible value: the left rail stays compact and easier to scan, with the
project/thread browser visually closer to `home.jpg` while preserving current
project grouping, search, Models, and Settings behavior.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-section-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Sidebar project section headings render in normal case with restrained size
  and weight.
- Sidebar section count text uses the same normal-case, muted support style and
  stays contained beside the Open Project icon button.
- Project rows, active thread grouping, sidebar search, Settings footer, model
  shortcut, branch metadata, and long-thread/path hiding remain unchanged.
- The first viewport remains conversation-first, with no local server URLs,
  internal IDs, secrets, or raw long prompts visible in the sidebar.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert initial layout heading computed styles, open a project,
  assert sidebar app rail geometry and heading styles, exercise sidebar Models
  and Search paths, then continue existing conversation, review, settings,
  terminal, model, branch, relaunch, and commit workflows.
- E2E assertions: sidebar heading samples report `text-transform: none`,
  compact font size and weight, no horizontal overflow, project/thread rows
  stay contained, and the full CDP smoke records zero unexpected console
  errors or failed local requests.
- Diagnostic artifacts to collect on failure: `initial-layout.json`,
  `sidebar-app-rail.json`, sidebar screenshots, Electron log, and
  `summary.json` under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` used the current repository memory
  and prompt constraints to choose a small prototype-fidelity slice;
  `frontend-design` constrained by `home.jpg` to reduce sidebar chrome without
  inventing a new visual direction; `electron-desktop-dev` for renderer CSS
  changes verified through the real Electron CDP harness.

Notes and decisions:

- Brainstormed alternatives: redesign the sidebar project header actions,
  rename the heading text, or make a targeted computed-style restraint pass.
  The targeted pass is the smallest safe step because the current sidebar
  grouping and search workflows already have coverage.
- This slice intentionally does not change Electron main/preload APIs, local
  server security, Git behavior, model settings, or session creation.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 36 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-37-32-289Z/`.
- `initial-layout.json` recorded the sidebar heading at normal-case
  `textTransform: "none"`, 10 px, and 660 weight; the heading count recorded
  normal-case, 9.5 px, and 620 weight.
- `sidebar-app-rail.json` recorded the same normal-case heading/count styles,
  no sidebar/app/project/thread/footer overflow, compact long-branch text, and
  no leaked local server URL, protocol ID, or raw prompt/path noise. The CDP
  `summary.json` recorded zero console errors and zero failed local requests.

Self-review:

- The first viewport moves closer to `home.jpg` by making the sidebar project
  browser feel like quiet navigation rather than uppercase debug chrome.
- The change is renderer CSS plus CDP computed-style assertions only; project
  selection, sidebar search, model settings, thread creation, Git, terminal,
  IPC, local server binding, token handling, and secret handling are unchanged.
- The real Electron harness still exercises the broader workbench workflows,
  including project switching, composer, approvals, review, settings, terminal,
  model selection, branch switching, relaunch persistence, and commit.

Next work:

- Continue prototype fidelity by checking the remaining Advanced diagnostics
  key/value label treatment now that the default workbench chrome is quieter.
- Continue model workflow polish by exposing provider health/validation state
  near model choices without widening the composer.

### Slice: Branch Menu and Runtime Chrome Restraint

Status: completed in iteration 80.

Goal: make the topbar branch menu and runtime status pill feel like compact
desktop context controls instead of uppercase diagnostic chrome.

User-visible value: users can open the branch menu with long branch names
without the menu turning into a noisy full-path list, while the current runtime
state remains visible but less visually loud.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/branch-menu-runtime-chrome-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Branch menu rows show compact middle-truncated branch labels and preserve the
  full branch name on accessible labels and native titles.
- Branch menu header, current-row marker, create label, and runtime status pill
  render in normal case with restrained font weights.
- Long branch labels do not escape or widen the branch menu at default or
  compact desktop widths.
- Branch create, validation, dirty-switch confirmation, checkout, Git status,
  review, settings, model, terminal, and relaunch workflows remain unchanged.
- No local server URLs, secrets, ACP/session IDs, or other diagnostics become
  visible in the first viewport.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert topbar context/runtime styles, open the branch menu on a
  long branch, assert compact row labels and preserved full branch metadata,
  validate branch creation, create a branch, reopen the menu, confirm dirty
  branch switching, then continue existing review, settings, terminal, model,
  commit, and relaunch paths.
- E2E assertions: branch rows do not visibly include raw long branch names,
  branch row titles/ARIA preserve the full names, support labels report
  `text-transform: none` with restrained weights, menu rows stay contained, the
  runtime pill reports normal-case text, and the full CDP smoke records zero
  unexpected console errors or failed local requests.
- Diagnostic artifacts to collect on failure: `topbar-context-fidelity.json`,
  `branch-create-menu.json`, `branch-switch-menu.json`,
  `branch-switch-confirmation.json`, screenshots, Electron log, and
  `summary.json` under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` used the current next-work notes to
  choose targeted branch/topbar chrome restraint over new workflow behavior;
  `frontend-design` constrained by `home.jpg` to keep the branch control
  compact, normal-case, and conversation-supporting; `electron-desktop-dev` for
  renderer changes verified through the real Electron CDP harness.

Notes and decisions:

- Brainstormed alternatives: redesign the branch picker as a custom searchable
  popover, leave full branch names visible in the menu, or make a targeted
  menu/status restraint pass. The targeted pass is the smallest reliable slice
  because branch creation and checkout behavior already have broad coverage.
- This slice intentionally does not change Git service semantics, dirty
  worktree protection, Electron main/preload APIs, local server binding, token
  handling, or secret persistence.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 36 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-26-22-276Z/`.
- `topbar-context-fidelity.json` recorded runtime status as normal-case with
  `fontWeight: 700`, a slim 60.3 px runtime pill, compact topbar branch text,
  zero long-branch leakage, and contained topbar actions.
- `branch-create-menu.json` and `branch-switch-menu.json` recorded compact
  visible branch labels such as `desktop-e2e/very...rflow-check`, full branch
  names preserved in row `title` and `aria-label`, branch row weight at 650,
  current markers at normal-case 640, support labels at normal-case weights,
  contained menu geometry, zero console errors, and zero failed local requests.

Self-review:

- The first viewport moves closer to `home.jpg` by reducing another uppercase
  diagnostic-looking surface without changing the conversation-first layout or
  widening topbar controls.
- The branch menu now treats long branch names the same way the topbar trigger
  does: compact in visible UI and complete in accessible/native metadata.
- The slice only changes renderer presentation plus assertions; Git checkout,
  branch creation, dirty-worktree confirmation, Electron security settings, IPC,
  local server binding, token handling, and secret handling are unchanged.

Next work:

- Continue prototype fidelity by reviewing remaining all-caps support labels in
  sidebar section headings and assistant activity summaries where they compete
  with message content.
- Continue model workflow polish by exposing provider health/validation state
  near model choices without widening the composer.

### Slice: Terminal and Review Status Label Restraint

Status: completed in iteration 79.

Goal: reduce the remaining uppercase status labels in the collapsed terminal
strip and review drawer so supporting surfaces stay quieter than the
conversation and composer.

User-visible value: users can keep the terminal and review drawer available
without small status chips, hunk metadata, and review note labels reading like
debug-dashboard headers.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/terminal-review-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The collapsed terminal status chip renders in normal case with restrained
  font weight while preserving its compact pill geometry and overflow
  containment.
- Review drawer file metadata, hunk source metadata, collapsed review-note
  prompt, and open comment label render in normal case with compact weights.
- Review safety, staging, discard confirmation, commit, terminal attach, model,
  settings, branch, and compact viewport workflows remain unchanged.
- The first viewport remains conversation-first: terminal stays collapsed by
  default, review opens as a supporting drawer, and no local server URLs,
  secrets, or protocol IDs become visible.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert initial and compact collapsed terminal label styles,
  open the dirty fake project review drawer, assert review metadata/comment
  label styles at default and compact widths, open the comment editor and assert
  the label style, then continue discard safety, stage, commit, settings,
  terminal attach, model, branch, and relaunch paths.
- E2E assertions: terminal and review support labels report
  `text-transform: none`, stay below the existing compact font-weight bounds,
  remain horizontally contained, and the full CDP smoke records zero unexpected
  console errors or failed local requests.
- Diagnostic artifacts to collect on failure: updated `initial-layout.json`,
  `compact-dense-conversation.json`, `review-drawer-layout.json`,
  `compact-review-drawer.json`, `review-comment-editor-chrome.json`,
  screenshots, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` used repository memory and the
  current next-work notes to choose a small fidelity slice; `frontend-design`
  constrained by `home.jpg` to reduce loud support chrome without introducing a
  new visual direction; `electron-desktop-dev` for renderer CSS changes
  verified through real Electron CDP interaction.

Notes and decisions:

- Brainstormed alternatives: leave uppercase treatment only in terminal,
  redesign the review drawer information hierarchy, or make a targeted
  normal-case styling pass over the remaining support labels. The targeted pass
  is the smallest safe step because prior slices already established the
  drawer/terminal structure and CDP geometry checks.
- This slice intentionally does not change review behavior, Git service
  semantics, terminal command execution, Electron main/preload APIs, or local
  server security.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 35 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-19-11-628Z/`.
- An initial CDP run at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-17-09-585Z/`
  failed because the harness still expected the previous rendered uppercase
  changed-file metadata. Git staging had succeeded; the assertion was updated
  to the new normal-case contract before the passing rerun.
- Key recorded metrics: `initial-layout.json` and
  `compact-dense-conversation.json` recorded the terminal status chip with
  `textTransform: "none"` and `fontWeight: 680`; `review-drawer-layout.json`
  and `compact-review-drawer.json` recorded changed-file metadata, hunk source
  metadata, review note, and terminal status support labels with
  `textTransform: "none"` and weights at or below 680; and
  `review-comment-editor-chrome.json` recorded the open comment label as
  normal-case at 680 weight. `summary.json` recorded zero console errors and
  zero failed local requests.

Self-review:

- The first viewport moves closer to `home.jpg` by making terminal/review
  support chrome quieter while preserving the existing compact geometry,
  icon-led controls, and conversation-first layout.
- The slice only changes renderer CSS and the CDP harness; Electron
  main/preload, IPC, local server binding, token handling, Git staging, discard,
  commit, and terminal command execution behavior are unchanged.
- The CDP harness now protects against regressing these support labels back to
  uppercase while continuing to exercise the existing review, settings,
  terminal, model, branch, relaunch, and commit workflows.

Next work:

- Continue prototype fidelity by reviewing branch-menu and topbar uppercase
  status chrome that still reads more like diagnostics than product context.
- Continue model workflow polish by exposing provider health/validation state
  near model choices without widening the composer.

### Slice: Model Picker Provider Grouping

Status: completed in iteration 78.

Goal: make composer and Settings thread-model selectors easier to scan when
active runtime models, saved API-key provider models, and Coding Plan models
coexist.

User-visible value: users can distinguish active thread models from saved
desktop provider models and Coding Plan options inside the same compact model
picker without raw provider prefixes, secrets, or wider first-viewport chrome.

Expected files:

- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.test.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/model-picker-provider-grouping.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Composer model options are grouped under compact provider categories when
  runtime, saved API-key, and Coding Plan models coexist.
- Settings Permissions thread-model options use the same grouping.
- Visible option labels remain compact and do not include
  `ModelStudio Coding Plan`; full raw provider names remain available only on
  native `title` attributes.
- Saved API-key provider entries and saved Coding Plan provider entries retain
  distinct metadata so ordering/grouping survives Settings reloads and draft
  thread creation.
- The model picker, Settings drawer, and composer remain contained with no
  visible secrets, local server URL, or first-viewport overflow.

Verification:

- Unit/component test commands:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
  and
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, save API-key and Coding Plan providers, inspect Settings
  Permissions model groups, create a draft thread, inspect draft composer model
  groups, return to an active thread, switch composer models, and assert group
  order and labels.
- E2E assertions: the relevant selectors expose `Saved providers` and
  `Coding Plan` groups, active-thread selectors also expose `Active session`,
  compact labels remain under the existing length bounds, raw Coding Plan
  provider prefixes are not visible, titles preserve full raw provider names,
  and console errors/failed local requests are empty.
- Diagnostic artifacts to collect on failure: `settings-permissions-model-label-restraint.json`,
  `draft-composer-saved-model-state.json`, `composer-model-switch.json`,
  screenshots, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` with the Ralph prompt and current
  next-work notes to choose provider grouping over new picker chrome;
  `frontend-design` constrained by `home.jpg` to add hierarchy inside native
  controls without widening the first viewport; `electron-desktop-dev` for
  renderer/store changes plus real Electron CDP verification.

Notes and decisions:

- Brainstormed alternatives: add visible provider suffixes to option labels,
  build a custom dropdown, or use native `optgroup` labels. Native groups are
  the smallest reliable slice because they improve scan order while preserving
  compact option text and browser/OS select behavior.
- This slice intentionally does not introduce a custom select component or new
  large badges in the composer; the prototype still favors compact controls.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
  passed with 7 tests.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 35 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-06-10-781Z/`.
- `settings-permissions-model-label-restraint.json`,
  `draft-composer-saved-model-state.json`, and `composer-model-switch.json`
  recorded `Active session`, `Saved providers`, and/or `Coding Plan` groups as
  appropriate, compact visible model labels, full raw Coding Plan titles
  preserved on options, no visible secrets, no local server URL, no selector
  overflow, zero console errors, and zero failed local requests.

Self-review:

- The first viewport remains compact and conversation-first; the change only
  adds native grouping semantics inside existing model selectors.
- Raw provider prefixes remain hidden from visible option text while full
  metadata stays available in native titles for disambiguation.
- Store metadata now distinguishes API-key and Coding Plan saved providers
  without changing Electron main, preload, IPC, local server binding, token
  handling, or secret persistence.

Next work:

- Continue prototype fidelity by reducing remaining uppercase status chrome in
  supporting review/terminal surfaces where it competes with thread content.
- Continue model workflow polish by exposing provider health/validation state
  near model choices without widening the composer.

### Slice: Settings Label Chrome Restraint

Status: completed in iteration 77.

Goal: reduce the remaining uppercase form and key/value labels in the Settings
drawer so the overlay reads as compact product settings instead of a debug
dashboard.

User-visible value: users can scan model, account, permission, tools,
terminal, and appearance settings without loud uppercase field chrome competing
with the section titles or the conversation behind the drawer.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-label-chrome-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings form labels render in normal case with compact weight and no CSS
  uppercase transform.
- Settings key/value labels render in normal case with compact weight and no
  CSS uppercase transform.
- Review comment labels keep their existing uppercase treatment; this slice is
  scoped to Settings.
- Settings remains a right-side supporting drawer with conversation visible
  behind it, no default diagnostics, no fake secrets, no local server URL, and
  no overflow at the default and compact CDP viewports.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open Settings from the workbench, inspect the computed styles
  for Settings form labels and key/value labels, continue compact Settings,
  validation, Coding Plan, Permissions model labels, composer, terminal, branch,
  review, and relaunch paths.
- E2E assertions: Settings label samples report `text-transform: none`, compact
  font weights, expected visible label text such as `Provider`, `API key`, and
  `Coding Plan key`, no hidden diagnostics or secrets in the default drawer, and
  no document/settings overflow.
- Diagnostic artifacts to collect on failure:
  `settings-layout.json`, `settings-page.png`, `compact-settings-overlay.json`,
  `settings-validation.json`, `settings-label-chrome-restraint.json`, Electron
  log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt and existing
  next-work notes to choose the smallest fidelity slice; `frontend-design`
  constrained by `home.jpg` to reduce label noise without inventing a new
  visual direction; `electron-desktop-dev` for real Electron CDP computed-style
  verification.

Notes and decisions:

- Brainstormed alternatives: rename labels in JSX, introduce a new Settings
  field component, or scope the visual restraint in CSS. CSS is the smallest
  safe slice because the labels already carry the right product text and tests
  can assert the real computed style in Electron.
- This slice intentionally leaves terminal/review/diff uppercase status labels
  alone; those surfaces have separate density and activity semantics.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 35 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-47-10-706Z/`.
- `settings-label-chrome-restraint.json` recorded all Settings form labels and
  key/value labels with `textTransform: "none"`, `fontWeight: 680`,
  `fontSize: 11.5`, no label overflow, no fake secrets, no local server URL,
  and no document overflow.

Self-review:

- The first viewport and Settings overlay move closer to `home.jpg` by reducing
  uppercase debug chrome without adding new cards, banners, or explanatory
  text.
- The change is renderer CSS plus CDP verification only; Electron main,
  preload, IPC, local server binding, token handling, and secret persistence
  are untouched.
- Review comment labels remain scoped to their existing uppercase rule, so the
  slice does not change review/terminal/diff activity semantics.

Next work:

- Continue prototype fidelity by reducing remaining uppercase status chrome in
  supporting surfaces where it competes with thread content.
- Continue model workflow polish by making configured provider ordering clearer
  when API-key and Coding Plan models coexist in the same selector.

### Slice: Settings Permissions Model Label Restraint

Status: completed in iteration 76.

Goal: make the Settings Permissions thread-model selector use the same compact
Coding Plan model labels as the composer, so raw provider prefixes do not
compete with the drawer section hierarchy.

User-visible value: users can verify or switch the active thread model from
Settings without seeing long `ModelStudio Coding Plan` provider prefixes in
the visible option text; the full provider label remains available as the
control title for clarity.

Expected files:

- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-permissions-model-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The Settings Permissions thread-model select renders compact model option
  text, strips both China and Global Coding Plan prefixes, and truncates long
  provider/path labels.
- The selected thread-model control preserves the full raw model label in its
  `title` attribute and option titles.
- The composer continues to use the same compact model label behavior.
- Settings remains drawer-like and conversation-first, with no visible API key,
  local server URL, raw provider prefix, or overflow in the permissions view.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, save API-key and Coding Plan provider settings, navigate to the
  Settings Permissions section, inspect the thread-model select labels and
  titles, then continue the existing draft composer and active composer model
  switch paths.
- E2E assertions: Settings Permissions thread-model options include Coding
  Plan models with compact visible labels, no visible option text includes
  `ModelStudio Coding Plan`, at least one option title preserves the full
  Coding Plan label, the control is enabled for the active thread, the drawer
  does not expose fake secrets or local server URLs, and permissions/settings
  content stays within the viewport.
- Diagnostic artifacts to collect on failure:
  `settings-permissions-model-label-restraint.json`, screenshot artifacts from
  the main CDP run, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` with the Ralph prompt and existing
  plan as fixed product intent; `frontend-design` constrained by `home.jpg` to
  keep Settings compact and quiet rather than adding a new explanatory banner;
  `electron-desktop-dev` for component coverage plus real Electron CDP
  verification.

Notes and decisions:

- Brainstormed alternatives: duplicate the composer label cleanup inside
  Settings, move all provider metadata into model-store normalization, or share
  a renderer formatter. The shared formatter is the smallest durable change
  because it keeps raw provider metadata intact while aligning visible labels
  across composer and Settings.
- The visible label is treated as product chrome; the full title stays available
  for accessibility and disambiguation without polluting the default drawer.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 35 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-38-17-611Z/`.
- `settings-permissions-model-label-restraint.json` recorded enabled Settings
  thread-model controls, compact Coding Plan labels such as `qwen3.5-plus`,
  full raw Coding Plan titles preserved on options, no visible raw Coding Plan
  provider prefix, no fake secrets or local server URL, and no permissions
  drawer/document overflow.

Self-review:

- The first viewport remains conversation-first; the change only reduces noise
  inside the existing Settings drawer.
- Model metadata is not normalized away at the store/API layer, so full provider
  context remains available for titles and diagnostics.
- The shared formatter preserves the composer behavior, including path-tail
  labels and separator-aware truncation.
- No Electron main, preload, IPC, local server binding, token behavior, or
  secret handling changed.

Next work:

- Continue prototype fidelity by reducing remaining uppercase/settings key
  labels that compete with drawer section headers.
- Continue model workflow polish by making configured provider ordering clearer
  when API-key and Coding Plan models coexist in the same selector.

### Slice: Settings Save Status Feedback

Status: completed in iteration 75.

Goal: make model provider Settings save success, saving, and failure states
explicit in the drawer without exposing provider secrets or adding main
workbench noise.

User-visible value: after users add or edit a model provider, the Settings
drawer clearly confirms what provider/model state was saved, and failures
appear as an inline product message instead of an ambiguous form error.

Expected files:

- `packages/desktop/src/renderer/stores/settingsStore.ts`
- `packages/desktop/src/renderer/stores/settingsStore.test.ts`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-save-status-feedback.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Model Providers shows a compact live status row while saving, after a
  successful save, and after a save failure.
- Success copy identifies the saved provider and visible model/region context,
  reports API key state only as configured/missing, and never renders API key
  values.
- Editing provider fields clears stale saved/error status so users do not see a
  previous save confirmation beside unsaved input.
- Save validation remains inline and compact; disabled Save continues to explain
  the validation reason.
- Settings remains drawer-like and conversation-first; no runtime diagnostics,
  server URLs, ACP IDs, fake secrets, or overflow appear in the default drawer.

Verification:

- Unit/store test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts`
- Component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open Settings, exercise invalid provider fields, save a valid
  API-key provider, verify the inline saved status, switch to Coding Plan, save
  again, verify the saved Coding Plan status, and continue the existing
  composer model visibility flow.
- E2E assertions: the status row uses `role=status` for saving/success and
  `role=alert` for errors, save status text is compact and contained, saved
  status clears after field edits, API key inputs remain password fields and
  are cleared after saving, fake secrets are absent from visible text and DOM
  field values after save, and no settings/document overflow occurs.
- Diagnostic artifacts to collect on failure:
  `settings-save-status-feedback.json`,
  `settings-coding-plan-provider.json`, screenshot artifacts from the main CDP
  run, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` constrained by `home.jpg` to keep
  feedback as a compact settings drawer row rather than a new banner;
  `electron-desktop-dev` for component/store coverage plus real Electron CDP
  verification.

Notes and decisions:

- This slice will not introduce toast infrastructure. The feedback belongs next
  to the Model Providers form because the prototype keeps the main conversation
  viewport quiet and control-centered.
- Save status lives in `settingsStore` instead of being inferred from the
  current form. This lets Settings distinguish saved, saving, and failed save
  states while clearing stale messages as soon as a provider field changes.
- The success copy deliberately says only `API key configured` or
  `API key missing`; the secret value remains limited to password inputs before
  save and is cleared from form state after save success.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts`
  passed with 10 tests.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 34 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-29-32-217Z/`.
- `settings-save-status-feedback.json` recorded saved API-key status text,
  role `status`, `aria-describedby="settings-save-status"`, cleared API key
  field value, no fake secrets, no local server URL, no overflow, and stale
  status removal after editing the provider model.
- `settings-coding-plan-provider.json` recorded saved Coding Plan status text
  `Saved Coding Plan provider · Global · API key configured`, role `status`,
  no visible fake secrets, cleared API key field value after save, and no
  document overflow.

Self-review:

- The first viewport remains conversation-first; the new feedback is scoped to
  the existing Settings drawer and does not introduce a toast, banner, or main
  canvas status surface.
- Save validation still owns disabled Save explanations, while successful and
  failed save attempts use a compact live status row.
- No Electron main, preload, IPC, local server binding, or token behavior
  changed.

Next work:

- Continue model configuration polish by shortening raw Coding Plan model
  labels in the Settings Permissions thread-model select, matching the composer
  model label restraint.
- Continue prototype fidelity by reducing remaining uppercase settings key
  labels where they compete with the drawer section headers.

### Slice: Draft Composer Saved Model State

Status: completed in iteration 74.

Goal: make the project-scoped composer reflect saved Model Providers state
before a thread exists, instead of showing the ambiguous `Default model` while
the runtime model selector is intentionally disabled.

User-visible value: after users configure a provider/model from Settings, the
bottom composer still communicates which saved model will seed the next thread.
Users can open a project, see the saved model context, and type immediately
without mistaking the disabled runtime picker for missing configuration.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/draft-composer-saved-model-state.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- When no thread is active but desktop settings have configured models, the
  composer model select remains disabled but displays the saved configured
  model options instead of `Default model`.
- Runtime mode/model selectors remain disabled until a session exists; the
  change must not imply that users can mutate ACP session state before the
  session is created.
- The composer stays compact, icon-led, and contained at desktop and compact
  CDP sizes, with no new visible diagnostics, API keys, server URLs, ACP UUIDs,
  or raw long Coding Plan prefixes.
- Existing active-thread model switching still uses session runtime state and
  still calls `onModelChange`.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, save model provider settings through the existing Settings
  workflow, return to Conversation, create a draft new thread, assert the
  disabled composer model picker is populated from saved configured models,
  select an existing thread again, then continue the existing active-thread
  model switch and terminal workflows.
- E2E assertions: the draft composer model select is disabled, has at least one
  saved configured option, does not display `Default model`, contains the saved
  `qwen-e2e-cdp` option, strips raw Coding Plan prefixes from option text,
  does not leak fake secrets or local server URLs, and does not overflow the
  composer.
- Diagnostic artifacts to collect on failure:
  `draft-composer-saved-model-state.json`, screenshot artifacts from the main
  CDP run, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` with the Ralph prompt as fixed
  product intent; `frontend-design` constrained by `home.jpg` to avoid adding
  a new heavy chip; `electron-desktop-dev` for component coverage plus real
  Electron CDP verification.

Notes and decisions:

- Brainstormed alternatives: add a new provider status chip, surface provider
  state in the topbar, or reuse the existing compact model picker. The picker
  reuse is the smallest product-faithful option because `home.jpg` keeps model
  context in the composer and avoids extra topbar/status noise.
- The draft picker remains disabled because it is still a session-runtime
  mutation control. The selected/options state now comes from
  `modelState.configuredModels` when no ACP session runtime exists, so the
  composer communicates saved provider state without loosening session
  lifecycle rules.
- The CDP harness selects an existing thread after checking the draft composer
  instead of sending a new prompt. The fake ACP intentionally emits command
  approvals for every prompt, and leaving an extra approval pending would mask
  the terminal attach workflow being tested later.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 32 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-19-45-738Z/`.
- `draft-composer-saved-model-state.json` recorded disabled runtime selectors,
  selected saved Coding Plan model `qwen3.5-plus`, saved configured option
  `qwen-e2e-cdp`, no `Default model`, no raw Coding Plan label in option text,
  no fake secrets, no local server URL, and no composer/model-control/document
  overflow.

Self-review:

- The first viewport remains composer/conversation-first and does not add a
  new status chip, drawer, or diagnostic surface.
- Active-thread model switching still uses session runtime state and existing
  `onModelChange`; only the no-runtime display fallback changed.
- No Electron security, IPC, local server, or token behavior changed.

Next work:

- Continue model configuration workflow by making Settings save success/failure
  feedback more explicit without exposing provider secrets.
- Continue prototype fidelity by checking whether the model settings icon
  should become a distinct provider/settings glyph in a later icon pass.

### Slice: Composer Model Providers Shortcut

Status: completed in iteration 73.

Goal: make the composer model control center expose a direct, compact route to
Model Providers settings, especially when a project is open but no thread
exists yet and runtime model switching is disabled.

User-visible value: users can open a project, type immediately, and still find
model/provider configuration from the bottom composer without understanding
session runtime state or hunting through the sidebar.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-model-settings-shortcut.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The composer renders an icon-only `Configure models` affordance beside the
  model picker with an accessible label, tooltip, and stable test id.
- The shortcut opens the existing Settings drawer at Model Providers and
  focuses the provider selector, matching the sidebar Models behavior.
- The shortcut remains compact, does not add visible text, does not expose
  secrets or diagnostics, and does not overflow the composer at desktop or
  compact CDP viewport sizes.
- Existing composer behavior remains unchanged: project/no-thread typing stays
  enabled, runtime mode/model selects stay disabled before a thread exists,
  Send stays disabled for empty input, and active thread model switching still
  calls `onModelChange`.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project before any thread is selected, assert
  the composer is enabled, click `Configure models`, assert Settings opens with
  Model Providers targeted and the provider selector focused, close Settings,
  then continue the existing project switch, conversation, sidebar, branch,
  review, settings, terminal, relaunch, and compact viewport workflows.
- E2E assertions: the composer shortcut is icon-only, 24 px compact, has
  `aria-label="Configure models"` and `title="Configure models"`, opens
  `settings-model-providers`, focuses `settings-provider-select`, preserves the
  chat thread behind the drawer, and records no console errors, failed local
  requests, secret exposure, diagnostics exposure, or composer overflow.
- Diagnostic artifacts to collect on failure:
  `composer-model-settings-shortcut.json`,
  `composer-model-settings-shortcut.png`, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` with the prototype as the visual
  contract and a compact icon-led composer control; `electron-desktop-dev` for
  renderer behavior verified through component coverage and real Electron CDP.

Notes and decisions:

- This slice reuses the existing Settings drawer and Model Providers section
  rather than adding a separate model modal. That keeps the first viewport
  conversation-first while making the composer a more complete task control
  center.
- The shortcut remains available as a product-level model configuration route
  even before a thread exists. Runtime model and permission selects still stay
  disabled until a session is available because those controls mutate active
  ACP session state.
- `frontend-design` guidance was applied by keeping the control icon-only,
  24 px, subtly accented, and non-textual so it supports the composer without
  turning the first viewport into a settings dashboard. `electron-desktop-dev`
  guidance was applied by asserting the real Electron user path through CDP.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 31 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-10-46-770Z/`.
- `git diff --check` passed.
- Key recorded metrics: `composer-model-settings-shortcut.json` recorded
  `initialSection: "settings-model-providers"`, `providerFocused: true`, an
  icon-only `Configure models` shortcut with a 24 px by 24 px rect, no direct
  text, no composer overflow, no diagnostics, no visible fake secret, and no
  document/settings overflow.

Self-review:

- The first viewport remains conversation-first; the change adds one compact
  composer affordance and reuses the existing settings drawer.
- The shortcut has an accessible label and tooltip, avoids visible text, and
  does not loosen the session-scoped model/mode mutation rules.
- No Electron security settings, IPC channels, local server binding, or token
  checks changed.

Next work:

- Continue the model configuration workflow by making provider validation and
  saved provider state clearer in the composer/topbar after settings changes.
- Continue prototype fidelity by checking whether the doubled model icon should
  become a distinct local settings glyph in a later icon-system pass.

### Slice: Sidebar Models Settings Entry

Status: completed in iteration 72.

Goal: make the sidebar `Models` app action behave like a product-level model
configuration entry by opening Settings directly at Model Providers, while the
footer/topbar Settings actions continue opening the general settings dialog.

User-visible value: users can get from the first-viewport sidebar to provider,
API key, and model configuration in one click without hunting through the
settings rail, while the main workbench remains conversation-first.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-models-settings-entry.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Clicking sidebar `Models` opens the settings drawer with the Model Providers
  section as the active entry target and focuses the provider selector.
- Clicking footer/topbar `Settings` still opens the general Settings dialog and
  focuses the compact close control.
- The Models app action uses the model icon language instead of sharing the
  generic settings/sliders glyph.
- The settings drawer remains right-aligned, keeps conversation context visible,
  does not expose API keys/secrets, and does not open Advanced Diagnostics by
  default.
- Existing sidebar search, project grouping, branch, review, composer,
  terminal, relaunch, and settings validation workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, click sidebar Models, assert Settings
  opens with Model Providers targeted and the provider selector focused, close
  Settings, then continue the existing sidebar search, branch, review,
  settings, terminal, relaunch, and compact viewport workflows.
- E2E assertions: sidebar Models remains one of the app actions with an icon;
  Settings records the model provider target without exposing secrets or
  diagnostics; the provider selector is focused and visible; closing Settings
  restores the conversation; the regular Settings entry still focuses Close
  Settings; no console errors or failed local requests are recorded.
- Diagnostic artifacts to collect on failure: `sidebar-models-settings-entry.json`,
  `sidebar-models-settings-entry.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt and current
  plan as fixed requirements; `frontend-design` with the prototype as the
  constraint and a compact model-entry workflow; `electron-desktop-dev` for
  renderer behavior verified through component coverage and real Electron CDP.

Notes and decisions:

- This slice keeps Settings as the existing drawer rather than introducing a
  new model modal, because the current settings IA already has a Model
  Providers section and the product gap is entry/focus, not a new surface.
- The general Settings path uses an explicit wrapper so React click events
  cannot accidentally become a section id. Only the sidebar Models path passes
  `settings-model-providers`.
- The sidebar Models entry now uses the existing `ModelIcon`, leaving the
  footer Settings action on the generic sliders/settings glyph so the two
  commands no longer read as duplicates.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 30 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-01-50-592Z/`.
- Root `npm run build` passed; the existing vscode companion lint warnings
  remained warnings only.
- Root `npm run typecheck` passed.
- Key recorded metrics: `sidebar-models-settings-entry.json` recorded
  `initialSection: "settings-model-providers"`, `providerFocused: true`,
  Model Providers visible inside the 620 px settings drawer, an icon-led
  sidebar Models button with no direct text node overflow, no runtime
  diagnostics, no visible secret, no retained fake secret value, and no failed
  local requests or console errors in `summary.json`.

Next work:

- Continue tightening the model configuration workflow by making the composer
  model picker offer a clear route into Model Providers when no session model
  options are available or provider validation blocks sending.
- Continue prototype fidelity by reducing the remaining sidebar app-action text
  prominence if later screenshots show it still competing with project/thread
  navigation.

### Slice: Sidebar Search Escape and Empty State

Status: completed in iteration 71.

Goal: make sidebar search feel like a polished navigation control by allowing
Escape to close it and by replacing duplicate empty rows with a single compact
no-results state when a filter matches neither projects nor active-project
threads.

User-visible value: users can leave search with the expected keyboard gesture
and get a concise no-results message that does not expose paths, protocol
details, or debug state.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-search-escape-empty-state.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Pressing Escape while the sidebar search input is focused closes search,
  clears the query, updates the Search action pressed state, and restores the
  grouped project/thread browser.
- A query with no project or active-thread matches renders one compact
  `No matching projects or threads` row and does not render a duplicate
  no-matching-threads row.
- The no-results row remains muted, compact, non-overflowing, and does not
  contain raw paths, local endpoints, ACP/session IDs, or server URLs.
- Existing Search toggle, Clear Search, project filtering, active-thread
  filtering, Open Project, branch, review, settings, terminal, relaunch, and
  compact viewport workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open both fake Git projects, create the fake ACP thread, toggle
  Search, filter to the active thread, clear it, filter to a no-match token,
  press Escape, assert the grouped browser is restored, then continue the
  existing branch, review, settings, terminal, relaunch, and compact viewport
  workflows.
- E2E assertions: the no-match state contains exactly one compact
  `No matching projects or threads` empty row with no diagnostic leakage;
  Escape closes search and clears `aria-pressed`; restored rows do not overflow;
  no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `sidebar-search-filter.json`,
  `sidebar-search-filter.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt, current
  implementation plan, and prototype as fixed requirements without blocking on
  a user question; `frontend-design` with the prototype as the visual contract
  and keyboard search polish as compact desktop navigation behavior;
  `electron-desktop-dev` for renderer behavior verified through component
  coverage and real Electron CDP.

Notes and decisions:

- Escape closes search rather than only clearing the current query because the
  sidebar action is a transient navigation mode; the Clear Search icon remains
  the explicit query-only reset.
- A fully unmatched search renders one combined empty row instead of separate
  project and thread empty rows, keeping the grouped browser compact and closer
  to the prototype's low-noise sidebar.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 29 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-51-05-931Z/`.
- Key recorded metrics: `sidebar-search-filter.json` recorded the no-match
  search value `no-sidebar-match`, exactly one
  `No matching projects or threads` row at 26 px tall, zero project/thread rows
  while filtered, no overflow, and no protocol/path leakage. The same artifact
  recorded Escape closing search, `aria-pressed="false"`, two project rows and
  one active thread row restored. `summary.json` recorded zero console errors
  and zero failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining sidebar app-action text
  prominence and exploring a narrower icon-led rail if it can be done without
  hurting discoverability.
- Longer term, add a cross-project session index so sidebar search can show
  thread matches under inactive projects instead of only filtering active
  project sessions.

### Slice: Sidebar Search and Project Heading Actions

Status: completed in iteration 70.

Goal: make the left sidebar closer to `home.jpg` by adding a real app-level
Search entry and moving project-opening affordance into the project browser
heading as a compact icon action.

User-visible value: users can filter recent projects and the active project's
threads without leaving the workbench, while the top app actions read more like
New Thread, Search, and Models instead of mixing project management into the
global action rail.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/ThreadList.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-search-project-heading-actions.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Sidebar app actions are `New Thread`, `Search`, and `Models`; `Open Project`
  remains available as an icon-led action in the Projects heading.
- Clicking Search toggles a compact search field labelled
  `Search projects and threads` and focuses it.
- Search filters recent project rows by name/path/branch/dirty metadata and
  filters the active project's visible thread rows by normalized thread title
  or model/time metadata.
- Empty filtered states use compact muted rows and do not expose raw paths,
  local endpoints, ACP/session IDs, or debug text in visible sidebar chrome.
- The grouped active project/thread hierarchy, compact row heights, pinned
  footer Settings action, composer, branch, review, settings, terminal, relaunch,
  and compact viewport workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open both fake Git projects, return to the dirty project,
  create the fake ACP thread, toggle sidebar Search, filter to the active
  thread, clear the filter, then continue the existing branch, review, settings,
  terminal, relaunch, and compact viewport workflows.
- E2E assertions: Search appears in the app action rail; Open Project appears
  as an icon-led Projects heading action; the search input is focused after
  toggling; filtering hides nonmatching project rows and keeps the matching
  compact thread visible without overflow or protocol/path leaks; clearing
  restores the grouped browser; no console errors or failed local requests are
  recorded.
- Diagnostic artifacts: updated `sidebar-app-rail.json`,
  `sidebar-search-filter.json`, screenshots, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt and current
  plan as the fixed requirements source; `frontend-design` with the prototype
  as the visual contract and search as a compact desktop-native sidebar
  affordance; `electron-desktop-dev` for renderer behavior verified through
  component coverage and real Electron CDP.

Notes and decisions:

- Search is implemented locally in the renderer because the current session
  list only contains the active project's sessions; this still improves the
  project/thread browser without introducing a new server index.
- `Open Project` moved from the app action rail into the Projects heading as an
  icon-led action, matching the prototype's app-level Search shape while
  preserving the normal open-project workflow.
- The search input uses native `type="search"` semantics with appearance reset
  so it stays a 28 px compact row in Electron instead of adopting platform
  search-field height.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 29 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-43-42-259Z/`.
- Key recorded metrics: `sidebar-app-rail.json` recorded app actions
  `New Thread`, `Search`, and `Models`, a 20 px icon-led Open Project heading
  action, a 244 px sidebar, no row overflow, and the active thread nested under
  the active project. `sidebar-search-filter.json` recorded the focused
  `Search projects and threads` input at 28 px container height and 22 px input
  height, filtering to one active project row and the
  `Review README.md after the failing test` thread, then restoring both recent
  project rows after Clear Search. `summary.json` recorded zero console errors
  and zero failed local requests.

Next work:

- Continue prototype fidelity by adding active-section/search state polish such
  as keyboard Escape-to-close and clearer no-match text if search becomes a
  more central navigation feature.
- Longer term, add a cross-project session index so inactive project groups can
  show and search their own recent thread previews.

### Slice: Active Project Thread Grouping

Status: completed in iteration 69.

Goal: make the populated sidebar read as a grouped project/thread browser like
`home.jpg`, instead of separate Projects and Threads blocks that repeat context
and make the active task feel disconnected from its project.

User-visible value: recent projects stay visible, while the active project's
threads sit directly beneath that project row with compact indentation and no
extra `Threads` band competing with the project hierarchy.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/ThreadList.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-active-project-thread-grouping.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The sidebar uses one project browser section, with the active project's
  thread list nested under the active project row.
- Recent inactive project rows remain selectable and keep compact branch/dirty
  metadata.
- The existing `project-list` and `thread-list` landmarks remain available for
  component tests and real Electron CDP checks.
- Thread rows remain compact, titles stay normalized, and no raw branch names,
  local URLs, session IDs, full paths, or debug protocol text appear in visible
  sidebar chrome.
- The footer settings action remains pinned at the bottom without overlapping
  the grouped browser at desktop and compact viewport sizes.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open both fake Git projects, switch back to the dirty project,
  create the fake ACP thread, inspect the populated sidebar hierarchy, then
  continue the existing composer, branch, review, settings, terminal, relaunch,
  and compact viewport workflows.
- E2E assertions: `thread-list` is contained by the active project group inside
  `project-list`; no standalone Threads section heading is visible; project and
  thread rows stay compact and contained; the active compact thread title is
  visible without endpoint/path/protocol leaks; no console errors or failed
  local requests are recorded.
- Diagnostic artifacts: updated `sidebar-app-rail.json`,
  `topbar-context-fidelity.json`, screenshots, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt, current
  implementation memory, and `home.jpg` as the requirements source without a
  blocking user question; `frontend-design` with the prototype as the visual
  contract and grouped navigation as the design direction; `electron-desktop-dev`
  for renderer behavior verified through component coverage and real Electron
  CDP.

Notes and decisions:

- This slice groups only the active project's loaded sessions because the
  current renderer receives session summaries for the active project, not a
  cross-project thread index.
- The grouped structure keeps existing project/session callbacks and test IDs,
  limiting behavioral risk while moving the visible hierarchy closer to the
  prototype.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-24-04-149Z/`.
- Key recorded metrics: `sidebar-app-rail.json` recorded a single `Projects`
  heading, `threadListInsideProjectList: true`,
  `threadListInsideActiveProject: true`, a 244 px sidebar, a 28 px active
  thread row, no horizontal row overflow, zero console errors, and zero failed
  local requests.

Next work:

- Continue populated-sidebar fidelity by adding lightweight per-project thread
  previews once a cross-project session index is available.
- Consider tightening remaining sidebar row text weight and project-row
  metadata spacing against `home.jpg` after the grouped hierarchy settles.

### Slice: Thread Title Local Endpoint Tail Restraint

Status: completed in iteration 68.

Goal: remove residual local endpoint wording from normalized thread titles so
populated sidebar and topbar rows read like user task titles instead of
protocol-derived prompts.

User-visible value: users see concise thread names such as
`Review README.md after the failing test` rather than titles ending in
`in local...`, which keeps the populated project/thread browser closer to
`home.jpg` and reduces diagnostic noise in the main workbench chrome.

Expected files:

- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/thread-title-local-endpoint-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Local `127.0.0.1` and `localhost` URLs are removed from session display
  titles along with a directly preceding preposition such as `in`, `at`, or
  `from`.
- Sidebar thread rows and the topbar title show the compact task title without
  `local server`, `local...`, raw local URLs, ACP/session IDs, or temp paths.
- Missing or ID-like titles still render as `Untitled thread`.
- Existing project metadata, branch controls, composer, review, settings,
  terminal, and compact layout workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, create the noisy fake ACP thread,
  inspect populated sidebar and topbar title text, then continue the existing
  composer, branch, review, settings, terminal, relaunch, and compact viewport
  workflows.
- E2E assertions: thread row and topbar title contain
  `Review README.md after the failing test`; visible navigation chrome omits
  local endpoint tails and protocol/session/path noise; no console errors or
  failed local requests are recorded.
- Diagnostic artifacts: updated `sidebar-app-rail.json`,
  `topbar-context-fidelity.json`, screenshots, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt and current
  artifacts as the requirements source without a blocking user question;
  `frontend-design` with the prototype as the visual contract and title
  restraint as the design direction; `electron-desktop-dev` for renderer
  formatter behavior verified through component coverage and real Electron CDP.

Notes and decisions:

- This slice does not attempt semantic AI title generation; it is a deterministic
  cleanup for local diagnostic tails that should never be visible in main
  navigation chrome.
- The formatter only strips localhost/127.0.0.1 endpoints and their immediate
  preposition, avoiding broad removal of natural phrases like `sign in`.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-12-56-109Z/`.
- Key recorded metrics: `sidebar-app-rail.json` recorded the active row
  `threadTitle` as `Review README.md after the failing test`; the visible
  sidebar text omitted local endpoint tails and protocol/path noise.
  `topbar-context-fidelity.json` recorded `titleText` as the same compact
  title, with zero horizontal overflow. `summary.json` recorded zero console
  errors and zero failed local requests.

Next work:

- Continue populated-sidebar fidelity by making project/thread grouping closer
  to `home.jpg` when several recent projects and threads are present.
- Consider reducing remaining sidebar app-action text prominence or moving
  repeated actions toward a more icon-led rail once the grouped browser shape
  is stable.

### Slice: No-Project Composer Quiet State

Status: completed in iteration 67.

Goal: make the first-launch no-project composer feel like a quiet inactive
task control instead of an amber warning/action state.

User-visible value: users still get a clear `Open a project to start` reason,
but the disabled composer no longer competes with the conversation canvas or
suggests a risky warning; the send affordance only uses the blue action styling
when it can actually send.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/no-project-composer-quiet-state.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The no-project empty-state label remains visible, compact, and anchored near
  the composer.
- The disabled composer reason remains present and accessible, but uses muted
  neutral chrome instead of warning color and heavy pill emphasis.
- Disabled send buttons use neutral inactive styling rather than the primary
  blue gradient; active send styling remains unchanged when a message can send.
- Composer project/branch/model/permission chips stay contained at the default
  desktop viewport and compact viewport.
- Existing composer-first thread creation, branch, review, settings, terminal,
  model, relaunch, and compact viewport workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert first-launch no-project composer styling and geometry,
  then open projects and continue the existing composer, branch, review,
  settings, terminal, model, relaunch, and compact viewport workflows.
- E2E assertions: disabled composer reason is present, muted, compact, and
  non-overflowing; disabled send action has no blue gradient and remains an
  icon button; no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `initial-layout.json`, `initial-workspace.png`,
  Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt and current
  artifacts as the requirements source without blocking on a user question;
  `frontend-design` with the prototype as the contract and the quiet inactive
  state as the direction; `electron-desktop-dev` for renderer CSS/DOM changes
  verified through the real Electron CDP harness.

Notes and decisions:

- This slice keeps the no-project composer disabled; composer-first creation
  remains scoped to an active project.
- The muted disabled reason still uses explicit text because the no-project
  state needs a discoverable next action, but it is no longer styled as a
  warning pill.
- Disabled send buttons now use neutral inactive chrome globally, so the
  primary blue send treatment is reserved for sendable composer states.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-05-13-907Z/`.
- Key recorded metrics: `initial-layout.json` recorded the disabled composer
  reason at 138.133 px wide, 22 px tall, 10.6 px / 620 weight, 0.56 text alpha,
  0.035 background alpha, no overflow, and no background image. The disabled
  Send button recorded `backgroundImage: none`, 0.055 background alpha, and
  0.72 opacity. `summary.json` recorded zero console errors and zero failed
  local requests.

Next work:

- Continue prototype fidelity by making the populated sidebar read more like
  the grouped project/thread browser in `home.jpg`, especially when several
  recent projects and threads are present.
- Consider reducing the remaining no-project terminal strip prominence now that
  the composer disabled state is quieter.

### Slice: First Viewport Chrome Restraint

Status: completed in iteration 66.

Goal: make the no-project first viewport and remaining sidebar/topbar text
weight feel closer to `home.jpg` instead of a sparse debug dashboard.

User-visible value: first launch keeps the workbench calm and conversation-led:
the empty-state prompt sits quietly near the composer, the sidebar actions and
rows stop shouting, and the slim topbar metadata reads as supporting context.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/first-viewport-chrome-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The no-project conversation empty state is a compact, muted prompt anchored
  near the composer instead of large centered copy.
- The disabled no-project composer reason remains present and accessible while
  using smaller, softer control chrome.
- Sidebar app actions, section headings, project rows, thread rows, and empty
  rows use lower font weight and smaller visual scale without overflowing.
- Topbar title, project context, branch/Git metadata, and runtime status keep
  the existing slim geometry but reduce remaining heavy type weight.
- Existing composer-first thread creation, branch, review, settings, terminal,
  model, relaunch, and compact viewport workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, assert the no-project initial workspace geometry and typography,
  then open projects and continue the existing composer, branch, review,
  settings, terminal, model, relaunch, and compact viewport workflows.
- E2E assertions: initial empty-state text is present, muted, compact, and
  positioned just above the composer; disabled composer reason stays compact;
  sidebar row/headline text weights are under the new restrained thresholds;
  topbar title/context/runtime text weights stay below heavy-dashboard values;
  no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `initial-layout.json`, `initial-workspace.png`,
  `sidebar-app-rail.json`, `topbar-context-fidelity.json`, corresponding
  screenshots, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the Ralph prompt, prototype,
  and current artifacts as requirements without a blocking user question;
  `frontend-design` with the prototype as the visual contract and restraint as
  the design direction; `electron-desktop-dev` for renderer CSS/DOM changes
  verified through the real Electron CDP harness.

Notes and decisions:

- This slice intentionally avoids new navigation concepts or behavior changes;
  it is a fidelity pass on the workbench chrome and first-launch state.
- The no-project composer remains disabled because composer-first creation is
  scoped to an active project; this pass only reduces redundant visual weight.
- The compact settings CDP assertion now scrolls the drawer content directly
  with smooth scrolling disabled for the measurement frame, avoiding a
  `scrollIntoView` path that could move the wrong container under compact
  geometry while preserving the same reachability assertion.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-54-33-740Z/`.
- Key recorded metrics: `initial-layout.json` recorded the empty-state label
  at 12 px / 600 weight with 0.52 text alpha, positioned just above the
  composer; the disabled composer reason at 138.836 px wide, 22 px tall, 10.6
  px / 650 weight, and no overflow; sidebar app actions at 11 px / 560 weight;
  sidebar headings at 9 px / 720 weight; the topbar at 50 px tall with title
  12.5 px / 700 weight, context text 10.2 px / 620 weight, and runtime status
  10.2 px / 740 weight. `summary.json` recorded zero console errors and zero
  failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining no-project composer
  disabled affordance weight and making the sidebar/topbar closer to the
  `home.jpg` visual rhythm when populated with several real projects.
- Consider active-section state for the settings rail now that the drawer
  scroll checks are deterministic.

### Slice: Settings Drawer Section Rail

Status: completed in iteration 65.

Goal: make Settings feel like a compact product settings drawer instead of a
two-column debug/dashboard surface.

User-visible value: users keep the conversation visible behind Settings, can
jump between Account, Model Providers, Permissions, Tools, Terminal,
Appearance, and Advanced from a slim internal rail, and still keep runtime
diagnostics hidden until Advanced Diagnostics is opened.

Expected files:

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-drawer-section-rail.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings opens as a right-aligned drawer no wider than the prior sheet and
  preserves visible conversation context behind the backdrop.
- The default Settings body has a compact `Settings sections` navigation rail
  with entries for Account, Model Providers, Permissions, Tools & MCP,
  Terminal, Appearance, and Advanced.
- Clicking the Permissions rail entry scrolls the Permissions section into the
  settings content without moving document/body scroll.
- Settings sections render as one compact content column with lighter section
  chrome instead of a two-column card dashboard.
- Runtime/server/session diagnostics, local server URLs, ACP IDs, and settings
  paths remain hidden until `Advanced Diagnostics` is opened.
- Existing model validation, Coding Plan workflow, composer model switching,
  terminal, branch, review, and relaunch CDP workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the existing project/thread/review flow, open
  Settings, assert the section rail and compact one-column drawer geometry,
  click the Permissions rail entry, verify diagnostics are still hidden, then
  continue settings validation, Coding Plan, Advanced Diagnostics, terminal,
  model, branch, and relaunch workflows.
- E2E assertions: rail entries are visible and accessible, the settings drawer
  is narrower than the old dashboard-width sheet, content sections sit to the
  right of the rail in one column, the Permissions link scrolls only the
  settings content, no local server/session diagnostics appear before Advanced,
  and no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `settings-layout.json`,
  `settings-page.png`, `compact-settings-overlay.json`,
  `compact-settings-overlay.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` using the existing Ralph prompt and
  docs as requirements rather than asking a blocking question;
  `frontend-design` for prototype-constrained settings hierarchy and reduced
  card chrome; `electron-desktop-dev` for renderer changes verified through the
  real Electron CDP harness.

Notes and decisions:

- This slice keeps Settings as an overlay drawer instead of a primary
  workbench tab, following the conversation-first contract from `home.jpg`.
- The rail uses anchors inside the drawer rather than adding new settings
  routing or server state.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-36-23-530Z/`.
- Key recorded metrics: `settings-layout.json` recorded the default settings
  drawer at 620 px wide with a 112 px `Settings sections` rail, 469 px
  one-column settings sections, 376 px of visible task backdrop, no review
  drawer, no runtime diagnostics, and no body overflow. The rail navigation
  artifact recorded clicking `Permissions` scrolled only the drawer content
  while leaving document scroll at 0. `compact-settings-overlay.json` recorded
  a 600 px drawer with a 102 px rail, contained one-column sections, and no
  diagnostic leakage. `summary.json` recorded zero console errors and zero
  failed local requests.

Next work:

- Continue prototype fidelity by trimming the remaining topbar/sidebar text
  weight and reducing first-viewport empty-state scale.
- Consider a follow-up settings slice that adds active-section state to the
  rail while keeping the implementation local to the drawer.

### Slice: User Message Bubble Restraint

Status: completed in iteration 64.

Goal: make user prompt messages in the main conversation feel like compact
prototype-aligned message bubbles instead of fixed-width amber cards.

User-visible value: short prompts no longer occupy a wide warning-colored card,
so the conversation reads closer to `home.jpg`: user input is still distinct
and right aligned, but assistant prose, activity rows, and changed-file
summaries remain the visual priority.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/user-message-bubble-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Short user messages size to their text content up to a bounded max width,
  rather than always occupying the previous 520 px bubble.
- User bubbles use the Qwen blue/violet accent family rather than warning/amber
  styling reserved for approvals or risk.
- User bubbles remain right aligned, accessible as `User message`, and do not
  render visible role labels.
- Long user prompts still wrap inside the compact viewport without escaping the
  conversation timeline or causing horizontal overflow.
- Existing assistant actions, changed-files summary, command approval, review,
  settings, terminal, branch, model, and relaunch CDP workflows remain
  unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the dirty fake project, send the command-approval prompt,
  assert the short user bubble geometry and accent styling, send a long prompt
  in the compact viewport, and continue the existing review, settings,
  terminal, model, branch, and relaunch workflows.
- E2E assertions: the short user bubble is content-sized below the fixed card
  threshold, has blue/violet accent border and background alpha, keeps compact
  height/type scale, and long-prompt user messages remain contained in compact
  layout with no body overflow.
- Diagnostic artifacts: updated `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to select this smallest remaining
  prototype-fidelity slice; `frontend-design` to align message treatment with
  the prototype instead of inventing a new visual direction; and
  `electron-desktop-dev` for renderer CSS verified through the real Electron
  CDP harness.

Notes and decisions:

- Keep the semantic message structure unchanged; this slice changes only the
  visual treatment and executable geometry assertions.
- Preserve the warning color family for command approval and validation states,
  where amber carries user-risk meaning.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/`.
- Key recorded metrics: `conversation-surface-fidelity.json` recorded the
  short user prompt bubble at 238.078 px wide and 37.234 px tall, with
  `rgba(85, 166, 255, 0.08)` background, `rgba(85, 166, 255, 0.28)` border,
  accessible label `User message`, and no role-label chrome.
  `compact-dense-conversation.json` recorded the long user prompt contained in
  the compact timeline at 531.953 px wide with no user-message overflow and
  body scroll width equal to the 960 px viewport. `summary.json` recorded zero
  console errors and zero failed local requests.

Next work:

- Continue prototype fidelity by trimming the remaining topbar/sidebar type
  weight or making settings overlay section chrome less card-heavy.
- Consider a follow-up visual pass on conversation activity spacing so the
  user bubble, tool rail, changed-files rail, and composer sit closer to the
  density in `home.jpg`.

### Slice: Review Drawer Chrome Restraint

Status: completed in iteration 63.

Goal: make the review drawer read as a compact supporting surface rather than
another large dashboard by reducing tab/meta visual weight and collapsing the
empty per-file comment editor until it is needed.

User-visible value: users can still open changes, inspect files, add review
notes, stage, discard with confirmation, and commit, but the first viewport
keeps more attention on the conversation and composer.

Expected files:

- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/review-drawer-chrome-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Review drawer section tabs are compact, icon-led, and no longer appear as
  heavy full-width dashboard tabs.
- Review Git metadata remains accessible as `Branch`, `Modified`, `Staged`,
  `Untracked`, and `Files`, but renders as a compact strip.
- Empty file comment editors are collapsed by default; clicking `Add Comment`
  opens the textarea, saves the note, and returns the drawer to the compact
  state.
- Stage/Discard/Open/Add Comment/Commit labels remain accessible through
  `aria-label`, `title`, and sr-only text where appropriate.
- Review-open desktop and compact viewports keep the conversation wider than
  the drawer, avoid horizontal overflow, and keep the terminal collapsed.
- Existing discard confirmation, staging, commit, branch, settings, terminal,
  model, composer, and relaunch workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the dirty fake project, open review, assert compact
  tab/meta/comment chrome in desktop and compact windows, open a review comment
  editor, save a comment, cancel discard confirmation, stage all, commit, and
  continue the existing branch, settings, terminal, model, composer, and
  relaunch workflows.
- E2E assertions: review tabs include icons and compact geometry, metadata
  items fit a short strip without overflow, no review-comment textarea is
  visible by default, the textarea appears only after `Add Comment`, saved
  comments remain visible, and no console errors or failed local requests are
  recorded.
- Diagnostic artifacts: updated review drawer layout JSON, compact review
  layout JSON, review screenshots, discard confirmation JSON, Electron log,
  and `summary.json` under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to choose a narrow fidelity slice
  instead of a larger review IA rewrite; `frontend-design` to keep the drawer
  restrained and subordinate to the conversation per `home.jpg`; and
  `electron-desktop-dev` for renderer behavior verified in a real Electron app
  through the CDP harness.

Notes and decisions:

- Keep the review service, staging, discard, and commit behavior unchanged.
  This slice is presentation and interaction chrome only.
- Keep the existing section tabs as controls for future Files/Artifacts/Summary
  content, but make them icon-led and compact now so they no longer dominate
  the drawer.
- Collapse only empty comment editors by default. Existing/saved comments
  remain visible, and `Add Comment` is still the accessible action that opens
  and submits the note.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-03-53-113Z/`.
- Key recorded metrics: `review-drawer-layout.json` recorded four icon-led
  review tabs at 28 px high, five Git metadata chips at 22 px high, and a
  collapsed 51 px comment affordance with no textarea visible by default.
  `compact-review-drawer.json` recorded tabs at 26 px, metadata chips at 22 px,
  and a collapsed 43 px comment affordance in the compact viewport.
  `summary.json` recorded zero console errors and zero failed local requests.

Next work:

- Continue prototype fidelity by making the review drawer tabs switch actual
  local bodies or by further reducing the drawer file/diff typography so the
  conversation keeps visual priority.
- Consider improving the settings overlay header and secondary section chrome
  so product settings stay compact without exposing diagnostics by default.

### Slice: Recent Project Relaunch Recovery

Status: completed in iteration 62.

Goal: preserve the user-selected recent project across an app relaunch when
multiple projects are present, so the sidebar order and active project recover
the last project the user intentionally switched to.

User-visible value: a user can open a dirty project, open a clean comparison
project, switch back from the sidebar, quit, and relaunch without the desktop
silently returning them to the clean project just because it was the last
project opened through the native dialog.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/recent-project-relaunch-recovery.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Selecting a recent project from the sidebar refreshes that project as the
  most recently opened project without requiring the native open-project dialog.
- Relaunching the real Electron app with the same isolated HOME/user-data after
  switching back to the dirty project restores that dirty project as the active
  sidebar row and topbar project.
- The persisted recent-project store contains both projects once each, with the
  sidebar-selected project first after relaunch.
- The dirty project's compact topbar diff stat and inline changed-files summary
  return after relaunch; the clean project's stale state does not leak into the
  active workbench.
- Existing composer, branch, review, settings, terminal, model, and commit CDP
  workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open a dirty project, open a clean second project, switch back
  to the dirty project from the sidebar, restart Electron with the same isolated
  HOME/user-data, assert the dirty project is active and first in recent
  projects, then continue the existing branch, review, settings, terminal,
  model, composer, and commit workflows.
- E2E assertions: recent-project store order matches the active sidebar row,
  both project paths are persisted without duplicates, topbar project and
  `+2 -1` diff stat belong to the dirty project after relaunch, no stale clean
  state is visible, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `project-relaunch-persistence.json`,
  `project-relaunch-persistence.png`, updated Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to choose a narrow workflow
  hardening slice; `frontend-design` to keep project recovery aligned with the
  prototype's compact recent-project navigation instead of adding new chrome;
  and `electron-desktop-dev` for renderer behavior verified in a relaunched
  real Electron app through CDP.

Notes and decisions:

- Reuse the existing authenticated `open project` API to mark a sidebar
  selection as recently opened. This avoids adding a new server route while
  preserving the same path validation and Git status refresh used by the native
  open-project flow.
- Keep active-project recovery tied to the persisted recent-project order for
  this slice. A separate explicit active-project preference can be added later
  if the product needs a different ordering model.
- The CDP harness now normalizes temporary workspace paths through `realpath`
  before handing them to Electron. This keeps Git assertions and the persisted
  recent-project store aligned on macOS, where `/var` paths are stored as
  `/private/var`.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 66 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-51-16-222Z/`.
- Key recorded metrics: `project-relaunch-persistence.json` recorded the dirty
  project as the only active project row and first recent project after
  relaunch, the clean project as second and inactive, exactly two persisted
  project paths with no duplicates, topbar Git text `+2 -1`, full Git metadata
  `1 modified · 0 staged · 1 untracked · Diff +2 -1`, a visible conversation
  changed-files summary, no body overflow, and a clean second workspace.
  `summary.json` recorded zero console errors and zero failed local requests.

Next work:

- Continue prototype fidelity by reducing remaining visible text weight in the
  review drawer tabs and runtime details, or by making the comment area more
  compact when no note has been entered.
- Consider adding an explicit active-project preference if future product
  requirements need active recovery to diverge from recent-project ordering.

### Slice: Review Drawer Action Density

Status: completed in iteration 61.

Goal: make repeated review drawer actions match the prototype's compact,
icon-led supporting-tool shape without weakening Stage/Discard terminology or
destructive-action confirmation.

User-visible value: the review drawer remains available for code review, but
its file and hunk controls no longer read as large dashboard buttons that
compete with the conversation. Users still get explicit accessible labels,
tooltips, and confirmation before any discard.

Expected files:

- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/review-drawer-action-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Review drawer global, file, hunk, and comment actions render as compact
  icon-led controls with stable accessible names and tooltips.
- Destructive discard actions remain visually secondary/danger-styled and still
  require the existing confirmation before changing local files.
- Stage/Discard/Open/Add Comment/Commit terminology remains available to
  assistive technology and tests; `Accept`/`Revert` do not return.
- Review-open desktop and compact viewports keep all drawer action controls
  within compact geometry thresholds with no horizontal overflow.
- Git staging, discard cancel, commit, branch, settings, terminal, composer,
  and model workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the dirty fake project, open the review drawer, assert
  compact icon-led review controls, cancel a discard confirmation, stage all,
  commit, then continue the existing branch, settings, terminal, compact
  viewport, and composer workflows.
- E2E assertions: review action labels are present through aria/title, action
  controls include SVG icons and sr-only text, repeated review controls stay
  compact, destructive controls keep danger styling plus confirmation, and no
  console errors or failed local requests are recorded.
- Diagnostic artifacts: updated review drawer layout JSON, compact review
  layout JSON, review safety JSON, review screenshots, Electron log, and
  `summary.json` under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to select icon-led density over a
  larger review IA rewrite; `frontend-design` to keep the drawer subordinate to
  the conversation and closer to `home.jpg`; and `electron-desktop-dev` for
  renderer changes verified through the real Electron CDP harness.

Notes and decisions:

- Keep the existing review service, staging, discard, and commit handlers
  unchanged. This slice changes only the review control presentation and
  harness assertions.
- Do not hide destructive action semantics behind an unlabeled overflow menu in
  this slice; preserve direct but compact controls while relying on the
  existing confirmation gate.
- The first-viewport review drawer now uses icon-led controls for the repeated
  global, file, hunk, comment, and commit actions. Labels remain in
  `aria-label`, `title`, and sr-only text so keyboard/search/test paths still
  use Stage/Discard/Open/Add Comment/Commit language.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-42-32-251Z/`.
- Key recorded metrics: `review-drawer-layout.json` recorded review action
  controls at 30 px with SVG icons, sr-only labels, no direct text, danger
  styling on discard actions, and primary styling on commit.
  `compact-review-drawer.json` recorded the same controls at 28 px in a
  960x608 viewport with no review, changed-file, commit, composer, grid, or
  topbar overflow. `summary.json` recorded zero console errors and zero failed
  local requests.

Next work:

- Continue prototype fidelity by reducing remaining visible text weight in the
  review drawer tabs and runtime details, or by making the comment area more
  compact when no note has been entered.
- Add restart-persistence coverage for multiple recent projects so sidebar
  ordering and active project recovery stay aligned after app relaunch.

### Slice: Review Drawer Git Refresh Relocation

Status: completed in iteration 60.

Goal: demote manual Git refresh from the primary topbar action cluster into the
supporting review drawer, keeping the first viewport closer to `home.jpg` and
reducing always-visible chrome around the conversation.

User-visible value: the topbar stays focused on conversation, review, settings,
runtime, branch, and compact diff state, while users still have a discoverable
Refresh Git action when they are inspecting changes.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/review-drawer-git-refresh-relocation.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The topbar no longer renders a `Refresh Git` icon button in default or
  review-open layouts.
- The review drawer header renders an icon-only `Refresh Git` action with
  accessible label, tooltip, and compact dimensions.
- Clicking the review drawer refresh action calls the existing Git refresh
  handler; no server, IPC, or Git service contract changes are required.
- Conversation and composer remain dominant, and review-open desktop and compact
  viewports do not overflow horizontally or vertically.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the dirty fake project, inspect default topbar action
  labels, open the review drawer, assert `Refresh Git` lives in the drawer
  header rather than the topbar, then continue the existing branch, staging,
  commit, settings, terminal, compact viewport, and composer workflows.
- E2E assertions: topbar action labels exclude `Refresh Git`, review drawer
  button labels include `Refresh Git`, all review buttons remain compact, topbar
  height stays slim, and no console errors or failed local requests are
  recorded.
- Diagnostic artifacts: updated review drawer layout JSON, compact review
  layout JSON, topbar/context screenshots, Electron log, and `summary.json`
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to evaluate the narrowest
  prototype-fidelity action relocation; `frontend-design` to keep the change
  constrained by the prototype's conversation-first chrome; and
  `electron-desktop-dev` for renderer changes verified through the real
  Electron CDP harness.

Notes and decisions:

- Keep the existing refresh handler and project Git state flow unchanged. This
  slice changes only where the user invokes the action.
- The review drawer is the correct home for manual refresh because it is where
  users inspect branch/file counts and review diffs; the topbar keeps the
  compact status output.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-29-42-195Z/`.
- Key recorded metrics: `review-drawer-layout.json` recorded topbar actions as
  `Conversation`, `Close Changes`, and `Settings`, with `Refresh Git` present
  in review drawer buttons at 28 px. `compact-review-drawer.json` recorded the
  same action placement at 960x608, a 50 px topbar, 304 px review drawer,
  424 px conversation, no overflow, and all containment checks passing.
  `summary.json` recorded zero console errors and zero failed local requests.

Next work:

- Continue prototype fidelity by reviewing whether the review drawer's text
  actions (`Discard All`, `Stage All`, per-file/hunk actions) should become
  denser icon+tooltip controls without weakening destructive-action safety.
- Add restart-persistence coverage for multiple recent projects so sidebar
  ordering and active project recovery stay aligned after app relaunch.

### Slice: Project Switch Diff Stat Isolation

Status: completed in iteration 59.

Goal: harden the multi-project workflow so compact topbar diff stats are scoped
to the active project when a user opens or switches recent projects.

User-visible value: opening a clean second project after reviewing a dirty
project no longer risks showing stale `+N -M` change counts in the slim topbar;
switching back restores the dirty project's own diff summary.

Expected files:

- `packages/desktop/src/main/native/dialogs.ts`
- `packages/desktop/src/main/native/e2eSelectDirectory.ts`
- `packages/desktop/src/main/native/e2eSelectDirectory.test.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/project-switch-diff-stat-isolation.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- E2E-only directory selection can provide more than one deterministic project
  path without changing production dialog behavior.
- The real Electron CDP harness opens a dirty project, verifies the topbar
  `+2 -1` diff stat, opens a clean second project, and asserts the topbar shows
  clean project Git state with no stale diff stat or changed-files summary.
- The same harness switches back to the dirty project from the sidebar and
  asserts the dirty project's `+2 -1` stat and metadata return.
- Sidebar project rows remain compact for both recent projects, and the first
  viewport stays conversation-first with no horizontal overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/main/native/e2eSelectDirectory.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the dirty fake project, verify the compact diff stat, open
  a clean fake project through the same Open Project control, assert no stale
  diff state is visible, switch back through the sidebar, and continue the
  existing branch, review, settings, terminal, model, and composer workflows.
- E2E assertions: clean project topbar status is `Clean`, no topbar diff stat
  node is rendered, no conversation changed-files summary remains from the
  previous project, returning to the dirty project restores `+2 -1` with full
  metadata, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `project-switch-clean-git-status.json`,
  `project-switch-dirty-git-status.json`, updated topbar/sidebar/layout
  screenshots, Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to select the narrow hardening
  slice; `frontend-design` to preserve prototype-constrained compact project
  chrome; and `electron-desktop-dev` for real Electron CDP verification of the
  user workflow.

Notes and decisions:

- Use an E2E-only multi-directory selector instead of weakening the production
  native dialog path. The selector repeats the final provided directory so the
  existing single-project E2E behavior remains compatible.
- Keep the production project-switching code unchanged unless the new harness
  exposes a real stale-state bug; `App` already clears `gitDiff` on project
  selection and workspace opening, so this slice primarily locks that behavior
  down in real Electron.
- The first CDP attempt placed the project-switch check after conversation
  activity, which correctly reset chat state and broke a later compact-review
  assertion. The harness now performs the two-project switch before sending the
  first prompt, preserving coverage without erasing the rest of the workflow.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/main/native/e2eSelectDirectory.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 33 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-20-30-259Z/`.
- Key recorded metrics: `project-switch-clean-git-status.json` recorded the
  clean project as active with topbar status `Clean`, no topbar diff-stat node,
  no conversation changed-files summary, two recent project rows, and no
  document overflow. `project-switch-dirty-git-status.json` recorded switching
  back to the dirty project with `+2 -1`, full Git metadata containing
  `1 modified · 0 staged · 1 untracked · Diff +2 -1`, and the changed-files
  summary restored. `summary.json` recorded zero console errors and zero failed
  local requests.

Next work:

- Add restart-persistence coverage for multiple recent projects so the sidebar
  ordering and active project recovery stay aligned after app relaunch.
- Continue prototype fidelity by reducing remaining topbar action chrome and
  evaluating whether Refresh Git should live in the review drawer or an
  overflow action.

### Slice: Topbar Diff Stat Affordance

Status: completed in iteration 58.

Goal: make the topbar dirty-state affordance read like the `home.jpg`
prototype by showing compact line-level diff counts (`+N -M`) when review diff
data is available, while preserving full Git file-count details in
accessibility metadata.

User-visible value: the slim topbar communicates the size of pending code
changes with the same quick-scan shape as the prototype instead of competing
with the conversation through generic `dirty` text.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/topbar-diff-stat-affordance.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- When the active project has a loaded review diff, the topbar Git status
  visible text shows compact additions/deletions such as `+2 -1`.
- The full modified/staged/untracked breakdown remains in `title` and
  `aria-label`; file-count fallback labels such as `2 dirty` remain available
  when no diff is loaded.
- Addition and deletion values use the existing success/danger color language
  without introducing a new heavy pill or dashboard-style Git panel.
- The review drawer badge, branch creation/switching, discard cancel, stage,
  commit, refresh, composer, settings, and terminal workflows remain unchanged.
- Default, compact, and review-open Electron viewports keep the topbar slim,
  contained, and free of horizontal overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project with one modified tracked file and one
  untracked file, inspect the topbar diff-stat affordance, create/switch
  branches with dirty changes, cancel discard, stage and commit, and continue
  the existing review, settings, terminal, model, and composer workflows.
- E2E assertions: topbar visible Git status shows `+2 -1`, additions/deletions
  have distinct diff stat styling, full Git status metadata remains present,
  file-count review badge remains `2`, staged and committed states still
  update, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `topbar-context-fidelity.json`,
  `topbar-context-fidelity.png`, branch result JSON, review screenshots,
  Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the narrow
  diff-stat slice; `frontend-design` for prototype-constrained topbar density
  and color treatment; and `electron-desktop-dev` for real Electron CDP
  verification of renderer behavior.

Notes and decisions:

- Use the already-loaded review diff as the source for line-level stats rather
  than expanding the project Git status API in this slice. That keeps the
  change scoped to first-viewport presentation while preserving file-count
  fallbacks when diff data is not available yet.
- Project switching now clears the loaded review diff before the next project's
  diff loads, preventing stale line counts from appearing in the topbar during
  project changes.
- The real Electron harness previously waited for visible `2 staged` text from
  the old topbar label. The staged-state assertion now checks review counts and
  topbar metadata instead, matching the new prototype-style visible diff stat.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 27 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-09-47-255Z/`.
- Key recorded metrics: `topbar-context-fidelity.json` recorded visible Git
  status `+2 -1`, title and aria metadata containing
  `1 modified · 0 staged · 1 untracked · Diff +2 -1`, distinct addition and
  deletion colors, a 50 px topbar, no visible raw long branch, and no document
  overflow. `review-stage-all-result.json` recorded topbar text `+2 -1` after
  staging, metadata containing the staged breakdown plus `Diff +2 -1`, review
  counts of modified `0`, staged `2`, untracked `0`, and the added file state.
  `summary.json` recorded zero console errors and zero failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining topbar action chrome:
  evaluate whether Refresh Git should move behind an overflow or review drawer
  action now that the primary diff affordance is compact.
- Add a project-switching CDP assertion for stale diff-stat prevention when
  multiple recent projects are present.

### Slice: Topbar Context Meta Restraint

Status: completed in iteration 57.

Goal: make the topbar project context read like compact workbench chrome by
shortening the visible branch label and replacing verbose modified/staged/
untracked text with a bounded status summary.

User-visible value: the first viewport moves closer to `home.jpg`: current
thread, project, branch, and dirty state remain visible, but long branch names
and Git diagnostics no longer crowd the slim topbar or compete with the
conversation.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/topbar-context-meta-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Topbar branch context shows a shortened visible label for long branch names
  while preserving the full branch in title/accessible metadata and in the
  branch menu.
- Topbar Git status shows compact visible labels such as `2 dirty`,
  `2 staged`, `Clean`, or `No Git`, while preserving the full modified/staged/
  untracked breakdown in title/accessible metadata.
- Branch switching, branch creation, review drawer, settings overlay, terminal
  drawer, composer first-send, model/permission controls, and dirty status
  refresh workflows remain unchanged.
- Default, compact, and review-open Electron viewports keep the topbar slim,
  icon-led, and free of horizontal overflow.
- The main conversation remains the dominant first-viewport surface; no new
  dashboard-style Git panel or heavy pill chrome is introduced.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project on a deliberately long branch with dirty
  changes, inspect topbar context metrics, create and switch branches, cancel a
  discard, stage and commit changes, and continue the existing review,
  settings, terminal, model, and composer workflows.
- E2E assertions: visible topbar context omits the raw long branch and verbose
  Git breakdown, full branch/status details remain available in title/aria
  metadata, topbar items stay bounded with no heavy pill chrome, and no console
  errors or failed local requests are recorded.
- Diagnostic artifacts: updated `topbar-context-fidelity.json`,
  `topbar-context-fidelity.png`, branch result JSON, review screenshots,
  Electron log, and `summary.json` under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the narrow
  label-formatting slice; `frontend-design` for prototype-constrained topbar
  density; and `electron-desktop-dev` for real Electron CDP verification of
  renderer behavior.

Notes and decisions:

- The prototype favors compact branch chrome in the topbar, so full branch
  names stay in hover/accessibility metadata and the branch menu instead of
  remaining visible in the topbar context row.
- Git status detail remains available without turning the topbar into a full
  Git diagnostics row; the review drawer remains the detailed Git surface.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 26 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-56-51-507Z/`.
- Key recorded metrics: `topbar-context-fidelity.json` recorded
  `visibleHasLongBranch: false`, branch trigger text
  `desktop-e2e/very...rflow-check`, branch title/aria preserving the full long
  branch, visible Git status `2 dirty`, detailed Git status metadata
  `1 modified · 0 staged · 1 untracked`, a 50 px topbar, no document overflow,
  and no heavy context pill chrome. `summary.json` recorded zero console errors
  and zero failed local requests.

Next work:

- Continue prototype fidelity by replacing the visible topbar dirty label with
  a compact diff-count affordance when line-level added/deleted counts are
  available.
- Consider moving Refresh Git behind a lower-weight overflow or review-drawer
  action once the topbar action cluster has a dedicated files/diff affordance.

### Slice: Sidebar Project Meta Restraint

Status: completed in iteration 56.

Goal: make sidebar project rows read like compact navigation entries rather
than concatenated Git diagnostics by splitting branch and dirty state into
bounded metadata chips.

User-visible value: the project browser stays close to `home.jpg`: project
names remain the primary scan target, branch context is still visible, dirty
state is compact, and long branch names do not make project rows feel like raw
debug output.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-project-meta-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Project rows expose project name, shortened branch label, and dirty count as
  separate DOM elements with accessible names and titles.
- Long branch names are shortened in the visible sidebar text while the
  topbar branch workflow remains unchanged.
- Clean repositories show a quiet branch label without a dirty badge; non-Git
  folders show `No Git`.
- Sidebar rows stay within existing compact height, typography, and horizontal
  overflow thresholds at default and compact Electron sizes.
- Existing project selection, thread selection, settings footer, composer,
  branch, review, terminal, and settings workflows remain unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project on a long branch with dirty changes,
  inspect sidebar project row metrics, then continue the existing composer,
  branch, review, settings, terminal, and follow-up send workflows.
- E2E assertions: project row metadata is structured, short, accessible,
  contains a branch label and dirty badge, does not expose the raw long branch
  in visible sidebar text, and records no console errors or failed local
  requests.
- Diagnostic artifacts: updated `sidebar-app-rail.json`, screenshots,
  Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the small structured
  metadata slice; `frontend-design` for prototype-constrained sidebar density;
  and `electron-desktop-dev` for real Electron CDP verification of renderer
  behavior.

Notes and decisions:

- This slice keeps the full branch available in the project-row title while
  shortening the visible sidebar label. The topbar remains the place for the
  richer branch workflow.
- Dirty state uses a compact `N dirty` badge in the project row; the detailed
  modified/staged/untracked counts remain in the badge title and topbar.
- Project row metadata now has stable DOM hooks so future CDP checks do not
  need to infer project/branch/dirty state from concatenated row text.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 25 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-47-14-573Z/`.
- Key recorded metrics: `sidebar-app-rail.json` recorded the active project row
  as `desktop-e2e-workspace-YmMYZZ, desktop-e2e/very-lo..., 2 dirty`, preserved
  the full long branch in the branch title, kept project metadata from
  overflowing, kept sidebar width at 244px, and recorded no sidebar region
  overflow; `summary.json` recorded zero console errors and zero failed local
  requests.

Next work:

- Continue prototype fidelity by tightening topbar context truncation: the
  long branch and dirty summary are still understandable but visually crowded
  in the topbar at default width.
- Consider adding a sidebar project overflow affordance for reveal path,
  refresh Git, and project removal without exposing full paths by default.

### Slice: Thread Title Noise Restraint

Status: completed in iteration 55.

Goal: keep sidebar thread rows and the topbar title from exposing raw long
prompts, absolute paths, local server URLs, or ACP/session identifiers by
normalizing session titles into compact product labels.

User-visible value: the first viewport stays close to `home.jpg`: thread rows
remain short and scannable, the active title does not push out project/Git
context, and internal or path-heavy prompt text stays out of the main
navigation chrome.

Expected files:

- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/components/layout/ThreadList.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/main/acp/createE2eAcpClient.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/thread-title-noise-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Sidebar thread rows render a derived display title instead of raw long prompt
  text, full absolute paths, local server URLs, or session IDs.
- Missing or ID-like session titles fall back to `Untitled thread` rather than
  exposing ACP/session identifiers.
- The topbar uses the same compact display title as the active thread and
  keeps the project label, context row, and icon actions contained.
- Existing session selection, draft-thread display, composer first-send thread
  creation, branch/review/settings/terminal workflows, and accessibility labels
  remain unchanged.
- Real Electron CDP coverage exercises a fake ACP session with a noisy title
  and records sidebar/topbar metrics with no console errors or failed requests.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, create the first thread whose fake ACP
  title contains a long prompt, absolute path, local URL, and session-like ID,
  then inspect sidebar and topbar title metrics before continuing the existing
  branch, review, settings, terminal, and composer workflows.
- E2E assertions: sidebar/topbar expose the compact derived thread title,
  preserve accessible row names, omit raw path/URL/session-noise text from
  visible navigation, keep row/topbar typography within existing thresholds,
  and record no console errors or failed local requests.
- Diagnostic artifacts: updated `sidebar-app-rail.json`,
  `topbar-context-fidelity.json`, screenshots, Electron log, and summary JSON
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for the scoped autonomous design
  choice; `frontend-design` for prototype-constrained navigation density; and
  `electron-desktop-dev` for real Electron CDP verification of renderer
  behavior.

Notes and decisions:

- This slice normalizes the display label only. It does not alter the ACP
  session title stored by the backend or introduce generated AI titles.
- Full raw prompts and internal identifiers remain diagnostics concerns, not
  first-viewport navigation text.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 24 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-40-50-335Z/`.
- Key recorded metrics: `sidebar-app-rail.json` recorded the active thread as
  `Review README.md after the failing test in local...` with no row overflow;
  `topbar-context-fidelity.json` recorded the same compact title, preserved the
  long branch in DOM text, kept topbar containment true, and recorded no
  horizontal document overflow; `summary.json` recorded zero console errors and
  zero failed local requests.

Next work:

- Continue prototype fidelity by shortening project-row meta in the sidebar;
  current row text still concatenates project name and branch metadata too
  tightly in DOM diagnostics even though it does not overflow visually.
- Consider a future generated-title path for historical sessions whose ACP
  titles are low-signal prompts rather than deterministic path/session noise.

### Slice: Composer Runtime Control Chrome

Status: completed in iteration 54.

Goal: replace the default-looking composer permission/model select chrome with
compact, icon-led runtime controls that preserve native keyboard behavior and
stay contained with long mode/model labels.

User-visible value: the bottom composer reads more like the `home.jpg` task
control center: attachment, project, branch, permission, model, stop, and send
are all compact controls in one stable row without raw provider prefixes or
native form chrome dominating the first viewport.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-runtime-control-chrome.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Permission and model selectors render inside compact composer control shells
  with leading icons, custom chevrons, stable `aria-label`, `title`, and native
  `<select>` behavior.
- Long permission/model names are shortened in the visible option text while
  preserving the full label in `title`; Coding Plan provider prefixes remain
  hidden in the composer.
- Select controls stay within compact geometry at default, compact, and
  review-open Electron viewports without horizontal overflow.
- Composer send, stop, attachment, project/branch chips, first-send thread
  creation, model switching, permission switching, terminal attach, review, and
  settings workflows remain unchanged.
- The change follows prototype-constrained `frontend-design` guidance: refine
  density and hierarchy instead of inventing a new visual direction.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, inspect the project composer before a thread exists, send the
  first prompt, switch to a configured model including a long Coding Plan model,
  inspect default/compact/review-open composer geometry, and continue the
  existing review, settings, branch, terminal, and composer workflows.
- E2E assertions: runtime controls expose icons and custom chevrons, preserve
  native selects and accessible labels, keep full titles for selected options,
  hide raw Coding Plan provider prefixes in visible composer labels, remain
  bounded in compact viewports, and record no console errors or failed local
  requests.
- Diagnostic artifacts: updated `project-composer.json`,
  `composer-model-switch.json`, `conversation-surface-fidelity.json`,
  `compact-dense-conversation.json`, `compact-review-drawer.json`, screenshots,
  Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to choose the small native-select
  wrapper approach over custom dropdowns or a larger settings rewrite;
  `frontend-design` for prototype-constrained composer density; and
  `electron-desktop-dev` for real Electron CDP verification of renderer
  behavior.

Notes and decisions:

- The chosen approach keeps native `<select>` controls rather than building a
  custom combobox. That preserves keyboard and screen-reader behavior while
  removing the visual weight of default select chrome.
- Model/provider configuration remains out of scope for this slice; this is a
  first-viewport fidelity and containment pass.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 23 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-27-40-383Z/`.
- Key recorded metrics: `project-composer.json` recorded permission/model
  runtime controls at `124 x 24` with leading icons, custom chevrons, native
  select labels, and full titles; `compact-dense-conversation.json` recorded
  both runtime controls at `106 x 24`; `compact-review-drawer.json` recorded
  both runtime controls under `100 x 25`; `summary.json` recorded zero console
  errors and zero failed local requests.

Next work:

- Continue composer fidelity by making the permission/model controls reachable
  from settings without leaving the main workbench flow.
- Add a focused searchable model picker only when the model list grows beyond
  what native select can handle comfortably.

### Slice: Composer Send/Stop Icon Density

Status: completed in iteration 53.

Goal: make the composer send and stop controls read as compact icon-led task
controls, matching the `home.jpg` control-center shape more closely without
changing send, stop, or keyboard behavior.

User-visible value: the bottom composer gives more space to project, branch,
permission, and model context while the primary send/stop affordances feel like
desktop-native tool controls instead of text-heavy form buttons.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-send-stop-icon-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Composer Stop and Send controls render as icon-led buttons with stable
  `aria-label`, `title`, icon, and screen-reader text.
- Stop remains disabled unless generation is streaming; Send remains disabled
  with an empty message or no project and still submits normally through click
  and Enter.
- Composer action controls stay within compact geometry at default, compact,
  and review-open Electron viewports without horizontal overflow.
- Existing attachment, permission mode, model picker, project/branch chips,
  new-thread indicator, retry draft, terminal attach, settings, branch, review,
  and approval workflows remain unchanged.
- No visible text button chrome or oversized button geometry is introduced in
  the first viewport.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, inspect the project-scoped composer before a thread exists,
  send the first prompt through the icon-led Send control, approve the fake
  command, inspect the populated conversation and compact viewport composer,
  attach terminal output and send a follow-up prompt through the same control.
- E2E assertions: composer action buttons expose accessible labels and
  tooltips, contain icons plus `.sr-only` text, keep bounded icon geometry, do
  not rely on visible text button width, do not overflow composer rows, and no
  console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `project-composer.json`,
  `conversation-surface-fidelity.json`, `compact-dense-conversation.json`,
  review/terminal screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for the narrow autonomous design
  choice among hiding Stop, keeping text buttons, or using icon-led controls;
  `frontend-design` for prototype-constrained composer hierarchy; and
  `electron-desktop-dev` for real Electron CDP verification of renderer
  behavior.

Notes and decisions:

- The preferred implementation keeps both controls present and accessible.
  Hiding Stop until streaming would reduce chrome, but it would shift action
  layout between idle and running states. Compact icon-led controls preserve a
  stable control row while reducing visual weight.
- No new icon dependency is needed; the local `SendIcon` and `StopIcon` match
  the existing desktop icon style.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 22 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-13-34-084Z/`.
- Key recorded metrics: `project-composer.json` recorded Stop as
  `28 x 28` and Send as `30 x 30`, both with `aria-label`, `title`, icon,
  `.sr-only` text, empty direct text nodes, and disabled idle state;
  default, compact, and compact review snapshots recorded no composer,
  composer-context, or composer-actions overflow; `summary.json` recorded zero
  console errors and zero failed local requests.

Next work:

- Continue composer fidelity by replacing the native select chrome with a
  compact, icon-led model/permission control that remains keyboard accessible.
- Add compact containment coverage for very long localized permission/model
  labels now that action buttons no longer consume text-button width.

### Slice: Compact Conversation Text Containment

Status: completed in iteration 52.

Goal: keep long user prompts and echoed assistant prose contained in compact
conversation viewports while removing the dead `.message-role` styling token
that no renderer component emits anymore.

User-visible value: long command names, generated identifiers, file-like text,
or localized prose no longer create horizontal scroll or push the compact
conversation away from the `home.jpg`-style first viewport.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/compact-conversation-text-containment.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- User and assistant message prose wraps long unbroken text inside the message
  column at default and compact desktop sizes.
- Compact CDP coverage includes a long prompt token that is echoed by the fake
  ACP response and asserts user/assistant messages do not overflow.
- No renderer component or stylesheet keeps active `.message-role` presentation
  rules; existing negative DOM assertions still guard against reintroducing
  visible role-label nodes.
- Existing assistant actions, file chips, changed-file summary, command
  approvals, ask-user prompts, review, settings, branch, terminal, and composer
  workflows remain unchanged.
- Default and compact Electron viewports keep the conversation dominant with no
  console errors, failed local requests, or horizontal document overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send the normal command-approval
  prompt, approve it, then send an ask-user-question prompt containing a long
  unbroken token and inspect the echoed assistant response and original user
  message at compact size before continuing the existing review, settings,
  branch, terminal, and composer workflows.
- E2E assertions: long prompt token is visible in both user and assistant
  messages, message paragraphs use wrap-safe styles, message rectangles remain
  inside the timeline width, no message/timeline/composer/terminal horizontal
  overflow is recorded, and no `.message-role` nodes appear in conversation
  surfaces.
- Diagnostic artifacts: updated `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, `conversation-surface-fidelity.json`,
  screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  typography and overflow handling; `electron-desktop-dev` for real Electron
  CDP verification of renderer layout.

Notes and decisions:

- This is deliberately a containment pass, not a new visual direction. The
  prototype still wins: keep prose visually quiet, avoid new cards, and make
  dense compact windows robust.
- The long-token prompt now runs through the ask-user-question branch after the
  normal command-approval path. That keeps the default conversation bubble
  density assertion focused on ordinary prompts while compact coverage still
  proves wrapped user and assistant prose.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 22 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-03-10-359Z/`.
- Key recorded metrics: `compact-dense-conversation.json` recorded
  `promptTokenInAssistant: true`, `promptTokenInUser: true`,
  `longAssistantMessageContained: true`, `userMessageContained: true`, all
  compact overflow checks `false`, `overflowWrap: anywhere` for both long
  message paragraphs, zero console errors, and zero failed local requests.

Next work:

- Add compact containment coverage for long localized labels in approval,
  settings, branch, and terminal controls.
- Consider extracting the long-message CDP assertions into a helper before
  adding more text-containment cases.

### Slice: Conversation Role Label DOM Restraint

Status: completed in iteration 51.

Goal: remove the last assistant/user role-label text nodes from the main
conversation DOM while preserving accessible message identity.

User-visible value: conversation messages read as clean prose and compact user
bubbles, matching `home.jpg` more closely, while diagnostics and text snapshots
no longer surface uppercase role chrome such as `ASSISTANT MESSAGE`.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-role-label-dom-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- User and assistant message articles expose accessible names through article
  attributes instead of visible or `sr-only` `.message-role` text nodes.
- Conversation body text, `innerText`, and compact viewport diagnostics do not
  include `Assistant message`, `ASSISTANT MESSAGE`, `User message`, or
  uppercase role-label chrome.
- Existing assistant actions, retry/copy/open-changes buttons, file reference
  chips, changed-file summary, plan/tool activity, pending approvals, review,
  settings, terminal, branch, and composer workflows remain unchanged.
- Default and compact Electron viewports keep message geometry, composer
  docking, and conversation dominance aligned with the existing CDP layout
  assertions, with no console errors or failed local requests.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, approve the command,
  inspect user and assistant messages in the default and compact conversation
  viewports, then continue the existing review/settings/terminal workflows.
- E2E assertions: message articles have accessible labels, no `.message-role`
  descendants, no role-label text in message or timeline `innerText`, compact
  geometry remains within thresholds, and no browser console errors or failed
  local requests are recorded.
- Diagnostic artifacts: updated `conversation-surface-fidelity.json`,
  `compact-dense-conversation.json`, screenshots, Electron log, and summary
  JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing between removing role
  nodes, keeping `sr-only` labels, or adding new visible labels;
  `frontend-design` for keeping the prototype-first prose hierarchy restrained;
  `electron-desktop-dev` for real Electron CDP verification of message DOM and
  geometry.

Notes and decisions:

- The preferred implementation is an `aria-label` on the message `<article>`.
  This keeps message identity available to assistive technology without adding
  extra timeline text nodes that appear in diagnostics or copy-like DOM reads.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 22 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-53-30-889Z/`.
- Key recorded metrics: default viewport assistant and user messages exposed
  `aria-label` values of `Assistant message` and `User message`,
  `hasRoleLabel` was `false` for both, compact viewport
  `messageHasRoleLabel` was `false`, and `summary.json` recorded zero console
  errors and zero failed local requests.

Next work:

- Continue conversation fidelity by removing or replacing the now-unused
  `.message-role` CSS token if no supporting surface needs it.
- Broaden compact viewport coverage for very long user prompts and assistant
  responses with localized action labels.

### Slice: Pending Prompt Card Label Restraint

Status: completed in iteration 50.

Goal: make command approval and ask-user-question cards read like compact
conversation task prompts, not debugger cards with uppercase role chrome.

User-visible value: when the agent needs permission or input, users can
understand the requested action quickly without `execute`, `question`,
`pending`, or question headers competing with the command/question content.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/main/acp/createE2eAcpClient.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/pending-prompt-card-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Command approval card title, kind, and status use title-case product
  language with no visible `.message-role` chrome.
- Ask-user-question card uses the same restrained label system for card status
  and individual question headers.
- Approval/question cards remain compact inline rails with accessible actions,
  stay inside the conversation timeline, and do not overlap the composer.
- Existing approval responses, ask-user-question responses, assistant actions,
  changed-file summary, review, settings, terminal, branch, and commit flows
  remain unchanged.
- Default and compact Electron viewports show no document overflow, console
  errors, or failed local requests.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt that triggers command
  approval, assert restrained pending approval labels, approve it, send a
  prompt that triggers an ask-user-question request, assert restrained question
  labels, submit it, then continue the existing review/settings/terminal
  workflow.
- E2E assertions: pending prompt cards have title-case labels and status text,
  no uppercase legacy labels, no `.message-role` elements, compact geometry, no
  permission strip/protocol leak, and no browser console errors or failed local
  requests.
- Diagnostic artifacts: new `inline-question-card.json`, updated
  `inline-command-approval.json`, screenshots, Electron log, and summary JSON
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for the narrow autonomous design
  choice; `frontend-design` for applying `home.jpg`-style compact hierarchy
  without inventing a new visual direction; `electron-desktop-dev` for real
  Electron CDP verification of both pending prompt paths.

Notes and decisions:

- The existing inline approval rail already matches the first-viewport
  direction better than a large modal or strip. This slice keeps that layout
  and only reduces the last visible debugger labels.
- The fake ACP client adds a deterministic ask-user-question branch keyed by
  prompt text so CDP can exercise the UI without live credentials.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 22 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-46-47-262Z/`.
- Key recorded metrics: approval card rendered `Execute`,
  `Needs approval`, `Run desktop E2E command`, and `printf desktop-e2e`;
  question card rendered `Question`, `Input needed`, `Waiting`, `Choice`, and
  `Pick the next review focus`; both cards had no `.message-role` chrome, no
  uppercase legacy labels, no protocol leaks, label weights at or below 680,
  and no console errors or failed local requests.

Next work:

- Continue conversation fidelity by making the visible user/assistant role
  treatment fully consistent in body text and screenshots; `ASSISTANT MESSAGE`
  still appears in raw `innerText` diagnostics even though the label is
  screen-reader-only in the rendered UI.
- Consider visual coverage for multi-question ask-user prompts and long
  option labels at compact viewport widths.

### Slice: Changed Files Summary Inline Fidelity

Status: completed in iteration 49.

Goal: make the conversation changed-files summary read like a compact inline
result primitive from `home.jpg`, instead of a framed review card competing
with assistant prose and the composer.

User-visible value: users can see that files changed, scan the affected files,
and open review from the conversation without the summary becoming a large
dashboard panel.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/changed-files-summary-inline-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Changed-files summary uses a slim inline activity row with a subtle left
  accent, no full box border, and lower surface weight than the prior card.
- Summary label and file states use title-case product text instead of
  uppercase section/status chrome.
- File rows stay chip-sized, horizontally wrapped, and do not look like nested
  cards.
- Review action remains obvious, accessible, and icon-led/compact while opening
  the existing review drawer only when clicked.
- Existing hidden-internal-ID behavior, assistant actions, command approval,
  review safety, settings, terminal, branch, composer, and commit workflows
  remain unchanged.
- Default and compact Electron viewports keep the summary inside the
  conversation timeline, above the composer, with no document overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, approve the command,
  inspect the inline changed-files summary before review opens, click the
  compact review action, continue the review/settings/terminal/commit smoke,
  and verify the compact viewport layout.
- E2E assertions: changed-files summary is unboxed, title-case, compact,
  left-accented, and contained; the review action is accessible and compact;
  uppercase legacy summary labels/statuses are absent; no console errors or
  failed local requests are recorded.
- Diagnostic artifacts: updated `conversation-changes-summary.json`,
  `conversation-surface-fidelity.json`, `compact-dense-conversation.json`,
  screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for comparing compact-card,
  inline-rail, and list-only approaches without user interruption;
  `frontend-design` for applying the prototype-constrained hierarchy and
  reducing card weight; `electron-desktop-dev` for renderer changes verified
  through real Electron CDP interaction.

Notes and decisions:

- `home.jpg` shows changed files as a modest inline result with readable file
  rows and a compact review affordance. The chosen approach keeps the current
  functionality but shifts presentation to an inline rail so review remains a
  supporting surface.
- No new dependency is needed. The existing local `DiffIcon` supports an
  icon-led review affordance.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 21 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-37-32-960Z/`.
- Key recorded metrics: changed-files summary rendered as `Changed files`,
  `2 files changed`, `Modified · Unstaged`, and `Untracked`; uppercase legacy
  summary text was absent; summary geometry was 820 x 61 px with transparent
  background, no top/right/bottom border, a 2 px left accent, and 0 px radius;
  the review action was icon-led, 75.69 x 24 px, and retained `Review Changes`
  as its accessible label; no console errors or failed local requests were
  recorded.

Next work:

- Continue prototype fidelity by tightening command approval/question card
  labels, where `message-role` still creates uppercase tool/question chrome.
- Consider broader changed-files visual coverage for renamed/binary files and
  very long localized status labels.

### Slice: Plan and Tool Activity Label Restraint

Status: completed in iteration 48.

Goal: reduce the remaining uppercase plan/tool activity chrome so timeline
progress reads like compact task context instead of debugger metadata.

User-visible value: users can scan assistant prose, plan steps, and completed
tool activity in one conversation flow without `PLAN`, `INPUT`, `RESULT`, and
raw status labels visually competing with the main response.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/plan-tool-label-restraint.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Plan activity renders with a compact title-case header and subdued step
  statuses instead of a standalone uppercase `PLAN` role label.
- Tool activity keeps title, kind, status, input, output, and file references
  visible, but kind/section/status labels are title-case, lower weight, and
  visually secondary to the tool title.
- Existing hidden-internal-ID behavior, assistant actions, file chips, changed
  files summary, command approval, composer, review, settings, and terminal
  workflows remain unchanged.
- Default and compact Electron viewports keep plan/tool rows contained, with
  no document overflow and no console errors or failed local requests.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, inspect plan and resolved
  tool activity label text/style, approve the command, complete the existing
  assistant/review/settings/terminal path, and assert compact viewport layout.
- E2E assertions: plan and tool activity labels use title-case product
  language, uppercase legacy labels are absent, metadata label weight/color are
  subordinate to titles/prose, activity rows stay compact and in timeline, and
  no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `conversation-surface-fidelity.json`,
  `resolved-tool-activity.json`, screenshots, Electron log, and summary JSON
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for the narrow autonomous design
  choice, `frontend-design` for prototype-constrained label hierarchy, and
  `electron-desktop-dev` for renderer changes verified through real Electron
  CDP interaction.

Notes and decisions:

- The `home.jpg` prototype uses progress/task context inline with the
  conversation, but not as loud uppercase debugger sections. This slice keeps
  the existing timeline primitives and only changes presentation/formatting.
- No new icon dependency is needed; this is a typography and hierarchy pass.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 21 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-28-25-933Z/`.
- Key recorded metrics: plan labels render as `Plan`, `2 tasks`,
  `Completed`, and `In progress` with no uppercase legacy plan labels; plan
  label/status weights are 650 with `text-transform: none`; resolved tool
  labels render as `Execute`, `Completed`, `Input`, and `Result` with no
  uppercase legacy tool labels; tool metadata label weights are at most 680;
  plan height is 69.27 px, resolved tool activity height is 113.7 px, and no
  console errors or failed local requests were recorded.

Next work:

- Continue conversation fidelity by reducing the remaining changed-files
  summary card weight if it still reads heavier than the inline summary in
  `home.jpg`.
- Consider compact/live ACP coverage for unexpected tool status strings and
  localized plan labels.

### Slice: Terminal Expanded Control Density

Status: completed in iteration 47.

Goal: tighten the expanded terminal drawer controls so the drawer remains a
supporting command surface instead of reading like a large form panel.

User-visible value: users can expand the terminal, run a command, send stdin,
copy/attach/clear/kill output, and collapse again with less visual weight
competing with the conversation and composer.

Expected files:

- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/terminal-expanded-control-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Expanded terminal Run and Send Input controls are compact icon-led buttons
  with stable accessible labels and tooltips.
- Copy, attach, clear, and kill actions stay icon-only, accessible, and grouped
  with the command row instead of consuming a separate blank toolbar row.
- Command and stdin rows stay contained with long command text at the default
  Electron viewport, with no document overflow.
- Terminal attach/copy/run/stdin/collapse behavior remains unchanged.
- The conversation remains taller than the expanded terminal drawer.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, complete the existing fake approval and
  review/settings paths, expand the terminal, inspect compact terminal control
  geometry, run a deterministic command, send stdin to a running command,
  attach terminal output to the composer, and collapse the terminal.
- E2E assertions: expanded terminal remains supporting, Run and Send Input are
  icon-led buttons with contained geometry and accessible labels, the terminal
  action group is not a standalone row, command/stdin controls do not overflow,
  attachment does not create an approval request, and no console errors or
  failed local requests are recorded.
- Diagnostic artifacts: updated `terminal-expanded-layout.json`,
  `terminal-long-command-layout.json`, `terminal-expanded.png`,
  `terminal-attachment.json`, `completed-layout.json`, screenshots, Electron
  log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting a small fidelity slice
  without user interruption, `frontend-design` for prototype-constrained
  terminal density and icon-first controls, and `electron-desktop-dev` for
  renderer changes verified through real Electron CDP interaction.

Notes and decisions:

- The prototype treats terminal/local controls as supporting chrome below the
  composer. This slice preserves the existing drawer behavior but removes the
  extra expanded toolbar row and text-heavy terminal form buttons.
- The existing local `TerminalIcon` and `SendIcon` are sufficient; no new icon
  dependency is needed.
- The expanded drawer keeps the same overall height but gives more of that
  height to terminal output by removing the separate action row.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-18-56-808Z/`.
- Key recorded metrics: expanded terminal remained 238 px tall while the
  conversation remained 500 px tall; command and stdin rows stayed inside the
  960 px terminal body; Run and Send Input controls were 32 x 32 px with
  accessible labels, tooltips, icons, and screen-reader text; the terminal
  action group was inside the command row; a 111-character command stayed
  contained without row overflow; no console errors or failed local requests
  were recorded.

Next work:

- Continue message-system polish by reducing `PLAN` and tool activity label
  weight if screenshot review shows they still compete with assistant prose.
- Consider compact-viewport coverage for expanded terminal controls if future
  work changes terminal height or drawer behavior.

### Slice: Terminal Strip Fidelity

Status: completed in iteration 46.

Goal: tighten the collapsed terminal so it reads as a slim supporting local
status row like the `home.jpg` prototype instead of a competing boxed bottom
panel.

User-visible value: users keep more attention on the conversation and composer
while still having an obvious terminal affordance with project, status, and
last-command context.

Expected files:

- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/terminal-strip-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The collapsed terminal strip is a one-line, icon-led status control with
  accessible expand/collapse labels and no visible uppercase section label
  competing with the composer.
- The collapsed strip height is reduced and remains docked below the workspace
  grid at default and compact Electron viewports without body overflow.
- The strip shows project context, terminal status, and last output/command
  preview without overflowing long project, branch, command, or output text.
- The expanded terminal remains a supporting drawer, keeps icon-only actions,
  and does not push the conversation below half the viewport.
- Terminal attach/copy/run/stdin behavior remains unchanged.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, verify the initial collapsed terminal geometry, send a prompt,
  re-check compact conversation geometry with terminal collapsed, expand the
  terminal, run a deterministic command, attach output to composer, collapse
  the terminal again, and verify no console errors or failed local requests.
- E2E assertions: collapsed strip height is slim, icon/status/preview remain
  horizontally contained, the conversation remains dominant, expanded height
  stays supporting, and terminal output attachment does not create an approval
  request.
- Diagnostic artifacts: updated `initial-layout.json`,
  `compact-dense-conversation.json`, `terminal-expanded-layout.json`,
  `terminal-attachment.json`, `completed-layout.json`, screenshots, Electron
  log, and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the smallest next
  fidelity slice without user interruption, `frontend-design` for
  prototype-constrained density and hierarchy, and `electron-desktop-dev` for
  real Electron CDP verification.

Notes and decisions:

- The prototype shows local mode and branch as low, slim context controls below
  the composer; this slice keeps Qwen's terminal affordance in that supporting
  position but removes the heavier boxed label treatment.
- No new icon dependency is needed; the existing local terminal/chevron icons
  are sufficient.
- Long project names and terminal previews may be ellipsized, but the CDP
  harness now asserts their visible boxes stay contained inside the strip.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-08-19-344Z/`.
- Key recorded metrics: default terminal strip 42 px high with a 32 px toggle,
  compact terminal strip 42 px high with a 32 px toggle, no visible terminal
  section label, collapsed strip docked below the workspace grid, expanded
  terminal 238 px high while conversation remains 500 px high, and no console
  errors or failed local requests.

Next work:

- Continue terminal fidelity by making the expanded drawer command/input rows
  denser and more icon-led if screenshot review still shows too much utility
  chrome.
- Continue message-system polish by reducing `PLAN` and tool activity label
  weight if screenshot review shows they still compete with assistant prose.

### Slice: Assistant Message Chrome Reduction

Status: completed in iteration 45.

Goal: make assistant responses read as unframed conversation prose instead of
generic chat cards with repeated visible role labels and boxed action chrome.

User-visible value: users can scan the task timeline more like the `home.jpg`
prototype, with assistant text as the main content and copy/retry/review
controls present but visually secondary.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/assistant-message-chrome.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Assistant messages keep an accessible role label but do not show a visible
  uppercase `ASSISTANT` label in the main timeline.
- Assistant copy, retry, and open-changes actions remain icon-only, accessible,
  keyboard-focusable, and compact while losing the default boxed idle chrome.
- User prompt bubbles, plan rows, tool cards, command approval cards, file
  chips, changed-files summary, composer, review drawer, settings overlay, and
  terminal workflows continue to behave as before.
- Default and compact Electron viewports keep the conversation dominant with no
  horizontal overflow, hidden internal IDs, server URLs, or secrets.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, approve the fake command,
  inspect the assistant response, action row, file chips, and changed-files
  summary at the default viewport, then repeat compact conversation geometry
  checks before continuing the existing branch, review, settings, and terminal
  paths.
- E2E assertions: assistant role label is screen-reader-only, action buttons
  have accessible labels and icon geometry while idle backgrounds/borders are
  nearly invisible, conversation prose remains unframed, compact layout stays
  contained, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: updated `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting a narrow fidelity
  slice under the autonomous loop constraints, `frontend-design` for
  prototype-constrained hierarchy and action-control restraint, and
  `electron-desktop-dev` for renderer changes verified through real Electron
  CDP interaction.

Notes and decisions:

- The prototype prioritizes assistant prose and subtle inline actions, so this
  slice hides only the repeated assistant role label. Tool, plan, approval, and
  diagnostic labels remain visible where they identify a distinct activity
  primitive.
- The existing local icon set is reused; no new icon dependency is needed for
  this visual refinement.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-55-54-656Z/`.
- Key recorded metrics: assistant role text `Assistant message` remains present
  for assistive technology but is positioned offscreen at 1x1 px in default
  and compact viewports; assistant action buttons remain 24x24 px with idle
  background alpha 0 and border alpha 0; compact assistant message height
  dropped to 180.17 px; no horizontal overflow, console errors, or failed local
  requests were recorded.

Next work:

- Continue prototype fidelity by tightening the collapsed terminal strip height
  and weight so it reads as a supporting status row rather than a competing
  bottom panel.
- Continue message-system polish by reducing `PLAN` and tool activity label
  weight if screenshot review shows they still compete with assistant prose.

### Slice: Compact Settings Overlay Fidelity

Status: completed in iteration 44.

Goal: tighten the Settings overlay so it behaves like a compact supporting
surface at both default and compact Electron viewports.

User-visible value: users can open Settings without losing the conversation,
get an icon-led close affordance consistent with the rest of the workbench, and
use the sheet at compact desktop sizes without page overflow or hidden primary
controls.

Expected files:

- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-compact-overlay.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings header uses a compact icon close button with `aria-label`,
  tooltip/title, and keyboard focus when the modal sheet opens.
- The overlay backdrop remains pointer-clickable but does not become a hidden
  keyboard stop before the settings sheet.
- At the default CDP viewport, Settings still opens as a right-aligned modal
  drawer while chat and the terminal strip remain mounted and review is closed.
- At the compact `960x640` CDP viewport, the settings sheet stays contained
  inside the workbench, keeps a visible task-context backdrop, avoids
  document/body overflow, and leaves model/provider and permissions controls
  reachable in the scrollable sheet.
- Default Settings still hides server URLs, Node versions, ACP/session IDs,
  settings paths, API keys, and other diagnostics until Advanced Diagnostics is
  opened.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the existing open-project/chat/review/commit path,
  open Settings, verify default overlay geometry and focus, resize the real
  Electron window to `960x640`, verify compact sheet geometry and overflow,
  restore the default viewport, then continue the existing settings validation,
  Coding Plan, Advanced Diagnostics, composer model, and terminal paths.
- E2E assertions: close control is icon-sized, focused, and accessible;
  backdrop is not keyboard focusable; compact overlay remains right-aligned,
  bounded, scrollable internally, and context-preserving; diagnostics and fake
  secrets stay hidden by default; and no console errors or failed local
  requests are recorded.
- Diagnostic artifacts: `settings-layout.json`,
  `compact-settings-overlay.json`, `settings-page.png`,
  `compact-settings-overlay.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the smallest uncovered
  settings risk, `frontend-design` for prototype-constrained icon density and
  hierarchy, and `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- The prototype favors icon-led support surfaces; this slice changes the close
  affordance from a text button to a compact icon while preserving the same
  accessible label.
- The settings sheet remains a modal overlay rather than a main workbench tab.
- The backdrop remains click-to-close for pointer users, but is removed from
  the keyboard tab order so focus lands directly inside the modal sheet.
- The sheet width was reduced from 780 px to 680 px at the default viewport to
  preserve more visible task context behind Settings while keeping the model
  form wider than the 250 px minimum.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
  passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-45-34-724Z/`.
- Key recorded metrics: default viewport 1240x788, settings sheet 680x738 px,
  backdrop 316 px, focused close icon 28x28 px, backdrop `tabindex="-1"` and
  `aria-hidden="true"`, no body/document overflow, compact viewport 960x608,
  compact sheet 620x558 px, compact backdrop 108 px, compact settings content
  scrollHeight 1193 px with permissions reachable at scrollTop 453.5, hidden
  diagnostics absent by default, and no console errors or failed local
  requests.

Next work:

- Continue Settings fidelity by reducing large form-control heights and card
  borders inside the sheet if screenshot review shows the overlay still reads
  heavier than `home.jpg`.
- Add keyboard escape/return-focus coverage for Settings once modal focus
  management is expanded beyond the initial close-button focus.

### Slice: Settings Overlay Surface

Status: completed in iteration 43.

Goal: make Settings a supporting overlay surface instead of replacing the
conversation-first workbench.

User-visible value: users can open account/model/permission settings from the
sidebar or topbar without losing their task context, while Advanced diagnostics
remain explicitly hidden until requested.

Expected files:

- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-overlay-surface.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Opening Settings keeps the conversation and terminal workbench surfaces
  mounted behind a modal right-side settings sheet.
- Settings closes from the sheet or the Conversation action without leaving the
  review drawer open behind it.
- The settings sheet remains bounded, scrollable, and right-aligned at the
  default CDP viewport without body overflow.
- Model provider, Coding Plan, permissions, and Advanced Diagnostics workflows
  keep their current accessible labels and secret-handling behavior.
- The default settings view still does not expose server URLs, Node versions,
  ACP/session IDs, settings paths, or API keys.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the existing open-project/chat/review/commit path,
  open Settings, verify the overlay geometry and hidden diagnostics, exercise
  API-key and Coding Plan save paths, open Advanced Diagnostics, close back to
  Conversation, and continue with composer/terminal checks.
- E2E assertions: chat and terminal remain mounted while Settings is open,
  review is closed, settings renders inside a right-side overlay, body does not
  overflow, secrets and diagnostics stay hidden until requested, model provider
  workflows persist, and no console errors or failed local requests are
  recorded.
- Diagnostic artifacts: updated `settings-layout.json`,
  `settings-page.png`, Coding Plan/settings diagnostics snapshots, Electron
  log, and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting a narrow settings
  surface slice, `frontend-design` for prototype-constrained overlay density
  and hierarchy, and `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- The prototype favors conversation-first continuity, so Settings will become a
  sheet over the workbench instead of a third main workbench view.
- Settings remains modal for focus and safety; review closes when the sheet
  opens to avoid stacking two supporting surfaces over the conversation.
- Keeping chat mounted exposed an ambiguous CDP label selector for the settings
  model field. The harness now targets settings-specific accessible labels such
  as `Provider model`, `Provider base URL`, and `Provider API key`.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-37-58-777Z/`.
- Key recorded metrics: default CDP viewport 1240x788, settings overlay
  996x738 px, right-aligned settings sheet 780x738 px, backdrop 216 px,
  chat and terminal mounted, review absent, no body overflow, dialog role and
  modal state present, hidden diagnostics absent by default, and no console
  errors or failed local requests.

Next work:

- Add compact-viewport settings overlay geometry assertions and consider focus
  management for keyboard-only settings navigation.
- Continue prototype fidelity by tightening Settings visual density further:
  icon-led close/action controls, smaller section headers, and reduced card
  borders inside the sheet.

### Completed Slice: Composer Attachment Affordance

Status: completed in iteration 42.

Goal: replace the disabled visible `+` placeholder in the composer with a
prototype-aligned icon affordance that is honest about attachment support.

User-visible value: the first viewport keeps the compact Codex-like composer
shape from `home.jpg` while avoiding a placeholder-looking text control. Users
can identify the attachment entry point and get a clear unavailable-state
tooltip without leaving the workbench.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-attachment-affordance.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The composer attachment control uses a real icon instead of visible `+`
  placeholder text.
- The control remains compact, keyboard-focusable, and explicitly unavailable
  with `aria-disabled` and tooltip/help text until attachment workflow scope is
  implemented.
- The control does not submit the composer, open a fake picker, expose debug
  state, or create first-viewport overflow at default or compact CDP sizes.
- Existing model, permission, project, branch, send, and stop controls keep
  their current behavior.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, assert the composer is ready before any
  selected thread, inspect the attachment control semantics and geometry, then
  continue the existing chat/review/settings/terminal path.
- E2E assertions: attachment control has accessible label, `aria-disabled`
  unavailable state, tooltip text, icon-sized geometry, no visible `+`
  placeholder, composer containment, no overflow, and no console errors or
  failed local requests.
- Diagnostic artifacts: updated `project-composer.json`, screenshots, Electron
  log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for the scoped design choice,
  `frontend-design` for prototype-constrained compact affordance design, and
  `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- Attachments remain intentionally unsupported in this slice. The control now
  presents a real attachment icon and an explicit unavailable state instead of
  implying that a visible `+` placeholder is wired to a file picker.
- The control uses `aria-disabled="true"` rather than the native disabled
  attribute so keyboard/CDP focus can verify the tooltip/help contract while
  still preventing form submission or fake picker behavior.
- The icon uses the existing local sidebar icon pattern instead of introducing
  a new icon dependency for one composer affordance.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-27-14-177Z/`.
- Key recorded metrics: attachment label `Attach files`, `aria-disabled="true"`,
  native disabled `false`, focused `true`, icon present, text empty, title
  `Attachments are not available yet`, help text present, 24x24 px geometry,
  composer 820x88.09 px, no composer/control/action overflow, and no console
  errors or failed local requests.

Next work:

- Continue prototype fidelity by checking whether Settings should open as a
  lighter overlay/drawer while preserving the current two-click model/API-key
  and permissions path.
- Continue composer workflow by selecting the first real attachment scope:
  file picker, drag-and-drop, paste image, or `@file` insertion.

### Completed Slice: Compact Composer Model Labels

Status: completed in iteration 41.

Goal: make the composer model picker stay compact when Coding Plan or other
providers return long, prefixed model display names.

User-visible value: users can switch between configured API-key models and
Coding Plan models from the bottom composer without raw provider prefixes
crowding the control or making the first viewport feel like a settings/debug
surface.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.test.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/composer-model-labels.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Composer model options keep their exact `value` model IDs while displaying a
  short label suitable for the compact composer control.
- Coding Plan labels like `[ModelStudio Coding Plan for Global/Intl]
qwen3-coder-next` render as the model name without the provider prefix.
- Full model names remain available as native `title` text and no API keys,
  server URLs, internal IDs, or new debug state appear in the conversation.
- The real Electron CDP path switches to a long Coding Plan model option, then
  back to the configured API-key model, with no composer overflow.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  and
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the carried open-project/chat/review/settings path,
  save Coding Plan settings, return to the composer, assert Coding Plan model
  option labels are compact, switch to `qwen3-coder-next`, assert containment,
  and switch back to `qwen-e2e-cdp`.
- E2E assertions: composer model select is enabled, model IDs are preserved,
  no option text includes the raw `ModelStudio Coding Plan` prefix, long model
  switching updates the selected value, the composer remains contained in the
  chat panel, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `composer-model-switch.json`, updated screenshots,
  Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting this narrow fidelity
  gap, `frontend-design` for prototype-constrained compact control labeling,
  and `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- The composer now strips verbose Coding Plan provider prefixes from visible
  model option labels while preserving the exact model IDs used by the runtime.
- The native select and option `title` values keep the full model label when
  richer metadata is available, so compact display does not erase provider
  context.
- The first CDP run exposed a metadata regression after switching to a Coding
  Plan model: the runtime confirmation could return only `name: modelId`.
  `modelStore` now preserves richer metadata already known to the renderer when
  applying a saved model response.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts`
  passed with 6 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-21-12-541Z/`.
- Key recorded metrics: composer model picker enabled; selected configured
  model `qwen-e2e-cdp`; Coding Plan option labels omit `ModelStudio Coding
Plan`; long model `qwen3-coder-next` selected with compact visible text and
  full title `[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next`;
  restored value `qwen-e2e-cdp`; no composer overflow, visible secret, local
  server URL, console errors, or failed local requests.

Next work:

- Continue prototype fidelity by checking whether Settings should open as a
  lighter overlay/drawer while keeping the current two-click model/API-key and
  permissions path.
- Continue composer polish by replacing the disabled attachment `+` placeholder
  with an icon-led affordance and explicit disabled tooltip once attachment
  workflow scope is selected.

### Completed Slice: Settings Coding Plan Provider Path

Status: completed in iteration 40.

Goal: strengthen the model configuration workflow by making the settings
provider controls keyboard/focus friendly and verifying the Coding Plan provider
path end to end.

User-visible value: users can switch from an OpenAI-compatible API-key model
configuration to Coding Plan from the desktop settings page, see clear
validation, save the provider without leaking secrets, and still return to the
composer with configured models available.

Expected files:

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/settingsStore.test.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-coding-plan-provider.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings provider, Coding Plan region, model, base URL, and API-key fields
  expose stable accessible labels for keyboard and CDP-driven interaction.
- Switching the provider to Coding Plan replaces API-key model/base-url inputs
  with a region selector and Coding Plan-specific validation.
- Saving Coding Plan settings with a fake key and global region succeeds in the
  real Electron app, clears the secret field, shows Coding Plan as configured,
  and does not expose fake API keys in visible text, diagnostics, composer, or
  screenshots.
- The previously saved API-key model remains available in the composer model
  picker after the Coding Plan save, preserving the normal switch-model path.
- Settings still keep runtime/server/ACP diagnostics hidden until Advanced
  Diagnostics is opened, and no first-viewport conversation/review/terminal
  layout regressions are introduced.

Verification:

- Unit/component test commands:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts`
  and
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the existing open-project/chat/review/API-key settings
  path, focus the model provider field, switch to Coding Plan, assert
  Coding Plan validation, select the global region, enter a fake Coding Plan
  key, save, verify the saved provider state, open Advanced Diagnostics, return
  to conversation, and switch the composer model to the previously configured
  API-key model.
- E2E assertions: provider controls have accessible labels and focus state,
  Coding Plan validation is specific and contained, saved state reports
  Coding Plan/global/configured without secret exposure, Advanced Diagnostics
  does not leak fake keys, composer model switching remains enabled, and no
  console errors or failed local requests are recorded.
- Diagnostic artifacts: `settings-coding-plan-provider.json`,
  `settings-coding-plan-state.png`, updated diagnostics/model-switch JSON,
  screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` to choose the smallest model
  workflow gap, `frontend-design` for prototype-constrained settings density
  and accessible control labeling, and `electron-desktop-dev` for renderer
  changes verified in real Electron through CDP.

Notes and decisions:

- The form remains compact and prototype-aligned; this slice adds accessible
  field contracts and coverage instead of changing settings into a heavier
  dashboard.
- The provider selector keeps native select behavior so keyboard navigation and
  screen-reader labeling are handled by the platform. Stable `aria-label`
  attributes and focused CDP assertions make the provider path less brittle.
- Coding Plan saves preserve non-Coding-Plan provider entries from the existing
  settings service, so the previously configured API-key model can still be
  selected from the composer after switching the active provider to Coding Plan.
- The CDP harness now treats both fake API-key and fake Coding Plan secrets as
  sensitive in settings diagnostics and composer model-switch assertions.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts`
  passed with 8 tests.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 20 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-10-44-501Z/`.
- Key recorded metrics: provider focus active label `Model provider`; Coding
  Plan validation text `Enter a Coding Plan API key to save this provider.`;
  provider value `coding-plan`; saved region `global`; Coding Plan key
  status `Configured`; saved API-key input length `0`; no visible secret,
  document overflow, console errors, or failed local requests; composer model
  picker remained enabled and switched to `qwen-e2e-cdp` with the Global Coding
  Plan model list also available.

Next work:

- Continue settings/model polish by reducing long Coding Plan model option text
  in compact composer selectors if screenshot review shows crowding.
- Continue prototype fidelity by checking whether settings should become a
  lighter overlay instead of a full workbench replacement, while preserving the
  current two-click model/API-key/permissions path.

### Completed Slice: Conversation Header Chrome Reduction

Status: completed in iteration 39.

Goal: remove the redundant visible `Conversation` panel header from the main
canvas so the timeline begins directly under the slim topbar, matching the
conversation-first first viewport in `home.jpg`.

User-visible value: users get more useful agent context above the composer and
less debug-style chrome. Current thread, project, branch, model, permission, and
runtime state remain visible in the topbar and composer instead of being
repeated as a secondary panel title.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-header-chrome.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The main conversation no longer renders a visible `.chat-header` or duplicate
  `Conversation`/connection row under the topbar.
- A screen-reader-only live status remains for streaming/connection changes.
- The timeline starts within a small padding distance of the chat panel top in
  default and compact Electron viewports.
- Composer, changed-files summary, assistant actions, review drawer, settings,
  branch, terminal, and commit workflows continue to pass.
- No ACP/session/internal IDs, server URLs, secrets, or new debug state are
  introduced into the main workbench.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, assert the pre-thread composer and
  headerless chat canvas, send a prompt, approve the fake command, assert the
  default and compact conversation geometry, then continue the existing branch,
  review, settings, terminal, discard safety, and commit workflows.
- E2E assertions: `.chat-header` is absent, the screen-reader status exists,
  timeline top is close to chat top, compact viewport preserves containment and
  no overflow, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `conversation-surface-fidelity.json`,
  `compact-dense-conversation.json`, screenshots, Electron log, and summary JSON
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing this narrow fidelity
  slice without interrupting the autonomous loop, `frontend-design` for
  prototype-constrained hierarchy and density, and `electron-desktop-dev` for
  real Electron CDP verification of renderer changes.

Notes and decisions:

- The visible `Conversation`/connection panel row was removed instead of merely
  shrinking it. Topbar and composer controls already carry the current thread,
  project, branch, model, permission, and runtime state.
- A screen-reader-only live region remains in the chat panel so streaming and
  connection state changes are still announced without spending first-viewport
  space on duplicate chrome.
- The CDP harness now guards the pre-thread project composer, default
  conversation, and compact conversation against reintroducing `.chat-header`.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 18 tests after correcting the new assertion to avoid pinning the
  fixture-specific `idle` connection state.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-00-29-581Z/`.
- Key recorded metrics: `.chat-header` absent in project, default, and compact
  conversation paths; accessible chat status text recorded as
  `Conversation idle` before thread creation and `Conversation connected` after
  the fake ACP session connects; default timeline top `50` equals chat top
  `50`; compact timeline top `50` equals compact chat top `50`; default
  timeline height increased to `585.90625` px while composer stayed
  `820x88.09375`; compact timeline height increased to `405.90625` px while
  composer stayed `704x88.09375`; no document/body overflow, no console errors,
  and no failed local requests.

Next work:

- Continue prototype fidelity with a focused pass on remaining assistant action
  button and changed-file summary border weight only if screenshot review shows
  crowding.
- Continue settings/model polish by adding keyboard-focused coverage for the
  provider selector and Coding Plan path.

### Completed Slice: Sidebar and Composer Control Density

Status: completed in iteration 38.

Goal: reduce the remaining oversized supporting controls in the sidebar and
bottom composer so the first viewport reads closer to the compact workbench in
`home.jpg`, with the conversation remaining visually dominant.

User-visible value: users see a quieter navigation rail and a less bulky task
composer. Project/thread rows, model/permission controls, and send/stop actions
remain readable and accessible without making the UI feel like a dashboard.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-composer-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Sidebar app actions, project rows, thread rows, and footer settings use a
  tighter type scale and row height while preserving accessible labels,
  tooltips, active state, relative age, and no horizontal overflow.
- The default composer is narrower, shorter, and uses compact chips, selects,
  attach, Stop, and Send controls without hiding project, branch, permission,
  model, or new-thread context.
- The compact `960x640` viewport keeps sidebar rows and composer controls
  contained with no shell, topbar, timeline, composer, context, or action
  overflow.
- The review-open compact path keeps the composer bounded and does not crush the
  conversation.
- No behavior changes, raw ACP/session IDs, full paths, server URLs, or secrets
  are introduced into the main workbench.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, assert project-scoped composer
  density before a thread exists, send a prompt, approve the fake command, assert
  conversation/composer/sidebar density at default and compact viewports, then
  continue the existing branch, review, settings, terminal, discard safety, and
  commit workflows.
- E2E assertions: default sidebar width stays under the prior 252 px baseline,
  sidebar row/action text stays under the prior 12 px visual scale, default
  composer width and height stay under prior baselines, composer controls stay
  below 26 px, compact viewport has no relevant overflow, and no console errors
  or failed local requests are recorded.
- Diagnostic artifacts: `project-composer.json`, `sidebar-app-rail.json`,
  `conversation-surface-fidelity.json`, `compact-dense-conversation.json`,
  `compact-review-drawer.json`, screenshots, Electron log, and summary JSON
  under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting the smallest fidelity
  slice without interrupting the autonomous loop, `frontend-design` for
  prototype-constrained density and hierarchy, and `electron-desktop-dev` for
  renderer changes verified in real Electron through CDP.

Notes and decisions:

- The prototype wins over inventing a new style. This slice only changes
  density, width, and CSS hierarchy; it does not alter thread creation, model
  switching, settings, review, branch, or terminal behavior.
- The composer remains a two-row task control center, but its frame and controls
  are scaled down so it no longer dominates the lower third of the workbench.
- The first CDP run failed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-51-45-127Z/`
  because the long-branch pre-thread composer still wrapped the model selector
  onto a second control row. The CSS now constrains default composer chip/select
  widths and keeps default composer controls on one row while allowing the
  review-open compact layout to wrap when necessary.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed before and
  after the composer wrap correction.
- `git diff --check` passed before and after the composer wrap correction.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 18 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed before and after the composer
  wrap correction.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-52-52-008Z/`.
- Key recorded metrics: default sidebar `244` px wide, compact sidebar `232`
  px wide, sidebar app/footer rows `26` px tall, project/thread rows `30` px
  tall, sidebar title text `11.5` px, sidebar metadata `9.2` px, pre-thread
  composer `820x88.09`, compact conversation composer `704x88.09`, compact
  review composer `404x112`, composer chips/selects `24` px tall, Stop/Send
  `26` px tall, no relevant overflow, no console errors, and no failed local
  requests.

Next work:

- Continue settings/model polish by adding keyboard-focused coverage for the
  provider selector and Coding Plan path.

### Completed Slice: Assistant Control Density Pass

Status: completed in iteration 37.

Goal: reduce the remaining visual weight of assistant file-reference chips,
assistant message action buttons, and the inline changed-files summary so the
first viewport stays closer to the compact conversation tooling shown in
`home.jpg`.

User-visible value: users can scan assistant prose, file references, changed
files, and the composer with less toolbar/card noise. The controls remain
clickable and accessible, but no longer read like large dashboard buttons.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/assistant-control-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Assistant file-reference chips are shorter, narrower, and use a smaller
  workbench type scale while preserving labels, overflow count, and click
  targets.
- Assistant message action buttons are compact icon controls with accessible
  labels and do not add a tall row under each assistant message.
- The inline changed-files summary uses a tighter title, diff stat, file chip,
  and Review Changes action treatment without looking like nested cards.
- The compact `960x640` viewport keeps assistant chips/actions and the
  changed-files summary contained without horizontal overflow.
- No behavior changes, raw ACP/session IDs, server URLs, or secrets are
  introduced into the main conversation.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the command,
  wait for assistant prose/file chips/actions and the changed-files summary,
  assert default and compact viewport geometry, then continue the existing
  branch, review, settings, terminal, discard safety, and commit workflows.
- E2E assertions: assistant action row/button heights stay below the previous
  28 px button baseline, file-reference chips stay below the previous 24 px
  height and use narrower max widths, changed-file summary action/row heights
  stay below previous baselines, the compact viewport has no element overflow,
  and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `assistant-message-actions.json`,
  `assistant-message-actions.png`, `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the smallest fidelity
  slice without asking routine product questions, `frontend-design` for
  prototype-constrained density and hierarchy, and `electron-desktop-dev` for
  real Electron CDP verification of renderer changes.

Notes and decisions:

- The prototype remains the visual contract. This slice intentionally avoids
  changing message parsing, file-opening behavior, retry/copy behavior, or the
  review flow.
- The controls stay text-readable where file names matter, but their scale is
  lowered to match the supporting-surface role of chips and icon actions.
- The first CDP run failed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-05-929Z/`
  because the new changed-files row font assertion measured the inherited
  `<li>` style instead of the rendered row label. The harness now records both
  row container and label styles, and asserts the visible label.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed before and
  after the harness assertion correction.
- `git diff --check` passed before and after the harness assertion correction.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 18 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T16-41-41-762Z/`.
- Key recorded metrics: assistant file chips `20` px tall with max width
  `220` px, assistant action buttons `24x24`, action row `24` px tall,
  changed-files summary `67` px tall, Review Changes action `24` px tall,
  changed-file row `21` px tall with `10.8` px label text, compact viewport
  file chips `20` px tall, compact assistant actions `24x24`, no document/body
  overflow, no console errors, and no failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining oversized sidebar and
  composer typography where it still visually outweighs the conversation in
  screenshots.
- Continue settings/model polish by adding keyboard-focused coverage for the
  provider selector and Coding Plan path.

### Completed Slice: Settings Model Validation Feedback

Status: completed in iteration 28.

Goal: make model provider setup fail early in the Settings surface with compact
inline validation, so users understand why Save is unavailable before a request
hits the desktop server.

User-visible value: users adding an API-key model configuration see specific,
contained reasons for missing model, invalid base URL, or missing API key
states. The Save action only enables when the active provider form is valid,
and saved secrets still never render back into the DOM.

Expected files:

- `packages/desktop/src/renderer/stores/settingsStore.ts`
- `packages/desktop/src/renderer/stores/settingsStore.test.ts`
- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/model-configuration-workflow.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- API-key settings trim model and base URL before saving.
- Save is disabled with a clear inline reason when the API-key provider has no
  model, an invalid HTTP(S) base URL, or no new/saved API key.
- Coding Plan settings keep the region control compact and require a new or
  saved API key before Save enables.
- The validation message is contained inside the settings card and does not
  expose typed or saved secrets.
- Existing successful model save and composer model-switch behavior continues
  through the real Electron CDP path.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, complete the existing composer, review, and commit path, open
  Settings, clear model/base URL/API key fields to assert inline validation and
  disabled Save states, then enter a valid fake model/base URL/API key, save,
  return to Conversation, and switch to the saved model from the composer.
- E2E assertions: invalid settings states keep Save disabled with visible
  reason text, the validation card stays within Settings without body overflow,
  valid input re-enables Save, the fake API key is absent from settings text and
  artifacts, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `settings-validation.json`,
  `settings-product-state.json`, `composer-model-switch.json`,
  `settings-page.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained inline
  validation that keeps Settings dense and readable; `electron-desktop-dev` for
  renderer changes and real Electron CDP verification.

Notes and decisions:

- This slice keeps Settings as the existing full workbench page. Converting it
  to a drawer or modal is a separate fidelity pass.
- Validation stays client-side for immediate feedback while the desktop server
  remains the authority for persisted settings and secret handling.
- Save calls are guarded in `App` as well as disabled in the form, so a stale
  or programmatic click still gets the same validation message instead of
  sending an incomplete request.
- API-key model and base URL values are trimmed before the update request is
  built. The API key input is also trimmed when sent, but saved secrets are
  still cleared from the form after persistence.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 24 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed with no warnings after the
  dependency fix.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-56-02-534Z/`.
- Key recorded validation metrics: missing model, invalid base URL, and missing
  API key each disabled Save with inline reasons; valid input enabled Save;
  the validation row stayed inside the 500 px model card; no document overflow;
  fake API key visible text exposure was false; console errors and failed local
  requests were both zero.

Next work:

- Continue model configuration by adding keyboard-focused coverage for the
  provider selector and Coding Plan path.
- Continue prototype fidelity by exploring whether Settings should open as a
  narrower supporting surface instead of replacing the full workbench.

### Completed Slice: Composer Model Provider Promotion

Status: completed in iteration 27.

Goal: make a model saved in desktop settings immediately available from the
composer model picker for the active thread, so the settings flow connects to
the first-viewport task controls instead of ending on the settings page.

User-visible value: after adding or editing an API-key model configuration,
users can return to the conversation, choose that saved model from the composer,
and see the active thread model update without restarting the desktop app or
creating a new thread.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.test.ts`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/model-configuration-workflow.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Saving an API-key model provider merges the saved model into the active
  session model options without leaking the API key into DOM text, input values,
  screenshots, logs, or diagnostics.
- The composer model picker stays disabled before a thread exists, then shows
  the runtime model and the saved configured model once a session is active.
- Selecting the saved model from the composer calls the existing token-protected
  session model route and updates the visible composer selection.
- Settings remains a supporting surface; returning to Conversation restores the
  conversation-first workbench, terminal strip, and compact composer.
- No raw ACP/session IDs or server URLs are introduced into the main
  conversation or composer.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, create a thread, complete the
  command-approval path, open Settings, save `qwen-e2e-cdp` with a fake API key,
  return to Conversation, select `qwen-e2e-cdp` from the composer model picker,
  assert the composer selection changes and the secret is absent, then continue
  terminal attach/send verification.
- E2E assertions: saved configured model appears in composer options, selecting
  it updates the active select value and visible text, the API key remains
  hidden, the composer remains contained, and no console errors or failed local
  requests are recorded.
- Diagnostic artifacts: `settings-product-state.json`,
  `composer-model-switch.json`, `settings-page.png`, Electron log, and summary
  JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for selecting the smallest
  settings-to-composer workflow slice without asking routine product questions,
  `frontend-design` for keeping the picker compact and prototype-constrained,
  and `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- Chosen approach: promote saved provider models into renderer model state as
  selectable session candidates, then continue using the existing
  `/api/sessions/:id/model` route for the actual thread switch. This keeps the
  server ACP session model route as the authority for runtime state while making
  the settings result visible in the first viewport.
- Alternatives rejected for this slice: rebuilding the full model provider UI
  as a composer popover, or automatically switching the active session when
  settings are saved. Both are broader than needed and risk surprising users.
- Configured model options are replaced when settings change rather than
  accumulated indefinitely. Session resets preserve the configured option cache
  so the next loaded runtime model list can be merged without another settings
  fetch.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 21 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-47-01-812Z/`.
- Key recorded model-switch metrics: composer model picker enabled, selected
  value `qwen-e2e-cdp`, options `e2e/qwen-code` and `qwen-e2e-cdp`, composer
  height `101` px, no composer overflow, no fake API key exposure, no local
  server URL exposure in the conversation view, no console errors, and no
  failed local requests.

Next work:

- Continue the model configuration workflow by adding inline validation and
  clearer disabled/save reasons for missing model, base URL, or API key states.
- Continue prototype fidelity by checking whether the settings page needs a
  narrower modal/drawer treatment instead of a full workbench replacement.

### Completed Slice: Sidebar and Topbar Chrome Density Pass

Status: completed in iteration 26.

Goal: tighten the remaining oversized sidebar and topbar chrome so the first
viewport reads closer to the compact `home.jpg` workbench instead of a heavy
dashboard shell.

User-visible value: users get more room for the conversation and task surfaces,
while project, thread, branch, model, review, refresh, and settings controls
remain visible, readable, and safely contained.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/sidebar-topbar-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The desktop sidebar is narrower and uses shorter app action, project, and
  thread rows without horizontal overflow.
- Sidebar app action, project, thread, section, and footer typography moves to a
  restrained workbench scale while preserving readable labels and accessible
  button names.
- The topbar height, action buttons, runtime pill, and status text are slimmer
  and remain contained with a deliberately long branch name.
- The topbar no longer increases body scroll width or hides conversation,
  review, settings, terminal, branch, or Git status actions.
- No raw project paths, ACP/session IDs, or debug state are introduced into the
  main sidebar or topbar text.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the command,
  wait for the assistant result, then assert sidebar and topbar chrome geometry
  at the default viewport before continuing the existing branch, review,
  settings, terminal, discard safety, and commit workflows.
- E2E assertions: sidebar width is below the previous 272 px baseline, top app
  action rows are below the previous 32 px baseline, project/thread rows are
  below the previous 39.75/36 px baselines, section headings and row text use a
  smaller font scale, topbar height is below the previous 54 px baseline,
  action buttons are below the previous 30 px baseline, runtime status is below
  the previous 30 px height, long branch/status text remains contained, and no
  console errors or failed local requests are recorded.
- Diagnostic artifacts: `sidebar-app-rail.json`,
  `topbar-context-fidelity.json`, `topbar-context-fidelity.png`, Electron log,
  and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the narrow prototype
  fidelity slice without asking for routine product decisions,
  `frontend-design` for prototype-constrained density and hierarchy, and
  `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- The prototype remains the constraint: this pass should refine density and
  hierarchy, not introduce a new navigation model, new routes, or new branding.
- This slice deliberately avoids workflow logic so model configuration can
  resume after the first-viewport chrome is less visually dominant.
- The sidebar grid now uses a 252 px rail, 28 px app/footer actions, and
  roughly 32 px project/thread rows. Project/thread button parents now carry
  the same 12 px font scale as the visible row titles so inherited styles do
  not regress unnoticed.
- The topbar now uses a 50 px workbench row, 28 px icon buttons, a 28 px runtime
  status pill, and 10.5 px context text. Long branch and Git status text remain
  in the DOM for accessibility but are visually contained.
- The CDP harness now records sidebar/topbar font metrics as well as geometry,
  so future fidelity work cannot accidentally reintroduce the heavier 272 px
  sidebar, 54 px topbar, 32 px action rows, or 30 px topbar buttons.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 15 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed after the final CSS fix.
- `cd packages/desktop && npm run e2e:cdp` first failed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-35-53-527Z/`
  because project/thread row button parents still inherited the root 14 px font
  even though the visible labels were compact. The CSS now sets the row parent
  font size explicitly.
- `cd packages/desktop && npm run e2e:cdp` then passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-36-28-286Z/`.
- Key recorded metrics from the passing run: sidebar width `252` px, app/footer
  action rows `28` px tall, project row `32.6328125` px tall, thread row `32`
  px tall, sidebar row font `12` px, sidebar heading font `10` px, topbar height
  `50` px, topbar action buttons `28x28`, runtime status
  `65.6328125x28`, topbar context font `10.5` px, no document overflow, no
  console errors, and no failed local requests.

Next work:

- Resume the model configuration workflow from the composer model picker and
  settings entry now that the first-viewport chrome is less visually dominant.
- Continue prototype fidelity by reducing remaining message/file chip button
  weight only where screenshots show it crowding the conversation.

### Completed Slice: Conversation Message Typography Density Pass

Status: completed in iteration 25.

Goal: reduce the remaining oversized message and plan typography in the first
viewport so assistant prose, user prompts, plan rows, tool activity, changed
files, and composer controls share the compact conversation-first hierarchy
shown in `home.jpg`.

User-visible value: users can scan more agent context above the composer
without the user bubble, plan rows, or assistant prose reading like large
dashboard cards. The conversation remains the main surface while activity rails
and changed-file summaries stay secondary.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-message-density.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Regular message prose uses a tighter desktop workbench type scale while
  remaining readable.
- The user prompt bubble is shorter and no longer spends vertical space on a
  redundant role label.
- Plan rows use compact status labels and spacing without overflowing the
  timeline.
- Compact `960x640` conversation screenshots show the assistant message,
  file chips, actions, changed-files summary, composer, and terminal strip
  contained in the first viewport.
- No ACP/session/internal IDs are introduced in the main conversation.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the command,
  assert the user bubble, assistant prose, plan rows, changed-files summary, and
  compact viewport geometry, then continue the existing assistant actions,
  branch, review, settings, terminal, discard safety, and commit workflows.
- E2E assertions: message paragraph font sizes remain below the previous 14 px
  default, user prompt height is bounded, plan item type and line height stay
  compact, compact assistant message height is bounded, and no console errors or
  failed local requests are recorded.
- Diagnostic artifacts: `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing a narrow prototype
  fidelity slice without asking for routine product decisions,
  `frontend-design` for prototype-constrained density and hierarchy, and
  `electron-desktop-dev` for real Electron CDP verification.

Notes and decisions:

- The user prompt bubble no longer renders the redundant uppercase role label.
  This removes debug-style chrome from the main conversation and saves vertical
  space without hiding any task content.
- Message prose now uses a 13 px workbench type scale with tighter line height.
  The screenshot still reads comfortably, but the assistant response no longer
  dominates the first viewport like a large card.
- Plan rows were compacted, then adjusted after screenshot review because the
  first pass let `IN_PROGRESS` visually collide with the row text. The final
  CSS keeps a fixed label gutter and margin while preserving the ordered list
  markers.
- The CDP harness now measures actual rendered font size, line height, user
  bubble height, hidden user-role display, plan row density, and compact
  assistant message height.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed before and after the plan-label spacing fix.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 15 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed before and after the spacing
  fix.
- `cd packages/desktop && npm run e2e:cdp` first passed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-26-40-440Z/`.
  Screenshot review found the plan status/text spacing issue, so the CSS was
  fixed and the full CDP smoke passed again at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-27-41-142Z/`.
- Key recorded metrics from the final pass: assistant paragraph font `13` px
  and line height `19.24` px, user prompt height `37.234375` px with user role
  `display: none`, plan item font `12` px and line height `16.32` px, plan
  block height `68.625` px, default assistant message height `163.9375` px,
  compact assistant message height `213.171875` px, no document overflow, no
  console errors, and no failed local requests.

Next work:

- Continue prototype fidelity by reducing the heavy sidebar/topbar typography
  and icon button scale visible in the latest screenshots.
- Resume the model configuration workflow from the composer model picker once
  the first-viewport density issues are stable.

### Completed Slice: Compact Agent Activity Rails

Status: completed in iteration 24.

Goal: make command approvals and resolved tool activity read like compact
timeline events instead of large dashboard cards, while preserving the
approval actions, command preview, result summary, file reference, and
accessibility hooks.

User-visible value: users can see what the agent is doing without losing the
conversation-first first viewport. Risky command approval remains obvious, but
it no longer visually dominates assistant prose, changed-file summaries, and
the composer.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/tool-activity-fidelity.md`
- `.qwen/e2e-tests/electron-desktop/inline-command-approval-cards.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Resolved tool activity keeps kind, title, status, bounded command input,
  bounded result output, and file-reference chips.
- Tool input/result previews render as dense inline rows, not stacked boxed
  mini panels.
- Pending command approval keeps the command preview and Approve Once,
  Approve for Thread, and Deny actions, but uses a slimmer warning rail and
  compact buttons.
- The approval rail and resolved tool rail stay inside the timeline and above
  the composer at the default Electron viewport.
- Internal ACP/session/tool IDs remain hidden from the main conversation.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, assert the pending
  approval rail geometry and actions, approve the command, assert the resolved
  tool rail geometry/content/styles, then continue the existing assistant
  actions, branch, review, settings, terminal, discard safety, and commit
  workflows.
- E2E assertions: pending approval height is below the previous 152.9 px
  baseline, resolved tool activity height is below the previous 167.8 px
  baseline, preview backgrounds and borders remain subtle, and no console
  errors or failed local requests are recorded.
- Diagnostic artifacts: `inline-command-approval.json`,
  `inline-command-approval.png`, `resolved-tool-activity.json`,
  `resolved-tool-activity.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the narrow fidelity
  slice without asking the user for routine product decisions,
  `frontend-design` for prototype-constrained density and visual hierarchy,
  and `electron-desktop-dev` for real Electron CDP verification of the
  renderer workflow.

Notes and decisions:

- Command approvals now use the same rail language as tool activity: subtle
  left accent, restrained warning tint, and compact action buttons. This keeps
  the risky decision visible without turning the first viewport into a modal
  review surface.
- Tool input and result previews now render as dense label/value rows. The raw
  preview text remains available through `title` and accessible labels, while
  internal ACP/session/tool IDs stay out of the main timeline.
- The CDP harness now treats the previous approval and tool heights as
  regressions by tightening the default-viewport geometry guards to 130 px.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 15 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-18-35-363Z/`.
- Key recorded metrics: pending approval rail height `109.5234375` px,
  resolved tool activity height `113.046875` px, resolved tool width `800` px,
  no legacy `.chat-tool` rows, no document overflow in the carried smoke path,
  no console errors, and no failed local requests.

Next work:

- Continue prototype fidelity by reducing the oversized user message and plan
  typography visible above the agent activity rail.
- Resume the model configuration workflow from the composer model picker once
  the remaining first-viewport density issues are stable.

### Completed Slice: Composer and Changed-Files Density Pass

Status: completed in iteration 23.

Goal: make the first viewport closer to `home.jpg` by reducing the bottom
composer's visual height and converting the inline changed-files summary from a
mini review panel into a compact conversation activity card.

User-visible value: users keep more conversation context visible while the
composer still exposes project, branch, permission, model, stop, and send
controls. The changed-files prompt remains discoverable but no longer competes
with assistant prose or the real review drawer.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-surface-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The composer uses a shorter textarea and slimmer accessory controls while
  preserving attach, project, branch, permission, model, stop, and send access.
- Composer controls wrap safely at the compact Electron viewport without
  horizontal overflow.
- The inline changed-files summary shows the file count, diff stats, a short
  bounded file list, and Review Changes action in a compact surface.
- The changed-files summary remains visibly secondary to assistant prose and
  stays inside the conversation timeline at 1240x820 and 960x640.
- The review drawer still opens from the changed-files summary and assistant
  Open Changes action.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the command,
  wait for assistant prose and changed-files summary, assert the compact summary
  and composer geometry, switch to the compact viewport, then continue the
  existing branch, review, settings, terminal, discard safety, and commit
  workflows.
- E2E assertions: default summary height is below the previous 153.5 px
  baseline, compact summary height is bounded, composer height is below the
  previous 126.9 px compact baseline, textarea height stays short, controls do
  not overflow, and no console errors or failed local requests are recorded.
- Diagnostic artifacts: `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, `compact-dense-conversation.json`,
  `compact-dense-conversation.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `brainstorming` for choosing the narrow slice
  without involving the user in routine product choices, `frontend-design` for
  prototype-constrained density and visual hierarchy, and
  `electron-desktop-dev` for real Electron CDP verification of the renderer
  workflow.

Notes and decisions:

- The prototype treats the composer as the task control center, but not as a
  tall form. The textarea now defaults to two rows with slimmer accessory
  controls; project, branch, permission, model, stop, and send remain in the
  composer.
- The changed-files summary now uses a single heading/action row and compact
  file chips. It shows up to three files inline and sends larger sets to the
  review drawer through a `+N more` chip.
- A self-review of the first passing CDP artifacts showed the compact
  screenshot was captured after the harness scrolled the assistant message into
  view, leaving the summary partly behind the composer in the diagnostic image.
  The harness now restores bottom-of-conversation scroll before the screenshot
  and asserts the compact summary stays above the composer.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 15 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first passed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-06-50-043Z/`.
  After the compact screenshot/bottom-scroll harness fix, it passed again at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-08-46-544Z/`.
- Key recorded metrics from the final pass: default changed-files summary
  height `80` px, default composer height `101` px, default textarea height
  `46` px, compact changed-files summary height `80` px, compact composer
  height `97.1875` px, no composer/control overflow, no document overflow, no
  console errors, and no failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining large message/tool
  typography and command activity vertical weight visible above the assistant
  response.
- Resume the model configuration workflow from the composer model picker and
  settings entry once the first viewport density is stable.

### Completed Slice: Branch Create Inline Validation

Status: completed in iteration 22.

Goal: keep branch creation errors inside the compact topbar branch menu by
validating duplicate and malformed names before submission and proving the
error state in real Electron.

User-visible value: users get immediate, contained feedback when a branch name
cannot be created, without a failed Git request, menu overflow, or leaving the
conversation-first workbench.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/branch-creation.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Empty branch creation remains disabled.
- Duplicate local branch names show an inline error and keep the create action
  disabled without calling the create route.
- Malformed names with leading/trailing whitespace, whitespace inside the name,
  option-looking names, path traversal, or `.lock` suffixes show a concise
  inline error and keep the create action disabled.
- Editing back to a valid unique branch name clears the inline error and allows
  creation.
- The error text, create form, and rows remain width-bounded inside the compact
  branch menu at the default Electron viewport.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, open the branch menu, type duplicate
  and malformed branch names, assert inline error/disabled state/geometry, type
  `desktop-e2e/new-branch-from-menu`, create it, then continue the existing
  branch switching, review, settings, terminal, discard safety, and commit
  workflows.
- E2E assertions: duplicate and invalid names do not close the menu or call
  branch creation; valid names clear the inline error; the error block does not
  overflow the menu; no console errors or failed local requests are recorded.
- Diagnostic artifacts: `branch-create-validation.json`,
  `branch-create-menu.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  menu feedback; `electron-desktop-dev` for real Electron CDP verification of
  the renderer workflow.

Notes and decisions:

- Validation remains renderer-side for fast feedback and mirrors the server's
  pre-Git rejection rules for common malformed names. The server remains the
  final authority for Git ref validation and duplicate checks.
- Duplicate names are checked against the loaded local branch list, including
  the current branch. The create action stays disabled while the inline error is
  visible, so users do not get a failed request for obvious conflicts.
- The menu continues to use the compact topbar surface from the prototype;
  errors render as a single inline status message beneath the create form
  rather than expanding into a Git management view.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 14 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed through real Electron with
  duplicate and malformed branch-create validation, successful branch creation,
  dirty branch switching, review, settings, terminal, discard safety, and
  commit workflows.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-59-40-308Z/`.
- Key recorded metrics: the branch menu stayed `320` px wide; duplicate and
  malformed validation errors stayed inside the menu; the create button stayed
  disabled for invalid names and became enabled for
  `desktop-e2e/new-branch-from-menu`; no document overflow, console errors, or
  failed local requests were recorded.

Next work:

- Continue prototype fidelity by reducing the remaining composer height and
  changed-files summary weight visible in the latest screenshots.
- Add a compact settings/model switch path from the composer once the model
  configuration workflow is resumed.

### Completed Slice: Safe Topbar Branch Creation

Status: completed in iteration 21.

Goal: extend the compact topbar branch menu so users can create and switch to a
new local branch from the current project without leaving the conversation
workbench.

User-visible value: users can stay in the default "open project -> ask agent ->
review changes" flow while preparing a clean branch for the task. The branch
control remains visible and compact in the first viewport, with validation and
dirty-worktree messaging handled in the menu.

Expected files:

- `packages/desktop/src/server/services/projectService.ts`
- `packages/desktop/src/server/index.ts`
- `packages/desktop/src/server/index.test.ts`
- `packages/desktop/src/renderer/api/client.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/branch-creation.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The branch menu includes a compact create-branch form beneath the local branch
  list, without turning the topbar into a Git dashboard.
- Branch names are validated before Git runs: empty names, whitespace,
  path-traversal-looking names, option-looking names, lock suffixes, invalid Git
  ref names, and duplicate local branch names are rejected with clear messages.
- Creating a branch calls a token-protected desktop server route, creates and
  switches to the branch, refreshes Git status and review diff, closes the menu,
  and updates the topbar branch label.
- Dirty worktrees are called out in the menu; creation keeps local changes in
  the worktree and relies on Git to reject conflicting state.
- Long branch names stay contained in the menu and topbar.

Verification:

- Unit/server test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project on the deliberately long branch, open
  the branch menu, create `desktop-e2e/new-branch-from-menu`, assert the topbar
  and actual repo branch switch to the new branch, assert the dirty status is
  preserved, reopen the menu and continue the existing dirty branch-switch path
  back to `main`, then continue the existing review, settings, terminal,
  discard safety, and commit workflows.
- E2E assertions: create form is bounded inside the menu; invalid empty branch
  submission is disabled or rejected before a request; created branch appears in
  Git and topbar; no menu row or create form overflows; no console errors or
  failed local requests are recorded.
- Diagnostic artifacts: `branch-create-menu.json`,
  `branch-create-validation.json`, `branch-create-result.json`,
  `branch-create-menu.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  branch-control design; `electron-desktop-dev` for server/renderer changes
  verified through real Electron CDP.

Notes and decisions:

- The prototype keeps branch state as slim workbench chrome. Creation therefore
  belongs as an inline branch-menu affordance rather than a persistent review or
  Git management panel.
- This slice creates and switches local branches only. Remote tracking,
  publishing, and branch deletion are out of scope for this iteration.
- Server-side validation rejects whitespace/control characters, option-looking
  names, path-traversal-looking names, lock suffixes, duplicate local branch
  names, and names that fail `git check-ref-format --branch` before running
  `git switch -c`.
- The first CDP run exposed an async harness timing issue after branch creation:
  the reopened menu briefly rendered the previous branch-list state before the
  server reload marked the new branch current. The harness now waits for the
  expected current row before snapshotting menu geometry.
- Self-review promoted that timing issue into a small product fix: branch rows
  are cleared at the start of each branch-list load, so reopening the menu shows
  loading state instead of stale branch rows.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed.
- After replacing the control-character validation regex with an explicit
  helper, `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts`
  passed again.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` first failed on ESLint
  `no-control-regex`; after the helper cleanup, `cd packages/desktop && npm run lint`
  passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-38-07-376Z/`
  because the new branch-switch assertion sampled stale branch rows immediately
  after reopening the menu.
- After the readiness wait, `cd packages/desktop && npm run e2e:cdp` passed
  through real Electron with branch creation, dirty branch switching, review,
  settings, terminal, discard safety, and commit workflows.
- After the stale-row product fix, `cd packages/desktop && npm run build` and
  `cd packages/desktop && npm run e2e:cdp` passed again.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-47-05-265Z/`.
- Key recorded metrics: create menu width `320`, create form width `298`, no
  escaped branch rows, empty create action disabled, created branch
  `desktop-e2e/new-branch-from-menu` became the actual repo branch, topbar
  branch text updated to that branch, dirty status stayed
  `1 modified · 0 staged · 1 untracked`, and no console errors or failed local
  requests were recorded.

Next work:

- Add a compact branch-create conflict/error path to the CDP harness by trying
  a duplicate or invalid branch name in the real menu and asserting the inline
  validation message stays contained.
- Continue prototype fidelity by reducing the remaining composer height and
  changed-files summary weight visible in the latest screenshots.

### Completed Slice: Safe Topbar Branch Switching

Status: completed in iteration 20.

Goal: turn the slim topbar branch context into a compact branch menu that lists
local branches, switches branches through the desktop server, and protects
dirty worktrees with an explicit confirmation before checkout.

User-visible value: users can answer and change "which branch am I on?" from
the main workbench without leaving the conversation-first viewport, while
uncommitted changes are called out before a branch change.

Expected files:

- `packages/desktop/src/server/services/projectService.ts`
- `packages/desktop/src/server/index.ts`
- `packages/desktop/src/server/index.test.ts`
- `packages/desktop/src/renderer/api/client.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/components/layout/SidebarIcons.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/branch-switching.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The topbar branch context is a compact accessible control that opens a local
  branch menu without reintroducing heavy pill styling.
- The menu lists local branches, marks the current branch, truncates long branch
  names, and remains contained in the slim topbar area.
- Choosing a different branch while the project is dirty shows a confirmation
  explaining that uncommitted changes will remain in the worktree unless Git
  rejects the checkout.
- Confirming a switch calls the server checkout route, refreshes Git status and
  review diff, closes the menu, and updates the topbar branch label.
- Server branch routes are token protected through the existing local-server
  auth layer, list only local branch names, validate checkout targets against
  that local list, and reject unknown branch names.

Verification:

- Unit/server test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project on the deliberately long branch,
  open the branch menu, assert the long branch and `main` are listed, choose
  `main`, confirm the dirty-worktree branch switch, assert the topbar updates
  to `main`, assert Git status and diff remain coherent, then continue the
  existing prompt, approval, review, settings, terminal, discard safety, and
  commit workflows.
- E2E assertions: branch menu geometry is bounded; the current branch is marked;
  dirty confirmation appears before checkout; confirmed checkout updates the
  topbar and actual repo branch; no console errors or failed local requests are
  recorded.
- Diagnostic artifacts: `branch-switch-menu.json`,
  `branch-switch-confirmation.json`, `branch-switch-result.json`,
  `branch-switch-menu.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  topbar menu design; `electron-desktop-dev` for server/preload/renderer changes
  verified in the real Electron app; `brainstorming` applied by choosing the
  smallest continuation from the prior topbar slice instead of expanding into
  branch creation or full Git management.

Notes and decisions:

- This slice intentionally supports local branch list and checkout only. Branch
  creation is left for a later workflow slice so the menu stays focused and the
  server can validate checkout targets against known local branches.
- Dirty-state protection is a renderer confirmation before checkout. The server
  still relies on Git to reject unsafe checkout conflicts and returns the
  existing `git_error` response if Git cannot switch.
- The branch menu belongs in the topbar context row because `home.jpg` keeps
  branch state as compact chrome, not as a large Git dashboard.
- The first real Electron run exposed a harness timing issue: the menu shell
  opened before async branch rows loaded. The harness now waits for branch rows
  before measuring menu geometry.
- The next passing artifact exposed a real visual issue: the long branch row
  escaped the 320 px menu. The row CSS now forces width containment, and the CDP
  harness records `escapedRows: []`.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed because the new branch
  menu assertion ran before branch rows loaded, producing diagnostics at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-17-48-367Z/`.
- After waiting for branch rows, `cd packages/desktop && npm run e2e:cdp`
  passed but artifact review showed the long branch row escaped the menu. The
  CSS and harness were tightened instead of accepting the visual drift.
- After rebuilding, `cd packages/desktop && npm run e2e:cdp` passed with the
  safe branch-switch path and the existing prompt, approval, review, settings,
  terminal, discard safety, and commit workflows. A final rebuild and CDP pass
  after the branch-name parser cleanup and final renderer readiness guard also
  passed.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-25-14-829Z/`.
- Key recorded metrics: branch menu width `320`, row widths `298`, no escaped
  rows, current long branch marked, `main` listed as switch target, dirty
  confirmation shown, actual repository branch switched to `main`, and dirty
  status remained `1 modified · 0 staged · 1 untracked`.

Next work:

- Add branch creation from the topbar menu or command palette with the same
  dirty-worktree protection and server-side branch-name validation.
- Continue prototype fidelity by reducing the remaining composer height and
  density drift visible in the branch-switch screenshot.

### Completed Slice: Slim Topbar Context Prototype Fidelity

Status: completed in iteration 19.

Goal: make the workbench top bar closer to the slim `home.jpg` header by
reducing heavy status-pill treatment, keeping project/runtime/branch context
single-line, and proving long branch names do not overflow when review is
opened.

User-visible value: users can scan thread title, project, connection state,
branch, dirty state, and core actions without the header competing with the
conversation or clipping into unreadable pill fragments.

Expected files:

- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/components/layout/StatusPill.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `.qwen/e2e-tests/electron-desktop/topbar-context-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Topbar project/runtime/branch/git context renders as a lightweight context
  row, not three heavy bordered pills.
- Runtime status remains visible and accessible but is compact enough to fit
  the action cluster.
- Long branch/project/thread/model labels are truncated within their regions
  and do not create horizontal overflow in the default or compact review
  viewport.
- Real Electron CDP coverage records topbar geometry, context item style
  weight, action sizes, long branch visibility, and overflow state.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, create/open the fake project on a deliberately long branch,
  send/approve the prompt, assert the slim topbar context metrics, open review
  at default and compact widths, and continue the existing review/settings/
  terminal/commit smoke.
- E2E assertions: topbar height remains slim, context items have no heavy
  bordered-pill frame, action buttons remain compact, long branch text is
  present in DOM but contained visually, and topbar/composer/review do not
  overflow in compact review.
- Diagnostic artifacts: `topbar-context-fidelity.json`,
  `topbar-context-fidelity.png`, `compact-review-drawer.json`, Electron log,
  and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained
  density and visual hierarchy; `electron-desktop-dev` for real Electron CDP
  verification; `brainstorming` applied by selecting the smallest recorded
  continuation from the prior slice's next-work item.

Notes and decisions:

- The slice leaves branch switching behavior unchanged; it only improves and
  verifies how long current-branch context is displayed.
- The prototype wins over a new art direction: context should read as quiet
  desktop chrome, with the conversation remaining visually dominant.
- The first real Electron CDP run exposed that the deliberately long branch
  pushed the compact composer to `158.890625` px, above the existing density
  limit. The fix tightened compact composer control widths and kept default
  compact composer controls on one row, instead of weakening the assertion.
- Narrow review mode still allows composer controls to wrap, because that
  drawer width is smaller and already has separate containment coverage.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed before the new topbar
  assertion because long branch text made the compact composer height
  `158.890625`; diagnostics were saved at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-57-32-569Z/`.
- After tightening compact composer widths,
  `cd packages/desktop && npm run build && npm run e2e:cdp` passed after
  launching real Electron over CDP, opening the fake project on the long
  branch, sending/approving the fake ACP prompt, asserting topbar context
  fidelity, and completing the existing compact review, review safety,
  settings, terminal, discard safety, and commit workflows.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-58-44-613Z/`.
- Key recorded metrics: topbar height `54`, context row height `16`, context
  item background alpha `0`, context border widths `0`, action buttons
  `30x30`, runtime status `71.2578125x30`, long branch present in DOM text,
  no topbar/body overflow, and compact composer height `126.890625` with the
  long branch visible and truncated.

Next work:

- Turn the branch context into a safe branch menu/dropdown with dirty-state
  protection and server-side branch list/checkout tests.
- Continue prototype fidelity by reducing the remaining changed-files summary
  card weight so it reads more like an inline conversation result.

### Completed Slice: Sidebar App Rail Prototype Fidelity

Status: completed in iteration 18.

Goal: make the left sidebar read more like the `home.jpg` prototype by moving
primary app actions into compact top rows, pinning Settings to the bottom, and
tightening project/thread row density without exposing raw paths or prompt
noise.

User-visible value: users get a clearer desktop-native navigation rail: start
a thread, open a project, reach model/settings, scan projects, scan threads,
and find Settings at the expected persistent bottom position.

Expected files:

- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `.qwen/e2e-tests/electron-desktop/sidebar-app-rail-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Sidebar primary actions render as compact icon+label rows at the top.
- Settings is available as a persistent bottom row and no longer competes in
  the top project toolbar.
- Project and thread rows stay compact, active rows keep a subtle left accent,
  and long project/thread/model labels remain truncated.
- Thread rows do not show raw full paths or protocol/session IDs.
- Real Electron CDP coverage records sidebar geometry and fails if the
  navigation loses the top action group or bottom Settings placement.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send/approve the prompt, assert the
  populated sidebar app rail layout, continue the existing review/settings/
  terminal/commit smoke, and capture first-viewport screenshots and JSON
  metrics.
- E2E assertions: top app action rows include New Thread/Open Project/Models,
  bottom Settings is visually below the project/thread lists, rows stay under
  the compact height limit, sidebar width remains compact at desktop and
  compact widths, and no sidebar row overflows horizontally.
- Diagnostic artifacts: `sidebar-app-rail.json`, `initial-workspace.png`,
  `completed-workspace.png`, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained
  information hierarchy and density; `electron-desktop-dev` for real Electron
  CDP verification; `brainstorming` applied by selecting the smallest recorded
  fidelity gap, using the prototype over a new visual direction.

Notes and decisions:

- The slice keeps the existing local server, preload, IPC, ACP, review, and
  settings behavior unchanged; this is a renderer layout and style fidelity
  pass.
- `frontend-design` is applied with the Ralph constraint that `home.jpg` wins:
  the sidebar should become quieter and more navigational, not more decorative.
- `electron-desktop-dev` applies because sidebar layout and navigation order
  must be verified in the real Electron shell with actual viewport geometry.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launching real
  Electron over CDP, opening the fake project, sending/approving the fake ACP
  prompt, checking the new sidebar app rail metrics, and completing the
  existing review, settings, terminal, discard safety, and commit workflows.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-46-17-523Z/`.
- Key recorded metrics: sidebar width `272`, top app action rows
  `32` px high, project row `39.75` px high, thread row `36` px high, bottom
  Settings row `32` px high, no legacy sidebar toolbar, no sidebar overflows,
  and no console errors or failed local requests.

Next work:

- Continue prototype fidelity by reducing the remaining topbar/status pill
  weight and making the title/action cluster closer to the slim `home.jpg`
  header.
- Add focused long branch/model/project-name CDP coverage with review open,
  since compact review and composer chips rely on truncation to avoid overflow.

### Completed Slice: Inline Tool Activity Prototype Fidelity

Status: completed in iteration 17.

Goal: reduce the remaining dashboard-card treatment around resolved tool
activity so command/tool progress reads like a compact inline timeline event,
closer to the activity rows in `home.jpg`.

User-visible value: users can scan agent work without a large framed tool
result crowding the conversation or competing with assistant prose, changed
files, and the composer.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/tool-activity-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Resolved tool activity keeps the existing semantic content and file chip.
- Tool activity no longer has a full card border or opaque card background;
  only a subtle timeline accent remains.
- Tool input/output previews are compact and less visually heavy than the
  previous dark boxed card treatment.
- File chips stay compact, readable, and width-bounded.
- Existing approval, assistant action, changed-files, review, settings,
  terminal, and commit workflows continue to pass in the real Electron CDP
  smoke.

Verification:

- Unit/component test command: no component logic change expected.
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, approve the fake command
  request, wait for the resolved tool activity, assert semantic content and
  compact visual style metrics, capture screenshot/JSON artifacts, then
  continue the existing assistant, changed-files, review, settings, terminal,
  review safety, and commit workflow.
- E2E assertions: tool activity has no top/right/bottom border frame, uses a
  subtle left timeline accent, has transparent or near-transparent background,
  keeps preview backgrounds subdued, stays shorter than the prior heavy card,
  and does not leak internal tool/session IDs.
- Diagnostic artifacts: `resolved-tool-activity.json`,
  `resolved-tool-activity.png`, plus existing CDP screenshots, Electron log,
  and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained visual
  hierarchy and density; `electron-desktop-dev` for renderer/CDP real Electron
  verification; `brainstorming` applied by selecting the smallest fidelity
  continuation from recorded next-work items instead of expanding scope.

Notes and decisions:

- `frontend-design` is applied with the Ralph constraint that `home.jpg` wins:
  the goal is restrained, desktop-native density rather than a new visual
  direction.
- `electron-desktop-dev` requires this CSS-only renderer polish to be verified
  in a real Electron window through the CDP harness because the risk is visual
  hierarchy, overflow, and first-viewport usability.
- This slice intentionally avoids changing tool timeline data shaping; it only
  adjusts the presentation and executable layout/style assertions.
- Resolved tool activity now uses a transparent container with a 2 px left
  timeline accent, subdued preview separators, and lighter file chips. This
  keeps the semantic command/result/file information without reintroducing a
  full bordered card.
- The first CDP run exposed a harness bug in the new style probe
  (`firstPreview`/`fileChip` were referenced before declaration); this was
  fixed before rerunning.
- The second CDP run showed the visual direction was correct but the activity
  row was still 177.8 px tall against the 175 px compactness target. The CSS
  spacing was tightened instead of loosening the assertion.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed with a style-probe
  `ReferenceError`, producing diagnostics at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-34-05-965Z/`.
- `cd packages/desktop && npm run e2e:cdp` then failed because the compact tool
  activity height was still `177.796875`, producing diagnostics at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-34-47-802Z/`.
- After tightening the tool activity spacing,
  `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP, including the new inline tool activity style assertions
  and the existing assistant, compact layout, review, settings, terminal,
  review safety, and commit workflows.
- After a self-review cleanup removed two accidental unused style-probe
  declarations from the command-approval assertion, the same
  `cd packages/desktop && npm run e2e:cdp` command passed again.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-38-24-240Z/`.
- Key recorded metrics: tool activity height was `167.796875`, background
  alpha was `0`, top/right/bottom border widths were `0`, left border width was
  `2` with alpha `0.36`, preview background alpha was `0`, and file-chip
  background alpha was `0.05`.

Next work:

- Continue prototype fidelity by reducing remaining visual heaviness in the
  changed-files summary and sidebar/topbar typography visible in the current
  CDP screenshots.
- Add focused long branch/model/project-name CDP coverage with review open,
  since compact review and composer chips rely on truncation to avoid overflow.

### Completed Slice: Conversation Surface Prototype Fidelity

Status: completed in iteration 16.

Goal: reduce the remaining boxed/dashboard treatment in the conversation
timeline so assistant prose reads as the main workbench surface, while changed
files and tool/activity summaries remain compact supporting surfaces.

User-visible value: the first viewport moves closer to `home.jpg`: the
conversation feels like a coding-agent timeline instead of stacked cards, with
less border noise and a lighter inline review entry point.

Expected files:

- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-surface-fidelity.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Assistant messages no longer render as visibly framed cards.
- User prompts remain readable as compact right-aligned bubbles.
- Changed-files summary and tool/activity surfaces retain accessible
  landmarks/actions but use subtler borders, backgrounds, and tighter density.
- Existing assistant file-reference, action-row, changed-files, review,
  settings, and terminal flows continue to pass.
- Real Electron CDP coverage records computed surface styles and geometry, and
  fails if assistant messages regain a visible card frame or if the changed
  files summary becomes visually heavy again.

Verification:

- Unit/component test command: no component logic change expected.
- Syntax command: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake project, send a prompt, approve the fake command
  request, wait for the dense assistant response and changed-files summary,
  assert assistant action/file chips, assert conversation surface computed
  styles and geometry, capture screenshot/JSON artifacts, then continue the
  existing compact, review, settings, and terminal workflow.
- E2E assertions: assistant message border widths are zero and background is
  transparent, user message remains a compact bubble, changed-files summary
  uses subtle border/background alpha and stays shorter than the previous
  dashboard-like card, action buttons remain compact, and console
  errors/failed local requests are absent.
- Diagnostic artifacts: `conversation-surface-fidelity.json`,
  `conversation-surface-fidelity.png`, plus existing CDP screenshots, Electron
  log, and summary JSON under `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained visual
  hierarchy and density; `electron-desktop-dev` for renderer/CDP real Electron
  verification; `brainstorming` applied by choosing the smallest fidelity
  slice from the recorded next-work items instead of introducing new product
  scope.

Notes and decisions:

- `frontend-design` was applied with the extra Ralph constraint that
  `home.jpg` wins over inventing a new visual direction. The slice removes the
  remaining assistant message frame instead of adding a new card treatment, and
  keeps changed-files/tool summaries as quieter supporting inline surfaces.
- `electron-desktop-dev` was applied by extending the real Electron CDP smoke
  path with computed-style and geometry assertions, not just visual inspection.
- The unframed assistant message still uses compact action icon buttons and
  file chips so the timeline remains actionable without becoming a dashboard.
- Changed-files summary rows now read more like a compact inline table: no
  nested row cards, subtler background, and a 30 px review action.
- Iteration 15 left this slice uncommitted after starting a CDP run that did
  not reach the new fidelity assertion. Iteration 16 reran the full verification
  and recorded the passing artifacts below.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP, including the new conversation surface fidelity assertion
  and the existing compact conversation, compact review, settings, terminal,
  review safety, and commit workflows.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-26-44-948Z/`.
- Key recorded metrics: assistant message border widths were all `0`,
  assistant background alpha was `0`, changed-files summary background alpha
  was `0.024`, changed-files summary border alpha was `0.11`, changed-files
  summary height was `153.5`, and the document scroll width stayed equal to the
  `1240` px viewport.

Next work:

- Continue prototype fidelity by reducing remaining visual heaviness in tool
  result cards and topbar/sidebar typography visible in the current CDP
  screenshots.
- Add focused long branch/model/project-name CDP coverage with review open,
  since compact review and composer chips now rely on truncation to avoid
  overflow.

### Completed Slice: Compact Review Drawer CDP Coverage

Status: completed in iteration 14.

Goal: extend the real Electron CDP harness so opening the review drawer at the
compact desktop width still leaves the conversation, composer, topbar, and
collapsed terminal usable.

User-visible value: users on smaller desktop windows can inspect changed files
without the review drawer turning the first viewport into a cramped diff
dashboard or hiding the task composer.

Expected files:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `packages/desktop/src/renderer/styles.css`
- `.qwen/e2e-tests/electron-desktop/compact-review-drawer.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The CDP harness opens Changes, resizes the real Electron window to the
  compact desktop bounds near 960x640, and asserts review-drawer geometry.
- The compact review drawer remains a supporting surface, with the
  conversation still wider than the drawer and the composer contained inside
  the chat panel.
- The collapsed terminal strip remains docked and closed while review is open.
- Topbar action buttons remain compact icon controls with accessible labels.
- The review drawer, changed-file rows, diff hunks, review actions, and commit
  controls do not cause horizontal document or panel overflow.
- The window is restored to the default desktop size before the rest of the
  smoke path continues.

Verification:

- Unit/component test command: no renderer unit changes expected unless CSS
  fixes require component hooks.
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the fake
  command request, wait for the dense assistant response and changed-files
  summary, open Changes, assert the default review drawer, resize the window to
  compact bounds, assert compact review/diff/composer geometry and overflow
  constraints, capture screenshot and JSON artifacts, restore the default
  window size, then continue the existing review/commit/settings/terminal path.
- E2E assertions: viewport is near 960 px, sidebar stays compact, review width
  is bounded, chat remains wider than review, composer height stays bounded,
  review rows and diff hunks stay inside the drawer, commit controls remain
  reachable, terminal is collapsed, and console errors/failed local requests are
  absent.
- Diagnostic artifacts: compact review drawer screenshot and JSON metrics,
  plus existing CDP screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  drawer density and conversation-first hierarchy; `electron-desktop-dev` for
  renderer/CDP real Electron verification; `brainstorming` applied by selecting
  the smallest continuation from the recorded compact review gap and prototype
  evidence rather than adding new product scope.

Notes and decisions:

- The prototype keeps review as a supporting surface, so compact review uses a
  304 px drawer at the 960 px desktop breakpoint instead of replacing the
  conversation or stacking into a dashboard.
- The first CDP run exposed a real compact issue: with the review drawer open,
  the composer textarea still honored the three-row intrinsic height and
  measured about 71 px. The review-open compact CSS now pins the textarea to
  44 px with internal scrolling, reducing the composer from about 152 px to
  125 px in the passing artifact.
- Review content can scroll inside the drawer at compact height. The
  first-viewport contract is that the drawer, changed-file rows, diff hunks,
  actions, and commit controls remain width-bounded without forcing document
  scroll or collapsing the conversation.
- A self-review cleanup briefly broke the existing compact conversation harness
  by renaming a shared helper in the wrong scope; the helper name was restored
  before the final CDP pass.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` first failed with
  `Compact review textarea should stay short: 70.890625`, producing diagnostic
  artifacts at
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T20-04-36-025Z/`.
- After the scoped compact textarea fix,
  `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP, including the compact review drawer resize path.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T22-35-19-250Z/`.

Next work:

- Continue prototype fidelity by reducing remaining card heaviness in the
  conversation and review drawer, especially the strong boxed message/activity
  surfaces visible in compact screenshots.
- Add a focused visual/layout assertion for long branch names and long model
  names with review open, since compact review now relies on aggressive chip
  truncation.

### Completed Slice: Compact Dense Conversation CDP Coverage

Status: completed in iteration 13.

Goal: extend the real Electron CDP harness so the dense assistant message state
is asserted at the lower supported desktop width, not only at the default
1240 px window size.

User-visible value: long assistant prose, file reference chips, action rows,
changed-file summaries, composer controls, sidebar rows, and the collapsed
terminal remain usable in compact desktop windows without horizontal overflow
or composer overlap.

Expected files:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `packages/desktop/src/renderer/styles.css`
- `.qwen/e2e-tests/electron-desktop/compact-dense-conversation.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The CDP harness resizes the real Electron window to the app minimum
  960x640-ish compact desktop size after the dense fake ACP assistant response
  is visible.
- The compact viewport still shows the workbench landmarks, compact sidebar,
  slim topbar, conversation, assistant message, file chips, message actions,
  changed-files summary, composer, and collapsed terminal strip.
- Assistant file chips and action buttons stay inside the assistant message and
  timeline; document width does not exceed the viewport.
- Composer controls wrap inside the composer instead of overflowing, and the
  composer remains contained above the terminal strip.
- The inline changed-files summary remains bounded in the timeline without
  horizontal overflow; at compact height it may require normal timeline
  scrolling rather than simultaneous visibility with the assistant card.
- The window is restored to the default desktop size before the rest of the
  smoke path continues.

Verification:

- Unit/component test command: no renderer unit changes expected.
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the fake
  command request, wait for the dense assistant response, assert the default
  dense assistant layout, resize the Electron window to the compact desktop
  bounds, assert compact geometry and overflow constraints, capture screenshot
  and JSON artifacts, restore the default window size, then continue the
  existing review/settings/terminal workflow.
- E2E assertions: compact viewport width is near 960 px; sidebar stays compact;
  topbar remains slim enough for the viewport; dense assistant chips,
  assistant actions, changed-files summary, composer, and terminal strip remain
  bounded; compact composer height stays below 154 px; console errors/failed
  local requests are absent.
- Diagnostic artifacts: compact dense conversation screenshot and JSON metrics,
  plus existing CDP screenshots, Electron log, and summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  density and overflow expectations; `electron-desktop-dev` for real Electron
  CDP window resizing and verification; `brainstorming` applied by selecting
  the smallest continuation from the recorded next-work item rather than
  introducing new product scope.

Notes and decisions:

- Electron 41 in this test environment does not expose
  `Browser.getWindowForTarget` through the remote debugger. The harness first
  attempts the browser-level CDP API and then falls back to `window.resizeTo`,
  recording a `window-resize-fallback-*.json` artifact when the fallback is
  used.
- The first compact run exposed a real density issue: the composer grew to
  about 176 px high at the compact viewport. The CSS now shortens the compact
  textarea and chips/selectors at the 960 px breakpoint, bringing the compact
  composer to about 127 px in the passing CDP artifact.
- At the compact height, the dense assistant card and changed-files summary can
  require normal timeline scrolling. The contract is that both remain bounded,
  discoverable, and free of horizontal overflow while the composer and terminal
  stay docked.

Verification results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP, including the compact dense conversation resize path.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-31-38-896Z/`.

Next work:

- Continue prototype fidelity by reducing remaining card heaviness in the
  conversation and changed-files summary so the compact viewport reads closer
  to `home.jpg`.
- Add a compact review-drawer CDP assertion so the 960 px width also proves the
  conversation and review drawer remain usable together.

### Completed Slice: Dense Assistant File Reference Overflow

Status: completed in iteration 12.

Goal: harden assistant prose file-reference rendering for realistic, dense
responses with repeated references, line/column suffixes, uncommon source file
extensions, and more references than can comfortably fit in the message card.

User-visible value: assistant responses stay compact and readable in the
conversation-first workbench while still exposing useful file chips for opening
referenced files. Repeated paths do not add visual noise, and overflow is
explicit instead of silently dropping references.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/main/acp/createE2eAcpClient.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/assistant-file-reference-overflow.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Assistant prose deduplicates repeated file references while preserving the
  first visible label.
- References with `:line:column` suffixes open the file path without the line
  suffix and keep the visible line/column label.
- Common desktop/code references such as `.mdx`, `.mts`, `.cts`, `.vue`,
  `.svelte`, `.astro`, `Dockerfile`, `Makefile`, `.env`, `.gitignore`, and
  `.npmrc` can render as chips when they appear in assistant prose.
- More than six references render the first six chips plus a compact overflow
  indicator with an accessible label.
- Long chips wrap/truncate within the assistant message at normal and compact
  widths without horizontal page overflow or composer overlap.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the fake
  command request, wait for the dense assistant response, assert deduped chips,
  line/column chips, overflow count, and contained chip geometry, then continue
  the existing copy/retry/review/settings/terminal smoke path.
- E2E assertions: assistant file chips include `README.md:1`,
  `packages/desktop/src/renderer/App.tsx:12:5`, `.env.example`,
  `Dockerfile`, and an overflow indicator; duplicate `README.md:1` references
  render once; every chip stays inside the assistant message/timeline; document
  scroll width does not exceed the viewport; console errors/failed local
  requests are absent.
- Diagnostic artifacts: CDP screenshots, dense assistant reference JSON,
  assistant action JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  chip density and overflow treatment; `electron-desktop-dev` for renderer
  changes and real Electron CDP verification; `brainstorming` applied by
  choosing the smallest continuation of the recorded rich-conversation backlog
  from repo artifacts and `home.jpg` without pausing the autonomous loop.

Notes and decisions:

- The prototype shows file/change context inline with the conversation, so this
  slice keeps file chips inside assistant messages rather than moving dense
  references into a separate drawer.
- Overflow uses a quiet text chip so the message remains readable and does not
  become a file browser.
- The fake ACP response includes deterministic dense references so the CDP
  harness can verify real Electron layout and dedupe behavior.
- The first focused component test exposed a line/column stripping bug where
  `path.ts:12:5` opened `path.ts:12`. The final implementation strips the
  full `:line:column` suffix for open-file callbacks while preserving the
  visible chip label.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 10 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-17-10-902Z/`.

Next work:

- Add a compact-viewport CDP pass or Browser bounds control for the dense
  conversation state so long assistant/file chips are also asserted near the
  lower supported desktop width.
- Continue rich conversation fidelity by adding clearer assistant action
  feedback for clipboard/open-file failures and by keeping multiple assistant
  messages dense at compact widths.

### Completed Slice: Assistant Message Actions and File Reference Chips

Status: completed in iteration 11.

Goal: add compact assistant message actions and clickable file-reference chips
inside the conversation timeline.

User-visible value: after an assistant response, users can copy the response,
reuse the last prompt, jump into changed-file review, and open referenced files
without leaving the workbench or reading protocol/debug output.

Expected files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/src/main/acp/createE2eAcpClient.ts`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/assistant-message-actions.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Assistant messages render a compact action row with Copy, Retry last prompt,
  and Open Changes when changed files exist.
- Retry last prompt is safe: it restores the previous user prompt into the
  composer instead of auto-sending a new agent request.
- File references in assistant prose, such as `README.md:1`, render as compact
  chips with an accessible open action.
- Copy and open actions use existing desktop-safe preload/browser APIs and do
  not expose ACP/session IDs in the main timeline.
- The message card stays within the conversation column and does not overlap
  the composer in real Electron.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send a prompt, approve the fake
  command request, wait for the assistant response, assert the assistant action
  row and file chip, copy the response, retry the last prompt into the
  composer, clear the retry draft, then continue the existing review/settings/
  terminal smoke path.
- E2E assertions: assistant message action row is present, the file chip shows
  `README.md:1`, Copy produces visible feedback, Retry restores the original
  prompt without auto-sending, Open Changes remains contextual, assistant
  geometry stays inside the timeline above the composer, and console errors/
  failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, assistant action JSON, retry composer
  JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  inline actions and file chip density; `electron-desktop-dev` for renderer
  changes and real Electron CDP verification; `brainstorming` applied by
  choosing the narrow conversation-first option from the repo plan and
  immutable prototype without pausing the autonomous Ralph loop.

Notes and decisions:

- The prototype shows response actions and changed-file controls in the
  reading flow, so the action row stays under assistant messages instead of
  becoming a toolbar or drawer.
- Retry is intentionally non-destructive and does not auto-send; it drafts the
  last user prompt in the composer so users can inspect or edit before sending.
- File reference chips reuse the existing project-relative open-file path and
  remain bounded so long paths cannot stretch the timeline.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 9 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-10-35-606Z/`.

Next work:

- Continue rich conversation primitives by adding clearer assistant feedback
  states for copy/retry failures and by supporting multiple dense assistant
  messages at compact viewport widths.
- Add a follow-up fake ACP scenario with longer assistant prose and several
  repeated file references to harden chip extraction, dedupe, and overflow.

### Completed Slice: Rich Tool-Call Activity Cards

Status: completed in iteration 10.

Goal: make completed and in-progress tool calls read as useful task activity
inside the conversation instead of a sparse tool row.

User-visible value: users can see what the agent did, what command/input was
used, which files were referenced, and whether the tool completed or failed
without reading ACP IDs or opening diagnostics.

Expected files:

- `packages/desktop/src/main/acp/createE2eAcpClient.ts`
- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/chatStore.test.ts`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/rich-tool-call-activity-cards.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Tool calls render as compact inline conversation activity cards with kind,
  title, status, and stable `data-testid` hooks.
- Tool cards show a bounded command/input preview when safe user-facing input
  is present.
- Completed or failed tool cards show a bounded output/result summary without
  exposing request/session IDs.
- File locations render as compact chips with path and optional line number.
- The previous generic `.chat-tool` row no longer appears for tool activity.
- Cards stay within the timeline and do not overlap the composer in real
  Electron.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send from the composer, approve the
  fake command request, then assert the resolved tool activity card includes
  command title, status, command preview, output summary, and file chips before
  continuing the existing review/settings/terminal smoke path.
- E2E assertions: activity card is present after approval, uses compact
  geometry inside the chat timeline, contains `README.md:1`, does not render
  the raw tool call ID or session ID, no legacy `.chat-tool` node remains, and
  console errors/failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, rich tool-call JSON, conversation
  summary JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  activity-card hierarchy and file chip density; `electron-desktop-dev` for
  renderer changes and real Electron CDP verification; `brainstorming` applied
  by deriving the slice from the repo plan and immutable prototype instead of
  asking ordinary product questions during the autonomous loop.

Notes and decisions:

- The prototype keeps agent activity in the reading flow, so this slice
  replaces the generic tool row with an inline card rather than adding another
  panel.
- The card intentionally surfaces title/kind/status, bounded input/output, and
  file locations only. ACP request IDs, session IDs, and transport details stay
  out of the main conversation.
- The fake ACP path will emit deterministic location/output data so the CDP
  harness can assert a real user-visible resolved tool card.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 13 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-57-31-788Z/`.

Next work:

- Continue rich conversation primitives by adding assistant message action rows
  for copy/retry/open changed files and by turning file references in assistant
  prose into compact open/reveal chips.
- Tighten tool-card density at compact viewport widths after adding a second
  fake ACP scenario with multiple file references and longer command output.

### Completed Slice: Inline Command Approval Cards

Status: completed in iteration 9.

Goal: make command approvals and ask-user prompts part of the conversation
timeline instead of a detached permission strip or protocol-like event row.

User-visible value: users see what command/action needs attention in the same
reading flow as the agent plan, tool activity, and changed-files summary. The
main conversation can answer "what needs me now?" without exposing ACP request
plumbing.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/chatStore.ts`
- `packages/desktop/src/renderer/stores/chatStore.test.ts`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/inline-command-approval-cards.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Pending command permissions render as compact inline conversation cards with
  command/tool title, optional command input, status, and approval/deny actions.
- Pending ask-user questions render inline with question text, options, and
  Cancel/Submit actions.
- The old permission strip is no longer rendered as a separate surface between
  the timeline and composer.
- Permission and ask-user server messages no longer append generic
  `Permission requested` or `Question requested` event rows to the timeline.
- Approval controls keep stable accessible labels and continue to send the
  same permission response.
- The composer remains docked and usable while a pending approval card is
  visible; changed-files summary still appears after the request resolves.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, send from the composer, assert the
  pending command approval appears as an inline conversation card with the fake
  command title/input and no separate permission strip, approve it, assert the
  card resolves away and the changed-files summary appears, then continue the
  existing review, settings, and terminal smoke path.
- E2E assertions: inline approval card is present before approval, has compact
  geometry within the chat timeline, exposes approval/deny actions, does not
  render protocol request events, and console errors/failed local requests are
  absent.
- Diagnostic artifacts: CDP screenshots, inline approval JSON, conversation
  summary JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained inline
  card density, action hierarchy, and conversation-first placement;
  `electron-desktop-dev` for renderer changes and real Electron CDP
  verification.

Notes and decisions:

- The prototype keeps approvals and task state in the reading flow, so this
  slice removes the separate permission strip instead of duplicating the same
  action in two places.
- The backing permission response contract remains unchanged; only renderer
  placement and noise filtering change.
- The inline card intentionally shows only the tool title/kind/status and a
  string or `command` preview from tool input; request IDs and session IDs stay
  out of the main conversation.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 11 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-47-26-492Z/`.

Next work:

- Continue rich conversation primitives by improving tool-call cards with
  file-reference chips, copy/retry/open actions, and clearer completed/failed
  command output summaries.
- Run another prototype fidelity pass on message density and assistant action
  rows now that approvals, changed files, terminal, review, and settings have
  all moved into supporting surfaces.

### Completed Slice: Settings Information Architecture

Status: completed in iteration 8.

Goal: make Settings read like product settings instead of a runtime debug
panel by grouping account, model provider, permission, tools, terminal,
appearance, and diagnostics controls.

User-visible value: users can find model/API key and permission controls
without seeing server URLs, Node versions, ACP state, active session IDs, or
other diagnostics in the default settings view. Advanced diagnostics remain
available when needed.

Expected files:

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/settings-information-architecture.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Settings defaults to product sections: Account, Model Providers,
  Permissions, Tools & MCP, Terminal, Appearance, and Advanced Diagnostics.
- The default settings view does not visibly expose server URL, Node version,
  ACP status, health milliseconds, settings path, or active session IDs.
- Model, Base URL, API key, OAuth, Save, and permission-mode controls remain
  reachable from the settings page.
- API key state is shown as configured/missing without rendering saved secret
  values in the DOM.
- Advanced Diagnostics can be opened explicitly and then shows runtime,
  session, and config diagnostic fields.

Verification:

- Unit/component test command:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx src/renderer/stores/settingsStore.test.ts`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, complete the existing composer,
  review, and commit path, open Settings, assert product sections are visible
  while diagnostics are hidden, edit model/Base URL/API key, save, assert the
  saved model appears without secret leakage, open Advanced Diagnostics, and
  assert runtime diagnostics are available only there.
- E2E assertions: settings replaces chat/review/terminal, default settings text
  excludes server URL, Node, ACP, active session ID, health ms, settings path,
  and the fake API key; Advanced Diagnostics renders the runtime diagnostics
  after an explicit click; console errors and failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, settings layout JSON, advanced
  diagnostics JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained product
  settings hierarchy and lower-noise surfaces; `electron-desktop-dev` for
  renderer changes and real Electron CDP verification.

Notes and decisions:

- The prototype treats Settings as supporting product chrome rather than a main
  debug dashboard, so diagnostics move behind an explicit Advanced action.
- This slice does not change settings persistence contracts; it reorganizes the
  renderer around the existing server/settings store APIs and keeps secrets out
  of rendered text.
- Settings remains a full workbench page for now, consistent with the previous
  verified behavior; this slice focuses on information architecture inside the
  page rather than converting Settings to a modal or drawer.
- The first CDP run reached Advanced Diagnostics but failed on a harness-only
  case-sensitive label assertion because diagnostic labels are rendered
  uppercase by CSS. The harness now asserts diagnostics case-insensitively.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx src/renderer/stores/settingsStore.test.ts`
  passed with 8 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-40-11-622Z/`.

Next work:

- Continue rich conversation primitives by rendering command approvals and tool
  activity inline in the timeline rather than only in the permission strip.
- Tighten settings density and responsive behavior further after the next
  conversation-first fidelity pass.

### Completed Slice: Conversation Changed-Files Summary and Protocol Noise Cleanup

Status: completed in iteration 7.

Goal: make the main conversation timeline feel like a product task flow by
hiding ACP/session protocol noise and surfacing Git changes inline.

User-visible value: users should not see internal session IDs or protocol stop
reasons in the main reading flow, and they can discover changed files from the
conversation itself instead of starting from the topbar.

Expected files:

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/stores/chatStore.ts`
- `packages/desktop/src/renderer/stores/chatStore.test.ts`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/conversation-changes-summary.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- The chat timeline no longer renders `Connected to <session id>` or
  `Turn complete: <stop reason>` event rows.
- Connection state remains available in the compact header/topbar rather than
  as protocol prose in the timeline.
- When the active project has Git changes, the conversation shows a compact
  changed-files summary with file names, staged/unstaged/untracked state, and
  addition/deletion totals.
- The inline summary opens the review drawer while keeping the conversation
  mounted.
- The summary hides itself when there are no changed files.

Verification:

- Unit/component test commands:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Build/typecheck/lint commands:
  `cd packages/desktop && npm run typecheck && npm run lint && npm run build`
- Real Electron harness:
  `cd packages/desktop && npm run e2e:cdp`
- Harness path: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- E2E scenario steps: launch real Electron with isolated HOME/runtime/user-data
  and fake ACP, open the fake Git project, create a composer-first thread,
  approve the fake command, assert protocol IDs and stop reasons are absent
  from the body text, assert the conversation changed-files summary is present,
  open review from that summary, then continue through discard cancel, stage,
  commit, settings, and terminal paths.
- E2E assertions: the body text does not contain `Connected to session-e2e`,
  `session-e2e-1`, or `Turn complete`; the inline summary reports the fake
  dirty files and opens the review drawer; console errors and failed local
  requests are absent.
- Diagnostic artifacts: CDP screenshots, conversation summary JSON, review
  layout JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained inline
  cards and conversation density; `electron-desktop-dev` for renderer changes
  and real Electron CDP verification.

Notes and decisions:

- The renderer still tracks connection state in `ChatState.connection` and the
  compact header/topbar, but `connected` and `message_complete` protocol
  messages no longer create timeline rows.
- The changed-files summary is derived from the active project Git diff instead
  of fake ACP payloads, so it appears whenever the review drawer would have
  meaningful content and disappears after commit/clean states.
- The inline summary opens the existing review drawer rather than introducing a
  separate review surface, keeping the first viewport conversation-first and
  consistent with `home.jpg`.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/chatStore.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 9 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-28-04-569Z/`.

Next work:

- Continue rich conversation primitives by rendering command approvals and tool
  activity as inline cards instead of relying mostly on the permission strip.
- Improve settings information architecture so runtime diagnostics move under
  Advanced and model/API key controls are reachable as product settings.

### Completed Slice: Review Safety Terminology and Discard Confirmation

Status: completed in iteration 6.

Goal: make the review drawer use Git-safe language and require explicit
confirmation before destructive discard operations.

User-visible value: users can review changed files without seeing ambiguous
`Accept`/`Revert` controls, and high-risk discard actions cannot be triggered
with one accidental click. This keeps review as a compact supporting surface
while preserving the conversation-first workbench shown in `home.jpg`.

Expected files:

- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- `packages/desktop/src/renderer/styles.css`
- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `.qwen/e2e-tests/electron-desktop/review-safety.md`
- `design/qwen-code-electron-desktop-implementation-plan.md`

Acceptance criteria:

- Review drawer controls use Stage/Discard terminology instead of
  Accept/Revert.
- Staged hunks/files show a staged state, and staging controls are disabled
  when already staged.
- Discard all/file/hunk actions open a confirmation UI that names the target,
  explains the local-change risk, and supports Cancel and confirmed discard.
- Canceling a discard leaves the Git worktree and review counts unchanged.
- Committing staged changes remains available from the same compact drawer.

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
  approve the fake command, open Changes, verify Stage/Discard language,
  initiate Discard All, cancel it, assert the workspace still has changes,
  stage all changes, commit, and continue through settings and terminal paths.
- E2E assertions: `Accept`/`Revert` labels are absent from the main review
  drawer; discard confirmation appears and can be canceled; modified/untracked
  counts remain after cancel; staged counts update after Stage All; console
  errors and failed local requests are absent.
- Diagnostic artifacts: CDP screenshots, review layout JSON, discard
  confirmation JSON, Electron log, summary JSON under
  `.qwen/e2e-tests/electron-desktop/artifacts/`.
- Required skills applied: `frontend-design` for prototype-constrained compact
  review actions, danger hierarchy, and confirmation wording;
  `electron-desktop-dev` for renderer changes and real Electron CDP
  verification.

Notes and decisions:

- The underlying server endpoint remains named `revert` for now; this slice
  changes product-facing language to `Discard` while keeping the existing
  reviewed backend contract.
- Confirmation stays inside the review drawer rather than using a native dialog
  so the CDP harness can assert the user path deterministically and the first
  viewport remains desktop-native.
- The first CDP run exposed a harness-only assertion mismatch: review counts
  render as definition rows while the topbar renders the combined dirty count.
  The harness now asserts both surfaces through their actual UI shapes.

Verification results:

- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 6 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed after launch through real
  Electron over CDP.
- Passing artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-18-14-754Z/`.

Next work:

- Continue conversation timeline fidelity by hiding session/protocol IDs such
  as `Connected to session-e2e-1` from the main user flow.
- Add inline changed-file summary cards in the conversation that open the
  review drawer without forcing users to start from the topbar.

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
