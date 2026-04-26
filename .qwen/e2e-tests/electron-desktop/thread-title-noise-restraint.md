# Thread Title Noise Restraint

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Normalize noisy ACP session titles before rendering them in the sidebar thread
rows or topbar title. Display titles stay compact and product-facing while raw
prompts, absolute paths, local URLs, and session IDs remain out of the main
navigation chrome.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Open the fake project and send the first prompt so the fake ACP creates a
   session with a noisy title.
3. Inspect sidebar and topbar metrics while the active session title contains
   path, local URL, session-like ID, and long-token noise in the source data.
4. Continue the existing branch, review, settings, terminal attach, and
   follow-up send workflows.

## Assertions

- Sidebar thread rows expose `Review README.md after the failing test...`
  instead of the raw fake ACP title.
- Missing or ID-like titles render as `Untitled thread` in component coverage.
- Topbar title uses the same compact session display title.
- Sidebar/topbar visible text omits `/tmp/`, `127.0.0.1`,
  `session-e2e-deadbeef`, `session-e2e`, `Connected to`, and the long prompt
  token.
- Sidebar rows and topbar actions remain within existing compact geometry and
  typography thresholds.
- The run records zero console errors and zero failed local requests.

## Commands

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck && npm run lint && npm run build
cd packages/desktop && npm run e2e:cdp
git diff --check
```

## Result

Passed.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-40-50-335Z/`

Key files:

- `sidebar-app-rail.json`
- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `summary.json`

`summary.json` recorded zero console errors and zero failed local requests.
`sidebar-app-rail.json` recorded a compact active thread row with no overflow.
`topbar-context-fidelity.json` recorded the same compact title, preserved long
branch text in the DOM, contained topbar geometry, and no horizontal document
overflow.

## Known Uncovered Risk

This slice uses deterministic front-end normalization. It does not generate
semantic AI titles for arbitrary historical sessions; that remains a future
title-generation or session-summary enhancement.
