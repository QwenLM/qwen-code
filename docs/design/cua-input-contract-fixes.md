# CUA input and session corrections for 0.27.0

[English](cua-input-contract-fixes.md) | [简体中文](cua-input-contract-fixes.zh-CN.md)

## Status and scope

Prepare native driver, CUA SDK, Browser SDK and Node REPL 0.27.0 together under the existing release contract. These input-delivery, window-selection and lifecycle corrections join main's existing cursor/PiP features in the same release. This change preserves those features and does not change browser behavior or the Qwen Code CLI version.

Earlier real-host checks used private, immutable payloads with 0.26.0 compatibility metadata. Their evidence applies to the corresponding functional changes; it does not establish production signatures, installation of future 0.27.0 assets, or complete benchmark acceptance. No benchmark or monitoring operation is part of this release preparation.

## Windows dispatch and cleanup

A UIA provider can remain inside an action while its modal is open. The clicked menu popup can disappear, and a new same-process dialog can have no owner. Waiting only for a dialog owned by the original popup misses this transition.

Capture the exact target HWND/PID and existing visible same-process windows. Only after native invocation starts, recognize a disappearing target or the supported disabled-target/new-modal transition as pending. The direct/embedded click and secondary-action paths retain COM references, NoActivate, session dispatch and runtime drain guards until the original operation ends. Disappeared-target and ownerless-modal receipts stay unconfirmed and require observation. Existing owned-surface evidence retains its classification. Input is not replayed.

An unsupported UIA pattern can select another actuator before input. Other pattern-lookup failures refuse dispatch. An error after possible input must not trigger another actuator. Bound SDK session shutdown waits through typed `session_cleanup_pending`, retaining its handle until a final result and preserving final cleanup errors. Successful cleanup hooks retain their existing deduplication.

## Windows targeting and readback

When the app is in the background, start window selection at a candidate owner rather than an idle owned helper, then retain the existing validated `GetLastActivePopup` promotion. Exact foreground preference, same-PID/owner-chain checks, independent small windows and the single-minimized-window branch remain intact. Screenshot crop and coordinate conversion do not change. A small screenshot is not replaced with desktop pixels or accepted by lowering the caller's size threshold.

Legacy PostMessage text input reads back only an exact cached element. Without an element index, it no longer performs a system-focused UIA query that can block or identify an unrelated recipient. The receipt remains unverified and asks for a fresh observation before another input. A changed value alone does not prove the insertion point.

An actual Edit child identifies the editable route in a ComboBoxEx whose inner combo reports a list-only style. Existing value/index readback and unknown-value refusal for lists without an Edit remain in place. Foreground SendInput preflight recognizes the actual TokenUIAccess value; posted-message and synthetic-pointer guards remain stricter. No elevation or signed-worker installation is added.

## macOS identity and discovery

Application inventory retains live Accessory-policy applications outside standard installation directories, so exact bundle-ID lookup can find menu-bar apps. Prohibited-policy background processes still require a matching installed bundle, and legacy Regular-only enumeration remains unchanged. This discovery correction does not supply a window or establish GUI acceptance for windowless apps.

When `PROC_PIDTBSDINFO` is unavailable, `KERN_PROC_PID` can supply the same microsecond process-birth identity. Reject invalid PIDs, incomplete data, PID mismatch and invalid timestamps, retaining subsequent lifetime checks. Check Objective-C class-factory availability on the class, rather than asking whether its instances implement that factory.

## macOS keyboard and text delivery

Keyboard, pointer, interactive input and cursor-event construction share a CombinedSessionState event source. Posting destinations, explicit modifiers and logical PID/window checks remain in place. Failed key-focus tap setup rolls back registration, count, tail and idle teardown without constructing a completed-action lease or running post-action restoration.

For a focused Open/Save field implemented by an auxiliary AX host, resolve its actual keyboard recipient while preserving the logical application's window and ownership checks. A different recipient must be a live, finished Prohibited process proven by the same focused AX object, public owner, exact window and CG owner. A missing private symbol keeps the original recipient; a failed query or mismatched identity refuses before posting. Command shortcuts retain the application PID, and foreground/global routes remain unchanged. No timestamp-only or authentication-bypass diagnostic variant is included.

