# Sidebar Section Label Restraint

Date: 2026-04-27

Slice: make the sidebar project-browser heading and count render as quiet
normal-case navigation labels instead of uppercase diagnostic chrome.

Executable coverage:

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

Scenario steps:

1. Launch real Electron with isolated HOME/runtime/user-data directories and
   deterministic fake ACP data.
2. Assert the initial first-viewport layout and sidebar heading computed
   styles.
3. Open the fake project and assert sidebar project/thread grouping, heading
   styles, app actions, Settings footer, compact rows, and overflow behavior.
4. Exercise sidebar Models and Search paths, then continue the existing
   conversation, review, terminal, settings, model, branch, relaunch, and
   commit CDP paths.

Assertions:

- Sidebar section headings report `text-transform: none` with compact font size
  and restrained weight.
- Sidebar section count text uses muted normal-case support styling and remains
  contained beside the Open Project icon action.
- Project/thread rows remain compact and do not expose raw long prompts, full
  paths, internal IDs, local server URLs, or raw long branch names.
- The CDP run records zero unexpected console errors and zero failed local
  requests.

Commands:

- Passed: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Passed:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Passed: `cd packages/desktop && npm run typecheck`
- Passed: `cd packages/desktop && npm run lint`
- Passed: `cd packages/desktop && npm run build`
- Passed: `cd packages/desktop && npm run e2e:cdp`

Result: passed.

Artifacts:

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-37-32-289Z/initial-layout.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-37-32-289Z/sidebar-app-rail.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-37-32-289Z/initial-workspace.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-37-32-289Z/summary.json`

Observed evidence:

- `initial-layout.json` recorded the sidebar heading at normal-case
  `textTransform: "none"`, 10 px font size, and 660 weight.
- `initial-layout.json` recorded the sidebar heading count at normal-case
  `textTransform: "none"`, 9.5 px font size, and 620 weight.
- `sidebar-app-rail.json` recorded no sidebar, app action, project list, thread
  list, or footer overflow and preserved compact project/thread text.
- `summary.json` recorded zero unexpected console errors and zero failed local
  requests.

Known uncovered risk:

- This slice checks computed style and containment, not pixel-level visual
  equivalence with `home.jpg`.
