# cua-driver MCP reliability hardening

## Problem

The MCP proxy waits up to 120 seconds for a daemon response. Several macOS tool
paths can block longer than that in synchronous OS calls. The proxy then emits a
generic JSON-RPC `-32603`, while the abandoned operation and child process keep
running. Separately, capture scope is read from both memory and disk, so one MCP
session can observe contradictory values after `set_config` reports success.

## Design

### One effective configuration per session

Treat `capture_scope` like the existing session-scoped image-size override.
MCP calls resolve it from the caller's `_session_id`; anonymous CLI calls use the
global persisted default. `set_config`, `get_config`, and `get_desktop_state`
must all resolve through the same `ToolState`. Anonymous persistence happens
before the in-memory value is committed, and a write failure is returned to the
caller.

### Remove subprocesses from app enumeration

Use `NSWorkspace.runningApplications` for live apps and Core Foundation bundle
metadata for installed apps. This removes `osascript` and `plutil` from the
`list_apps`, `get_accessibility_tree`, and `launch_app` discovery paths rather
than attempting to guess a safe timeout for each installed bundle.

### Bound and terminate screenshot capture

Keep the existing `screencapture` backend, but spawn it through one bounded
helper. On deadline, kill and reap the process before returning a tool error.
Use a unique temporary pathname per capture and an RAII cleanup guard so
concurrent calls cannot collide and failures do not leave files behind.

### Bound AX and daemon work below the proxy deadline

Set the native AX messaging timeout before tree walks and element actions. Add a
daemon-side tool deadline shorter than the proxy's 120-second transport deadline
as a final backstop. Internal bounds should normally win; the daemon deadline
ensures an unforeseen tool stall becomes a tool-level error instead of
`-32603`.

### Isolate the fork's daemon endpoint

Use a Qwen-specific default Unix socket and PID directory. An old upstream
daemon may continue running on the upstream default, but the Qwen proxy will no
longer silently reuse it and execute a different implementation/version than
the binary the user launched. Explicit `--socket` overrides remain unchanged.

### Preserve lifecycle diagnosis

Retain why a session was tombstoned (explicit end, idle expiry, or connection
end) and include that reason in rejection text. Keep explicit `start_session`
revival. Increase the default idle TTL so a normal long agent turn does not lose
its session after only five minutes; the environment override remains available
for tests and deployments.

### Make E2E tests execute the fork binary

Resolve `qwen-cua-driver` in the shared testkit. A missing binary must no longer
turn an intended E2E assertion into a zero-second passing skip when the fork's
binary is present under its actual name.

## Non-goals

- Changing the MCP JSON-RPC protocol or retrying destructive actions.
- Making Tokio able to cancel arbitrary foreign blocking calls; OS subprocesses
  are killed directly and AX receives its native messaging timeout.
- Changing coordinate normalization behavior.

## Verification

Run the same isolated proxy/daemon black-box cases used for the pre-fix
reproduction: failed config persistence, hung app-enumeration shim, hung
screenshot shim, and short session TTL/revival. The two hang cases must return
before the 120-second proxy deadline, leave no child process, and allow an
immediate follow-up call.
