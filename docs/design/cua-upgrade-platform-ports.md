# Computer Use platform ports (2026-10)

This is the implementation ledger for the approved [upgrade design](./cua-upgrade-2026-10.md). Code adapted from trycua/cua through `cua-driver-rs-v0.35.4` is MIT licensed, Copyright (c) 2025 Cua AI. Only the native driver library is a port source. The upstream bench package and its license are not included.

## Dispatch contract

App input resolves an exact application/window inside the driver. macOS uses accessibility and process-directed events; there is no automatic global foreground fallback. Windows and Linux may try the foreground rung once, exclusively after a native `background_unavailable` error with `sent:false`. An actuator error after a possible dispatch never replays input. Explicit desktop input is a separate foreground surface.

Foreground transactions observe physical input without consuming it. They stop remaining input on detection, preserve an external foreground C, and restore prior A only while the transaction still owns B. Windows drains the target input queue before restoring; text checks the target between UTF-16 units. Linux confirms both EWMH activation and core input focus before XTest.

Success acknowledges dispatch, not application effects. Input calls do not wait for screenshot changes. The next observation supplies effect evidence. A held press and a multi-click gesture retain only the timing required to deliver the gesture.

## macOS

| Upstream reference | Adaptation |
| --- | --- |
| #4943 | Do not send A a synthetic deactivation notice when directing focus to B. |
| #4943, #4955, #5091, #5129 | Key-focus protection shares the existing per-process `app_focus` observer; bounded tail/order correction and intentional-focus epochs prevent competing observers. |
| #4976 | Physical mouse/modifier activity grants the user's switch priority. The existing activation guard checks the same physical-input state. |
| #5051 | Directed mouse events explicitly set modifier flags, including the empty set. |
| #5057 | Existing-file saves and Finder item renames use bounded Apple Events and readback. Arguments are passed as script arguments, not concatenated into AppleScript. Automation consent follows normal macOS TCC. |
| Popup selection | Open a popup, select a unique matching option through AX, close a menu opened by this call on refusal. Safari's existing DOM fallback remains restricted to the actual foreground document. |
| Text insertion | ASCII uses directed events. Non-ASCII requires a focused editable element and AX selected-text support; expected insertion is read back. No keyboard replay after an uncertain AX write. |
| Document model | A verified AX write to a document-backed AppKit field registers an edit through a directed, net-zero editing shim; refusal is reported if registration cannot be verified. |

Background drag refuses before dispatch. Sliders use `setValue`. Paste keeps the clipboard restoration transaction. The old fixed one-second post-action wait is removed. Neither AX acknowledgement nor event delivery alone is reported as a confirmed effect.

## Windows

| Upstream reference | Adaptation |
| --- | --- |
| #4500 | Attach to the actual target input queue and use a sentinel read to bound queue draining before restoration. |
| #4901 | Check foreground ownership and physical input between UTF-16 units; stop after a stalled unit without replay. |
| #3671 | A timed-out UIA point action is distinct from a preflight absence of a suitable pattern, so an uncertain action cannot become a second coordinate click. |
| #4774 | Native combo selection uses the control's selection and notification messages and verifies the selected value. |
| Tk | Refuse the unsupported background pointer rung before input; the shared App dispatcher may then use foreground once. |
| Extended keys | Left/right Windows keys carry the extended-key flag. |
| Worker IPC | Bound worker response reading; a timeout says input may have been sent. UIAccess routing is explicitly opt-in. |
| Standard-user launch | The elevated daemon derives and verifies a Medium token from its own token with administrator membership deny-only. No other process token is opened or borrowed. Direct executable and shell-helper launches use that token; failures refuse rather than launching elevated. |

The normal installer/UAC flow is retained. Cross-compilation is build evidence only; it does not prove a normal interactive Windows desktop, UAC behavior, token facts at runtime, or shared-desktop interference.

## Linux

Native Wayland support, helpers, dependencies and installer payloads are removed. X11 and XWayland X11 applications share the same X11 implementation. A compositor-native Wayland surface is unsupported.

