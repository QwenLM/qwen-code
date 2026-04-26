# Electron Desktop E2E: First Viewport Chrome Restraint

Date: 2026-04-27

## Slice

First Viewport Chrome Restraint

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   deterministic fake ACP/project data.
2. Assert the no-project first viewport renders the sidebar, topbar,
   conversation, composer, and collapsed terminal without secondary drawers.
3. Assert the empty conversation prompt is compact, muted, and positioned near
   the composer rather than centered as a large empty-state headline.
4. Assert the disabled no-project composer reason remains present and compact.
5. Open the dirty fake project, verify composer-first thread creation remains
   available, then continue the existing branch, review, settings, terminal,
   model, relaunch, and compact viewport workflows.

## Assertions

- Initial empty-state text is visible as `Open a project to start`, uses small
  muted typography, and sits just above the composer.
- Sidebar app actions, section headings, project rows, thread rows, and empty
  rows stay within the restrained font-size and font-weight thresholds.
- Topbar title, project context, branch/Git metadata, and runtime status keep
  slim geometry while using lighter typography.
- The no-project composer reason remains visible and does not overflow.
- Real Electron console errors and failed local requests are empty.

## Command

```bash
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Artifacts:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-54-33-740Z/`

Key files:

- `initial-layout.json`
- `initial-workspace.png`
- `sidebar-app-rail.json`
- `topbar-context-fidelity.json`
- `compact-settings-overlay.json`
- `summary.json`

Additional verification:

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
git diff --check
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck && npm run lint && npm run build
```

The final CDP run recorded zero console errors and zero failed local requests.

## Known Uncovered Risk

This slice validates geometry and typography thresholds rather than pixel-level
comparison against `home.jpg`; a later visual regression pass should compare
full-window screenshots more directly.
