# Conversation Surface Prototype Fidelity

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-26-44-948Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the dense fake ACP assistant response, file-reference chips,
   assistant actions, and changed-files summary.
5. Capture computed styles and geometry for the assistant message, user prompt,
   changed-files summary, action buttons, timeline, and document width.
6. Save `conversation-surface-fidelity.json` and
   `conversation-surface-fidelity.png`, then continue the compact conversation,
   compact review, review safety, commit, settings, and terminal workflows.

## Assertions

- Assistant message border widths are all `0`.
- Assistant message background alpha is `0`, so assistant prose is not a
  framed card.
- User prompt remains a compact right-aligned bubble with a visible border and
  background alpha of `0.1`.
- Changed-files summary remains an inline supporting surface with background
  alpha `0.024`, border alpha `0.11`, and height `153.5` px.
- Changed-file rows do not render as nested cards.
- Changed-files `Review Changes` action height is `30` px.
- Assistant action buttons remain compact at `28x28` px.
- Document scroll width stayed equal to the `1240` px viewport.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `assistant-message-actions.json`
- `assistant-message-actions.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `compact-review-drawer.json`
- `compact-review-drawer.png`
- `review-drawer-layout.json`
- `terminal-expanded-layout.json`
- `electron.log`
- `summary.json`

## Failed Run Fixed

Iteration 15 produced a partial artifact directory at
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T01-19-16-242Z/`.
That run stopped before `conversation-surface-fidelity.json` or `summary.json`
were written. Iteration 16 reran the full CDP smoke successfully with the same
slice changes and produced the passing artifact directory above.

## Known Uncovered Risk

The harness validates deterministic fake ACP content at the default and compact
desktop sizes. Long branch names, long model names, and unusually long project
names with the review drawer open still need a focused truncation and overflow
assertion.
