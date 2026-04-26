# Settings Permissions Model Label Restraint

- Slice name: Settings Permissions Model Label Restraint
- Slice date: 2026-04-27
- Executable harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Command:
  `cd packages/desktop && npm run e2e:cdp`
- Result: pass
- Final artifact directory:
  `.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T23-38-17-611Z/`

## Scenario

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   fake ACP data.
2. Open the dirty fake project, complete the existing conversation, review,
   commit, and model settings flows.
3. Save a valid API-key provider, then save a Global Coding Plan provider.
4. Navigate to Settings Permissions from the section rail.
5. Inspect the active thread-model selector labels, titles, containment, and
   secret exposure state before continuing the existing composer and terminal
   paths.

## Assertions

- The Settings Permissions thread-model selector is enabled for the active
  thread.
- Coding Plan model options render compact visible labels such as
  `qwen3.5-plus`; no visible option text includes `ModelStudio Coding Plan`.
- Full Coding Plan provider labels remain available on option `title`
  attributes.
- All Coding Plan visible option labels are 32 characters or shorter.
- The Settings drawer does not expose `sk-desktop-e2e`, `cp-desktop-e2e`, or
  the local server URL.
- The permissions section, select control, and document do not overflow the
  viewport.
- Console errors and failed local network requests are 0.

## Artifacts

- `settings-permissions-model-label-restraint.json`
- `settings-permissions-model-label-restraint.png`
- `summary.json`
- `electron.log`

## Known Uncovered Risk

The harness verifies deterministic fake ACP and Coding Plan template models.
Live provider metadata may include other long localized prefixes, so future
provider-specific naming should reuse the shared runtime model formatter.
