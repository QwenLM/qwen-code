# Linux input delivery without model-selected modes

[English](linux-input-delivery.md) | [简体中文](linux-input-delivery.zh-CN.md)

The Linux Computer Use workflow keeps explicit process/window targeting and
current element tokens. The model should choose the target and action; the
runtime should choose a semantic operation or guarded native input.

## Scope

Based on main after PR #11829 merged at
`ba0ddcd0b7d077a66d803898706210ae8b02d910`:

1. Default Linux Computer Use actions permit native focus preparation. Preserve
   explicit delivery overrides for existing programmatic callers and Windows.
2. Recover a failed focus preparation only before dispatching input. Never retry
   an action after its callback has started, including errors or uncertain results.
3. Propagate the selected desktop's environment in the benchmark launcher.
4. Explain the existing 10-second Node REPL yield default and verify screenshot
   forwarding with the current skill.

App handles on Linux, audio support and shell policy are excluded. The follow-up
PR includes the driver/SDK 0.20.8 and Node REPL 0.1.5 release metadata, installers,
consumer pins and complete-package verification. Creating the PR does not run
the production release.

The complete Linux workflow lives in the fixed `computer-use/SKILL.md` entrypoint.
OSWorld extracts that single npm package member and injects it into the user
message; Linux instructions must not depend on reading another skill resource.

## Ownership and authorization

The JavaScript facade selects the default using the connected driver's platform,
not the Node host OS. It passes the existing foreground permission ceiling to the
native call, so the native authorization layer sees the possible focus change.
Do not change the native interpretation of a missing delivery field: bounded
manifests currently interpret it as background-only.

Native Linux keeps its existing semantic and target-addressed routes. Where a
route needs global X11 input, it prepares and verifies the exact window first.
The existing process-wide desktop action coordinator serializes physical input.
There are no new runtime processes, executables, dependencies, permissions or
protocols.

Explicit calls to getPlatform refresh the platform choice. A replaced native
session invalidates any cached platform used for defaults. Default discovery is
internal and does not add a model tool round or another desktop observation.

## Recovery boundary

The focus-preparation callback is separate from the input callback. Only the
former may run again, within a finite deadline and attempt bound. Success,
partial delivery, timeout after dispatch and an input callback error all end the
operation without replay. When focus must be temporarily moved into the target,
restore the previous active window and core focus afterwards. When the target
already holds focus, retain widget or dialog focus changes made by the action;
restoring the old child focus would undo clicks and keyboard navigation.
When restoring another window, wait for its activation and focus transition
before restoring its exact child focus. This confirmation has the same bounded
timeout as preparation; if the window manager refuses restoration, the existing
best-effort core-focus restoration still runs. No input callback is replayed.

The historical active=0 failure needs an X11 reproduction before weakening or
changing the active-window guard. An absent EWMH window manager and a delayed or
refused activation by an existing window manager are different cases.

## Launcher boundary

The benchmark launcher must use the actual selected GUI session's DISPLAY,
XAUTHORITY, DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR (and Wayland display when
applicable). Do not guess :0 or copy an unrelated session's environment. Carry
these through the MCP process and its Node kernel. Missing display selection
fails before MCP configuration is rewritten. The launcher does not probe GUI
availability: an inaccessible display or bus still fails during driver use.
The driver discovery error alone does not repair stripped launcher environment.

The actual launcher changes live in OSWorld-V2, based on
`f4d1d85929c81c1e345a3c8404bde22fec6798f3`. Both Codex and Claude setup paths
copy only the selected desktop variables into the node-repl MCP configuration;
explicit MCP environment values take precedence. The service's user-specific
D-Bus session address is also supplied by its existing systemd setup.

## Validation

Use a fake typed driver to prove platform-aware defaults, explicit override
compatibility, cancellation and no mutation replay. Use a Linux X11 fixture to
observe real focused target and input count, with delayed activation, refused
activation and callback errors. Verify existing sparse token/truncation fixes on
that native build. Compare launcher parent/MCP/kernel values without printing
secrets. Exercise immediate and delayed MCP images as image blocks and a cell
longer than one second with the default yield.

Report native tests separately from protocol tests. No aggregate score or token
improvement is claimed until the same benchmark cases are rerun.
