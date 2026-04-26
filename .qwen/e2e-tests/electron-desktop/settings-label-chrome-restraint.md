# Settings Label Chrome Restraint

- Slice name: Settings Label Chrome Restraint
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-47-10-706Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP data.
2. Open the dirty fake project, complete the existing conversation, review,
   commit, and settings entry flows.
3. Open Settings as the right-side overlay while the conversation and terminal
   remain mounted behind it.
4. Inspect computed styles for Settings form labels and key/value labels.
5. Continue the existing compact Settings, validation, Coding Plan,
   Permissions model-label, composer, terminal, branch, and relaunch paths.

## Assertions

- Settings form labels include `Provider`, `Model`, `Base URL`, `API key`,
  `Permission mode`, and `Thread model`.
- Settings key/value labels include `Auth`, `API key`, `Coding Plan key`,
  `Commands`, `Skills`, `Shell`, `Output`, `Theme`, and `Density`.
- Every sampled Settings label reports `text-transform: none`, font weight
  `680`, font size `11.5`, and no text overflow in the real Electron renderer.
- The default Settings drawer does not expose `sk-desktop-e2e`,
  `cp-desktop-e2e`, or the local server URL.
- The document does not overflow the default viewport.
- Console errors and failed local network requests are 0.

## Artifacts

- `settings-label-chrome-restraint.json`
- `settings-layout.json`
- `settings-page.png`
- `compact-settings-overlay.json`
- `settings-validation.json`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

This verifies the mounted Settings sections under deterministic fake runtime
data. It does not inspect future provider-specific custom fields until those
fields are added to the Settings form.
