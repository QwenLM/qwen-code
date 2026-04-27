# Electron Desktop E2E: Topbar Single-Line Context

- Slice: Single-Line Topbar Context Alignment
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: passed
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-29-07-726Z/`

## Scenario Steps

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and deterministic fake ACP data.
2. Open the temporary Git project through the desktop project picker flow.
3. Send a prompt from the composer, approve the deterministic command request,
   and wait for the assistant result and changed-files summary.
4. Assert the default topbar title, project, connection, branch, diff, action,
   and runtime metrics.
5. Continue the existing settings, terminal, branch switching, discard safety,
   compact viewport, review drawer, relaunch, and commit smoke paths.

## Assertions

- The topbar remains within the 46-52 px slim header target.
- At default desktop width, `topbar-title` and `topbar-context` share one
  visual row with bounded center delta, vertical overlap, and title-stack
  height.
- Thread title, project label, connection status, branch control, and diff stat
  stay visible, compact, contained, and non-overflowing.
- Long branch text remains truncated in visible chrome while full branch and
  Git status details stay in titles and accessible labels.
- The CDP summary records zero unexpected console errors and zero failed local
  requests.

## Commands

- Passed: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Passed:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Passed: `cd packages/desktop && npm run typecheck`
- Passed: `cd packages/desktop && npm run lint`
- Passed: `cd packages/desktop && npm run build`
- Passed: `cd packages/desktop && npm run e2e:cdp`
- Passed: `git diff --check`

## Result Notes

- `topbar-context-fidelity.json` recorded a 50 px topbar, title stack height
  `15`, title/context center delta `0`, vertical overlap `14`, and no visible
  long-branch leak.
- `compact-review-drawer.json` recorded the compact review viewport with
  `28 x 28` topbar actions and no topbar, review, composer, or document
  overflow.
- `branch-create-menu.json` recorded `menuHitTestVisible: true` so the branch
  popover is not clipped by the single-line title/context layout.
- `summary.json` recorded zero unexpected console errors and zero failed local
  requests.

## Artifacts

- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `compact-review-drawer.json`
- `compact-review-drawer.png`
- `branch-create-menu.json`
- `branch-create-menu.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

This slice verifies row geometry and containment in the default CDP viewport,
not pixel-level equivalence with `home.jpg` or every possible localized string.
