# No-Project Terminal Strip Restraint

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-56-35-264Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and fake
   project picker paths.
2. Verify the no-project startup viewport before opening a workspace.
3. Assert the collapsed terminal strip remains docked below the conversation but
   uses the restrained no-project summary copy.
4. Open the fake Git project through the conversation Open Project affordance.
5. Continue the existing model, settings, terminal expansion, command/stdin,
   attach-output, review, branch, discard safety, compact viewport, and commit
   smoke paths.

## Assertions

- The no-project terminal drawer has the
  `terminal-drawer-no-project` collapsed variant.
- The visible terminal identity is `Terminal`.
- The separate `Idle` status pill is absent in the no-project collapsed strip.
- The preview is `Open a project to run commands`.
- The terminal strip does not repeat visible `No project` or
  `No recent command` copy.
- The strip remains `42` px high with a `32` px toggle, no overflow, and no
  document scrolling.
- After opening a project, the normal terminal workflow still passes, including
  command execution, stdin, copy, attach to composer, and collapse.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `no-project-terminal-strip-restraint.json`
- `initial-layout.json`
- `initial-workspace.png`
- `terminal-expanded-layout.json`
- `terminal-expanded.png`
- `terminal-attachment.json`
- `completed-layout.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies default no-project geometry and full project-scoped
terminal behavior. It does not yet capture hover/focus visual states for the
no-project terminal strip.
