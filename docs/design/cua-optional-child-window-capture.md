# Optional child-window screenshots

[English](cua-optional-child-window-capture.md) | [简体中文](cua-optional-child-window-capture.zh-CN.md)

## Scope and baseline

Implement a first candidate on base `0ab64d5066fb467646b02a7309bc48632055d6e4`. A caller can request `includeChildWindows: true` on one App or exact-window observation. Omission or false preserves the base capture policy. The parameter expands visual observation only; native app target selection, AX projection and IDs, keyboard routing and pointer authorization retain their existing behavior.

The prior Freeform experiment found that including child windows exposes the pen palette at its unchanged main-window position. A screenshot-coordinate click worked with the app in the foreground. Native AXPress still failed independently of this SDK. These results do not establish background input support or compatibility with every application.

## Implementation

Add optional `include_child_windows` to the typed observation contract, generate the bindings, and expose `includeChildWindows` in the Computer Use observation options. The facade validates the Boolean and rejects true on platforms other than macOS. Native Windows/Linux requests also reject true explicitly.

On macOS, true creates a fresh ScreenCaptureKit plan with child-window capture enabled. It neither reads nor writes the default plan cache, and does not use the shell fallback whose child-window policy cannot be guaranteed. The setting is read back from the native configuration to reject unsupported OS versions. Existing attached-group display crops retain their default path; true reports screenshot unavailable on that path because it cannot promise child coverage. This first candidate does not change those crops or the no-Metal compatibility path.

The image retains the requested window coordinate frame and existing dimension/scale validation. Default and true observations therefore use the existing coordinate conversion; no new input mode or automatic retry is added. PNG dimensions alone cannot prove that a toolkit did not internally scale content: the Freeform acceptance test also compares content positions and actually clicks a visible swatch. Other toolkit acceptance remains future work.

The option is not persistent. The next observation without it uses base capture, including when the image is not returned to the caller. Current AX revision/token behavior is preserved. Unsupported expanded screenshots keep the existing truthful AX payload and invalid/unavailable screenshot diagnostics.

## Validation and acceptance

- Typed serialization and facade tests cover omitted, false, true, invalid values and unsupported platforms; fresh observations retain the same native semantic target and input route.
- Default capture retains its cache behavior; expanded capture bypasses it. Alternate true and omitted observations on the same live Freeform palette to check that the choice does not persist.
- In a fresh candidate process, capture the existing Freeform board/palette with default, true, then default again. Preserve the same live window and record bounds, image dimensions, AX and actual screenshots.
- Select a visible pen swatch once using the expanded main screenshot, then verify actual pen color and palette dismissal. Record any explicit foreground setup and distinguish it from normal App behavior. Verify Fill controls and dismissal remain available.
- Build the SDK/native library and local CLI, run targeted tests, repository build/typecheck, inspect the complete diff, and perform an independent review. This candidate is not a declaration of universal no-regression acceptance.

## Limits

Only the requested window's platform-recognized child content is requested; this is not a screenshot of all same-process windows. Content outside the existing coordinate frame, GTK group composition, mixed-DPI layouts and background popup input require further evidence before broader claims. Exact-window consumers that omit the option retain the base implementation. No PR publication or update is part of this candidate.
