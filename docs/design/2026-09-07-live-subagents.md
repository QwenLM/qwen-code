# Subagents: side summary, compact list and inline detail

Updated by the user-approved refinement in
`2026-09-07-live-subagents-refinement.md`: one frameless panel and compact
icon/count summary, replacing the original independent detail window.

## Confirmed behavior

Implement proposal C. The hover entry explicitly reads `Subagents` /
`子智能体`, not just anonymous counts. It summarizes working, completed and
needs-attention tasks. A click opens a compact task list; selecting a task
opens detail in that same panel with status, original request, recent
activity, public intermediate output and result. All fixed text uses the
existing paired language catalogue. No cancel, permission approval or task
creation controls are added in this read-only feature.

Counts represent logical tasks, not model connections, monitor evaluations,
backend sessions or steering instructions joined to an existing task. Only an
authoritative successful terminal event counts as completed. Failed, cancelled
and interrupted entries stay distinct. A monitor's condition match, queued
notification and delivered notification are independent of its task lifetime.

History covers the current Live daemon run with bounded retained detail. Voice
End call stops Proactive as before but retains its final history. Harness jobs
and observation continue until their terminal event or daemon shutdown, without
opening a model/audio connection. Requests requiring permission while no voice
call exists are recorded without granting new permissions.

## Runtime and protocol

A daemon-lifetime ledger in LiveSession receives normalized backend events and
Proactive task observations before the speech Injector's throttling. Backend
event pumps have a single daemon-level owner; voice is an optional consumer.
Public agent text, plan and tool updates become a new observation-only activity
event, never a model instruction. Thought chunks, arbitrary raw objects,
credentials and binary/image payloads are not forwarded.

Shared pure contract is the public `@qwen-code/qwen-live/subagents` module,
compiled into Host through the same style of aliases as i18n. It defines a
strict bounded snapshot validator. Optional `subagentsV1` welcome/state field
and an independent `host.subagents` update avoid marking legacy daemons as
supporting this feature and avoid republishing audio/capture state per chunk.

Snapshot: revision, counts, retained tasks. A task has stable id, kind, title,
status, created/updated timestamps, backend/source metadata, latest activity,
bounded public output, recent typed events, and Proactive notification counts.
Retain at most 32 task details and a 240KiB JSON budget, trim terminal history
before active detail and explicitly report omitted records/truncated output.
Counts remain independent of visible retention. One bounded update interval
coalesces text chunks; every new revision remains authoritative.

## Native geometry and interaction

Keep the orb's 384×480 canvas and existing saved logical position unchanged.
Use one separate frameless BrowserWindow for summary, list and detail.
It has a dedicated inert preload, no audio/camera acquisition or general
Live actions. Every IPC verifies sender identity and validates task IDs.

Summary is 132×62 with a bot icon, explicit Subagents title and dot/check counts.
The running dot pulses only with active tasks and respects reduced motion.
List and detail both use 330×430 with internal scrolling, so navigation does
not enlarge the panel across the orb or shift its position.
Choose left/right once on opening from the orb's actual visible rectangle and
current display work area; prefer left near the usual bottom-right position.
Clamp the full window, fall back above/below when necessary, and never move the
orb to fit a task surface. Content updates do not resize or reposition windows.
During orb drag, hide only the collapsed summary; a later hover reanchors it.
Crossing from orb to summary allows about 1s of dismissal grace. Clicking pins
the panel until Escape/Close. Settings, blur and disconnection do not close
expanded content. List/detail headers are draggable; Back preserves location
and clamps the changed size to the display. New output does not move the panel.
Closing the panel does not stop tasks or quit Host.

Language switches and task revisions update stable DOM by ID, preserve selected
task/scroll position, and do not follow new output unless already at the bottom.
Repeated open focuses existing detail; late results cannot reopen a closed
window. Quit closes all surfaces and aborts observers. Display removal clamps
windows to a surviving work area without altering unrelated orb preference.

## Verification

Independent baseline recorded in `.qwen/e2e-tests/subagents-baseline-2026-09-07.md`:
stopping voice aborts backend subscriptions; a later completion stays queued
until a new call; Proactive dispose clears tasks; Host has no subagent surface.
Use fake backends/realtime and real loopback Host protocol, no user config or
devices. Verify hangup continuity, one observer, queued/joined tasks, exact
terminal counts, public activity filtering/bounds, permissions and cleanup.
Verify geometry with actual primary/right-hand display metadata, opposite
screen edges, drag, close/reopen, Settings, and status updates. Native smoke
uses inert services. Run package suites, build/typecheck/bundle, boundary checks
and two clean review passes. No release or dependency reinstall.
