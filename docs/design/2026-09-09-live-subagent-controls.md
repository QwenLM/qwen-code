# Live subagent controls and approvals

[English](2026-09-09-live-subagent-controls.md) | [简体中文](2026-09-09-live-subagent-controls.zh-CN.md)

## Current behavior and scope

Live can observe multiple Harness sessions and runs one evaluator per monitor.
However, monitor admission defaults to four, and the 32-record detail cache can
evict active tasks. Subagents is read-only. Session-level cancellation can stop
the wrong task when invoked through an old job handle. Permission requests are
retained after hangup but have no native approval controls. Codex ACP versions
inspected locally advertise an explicit asking mode, not `default`.

Remove Live's application-level active-task admission cap, retain every active
task's bounded detail, and add paginated management, exact-task stop, explicit
approval controls and truthful text receipts to Omni. Backend/service quotas,
per-session queue limits and physical resources still apply; no global backend
settings, sandbox bypass, model call or existing user configuration is changed.
Independent Harness work uses separate sessions; continuing an existing session
retains its existing queue/steer behavior.

## Contract and transport

Keep protocol v9 compatibility. A new optional `subagentsControlV1` welcome
capability advertises standalone management. The existing subagents snapshot
stream remains a bounded change signal and legacy read-only view. New Host
management uses an authenticated loopback `POST /live/subagents` endpoint,
requiring the same bearer token and instance nonce as standalone shutdown.
Requests and responses are size-bounded and validated. It is daemon-scoped,
not call-epoch-scoped, so Harness work remains manageable after End call.
Requests are limited to 4 KiB and management responses to 1 MiB; the legacy
snapshot remains 240 KiB. Pending unassigned approvals have their own snapshot
count so the collapsed summary can warn without inventing a task. Approval
descriptions retain up to 4096 characters; an incomplete description is marked
and cannot be approved here, although an offered Deny remains available.

Shared browser-safe contracts live with the subagent types:

- Request: `list` with offset and optional selected task ID; `stop` with exact
  task ID; `permission` with exact pending request handle and offered decision.
- Page: bounded snapshot, offset, retained total and optional selected detail.
  Task metadata may advertise `canStop`, a fixed disabled reason and a bounded
  list of pending permissions. Unassigned permission requests are exposed
  separately rather than attributed to an unrelated job.
- Result: page or an explicit operation outcome (`stopping`, `stopped`,
  `already_ended`, `allowed`, `denied`); failures use owned error codes.

Host keeps all credentials in main. Native IPC accepts only these typed
operations from its current subagent renderer. Mutations echo the rendered
daemon instance, checked before dispatch; stale replies and old instance/row
actions cannot act on a replacement daemon's reused job/request counters.
Host refreshes the current page on bounded state updates while expanded,
coalesces in-flight refreshes, and stops fetching when the panel is closed.

## Runtime behavior

- Remove the monitor admission gate and generated maxConcurrentTasks setting.
  Accept the legacy field without enforcing it so existing init files do not
  retain the old cap. Per-task failure/media limits remain unchanged.
- Retain all active ledger details; evict only old terminal history. Page at
  the existing 32-row/message-size boundary, with selected detail loaded on
  demand. Never solve unlimited active tasks by unbounding a single payload.
- Stop Proactive by immutable task ID and use its existing cleanup/delivery
  invalidation path, not a title lookup that can match a replacement task.
- Add targeted adaptor cancellation. Qwen uses the existing exact
  removePendingPrompt API. ACP removes a matching queued item or cancels only
  its matching active ref/generation. Unknown refs and unsupported adaptors
  fail safely; they never fall back to cancelling another current task.
  Cancelling queued B must not clear running A's state or steal A's output.
- Preserve cancellation-request versus terminal-confirmation semantics. A
  manual request and its eventual outcome generate small, owned text receipts.
  Pending receipts survive End call, queue while foreground speech is busy,
  and are removed only after the complete text is accepted by Realtime. Use
  distinct silent injector control items so ordinary 6000-character batch
  truncation or speech-only acceptance cannot falsely acknowledge a receipt.
- Advertise an asking mode only after selecting and awaiting an explicitly
  supported ACP mode. Prefer advertised `default`, or the verified Codex
  `read-only` / `Ask for approval` combination. Never select full access.
  Unknown/unavailable mode negotiation reports a warning, not guaranteed
  manual approval. Changes apply only to sessions Live creates.
