# Conversation Surface Prototype Fidelity

## Iteration 23: Composer and Changed-Files Density Pass

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-08-46-544Z/`

### Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the first composer prompt, approve the fake command request, and wait
   for assistant prose, file-reference chips, assistant actions, and the inline
   changed-files summary.
4. Capture geometry and computed styles for the assistant message, user prompt,
   changed-files summary, action buttons, composer, textarea, timeline, and
   document width.
5. Resize to the compact `960x640` Electron viewport, assert dense
   conversation geometry, restore bottom-of-conversation scroll, and capture the
   compact screenshot.
6. Continue the existing branch creation/validation, branch switch, review
   drawer, discard confirmation, commit, settings, terminal attach, and
   follow-up prompt workflows.

### Assertions

- Changed-files summary height is `80` px at default and compact viewport
  sizes, below the previous `153.5` px baseline.
- Changed-files summary background alpha is `0.02`, border alpha is `0.11`,
  and chip row background alpha is `0`.
- Changed-files `Review Changes` action height is `28` px.
- Default composer height is `101` px and textarea height is `46` px.
- Compact composer height is `97.1875` px.
- Compact bottom-scroll summary stays inside the timeline and above the
  composer.
- Composer, composer context, and composer actions do not overflow at compact
  width.
- Document scroll width stayed equal to the viewport.
- Console errors: 0.
- Failed local network requests: 0.

### Artifacts

- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `compact-review-drawer.json`
- `review-drawer-layout.json`
- `electron.log`
- `summary.json`

### Known Uncovered Risk

The harness covers deterministic fake ACP content and two viewport sizes.
Additional real-world coverage is still needed for unusually verbose command
activity, long model names in the composer, and mixed staged/unstaged file sets
with more than three changed files.

## Iteration 16: Conversation Surface Pass

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
