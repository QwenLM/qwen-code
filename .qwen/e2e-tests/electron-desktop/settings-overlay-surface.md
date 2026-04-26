# Settings Overlay Surface

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-37-58-777Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project, create the first task from the composer, approve the
   fake command request, review changes, cancel discard, stage, and commit.
3. Return to Conversation, then open Settings from the workbench.
4. Assert Settings renders as a right-side overlay sheet while chat and the
   terminal strip remain mounted and the review drawer is closed.
5. Assert default Settings hides server URL, Node version, ACP/session IDs,
   settings path, health diagnostics, and fake secrets.
6. Exercise API-key validation/save and Coding Plan provider save flows using
   settings-specific accessible labels.
7. Open Advanced Diagnostics, verify runtime/session diagnostics are visible
   only after that action, close back to Conversation, then continue through the
   composer model switch and terminal attachment path.

## Assertions

- Settings overlay, backdrop, dialog role, model config, and permissions config
  are present.
- Chat and terminal remain mounted while Settings is open; Review is not
  mounted behind the settings sheet.
- Settings sheet is right-aligned, drawer-width bounded, and does not create
  body overflow at the default CDP viewport.
- Model provider, Base URL, API key, Coding Plan region, and permissions
  controls stay reachable through stable accessible labels.
- Fake API keys are never visible in settings text, diagnostics, form fields
  after save, screenshots, or summary output.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `settings-layout.json`
- `settings-validation.json`
- `settings-product-state.json`
- `settings-coding-plan-provider.json`
- `settings-advanced-diagnostics.json`
- `settings-page.png`
- `settings-coding-plan-state.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies default desktop geometry and the existing compact
workbench paths, but it does not yet assert keyboard focus trapping or visual
snapshots for the settings sheet at the 960x640 compact viewport.
