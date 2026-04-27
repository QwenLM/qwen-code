# Composer Missing Key Send Guidance

Date: 2026-04-27

Slice: Composer Missing Key Send Guidance

Executable test/harness:

- `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

Scenario steps:

1. Launch real Electron through CDP with isolated HOME, runtime, user data, and
   fake ACP.
2. Seed the isolated HOME with a saved `qwen-e2e-cdp` provider model that has
   no stored API key.
3. Open the fake Git project from the no-project composer action.
4. Select `Auto Edit`, type the first prompt, and assert the composer replaces
   the draft `New thread` chip with `API key missing`.
5. Assert Send remains enabled and its title explains that sending may fail
   until the missing key is configured.
6. Continue the existing first-send, command approval, settings, branch,
   review, terminal, relaunch, and commit paths.

Assertions:

- Missing-key composer warning text is `API key missing`.
- Warning title is
  `Selected model is missing an API key; sending may fail until configured.`
- Warning chip is warning-styled, contained, and non-overflowing.
- Send remains enabled and uses the matching warning title.
- Draft `New thread` chip is absent while the warning is active.
- Fake secrets, local server URLs, raw Coding Plan labels, and diagnostics do
  not leak into the composer snapshot.
- The full CDP smoke records zero unexpected console errors and zero failed
  local requests.

Exact commands run:

```bash
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

Result: pass.

Artifacts:

- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-08-03-032Z/composer-missing-key-send-guidance.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-08-03-032Z/composer-missing-key-send-guidance.png`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-08-03-032Z/summary.json`
- `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-27T02-08-03-032Z/electron.log`

Known uncovered risk:

- The warning is based on saved provider metadata, not live provider
  validation. A provider could still fail for network, quota, base URL, or
  credential validity reasons after a key is configured.
