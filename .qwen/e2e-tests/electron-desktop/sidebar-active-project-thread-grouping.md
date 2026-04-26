# Sidebar Active Project Thread Grouping

Date: 2026-04-27

Slice: group the active project's thread list beneath the active project row so
the populated sidebar reads closer to the `home.jpg` project/thread browser.

Executable harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP.
2. Open the dirty fake Git project, switch to the clean project, then switch
   back to the dirty project.
3. Relaunch and recover the selected dirty project from the recent-project
   store.
4. Send the fake ACP prompt, approve the command, and wait for the created
   thread to populate the sidebar.
5. Inspect sidebar geometry and hierarchy through CDP, then continue the
   existing branch, review, settings, terminal, relaunch, and compact viewport
   workflow.

Assertions:

- `project-list` and `thread-list` landmarks are present.
- `thread-list` is contained by `project-list`.
- `thread-list` is contained by `sidebar-active-project-group`.
- The visible sidebar has a single `Projects` heading and no standalone
  `Threads` section heading.
- Project rows keep compact branch and dirty metadata without exposing the raw
  long branch in visible text.
- The active thread row shows `Review README.md after the failing test` without
  local endpoint tails, protocol IDs, full paths, or session IDs.
- Sidebar rows and regions do not overflow horizontally.
- Console errors and failed local requests are empty.

Commands run:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- `cd packages/desktop && npm run typecheck`
- `cd packages/desktop && npm run lint`
- `cd packages/desktop && npm run build`
- `cd packages/desktop && npm run e2e:cdp`

Result:

- Pass.
- Artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-24-04-149Z/`

Key artifact notes:

- `sidebar-app-rail.json` recorded `headingLabels: ["Projects"]`,
  `threadListInsideProjectList: true`,
  `threadListInsideActiveProject: true`, a 244 px sidebar, a 28 px active
  thread row, and no row overflow.
- `summary.json` recorded `consoleErrors: []` and `failedRequests: []`.
- `topbar-context-fidelity.png` shows the active thread indented under the
  active project row with the inactive project row still visible below.

Known uncovered risk:

- The renderer still receives session summaries only for the active project, so
  inactive projects cannot yet show their own recent thread previews in the
  grouped browser.
