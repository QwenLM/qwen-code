# Qwen Live Proactive

## Goal

Port the in-call Proactive capability from `qwen-omni-realtime-agent` into
Qwen Live. The port supports only the DashScope Realtime monitor backend,
uses the foreground Realtime endpoint, API key, and model, and is enabled by
default. Tasks are scoped to one Live call and are never persisted.

The public capability consists of six foreground-model tools:

- `create_proactive_monitor`
- `create_live_narration`
- `create_proactive_timer`
- `update_proactive_task`
- `cancel_proactive_task`
- `list_proactive_tasks`

When Proactive is disabled, none of these tools or their routing instructions
are exposed to the foreground model.

Tool results are authoritative transactions. Mutation receipts contain the
committed result and a fresh snapshot of the active task pool, while the text
returned to the voice model is a speech-safe rendering that omits internal
task ids and private error details. A failed mutation therefore cannot be
mistaken for a completed action.

## Configuration

`config.json` contains one `proactive` object. Only settings read by the
DashScope Realtime Proactive path are included:

```json
{
  "proactive": {
    "enabled": true,
    "monitor": {
      "sessionRecycleEvals": 60
    },
    "scheduler": {
      "evalIntervalSec": 2,
      "maxConcurrentTasks": 4,
      "maxFailuresPerTask": 3,
      "repeat": {
        "cooldownSec": 3,
        "maxWaitTtsSec": 30,
        "clearBufferOnResume": true
      }
    },
    "vision": {
      "fps": 1,
      "windowSizeSec": 10,
      "minEvalDurationSec": 0
    },
    "audio": {
      "windowSizeSec": 60,
      "minEvalDurationSec": 0
    }
  }
}
```

`QWEN_LIVE_PROACTIVE_ENABLED` is the environment override for the master
switch. Monitor endpoint, credentials, and model come from `realtime`; the
text-only Monitor does not inherit or send the foreground voice. Microphone
input remains fixed at 16 kHz mono PCM16.

## Task lifecycle

Each Live call owns one task manager and scheduler. A timer task uses a local
generation-fenced timer. A perception task owns one independent manual-mode
DashScope Realtime WebSocket and moves through provisioning, running,
delivering, and a terminal state. Updating a running perception task replaces
its monitor connection; cancelling, stopping the call, or a fatal foreground
failure closes it. Late callbacks are rejected by both call epoch and task
generation.

Perception tasks support two contracts:

- Event monitor: one future observable condition, optionally repeated. A
  repeated event rearms only after cooldown and a later `wait` result.
- Live narration: continuing, novelty-sensitive descriptions. It stays active
  until cancelled and does not require a false edge between distinct updates.

One-shot tasks become completed only after their announcement is actually
played. Repeated tasks stay running while any earlier notification is queued
or announcing. Each notification has an independent delivery id and ACK;
acknowledging one never retires a later event or resets ongoing observation.
Cooldown is measured from detection and keeps the configured false-edge rule.
Updating or cancelling a task invalidates all of its pending notifications.

The same genuine microphone turn may continue through multiple tool results:
list then cancel, Appshot then create, or validation error then corrected
arguments. Continuations inherit only that turn's existing tool capability;
synthetic Proactive turns and repair-result continuations cannot gain it.
Task-list receipts expose timer remaining duration, reminder content,
monitoring condition/focus, response guidance, repeat state, and pending-event
count without exposing internal ids.

The last successfully created or updated task may be referenced without a
title only from the immediately adjacent genuine microphone turn. That
one-shot context is never consumed by background, receipt, or repair turns.
For safety, an implicit update can only change `repeat` from false to true; an
implicit cancel must have no arguments. Failed mutations preserve the prior
adjacent context, while a successful cancel clears it.

If a successful direct reply audibly promises future monitoring/reminding, or
claims that a Proactive task was cancelled, but made no Proactive mutation
call, Qwen Live asks the same foreground model to re-evaluate that turn in one
silent, response-scoped repair round. The repair reads only the assistant's
own transcript, never ASR text. It may call one allowlisted mutation tool
(cancel-only for a cancellation claim); all other calls are rejected without
side effects. New user speech invalidates a stale repair. Only the subsequent
authoritative tool-receipt continuation may speak.

## DashScope monitor protocol

Every perception task has a text-output-only Realtime session configured with
manual turn detection. The connection receives the fixed monitor system prompt
and one standing user instruction. Microphone PCM and selected-source JPEG
frames are appended continuously. At each evaluation boundary the client:

