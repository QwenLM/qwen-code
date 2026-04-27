# No-Project Sidebar Open Project Affordance

- Slice: No-Project Sidebar Open Project Affordance
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: Passed
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-38-25-406Z/`

## Scenario

1. Launch the real Electron app with isolated HOME/runtime/user-data paths and
   no active project.
2. Assert the no-project sidebar project browser shows a compact actionable
   `Open Project` row with an icon, accessible label, and title.
3. Assert the disabled composer still shows its existing compact `Open Project`
   action while text entry and Send remain disabled.
4. Assert the passive `No folder selected` row and duplicate thread/no-session
   noise are absent.
5. Click the sidebar `Open Project` row and use the existing native project-open
   path to select the fake E2E workspace.
6. Assert the normal project-scoped composer becomes enabled, then continue the
   existing model, settings, branch, review, terminal, discard safety, compact
   viewport, and commit smoke coverage.

## Assertions

- The sidebar `Open Project` action is a button with accessible label/title,
  icon plus label, 227 x 28 px geometry, transparent default chrome, and no
  overflow.
- The composer `Open Project` action remains contained at 109.9 x 26 px and the
  disabled Send control stays visually neutral.
- The textarea placeholder and quiet conversation empty copy remain
  `Open a project to start`.
- The sidebar no-project state contains one compact action row and no
  `No folder selected` or `No sessions` text.
- The document and composer do not overflow.
- The CDP summary recorded zero unexpected console errors and zero failed local
  requests.

## Artifacts

- `no-project-open-project-affordance.json`
- `initial-layout.json`
- `initial-workspace.png`
- `project-composer.json`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This slice reuses the existing project picker callback. It does not change
native dialog cancellation behavior or recent-project persistence.
