# Inline Command Approval Cards

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-18-35-363Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt without manually creating a thread.
4. Wait for the fake ACP command permission request.
5. Assert the request renders as a compact inline conversation rail with the
   command title, command preview, pending status, and approval/deny actions.
6. Assert the old detached permission strip is absent and the body does not
   show a generic `Permission requested` event.
7. Approve once, assert the pending card resolves, then continue the existing
   changed-files, review, settings, terminal, and final layout smoke path.

## Assertions

- The inline approval card is inside the chat timeline and stays above the
  composer without overlap.
- The card exposes `Approve Once`, `Approve for Thread`, and `Deny` actions.
- The card includes `Run desktop E2E command`, `printf desktop-e2e`, and a
  pending status.
- The approval rail height is `109.5234375` px, below the 130 px geometry
  guard and the prior `152.8984375` px baseline.
- `.permission-strip` is absent.
- The conversation body does not contain `Permission requested`.
- The changed-files summary appears after approval and no approval card remains.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `inline-command-approval.json`
- `inline-command-approval.png`
- `conversation-changes-summary.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers deterministic fake ACP command approval with a string command
input. It does not yet validate live ACP approvals with structured tool input,
ask-user free-form answer capture, or long command wrapping at compact widths.
