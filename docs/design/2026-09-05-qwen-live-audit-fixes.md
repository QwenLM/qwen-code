# Qwen Live audit corrections

## Problem and scope

The local Live extension rejects Proactive tool chains that belong to one user
turn, can leave the notification gate waiting after reordered provider events,
uses the vision window for audio evidence, and omits useful task-list details.
Repeated monitors also stop observing as soon as their first event is queued.
Camera snapshots reuse the preview stream and cannot independently request
their capture resolution.

This change fixes those behaviors. The source Monitor prompt and the Proactive
repair prompt remain intact. Publishing, release feeds, general UI redesign,
and ACP installation policy are outside this change.

## User-turn authority and delivery gate

The existing Realtime tool capability represents authority inherited from a
real microphone turn. Proactive tools may execute in that turn's tool-result
continuations, including list then cancel, Appshot then create, and validation
failure then retry. Synthetic notifications and repair-result continuations
must not gain this authority. Response lineage retains the originating input
item while the user-turn capability is valid.

The input-commit callback explicitly reports whether a direct response still
needs to be created. The Injector consumes that fact instead of independently
assuming every commit precedes response creation. A late completion belonging
to an earlier turn must not release a genuinely pending newer turn.

## Continuous observation and notification FIFO

Repeated perception tasks remain running while their events are queued or
announcing. Each event has its own delivery id, status, and acknowledgement
timer. Acknowledging an earlier event retires only that event; it does not
pause, reset, or complete its monitor. One-shot tasks retain their existing
delivering-to-completed lifecycle.

Observation and evaluation continue independently of foreground playback.
Event monitors still require a false observation before another true match;
configured cooldown suppresses duplicate alerts. Narration retains the source
prompt's novelty behavior. Cooldown runs from detection, not from playback.

Cancel, update, failure, and call teardown invalidate all affected queued
deliveries. All records are removed before invoking callbacks; queued tail
items are retracted before releasing a current item so synchronous FIFO
advancement cannot submit a cancelled event.

Audio and vision evidence use their own configured windows for warm-up and
Monitor reconnect replay. Task-list receipts retain remaining timer duration,
reminder contents, monitoring condition/focus, response guidance, repeat state,
and any queued-delivery count, while still hiding internal ids.

## Independent camera snapshots

`visualInput.cameraSnapshotResolution` defaults to `native` and also accepts a
width/height pair. `QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION` overrides it.
`cameraResolution` controls preview and Live Feed; `snapshotResolution`
controls Screen snapshots. Init writes defaults without another prompt.

For user Appshot requests, the Host obtains a still image from the selected
camera track and fits it within the requested snapshot bounds. Native uses the
device's available still-image size; when still-image capture is unavailable,
a supported video-constraint capture may be used with explicit frame readiness
and preview restoration. Capture failures must not masquerade as native 720p.

The high-resolution JPEG is stored as the camera handoff asset. Its bounded
transport preview still follows the existing 1080p/190 KiB provider limit.
The full asset crosses only trusted Host-local IPC and retains the existing
8 MiB asset limit. Proactive private captures do not invoke high-resolution
still capture or reconfigure the camera for each monitor frame.

Configuration flows through the standalone daemon, synchronized Host type
copies, Host welcome/settings parsing, correlated capture request, preload
camera capture, and main-process asset storage. Fields are optional on the v9
wire format; local Host and daemon builds must be updated together.

## Files and verification

- Realtime session and orchestrator: user-turn continuation and commit gate.
- Proactive scheduler, task manager, Monitor, receipts: independent event
  delivery, modality windows, and complete task information.
- Config/init/daemon and Host coordinator/protocol/camera capture: snapshot
  resolution, full asset, and bounded transport preview.
- README and the existing visual/Proactive design documents: current behavior.

The reproducible baseline and verification matrix live in
`.qwen/e2e-tests/2026-09-05-qwen-live-audit-fixes.md`. Verification uses source
protocol simulations and built package artifacts, followed by targeted unit
tests, type checks, builds, and independent review. The global qwen command is
not available and has no standalone Live Proactive surface; runtime simulations
exercise the affected code directly without recording user media.
