# Optional child-window screenshots

[English](cua-optional-child-window-capture.md) | [简体中文](cua-optional-child-window-capture.zh-CN.md)

## Scope and baseline

The implementation starts from base `0ab64d5066fb467646b02a7309bc48632055d6e4` and is rebased onto main `fc4e01b9fc381952c15592ead9e0cf170754dd8d`, whose CUA driver is unchanged from that base. A caller can request `includeChildWindows: true` on one App or exact-window observation. Omission or false preserves the base capture policy. The parameter expands visual observation only; native app target selection, AX projection and IDs, keyboard routing and pointer authorization retain their existing behavior.

The prior Freeform experiment found that including child windows exposes the pen palette at its unchanged main-window position. A screenshot-coordinate click worked with the app in the foreground. Native AXPress still failed independently of this SDK. These results do not establish background input support or compatibility with every application.

## Implementation

Add optional `include_child_windows` to the typed observation contract, generate the bindings, and expose `includeChildWindows` in the Computer Use observation options. The facade validates the Boolean and rejects true on platforms other than macOS. Native Windows/Linux requests also reject true explicitly.

On macOS, true creates a fresh ScreenCaptureKit display filter restricted to the requested window with child-window capture enabled. An explicit source rectangle crops to that window’s screen bounds; output dimensions use the same bounds and display scale. This avoids desktop-independent capture scaling an out-of-bounds attachment group into the parent’s original image size. Child pixels outside the parent frame are clipped, so this does not expose an expanded coordinate canvas. It neither reads nor writes the default plan cache, and does not use the shell fallback whose child-window policy cannot be guaranteed. The setting is read back from the native configuration to reject unsupported OS versions. Existing attached-group display crops retain their default path; true reports screenshot unavailable on that path because it cannot promise child coverage. The new mode requires Metal, an on-screen window and full containment within one display. Unsupported configurations return no image. Default attached-window crops and the no-Metal compatibility path remain unchanged.

The image retains the requested window coordinate frame and existing dimension/scale validation. Default and true observations therefore use the existing coordinate conversion; no new input mode or automatic retry is added. PNG dimensions alone cannot establish correct content geometry. An AppKit edge-popover experiment reproduced 60×60 landmarks shrinking to 41×42 inside a nominally valid 620×492 image in the first candidate. The corrected crop must preserve these landmarks; Freeform and contained-popover acceptance also require an actual coordinate action from a freshly inspected image.

The option is not persistent. The next observation without it uses base capture, including when the image is not returned to the caller. Invalid values and unsupported platforms are rejected before App target resolution or launch. The platform check uses connection metadata; explicit platform queries refresh it and reconnect clears it. Closed-instance and cancellation checks still precede cached validation. Expanded captures hide the cursor. Exact-window callers must also request an image with `includeScreenshot: true` or `screenshotOutFile`.

Current AX revision/token behavior is preserved. Unsupported expanded screenshots keep the existing truthful AX payload and invalid/unavailable screenshot diagnostics. Observation text preserves a bounded error code and reason, including the reason's tail, and identifies false as the default capture option. Missing-window and frame-mismatch errors instead advise observing the current window again. The warning and AX details share the text budget, with truncation marked even at the 512-character minimum.

The App facade refuses screenshot-coordinate input after an observation without a valid image and retains current AX actions. Direct-window and raw consumers must check frame validity and obtain a successful current screenshot before using coordinates. This change does not add an image-epoch protocol to raw input or make the shared native resize registry session-specific. Retaining an old ratio alone would not prove that it still matches current geometry, configuration, or internally generated AX coordinates.

## Validation and acceptance

- Typed serialization and facade tests cover omitted, false, true, invalid values and unsupported platforms; fresh observations retain the same native semantic target and input route.
- Default capture retains its cache behavior; expanded capture bypasses it. Alternate true and omitted observations on the same live Freeform palette to check that the choice does not persist.
- In a fresh candidate process, capture the existing Freeform board/palette with default, true, then default again. Preserve the same live window and record bounds, image dimensions, AX and actual screenshots.
- Select a visible pen swatch once using the expanded main screenshot, then verify actual pen color and palette dismissal. Record any explicit foreground setup and distinguish it from normal App behavior. Verify Fill controls and dismissal remain available.
- Compare an AppKit contained popover, an edge popover, a modal sheet and a moved/resized window against base. Inspect fixed pixel landmarks, target/AX controls and explicit unsupported diagnostics. A supported contained-popover click must increment its independent fixture counter.
- Build the SDK/native library and local CLI, run targeted tests, repository build/typecheck, inspect the complete diff, and perform an independent review. This candidate is not a declaration of universal no-regression acceptance.

## Limits

Only the requested window’s platform-recognized child content is requested; unrelated windows are excluded. Content outside the existing coordinate frame is clipped. GTK group composition, mixed-DPI layouts, older macOS/no-Metal environments and background popup input are not established by the local Freeform/AppKit checks. Exact-window consumers that omit the option retain the base implementation. Missing environments must be reported as untested; targeted checks do not constitute the full canonical GUI matrix or a universal no-regression claim.
