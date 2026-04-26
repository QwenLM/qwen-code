# Sidebar Models Settings Entry

Date: 2026-04-27

Slice: make the sidebar Models command open Settings directly at Model
Providers while preserving the general Settings entry behavior.

Executable harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch real Electron with isolated HOME, runtime, user-data, and fake ACP.
2. Open the dirty fake Git project and create the fake ACP active thread.
3. Assert the sidebar app rail is present, compact, and contains Models.
4. Click sidebar Models.
5. Assert the settings drawer opens with Model Providers targeted and the model
   provider selector focused.
6. Close Settings and continue the existing sidebar search, branch, review,
   settings, terminal, relaunch, and compact viewport workflows.

Assertions:

- Settings opens as the existing right-side dialog with
  `data-initial-section="settings-model-providers"`.
- The `Model provider` selector is focused and visible in the drawer.
- The sidebar Models action remains icon-led, compact, and non-overflowing.
- Runtime diagnostics stay closed by default.
- Fake API key values are not visible or retained in DOM field values.
- Console errors and failed local requests are empty.

Commands run:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- `cd packages/desktop && npm run typecheck`
- `cd packages/desktop && npm run lint`
- `cd packages/desktop && npm run build`
- `cd packages/desktop && npm run e2e:cdp`
- `npm run build`
- `npm run typecheck`

Result:

- Pass.
- Artifacts:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-01-50-592Z/`
- Root `npm run build` passed with existing vscode companion lint warnings
  only; root `npm run typecheck` passed.

Key artifact notes:

- `sidebar-models-settings-entry.json` recorded
  `initialSection: "settings-model-providers"`, `providerFocused: true`, and
  `runtimeDiagnosticsPresent: false`.
- The same artifact recorded no visible fake secrets, no retained fake secret
  values, no document overflow, no settings overflow, and a compact Models
  action with an icon and no direct text-node overflow.
- `summary.json` recorded `consoleErrors: []` and `failedRequests: []`.

Known uncovered risk:

- The composer model picker still does not provide an inline shortcut to Model
  Providers when provider settings are missing or invalid.
