# Electron Desktop E2E: Sidebar and Topbar Density

- Slice: Sidebar and Topbar Chrome Density Pass
- Date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: passed
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-36-28-286Z/`
- Earlier failed artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-35-53-527Z/`

## Scenario Steps

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   temporary fake Git workspace.
2. Open the fake project through the desktop project picker flow.
3. Send a prompt from the composer, approve the deterministic command request,
   and wait for the fake ACP assistant result.
4. Assert sidebar and topbar geometry, typography, containment, and overflow at
   the default `1240x820` Electron window.
5. Continue the existing branch creation/switching, review drawer, compact
   review, settings, terminal, discard safety, and commit smoke workflows.

## Assertions

- Sidebar width is `252` px, below the previous `272` px baseline.
- Sidebar app/footer action rows are `28` px tall, below the previous `32` px
  baseline.
- Project row height is `32.6328125` px and thread row height is `32` px, below
  the previous `39.75`/`36` px baselines.
- Sidebar action/project/thread text is `12` px; section headings are `10` px;
  project/thread meta text is `9.5` px.
- Topbar height is `50` px, below the previous `54` px baseline.
- Topbar action buttons are `28x28`; runtime status is `65.6328125x28`.
- Long branch and Git status text remain present, clipped, and contained.
- No sidebar/topbar horizontal overflow, console errors, or failed local
  requests are recorded.

## Failure and Fix

The first run failed because project/thread button parents still inherited the
root `14` px font even though their visible child labels had been compacted.
The stylesheet now sets the project and thread row parent font size explicitly,
and the harness records both row parent and child text metrics.

## Artifacts

- `sidebar-app-rail.json`
- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `initial-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This pass is a density/fidelity slice, not a navigation redesign. The harness
still covers one project/thread pair; a future visual regression path should add
several recent projects and longer localized thread titles at compact width.
