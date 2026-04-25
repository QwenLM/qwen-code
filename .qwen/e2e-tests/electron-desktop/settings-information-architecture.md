# Settings Information Architecture

- Slice date: 2026-04-26
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-25T17-40-11-622Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Open the fake project, send the first composer prompt, approve the fake
   command request, review changes, cancel discard, stage, and commit.
3. Open Settings from the workbench.
4. Assert product sections are visible: Account, Model Providers, Permissions,
   Tools & MCP, Terminal, Appearance, and Advanced.
5. Assert default Settings text does not expose server URL, Node version, ACP
   status, health milliseconds, settings path, or the active session ID.
6. Edit Model, Base URL, and API key fields, save, and assert the saved model
   is visible without exposing the fake secret.
7. Open Advanced Diagnostics and assert runtime/session diagnostics are visible
   only after that explicit action.

## Assertions

- Settings replaces chat, review, and terminal while it is open.
- Model and permission controls have stable `data-testid` hooks.
- Runtime diagnostics are absent from the default settings view.
- Advanced Diagnostics shows Server, Node, ACP, Health, Settings path, and
  active session diagnostics after opening.
- API key input remains a password field and is cleared after save.
- Console errors: 0.
- Failed local network requests: 0.

## Artifacts

- `settings-layout.json`
- `settings-product-state.json`
- `settings-advanced-diagnostics.json`
- `settings-page.png`
- `electron.log`
- `summary.json`

## Known Uncovered Risk

The harness verifies a deterministic fake ACP session and one API-key provider.
It does not yet cover Coding Plan save flows, invalid API key validation, or
keyboard-only navigation through every settings section.
