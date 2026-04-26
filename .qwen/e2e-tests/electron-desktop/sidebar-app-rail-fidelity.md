# Sidebar App Rail Prototype Fidelity

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-46-17-523Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP response and changed-files summary.
5. Assert the left sidebar uses compact top app actions, project/thread browser
   sections, and a persistent bottom Settings row.
6. Continue the existing assistant actions, changed-files summary, review
   drawer, compact layout, settings, terminal, discard safety, and commit smoke
   path.

## Assertions

- `data-testid="sidebar-app-actions"` and
  `data-testid="sidebar-footer-settings"` are present in the real Electron DOM.
- Top app action labels are `New Thread`, `Open Project`, and `Models`.
- The old `.sidebar-toolbar` is absent.
- Bottom Settings is below the project/thread browser and contained in the
  sidebar.
- Sidebar width stays compact at `272` px in the default viewport.
- App action rows are `32` px high, the project row is `39.75` px high, and the
  thread row is `36` px high.
- Sidebar rows and regions have no horizontal overflow.
- Sidebar text does not expose fake ACP session IDs, `Connected to ...`
  protocol text, or temp full paths.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `sidebar-app-rail.json`
- `initial-workspace.png`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers one project, one thread, and bounded labels. A dedicated
long-label CDP path is still needed for very long project names, branch names,
model names, and review-open compact widths.
