# Thread Title Local Endpoint Restraint

- Slice date: 2026-04-27 (Asia/Shanghai)
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`
- Commands:
  `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs`
  `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  `cd packages/desktop && npm run typecheck`
  `cd packages/desktop && npm run lint`
  `cd packages/desktop && npm run build`
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-12-56-109Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP workspaces.
2. Open the fake Git project and create the deterministic fake ACP thread whose
   source title contains a temp path, a `127.0.0.1` URL, a session-like ID, and
   a long prompt token.
3. Inspect the populated sidebar thread row and topbar title.
4. Continue the existing composer, branch, review, settings, terminal,
   relaunch, and compact viewport smoke path.

## Assertions

- The sidebar active thread title is exactly
  `Review README.md after the failing test` before relative-time metadata.
- The topbar heading is exactly `Review README.md after the failing test`.
- Sidebar/topbar visible text omits `/tmp/`, `127.0.0.1`, `local server`,
  `local...`, ACP/session IDs, and the fake long prompt token.
- Missing or ID-like component titles still render as `Untitled thread`.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `sidebar-app-rail.json`
- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `electron.log`
- `summary.json`

`sidebar-app-rail.json` recorded the active row `threadTitle` as
`Review README.md after the failing test`. `topbar-context-fidelity.json`
recorded `titleText` as the same compact title. `summary.json` recorded no
console errors and no failed local requests.

## Known Uncovered Risk

This is deterministic cleanup for localhost-derived prompt noise. It does not
generate semantic titles for arbitrary historical sessions whose source titles
are genuinely long but contain no diagnostic endpoint or ID markers.
