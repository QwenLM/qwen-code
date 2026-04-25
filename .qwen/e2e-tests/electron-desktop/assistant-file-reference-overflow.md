# Assistant File Reference Overflow

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-17-10-902Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP assistant response with repeated dense file
   references.
5. Assert the assistant message renders deduped chips, `:line:column` labels,
   uncommon file references, and a compact overflow indicator.
6. Continue the existing copy, retry, changed-files, review, settings,
   terminal, and final layout smoke path.

## Assertions

- `README.md:1` appears as one file chip even though the assistant prose
  repeats it.
- `packages/desktop/src/renderer/App.tsx:12:5`, `.env.example`,
  `Dockerfile`, `docs/guide.mdx`, and `src/App.vue` appear as accessible file
  chips.
- The overflow indicator shows `+2 more` with the accessible label
  `2 more file references`.
- File chips stay inside the assistant message and timeline, remain under the
  maximum chip width, and do not create horizontal document overflow.
- The assistant action row still exposes `Copy Response`, `Retry Last Prompt`,
  and `Open Changes`.
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

This harness verifies the default 1240 px Electron window. A follow-up compact
viewport pass should assert the same dense message state near the lower
supported desktop width.
