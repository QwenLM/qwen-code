# Accepted cross-session messages reach a session a program drives

[English](2026-09-21-acp-accepted-peer-delivery.md) | [简体中文](2026-09-21-acp-accepted-peer-delivery.zh-CN.md)

Status: implemented alongside this document.

## Problem

A session a program drives over ACP — one an editor started, or one the
daemon manages — registers in the session directory, is addressable, and
can send. It answers `refused` to everything sent to it.

That was decided when those sessions first appeared in the directory,
and for a reason that still holds for part of the traffic: a hold is a
question put to a person, and nobody is watching a hold list on such a
session's behalf. A parked message there would wait out its lifetime and
expire, having told its sender `held`, which promises that someone will
look.

But most of what reaches one of these sessions would not be held. The
approval mode a daemon-managed session runs in accepts a message from
another session in the same class. A trusted controller — a program the
user minted a grant for, out of band, by hand — is accepted whatever the
mode is; that is the whole point of the grant. A process the session
itself started is accepted too. All of it is refused today, because the
answer was decided once for every message rather than per message.

The voice front-end that joins through the SDK's peer endpoint is
exactly this case: a grant the user minted, speaking into a session the
daemon drives, turned away.

## Design

**The gate decides, and refuses only what it would have parked.** The
gate gains one option, `presentsHolds`. A host that answers false to it
has nowhere to put a parked message, so every hold becomes a `refused`
receipt and nothing is ever parked. Accepts are unaffected.

It has to be the gate that converts. A host could answer `refuse` to the
policy reader instead, but that reader cannot tell a message that would
be held from one that would be accepted: an explicit setting outranks
both a trusted controller and the session's own processes, so refusing
there would turn away exactly the messages this change exists to let
through.

A hold converted this way is not tombstoned, and what its sender is told
depends on why it would have been held. Three of the reasons are the
session's own standing answer — its setting, a sender in another review
class, a sender that asserted no class — and `refused` tells that sender
to stop. Two are momentary: an approval mode that could not be read
while a session was tearing down reads as unknown, and a settings reader
can throw for the same reason. Those are answered `expired`, which asks
nothing of the sender and stops nothing, because the same message would
land on a later attempt. Only a policy that refused on its own merits is
final, and only it settles the id.

While the session is shutting down the conversion does not run at all:
the gate already answers every message `expired` then, and `refused`
there would tell a sender this session declines what it sends when it
was only going away.

**The addressee is resolved once, before the gate.** A session answers
to two spellings: the id it was published under, which never changes,
and the id its Config holds now, which `/clear` and a resume swap
underneath it. The record a sender reads follows the latter, so both
arrive in practice.

The host is asked once per arriving message, by the transport, at the
point where it already answers a misaddressed frame — and the name it
gives replaces the sender's spelling on the frame. Everything that
judges the message then reads the addressee off the frame: the gate's
settings lookups, its hold bookkeeping, the queue lookup at the host.
None of them resolves again, so no two of them can disagree about which
session the message is for.

One question is asked later, and has to be: whether the host still holds
the session a _parked_ message names. A message can sit parked for as
long as a person takes to answer, so that is a question about now, not
about the moment it arrived. The gate asks the host's resolver again
there, and that ask is deliberately uncaught — a resolver that throws
mid-teardown leaves the message parked, where on arrival the same throw
means misaddressed. Settling it would tombstone something a reviewer is
about to release, and one re-evaluation would settle every other parked
message with it.

Resolving inside the gate instead, at each place that compares or groups
by addressee, was tried and abandoned: every such place is a chance for
two answers to differ, and the host's answer legitimately changes
between them.

**A message becomes a turn of its own.** It is written to the transcript
first, then queued as a background notification of a new kind, `peer`,
and handled once the session is idle — the same "next turn" a person at
a terminal would get, rather than an interruption of whatever is
running. The message id is the task id, so a message that arrives twice
is recognised rather than handled twice; the session forgets that id
once it is done with the message, because a peer mints ids without limit
and what keeps a message from arriving twice on the wire is the
transport's own record.

A message waiting to be read holds the session: a conditional close that
reads it as idle would discard the queue, and someone else's message —
receipted `delivered` — cannot be worth less than the queued result or
shell line that already refuses such a close.

The sender's name travels with the message, qualified by who the sender
is (`controller:`, `own process:`, `peer:`) and capped like every other
notification label. The surfaces that show a label show it alone, so a
peer that names itself after a grant the user minted would otherwise
read as that grant.

A session that cannot write a message down cannot take one, so the gate
is told to refuse for it rather than the delivery turning the sender
away: with chat recording off, "no room" would be read as "not now" and
retried against a condition that never changes.

**Messages have their own allowance in that queue.** They neither evict
a result nor are evicted by one. A result this session's own work
produced can be produced again; someone else's message cannot, and its
sender was told it arrived. Room is checked before the sender is
answered, counting the messages still being written to the transcript,
so a full allowance turns a sender away with a receipt it can act on.

**The host corrects the receipts of what a session never read.** A
message accepted into a queue was receipted `delivered`. If the session
closes with it unread, that receipt is wrong, and only the host can say
so: its sessions' queues drain independently, so the order messages were
handed over in says nothing about which are still waiting. The transport
keeps settling what never reached a session at all.

Leaving the queue is not the same as being read. The drain takes an
entry off the queue before the turn runs, and a turn can end without
running what it took — cancelled before it started, refused admission,
or stopped at the session's token limit, which discards the parts it was
about to send. Such a message moves to an in-flight list instead and
leaves it once the model has it, or once the history the next turn sends
does; a session hands back both lists, so a message waits in exactly one
place and its sender is told exactly once. An in-flight message counts
against the allowance too, or a session that keeps dropping them would
keep accepting them.

The corrections travel in batches under the transport's concurrent-send
ceiling, and the inbox waits for them: a burst past that ceiling is
refused, and a refused correction is the wrong receipt left standing.

## What this leaves open

Held messages. A session a program drives still cannot present one, so
every message that would have been held is turned away — under
`agents.crossSessionInbound: hold` and under the reasons the unset
default holds for. How a hold
should surface for these sessions — through the ACP client, or the
daemon's own API — is the next piece of work, and the questions that
come with it are tracked as a group.

The duplicate window. The 30-second identical-body check is keyed by the
sender alone, so one body sent to two sessions of one process inside that
window reaches the first and is dropped at the second. Scoping it by
addressee has to move on both sides at once, because a sender predicts
the receiver's answer locally before it spends a connection.

Re-using a message id after a correction. `reportExpired` gives back the
body record the duplicate window keeps, so an honest re-send of what
went unread lands. It cannot take back the gate's `delivered`
tombstone, so a sender that re-uses the same message id after an
`expired` correction is told `delivered` again, about a session that is
no longer there. A re-send with a fresh id is unaffected, which is what
the SDK's endpoint does.