- Present real broker requests and their supported options, including while
  the call is stopped. Revalidate the exact pending handle on approval; do not
  turn an ordinary filesystem denial into a fabricated permission request.
  The user's specific file error remains unconfirmed until matching evidence
  arrives; compatibility and missing UI controls are independently testable.

## UI and validation

Use the current pinned floating panel, without native dialogs or changed drag
bounds. Add compact Stop controls, inline result/error feedback, Previous/Next
pagination and approval actions in details. Close still only closes the panel.
All fixed English/Chinese labels belong to the existing message catalogue.
Cover >32 active tasks, more than four monitors, same-title replacement, queued
versus active jobs, duplicate/stale stop, no active call, full text delivery,
unsupported capability and permission replay/resolution. No real media or paid
provider is needed for regression tests.

## Summary

### Current behavior and scope

Live already observes multiple Harness sessions, and each monitor has its own
evaluator. However, monitors default to a limit of four, and the 32-entry detail
cache can evict active tasks. The management panel is read-only; session-level
cancellation through an old job can stop a newer task. Permission requests remain
after hangup without native approval buttons. The locally inspected Codex ACP
offers an explicit manual approval mode instead of `default`.

Remove Live's own active-task count limit, retain bounded details for all active
tasks, and add paginated management, exact stopping, explicit approval and
truthful text receipts to Omni. Backend quotas, per-session queues and physical
resource limits still apply. Do not change global backend settings, bypass the
sandbox, call a model or change existing user configuration. Independent parallel
work uses different Harness sessions; existing sessions keep their queue/append
semantics.

### Contract and transport

Keep v9 compatibility and advertise standalone management through optional
`subagentsControlV1`. Preserve the snapshot stream as a bounded change signal and
legacy read-only view. Management uses loopback `POST /live/subagents`, validates
both the bearer token and instance nonce, and bounds and validates request and
response bodies. Its scope is the daemon, not the call epoch, so background
Harness work remains manageable after End call. Shared types cover pagination,
stopping by ID, approval by request handle and explicit operation outcomes;
unassigned permissions must not be attributed to other tasks.

Credentials stay in Host main; IPC accepts typed operations only from the current
subagent renderer. Mutation requests carry the displayed instance identity,
preventing old instances/rows from acting on counters reused by a new daemon.
Coalesce state-driven refreshes for the current page while expanded, and stop
fetching when collapsed.

### Runtime and UI

- Remove monitor count limits and maxConcurrentTasks from newly generated
  configuration. Read the legacy field compatibly but no longer enforce it.
  Per-task failure, media and transport limits remain unchanged.
- Retain every active detail and evict only old terminal history. Keep the
  32-entry page and payload limits, loading selected detail on demand; never
  implement “unlimited tasks” by enlarging a single message.
- Cancel Proactive by immutable ID, reusing cleanup and delivery invalidation;
  title matching must not stop a replacement task with the same title.
- Harness cancellation is exact: Qwen uses existing removePendingPrompt; ACP
  removes only the matching queued item or cancels the matching current
  ref/generation. Unsupported or unknown IDs fail explicitly without falling
  back to another current task. Cancelling queued B must not clear running A's
  state or take its output.
- Distinguish requested stop from an actual terminal state. User actions and
  final outcomes produce bounded text receipts, retained across hangup and queued
  while the foreground is busy. Confirm delivery only after Realtime accepts the
  complete text. Separate silent control items prevent false acknowledgements
  through ordinary 6000-character batch truncation or speech-only success.
- Claim manual approval is enabled only when explicitly supported and
  successfully selected. Prefer advertised default, or the verified Codex
  read-only / Ask for approval combination; never choose full access. Warn on
  unknown/failed selection, and apply only to sessions newly created by Live.
- Show actual pending approval requests and backend-offered options in details;
  these remain actionable after hangup, with handle revalidation before acting.
  Never invent an approvable request from an ordinary write denial. The actual
  reported error still needs log confirmation; mode compatibility and missing UI
  controls can be verified independently.
- Retain the pinned, draggable floating panel; add compact Stop controls, inline
  feedback, Previous/Next pagination and approval actions without native dialogs.
  Close only closes the panel. All fixed text stays in the English/Chinese
  message catalogue.

Tests cover more than 32 active tasks / four monitors, old IDs, same-title
replacement, queued and running tasks, duplicate operations, hangup and complete
text delivery, legacy capabilities and permission replay/resolution. No real
media or paid model is used.
