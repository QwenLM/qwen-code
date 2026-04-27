# No-Project Open Project Composer Affordance

- Slice: No-Project Open Project Composer Affordance
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: Passed
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-57-00-235Z/`

## Scenario

1. Launch the real Electron app with isolated HOME/runtime/user-data paths and
   no active project.
2. Assert the conversation empty state stays quiet and near the composer.
3. Assert the disabled composer shows a compact `Open Project` action in the
   action cluster while keeping text entry and Send disabled.
4. Assert the sidebar only shows the no-folder state and does not render a
   duplicate `No sessions` row.
5. Click the composer `Open Project` action and use the existing native
   project-open path to select the fake E2E workspace.
6. Assert the normal project-scoped composer becomes enabled, then continue the
   existing model, settings, branch, review, terminal, relaunch, and commit
   smoke coverage.

## Assertions

- The composer `Open Project` action is a button with accessible label/title,
  icon plus label, 109.9 x 26 px geometry, and no overflow.
- The textarea placeholder and quiet conversation empty copy remain
  `Open a project to start`.
- The disabled Send control stays neutral rather than appearing as the primary
  startup action.
- The sidebar no-project state contains one quiet empty row and no
  thread-list/no-session noise.
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

This slice does not change the native directory picker itself or recent-project
persistence. If the native dialog is canceled, the composer remains in the same
no-project state.
