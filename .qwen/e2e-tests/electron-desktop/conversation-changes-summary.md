# Conversation Changed-Files Summary and Protocol Noise Cleanup

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-28-04-569Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt without manually creating a thread.
4. Approve the fake command request.
5. Assert the main body does not expose `session-e2e-1`,
   `Connected to session-e2e`, or `Turn complete`.
6. Assert the conversation inline changed-files summary is visible with
   `README.md`, `notes.txt`, `2 files changed`, `+2`, and `-1`.
7. Open review from the inline `Review Changes` action and continue the
   existing review, settings, and terminal smoke path.

## Assertions

- Protocol connection and completion events stay out of the visible
  conversation body.
- The changed-files summary is present before review opens and includes a
  compact file/status/stat summary.
- The summary opens the review drawer without replacing the conversation.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-changes-summary.json`
- `review-drawer.png`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This harness uses deterministic fake ACP updates and a small two-file Git
workspace. It does not yet validate long file paths, many changed files, or
live ACP tool/file-reference payloads.
