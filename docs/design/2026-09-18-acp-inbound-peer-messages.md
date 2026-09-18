# Cross-session messages for sessions a program drives

[English](2026-09-18-acp-inbound-peer-messages.md) | [简体中文](2026-09-18-acp-inbound-peer-messages.zh-CN.md)

Status: implemented alongside this document. Sessions hosted by a
`qwen --acp` process, whether the daemon spawned it or an editor drives
it directly, now take messages from other sessions under the same review
rules as a terminal session.

## Problem

[Daemon sessions in the directory](2026-09-09-daemon-sessions-in-directory.md)
gave every session a `qwen --acp` process hosts a registry record and an
inbox, so those sessions could be listed and could send. Anything sent
_to_ them was answered `refused`. Two things were missing.

### Nobody could answer a hold

A held message is a question for a person: deliver this, or drop it. A
terminal session asks through `/peers`. A driven session had nowhere to
ask, so holding would have left every sender waiting out an expiry for
nothing. Refusing was the honest answer until the question had
somewhere to go.

### One process, several workspaces

One `qwen --acp` process can host sessions opened in different
directories, each with its own settings and its own approval mode. The
gate read one approval mode and one set of inbound settings per process.
Judging a message for one session by another session's policy is wrong
in both directions: a repository that holds every message could have one
delivered because a sibling accepts them.

## Design

**Each question is answered for the addressed session.** The gate's
readers for approval mode, `agents.crossSessionInbound`, the hold
lifetime and the policy scope now take the id the frame is addressed to.
A process that hosts one session ignores it. A process that hosts
several answers from that session's own config and settings, and treats
an id it does not hold as `refuse`. Expiry reads the lifetime of each
held message's own session, so a one-minute hold in one workspace
expires on time while a ten-minute hold beside it waits. The gate arms
its timer for whichever comes first.

**An accepted message is a background notification.** Driven sessions
already have a path for "something arrived while nobody was typing": a
finished background task is written to the transcript, queued, and
handed to the model in a background turn once the session is idle. That
path already waits for a running prompt, asks the daemon for admission
to start a turn, reports the turn in live state, and caps its queue. A
peer message is one more kind on it, `peer`. A session whose queue is
full turns the message away with `queue-full` rather than pushing out a
result the model has not seen. A message accepted and then not queued,
because its session closed or the transcript write failed, has its
`delivered` receipt taken back with `expired`, which is a legal step
from `delivered`.

**A held message is a permission request.** ACP already has one way to
put a question to whoever drives a session:
`session/request_permission`. Every client renders it. An editor shows a
dialog. The daemon publishes it as a `permission_request` event, lists
it among the session's pending interactions, and routes a vote back.
So a hold is asked the same way, with two options, `peer_deliver` and
`peer_drop`. The request is marked with
`_meta.qwenInteractionKind: "peer_message"` and carries the sender, the
origin and the hold cause for a client that wants to show it as a
message rather than as a tool call. Nothing new has to exist on the
client side for the feature to work.

**The review does not wait in the tool-approval line.** A session
serializes its tool approvals. A hold can wait minutes for an answer,
and a tool call in the meantime must not queue behind it. Reviews go
straight to the client.

**One review per hold.** The host watches the held set. A new hold
starts a review. A hold that disappears, because it expired, was
released by a mode change or was decided elsewhere, stops the host
waiting for that review. A session's reviews stop when the session goes.
An answer that is neither option, including a cancellation or a
timeout, leaves the message held, and the host asks again after a delay
that doubles each time, up to a minute. A request can be cancelled for
reasons unrelated to the message: cancelling a prompt cancels every
pending request of the session. Without asking again, the message would
sit held with nobody able to decide it. The delay keeps a client that
cancels everything from being asked in a loop.

**The review belongs to no turn.** A message can be held while an
unrelated prompt or background turn is running. The daemon ties a
permission request to the running turn and cancels it when the turn
ends. It leaves a review of a held message untied, so the review waits
on the message's expiry, not on the turn.

**The request carries its own deadline.** ACP gives an agent no way to
withdraw a request it sent. A review therefore says when it stops
mattering, in `_meta.expiresAt`, and the daemon ends the request at that
moment, or at its configured permission timeout if that comes first. A
request with no expiry keeps the configured behavior. The daemon's
pending list never shows a message that already expired.

**Leaving a mode re-judges the backlog.** Parity may release a held
message once the addressed session changes review class. Both ways a
driven session changes mode, the ACP `session/set_mode` call and the
daemon's approval-mode control, re-evaluate held messages. Each message
is re-judged for its own session.

**Exit settles by id.** At exit, messages accepted but never handled get
their receipts corrected. A single session's queue drains oldest first,
so a count was enough. Sessions in one process drain on their own
schedules, so the host now reports exactly which message ids are still
waiting.

## What it does not do

- No new daemon endpoint. Holds use the existing pending-interaction
  list and vote route.
- Holds are not persisted. A held message does not outlive the process,
  as in a terminal session.
- No `/peers` for driven sessions. The review is the only way to decide
  a hold there.
- An editor that ignores `_meta.expiresAt` may keep a dialog open after
  the hold is gone. Answering it then changes nothing.
- Sessions behind one inbox are still one sender to every peer, sharing
  its rate budget and duplicate window. That is unchanged and remains
  listed as unsettled on the protocol page.

## Verification

- The gate: two hosted sessions with different policies on one gate, a
  message for each judged by its own settings, and holds expiring on
  their own sessions' schedules.
- The session: an accepted message is recorded with kind `peer` and runs
  in a background turn; room and waiting ids are reported; a review maps
  all three answers and stops on abort.
- The host: readers answer per session, and an unknown id is refused;
  submissions route to the addressed session; reviews start once per
  hold, map to decisions, and stop when the hold or the session goes;
  a review with no answer is asked again; both mode-change paths
  re-judge.
- The bridge: `_meta.expiresAt` shortens the request timeout, the peer
  details are projected into the pending interaction, and a review asked
  during a running prompt is not tied to it.
- End to end against `qwen serve`: a message from an SDK peer endpoint to
  a daemon session is delivered, and a held one appears as a pending
  permission request and leaves the list when it expires.

## Follow-ups

- A dedicated rendering of `peerMessage` in the Web Shell, instead of
  the generic permission card.
- A typed helper in the SDK for answering a held message.
