# Settings Permissions Provider Health

Date: 2026-04-27

## Slice

Settings Permissions Provider Health

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP paths.
2. Open the fake dirty project and complete the existing conversation, review,
   branch, Settings, and model-provider setup paths.
3. Save API-key and Coding Plan provider settings without exposing fake key
   values.
4. Open Settings, navigate to Permissions, and verify compact Thread model
   labels and provider grouping.
5. Select the saved `qwen-e2e-cdp` API-key provider as the thread model and
   assert the compact provider-health signal.
6. Continue the Advanced Diagnostics, draft composer, terminal attach/send,
   relaunch, and commit paths in the full CDP smoke.

## Assertions

- Settings Permissions exposes the selected saved API-key model as
  `qwen-e2e-cdp · Saved API key provider · API key configured` through the
  control title, select title, and selected option title.
- The provider-health dot has an accessible label/title, uses the configured
  state, is 6 px, and stays inside the Thread model selector shell.
- Thread model option labels remain compact and do not show raw Coding Plan
  prefixes.
- Fake API keys, local server URLs, internal diagnostics, and raw provider
  prefixes are absent from normal Settings text, field values, and the
  provider-health artifact.
- The CDP run finishes with zero unexpected console errors and zero failed
  local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

- `WorkspacePage.test.tsx`: 38 tests passed.
- Desktop typecheck, lint, build, and real Electron CDP smoke passed.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-06-13-119Z/`
- Provider-health snapshot:
  `settings-permissions-provider-health.json`
- Provider-health screenshot:
  `settings-permissions-provider-health.png`
- Overall run summary: `summary.json`

Key artifact evidence:

- `controlTitle`, `selectTitle`, and `selectedTitle` were
  `qwen-e2e-cdp · Saved API key provider · API key configured`.
- `dotClass` was
  `settings-thread-model-status-dot settings-thread-model-status-configured`.
- `dotStyle.width` and `dotStyle.height` were both `6`.
- `controlOverflow`, `shellOverflow`, `selectOverflow`, `visibleSecret`,
  `hasAnySecret`, `hasServerUrl`, `hasRawCodingPlanLabel`, and
  `documentOverflow` were all `false`.
- `summary.json` recorded empty `consoleErrors` and `failedRequests`.

## Known Uncovered Risk

This slice mirrors saved Settings metadata in the Permissions selector. It
does not perform live provider network validation or replace the native model
selector with a richer custom picker.
