# Prompt-safe session navigation

## Contract

Session navigation may load, resume, or detach session attachments, refresh
heartbeats, and issue read-only requests. Navigation must not create execution
side effects: it must not send `cancel`, admit a new prompt, continue a prior
prompt, or inject a mid-turn message. An explicit user Stop remains allowed to
send one cancellation while a transition is preparing.

The WebShell therefore blocks prompt writes as soon as a desired target is
pending or the daemon transition enters `queued` or `preparing`. Every prompt
records its owner and the write-gate generation before asynchronous host
admission, session preparation, or a prompt prerequisite such as switching to
plan mode, then rechecks them before any composer commit, follow-up clear, send,
or enqueue.
Any prompt that joins an existing lazy-session preparation likewise defers its
composer commit until the shared preparation passes the same check.
It invalidates the continuation when its App instance unmounts. If the gate
closes at any point while admission or preparation is pending, the draft and
retry state remain owned by the source composer even if navigation completes
or fails before the continuation returns. A cancelled retry is consumed only
after navigation settles and its source session becomes current again. A retry
started later supersedes an older retry of the same kind even when their
asynchronous admission callbacks settle out of order. A retry
whose workspace is known may settle across an attachment replacement of the
same logical session. A retry captured before its workspace is known may be
restored only while the captured live owner remains current, or after that same
owner supplies its workspace. An owner change discards it; transcript block IDs
are local to a reducer and cannot establish identity across transcript
replacement. Failed-message restoration therefore requires the same in-memory
block or stable persisted source-record identities. Rehydration is allowed only
when the preceding message has equivalent identity, including an empty
transcript with no preceding message.
Accepting a newer prompt refreshes the retry owner before its send begins, so a
replacement attachment cannot leave its eventual failure tied to a stale live
owner. If navigation resets the transcript after a locally rejected prompt,
the local user message may be restored only when the preceding user-message
anchor still matches. Turn-error retries likewise require the same block or a
stable prompt/event identity after transcript replacement. A missing or changed
identity fails closed instead of offering a retry for a potentially different
transcript.

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
