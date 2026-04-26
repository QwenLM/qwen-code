# Topbar Diff Stat Affordance

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Replace the visible topbar dirty-count label with compact line-level diff
counts when the active project's review diff is loaded. The first viewport now
matches the `home.jpg`-style `+N -M` affordance while preserving file-count Git
details in title and accessible metadata.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake Git project on a long branch with one modified tracked file
   and one untracked file.
3. Send the fake prompt, inspect topbar context geometry, visible diff stats,
   addition/deletion styling, and Git metadata.
4. Create a branch, switch back to `main` with dirty worktree confirmation,
   open review, cancel discard, stage all changes, and commit.
5. Continue the existing settings, model, terminal, compact viewport, and
   composer follow-up workflows.

## Assertions

- The visible topbar Git status shows `+2 -1` instead of `2 dirty`.
- The full Git breakdown remains in title and `aria-label`, including
  `1 modified · 0 staged · 1 untracked · Diff +2 -1`.
- Addition and deletion values use distinct diff-stat colors.
- The review action badge still shows the changed-file count.
- Stage All updates review counts to modified `0`, staged `2`, untracked `0`
  while the topbar keeps the diff-stat affordance and updated metadata.
- Branch creation/switching, discard cancel, commit, settings, terminal, model,
  and composer paths pass with zero console errors and zero failed local
  requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
git diff --check
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-09-47-255Z/`

Key files:

- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `review-stage-all-result.json`
- `branch-create-result.json`
- `branch-switch-result.json`
- `summary.json`

`topbar-context-fidelity.json` recorded visible Git status `+2 -1`, preserved
the full long branch in branch metadata, kept the topbar at 50 px, and recorded
no document overflow. `review-stage-all-result.json` recorded staged counts of
`0 modified`, `2 staged`, and `0 untracked` after Stage All while the topbar
metadata contained `Diff +2 -1`. `summary.json` recorded zero console errors
and zero failed local requests.

## Known Uncovered Risk

This slice clears stale review diff data on project selection, but the CDP
harness still opens a single fake recent project. A future project-switching
scenario should assert that old diff stats never flash when multiple projects
are present.
