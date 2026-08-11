# Prompt-safe session navigation

## Contract

Session navigation may load, resume, or detach session attachments, refresh
heartbeats, and issue read-only requests. Navigation must not create execution
side effects: it must not send `cancel`, admit a new prompt, continue a prior
prompt, or inject a mid-turn message. An explicit user Stop remains allowed to
send one cancellation while a transition is preparing.

The WebShell therefore blocks prompt writes as soon as a desired target is
pending or the daemon transition enters `queued` or `preparing`. A prompt that
is awaiting an asynchronous host admission hook records the write-gate
generation and rechecks it before any composer commit, follow-up clear, session
allocation, send, or enqueue. If the gate closes at any point while the hook is
pending, the draft and retry state remain owned by the source composer even if
navigation completes or fails before the hook returns.

## Queued prompts

An accepted daemon queued prompt is never reposted automatically. When an
admission outcome is uncertain, local cleanup may remove the pending row and
restore its payload to the editor once; it must not infer safety from prompt
text or use text hashes for deduplication.

## Rapid switching

The transactional provider keeps at most one raw restore in flight. An
A-to-B-to-A-to-B sequence may adopt a successful result for the latest
equivalent B target. If the older B restore fails or times out, the latest B
intent may start one serial replacement restore. Superseded targets never
commit and their attachments are detached best-effort.

## Compatibility

Modern daemons that advertise `client_identity` preserve the committed source
until the target is staged and committed. Legacy daemons retain destructive
switching for compatibility; they guarantee only that navigation does not
actively cancel or replay prompts, not that the source remains visible during
restore.
