# Qwen Live tool continuation and permission resume

## Problem

DashScope Realtime does not automatically continue after a
`function_call_output`. The standalone Live client currently submits the tool
output without requesting another response, so result-bearing tools leave the
conversation silent until the user speaks again.

Creating every continuation immediately is also incorrect. User speech owns
the current turn: backend results that arrive while the user is speaking must
be retained and folded into the answer to that utterance, rather than racing
the provider's direct response or speaking over the user. A second lifecycle
gap exists after `response.done`, because the Host can still have buffered
audio even though the provider response is no longer active.

Permission requests have a second lifetime mismatch. ACP sessions outlive a
Live call, and an injected spoken ask can also be interrupted or ignored while
the backend request remains parked. Delivery of speech is therefore not proof
that the permission was resolved.

## Design

- Let server VAD detect and commit utterances, but disable its automatic
  response creation. DashScope may acknowledge that commit with either
  `conversation.item.created` for the VAD input item or
  `input_audio_buffer.committed`; treat those as idempotent forms of the same
  event. After the input commit callback synchronously drains queued backend
  context, create exactly one direct response. Tool results and backend speech
  requests that arrive during the open user turn coalesce into that response
  rather than creating another one. If a merge arrives after `response.create`
  has left the socket but before its `response.created` acknowledgement,
  cancel that unacknowledged request and replace it after the merged context so
  the user still hears one combined answer. Keep a cancelled response active
  until DashScope confirms `response.done`; only then release the response slot
  and create its replacement. If another utterance starts first, retire the
  older queued input and ignore its late ASR completion.
- Request tool continuation for result-bearing synchronous tools and permission
  votes. The latter lets Live confirm success only after a delivered receipt.
  Asynchronous `handoff` receipts do not get a redundant acknowledgement
  response; their later backend events remain the user-visible result.
- Keep the injection window closed from `speech_started` through input commit,
  not merely through `speech_stopped`. Starting new speech also ends any old
  playback quiet-gap estimate, even when the audio itself has already ended.
- If speech starts while the Host's estimated playback tail is still pending,
  clear it even when the provider has already emitted `response.done`.
- Own the permission broker at daemon-session scope. On a new Live call,
  reconnect event pumps for every backend session it previously observed,
  drain buffered ACP events, and ask only for decisions that still need the
  user rather than an in-flight standing-rule vote.
- Report `waiting_for_permission` from session status tools, including the
  request handle and human-readable title needed to answer it.
- Treat replayed backend permission events idempotently so resubscription
  never asks the same unresolved question twice.
- Keep unresolved permission asks replayable. Requeue them when user speech
  interrupts output, and after a direct response that failed to cast the vote;
  deduplicate queued reminders and retract them for both local and external
  resolutions.
- Preserve the backend job reference on permission events. Session-level status
  may report any pending vote, but job-specific monitoring reports a vote only
  when it belongs to that exact job.
- Keep internal handles in model context and tool receipts, but strengthen the
  voice contract and proactive summaries so those handles are not spoken.
- Deduplicate completed direct transcripts against their response/input IDs,
  while retaining partial output that was heard before a response was
  interrupted and therefore never emitted a canonical done callback.

## Verification

- Realtime unit tests cover manual direct-response arbitration, one and
  multiple tool calls, both provider input-commit forms, selective and
  coalesced continuations, the pre-ack replacement window, stale continuations,
  repeated speech that supersedes a queued input, unknown tools, and
  `remain_silent`.
- Orchestrator tests cover pending status, call restart, permission relay after
  restart, input-commit injection gating, playback-tail interruption,
  non-duplicated logs, and handle-free spoken completion.
- Run the qwen-live package tests, build, and typecheck before manual Host
  retesting with both `qwen-acp` and `qodercli`.
