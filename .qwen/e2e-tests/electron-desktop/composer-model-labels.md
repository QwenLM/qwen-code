# Composer Model Labels

- Slice name: Compact Composer Model Labels
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T17-21-12-541Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and a
   fake dirty Git workspace.
2. Complete the carried open-project, composer-first send, command approval,
   branch, review, discard-cancel, commit, settings, and Coding Plan provider
   paths.
3. Return to Conversation with the composer visible and model picker enabled.
4. Assert Coding Plan model options use compact visible labels while preserving
   exact model IDs.
5. Switch the composer model to `qwen3-coder-next`, assert the compact selected
   label and full native title, then switch back to `qwen-e2e-cdp`.

## Assertions

- The composer model picker is enabled for the active thread.
- Model option `value` attributes preserve the exact runtime model IDs.
- No composer option text includes the raw `ModelStudio Coding Plan` prefix.
- Coding Plan model labels are compact, including `qwen3-coder-next`.
- The selected `qwen3-coder-next` option keeps native title text:
  `[ModelStudio Coding Plan for Global/Intl] qwen3-coder-next`.
- The composer remains contained in the chat panel and does not overflow after
  switching models.
- The model is restored to `qwen-e2e-cdp`.
- Visible DOM and input values do not expose fake API keys or the local server
  URL.
- Console errors and failed local network requests are 0.

## Artifacts

- `composer-model-switch.json`
- `settings-coding-plan-provider.json`
- `settings-coding-plan-state.png`
- `completed-workspace.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

Native select dropdown rendering is platform-owned, so the harness verifies DOM
labels, selected state, titles, and composer geometry rather than pixel-testing
the opened dropdown menu.
