# Plan and Tool Activity Label Restraint

- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Passing artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T18-28-25-933Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and wait for the fake ACP plan update.
4. Assert the plan activity uses restrained title-case labels and compact
   geometry.
5. Approve the fake command request and wait for the resolved tool activity.
6. Assert tool kind, status, input, result, and file-reference labels are
   title-case, low-weight, and still contained in the timeline.
7. Continue the existing assistant actions, changed-files summary, review
   drawer, compact layout, settings, terminal, discard safety, and commit smoke
   path.

## Assertions

- Plan activity renders `Plan`, `2 tasks`, `Completed`, and `In progress`
  instead of uppercase `PLAN`, `COMPLETED`, or `IN_PROGRESS`.
- Plan label and status computed `text-transform` are `none`; label/status
  weights are at or below `650`.
- Resolved tool activity renders `Execute`, `Completed`, `Input`, and `Result`
  instead of uppercase legacy labels.
- Tool metadata label computed `text-transform` values are `none`; label
  weights are at or below `680`.
- Tool activity remains an inline timeline rail with no top/right/bottom
  border frame and a subtle 2 px left accent.
- Plan height is `69.2734375` px; resolved tool activity height is
  `113.6953125` px; both remain above the composer without overlap.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `resolved-tool-activity.json`
- `resolved-tool-activity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness covers deterministic fake ACP plan statuses and one resolved tool
card. Live ACP tools with custom status strings, many sections, or localized
status labels still need broader visual and truncation coverage.
