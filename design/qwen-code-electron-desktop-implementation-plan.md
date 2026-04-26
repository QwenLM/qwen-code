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
