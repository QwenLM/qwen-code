# Tool Activity Prototype Fidelity

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-38-24-240Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP resolved tool update.
5. Assert the resolved tool activity keeps command title, status, command
   input, output summary, and file chip.
6. Assert the tool activity surface is a compact inline timeline event rather
   than a heavy framed card.
7. Continue the existing assistant actions, changed-files summary, review
   drawer, compact layout, settings, terminal, discard safety, and commit smoke
   path.

## Assertions

- The tool activity card is inside the chat timeline and stays above the
  composer without overlap.
- The card includes `Run desktop E2E command`, `completed`,
  `printf desktop-e2e`, `desktop-e2e command completed`, and `README.md:1`.
- The card does not show the fake tool call ID or session ID.
- Legacy `.chat-tool` rows are absent.
- The tool activity has no top/right/bottom border frame.
- The left timeline accent remains subtle: 2 px wide with alpha `0.36`.
- The container background alpha is `0`.
- Preview background alpha is `0`.
- File-chip background alpha is `0.05`, with border alpha `0.16`.
- The final resolved tool activity height is `167.796875` px, below the
  compactness guard of 175 px.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `resolved-tool-activity.json`
- `resolved-tool-activity.png`
- `conversation-surface-fidelity.json`
- `compact-dense-conversation.json`
- `compact-review-drawer.json`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Intermediate Failures

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-34-05-965Z/`:
  failed because the new CDP style probe referenced `firstPreview` and
  `fileChip` before declaration.
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-34-47-802Z/`:
  failed because the surface was still `177.796875` px tall against the 175 px
  compactness target.

## Known Uncovered Risk

The harness covers deterministic fake ACP tool updates with one file reference
and bounded string output. Live ACP tools with many file references, structured
JSON output, or multi-screen command output still need broader coverage.
