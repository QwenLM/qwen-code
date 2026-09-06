# Qwen normalized-coordinate boundary

## Contract

`CUA_DRIVER_RS_COORDINATE_SPACE=1` enables the Qwen 0-1000 coordinate
contract. Pixel semantics remain the default. `CUA_DRIVER_RS_COORDINATE_SCALE`
can override the full scale; invalid or zero values fall back to 1000.

The switch is process-owned configuration. Public tool arguments cannot enable
or disable it.

## Canonical placement

The translation layer lives in `cua-driver-core` and is called by
`ToolRegistry`, the canonical authorization and dispatch boundary shared by
MCP, CLI, daemon, private-worker, replay, and direct SDK paths.

The public normalized arguments are retained for authorization, consent,
recording, and action evidence. A private copy is converted to pixels only
after admission and immediately before platform dispatch. Results feed the
runtime-scoped size caches before any public projection.

This placement is required by the 0.17 SDK architecture: transforming only an
MCP handler or daemon route would let other transports bypass the contract.

## Coordinate bases

- Window-local actions use the latest `get_window_state` screenshot dimensions
  for the exact `(runtime, pid, window_id)`.
- Desktop-scope actions use the latest `get_desktop_state` screenshot size.
- Screen-space actions such as `move_cursor` and `set_window_frame` use the
  latest logical `get_screen_size` dimensions.
- Zoom-image actions use the cached dimensions of the corresponding zoom
  result.
- `parallel_mouse_drag` resolves every item independently.
- `verify_state.expect[].window.bounds` uses the logical screen basis.

All mutable bases are keyed by the runtime-private scope installed by the
registry. A public session id cannot select another runtime's cache.

The conversion is:

```text
pixel = round(normalized / scale * dimension)
```

If the required basis has not been observed, dispatch fails closed with a
request for the appropriate fresh state call. It never treats normalized
values as literal pixels.

## Covered inputs

- `click`, `double_click`, `right_click`
- `drag`, `mouse_drag`, `mouse_button_down`, `mouse_button_up`
- `zoom`, including `from_zoom`
- `scroll`
- focus coordinates on `type_text`, `press_key`, and `hotkey`
- `parallel_mouse_drag`
- `move_cursor`
- `set_window_frame`
- `verify_state` window bounds

Browser raw coordinates are CSS pixels and do not share a desktop screenshot
basis. In normalized mode, `browser_click` and `browser_pointer` reject raw
coordinate fields and direct the caller to use a fresh browser ref.

## Published schemas and results

`tools/list` descriptions are rewritten only when normalized mode is active.
The same configured scale appears in field descriptions and MCP instructions.
Pixel mode preserves the upstream schema.

Query results remain byte-compatible with upstream. In particular,
`screenshot_width`, `screenshot_height`, accessibility frames, window bounds,
and cursor positions retain their real pixel/point values; rewriting them to
1000 would create contradictory geometry in one payload.

## Validation

Unit tests cover conversion, missing-basis failures, runtime cache isolation,
zoom and nested coordinates, browser fail-closed behavior, schema rewriting,
and the registry switch. Release validation must additionally exercise both
modes through the packaged MCP binary on each supported desktop platform.
