# Model Picker Provider Grouping

- Slice name: Model Picker Provider Grouping
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command: `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-06-10-781Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP data.
2. Open the fake dirty Git project and complete the existing command approval,
   review, commit, settings, and model-provider flows.
3. Save a valid API-key provider, then save a Global Coding Plan provider.
4. Inspect the Settings Permissions thread-model selector.
5. Return to Conversation, create a draft thread, inspect the disabled draft
   composer model selector, then return to the active thread and switch models
   from the composer.

## Assertions

- Settings Permissions groups thread-model options under `Active session`,
  `Saved providers`, and `Coding Plan`.
- Draft composer groups saved API-key provider models separately from Coding
  Plan models while keeping runtime selectors disabled for a draft thread.
- Active composer groups active runtime, saved API-key, and Coding Plan models
  while preserving exact option values.
- Visible model labels stay compact and never include `ModelStudio Coding Plan`.
- Coding Plan options preserve the full raw provider label in native `title`
  attributes.
- The composer and Settings selectors do not overflow and do not expose
  `sk-desktop-e2e`, `cp-desktop-e2e`, or the local server URL.
- `summary.json` records zero console errors and zero failed local requests.

## Artifacts

- `settings-permissions-model-label-restraint.json`
- `settings-permissions-model-label-restraint.png`
- `draft-composer-saved-model-state.json`
- `draft-composer-saved-model-state.png`
- `composer-model-switch.json`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The harness verifies deterministic fake ACP and Coding Plan template models.
Native select dropdown rendering is platform-owned, so this coverage asserts
DOM group structure, option values, titles, selected state, containment, and
diagnostics rather than pixel-testing the opened dropdown menu.
