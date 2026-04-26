# Compact Settings Overlay Fidelity

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-45-34-724Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project, create a task from the composer, approve the fake
   command request, review changes, cancel discard, stage, and commit.
3. Return to Conversation, open Settings, and assert the right-side overlay
   keeps chat and the terminal strip mounted while closing Review.
4. Assert the Settings close control is icon-led, focused, accessible, and
   compact, and that the backdrop remains pointer-clickable without becoming a
   keyboard tab stop.
5. Resize the real Electron window to the compact `960x640` desktop viewport,
   assert overlay geometry and internal sheet scrolling, then restore the
   default viewport.
6. Continue the existing settings validation, Coding Plan provider, Advanced
   Diagnostics, composer model switching, and terminal attachment paths.

## Assertions

- Default Settings sheet is right-aligned at 680x738 px with a 316 px backdrop.
- Compact Settings sheet is right-aligned at 620x558 px with a 108 px backdrop.
- Close control is focused on open, has `aria-label="Close Settings"`, contains
  an icon, has no visible text, and remains 28x28 px.
- Backdrop has `tabindex="-1"` and `aria-hidden="true"` while still closing the
  overlay on pointer click.
- Compact Settings avoids body/document overflow; Settings content scrolls
  internally and permissions become reachable at scrollTop 453.5.
- Default Settings does not expose server URLs, Node versions, ACP/session IDs,
  settings paths, runtime diagnostics, or fake API keys.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `settings-layout.json`
- `compact-settings-overlay.json`
- `settings-page.png`
- `compact-settings-overlay.png`
- `settings-validation.json`
- `settings-product-state.json`
- `settings-coding-plan-provider.json`
- `settings-advanced-diagnostics.json`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies initial modal focus on the close control, but it does not
yet assert Escape-to-close behavior or focus restoration to the Settings
launcher after the sheet closes.
