# CUA tool failures and efficiency fixes

[English](cua-tool-efficiency-fixes.md) | [简体中文](cua-tool-efficiency-fixes.zh-CN.md)

## Scope

This document consolidates the bugfixes found during OSWorld execution through Codex CLI app-server → local Node REPL MCP → Qwen CUA SDK → in-process macOS native library. It covers failed or ineffective tool calls and avoidable execution overhead. Task scores are not the efficiency criterion; four full-task regressions do not establish acceptance across all 20 tasks or the ≤1.5× baseline time target.

## Problems and fixes

| Problem and cause                                                                                                                                                                     | Implemented change                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old REPL helpers read stale observations because later cells copied bindings. Compact nested `await` could merge with an injected guard.                                              | Share private lexical-binding accessors across cells and preserve whitespace around cancellation instrumentation.                                                                                                                  |
| A long-lived MCP missed launched/exited apps and foreground changes because AppKit state depended on main-run-loop updates. App discovery also launched one plist subprocess per app. | Query live process membership/foreground through Process Manager and parse XML/binary plists in process with CoreFoundation. AppKit still supplies metadata; no explicit app cache is added.                                       |
| Foreground shortcuts lost modifiers or failed to select text; Unicode LF did not produce a spreadsheet row boundary.                                                                  | Use exact-window guarded foreground delivery, explicit modifier flags/transitions, Command aliases (`meta`/`super`) and Arrow-key aliases. Require one base key per chord. Emit Return for LF/CR and coalesce CRLF.                |
| Excel Name Box and Colors text fields do not advertise `AXPress`, so semantic clicks failed.                                                                                          | For eligible editable combos/text fields, focus through writable `AXFocused` and confirm the actual focused identity with the original value preserved. Resolve secondary-action aliases only to uniquely advertised actions.      |
| Attached file panels were absent from top-level `AXWindows`; visible nonzero-layer dialogs could be omitted or incorrectly expired.                                                   | Discover directly attached sheets by exact identity. Supplement PID-filtered discovery with AX-proven dialogs and use all layers for same-owner window lifetime checks.                                                            |
| Repeated/cyclic AX identities exhausted traversal limits; an empty Help-search child invalidated otherwise usable observations.                                                       | Deduplicate retained identities across the entire walk with `CFHash`/`CFEqual`; narrowly omit only directly verified empty search-field placeholders.                                                                              |
| Window-group composition put parent content or black padding into the target screenshot.                                                                                              | Capture attached groups through a selected-window display crop. For ordinary desktop-independent window capture, explicitly disable child-window composition; this latest adjustment has limited GUI verification.                 |
| The public facade lost nested capture completeness, geometry/degradation context and native action notices.                                                                           | Prefer `observation_revision.capture_complete`, retain legacy fallback and context, and preserve native text alongside structured action evidence.                                                                                 |
| An initial detector sleep delayed the first observation; callers also reused wrong windows, coordinates or delivery modes.                                                            | Sample once before sleeping while retaining the normal deadline. Update the Skill to select visible targets, batch stable-window actions, rediscover dialogs, use screenshot pixels and inspect state before retrying an AX error. |

## Behavioral contracts

### REPL state

Bindings remain owned by their declaring module, not `globalThis`. Old helper reads/writes and later assignments share state immediately, including within one statement. Preserve redeclaration errors, repeated `var` and destructuring/loop targets, lexical shadowing, const/TDZ, bare-call `this`, shorthand properties, inferred function/class names and strict unqualified-delete errors. Undeclared forward references retain the existing module behavior; this is not a global Script REPL.

Ordinary errors restore the last completed statement/declarator checkpoint. Timeout/cancellation restores binding values from cell entry without publishing new bindings. Object mutations and external side effects are not rolled back; continuation guards and native terminal barriers remain effective.

### Input and observation

Process Manager APIs are deprecated but available on the verified host. The fix establishes live membership/foreground queries without taking over the host main thread; it does not make every AppKit property, including activation policy, freshly updated.

Preserve exact PID/window ownership, focus guards, background refusals, Screen Sharing physical routing, single-key flags and web coordinate-focus fallback. Foreground Unicode uses the existing exact-window HID guard and revalidates the target after focus preparation. Default character pacing, ordinary Unicode/Tab and atomic AX insertion remain unchanged. Readback across Return must not manufacture a single-field partial offset that would invite incorrect replay.

