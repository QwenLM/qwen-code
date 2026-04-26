# Electron Desktop E2E: User Message Bubble Restraint

Slice name: User Message Bubble Restraint

Date: 2026-04-27

Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch the real Electron app with isolated HOME, runtime, user-data, and fake
   ACP paths.
2. Open the dirty fake Git project and send the command-approval prompt.
3. Assert the short user prompt bubble is right aligned, content-sized, compact,
   and uses blue/violet accent styling rather than amber warning styling.
4. Send the long ask-user-question prompt, switch to the compact viewport, and
   assert the long user prompt wraps inside the timeline without overflow.
5. Continue the existing branch, review, settings, terminal, model, commit, and
   relaunch workflows.

Assertions:

- `.chat-message-user` keeps the accessible label `User message` and has no
  visible role-label node.
- Short user bubble width stays below the old fixed-card threshold while still
  preserving a visible accent background and border.
- User bubble border uses the Qwen blue/violet accent family.
- User prompt text remains at the compact conversation type scale.
- Compact viewport long prompt remains contained, scrollable, and does not
  create horizontal body overflow.
- The harness records zero unexpected console errors and failed local requests.

Command:

```bash
cd packages/desktop && npm run e2e:cdp
```

Result: passed.

Artifacts:

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/conversation-surface-fidelity.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/conversation-surface-fidelity.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/compact-dense-conversation.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/compact-dense-conversation.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/electron.log`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-14-20-745Z/summary.json`

Verification command results:

- `node --check packages/desktop/scripts/e2e-cdp-smoke.mjs` passed.
- `git diff --check` passed.
- `cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx`
  passed with 28 tests.
- `cd packages/desktop && npm run typecheck` passed.
- `cd packages/desktop && npm run lint` passed.
- `cd packages/desktop && npm run build` passed.
- `cd packages/desktop && npm run e2e:cdp` passed.

Recorded metrics:

- Short user prompt bubble: 238.078 px wide, 37.234 px tall,
  `rgba(85, 166, 255, 0.08)` background, and
  `rgba(85, 166, 255, 0.28)` border.
- Compact long user prompt: 531.953 px wide, contained in the timeline, no
  user-message overflow, and body scroll width equal to the 960 px viewport.
- Browser/runtime diagnostics: zero unexpected console errors and zero failed
  local requests.

Known uncovered risk:

- This harness checks geometry and computed colors, not pixel-level comparison
  against `home.jpg`.
