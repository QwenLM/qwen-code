# Topbar Context Meta Restraint

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Shorten visible topbar project context so the slim workbench header stays close
to `home.jpg`. Long branch names are compact in the first viewport, and verbose
modified/staged/untracked Git diagnostics are replaced with a bounded summary.
Full details remain available through title and accessible metadata.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake Git project on a deliberately long branch with one modified
   file and one untracked file.
3. Send the fake prompt, inspect topbar context geometry and metadata, then
   exercise branch creation and dirty branch switching.
4. Continue the existing review drawer, discard cancel, stage/commit, settings,
   model, terminal, and composer follow-up workflows.

## Assertions

- The visible branch trigger shows a shortened label such as
  `desktop-e2e/very...rflow-check`.
- The full branch remains in the branch trigger title and `aria-label`, and the
  branch menu still lists the full branch name.
- The visible Git status renders compact text such as `2 dirty` or `2 staged`.
- The full Git breakdown remains in the Git status title and `aria-label`.
- The topbar remains 50 px tall, uses icon-sized actions, avoids heavy pill
  chrome, and records no horizontal document overflow.
- Branch creation, branch switching, review, settings, terminal, and composer
  paths still pass with zero console errors and zero failed local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-56-51-507Z/`

Key files:

- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `branch-create-result.json`
- `branch-switch-result.json`
- `summary.json`

`topbar-context-fidelity.json` recorded `visibleHasLongBranch: false`, branch
metadata preserving the full long branch, visible Git status `2 dirty`, and a
full Git title of `1 modified · 0 staged · 1 untracked`. `summary.json`
recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice constrains the current text labels. It does not add a searchable
branch picker, remote branch metadata, or diff line-count summaries such as the
`+N -N` affordance visible in the prototype.
