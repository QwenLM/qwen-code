# macOS App popover controls

[English](cua-macos-app-popovers.md) | [简体中文](cua-macos-app-popovers.zh-CN.md)

## Status and problem

Bug fix verified, 2026-09-24. In Freeform, the drawing color button appears in the App accessibility text but has no action or writable value, so it receives no action token and `app.click(id)` fails. Clicking its screen position opens a separate, untitled 270×300 palette window. The App facade continues observing the main board and hides that palette. The palette has no AX window entry, so ordinary background pointer safety checks refuse it; foreground delivery waits for AX focus that this window cannot report.

## Scope and design

Give framed, enabled `AXButton` nodes in macOS App window observations an action index even when they advertise no AX action. The existing App click actuator then uses the button's frame for a background pointer click, keeping a transient palette open across the following observation. Legacy and open-menu AX walks are unchanged.

On macOS, when one visible, untitled, layer-zero window of the same process is above and contained within the native App target, and is smaller than it, the App facade treats the topmost such window as the current surface. It uses the on-screen window list for this stacking comparison: macOS's all-window list can assign reversed `z_index` values when off-screen windows are included. The all-window list still resolves the native target, including minimized windows. Changing surfaces invalidates prior IDs and screenshot coordinates. App clicks on that auxiliary window use background pointer delivery. App key, hotkey, text and paste operations keep the native target window ID because the auxiliary window cannot become the AX focused window; this preserves `Escape` dismissal. The macOS actuator accepts the pointer exception only after checking current WindowServer ownership, geometry and stacking order again under the per-process mutation lock; all other AX-unresolved windows retain the existing refusal. The pointer event remains addressed to the exact window ID. The action record reports the delivery mode actually used. Other platforms continue to use their native App target.

## Constraints and risks

The palette exposes no AX elements, so color choice uses its screenshot coordinates. A topmost untitled tool window that satisfies the same geometric test may also be selected; this is appropriate while it is the visible App surface, but automated selection must still verify the next state. The special input path must never accept a foreign PID, a hidden or off-Space window, an uncovered sibling, or a stale window ID.

## Validation and acceptance

Run focused App and macOS native tests, SDK and repository builds, and repository typecheck, then a real Freeform sequence from the authorized ChatGPT process: open Drawing Tools, click the color button by ID, observe the palette as the current App window, click a red cell by its fresh screenshot coordinates, and verify the main-window color value changes from black. Confirm the board's existing drawing count stays fixed until a deliberate drawing action. Verify `Escape` dismisses a fill popover while App observes it. Inspect the complete diff twice after the last change. In the real Freeform run, the color value changed from `black` to `vermilion`; the existing 43 drawings were unchanged. A later Freeform run observed a fill popover, dismissed it with one confirmed `Escape`, and returned to the board with its solid blue rocket intact. The SDK-only computer-use typecheck is blocked by pre-existing generated declarations that omit imports for `UniffiGcObject` and `UniffiHandle`; the targeted check passes with `skipLibCheck`.
