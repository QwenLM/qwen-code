# Draft Runtime Controls Apply On First Send

- Slice: Draft Runtime Controls Apply On First Send
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: Passed
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-46-03-770Z/`

## Scenario

1. Seed the isolated E2E HOME with a saved `qwen-e2e-cdp` API-key provider
   that has no stored key.
2. Launch the real Electron app with fake ACP and isolated HOME/runtime/user
   data paths.
3. Open the E2E project with no selected thread and assert the draft composer
   runtime controls are enabled.
4. Assert the draft permission mode offers compact `default`, `auto-edit`,
   `plan`, and `yolo` choices.
5. Assert the draft model picker selects the saved provider model, keeps
   missing-key health metadata, and remains provider-grouped.
6. Switch draft permission mode to `auto-edit`.
7. Send the first prompt, wait for fake ACP command approval, and assert the
   active session composer now shows `auto-edit` and `qwen-e2e-cdp`.
8. Continue the existing approval, conversation, settings, branch, review,
   terminal, relaunch, model, and commit smoke coverage.

## Assertions

- Draft mode and model controls are enabled before a session exists when a
  project is active.
- Draft control labels remain compact and no raw Coding Plan provider prefix is
  visible.
- The draft composer keeps the `New thread` notice until send.
- Lazy session creation applies the selected model and mode before the prompt
  reaches fake ACP.
- The active session composer no longer shows `New thread`, keeps the selected
  `auto-edit` mode, and keeps the saved provider model selected.
- Saved-provider health metadata refreshes when Settings later changes key
  state, avoiding stale `API key missing` state after a provider is configured.
- Fake API keys, Coding Plan keys, and local server URLs do not appear in
  visible text, field values, or artifact snapshots.
- The CDP summary recorded zero unexpected console errors and zero failed local
  requests.

## Artifacts

- `draft-runtime-controls.json`
- `draft-runtime-controls-selected.json`
- `draft-runtime-controls-selected.png`
- `draft-runtime-controls-applied.json`
- `draft-composer-saved-model-state.json`
- `settings-permissions-provider-health.json`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This slice does not add live credential validation before first send. Selecting
a saved provider with a missing key is now faithfully applied to the session,
but the resulting agent request may still fail until the user configures the
provider key.
