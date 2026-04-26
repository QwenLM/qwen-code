# Model Configuration Workflow

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-47-01-812Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, fake
   ACP, and a dirty temporary Git workspace.
2. Open the fake project, type a first composer prompt, create a thread, and
   approve the fake command request.
3. Complete the existing review, discard-cancel safety, stage, and commit path.
4. Open Settings, save `qwen-e2e-cdp` with a fake API key and base URL, and
   assert the saved model is visible without exposing the secret.
5. Return to Conversation and select `qwen-e2e-cdp` from the composer model
   picker.
6. Continue through terminal expand, command execution, attach-to-composer, and
   send verification.

## Assertions

- The Settings default view includes product sections and keeps diagnostics
  behind Advanced.
- The API key input remains `type="password"` and is cleared after save.
- The fake API key is absent from settings text, composer text, input values,
  advanced diagnostics, and the model-switch artifact.
- The composer model picker is enabled for the active thread, includes both the
  fake ACP runtime model and the saved configured model, and switches to
  `qwen-e2e-cdp`.
- The conversation view after returning from Settings does not expose the local
  server URL.
- The composer stays contained in the chat panel and does not overflow after
  the model switch.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `settings-page.png`
- `settings-product-state.json`
- `settings-advanced-diagnostics.json`
- `composer-model-switch.json`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies the API-key model save and active-session model switch
using fake ACP. It does not yet cover Coding Plan model switching, invalid API
key validation, or keyboard-only navigation through the model picker.