1. appends 100 ms of silence so the server-side audio buffer is non-empty;
2. sends `input_audio_buffer.commit`;
3. waits for the matching `input_audio_buffer.committed` event;
4. sends one `response.create`.

The only valid final actions are `wait`, `Reply: <text>`, and
`Func_call:<...>`. `Reply:` produces a Proactive event. `wait` is silent, and
monitor-proposed function calls are recognized but never executed. Invalid
output fails closed and recycles that monitor connection. Connections recycle
after the configured number of evaluations while retaining recent media for
the configured window.

## Media routing

Microphone PCM is copied to every active task that selected audio. Visual
evidence always follows Qwen Live's currently selected Screen or Camera source:

- Live Feed frames are copied from the existing Host frame path and sampled no
  faster than `proactive.vision.fps`.
- In On Demand mode, the scheduler privately requests frames from the existing
  correlated Host capture path while at least one active vision task exists.
  This does not invoke the foreground `appshot` tool or commit the foreground
  audio buffer.

Every selected modality must have real recent evidence before evaluation;
transport padding silence never counts as evidence. Optional minimum-duration
settings add warm-up requirements. Audio and vision keep their own configured
windows both for warm-up and for replay after reconnect, including in a
combined task. Changing the selected visual source replaces
each vision Monitor session so committed frames and late results from the old
source cannot cross into the new source timeline.

## Announcement FIFO

There is no Turn Arbiter. Triggered events enter a durable FIFO lane in the
existing injection gate. The lane observes the same three foreground barriers:
user speech, an in-flight foreground response, and Host playback.

Only one Proactive item may be submitted to the foreground Realtime model at a
time. Submission itself closes the gate synchronously, covering the interval
before `response.created`. The model receives a structured
`[PROACTIVE_EVENT]` context item and produces a natural spoken response from
the monitor evidence plus the user's requested response guidance.

Foreground waiting and playback do not pause repeated Monitor evaluation.
Newly detected events append to the same FIFO, including multiple events from
one task. Cancel/update/failure removes all affected records before notifying
the gate, retracting queued tail items before the current item to avoid
synchronously admitting another obsolete event.

The next FIFO item is released only after both boundaries for the current item
have occurred, in either order:

- the foreground Realtime response is done;
- the Host reports playback completed.

Audio chunks and playback receipts carry a monotonically increasing output id.
When the Host advertises `outputAudioEndMarkerV1`, `response.done` sends an
explicit end marker and seals that id; later response audio receives a new id.
The Host acknowledges each id only after both its marker and all scheduled
frames have drained, while the daemon keeps the injection gate closed until all
consecutive outputs have completed. Clearing playback retires every outstanding
id, so late started/completed receipts cannot acknowledge a newer Proactive
delivery. Hosts without the capability retain the legacy drain behavior. If the
user starts talking after the model response is done but before its queued audio
finishes, that delivery is put back at the head of the FIFO and retried after
the user's foreground turn.

Queued time does not consume the delivery-ack timeout. The timeout begins when
foreground Realtime emits `response.created`, so generation and the Host
playback acknowledgement share one bounded delivery window. Duplicate start
signals do not extend that deadline. A stale epoch, cancelled task, or old
delivery generation can never acknowledge a newer item.

## Failure boundaries

- Monitor setup and consecutive evaluation errors fail only the affected task.
- A permanently failed task queues one fixed, speech-safe notification naming
  the task; technical details stay in diagnostics and the notice cannot recurse
  into task failure handling.
- A rejected announcement submission remains queued for retry.
- A delivery acknowledgement timeout fails that delivery and releases the FIFO,
  including when the Host never reports playback start or completion.
- Cancelled or audio-less announcement responses never acknowledge delivery;
  user-interrupted announcements are retried at the front of the FIFO.
- Foreground Realtime or Host-call failure tears down the whole call-scoped
  Proactive runtime.
- No media payload, transcript, API key, monitor prompt, or task evidence is
  written to debug logs; logs contain ids, states, dimensions, byte counts, and
  sanitized error metadata only.

## Verification

Automated tests cover config defaults and validation, init output, tool
visibility and CRUD, monitor manual commit ordering, action parsing, generation
fences, timer replacement, perception warm-up, repeat false-edge behavior,
call cleanup, and strict FIFO delivery across response/playback ordering.
