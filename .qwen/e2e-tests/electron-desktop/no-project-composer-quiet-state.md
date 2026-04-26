# No-Project Composer Quiet State

Date: 2026-04-27 (Asia/Shanghai)

## Slice

Mute the first-launch no-project composer so it reads as an inactive local
task control instead of a warning state. The disabled reason remains visible,
but the composer and disabled send action no longer use amber warning or blue
primary-action emphasis.

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch real Electron with isolated HOME, user-data, runtime, workspace, and
   fake ACP.
2. Inspect the initial no-project workspace before opening any project.
3. Assert the no-project empty-state label remains near the composer.
4. Assert the disabled composer reason and disabled send action use muted
   inactive styling.
5. Continue the existing project open, composer-first thread creation, branch,
   review, settings, terminal attach, model switch, relaunch, and compact
   viewport workflows.

## Assertions

- The no-project empty state still says `Open a project to start` and stays
  near the composer.
- The disabled composer reason is present through
  `data-testid="composer-disabled-reason"`, does not overflow, remains 22 px
  tall, and uses muted neutral styling.
- The disabled Send icon button has `backgroundImage: none`, neutral background
  alpha, and does not render the primary blue gradient.
- The run records zero console errors and zero failed local requests.

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

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T22-05-13-907Z/`

Key files:

- `initial-layout.json`
- `initial-workspace.png`
- `summary.json`

`initial-layout.json` recorded the disabled composer reason at 138.133 px wide,
22 px tall, 10.6 px / 620 weight, 0.56 text alpha, 0.035 background alpha, and
no overflow. The disabled Send button recorded no background image, 0.055
background alpha, and 0.72 opacity. `summary.json` recorded zero console errors
and zero failed local requests.

## Known Uncovered Risk

This slice only adjusts the no-project inactive composer and disabled send
states. It does not change the topbar no-project status, the terminal strip,
or the larger sidebar grouping mismatch with `home.jpg`.
