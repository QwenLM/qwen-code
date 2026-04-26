# Recent Project Relaunch Recovery

- Slice: Recent Project Relaunch Recovery
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

## Scenario

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and fake ACP state.
2. Open a dirty fake project, then open a clean second project through the same
   Open Project control.
3. Switch back to the dirty project from the sidebar recent-project list.
4. Quit and relaunch Electron with the same isolated HOME and user-data paths.
5. Assert the relaunched app restores the sidebar-selected dirty project before
   continuing the existing branch, review, settings, terminal, model, composer,
   and commit workflows.

## Assertions

- Selecting a recent project persists that project as the first recent project
  without duplicating project paths in `desktop-projects.json`.
- After relaunch, the active sidebar row and topbar project both identify the
  dirty project, and the clean project remains present but inactive.
- The topbar restores the dirty project's compact `+2 -1` diff stat and full
  Git metadata, and the conversation changed-files summary is visible.
- The clean project remains clean and does not leak stale diff state into the
  active workbench.
- The real Electron run records no unexpected console errors or failed local
  requests.

## Commands

- Passed: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Passed: `git diff --check`
- Passed:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx`
- Passed: `cd packages/desktop && npm run typecheck`
- Passed: `cd packages/desktop && npm run lint`
- Passed: `cd packages/desktop && npm run build`
- Passed: `cd packages/desktop && npm run e2e:cdp`

## Result

Passed. The final real Electron CDP harness relaunched the app mid-run,
reconnected through CDP, verified recent-project recovery, and then completed
the existing branch, review, discard cancel, stage, commit, settings, terminal,
model, and composer workflows.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-51-16-222Z/`
- `project-relaunch-persistence.json`: dirty project active and first after
  relaunch, clean project inactive and second, persisted store has exactly both
  realpathed project paths, topbar `+2 -1`, and no body overflow.
- `project-relaunch-persistence.png`: relaunched workbench screenshot.
- `summary.json`: zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice relies on recent-project order for active-project recovery. It does
not add a separate active-project preference, which may still be useful if the
product later wants sidebar recency and active recovery to diverge.
