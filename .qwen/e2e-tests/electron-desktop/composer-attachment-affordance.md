# Composer Attachment Affordance

- Slice name: Composer Attachment Affordance
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-27-14-177Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project and stop before selecting an existing thread.
3. Assert the composer is enabled for the active project and still marks model
   and permission selectors unavailable until a session exists.
4. Inspect the attachment control semantics, focus state, tooltip/help text,
   icon presence, geometry, and absence of placeholder text.
5. Continue the carried chat, command approval, branch, review, settings, model
   switch, and terminal workflow.

## Assertions

- The attachment control has accessible label `Attach files`.
- The control is keyboard-focusable and reports `aria-disabled="true"` instead
  of becoming an inert disabled placeholder.
- Tooltip/help text says `Attachments are not available yet`.
- The button renders an SVG icon and has empty text content, so the old visible
  `+` placeholder is gone.
- Attachment geometry is 24x24 px and remains within the composer control row.
- The project-scoped composer stays enabled before thread creation, remains
  820x88.09 px at the default viewport, and has no composer/control/action
  overflow.
- Console errors and failed local network requests are 0.

## Artifacts

- `project-composer.json`
- `initial-workspace.png`
- `completed-workspace.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The actual file attachment workflow is still intentionally out of scope. This
slice verifies the unavailable affordance is honest and compact, not that a file
picker opens or uploaded files can be sent to the agent.
