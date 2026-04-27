# Settings Provider Key Guidance

Date: 2026-04-27

## Slice

Settings Provider Key Guidance

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP paths.
2. Open the fake dirty project and continue the existing conversation, review,
   branch, Settings, and model-provider paths.
3. Open Settings > Model Providers and assert the compact API-key guidance row
   starts in a missing-key state.
4. Type a fake API key and assert the row changes to a ready-to-save state
   without exposing the key in visible text or artifacts.
5. Save the API-key provider and assert configured-key guidance.
6. Switch to Coding Plan, save the provider, and assert configured Coding Plan
   key guidance.
7. Continue the existing Settings Permissions, draft composer, terminal,
   relaunch, model, and commit paths in the full CDP smoke.

## Assertions

- The provider-key guidance row exposes `role="status"`, a provider-specific
  accessible label/title, and compact missing/configured classes.
- API-key mode reports `API key missing`, `API key ready to save`, and
  `API key configured` at the correct points in the workflow.
- Coding Plan mode reports `Coding Plan API key configured` after saving.
- The status dot stays 6 px, the row remains inside the Model Providers card,
  and no document or row overflow is recorded.
- Fake API keys, local server URLs, and internal diagnostics are absent from
  visible Settings text and the guidance artifact.
- The CDP run finishes with zero unexpected console errors and zero failed
  local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck && npm run lint && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

- `WorkspacePage.test.tsx`: 39 tests passed.
- Desktop typecheck, lint, build, and real Electron CDP smoke passed.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T01-17-46-472Z/`
- Provider-key guidance snapshot:
  `settings-provider-key-guidance.json`
- Settings screenshots: `settings-page.png`, `settings-coding-plan-state.png`
- Overall run summary: `summary.json`

Key artifact evidence:

- `initial.text` was `API key missing`.
- `ready.text` was `API key ready to save`.
- `apiKeyConfigured.text` was `API key configured`.
- `codingPlanConfigured.text` was `Coding Plan API key configured`.
- Every guidance snapshot recorded `role: "status"`, a contained 24 px row,
  a 6 px status dot, `guidanceOverflow: false`, `visibleSecret: false`,
  `hasServerUrl: false`, and `documentOverflow: false`.
- `summary.json` recorded empty `consoleErrors` and `failedRequests`.

## Known Uncovered Risk

This slice displays local saved-key metadata and typed-key readiness. It does
not perform live provider network validation or replace the native provider
form controls.
