# Conversation Header Chrome

- Slice name: Conversation Header Chrome Reduction
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-00-29-581Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project and assert the project-scoped composer is enabled
   before any thread exists.
3. Assert the main chat panel does not render a visible `.chat-header`, while a
   screen-reader-only chat status remains present.
4. Send the composer prompt, approve the fake command request, and wait for the
   fake ACP response, tool activity, assistant actions, and changed-files
   summary.
5. Assert default and compact conversation geometry, including the timeline
   starting directly at the chat panel top.
6. Continue the carried branch creation/validation, branch switching, review,
   discard safety, commit, settings, terminal attach, and follow-up prompt
   workflows.

## Assertions

- `.chat-header` is absent before thread creation, in the default conversation,
  and in the compact `960x608` viewport.
- Accessible chat status text is present: `Conversation idle` before thread
  creation and `Conversation connected` after the fake session connects.
- Default chat top is `50` px and timeline top is `50` px.
- Compact chat top is `50` px and timeline top is `50` px.
- Default timeline height is `585.90625` px, up from the prior `539.90625` px
  artifact after removing the duplicate header row.
- Compact timeline height is `405.90625` px, up from the prior `359.90625` px
  artifact.
- Composer geometry remains stable: default `820x88.09375`, compact
  `704x88.09375`.
- Document/body width stayed equal to the viewport, with no compact overflow.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `project-composer.json`
- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The harness uses deterministic fake ACP content. Additional visual review is
still useful for live sessions with very long first messages or localized
status strings because the timeline now starts closer to the topbar.
