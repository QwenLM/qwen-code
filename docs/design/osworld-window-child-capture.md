# Exact window capture and child composition

[English](osworld-window-child-capture.md) | [简体中文](osworld-window-child-capture.zh-CN.md)

## Evidence and scope

Status: candidate cbeefff9 built and independently reviewed; real public SDK Welcome/main read-only comparison passed, menu and input regressions pending. On the same GIMP 3.2.4 Welcome window (PID45849/CG36191,610×679 points), the asynchronous read-only SCK probe reports includeChildWindows=true by default. Its1220×1358 PNG compresses the parent image window and Welcome into the requested frame, followed by a large black region. Explicit false produces the correctly sized Welcome alone; a selected-window display filter with sourceRect also produces the correct content. Root inspected all three PNGs. Q30 historical call4 has the same parent/group/black-region pattern. No comparable baseline window-scoped composition failure has been established.

Evidence is in `.qwen/investigations/gimp-welcome-sck-async-20260912`. The N-API async probe releases the Node event loop; earlier blocking probes timed out and remain recorded. Capture calls were105/40/37ms in fixed order, so this is a geometry/configuration control, not a speed comparison. It sends no input or Apple Event. At that probe stage, case30R1 had been prepared with frozen b47 but no agent had started, and GIMP consent for the historical getter was pending.

## Candidate and boundaries

For desktop-independent window capture, explicitly set `SCStreamConfiguration::with_includes_child_windows(false)` using the already installed screencapturekit6.0.1/macOS15 feature chain. Do not change dependencies or the existing confirmed-AppKit-sheet display-crop branch. Preserve requested dimensions, owner/frame revalidation, cache keys, permission checks, and current failure behavior. This change addresses composition; it does not resolve GIMP's unreadable AX Help search child or authorize new AX tokens.

Single-window observations must depict the addressed target at its declared pixel coordinates. Menus/popovers and legitimate child content require regression checks: a smaller or missing UI is not a successful fix. If suppressing child composition makes an existing supported menu flow unobservable, reject or narrow the candidate before use. Offscreen/cross-display and older OS behavior are not established by the on-screen control.

## Verification

Existing macOS library tests and the release build returned zero; the candidate is stored separately. Independent fixed R4 MCP old/new comparisons produced eight PNGs across two rounds. Same-version images were byte-identical; the new Welcome is1220×1358 with correct target-only content, and main is1567×815 without the Welcome composite. AX completeness, stable token availability and same-PID background keyboard ambiguity refusal were unchanged. Root also inspected the actual public-SDK PNGs. Evidence: `.qwen/investigations/gimp-window-child-capture-metadata-20260912/`; static review: `.qwen/pr-reviews/osworld-window-child-capture.md`.

Before whole-candidate acceptance, check a real brightness dialog, ordinary app window/menu, an AppKit attached panel, and actual coordinate input. Keep prepared runtimes immutable and put the candidate in a new native directory; a full case30 run using it needs a new prepared run and the modified Skill hash. These current-scene captures do not constitute whole-candidate acceptance or a speed comparison. No1.5× claim is made before a complete comparable task run.
