# Composer Runtime Control Chrome

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Make the composer permission and model selectors feel like compact runtime
controls instead of default form widgets while preserving native `<select>`
keyboard and screen-reader behavior.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake project and inspect the project-scoped composer before any
   thread exists.
3. Send the first prompt, approve the deterministic command request, and
   inspect the populated conversation.
4. Switch the composer model to the saved settings model, then to the long
   Coding Plan model, and back.
5. Inspect default, compact, and compact review composer layouts.
6. Continue the existing review, settings, branch, terminal attach, and
   follow-up send workflows.

## Assertions

- Permission and model controls render native selects inside compact shells.
- Runtime controls expose leading icons, custom chevrons, stable `aria-label`,
  and full `title` values.
- Long visible runtime labels are shortened while full labels remain available
  through `title`.
- Coding Plan provider prefixes are hidden from visible composer labels.
- Runtime controls stay at `124 x 24` in the default project composer, `106 x
  24` in compact conversation, and under `100 x 25` in compact review.
- Default, compact, and review-open composer regions report no horizontal
  overflow.
- The run records zero console errors and zero failed local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
git diff --check
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-27-40-383Z/`

Key files:

- `project-composer.json`
- `composer-model-switch.json`
- `conversation-surface-fidelity.json`
- `compact-dense-conversation.json`
- `compact-review-drawer.json`
- `summary.json`

`summary.json` recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice intentionally keeps native select popups. It does not add a custom
searchable model picker or solve very large model lists.
