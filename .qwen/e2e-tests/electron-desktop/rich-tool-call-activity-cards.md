# Rich Tool-Call Activity Cards

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-57-31-788Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP resolved tool update.
5. Assert the conversation renders a compact tool activity card with command
   title, status, command input, output summary, and file chip.
6. Continue the existing changed-files, review, settings, terminal, and final
   layout smoke path.

## Assertions

- The resolved activity card is inside the chat timeline and stays above the
  composer without overlap.
- The card includes `Run desktop E2E command`, `completed`,
  `printf desktop-e2e`, `desktop-e2e command completed`, and `README.md:1`.
- The card does not show the fake tool call ID or session ID.
- Legacy `.chat-tool` rows are absent.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `resolved-tool-activity.json`
- `resolved-tool-activity.png`
- `conversation-changes-summary.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers deterministic fake ACP tool updates with one file reference
and bounded string output. Live ACP tools with richer structured outputs, many
file references, and long command output still need broader coverage.
