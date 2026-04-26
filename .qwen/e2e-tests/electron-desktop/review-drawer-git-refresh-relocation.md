# Review Drawer Git Refresh Relocation

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Move manual Git refresh out of the primary topbar action cluster and into the
review drawer header. The first viewport keeps the conversation-focused topbar
chrome while preserving a discoverable refresh action when users inspect
changes.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake dirty Git project and wait for the conversation-first
   workbench.
3. Inspect default and review-open topbar actions.
4. Open the review drawer and assert `Refresh Git` is available from the drawer
   header, not the topbar.
5. Continue the existing branch, discard cancel, stage, commit, settings,
   terminal, compact viewport, model, and composer workflows.

## Assertions

- Topbar action labels exclude `Refresh Git` in review-open layouts.
- Review drawer button labels include `Refresh Git`.
- The drawer refresh affordance is icon-only, accessible, and 28 px in the
  recorded desktop and compact layouts.
- Review-open desktop and compact layouts keep the topbar slim and the
  conversation wider than the review drawer.
- The harness records zero unexpected console errors and zero failed local
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
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T20-29-42-195Z/`

Key files:

- `review-drawer-layout.json`
- `review-drawer.png`
- `compact-review-drawer.json`
- `compact-review-drawer.png`
- `topbar-context-fidelity.json`
- `summary.json`

`review-drawer-layout.json` recorded topbar actions as `Conversation`,
`Close Changes`, and `Settings`, and review drawer buttons including
`Refresh Git` at 28x28 px. `compact-review-drawer.json` recorded the same
placement at 960x608 with no overflow and all containment checks passing.
`summary.json` recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

The CDP harness asserts placement and continued workflow behavior, but it does
not simulate an external Git mutation before clicking `Refresh Git`. Existing
Git refresh behavior remains covered through the unchanged handler path.
