# Conversation Role Label DOM Restraint

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-53-30-889Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and wait for the inline command approval.
4. Approve the command and wait for the fake assistant response.
5. Inspect the default conversation viewport for user and assistant message
   accessible labels, role-label DOM nodes, and timeline text.
6. Switch to the compact viewport and repeat the assistant message DOM/text
   checks while preserving the dense layout assertions.
7. Continue the existing review drawer, discard-confirmation, staging, commit,
   settings, model switching, and terminal smoke path.

## Assertions

- User and assistant message articles expose accessible labels through
  `aria-label`.
- User and assistant messages do not render `.message-role` descendants.
- Message and timeline `innerText` do not include `Assistant message`,
  `ASSISTANT MESSAGE`, `User message`, or `USER MESSAGE`.
- Assistant prose remains unframed and compact.
- User prompt bubbles remain compact and do not spend height on role labels.
- Existing assistant actions and file reference chips remain visible and
  clickable.
- Compact conversation geometry, composer docking, collapsed terminal strip,
  and changed-files summary containment remain within the CDP thresholds.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-surface-fidelity.json`
- `compact-dense-conversation.json`
- Screenshots for the existing CDP smoke checkpoints.
- `electron.log`
- `summary.json`

Key recorded values:

- Default viewport assistant label: `Assistant message`.
- Default viewport user label: `User message`.
- Default viewport assistant `hasRoleLabel`: `false`.
- Default viewport user `hasRoleLabel`: `false`.
- Compact viewport `messageHasRoleLabel`: `false`.

## Known Uncovered Risk

The harness verifies article labels and DOM text leakage, but it does not run a
screen reader. Assistive technology behavior is inferred from semantic
attributes and existing browser accessibility conventions.
