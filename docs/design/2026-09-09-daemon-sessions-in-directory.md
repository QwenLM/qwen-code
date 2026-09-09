# Daemon-managed sessions in the session registry

Status: implemented alongside this document. Lets a session `qwen serve`
drives be discovered and addressed like any other, and lets it send.

## Problem

Only the interactive UI registered. A session the daemon drives was
invisible to `qwen sessions ps`, absent from every peer's `list_agents`,
and unable to send: `sendToPeer` reads this process's own registry record
to learn its reply address, and with no record it reported the feature
disabled. A user with a terminal open and a daemon session working in the
same repository could not have the two speak to each other at all.

Three things stood in the way.

### One process, several sessions — one record

The registry is keyed by PID, one `<pid>.json` per process. That was
exactly right while a process meant a session. The `qwen --acp` child the
daemon spawns hosts up to 32 sessions at once, each with its own id, name
and working directory, and one record cannot describe them.

### The reply address had stopped meaning "the same session"

Both the send path and `list_agents` excluded "this session" from the
peers they consider by matching either the session id **or** the reply
address. The address was a proxy for the id, and a correct one while a
process held one session and bound one socket. Sessions in one process
share an inbox, so the proxy stopped holding: every sibling of the
sending session would have been filtered out as if it were the sender
itself, leaving sessions in one process unable to see each other.

### An unpinned frame had no single answer

A frame that names no `toSessionId` used to be deliverable: with one
session, it could only have meant that one. Reaching a process with
several, it names nothing at all.

## Design

**One record per session, in a minted slot.** A process hosting several
sessions writes `<pid>-<8 hex>.json` per session. The suffix is minted at
registration and never moves. It is deliberately not derived from the
session id: an id can be swapped underneath a live session (`/clear`, a
session load), and a record that renamed itself would strand every reader
holding the old name — the record is patched in place instead, which is
what the registry already did for every other mid-session change.

Everything else about a record is unchanged, and that is the point: the
PID in front of the suffix is what the liveness check, the sweep and the
namespace guards read, so a minted record is reaped exactly like a shared
one, and a reader too old to know the new name simply does not see it
(its filename pattern does not match) rather than mistaking it for
litter to delete.

Which record a caller means is a `slot`, threaded through `patch`,
`unregister` and the own-record read. `Config` learns its slot from the
registration itself and passes it to every write it queues, so a
session's `/clear`, its `/cd` and its exit each touch its own record and
no sibling's.

**One inbox, sessions told apart by the frame.** The process binds one
socket and writes that address into every record it owns. A sender picks
a session by the `toSessionId` it already pins on every frame; a frame
naming a session this process does not hold, or naming none, is answered
`misaddressed`. Binding a socket per session would multiply file
descriptors by the session count and buy nothing, since the frame
already carries the discriminator.

**Exclude self by session id alone.** The address is no longer evidence
of identity, so it is out of the test. A twin — the same session id under
a second process, which `qwen --resume` creates — is still excluded,
because that is what the id catches.

**Inbound is refused, not held.** A hold is a question put to a person,
and nobody is watching a held-message list on a daemon-managed session's
behalf: holding would leave every sender waiting out a five-minute expiry
to learn nothing. `refused` says so immediately. Where a held message
_should_ surface for these sessions — the ACP client, the daemon's own
API — is a real question, and answering it is separate work.

**Register only when messaging is on.** The interactive UI registers
unconditionally, because its record also answers "what is running right
now". A daemon-managed session's record exists to be addressed; with
messaging off, registering one would put a name in every peer's listing
that can be addressed and never answered.

**Bind on the first session, close on every exit.** The inbox is bound by
the first session that needs one — an ACP process with no session has
nothing to advertise — and the transport is imported at that moment
rather than at startup, so a process that never messages a peer never
loads it. Closing is registered as exit cleanup and also runs from the
two teardown methods, because a bare signal reaches neither.

**The process's own settings, captured once.** `this.settings` on the
agent is re-pointed at whichever session is being handled. Whether to
bind an inbox is a question about the process, so it is answered from the
settings the process started with, captured at construction.

## Trade-offs

**A record outlives a process that is killed outright.** The next listing
sweeps it, which is the same guarantee every other session has had; a
graceful shutdown removes it immediately.

**`qwen -p` still does not register.** A one-shot run measured in seconds
would mostly contribute stale records.

**Outbound only.** A hosted session can send and receives its own
receipts; what it cannot do is take a message in. That is the next step,
and the protocol page says so rather than leaving a reader to discover it.

**`kind` is still a self-report.** `serve` comes from the environment
marker the daemon sets on its children, which a process could set for
itself. It labels a listing; nothing reads it to decide anything.

## Files

- `packages/core/src/services/session-registry.ts` — slots, the minted
  filename, and the per-slot path capture.
- `packages/core/src/config/config.ts` — remembering a session's slot and
  passing it to every registry write.
- `packages/core/src/ipc/peer-send.ts` — reading the sending session's
  own record, and excluding self by id.
- `packages/core/src/tools/list-agents.ts`, `send-message.ts` — passing
  the slot through.
- `packages/core/src/ipc/inbound-gate.ts`,
  `packages/cli/src/peerMessaging/peer-messaging.ts` — `ownsSessionId`
  for a process hosting several sessions.
- `packages/cli/src/acp-integration/acpAgent.ts` — binding the inbox,
  registering and removing each hosted session's record.
