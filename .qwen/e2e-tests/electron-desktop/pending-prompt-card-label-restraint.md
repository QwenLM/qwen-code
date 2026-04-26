# Pending Prompt Card Label Restraint

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-46-47-262Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and wait for the inline command approval.
4. Assert restrained approval labels, approve the command, and wait for the
   fake assistant response.
5. Send a second composer prompt that deterministically triggers an
   ask-user-question request from the fake ACP client.
6. Assert restrained question labels, submit the question, then continue the
   existing review drawer, discard-confirmation, staging, commit, settings,
   model switching, and terminal smoke path.

## Assertions

- Command approval renders `Execute`, `Run desktop E2E command`,
  `Needs approval`, `printf desktop-e2e`, `Approve Once`,
  `Approve for Thread`, and `Deny`.
- Ask-user-question renders `Question`, `Input needed`, `Waiting`, `Choice`,
  `Pick the next review focus`, `Review changes`, `Continue task`, `Cancel`,
  and `Submit`.
- Approval and question cards do not render `.message-role` visual chrome.
- Uppercase legacy labels such as `EXECUTE`, `PENDING`, `QUESTION`, `WAITING`,
  and `CHOICE` are absent.
- Prompt/status/question labels have `text-transform: none` and font weights at
  or below 680.
- Cards remain inline in the conversation timeline, stay above the composer,
  and do not fall back to the old permission strip.
- Raw protocol names such as `ask_user_question` do not appear in the body.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `inline-command-approval.json`
- `inline-command-approval.png`
- `inline-question-card.json`
- `inline-question-card.png`
- `conversation-surface-fidelity.json`
- `compact-dense-conversation.json`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The real Electron harness covers one approval and one single-question prompt
with two options. Multi-question prompts, multi-select answers, and very long
localized option labels still need broader compact-viewport coverage.
