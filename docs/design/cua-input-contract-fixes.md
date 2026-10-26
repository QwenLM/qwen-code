# CUA input and session corrections for 0.26.1

[English](cua-input-contract-fixes.md) | [简体中文](cua-input-contract-fixes.zh-CN.md)

## Status and scope

Prepare native driver, CUA SDK, Browser SDK and Node REPL 0.26.1 together, following the existing release contract. Browser behavior and the Qwen Code CLI version are outside this change.

The original 22-file input/session correction patch is the `0b2ec12bab99` patch used by the four running RecreationBench groups, rebased onto current main for release preparation. The release candidate additionally corrects macOS accessory-app discovery after an offline reproduction of the first R8 startup failures. Those experiments retain their original 0.26.0 package metadata and immutable archive; the additional fix does not upgrade or restart them. The user explicitly authorized the full runs before complete macOS case acceptance; results remain pending.

## Windows dispatch and cleanup

A UIA provider can remain inside an action while its modal is open. The clicked menu popup can disappear, and a new same-process dialog can have no owner. Waiting only for a dialog owned by the original popup misses this transition.

Capture the exact target HWND/PID and existing visible same-process windows. Only after native invocation starts, recognize a disappearing target or the supported disabled-target/new-modal transition as pending. Preserve strict ownership, capture and foreground authorization helpers. The direct/embedded click and secondary-action paths retain COM references, NoActivate, session dispatch and runtime drain guards until the original operation ends. Disappeared-target and ownerless-modal receipts stay unconfirmed and require observation; existing owned-surface evidence retains its classification. No input is replayed.

An unsupported UIA pattern can select another actuator before input. Other pattern-lookup failures refuse dispatch. An error after possible input must not trigger another actuator. Bound SDK session shutdown waits through typed `session_cleanup_pending`, retaining its handle until a final result and preserving final cleanup errors. Successful cleanup hooks keep their existing deduplication; failed hooks retain their existing semantics.

## Other Windows corrections

The foreground SendInput preflight recognizes the actual TokenUIAccess value. Posted-message and synthetic-pointer guards remain stricter; no process elevation or signed-worker installation is added.

An actual Edit child identifies the editable route in a ComboBoxEx whose inner combo reports a list-only style. Existing value/index readback and unknown-value refusal for lists without an Edit remain in place.

## macOS identity and input

Application inventory retains live Accessory-policy applications, including menu-bar apps launched outside standard installation directories. Previously those entries were omitted unless the same bundle path appeared in the installation scan, causing exact bundle-ID lookup to fail. Prohibited-policy background processes still require a matching installed bundle, and legacy Regular-only enumeration remains unchanged. Offline source reproduction verifies the discovery defect; historical R8 process activation policy and exact PID/path binding were not retained, so this does not claim complete causal closure or GUI acceptance for the failed guests.

When `PROC_PIDTBSDINFO` is unavailable, `KERN_PROC_PID` can supply the same microsecond process-birth identity. Reject invalid PIDs, incomplete data, PID mismatch and invalid timestamps, retaining subsequent lifetime checks. This historical failure does not establish the cause of every later input with no visible effect.

Keyboard, pointer, interactive input and cursor-event construction share a CombinedSessionState event source to avoid observed hardware-source construction hangs. Posting destinations, explicit modifiers, PID/window checks and successful focus-restoration policy remain unchanged.

Failed key-focus tap setup rolls back registration, count, tail and idle teardown without constructing a completed-action lease. It therefore does not run post-action restoration before any action occurred. Secondary actions accept exact case-preserved advertised aliases alongside existing raw/lowercase forms, retaining membership and ambiguity checks without an implicit AXPress or pixel fallback.

## Clipboard start handshake

Bound only a clipboard transaction's main-thread start to three seconds. The queued callback and timeout waiter share an optional closure under a mutex. Timeout can take and drop work that has not started, preventing a late clipboard write. Once the callback takes the work, wait for completion and retain mutation/clipboard leases through restoration. Ownership checks and restoration are not cancelled halfway.

This fails closed in a host without a servicing AppKit main queue. It does not install a different GUI host, change identities or replay paste.

## Model-facing documentation

The Node REPL initial description directs models to `cua.getState()` or the runtime documentation before desktop actions. App-option examples distinguish numeric IDs, key arrays and JavaScript timeout from app options. No compatibility API is invented.

## Verification and remaining acceptance

Public SimpleConvert, with one Qt6 translation-path API compatibility line and unchanged modal construction, reproduced a 30.341-second click wait on Windows. Corrected MCP click, SDK click and secondary invoke returned in 150/153/149 milliseconds. Independent AX/PNG observations confirmed the modal before one controlled close per run. SDK dispose actually succeeded after 25.681 seconds; no caught error was presented as success. These are scoped host results, not a latency guarantee or proof of every historical AP call's cause.

Native tests cover pending-window transitions, actuator selection, retained session/runtime lifetime, final cleanup failure, clipboard callback cancellation and birth identity. Version, build, typecheck and packaging checks accompany release preparation.

TextEdit input and saved-file readback passed within their tested macOS identity/target scope. JSONExport input parity remains unaccepted: company policy terminates the host's self-compiled app before input, and the AP typeText/no-change symptom remains unresolved. That policy does not establish the AP cause. Optional UIAccess-worker behavior, Linux GUI parity, full benchmark quality and the future published 0.26.1 installation are not marked passed.

Release acceptance requires the corresponding artifacts, normal signed distribution where required, checksum-verified installation and meaningful runtime effects. Builds, permissions, receipts and Running states do not replace those results. No permission, protection, account or model change is included.
