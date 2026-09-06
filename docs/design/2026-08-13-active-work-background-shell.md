# Background shell active-work coverage

## Problem

A Prompt can start a long-running background shell and finish immediately. Before this change the daemon then observed `activePrompts: 0` and `activeWork: false` even though `GET /session/:id/tasks` still reported a running shell. A restart controller could therefore treat the daemon as idle and terminate the Session before the shell's terminal notification reached the parent continuation.

## Decision

Session-managed background shells join the existing active-work snapshot protocol as category `shell`. A Session publishes one aggregate hold while its shell registry has a running entry, a shell terminal notification is queued, or that notification is driving the parent continuation:

```json
{ "category": "shell", "id": "background-shells" }
```

The hold is deliberately aggregate. The shell registry and task-status surfaces remain the detailed roster, while the retention protocol stays bounded even if a Session owns more than 1024 shells.

The Session collector remains an unfiltered statement of local truth. Category negotiation is applied only when the reporter serializes a wire snapshot. This distinction is required for compatibility: a new child talking to an old v1 daemon filters `shell` from the wire, but its conditional-close check still sees the running shell locally and answers `closed: false`.

## Negotiation and compatibility

The protocol version remains v1. The daemon initialize request advertises `agent`, `notification`, and `shell`; the child answers with the intersection it supports. A request with no `categories` is the pre-negotiation v1 baseline, `agent` and `notification`.

| Peers                                      | Reporting result                         | Ordinary automatic cleanup                            |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| new daemon + new child                     | `full`; shell hold crosses the wire      | existing conditional-close flow                       |
| new daemon + old v1 child                  | `partial`; `shell` is missing            | disabled for that Session                             |
| old v1 daemon + new child                  | wire contains only the legacy categories | local conditional close still rejects a running shell |
| daemon + child with no active-work support | `none`                                   | historical legacy cleanup                             |

Negotiated-but-incomplete and unsupported are intentionally different. An unsupported historical child keeps the behavior it had before active-work existed. A child that negotiated the protocol but omitted a currently required category has explicitly disclosed that its predicate is incomplete, so it cannot authorize an ordinary teardown. Explicit close, kill, daemon shutdown, channel exit, and condemned restore cleanup keep their force semantics.

## Lifecycle and ordering

The shell registry synchronously reports registration and terminal transitions. Session installs an identity-safe status callback that triggers the existing change-coalesced reporter and removes exactly that callback on dispose.

At shell completion, the registry invokes the notification callback before publishing the terminal status change. The notification is therefore already queued when the running entry becomes terminal. When the drain removes the queue item it marks the shell continuation active before yielding. These transitions ensure the derived aggregate hold has no false gap between running, queued, and executing states. Prompt teardown also retains the existing reporter flush-before-response ordering, so a shell started by the Prompt is visible before the daemon decrements its own prompt count.

`Session.isIdle()` consumes the same unfiltered collector. Workspace reload therefore skips a Session while a background shell or its terminal continuation is active.

Conditional close reads the unfiltered collector once before disturbing active turns and again after those turns drain, while the Session close gate remains held. The final read closes the window where an already-running, otherwise out-of-scope cron or automatic turn registers a shell during drain; the new shell refuses ordinary teardown without adding cron itself to `activeWork`.

## Boundaries

This change tracks the logical lifecycle owned by `BackgroundShellRegistry`; it does not use PID probes or sidecars to reconstruct process liveness. `task_stop` follows the registry's terminal status and does not promise an additional OS-level exit confirmation. A promoted or externally detached process that the registry no longer tracks is outside the signal.

Long-running development servers consequently keep `activeWork: true`. This is the intended retention fact, not shell-stall detection or a restart lease. Monitor, workflow, cron, and follow-up work remain out of scope, and the public health shape, persistence formats, shell admission policy, heartbeat behavior, and watchdog behavior do not change.

## Verification

Unit coverage pins aggregate cardinality, running-to-notification handoff, reporter filtering, legacy negotiation, bridge parsing, incomplete-child retention, post-drain conditional-close authorization, explicit force close, callback cleanup, and unchanged unsupported-child behavior. The E2E plan reproduces the released baseline with a running `sleep` shell and compares it with the local build through shell completion and parent continuation settlement.
