# Changed Files Summary Inline Fidelity

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-37-32-960Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Inspect the changed-files summary before opening review.
5. Click the compact `Review Changes` action and continue the review drawer,
   discard-confirmation, staging, commit, settings, model switching, and
   terminal smoke path.
6. Re-check compact viewport layout for conversation, composer, terminal, and
   changed-files containment.

## Assertions

- The main conversation does not expose ACP session IDs, connection event text,
  or turn-complete protocol stop reasons.
- Changed-files summary renders `Changed files`, `2 files changed`, `+2`,
  `-1`, `README.md`, `Modified · Unstaged`, `notes.txt`, and `Untracked`.
- Uppercase legacy summary text such as `CHANGED FILES` and
  `MODIFIED · UNSTAGED` is absent.
- The summary no longer uses `.message-role` visual chrome.
- The summary is an inline rail: transparent background, no top/right/bottom
  border, 2 px left accent, 0 px radius, 820 x 61 px in the default viewport.
- The review action keeps `aria-label` and `title` as `Review Changes`, shows
  visible text `Review`, includes an icon, and stays 24 px tall.
- Compact viewport keeps the changed-files summary inside the timeline and
  above the composer after scrolling.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-changes-summary.json`
- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `review-drawer.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers two deterministic changed files and one hidden overflow row
through component tests. Live sessions with many renamed files, binary diffs,
or very long localized status labels still need broader visual coverage.