App text insertion uses supported `AXSelectedText` with the current UTF-16 selection and expected-value readback for literal text. Terminal targets and ASCII control characters retain their guarded key-event routes; unsupported targets continue to fail closed. AX-only readback is not treated as renderer/DOM confirmation for web content. Secondary actions accept exact case-preserved advertised aliases alongside the existing raw/lowercase forms, retaining membership and ambiguity checks without an implicit AXPress or pixel fallback.

## Clipboard start handshake

Bound only a clipboard transaction's main-thread start to three seconds. The queued callback and timeout waiter share an optional closure under a mutex. Timeout can take and drop work that has not started, preventing a late clipboard write. Once the callback takes the work, wait for completion and retain mutation/clipboard leases through restoration. Ownership checks and restoration are not cancelled halfway.

This fails closed in a host without a servicing AppKit main queue. It does not install a different GUI host, change identities or replay paste.

## Public errors and documentation

A keyboard refusal must recommend supported element/browser actions or explicit desktop observation and focus. It must not recommend `delivery_mode` as a public App option: that option is not in the public schema. An explicit `effect: refused` defaults to `sent: false` when dispatch evidence is absent. An explicit `sent` boolean remains authoritative; unknown mutating failures remain conservative. No new delivery option or automatic retry is added.

Node REPL's initial description directs models to `cua.getState()` or runtime documentation before desktop actions. Examples distinguish numeric IDs, key arrays and JavaScript timeout from app options.

## Verification and remaining acceptance

- **Windows modal/cleanup:** A public Qt fixture reproduced a 30.341-second click wait. Corrected direct MCP click, SDK click and secondary invoke returned in 150/153/149 ms with independent AX/PNG modal observations. SDK dispose waited through pending cleanup and succeeded after 25.681 seconds. These are scoped host checks; optional UIAccess-worker behavior is separate.
- **Windows window selection:** A real idle owned helper changed a normal 624×391/14,212-byte PNG into a 2×2/86-byte PNG before the fix. Corrected direct MCP and actual Medium Node REPL/SDK returned the original main-window PNG. The kernel's loaded candidate DLL/NAPI hashes were checked. Background active-popup capture and single-minimized target selection also passed. A minimized screenshot and the foreground selection branch were not accepted by that run. Historical FX's 73-byte image and frozen executable identity are missing, so the original case is not accepted.
- **macOS editing:** Six earlier one-shot character/deletion, semantic text, Command-selection and Escape checks passed on an owned TextEdit sheet, with independent exact value/range, own-window pixels and process cleanup. Review of the previous PR head on macOS 26.6.2 found Save-sheet keyboard recipient routing unreachable. The merged main changes window-identity ancestry resolution, but this combined Save-sheet path has not been retested; its acceptance remains open. This does not establish macOS 14/x64/Electron, standalone CLI, JSONExport or full benchmark parity.
- **Public refusal contract:** Two new Rust tests fail before the fix and pass after it; the actual public facade/schema test changes from 2 pass/1 fail to 3 pass/0 fail. The core library passes 652 tests serially. Contract checks do not prove native GUI input effects.

Native tests also cover lifecycle retention, final cleanup failure, clipboard callback cancellation, process identity and the window-selection policy. Build, typecheck, version and package checks accompany PR preparation. A parallel core run stalled in existing registry tests; its result is not counted as passing.

Known limits remain explicit: Windows App.paste is unimplemented; a SAFER-derived Medium host retains TokenElevation and can be refused by the existing app-launch token policy; some Windows UIA effects are unconfirmed; Mac TimeToLeave's synchronous readback failure versus later matching text is unresolved. Company policy terminating a self-built Mac app does not establish the AP input cause. Model image-context limits are outside the tool corrections.

Release acceptance still requires every architecture's artifacts, normal signing/notarization where applicable, checksum-verified installation and final consumer checks. Builds, permissions, acknowledgements and benchmark control-plane status do not replace runtime effects or quality results. No permission, protection, account or model change is included.
