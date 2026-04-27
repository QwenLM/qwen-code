# No-Project Topbar Context Restraint

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T03-05-37-622Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and fake
   project picker paths.
2. Verify the no-project startup topbar before opening a workspace.
3. Assert the header keeps only the app title, connection state, icon actions,
   and runtime status without disabled project-only placeholders.
4. Open the fake Git project through the conversation Open Project affordance.
5. Continue the existing model, settings, terminal expansion, command/stdin,
   attach-output, review, branch, discard safety, compact viewport, and commit
   smoke paths.

## Assertions

- The startup topbar heading is `Qwen Code Desktop`.
- The startup title stack has no project label.
- The startup topbar does not render visible `No project selected`,
  `No Git branch`, or `No project` placeholder copy.
- The startup topbar context has exactly one item: `Connected`.
- Branch trigger and Git status controls are absent until a project is open.
- The topbar, title, and context do not overflow and the document remains
  contained in the viewport.
- After opening a project, the normal topbar workflow still passes, including
  compact branch display, dirty diff stats, branch creation/switching, review
  entry, and commit smoke assertions.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `no-project-topbar-context-restraint.json`
- `initial-layout.json`
- `initial-workspace.png`
- `topbar-context-fidelity.json`
- `topbar-context-fidelity.png`
- `branch-create-menu.json`
- `branch-switch-result.json`
- `completed-layout.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies default no-project geometry and project-scoped topbar
behavior. It does not yet capture hover/focus visual states for the topbar icon
actions in the no-project state.
