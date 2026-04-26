# Compact Conversation Text Containment

Slice date: 2026-04-27

Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake Git workspace.
2. Open the fake project and send the normal fake command-approval prompt.
3. Approve the command, then send an ask-user-question prompt containing a long
   unbroken token.
4. Submit the question prompt, wait for the fake ACP response that echoes the
   long token, and resize the Electron window to the compact `960x640`
   viewport.
5. Inspect the original user message, echoed assistant message, file chips,
   action row, composer, and terminal strip.
6. Continue the existing branch, review, settings, model, and terminal flows.

Assertions:

- The long prompt token appears in both the user message and assistant response.
- User and assistant message prose uses wrap-safe text containment.
- User and assistant message rectangles remain inside the compact timeline
  width.
- Conversation, message, file chip, composer, and terminal strip regions do not
  overflow horizontally.
- `.message-role` nodes remain absent from conversation surfaces.
- No browser console errors or failed local requests are recorded.

Exact command:

```bash
cd packages/desktop && npm run e2e:cdp
```

Result: passed in iteration 52.

Artifacts:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T19-03-10-359Z/`.

Key recorded metrics:

- `promptTokenInAssistant: true`
- `promptTokenInUser: true`
- `longAssistantMessageContained: true`
- `userMessageContained: true`
- all compact overflow checks were `false`
- `summary.json` recorded zero console errors and zero failed local requests

Known uncovered risk: this harness covers one long unbroken prompt token and
the fake ACP echo path; it does not yet exercise every locale-specific action
label length or every possible assistant markdown/code-block shape.
