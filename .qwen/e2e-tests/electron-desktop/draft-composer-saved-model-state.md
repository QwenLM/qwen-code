# Draft Composer Saved Model State

Date: 2026-04-27

Slice: draft composer saved model state.

Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`

Scenario steps:

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP workspaces.
2. Save API-key and Coding Plan provider settings through the existing Settings
   workflow.
3. Return to Conversation and click `New Thread` to enter the project-scoped
   draft composer state.
4. Assert the disabled composer model picker is populated from saved configured
   models instead of the fallback default.
5. Select an existing thread again and continue the active-thread model switch
   and terminal workflows.

Assertions:

- The draft composer model select and permission select both remain disabled
  until an ACP session exists.
- The model select has configured model options, includes `qwen-e2e-cdp`, and
  does not show `Default model`.
- Long Coding Plan provider prefixes are stripped from visible option text
  while preserved in option titles.
- The composer remains contained and does not overflow.
- No API keys, fake secrets, local server URLs, console errors, or failed local
  requests appear in the user-visible path.

Command:

```bash
cd packages/desktop && npm run e2e:cdp
```

Result: passed on 2026-04-27.

Artifact directory:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-19-45-738Z/`

Recorded artifact highlights:

- `draft-composer-saved-model-state.json` recorded `disabled: true` and
  `permissionDisabled: true`.
- The selected draft model was `qwen3.5-plus`, and the saved configured option
  list included `qwen-e2e-cdp`.
- `hasDefaultModel`, `hasRawCodingPlanLabel`, `hasSecret`, `hasServerUrl`,
  `composerOverflow`, `modelControlOverflow`, and `documentOverflow` were all
  false.
- `summary.json` recorded no console errors and no failed requests.

Known uncovered risk: this harness verifies saved model visibility with fake
provider credentials, but it does not validate live provider authentication.
