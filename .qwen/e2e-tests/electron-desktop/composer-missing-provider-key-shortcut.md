# Composer Missing Provider Key Shortcut

- Slice: Composer Missing Provider Key Shortcut
- Date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: Passed
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-28-52-626Z/`

## Scenario

1. Seed the isolated E2E HOME with a saved `qwen-e2e-cdp` API-key provider
   that has no stored key.
2. Launch the real Electron app with fake ACP and isolated HOME/runtime/user
   data paths.
3. Open the dirty E2E project.
4. Wait for the composer to show `qwen-e2e-cdp` as the selected saved model
   with missing API-key provider metadata.
5. Assert the compact Configure models shortcut beside the model picker is
   warning-styled and titled `Configure models - API key missing`.
6. Click Configure models and assert Settings opens directly to Model
   Providers with the provider selector focused.
7. Continue the existing settings, branch, review, commit, relaunch, model, and
   terminal smoke coverage.

## Assertions

- The composer model control title is
  `qwen-e2e-cdp · Saved API key provider · API key missing`.
- The model provider status dot uses missing-state metadata and stays inside
  the 124 x 24 px model control.
- The Configure models shortcut keeps aria-label `Configure models`, has no
  visible text, keeps a 24 x 24 px icon footprint, and carries
  `composer-model-settings-button-warning`.
- The composer, model control, shortcut, and document do not overflow.
- Fake API keys, Coding Plan keys, and local server URLs do not appear in
  visible text, field values, or artifact snapshots.
- The CDP summary recorded zero unexpected console errors and zero failed local
  requests.

## Artifacts

- `composer-missing-provider-key-shortcut.json`
- `composer-missing-provider-key-shortcut.png`
- `composer-model-settings-shortcut.json`
- `composer-model-settings-shortcut.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This slice does not yet let users change draft-thread model or permission mode
before first send. That remains a follow-up because it requires storing draft
runtime choices and applying them during session creation.
