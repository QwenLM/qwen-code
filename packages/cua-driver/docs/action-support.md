# Desktop action support

This ledger records the canonical Rust harness contracts for Windows, macOS,
and Linux. It is derived from typed `CaseSpec` rows and accepted E2E evidence,
not from a successful driver response alone.

- **Delivered** means a fixture-owned state change was observed.
- **Refused** means the exact structured refusal code and all required desktop
  side-effect oracles passed.
- **Gap** means unsupported or not yet proven. A missing row is never evidence
  that an action is impossible.

AX and PX describe how the target is selected. They do not require the same
delivery backend: a PX target may be hit-tested and delivered through AX/UIA
when that is the background-safe route.

## Accepted baselines

| Environment | Exact source | Accepted evidence |
| --- | --- | --- |
| Windows/Win32 | `64e82449` | Run `29257963004`: 122/122 rows, 99 delivered and 23 exact refusals |
| macOS/Quartz | `0b9b5d94` and `64e82449` | Logged-in local matrix: 138 deliveries and 6 exact refusals passed; one cursor-interrupted row passed alone on the final head, for effective 145/145 coverage |
| Linux/X11 | `268a6ab1` | Run `29254936043`: 116/116 rows, 75 delivered and 41 exact refusals |

## Shared web harnesses

Foreground rows listed here are delivered for both AX and PX.

| OS | Harness | Background delivered | Background refused |
| --- | --- | --- | --- |
| Windows | Electron | left click and child window AX/PX | right click and double click AX/PX, plus drag PX: `background_occluded`; type text, press key, hotkey, and scroll AX/PX plus editor save AX: `background_unavailable`; `start_minimized` launch: `background_unavailable` when Windows denies the foreground lock, with no process spawned |
| Windows | Tauri | left/right/double click AX/PX, type text AX/PX, press key AX/PX, child window AX/PX, scroll AX, editor save AX | hotkey AX/PX and scroll PX: `background_unavailable`; drag PX: `background_occluded` |
| macOS | Electron | left/right/double click AX/PX, type text AX/PX, press key AX/PX, hotkey AX/PX, child window AX/PX, editor save AX | scroll AX/PX and drag PX: `background_unavailable` |
| macOS | Tauri | left/right/double click AX/PX, type text AX/PX, press key AX/PX, hotkey AX/PX, scroll AX/PX, child window AX/PX, editor save AX | drag PX: `background_unavailable` |
| macOS | WKWebView | left/right/double click AX/PX, type text AX/PX, press key AX/PX, hotkey AX/PX, scroll AX/PX, child window AX/PX, editor save AX | drag PX: `background_unavailable` |
| Linux X11 | Electron | Background AX left click and child-window actions deliver with strict focus, z-order, cursor, and input-leak oracles | Background PX left click, AX/PX right and double click, PX child window and drag, AX/PX keyboard and scroll, and AX editor save return exact `background_unavailable` |
| Linux X11 | Tauri | Background AX/PX left click and child-window actions deliver with strict focus, z-order, cursor, and input-leak oracles | Other background pointer, keyboard, scroll, drag, and editor-save shapes return exact `background_unavailable` |

All shared background rows require fixture state, focus, z-order, and
no-leaked-input evidence. Windows, macOS, and X11 also require cursor
preservation.
Foreground rows require fixture state and retain a video plus before/after turn
evidence.

## Native Windows

| Harness | Proven contracts | Refusals and gaps |
| --- | --- | --- |
| WPF | Native AX controls; background combo selection, left click, and value changes; PX background left click through UIA hit-testing; foreground pointer gestures | Background F5 and PX drag are `background_unavailable`. Additional PX gesture rows remain unproven. |
| WinUI3 | Current UIA control, value, selection, popup, and slider rows | Background right/double-click refusal behavior and broader PX coverage remain unproven. |
| WebView2 | CDP page operations; native PX background left click through UIA hit-testing | Native keyboard and broader pointer cells remain unproven outside the shared Tauri/Electron hosts. |

`background_uipi_blocked` is a production refusal code with no canonical
elevated fixture today. It must not be counted as covered until a controlled
integrity-level harness can exercise it.

## Native macOS

| Harness | Proven contracts | Refusals and gaps |
| --- | --- | --- |
| AppKit | AX tree/capture; AX background left click, set value, and type text; PX background left/right/double click; PX foreground right/double click and slider drag; AX foreground/background scroll; desktop PX foreground left click | PX background slider drag returns exact `background_unavailable`. Native press key, hotkey, AX-addressed right/double click, and broader control combinations remain unproven. |
| SwiftUI | AX tree/capture; AX background left click and set value; foreground popover-trigger activation | The fixture proves `popover_open=true`, but the transient panel remains absent from targeted AX enumeration. Other native pointer and keyboard combinations remain unproven. |
| WKWebView | Full 40-cell shared-web catalog through the dedicated repo-local native host | PX background drag returns exact `background_unavailable`; the other 39 shared cells deliver. Native host-specific controls are outside this fixture. |

## Native Linux

Linux supports X11, including X11 applications under XWayland. Native Wayland
backends and their validation lanes have been removed. The exact-source runs
below are historical baselines; acceptance of the upgrade requires new evidence.

| Environment | Proven contracts | Refusals and gaps |
| --- | --- | --- |
| X11/Openbox | Exact run `29254936043` passed all 116 declared outcomes: 75 deliveries and 41 exact refusals. GTK3 AT-SPI actions and values, foreground XTest pointer/keyboard routes, capture, desktop scope, and the complete Electron/Tauri catalog all reached fixture-owned oracles. | Xvfb does not prove the real-Xorg MPX/uinput background pointer route. Toolkits that reject XSendEvent retain exact refusals. |

PX background left-click rows may resolve the screen point to an actionable
AT-SPI node. Such a pass proves the public PX-addressed behavior and its desktop
side effects, but it does not prove raw pixel delivery to canvases or games.

## Maintenance rule

Update this document only when a typed row is added, removed, or changes
contract and an empirical run supports the change. Keep unsupported delivery
as an exact refusal where the driver can determine it before dispatch. When an
OS API reports success but offers no effect read-back, retain a visible gap
rather than inventing a fixture-specific refusal in production code.
