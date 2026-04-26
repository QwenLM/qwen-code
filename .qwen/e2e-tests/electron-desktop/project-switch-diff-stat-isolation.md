# Project Switch Diff Stat Isolation

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Harden the recent-project workflow so the compact topbar diff stat is scoped to
the active project. The real Electron harness now opens a dirty project, opens a
clean second project, verifies no stale `+N -M` diff stat leaks into the clean
project, then switches back to the dirty project and verifies its diff summary
returns.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Unit test:
  `packages/desktop/src/main/native/e2eSelectDirectory.test.ts`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, and fake ACP.
2. Configure the E2E-only directory selector with two temp Git workspaces.
3. Open the dirty project and wait for the topbar `+2 -1` diff stat.
4. Open the clean project through the same Open Project control.
5. Assert the clean project shows `Clean`, has no topbar diff-stat node, and has
   no conversation changed-files summary from the prior project.
6. Switch back to the dirty project from the sidebar.
7. Assert `+2 -1`, full Git metadata, and the changed-files summary return.
8. Continue the existing branch, review, settings, model, terminal, and composer
   CDP workflow.

## Assertions

- E2E directory selection supports multiple deterministic paths and repeats the
  final path for backward-compatible single-project flows.
- Exactly one sidebar project row is active after each switch.
- The clean project row is compact, on `main`, and has no dirty badge.
- The dirty project row keeps the shortened long branch and `2 dirty` metadata.
- The clean topbar records `Git status: Clean` and no `topbar-diff-stat`.
- The dirty topbar records `+2 -1` and metadata containing
  `1 modified · 0 staged · 1 untracked · Diff +2 -1`.
- Real Electron completed with zero console errors and zero failed local
  requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/main/native/e2eSelectDirectory.test.ts src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
git diff --check
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-20-30-259Z/`

Key files:

- `project-switch-clean-git-status.json`
- `project-switch-clean-git-status.png`
- `project-switch-dirty-git-status.json`
- `project-switch-dirty-git-status.png`
- `summary.json`

`project-switch-clean-git-status.json` recorded topbar text `Clean`, title
`Git status: Clean`, no topbar diff-stat node, no conversation changed-files
summary, two recent project rows, and no document overflow.

`project-switch-dirty-git-status.json` recorded topbar text `+2 -1`, title and
aria metadata containing `1 modified · 0 staged · 1 untracked · Diff +2 -1`,
the changed-files summary present again, and the dirty workspace still carrying
`README.md` plus `notes.txt` changes.

`summary.json` recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

The harness verifies project switching with deterministic fake ACP and local
Git repositories. It does not yet cover persisted recent projects across a full
app restart.
