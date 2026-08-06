# Narrow empty-session composer anchoring

## Scenario

Open the WebShell composer-layout harness without a session, with
`mobileWelcomeFooterMiddle` enabled and welcome header/footer renderers. At a
760px viewport width, the empty chat pane uses the mobile composer-bottom
layout. Resize to 761px and back to 760px, exercise the supported custom footer,
and repeat at short 400px and 320px pane heights.

## Checks

- The composer footer occupies a real bottom grid row aligned with the full
  chat-pane bottom at 760px.
- The welcome header stays above the composer at normal and short pane heights;
  the dot field covers the pane, stays behind the foreground, and does not
  capture pointer events.
- Without a welcome footer, the welcome header remains vertically centered in
  the available row above the composer.
- A custom footer stays in the same real bottom wrapper above the composer.
- Applying the production hidden-chat class still removes the grid from layout,
  matching the panel/full-page visibility contract.
- The composer accepts text input.
- At 761px, the mobile bottom-grid rule is inactive; resizing back restores the
  bottom anchoring.

## Evidence

Before the CSS repair, the internal Chromium harness measured a 419px gap
between the composer footer bottom and the chat-pane bottom at 760x900. The
focused upstream command is:

```sh
npx playwright test --config packages/web-shell/playwright.config.ts packages/web-shell/client/e2e/web-shell.smoke.spec.ts packages/web-shell/client/e2e/web-shell.composer.mobile.spec.ts --grep 'anchors the empty mobile composer|anchors a custom footer|keeps centered welcome content clear|preserves the hidden empty mobile chat'
```

After the repair and edge-case hardening, the focused upstream run passed
(`6 passed`, 9.3s). The
embedded extension-host browser verification also passed in Chrome on macOS
using the naturally narrow Data Agent sidebar: the welcome content stayed
centered, the composer aligned with the sidebar bottom, the dot field remained
behind the foreground, and a temporary draft could be entered and cleared
without submission.

A baseline dry-run against the global `qwen` CLI is not applicable to this
host-only layout path. The CLI does not render the WebShell DOM or expose the
host props `mobileWelcomeFooterMiddle`, `renderWelcomeHeader`, and
`renderWelcomeFooter` needed to trigger it. The executable baseline is instead
the real Chromium composer-layout harness above, which reproduced the defect as
a 419px footer-to-pane bottom gap before the CSS repair.
