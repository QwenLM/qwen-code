# Default CU cursor and live window preview

[English](cua-cursor-pip.md) | [简体中文](cua-cursor-pip.zh-CN.md)

Status: implementation design, 2026-10-26. Base: origin/main 40f73909a9. This feature does not include the separate 0.26.1 regression/release candidate.

## Problem and current behavior

The normal MCP service initializes the native agent cursor, but the same-process SDK disables it. macOS cursor initialization currently blocks in NSApplication.run, which a Node host cannot call. The optional PiP displays one post-action PNG, lacks session/window geometry, and its event loop bypasses cursor startup. A screenshot crosshair is not an on-desktop agent cursor.

## Intended behavior and scope

Enable the native cursor by default on both normal MCP and Node REPL plus SDK paths, retaining explicit disabling. On macOS, show a live, nonactivating PiP for at most two recently observed authorized windows, ordered by recent use. The PiP displays the session cursor in the matching window and updates while the agent performs no actions. Windows and X11 keep native cursor support; their existing PiP backend remains explicitly unsupported in this feature.

The preview is local and read-only. It does not forward clicks to target apps, add a process, use an MP4 intermediary, send frames over the network, change permissions, or replace the desktop framework. Modal or sibling windows require their own successful authorized observation; same PID alone never authorizes adding a window.

## Design

Separate nonblocking macOS cursor initialization from the daemon's blocking event loop. A main-thread host initializes AppKit and both UI surfaces once. Node keeps a reference-counted, unreferenced timer while native runtime handles are active; each bounded pump services main-queue callbacks and AppKit events. Worker-thread construction cannot claim a main-thread facility. Closing a runtime waits for native operations and cleanup, then releases its pump lease. Global UI infrastructure survives runtime recreation; session contents do not. The Node package root declares its UI host only during construction and restores the previous thread-local value; raw Rust/Python embedding remains UI-disabled by default on macOS. Native-only capture has a deadline and retains its owner lease until the underlying callback actually finishes. Cleanup failures propagate through shutdown and retain the pump lease.

Replace synchronous post-action screenshot pushes with an internal preview-target notification after a successful window observation. The target carries a runtime-private session, exact window ID/PID, and a liveness predicate bound to its authorization context. Sampling does not refresh authorization idle deadlines, change AX snapshot revisions, or guess the foreground/main window. Capture checks current ownership and geometry, permissions, authorization/session lifetime, and capture scope. Missing or changed targets fail closed, with no display fallback.

The macOS controller samples only visible, live previews at approximately 3 fps. It keeps bounded/latest-only work and discards stale generation callbacks. Each capture validates source bounds, pixel dimensions, identity and availability. Preserve aspect ratio and transform the authoritative session cursor through the same source-to-preview geometry. Recent windows are separate presentations; do not infer native ownership algorithms from Codex symbols.

One process owns AppKit infrastructure. Preview data and cleanup are runtime/session scoped. Each session's preview is separate, so another owner cannot replace its content. Close hides and stops sampling that preview; session end, revocation, runtime shutdown and reset clear only the owning data. UI controls use a nonactivating panel: explicit drag and close regions, passive image content, no target input forwarding. Labels contain app names, never typed input or raw arguments.

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

First dry-run the global qwen CLI and record exact installed artifacts, with a test-engineer agent. Then build the local Rust/SDK/CLI artifacts and run focused unit checks, build, typecheck and bundle in order. Real acceptance requires independent desktop recording, application event/AX/file readback, and system pointer/focus readback. Verify default first action, drag, idle fade, two windows, no-action live updates, cursor scaling, PiP controls and independent owner cleanup. Repeated create/close must not leave stale windows, samplers or Node timers.

Use an isolated desktop and runtime. Do not touch the original session's AP/R8 experiments or shared services. Revalidate inventory/host identity before remote access; never bypass company policy, TCC or signing restrictions. A blocked platform is reported as unverified, not passed. Complete two clean diff audits and independent Codex review before the specifically authorized feature PR; no merge or release is authorized.

## Risks and remaining decisions

The main risks are AppKit/Node event coexistence, late callbacks during shutdown, source/cursor geometry and continuous-capture authorization. Prefer the same-process host and do not silently substitute a worker. A product-wide PiP streaming protocol, native Wayland and Windows/Linux PiP are follow-up scope, not claimed here. Exact capture performance and permissions are acceptance results, not assumptions.
