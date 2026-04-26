# Composer Model Providers Shortcut

Date: 2026-04-27

Slice: composer model settings shortcut.

Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP workspaces.
2. Open `desktop-e2e-workspace` while no thread is selected.
3. Assert the project-scoped composer is enabled and runtime selectors remain
   disabled until a thread exists.
4. Click the composer `Configure models` icon control.
5. Assert the Settings drawer opens at Model Providers and focuses the provider
   selector.
6. Close Settings and continue the existing CDP smoke workflow.

Assertions:

- The composer shortcut is icon-only, compact, accessible, and does not
  overflow the composer.
- Settings opens with `data-initial-section="settings-model-providers"`.
- `settings-provider-select` is visible and focused.
- The settings drawer keeps the conversation in the background.
- No API keys, fake secrets, runtime diagnostics, ACP ids, console errors, or
  failed local requests appear in the user-visible path.

Command:

```bash
cd packages/desktop && npm run e2e:cdp
```

Result: passed on 2026-04-27.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-10-46-770Z/`

Recorded artifact highlights:

- `composer-model-settings-shortcut.json` recorded
  `initialSection: "settings-model-providers"` and `providerFocused: true`.
- The shortcut recorded `ariaLabel: "Configure models"`, no direct text, a
  24 px by 24 px rect, `overflows: false`, and `composerOverflow: false`.
- Diagnostics, fake secrets, document overflow, and settings overflow were all
  absent.

Known uncovered risk: this harness verifies the product route and layout with
fake settings data, but it does not validate live provider credentials.
