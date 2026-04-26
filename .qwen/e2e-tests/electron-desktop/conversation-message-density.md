# Conversation Message Density

- Slice name: Conversation Message Typography Density Pass
- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-27-41-142Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project through the desktop directory picker path.
3. Send the composer prompt and approve the fake command request.
4. Capture computed type styles and geometry for the user prompt, assistant
   prose, plan rows, changed-files summary, composer, and compact viewport.
5. Resize to the compact `960x640` Electron viewport and assert the assistant
   message, file chips, actions, changed-files summary, composer, and collapsed
   terminal strip stay contained.
6. Continue the carried branch creation/validation, branch switching, review,
   discard safety, commit, settings, terminal attach, and follow-up prompt
   workflows.

## Assertions

- Assistant and user message paragraph font size is `13` px with `19.24` px
  line height.
- The user prompt role label is present for semantics but rendered with
  `display: none`.
- User prompt bubble height is `37.234375` px, down from the previous
  `64.6953125` px artifact baseline.
- Plan item font size is `12` px with `16.32` px line height.
- Plan block height is `68.625` px, and status labels do not collide with row
  text.
- Default assistant message height is `163.9375` px, down from the previous
  `177.78125` px artifact baseline.
- Compact assistant message height is `213.171875` px, down from the previous
  `229.4765625` px artifact baseline and below the new `218` px guard.
- Document/body width stayed equal to the viewport, with no element overflow in
  the compact conversation metrics.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `conversation-surface-fidelity.json`
- `conversation-surface-fidelity.png`
- `compact-dense-conversation.json`
- `compact-dense-conversation.png`
- `inline-command-approval.json`
- `resolved-tool-activity.json`
- `review-drawer-layout.json`
- `settings-layout.json`
- `terminal-expanded-layout.json`
- `electron.log`
- `summary.json`

## Intermediate Findings

- The first passing CDP run wrote
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T03-26-40-440Z/`.
  Manual screenshot review found the compacted plan label gutter was too tight:
  `IN_PROGRESS` visually collided with the row text.
- The CSS was adjusted to preserve a wider label gutter and explicit right
  margin, then the full build and CDP smoke passed again at the final artifact
  directory above.

## Known Uncovered Risk

The harness covers deterministic fake ACP content and the default plus compact
desktop viewports. Additional visual checks are still needed for live plans
with longer localized status labels, very long user prompts, and dense
multi-paragraph assistant output with code blocks.
