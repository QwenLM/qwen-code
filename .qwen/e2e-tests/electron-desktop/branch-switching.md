# Electron Desktop E2E: Safe Topbar Branch Switching

Date: 2026-04-26

## Slice

Safe Topbar Branch Switching.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Server/component tests:
  `packages/desktop/src/server/index.test.ts` and
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP.
2. Open the fake Git project on
   `desktop-e2e/very-long-branch-name-for-topbar-overflow-check`.
3. Send a prompt and approve the fake command request.
4. Open the topbar branch menu.
5. Assert the current long branch and `main` are listed, the current branch is
   marked, the menu and rows are width-bounded, and the worktree is marked
   dirty.
6. Choose `main`, assert dirty-worktree confirmation, then confirm.
7. Assert the topbar branch label and actual repository branch update to
   `main`, while dirty status remains visible.
8. Continue the existing review, discard-cancel, commit, settings, terminal,
   and terminal-attachment smoke paths.

## Assertions

- Branch menu opens from the slim topbar branch control.
- Menu width stays compact and inside the viewport.
- Long branch rows truncate inside the menu; `escapedRows` must be empty.
- Dirty branch switching requires explicit confirmation.
- Confirmed checkout updates renderer state and the real Git branch.
- No unexpected console errors or failed local requests are recorded.

## Commands

```bash
cd packages/desktop && SHELL=/bin/bash npx vitest run src/server/index.test.ts src/renderer/components/layout/WorkspacePage.test.tsx
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Pass.

Passing artifact directory:

```text
.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-25-14-829Z/
```

Important artifacts:

- `branch-switch-menu.json`
- `branch-switch-menu.png`
- `branch-switch-confirmation.json`
- `branch-switch-result.json`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

This slice covers local branch list and checkout only. Remote branches and
checkout conflict copy remain future work. Branch creation is now covered by
`.qwen/e2e-tests/electron-desktop/branch-creation.md`.
