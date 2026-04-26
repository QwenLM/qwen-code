# Sidebar Search and Project Heading Actions

Date: 2026-04-27

Slice: add a compact app-level Search entry to the sidebar and move Open Project
into the Projects heading as an icon-led action.

Executable harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP.
2. Open the dirty fake Git project, switch to the clean project, switch back,
   and relaunch to verify recent-project persistence.
3. Send the fake ACP prompt, approve the command, and wait for the populated
   active thread.
4. Inspect the sidebar app rail and Projects heading action.
5. Toggle Search, filter to `Review README`, clear the search, close Search,
   then continue the existing branch, review, settings, terminal, and compact
   viewport workflows.

Assertions:

- App actions are `New Thread`, `Search`, and `Models`.
- `Open Project` is an icon-led Projects heading action with no visible text.
- `Search projects and threads` is focused after Search opens.
- Filtering to `Review README` shows one active project row and the compact
  active thread title `Review README.md after the failing test`.
- Filtering hides the clean project row, does not overflow, and does not expose
  local endpoints, protocol IDs, full paths, or session IDs.
- Clearing Search restores both recent project rows and the grouped active
  thread.
- Console errors and failed local requests are empty.

Commands run:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `git diff --check`
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- `cd packages/desktop && npm run typecheck`
- `cd packages/desktop && npm run lint`
- `cd packages/desktop && npm run build`
- `cd packages/desktop && npm run e2e:cdp`

Result:

- Pass.
- Artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-43-42-259Z/`

Key artifact notes:

- `sidebar-app-rail.json` recorded app actions `New Thread`, `Search`, and
  `Models`, plus a 20 px icon-only Open Project heading action.
- `sidebar-search-filter.json` recorded a 28 px search container, a 22 px input,
  focused input state, one filtered active project row, one filtered active
  thread row, and no sidebar/search/thread row overflow.
- `summary.json` recorded `consoleErrors: []` and `failedRequests: []`.

Known uncovered risk:

- Search can only filter threads for the active project until the desktop server
  exposes a cross-project session index.
