# Electron Desktop E2E: Topbar Context Fidelity

- Slice: Slim Topbar Context Prototype Fidelity
- Date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run build && npm run e2e:cdp`
- Result: passed
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-58-44-613Z/`
- Earlier failed artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-57-32-569Z/`

## Scenario Steps

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and a temporary Git workspace.
2. Create the temporary workspace on
   `desktop-e2e/very-long-branch-name-for-topbar-overflow-check`.
3. Open the project through the desktop UI.
4. Send the fake ACP prompt, approve the command request, and wait for the
   assistant result and changed-files summary.
5. Assert sidebar and topbar first-viewport layout, including the slim topbar
   context row.
6. Open review at default and compact widths, then continue the existing
   settings, terminal, discard confirmation, and commit smoke paths.

## Assertions

- Topbar does not render legacy segmented tabs or `.topbar-meta` pill chrome.
- Topbar height remains slim at `54` px.
- Long branch text is present in DOM text and visually contained.
- Context items have height `16` px, background alpha `0`, and zero border
  widths.
- Topbar icon buttons remain `30x30`.
- Runtime status remains visible and compact at `71.2578125x30`.
- Default compact composer remains bounded with the long branch, recording
  height `126.890625`.
- No console errors or failed local network requests were recorded.

## Failure and Fix

The first CDP run failed at
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-57-32-569Z/` because
the long branch pushed the compact composer to `158.890625` px, above the
existing `154` px density limit. The fix tightened compact composer chip/select
widths and kept default compact composer controls on one row.

## Known Uncovered Risk

This harness verifies display of a long current branch, but it does not yet
exercise opening a branch dropdown or switching branches. That remains the next
workflow slice.
