# Electron Desktop E2E: Safe Topbar Branch Creation

Date: 2026-04-26

## Slice

Safe Topbar Branch Creation.

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
4. Open the topbar branch menu and assert the compact create form is present.
5. Assert empty branch creation is disabled.
6. Create `desktop-e2e/new-branch-from-menu`.
7. Assert the topbar branch label and real repository branch switch to the new
   branch, while dirty status remains visible.
8. Reopen the menu, assert the new branch is marked current, then switch back
   to `main` through the existing dirty-worktree confirmation path.
9. Continue the existing review, discard-cancel, commit, settings, terminal,
   and terminal-attachment smoke paths.

## Assertions

- Branch creation stays inside the slim topbar branch menu.
- The create form, branch rows, and menu stay width-bounded.
- Empty branch creation is disabled before request submission.
- Server branch creation validates names and rejects duplicates/invalid refs in
  focused tests.
- Successful creation runs through the token-protected desktop server route,
  updates renderer state, refreshes diff/status, and switches the actual Git
  branch.
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
.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-47-05-265Z/
```

Important artifacts:

- `branch-create-menu.json`
- `branch-create-menu.png`
- `branch-create-validation.json`
- `branch-create-result.json`
- `branch-switch-menu.json`
- `branch-switch-result.json`
- `summary.json`
- `electron.log`

Failed diagnostic artifact retained for the fixed harness readiness issue:

```text
.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-38-07-376Z/
```

Intermediate passing artifact before the stale-row product cleanup:

```text
.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T02-39-03-398Z/
```

## Known Uncovered Risk

The real Electron path covers disabled empty submission and successful branch
creation. Duplicate and malformed branch names are covered by server tests but
not yet by an inline CDP error-state assertion.
