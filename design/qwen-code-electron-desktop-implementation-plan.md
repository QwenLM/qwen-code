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
