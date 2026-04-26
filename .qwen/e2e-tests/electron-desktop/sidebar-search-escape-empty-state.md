# Sidebar Search Escape and Empty State

Date: 2026-04-27

Slice: close sidebar search with Escape and show a single compact no-results
row when a filter matches neither projects nor active-project threads.

Executable harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP.
2. Open the dirty fake Git project, switch to the clean project, switch back,
   and relaunch to verify recent-project persistence.
3. Send the fake ACP prompt, approve the command, and wait for the populated
   active thread.
4. Toggle sidebar Search and filter to `Review README`.
5. Clear the query, then filter to `no-sidebar-match`.
6. Press Escape while the search input is focused.
7. Continue the existing branch, review, settings, terminal, relaunch, and
   compact viewport workflows.

Assertions:

- Filtering to `Review README` still isolates the dirty project and compact
  active thread title.
- Filtering to `no-sidebar-match` renders exactly one
  `No matching projects or threads` row, zero project rows, zero thread rows,
  and no duplicate `No matching threads` row.
- The no-results row is compact, muted, non-overflowing, and does not expose
  local endpoints, protocol IDs, full paths, or session IDs.
- Escape closes Search, clears the search mode pressed state, and restores both
  project rows plus the active thread row.
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
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-51-05-931Z/`

Key artifact notes:

- `sidebar-search-filter.json` recorded the no-match value
  `no-sidebar-match`, one `No matching projects or threads` row at 26 px tall,
  no project/thread rows while filtered, no overflow, and no diagnostic
  leakage.
- `sidebar-search-filter.json` also recorded Escape closing search with
  `aria-pressed="false"`, two project rows restored, and the active thread row
  restored.
- `summary.json` recorded `consoleErrors: []` and `failedRequests: []`.

Known uncovered risk:

- Search still only filters active-project threads until the desktop server
  exposes a cross-project session index.
