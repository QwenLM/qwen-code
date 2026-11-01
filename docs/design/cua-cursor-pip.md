# Default CU cursor and live window preview

[English](cua-cursor-pip.md) | [简体中文](cua-cursor-pip.zh-CN.md)

Status: implementation design, 2026-10-26. Base: origin/main 40f73909a9. This feature does not include the separate 0.26.1 regression/release candidate.

## Problem and current behavior

The normal MCP service initializes the native agent cursor, but the same-process SDK disables it. macOS cursor initialization currently blocks in NSApplication.run, which a Node host cannot call. The optional PiP displays one post-action PNG, lacks session/window geometry, and its event loop bypasses cursor startup. A screenshot crosshair is not an on-desktop agent cursor.

## Intended behavior and scope

Enable the native cursor by default on both normal MCP and Node REPL plus SDK paths, retaining explicit disabling. On macOS, show a live, nonactivating PiP for at most two recently observed authorized windows, ordered by recent use. The PiP displays the session cursor in the matching window and updates while the agent performs no actions. Windows and X11 keep native cursor support; their existing PiP backend remains explicitly unsupported in this feature.

The preview is local and read-only. It does not forward clicks to target apps, add a process, use an MP4 intermediary, send frames over the network, change permissions, or replace the desktop framework. Modal or sibling windows require their own successful authorized observation; same PID alone never authorizes adding a window.

## Design

Separate nonblocking macOS cursor initialization from the daemon's blocking event loop. A main-thread host initializes AppKit and both UI surfaces once. Standalone hosts service the Core Foundation run loop and explicitly dispatch AppKit events instead of calling NSApplication.run, which reactivates the process after launch completion. Each turn waits at most 100 ms and limits the event drain between callbacks; native drag tracking may run until mouse-up. The loop remains alive through owner cleanup until the protocol thread exits the process. Node keeps a reference-counted, unreferenced timer while native runtime handles are active; each bounded pump services main-queue callbacks and AppKit events. Worker-thread construction cannot claim a main-thread facility. Closing a runtime waits for native operations and cleanup, then releases its pump lease. Global UI infrastructure survives runtime recreation; session contents do not. The Node package root declares its UI host only during construction and restores the previous thread-local value; raw Rust/Python embedding remains UI-disabled by default on macOS. Native-only capture has a deadline and retains its owner lease until the underlying callback actually finishes. Cleanup failures propagate through shutdown and retain the pump lease.

Replace synchronous post-action screenshot pushes with an internal preview-target notification after a successful window observation. The target carries a runtime-private session, exact window ID/PID, and a liveness predicate bound to its authorization context. Sampling does not refresh authorization idle deadlines, change AX snapshot revisions, or guess the foreground/main window. Capture checks current ownership and geometry, permissions, authorization/session lifetime, and capture scope. Missing or changed targets fail closed, with no display fallback.

The macOS controller samples only visible, live previews at approximately 3 fps. It keeps bounded/latest-only work and discards stale generation callbacks. Each capture validates source bounds, pixel dimensions, identity and availability. Preserve aspect ratio and transform the authoritative session cursor through the same source-to-preview geometry. Recent windows are separate presentations; do not infer native ownership algorithms from Codex symbols.

Explicit observations and continuous previews each have one bounded native capture worker, so a sample cannot consume the observation worker. Both retain the existing capture deadlines, exact-window scope and cleanup receipts, including when an Apple callback has not returned.

One process owns AppKit infrastructure. Preview data and cleanup are runtime/session scoped. Each session's preview is separate, so another owner cannot replace its content. Close hides and stops sampling that preview; session end, revocation, runtime shutdown and reset clear only the owning data. UI controls use a nonactivating panel: explicit drag and close regions, passive image content, no target input forwarding. Labels contain app names, never typed input or raw arguments.

## Native floating-card presentation

The panel joins all Spaces with stationary, cycle-excluded behavior and uses only AppKit's FullScreenAuxiliary full-screen role. It never requests FullScreenPrimary or FullScreenNone. It may appear in desktop sharing or recording; automatic sharing detection is outside this feature. Closing stops the current preview, but later authorized observations may recreate it. A persistent sharing opt-out uses the existing disable flag or configuration and restarts the owning host.

The preview is one independent, borderless, nonactivating NSPanel per private session. Its background is visually transparent and it has no permanent title bar. A near-clear native background keeps the gaps in the local input surface: macOS otherwise passes clicks through zero-alpha window pixels. The default location is the lower-right of the screen work area; the user can drag the cards or the explicit Move preview handle to reposition the whole window. Existing explicit geometry still selects the starting position and a maximum card size. Position is retained for that live panel, including subsequent frames and card-order changes. Snapping, inertia, position persistence and attaching to a particular client window are outside this change.

