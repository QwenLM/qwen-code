# TUI dialog review regressions

## Baseline

The global CLI was opened in a 70-column, 24-row terminal with
`QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true`, safe mode, fixture OpenAI credentials,
and a loopback endpoint. After dismissing the provider notice, `/model` opened
the model selector and its detail panel without sending a model request.
The installed binary does not reproduce the pinned source or controlled nested
dialog bounds. Exact-head component tests supply those fixtures; the initial
reproduction failed 21 assertions across five files.

## Interactive model selector

Run `interactive/tui-dialog-bounds.test.ts` from `integration-tests` after
building and bundling. Run once with `QWEN_E2E_RENDERER=ink` and
`QWEN_E2E_RUNTIME=node`, then with `QWEN_E2E_RENDERER=opentui` and
`QWEN_E2E_RUNTIME=bun`.

1. Start with twelve configured fixture models and a local fake model server.
2. Resize to 70 columns and 18 rows and open `/model`.
3. Require the title, keyboard footer and multiple model choices to remain
   visible. Compact mode must omit the detail panel in both renderers.
4. Dismiss with Escape, require the selector to disappear, and exit cleanly.
   The fake server must receive no model requests.

Run the existing extension acquisition interaction in both renderer/runtime
combinations to check that install-time dialogs still open and dismiss.

## Controlled layout and theme fixtures

- Render the actual extensions manager and Installed tab inside clipped
  16- and 20-row providers. Navigate a 24-entry list to entry 16. Require its
  selected marker, the footer, and the complete wrapped Chinese error message
  to stay visible within the frame height.
- Verify the manager publishes its actual remaining rows and inner columns.
  A Discover search box must use its supplied 60-column width directly.
- Exercise compact model capacities with descriptions and errors. Check
  non-floating agent dialogs do not add a second composer placeholder while
  the real inactive composer retains its draft.
- Pin both Qwen palettes and apply every built-in theme plus NoColor. Missing
  optional surfaces must not throw or retain the previous theme's surface.
- Use meaningful constrained fixtures for Help, Rewind, Permissions, Skills,
  Discover and Installed lists. Check real DialogManager handoffs, overlay
  measurements, activity data and inactive/cancel input gates.
- Check pending-to-committed code styling. Internal notice-budget branches
  require isolating the earlier public pre-slice; retain a separate public
  rendering assertion rather than describing unreachable branches as defects.

Runtime-only mutation probes should fail the intended assertions when these
bounds, handoffs or semantic tokens are removed. Compilation or module-loading
failures do not count as discriminatory test evidence. Keep mutation transforms
outside the source checkout.