Editable-field focus requires an unmodified click, no advertised `AXPress`, writable `AXValue`/`AXFocused`, readable unchanged values and a fresh exact focused identity. Only a combo may accept its direct text-editor child. Failure does not trigger another action; confirmed focus does not prove later submission or application linkage.

AX deduplication retains the first DFS appearance and traverses unseen descendants; real attribute failures and remaining depth/count limits still produce incomplete observations. The placeholder exception requires exact NoValue role, the supported search-field parent, typed zero size, successful empty children, no title/description/value/placeholder/help or actions, non-writable value/focus, and an unfocused state. Unknown, transient, nonempty or editable nodes are not suppressed. Read failures retry at most once; pure traversal limits do not. Current issued tokens remain usable, and successful bounded captures with unique identities retain their baseline. Native AX errors remain visible. See [Bounded CUA observations](cua-bounded-observations.md) for the updated capture and text-budget contract.

### Windows and screenshots

Sheet discovery uses bounded direct-child reads and identity deduplication, rather than another full tree walk. Only uniquely matched same-owner sheets extend an unresolved target. Top-level resize/menu/document activation and consent behavior remain unchanged.

Nonzero-layer discovery requires an explicit PID, a visible CG candidate and AX proof of `AXSheet`, `AXDialog`/`AXSystemDialog` or modal status. Inspect at most 64 roots with 100 ms messaging timeouts and a 500 ms deadline on a blocking worker. Worker failure is explicit; missing AX proof adds nothing and never authorizes input. Rebuild ordering from one final CG snapshot. No-PID discovery retains its layer-0 filter; undiscoverable or late dialogs can still lack action-result hints.

For attached groups, use a display filter containing only the selected window and crop to its validated bounds on one display. Revalidate owner, frame, group classification and on-screen status around capture. Explicit AX classification failure also selects this crop path; screenshots still require screen-recording permission. Do not crop a parent-only image or fall back to known incorrect group composition. Offscreen/cross-display groups can return screenshot unavailable.

Ordinary capture sets `includes_child_windows(false)` through the existing ScreenCaptureKit dependency/features, preserving permission checks, geometry, cache identity and failure behavior. Validate menus, popovers and legitimate child content before accepting this adjustment broadly; narrow or reject it if supported content disappears. Older-system behavior and all coordinate-input paths are not established by the current controls.

## Verification and remaining work

Implementation checks recorded on 2026-09-12: 70 REPL tests, 54 SDK tests (5 integration tests skipped), 6 Skill tests, MCP wire smoke, 357 macOS native tests and native release build passed. Full-repo build/typecheck were blocked by missing local `@node-rs/jieba` in unchanged `qwen-live`. Native verification required both `DEVELOPER_DIR` and `SDKROOT` to select the installed Command Line Tools; the earlier old-SDK compilation failure is retained in the report. Windows/Linux were not tested.

GUI controls verified live app changes, selection/replacement, LF/CRLF input, attached-panel observation/input, editable focus, nonzero-layer dialog lifetime and AX identity handling with actual postconditions. Case34 R5, case44 R2, case45 R1 and case50 R4 used frozen native `b47e0102`. Candidate `cbeefff9` separately corrected GIMP Welcome/main-window images; the subsequently rebuilt binary passed build/tests but was not GUI-tested. These evidence sets are not interchangeable.

Remaining work:

- Validate the newest capture adjustment with brightness dialogs, menus/popovers, attached panels and real coordinate input; then rerun the affected tasks.
- Quantify the normal one-second no-change action wait before changing it: observation also holds a focus-suppression lease. Sampling immediately does not remove this wait.
- Preserve and clarify state evidence when an AX error follows a real UI change. Sheet `setValue` refusals and color-text readback without actual color linkage remain separate unresolved issues.
- Continue matched task regressions using the original instruction, pristine inputs, setup/getter/scoring contracts and modified Skill. Record source/runtime/Skill hashes in isolated immutable runs; retain historical host/provider/CLI/scorer differences and workload differences as attribution limits. Similar baseline symptoms remain suspected environment issues unless an identical cause is established.

Detailed experiments remain in the local investigation records and Git history. The PR contains the [English verification report](https://github.com/QwenLM/qwen-code/pull/11683#issuecomment-5642894479), [Chinese verification report](https://github.com/QwenLM/qwen-code/pull/11683#issuecomment-5642915885) and task comparison comments. Mechanism controls and shorter recorded runs alone do not establish SDK-only speedup or complete tool-path coverage.
