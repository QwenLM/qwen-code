# Transactional WebUI resync and live-journal repair

## Problem

The WebUI rebuilds a session after an event epoch reset or replay-ring gap by
clearing the visible transcript and replacing the current attachment before a
fresh load succeeds. Live-journal repair uses the same destructive reload path.
A slow or failed load can therefore hide a still-useful transcript, reopen a
known-gapped attachment for writes, or lose the healthy source stream used by
repair.

## Scope

This change makes event-gap resync and live-journal repair transactional for
modern daemons that advertise `client_identity`. It reuses the provider-local
restore coordinator used by cross-session switching and same-session refresh.
Selective transcript reading, branch adoption, durable checkpoints, and daemon
wire formats remain separate work.

Daemons that explicitly lack client identity retain the legacy recovery path.
Unknown capabilities or malformed ownership fail closed. No feature flag or
second restore coordinator is introduced.

## Resync episode

A `state_resync_required` frame creates a provider-local recovery episode tied
to the exact source attachment, normalized workspace, committed client id,
lifecycle, environment, and one absolute restore deadline. The episode is a
safety lock rather than a request: superseding or failing one restore intent
does not make the gapped source writable again.

The runner flushes every legal event before the sentinel, leaves the retained
transcript visible, and parks the source stream without clearing its session or
prompt state. All sentinel reasons use the same authoritative full-load path;
the reason is diagnostic and a replacement epoch may equal or differ from the
source epoch.

Recovery always requests response replay with no history page size and reuses
the committed client id. It waits for already-started source-bound requests,
shell work, and prompt admission to settle, but an admitted prompt may continue
while the snapshot is prepared. If prompt admission self-heals the source
registration before recovery starts, the episode adopts that new committed
client id; the identity is fixed once the load request begins. A candidate must
have the exact owner identity, a complete non-degraded replay, a concrete epoch,
and a valid watermark. When the epoch is unchanged, a known gap reason must
advance beyond the final processed source cursor; other recovery reasons cannot
move behind it. Cursors from different epochs are not compared.

The replay is built in an unsubscribed shadow store. Commit synchronously swaps
the transcript, history owner, session handle, connection state, cursor, and
prompt ownership, then starts the prepared runner. The old registration is
detached once afterward. Source and candidate may use the same logical client
id, so cleanup is tracked by attachment object and registration reference, not
by comparing client-id strings.

If automatic recovery cannot finish, the old transcript and attachment remain
visible but read-only. A same-session reload starts a new authoritative recovery
attempt; successful navigation to another session or an explicit lifecycle
operation ends the episode. A failed close or release resumes recovery instead
of silently leaving the safety lock without an active attempt. The old cursor
is never resumed after a real gap.

## Prompt and side-effect consistency

Replay reconstruction and local prompt-promise settlement are separate. Replay
already materializes terminal `assistant.done` state, so a matching local waiter
is resolved or rejected without dispatching another transcript terminal. An
idle candidate without a terminal for a bound local prompt is rejected; an
active candidate carries the waiter into the replacement runner. If replay
settles that local prompt while the candidate reports another active prompt,
the successor remains owned by the replacement runner until its terminal.

Historical replay does not republish notices, pending-prompt events, mid-turn
injection events, or workspace-change counters. After commit, one reconciliation
pulse refreshes workspace resources and pending/mid-turn snapshots, while only
the latest follow-up suggestion is restored. Extension change details are
cleared so a historical extension toast cannot reappear.

## Live-journal repair

Repair keeps its existing marker, checkpoint, and target-turn suffix rules but
uses the same coordinator. The healthy source runner remains live while a full
candidate snapshot is prepared. A bounded same-epoch source-tail capture closes
the interval after the candidate watermark. If the load response arrives before
the source SSE reaches that watermark, preparation waits within the existing
deadline instead of treating delivery lag as corruption. The deadline starts
when repair is queued, including when the source runner has not reached
`replay_complete`. Commit atomically replaces the marker with the complete
suffix plus captured tail and advances the candidate cursor to the final
processed source event.

The captured tail is reduced after the candidate snapshot, so newer title and
token-usage updates remain authoritative through commit and runner startup.

Repair replay and tail events have already been observed, so their external
side effects are not emitted again. Repair attempts once. Failure retires the
candidate and capture and continues the healthy source; a resync sentinel takes
priority and converts the session to the persistent read-only episode.

## Scheduling and failure behavior

Resync shares one deadline across at most three requests. Only structured
pre-attachment conditions are automatically retried: `session_closing`, an
ordinary `restore_in_progress`, and a retryable quarantined ACP channel. Network
outcome, restore timeout, abandoned-cleanup fences, generic HTTP failures, and
candidate-integrity failures do not retry automatically because the server may
already have registered an attachment that the client cannot identify safely.

The WebUI connection exposes a recovery-required bit and a recovery transition
origin. The main WebShell and split panes block every session mutation while a
recovery is preparing or a gap remains unresolved. Read-only inspection,
navigation, and explicit clear/new/close/release paths remain available.
Controlled navigation rolls back host state only for controlled transition
failures, never for an internal recovery failure.

## Verification

Provider tests cover every resync reason, legal-prefix flushing, replay
integrity, prompt settlement, retries, supersede and lifecycle races, exact
registration cleanup, side-effect reconciliation, and repair capture/commit.
WebShell tests cover both layouts and provider-level mutation defenses.

A real-daemon JSDOM test pauses an SSE reconnect, advances a three-event ring
past the retained cursor, and observes a genuine `ring_evicted` sentinel. It
then delays the recovery load to prove that the source transcript stays visible
and read-only until atomic commit. The existing real-daemon live-journal test
delays the repair load and verifies that the healthy source remains attached and
the repaired turn appears once.
