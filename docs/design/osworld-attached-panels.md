# OSWorld attached panel efficiency

[English](osworld-attached-panels.md) | [简体中文](osworld-attached-panels.zh-CN.md)

## Evidence and scope

Status: native 94eb59d2 built; independent panel, Unicode, stale-token and Excel LF checks passed. Formal review: No findings. Full case34 R2 timing was pending at that stage. Later case34 R4/R5 runs exercised the fix; R5 took 221.175 seconds overall and did not meet the 1.5× limit. Case34 R1 used native d8ddc9ea and the archived prompt, input hashes, setup and scorer rules. It stopped diagnostically at 181.419 seconds without an MP3. This is not a completed timing result. The historical baseline is 108.392 seconds; the 1.5× limit is 162.588 seconds. Local model provider and unavailable historical scorer internals remain documented comparability limits.

Independent reproduction found Convert → Open → Go To as directly attached AXSheet children with distinct CGWindowIDs, omitted from AXWindows. AXSheets is unsupported. Existing observation matches only top-level AXWindow. Single-window ScreenCaptureKit puts the entire window group into sheet-sized output, producing incorrect pixel coordinates. A selected-window display filter cropped to the sheet's actual bounds produces the correct content. Foreground typeText delivers zero characters while physical foreground keys work. Identical Unicode events with the public PID route also deliver zero, while global HID correctly inserts ASCII and Chinese. The control does not recreate the SDK authentication envelope.

## Changes and boundaries

Discover directly attached AXSheet children with bounded reads and CFEqual identity deduplication. This is attachment discovery, not a second full control-tree walk. On an otherwise unresolved sheet request, walk the uniquely mapped sheet itself. Preserve normal window/menu and browser consent behavior. Keep top-level window APIs used by resize, menu and document activation unchanged. Unknown mappings remain unresolved.

Use a display filter including only the selected window, with a display-relative source rectangle, for confirmed attached window groups. Require the entire requested frame to fit one display. Keep desktop-independent capture for ordinary windows. Never use the known incorrect shell group capture as fallback for a confirmed group. Revalidate window ownership, frame and group classification around capture; do not use parent-only cropping or relax geometry checks. Cross-display/offscreen groups may return screenshot unavailable. Explicitly failed AX classification also selects display cropping, so an on-screen screenshot does not require Accessibility permission. Revalidate on-screen status to avoid a stale crop after a Space switch.

Explicit foreground Unicode delivery now uses the existing exact-window HID guard and global Unicode function; proof comes from the same-event routing control plus the failing SDK call. Keep background delivery, default typing delays, Screen Sharing physical delivery and exact-target refusals separate. Do not attribute wrong-parent focus refusals to an SDK defect.

## Verification and acceptance

Test sheet-only scoping, wrong/stale IDs, duplicate identities, read limits, ordinary menu/consent behavior and group capture bounds. Independently verify real Open and nested Go To observations, pixel alignment, short Unicode input and unchanged wrong-parent refusals. Build native code, run affected tests, complete two clean self-audits and independent review. Then rerun case34 with a fresh input-only workspace and fixed native hashes, the original prompt/setup/result getters/scorer rules, and record full execution duration separately from agent duration and completion. Continue the ranked queue; this patch alone does not establish the 1.5× goal.
