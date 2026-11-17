# Sessions a program drives take accepted cross-session messages

[English](2026-11-16-acp-accepted-peer-messages.md) | [简体中文](2026-11-16-acp-accepted-peer-messages.zh-CN.md)

Status: implemented alongside this document.

## Problem

A session a program drives over ACP (one the daemon runs for Web Shell,
or one an editor drives directly) registers in the session directory, is
listed by `list_agents`, and can send with `send_message`. Anything sent
to it is answered `refused`. The `qwen --acp` process that hosts it binds
its inbox with a policy reader that answers `refuse` for every message,
so none of it is ever judged.

The reason was that a hold is a question for a person, and nobody watches
a hold list for such a session. That still applies to messages that
would be held. It does not apply to the rest. A message from a session in
the same review class, from a trusted controller, or from a process the
session started would be accepted without review, and today it is refused
like everything else. So two Web Shell sessions cannot tell each other
"the build finished", and neither can a terminal session tell a Web Shell
one.

Two earlier attempts at this (#12162, #12403) brought the whole message
lifecycle in at once: per-message bookkeeping from acceptance through a
turn that might never run, with corrections at every step. Each review
round found new defects in the transitions. This change takes the
smallest piece that is useful by itself. It accepts what the gate
accepts, matches the guarantees an interactive terminal session gives
today, and lists what it leaves open.

## Design

**The gate refuses what it would have held.** `InboundGate` gets one
option, `presentsHolds`, true by default. A host that sets it to false
has nowhere to show a held message, so the gate treats a hold decision as
a refusal: the sender gets `refused`, the id is settled, and nothing is
parked. Accepts are unchanged, and so are explicit `refuse` settings.

The conversion has to happen in the gate. The host cannot get the same
result by answering `refuse` to the policy reader. That reader only sees
the explicit setting, and an explicit setting outranks a trusted
controller and the session's own processes. Answering `refuse` there is
what the host does today, and it is why those messages are refused.

`refused` is the right answer for every cause of a would-be hold here. An
explicit `hold`, a sender in the other review class, a sender with no
declared class, and an unrecognized setting value all depend on this
session's standing configuration. That configuration will not change
unless the user changes it, so the sender should stop instead of
retrying. An unknown approval mode is not reachable for a session this
host holds, because the readers below answer it from a live `Config`.

**Every reader answers for the addressed session.** The host already
recognizes both names a session goes by: the id it was published under,
and the id its `Config` holds now (`/clear` and a resume replace the
latter). Session admission checks both IDs for active owners. The lookup
uses either ID when it identifies one registered session and answers `misaddressed`
when multiple registered sessions match. Every reader uses that lookup:

- Whether the host owns the session (`ownsSessionId`). Only a session
  that registered for messaging counts. A session whose settings turn
  messaging off has no record and is not addressable. A sender that
  knows its id anyway is answered `misaddressed`. Today such a sender
  gets a judgment based on another session's mode.
- The approval mode comes from that session's `Config`.
- The policy is that session's own `agents.crossSessionInbound`.
- Delivery goes to that session's queue. Closing sessions and sessions
  paused by Stop return `queue-full`. A new prompt clears the pause.
  Once the session is gone, a retry receives `misaddressed`.

**Child credentials require a single-session inbox.** A process-wide
credential proves descent from the host. The shared ACP inbox accepts
peer and controller credentials. Terminal inboxes keep the own-process
credential.

**Delivery is wired before the socket binds.** `PeerMessaging.start`
accepts the submit function as an option and installs it before the
inbox listens, as it already does for the gate. A host with a submit
function from the start never buffers. A buffered message whose session
had gone could not be submitted, and it would block every message behind
it.

**An accepted message is a background notification of kind `peer`.**
The host hands the message to the addressed session, which queues it on
the same notification queue that carries finished agents and shells.
Once the session is idle, its turn records the message in the transcript,
shows it to the client, and gives it to the model. Recording at that
point keeps a message that expired in the queue out of transcript replay.
That is the "next turn" a terminal session gets too, not an interruption
of running work. The kind `peer` is already recognized by every parser
between a session and a client (#12342). While a message waits, the
session counts as busy, so a conditional close does not discard it.
The turn's label is the receiver's own attribution of the message
("Message from another session (name): ..."), cut to the label length.
Web Shell shows the label next to the cross-session marker, so the
person reading the transcript sees who sent what. A label the sender
chose could impersonate a trusted controller, so it is not used.

Peer messages have a separate 20-slot allowance within the notification
queue, leaving all 20 background-result slots available to results. A
full peer allowance answers `queue-full`, and the sender can retry. This
preserves room for the completion a deferred work chain needs to resume.

**Messages a session never reads are corrected to `expired`.** When the
host removes a session, it detaches the messages still in that queue and
sends `expired`. When `/clear` switches conversations, it does the same
for messages queued under the old conversation ID. Process shutdown
stops intake and detaches unread messages before awaiting socket
teardown. It also waits for receipts from messages requeued during
session teardown. Receipt batches run independently within the shared
outbound send limit (64), waiting for capacity when all slots are used.

## Files

- `packages/core/src/ipc/inbound-gate.ts`: the `presentsHolds` option.
- `packages/cli/src/peerMessaging/peer-messaging.ts`: the option passed
  through, the submit function as a start option, and a method that
  reports a list of queued messages `expired`.
- `packages/cli/src/acp-integration/session/Session.ts`: the `peer`
  kind, the queue entry point with its room check, eviction exemption,
  and the list of queued peer messages.
- `packages/cli/src/acp-integration/acpAgent.ts`: per-session readers,
  routing to the addressed session, and the corrections on session
  removal and shutdown.
- `docs/users/features/commands.md`,
  `docs/users/features/cross-session-protocol.md`: the new behavior and
  what remains open.

## What this leaves open

- **Held messages.** A session a program drives still cannot show one,
  so whatever the gate would hold is refused. Showing it through the
  client's permission request, the Web Shell interaction it would
  render as, and the questions in #12303 (holds of a departing session,
  a host-wide ceiling) are the next piece.
- **A message taken by a turn that never runs.** The drain removes a
  message from the queue before its turn starts. A turn cancelled before
  the model sees it, or cut off at the token limit, leaves the sender
  with a `delivered` that is not corrected. (A turn the session refuses
  to start puts the message back on the queue, where the corrections
  above still find it.) An interactive terminal session has the same
  gap. Closing it means tracking messages in flight, the state machine
  that stopped #12403.
- **The duplicate window is per sender.** The same body sent by one
  sender to two sessions of one host within 30 seconds reaches the first
  and is dropped as `duplicate` at the second. Scoping it by addressee
  has to change the receiver and the sender's local pacer together.
- **Re-using an id after a correction.** The gate's settled record for
  an id stays `delivered`, so a sender that re-sends the same id after
  an `expired` correction is told `delivered` again. A re-send with a
  fresh id, which is what Qwen Code sessions and the SDK endpoint do,
  is not affected.

## Verification

- Unit: the gate refuses a would-be hold with `presentsHolds: false` and
  retains the default controller and single-session own-process rules.
  The shared inbox only exports an address through the peer registry.
  The host routes by either name for a registered session. Peer messages
  have a separate allowance from task results, expire on conversation
  change and close, and enter the transcript when a turn takes them.
- End to end: a terminal session and a Web Shell session in the same
  review class send each other a message. The Web Shell session shows the
  message and answers it in a turn of its own. A message from a session
  in the other class is refused, and the sender's transcript says so.