Each authorized source keeps its own native card view, exact window identity, image and aspect ratio. A shared width is chosen to fit all cards within the configured maximum card width/height and the available screen area. The front card occupies the lower-right slot; the second card is offset toward the upper-left. The native panel reserves a stable transparent envelope for both slots, so switching cards does not move the user's chosen window position. The default maximum card size is 400×300 points. Images are prepared separately; the sampler no longer flattens the two cards into one PNG.

Pointer movement onto a rear card's exposed region brings it to the front with a short, critically damped position transition. Retargeting starts from current positions and velocities. Hover selection changes only native presentation, never the authorized target set, generation or idle lifetime. Recurring image updates preserve the user's selected front card unless the observed source order changes. Pointer entry/exit fades the floating close and Move preview controls; the close button remains accessible to AX even while visually hidden. The move handle is explicitly a drag affordance: the unidentified second icon in the reference is not assumed to forward input or activate a source application. Card contents also drag the local panel and never interact with source apps. Transparent gaps remain part of this local floating surface; no new click-through or global input monitor is introduced.

Hover uses the destination rectangles and promotes once per entry into the rear slot. Small pointer movements while cards exchange places cannot promote the newly exposed card again. Moving over the front destination or leaving the cards rearms the next promotion; deliberate reversals still continue from the current motion.

Use the existing AppKit/main-thread pump and native views. A native animation timer runs only while position or control-opacity values are changing and is invalidated on close; reduced-motion settings skip positional motion. Main-thread handle ownership survives nested native dragging, and registry/state borrows end before AppKit calls that can reenter callbacks. Owner shutdown still closes the panel synchronously before the existing main-queue flush receipt. Native acceptance must cover unequal source ratios, transparent gaps over an owned backdrop, hidden/visible controls, rapid hover reversals, drag followed by live refresh/reordering, AX close while controls are hidden, background input invariants and owner/reset cleanup.

## Change coverage

| Layer                            | Required consumers                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- |
| cursor/AppKit host               | daemon service, direct main-thread host, same-process SDK and Node event pump     |
| internal preview target/liveness | validated observation dispatch, macOS sampler, session/runtime cleanup            |
| PiP scene/layout                 | shared preview types, macOS native backend, cursor state mapping                  |
| defaults and packaging           | SDK runtime, CLI/config, aligned CUA version references and changelog             |
| verification                     | focused Rust/Node tests, real default MCP and SDK paths, E2E plan, bilingual docs |

No new daemon HTTP route is planned. A later remote preview must be live-session-owner scoped and preserve runtime trust/failure semantics; the content-free activity observer is not a frame channel.

## Validation and acceptance

Regression acceptance includes a Keynote save sheet whose controls report an internal native window distinct from their enclosing AXSheet. Fresh element actions must resolve the nearest AX window/sheet ancestor, preserve exact owner checks, and save only a new test document. Large desktop screenshots must fit the Node REPL's 4 MiB image limit without changing screenshot dimensions or desktop coordinate mapping; oversized PNGs use JPEG encoding before delivery.

Modal panel shortcuts use the existing exact-window keyboard gate rather than the disabled application menu. Normal background menu shortcuts retain their character/modifier match when resolving a menu item again, so alternate items with identical labels cannot make the requested command ambiguous or select a different command.

First dry-run the global qwen CLI and record exact installed artifacts, with a test-engineer agent. Then build the local Rust/SDK/CLI artifacts and run focused unit checks, build, typecheck and bundle in order. Real acceptance requires independent desktop recording, application event/AX/file readback, and system pointer/focus readback. Verify default first action, drag, idle fade, two windows, no-action live updates, cursor scaling, PiP controls and independent owner cleanup. Repeated create/close must not leave stale windows, samplers or Node timers.

Use an isolated desktop and runtime. Do not touch the original session's AP/R8 experiments or shared services. Revalidate inventory/host identity before remote access; never bypass company policy, TCC or signing restrictions. A blocked platform is reported as unverified, not passed. Complete two clean diff audits and independent Codex review before the specifically authorized feature PR; no merge or release is authorized. Native acceptance must also verify that the preview remains auxiliary over a full-screen source without activating the host or entering full-screen itself.

## Risks and remaining decisions

The main risks are AppKit/Node event coexistence, late callbacks during shutdown, source/cursor geometry and continuous-capture authorization. Prefer the same-process host and do not silently substitute a worker. A product-wide PiP streaming protocol, native Wayland and Windows/Linux PiP are follow-up scope, not claimed here. Exact capture performance and permissions are acceptance results, not assumptions.
