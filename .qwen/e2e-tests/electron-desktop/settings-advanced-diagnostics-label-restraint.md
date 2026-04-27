# Settings Advanced Diagnostics Label Restraint

Slice date: 2026-04-27

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario

1. Launch the real Electron desktop app with isolated HOME, runtime, user-data,
   and fake ACP paths.
2. Open Settings and assert default product settings do not expose runtime
   diagnostics, local server URLs, ACP/session IDs, or secrets.
3. Open Advanced Diagnostics.
4. Assert session/runtime diagnostic labels are present, normal-case,
   restrained in weight/size, and contained.
5. Assert runtime diagnostics show the local `127.0.0.1` server URL only after
   expansion and still do not expose fake API keys.
6. Continue the existing CDP smoke coverage for settings validation, model
   switching, terminal attach, branch switching, review, commit, and relaunch.

## Assertions

- `settings-advanced-diagnostics.json` records `aria-expanded="true"` for the
  Advanced Diagnostics toggle.
- Diagnostic labels include `Active`, `Commands`, `Skills`, `Tokens`,
  `Settings path`, `Server`, `Desktop`, `Platform`, `Node`, `ACP`, and
  `Health`.
- Each diagnostic label reports `textTransform: "none"`, `fontWeight <= 700`,
  `fontSize <= 12`, and no horizontal overflow.
- Fake API keys are absent from text, input values, logs, and screenshots.
- `summary.json` records zero unexpected console errors and zero failed local
  requests.

## Commands

- Passed: `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Passed:
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
- Passed: `cd packages/desktop && npm run typecheck`
- Passed: `cd packages/desktop && npm run lint`
- Passed: `cd packages/desktop && npm run build`
- Passed: `cd packages/desktop && npm run e2e:cdp`

## Result

Passed. The targeted WorkspacePage test ran 36 tests. The real Electron CDP
smoke completed with zero unexpected console errors and zero failed local
requests.

## Artifacts

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-42-07-584Z/settings-advanced-diagnostics.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-42-07-584Z/settings-page.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T00-42-07-584Z/summary.json`

`settings-advanced-diagnostics.json` recorded all diagnostic labels as
`textTransform: "none"`, `fontWeight: 680`, `fontSize: 11.5`, and
`overflows: false`.

## Known Uncovered Risk

This slice only changes the styling and CDP assertion coverage for the opt-in
Advanced Diagnostics labels. It does not redesign Settings IA or add new
diagnostic content.