| Upstream reference | Adaptation / existing equivalent |
| --- | --- |
| #3882 | MPX pointer/keyboard dispatch, toolkit-aware refusal, occlusion and focus guards, no input shields. Existing fork exact-window checks remain. |
| #3761 | Flush/check key press before hold timing; unconditional final server round-trip before closing a short-lived connection. Temporary keymaps remain live through delivery. |
| #3762 | Check pointer presses/releases, keep gesture timing, release a queued button/modifiers after an error. |
| #3864 | Preserve the fork's exact observed bus/object click identities and per-window snapshot validation. Session-owned MPX device persistence comes from the MPX umbrella rather than this identity patch. |
| #3618 | Modified foreground drag brackets the gesture with real modifier transitions and cleanup. Unsupported modified background drag refuses before dispatch. |
| #4248 | The new App contract has no post-action effect classifier: closing B's dialog cannot be mislabeled a no-op because the WM parks focus. Existing exact-target foreground restoration preserves C and does not infer confirmation from unattributed popups. The upstream screenshot/window-change wait is intentionally not copied. |
| #4188 | Exclude application/frame/window shells from coordinate AX activation; recognize both NUL-separated and space-joined Chromium helper command lines. |
| #5139, #5158 | Unicode keysyms and full-character preflight; reserve/remap spare keycodes before the first event; serialize temporary keymap changes. No silently skipped characters. |
| #3601 | Master ownership includes boot, PID namespace, UID and process start identity. Reap only stale devices proven to belong to this driver family. |
| #2888 | Conservatively refuse MPX on KDE where device hotplug may reconfigure physical input. No automatic permission changes to `/dev/uinput`. |
| #5070 | Background keyboard refusal names a missing AT-SPI bus and its normal setup path; the diagnostic bus probe is bounded. |
| #4903 | Remove AT-SPI P2P feature/peer calls; use one registered accessibility connection. |
| #4984 | Rebase tree bounds only against a valid complete screen frame; reject incomplete/zero-size frame geometry. |
| #5074 | Wake an AT-SPI application with attributes before its first child walk. |
| #4375 | First semantic walk budget is two seconds; later walks one second. No generic full-tree retry for an incomplete observation. |
| GTK combo | `Selection.SelectChild` picks a unique option and its selected-child name is read back. No focus/foreground change for selection. |
| #4292 | Preserve text content separately from labels; prefer numeric Value for numeric controls and do not read password Text. |
| #3758 | Decode DirectColor screenshots with the X colormap rather than treating them as TrueColor masks. |
| #4281 | A successful kill waits for actual process exit; zombies count as exited. |
| #3814 | A delivered exact-window frame explicitly reports `screenshot_frame_valid:true`. |
| #4529 | Prepare overlays unmapped with empty input/bounding shapes; map only while painting visible content and unmap idle frames. |
| #4715 | Non-Linux stub registry no longer advertises the removed screenshot tool; portable menu schemas do not pass through cursor-only schema assertions. |
| #3658 | Enter/Return/KP/Numpad aliases share the terminal key gate and key mapping. |
| #3778 | Existing opt-in native browser tools share the session cursor registry; inactive tabs do not move the visible cursor. This does not add upstream browser tools to the default surface or change the repository Browser SDK. |

Fork repairs also preserve per-window screenshot scaling, do not scale an omitted mouse-up position twice, restrict Qt synthetic FocusIn to Qt5, condition FocusOut on actual core focus ownership, and classify Chromium only when a route needs the information.

## Validation boundaries

See the ignored `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/` reports for immutable source manifests, build logs, protocol calls and fixture readback. Linux Xvfb/Openbox verifies the foreground fallback and AT-SPI paths, not a real Xorg/uinput MPX device or a physical shared desktop. Windows GNU checks verify cross-platform types, not interactive behavior. macOS builds and directed-event fixture tests are separate evidence. Model task success, token counts and timing parity require the second-layer benchmark and are never inferred from these tests.
