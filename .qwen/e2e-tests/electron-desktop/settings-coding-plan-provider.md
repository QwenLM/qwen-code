# Settings Coding Plan Provider

- Slice name: Settings Coding Plan Provider Path
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-10-44-501Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Complete the carried open-project, composer-first send, command approval,
   branch, review, discard-cancel, commit, and API-key model settings paths.
3. Open Settings and focus the model provider control by accessible label.
4. Switch the provider to Coding Plan, assert Coding Plan-specific validation,
   and confirm the API-key model/base-url fields are replaced by the region
   selector.
5. Select the global Coding Plan region, enter a fake Coding Plan key, save,
   and verify the saved provider state clears the secret field.
6. Open Advanced Diagnostics and verify runtime diagnostics remain hidden until
   requested and do not expose either fake secret.
7. Return to Conversation and switch the composer model back to the previously
   configured API-key model.

## Assertions

- The provider field receives focus with active label `Model provider`.
- Coding Plan validation renders:
  `Enter a Coding Plan API key to save this provider.`
- Coding Plan mode shows a region selector, hides provider model/base URL
  inputs, and keeps the API key input as `type="password"`.
- Save is disabled before a Coding Plan key is entered and enabled after the
  fake key is entered.
- Saved state reports provider `coding-plan`, region `global`, Coding Plan key
  `Configured`, and API-key field length `0`.
- Visible settings text, Advanced Diagnostics, and the composer model-switch
  path do not expose `sk-desktop-e2e` or `cp-desktop-e2e`.
- The composer model picker remains enabled and can switch to `qwen-e2e-cdp`
  after Coding Plan saves.
- Document/body width stayed within the viewport; console errors and failed
  local network requests were 0.

## Artifacts

- `settings-coding-plan-provider.json`
- `settings-coding-plan-state.png`
- `settings-advanced-diagnostics.json`
- `composer-model-switch.json`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The CDP path uses fake settings and deterministic model templates. Live Coding
Plan accounts may return longer localized model names, so compact composer
selector screenshots should still be reviewed when real account data is
available.
