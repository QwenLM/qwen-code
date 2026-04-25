# Assistant Message Actions and File Reference Chips

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-10-35-606Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP assistant response that references `README.md:1`.
5. Assert the assistant message renders compact Copy, Retry last prompt, and
   Open Changes actions plus a file-reference chip.
6. Click Copy and verify visible composer feedback.
7. Click Retry and verify the previous user prompt is restored into the
   composer without sending a new request, then clear the retry draft.
8. Continue the existing changed-files, review, settings, terminal, and final
   layout smoke path.

## Assertions

- The assistant action row is inside the chat timeline and stays above the
  composer without overlap.
- The assistant action row exposes `Copy Response`, `Retry Last Prompt`, and
  `Open Changes` as accessible button labels.
- The assistant file chip shows `README.md:1` and exposes `Open README.md:1`.
- Copy produces `Copied response.` feedback.
- Retry restores `Please exercise command approval.` to the composer and does
  not auto-send a new approval request.
- The assistant message does not show fake tool call IDs or session IDs.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `assistant-message-actions.json`
- `assistant-message-actions.png`
- `assistant-retry-draft.json`
- `resolved-tool-activity.json`
- `conversation-changes-summary.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers one deterministic assistant response with one file
reference. Live assistant prose with many repeated paths, uncommon file
extensions, or markdown-wrapped references still needs broader coverage.
