# Compact Review Drawer

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T22-35-19-250Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP assistant response and changed-files summary.
5. Open Changes as the review drawer and assert the default drawer layout.
6. Resize the real Electron window to the compact desktop bounds near 960 px.
7. Assert compact review, conversation, composer, topbar, and terminal
   geometry.
8. Restore the default window size and continue the review safety, commit,
   settings, and terminal workflow.

## Assertions

- Compact viewport resolved to 960x608 content pixels.
- Sidebar stayed compact at 236 px, topbar stayed 58 px, and the terminal strip
  stayed collapsed at 54 px.
- Review drawer stayed bounded at 304 px while the conversation remained wider
  at 420 px.
- Composer stayed inside the conversation at 400x125 px, with the textarea
  capped to 44 px in the compact review-open state.
- Review tabs, changed-file rows, diff hunks, action groups, and commit controls
  did not introduce horizontal overflow.
- Required review actions remained available: Discard All, Stage All, Open,
  Discard File, Stage File, Discard Hunk, Stage Hunk, Add Comment, and Commit.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `compact-review-drawer.json`
- `compact-review-drawer.png`
- `review-drawer-layout.json`
- `review-drawer.png`
- `window-resize-fallback-960x640.json`
- `window-resize-fallback-1240x820.json`
- `electron.log`
- `summary.json`

## Failed Run Fixed

The first run failed at
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T20-04-36-025Z/`
because the compact review-open textarea measured about 71 px. The fix pins
that scoped textarea to 44 px with internal scrolling, reducing composer height
while preserving the composer controls.

## Known Uncovered Risk

This slice covers the normal fake branch/model/project names. Long branch names
and long model names with review open still need a focused compact layout
assertion.
