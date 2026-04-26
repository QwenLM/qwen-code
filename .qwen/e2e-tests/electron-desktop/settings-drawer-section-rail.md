# Electron Desktop E2E: Settings Drawer Section Rail

Date: 2026-04-26

## Slice

Settings Drawer Section Rail

## Executable Coverage

- Harness: `packages/desktop/scripts/e2e-cdp-smoke.mjs`
- Targeted component test:
  `packages/desktop/src/renderer/components/layout/WorkspacePage.test.tsx`

## Scenario Steps

1. Launch the real Electron app with isolated HOME, runtime, user-data, and
   deterministic fake ACP/project data.
2. Open the dirty fake project, relaunch to verify recent project recovery,
   send prompts, approve the command card, answer the inline question, review
   and commit changes, then open Settings.
3. Assert Settings is a right-aligned drawer that keeps the conversation
   mounted and visible behind the backdrop.
4. Assert the `Settings sections` rail contains Account, Model Providers,
   Permissions, Tools & MCP, Terminal, Appearance, and Advanced.
5. Click the Permissions rail entry and assert only the settings drawer content
   scrolls; body/document scroll remains unchanged.
6. Assert runtime diagnostics, local server URLs, ACP/session IDs, and settings
   paths stay hidden until Advanced Diagnostics is opened.
7. Continue the existing settings validation, Coding Plan provider, model
   switch, terminal, branch, compact layout, and relaunch workflows.

## Assertions

- Default settings drawer width is drawer-like and no wider than 640 px.
- The section rail is compact, accessible, and separated from the single
  settings content column.
- Settings sections share one column and do not return to the old two-column
  card dashboard.
- Compact viewport keeps the drawer contained with no body overflow.
- Diagnostics remain hidden by default and appear only after Advanced
  Diagnostics.
- Real Electron console errors and failed local requests are empty.

## Command

```bash
cd packages/desktop && npm run e2e:cdp
```

## Result

Passed.

Artifacts:
`.qwen/e2e-tests/electron-desktop/artifacts/2026-04-26T21-36-23-530Z/`

Key files:

- `settings-layout.json`
- `settings-page.png`
- `settings-section-rail-navigation.json`
- `compact-settings-overlay.json`
- `compact-settings-overlay.png`
- `summary.json`

## Known Uncovered Risk

The rail does not yet show active-section state while scrolling. This slice
keeps navigation local and deterministic; active-section tracking can be added
later without changing server or settings persistence contracts.
