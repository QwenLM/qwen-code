# No-Project Conversation Empty Action

- Slice: No-Project Conversation Empty Action
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: Passed
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-47-11-149Z/`

## Scenario

1. Launch the real Electron app with isolated HOME/runtime/user-data paths and
   no active project.
2. Assert the conversation empty state keeps the visible copy
   `Open a project to start` and exposes one compact icon-only `Open Project`
   action with accessible label and title.
3. Assert the disabled composer still shows its compact labeled `Open Project`
   action while text entry and Send remain disabled.
4. Assert the sidebar still shows the compact project-browser `Open Project`
   row and does not render passive `No folder selected` or `No sessions` rows.
5. Click the conversation empty-state action and select the fake Git workspace
   through the existing project-open route.
6. Continue the existing model, settings, branch, review, terminal, discard
   safety, compact viewport, and commit smoke coverage.

## Assertions

- The conversation empty-state action is a button with accessible label/title,
  icon-only text, 24 x 24 px geometry, transparent default chrome, and no
  overflow.
- The empty-state copy remains exactly `Open a project to start`.
- The composer `Open Project` action remains contained at 109.9 x 26 px and the
  disabled Send control stays visually neutral.
- The sidebar `Open Project` action remains a compact 227 x 28 px row with no
  duplicate passive empty rows.
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
native dialog cancellation behavior, recent-project persistence, or no-project
terminal strip behavior.
