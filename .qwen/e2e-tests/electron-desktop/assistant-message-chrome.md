# Assistant Message Chrome Reduction

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-55-54-656Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project, create a task from the composer, approve the fake
   command request, and wait for the assistant response.
3. Assert the conversation surface at the default viewport, including assistant
   prose, file-reference chips, action icons, changed-files summary, composer,
   and collapsed terminal.
4. Resize the real Electron window to the compact `960x640` viewport and repeat
   dense conversation containment checks.
5. Continue the carried branch, review, discard cancel, commit, settings,
   model switching, and terminal attach paths.

## Assertions

- Assistant role label remains available as `Assistant message` for assistive
  technology but is offscreen at 1x1 px in default and compact viewports.
- Assistant copy, retry, and open-changes controls keep their accessible labels,
  remain 24x24 px, and render with idle background alpha 0 and border alpha 0.
- Assistant prose remains unframed with background alpha 0 and no border width.
- User prompt bubble, plan rows, tool cards, changed-files summary, composer,
  settings overlay, review drawer, and terminal workflows remain covered by the
  existing smoke path.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `assistant-message-actions.json`
- `assistant-message-actions.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies idle button chrome and geometry, but it does not yet
capture hover/focus screenshots for the assistant action row.
