# Compact Dense Conversation

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T18-31-38-896Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt and approve the fake command request.
4. Wait for the fake ACP assistant response with dense repeated file
   references.
5. Assert the default-width assistant actions and dense file chips.
6. Resize the real Electron window to the compact desktop bounds near 960 px.
7. Assert compact sidebar, topbar, dense assistant message, file chips, action
   row, composer, and collapsed terminal geometry.
8. Restore the default window size and continue the existing review, settings,
   terminal, and commit smoke path.

## Assertions

- Compact viewport resolved to 960x608 content pixels.
- Sidebar stayed compact at 236 px and topbar stayed 58 px high.
- The dense assistant message, file chips, and action row stayed inside the
  conversation timeline with no horizontal document overflow.
- Required chips remained accessible: `README.md:1`,
  `packages/desktop/src/renderer/App.tsx:12:5`, `.env.example`, `Dockerfile`,
  `docs/guide.mdx`, and `src/App.vue`.
- Assistant actions remained accessible: `Copy Response`, `Retry Last Prompt`,
  and `Open Changes`.
- Compact composer height stayed bounded at about 127 px and did not overflow
  its context/action rows.
- The collapsed terminal strip remained docked and closed.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `compact-summary-visibility-note.json`
- `window-resize-fallback-960x640.json`
- `window-resize-fallback-1240x820.json`
- `assistant-message-actions.json`
- `assistant-message-actions.png`
- `completed-workspace.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

This slice covers the dense conversation and composer at compact width. A
follow-up should add a compact-width review drawer assertion because the review
drawer intentionally reduces conversation width.
