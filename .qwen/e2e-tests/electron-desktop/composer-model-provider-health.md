# Composer Model Provider Health

Date: 2026-04-27

## Slice

Composer Model Provider Health

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted store test:
  `packages/desktop/src/renderer/stores/modelStore.test.ts`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP paths.
2. Open the fake dirty project and complete the existing conversation, review,
   branch, Settings, and model-provider setup paths.
3. Save an API-key provider and Coding Plan provider without exposing the fake
   key values.
4. Create a draft thread and confirm saved provider models appear in the
   disabled draft composer selector.
5. Return to the active thread, switch the composer model to the saved
   `qwen-e2e-cdp` API-key provider, and assert the compact provider-health
   signal.
6. Continue the terminal attach/send path and complete the full CDP smoke.

## Assertions

- Saved provider models carry provider kind and API-key configured/missing
  metadata from Settings.
- The selected saved API-key model exposes
  `qwen-e2e-cdp · Saved API key provider · API key configured` through the
  model control title, select title, and selected option title.
- The visible provider-health dot has the configured state, is 6 px, and stays
  inside the existing 124 px composer model control.
- Composer option labels remain compact and do not show raw Coding Plan
  prefixes.
- Fake API keys, local server URLs, and internal diagnostics are absent from
  visible text, field values, and the provider-health artifact.
- The CDP run finishes with zero unexpected console errors and zero failed
  local requests.

## Commands

```bash
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/modelStore.test.ts
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

- `modelStore.test.ts`: 8 tests passed.
- `WorkspacePage.test.tsx`: 37 tests passed.
- Desktop typecheck, lint, build, and real Electron CDP smoke passed.

## Artifacts

- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-54-06-303Z/`
- Provider-health snapshot:
  `composer-model-provider-health.json`
- Provider-health screenshot:
  `composer-model-provider-health.png`
- Overall run summary: `summary.json`

Key artifact evidence:

- `controlTitle`, `selectTitle`, and `selectedTitle` were
  `qwen-e2e-cdp · Saved API key provider · API key configured`.
- `dotClass` was
  `composer-model-status-dot composer-model-status-configured`.
- `dotStyle.width` and `dotStyle.height` were both `6`.
- `controlOverflow`, `selectOverflow`, `hasSecret`, `hasServerUrl`, and
  `documentOverflow` were all `false`.
- `summary.json` recorded empty `consoleErrors` and `failedRequests`.

## Known Uncovered Risk

This slice records configured/missing API-key state from Settings metadata. It
does not perform live provider network validation or show latency/rate-limit
health.
