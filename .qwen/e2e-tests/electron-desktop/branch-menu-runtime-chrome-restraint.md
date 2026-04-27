# Branch Menu and Runtime Chrome Restraint

Date: 2026-04-27

## Slice

Make the topbar branch menu and runtime status pill read as compact product
context rather than uppercase diagnostic chrome.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, runtime, user-data, and temp Git
   workspaces.
2. Open a fake project whose active branch has a long name.
3. Assert topbar geometry, compact branch trigger text, and normal-case runtime
   status styling.
4. Open the branch menu and assert long branch rows are visually truncated while
   preserving full names in `title` and `aria-label`.
5. Validate branch creation input, create a branch, reopen the menu, confirm a
   dirty-worktree branch switch, and verify Git status updates.
6. Continue the full smoke path through review, settings, model picker,
   terminal attach, commit, and relaunch recovery.

## Assertions

- Branch menu rows do not visibly include the raw long branch name.
- Branch row `title` and `aria-label` preserve the full branch name.
- Branch menu rows stay inside the menu and do not cause body overflow.
- Branch menu header, current marker, create label, and runtime pill report
  `text-transform: none` with restrained weights.
- Runtime status remains slim and contained in the topbar.
- Console errors and failed local requests are empty.

## Commands Run

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck && npm run lint && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

- Component test: 36 tests passed.
- Real Electron artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-26-22-276Z/`
- Key artifacts:
  - `topbar-context-fidelity.json`
  - `branch-create-menu.json`
  - `branch-switch-menu.json`
  - `branch-switch-confirmation.json`
  - `summary.json`

## Known Uncovered Risk

This slice keeps the native menu structure and does not add branch search or
keyboard roving focus. Extremely large local branch lists still rely on the
existing scrollable menu behavior.
