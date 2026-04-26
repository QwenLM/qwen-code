# Settings Save Status Feedback

Date: 2026-04-27

Slice: settings save status feedback.

Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP workspaces.
2. Open Settings and exercise invalid API-key provider fields.
3. Save a valid API-key provider with fake credentials.
4. Verify the inline saved status row and then edit the provider model field to
   confirm stale saved feedback clears.
5. Switch to Coding Plan, validate its required API key, save it, and verify
   the saved Coding Plan status.
6. Continue the existing draft composer and active composer model visibility
   checks.

Assertions:

- API-key provider save renders `settings-save-status` with `role="status"`,
  `aria-describedby="settings-save-status"` on Save, and text
  `Saved API key provider · qwen-e2e-cdp · API key configured`.
- Editing provider fields clears the saved status row and Save no longer points
  at the stale status.
- Coding Plan save renders `Saved Coding Plan provider · Global · API key
  configured` with `role="status"`.
- Provider API key inputs remain password fields and are cleared after save.
- Fake API keys, local server URLs, diagnostics, console errors, failed
  requests, and layout overflow are absent from the verified path.

Commands:

```bash
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/stores/settingsStore.test.ts
cd packages/desktop && SHELL=/bin/bash npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
node --check packages/desktop/scripts/e2e-cdp-smoke.mjs
cd packages/desktop && npm run typecheck
cd packages/desktop && npm run lint
cd packages/desktop && npm run build
cd packages/desktop && npm run e2e:cdp
```

Result: passed on 2026-04-27.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-29-32-217Z/`

Recorded artifact highlights:

- `settings-save-status-feedback.json` recorded saved API-key status, cleared
  stale status after edit, no fake secrets, no server URL, and no overflow.
- `settings-coding-plan-provider.json` recorded saved Coding Plan status,
  cleared API key field value, no visible fake secret, and no document
  overflow.
- `summary.json` recorded no console errors and no failed requests.

Known uncovered risk: the harness uses fake provider credentials and does not
validate live provider authentication or upstream model reachability.
