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

A hold converted this way is not tombstoned. Some of the reasons a
message is held are momentary — an approval mode that could not be read
while a session was still settling reads as unknown — and settling the
id would refuse that one message for good. Only a policy that refused on
its own merits is final.

**The addressee is resolved once, before the gate.** A session answers
to two spellings: the id it was published under, which never changes,
and the id its Config holds now, which `/clear` and a resume swap
underneath it. The record a sender reads follows the latter, so both
arrive in practice.

The host is asked once, by the transport, at the point where it already
answers a misaddressed frame — and the name it gives replaces the
sender's spelling on the frame. Everything after that reads the
addressee off the frame: the gate's settings lookups, its hold
bookkeeping, the queue lookup at the host. None of them asks again, so
no two of them can disagree about which session a message is for.

Resolving inside the gate instead, at each place that compares or groups
by addressee, was tried and abandoned: every such place is a chance for
two answers to differ, and the host's answer legitimately changes
between them.

**A message becomes a turn of its own.** It is written to the transcript
first, then queued as a background notification of a new kind, `peer`,
and handled once the session is idle — the same "next turn" a person at
a terminal would get, rather than an interruption of whatever is
running. The message id is the task id, so a message that arrives twice
is recognised rather than handled twice.

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

## What this leaves open

Held messages. A session a program drives still cannot present one, so
`agents.crossSessionInbound: hold` turns its messages away. How a hold
should surface for these sessions — through the ACP client, or the
daemon's own API — is the next piece of work, and the questions that
come with it are tracked as a group.

The duplicate window. The 30-second identical-body check is keyed by the
sender alone, so one body sent to two sessions of one process inside that
window reaches the first and is dropped at the second. Scoping it by
addressee has to move on both sides at once, because a sender predicts
the receiver's answer locally before it spends a connection.
