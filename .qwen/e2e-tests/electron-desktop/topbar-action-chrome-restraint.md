# Electron Desktop E2E: Topbar Action Chrome Restraint

- Slice: Topbar Action Chrome Restraint
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: passed
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-16-34-459Z/`
- Earlier failed artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-16-01-286Z/`

## Scenario Steps

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and deterministic fake ACP data.
2. Open the temporary Git project through the desktop project picker flow.
3. Send a prompt from the composer, approve the deterministic command request,
   and wait for the assistant result and changed-files summary.
4. Assert the default topbar action, runtime status, branch, title, and diff
   metrics.
5. Open the review drawer at default and compact widths, then continue the
   existing settings, terminal, branch, discard safety, relaunch, and commit
   smoke paths.

## Assertions

- Topbar action buttons remain `28 x 28`, icon-led, accessible, and contained.
- Inactive topbar action backgrounds and borders stay at alpha `0`.
- The active topbar action frame stays subtle with background alpha `0.07` and
  border alpha `0.12`.
- Runtime status remains visible at `58.0546875 x 26`, with background alpha
  `0.055`, transparent borders, and normal-case text.
- The changed-files badge stays secondary at `13` px tall, background alpha
  `0.72`, and no overflow.
- Compact review keeps topbar actions `28 x 28` and records no topbar, review,
  composer, or document overflow.
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

## Failure and Fix

The first CDP run failed because the new assertion treated the inherited
computed font size on icon-only topbar buttons as visible chrome. The harness
was corrected to assert frame and badge visual weight instead.

## Artifacts

- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `compact-review-drawer.json`
- `compact-review-drawer.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

This slice verifies chrome weight and containment, not pixel-level equivalence
with `home.jpg`. The topbar still uses a stacked title/context layout; a future
slice should evaluate a single-row title/context arrangement at desktop width.
