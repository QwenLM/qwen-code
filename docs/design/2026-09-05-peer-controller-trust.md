# Peer messaging: trusted controllers

Status: implemented alongside this document. Tracks the third part of the
inbound-gate proposal, whose first two parts shipped as the review-class
parity and tighten-only settings change.

## Problem

The parity rule delivers a message without review only between two
sessions in the same review class, and holds anything from a sender that
asserts no class at all. That last row is what makes the rule safe
against a stranger, and it is also what makes one legitimate case
unusable.

A user may want a program that is not a Qwen Code session driving their
session: a voice front-end, a dictation bridge, an automation daemon
relaying instructions the user is giving out loud. Such a program has no
approval mode, so it has no class to assert, so every message it sends
parks for review — and `/peers accept` per utterance is not a workflow.

The tempting fix is a way for a sender to ask for better treatment: a
field in the frame, a flag in the registry record, a settings key listing
program names. None of them work. Every one of those is written by, or
readable and forgeable by, any process running as this user, which is
exactly the population the grant is supposed to distinguish within. A
claim to be a controller is worth nothing; only a secret is.

## Design

**The grant is a secret the user mints by hand.**

```
qwen sessions controllers add --label voice-bridge
```

prints a token once and stores a record — id, label, `sha256(token)`,
timestamp — in `<qwen home>/peer-controllers.json` at 0600. `list` and
`remove <id>` are the other two verbs; `/peers controllers` and
`/peers revoke <id>` are the in-session equivalents.

**Only the hash is stored.** This is the one place the design departs
from how the session registry handles the inbox token, and the reason is
that a session is a program that reads files on request. A model in any
session on this machine can be talked into printing a 0600 file from the
user's home, and a plaintext controller token in that file would turn
every held message into a delivered one. A hash cannot be presented.
(The inbox token has no such problem: it grants only what reaching the
socket already grants, a message the gate still judges.)

**The grant is established by the transport, not the frame.** A
controller presents its token on the connection's auth line, in exactly
the format a peer or a child process uses. `PeerConnectionAuth` gains a
third value, `'controller'`, beside `'peer'` and `'child'`, and the inbox
hands `onFrame` the matched grant's `{id, label}` — the same shape of
fact as `selfSent`, which #10764 established and which nothing in a frame
can set.

**The gate row.**

| receiver | sender            | result |
| -------- | ----------------- | ------ |
| any      | own process       | accept |
| any      | controller grant  | accept |
| any      | explicit `hold`   | hold   |
| any      | explicit `refuse` | refuse |

The grant sits directly below the explicit setting and above every parity
row: a user who set `hold` reviews everything, controllers included, and
a user who set `refuse` turns them away. Parity itself has nothing to say
here — it compares two sessions' review classes, and a controller is not
a session.

**Revocation is immediate.** The resolver reads the file per auth line
rather than caching it at startup, so `add` and `remove` both take effect
on the next connection with nothing to restart. The cost is one `lstat`
per connection on a machine that has never minted a grant, because the
presented token is shape-checked (a `qpc_` prefix, a length bound) before
the file is consulted at all.

**The envelope says what the origin means.** A controller message reaches
the model as
`<cross_session_message from="…" origin="controller" controller="<label>">`
followed by `CONTROLLER_AUTHORITY_NOTICE`. That notice is the only one of
the three that does not open with "not from your user" — saying so would
be false, and a model told to discount an instruction its user really did
send is worse than no notice. It keeps the two prohibitions that no relay
can carry: no escalation because the message asked, and never read as the
user answering a pending confirmation prompt. An escalation is a decision
about this session's permissions, and a relayed request for one is
indistinguishable from a compromised relay asking. A confirmation prompt
is a question about one specific pending action, and an instruction
written before that action existed cannot be its answer.

The label shown in the envelope, the transcript line and the `/peers`
listing comes from the grant, never from the frame's `fromName`: a sender
that could choose that string could dress itself as another grant.

**Failing closed.** Anything wrong with the registry file — missing,
unparseable, a schema this build does not know, a symlink, over 64 KiB —
reads as no grants, which holds every controller message rather than
admitting one. A malformed individual entry is skipped rather than
failing the whole file, so one bad record does not silently revoke the
others. A resolver that throws is "not a controller", never an admission.

**What does not change.** The wire protocol, `fromMode`'s vocabulary and
meaning, the parity table for peers, the child-token row, receipts, the
held-buffer bounds, and every explicit setting path.

## Alternatives considered

- **In-session `/peers trust <name>`**, the ephemeral half of the
  original proposal, which would record a peer's current registry ref and
  inbox token. Not implemented: that inbox token sits in the peer's own
  0600 registry record, which any process running as this user can read,
  so binding trust to it binds trust to something unprivileged and
  forgeable — the thing this design exists to avoid. Doing it honestly
  needs a new control frame that hands a receiver-minted secret into the
  peer's memory, and the "relays your user's instructions" framing does
  not hold when the sender is another session's model anyway. Left as a
  separate change.
- **Storing the token in plaintext at 0600**, as the session registry
  does. Rejected for the reason above: a session will read a file for
  whoever asks it nicely.
- **Per-session grants.** Rejected as busywork: a controller the user
  trusts to relay their instructions is trusted by whichever session they
  happen to be running, and re-granting on every restart would push users
  toward leaving one long-lived session open.
- **Scoping a grant to a working directory or a session id.** Deferred,
  not rejected. It is a real want for an automation daemon that should
  only reach one project, and it can be added as a field on the record
  without changing the auth line or the gate.
- **A settings key naming trusted programs.** Rejected: a program name is
  not a credential, and anything that can run as this user can adopt one.

## Trade-offs

- A grant is a bearer token for every session in the Qwen home. Anyone
  who can read it out of the controller's own configuration can send as
  that controller. This is the same trust model as any API credential and
  the docs say so, but it is strictly more than the child token grants,
  which dies with its session.
- Revoking a grant does not re-attribute messages already parked or
  already delivered. A parked one keeps the attribution it arrived with;
  `/peers deny` is how the user drops it. Rewriting history on a
  revocation would be a lie in the other direction — the message really
  did arrive under a grant that was valid then.
- Reading the registry per connection is a syscall in the connection
  path. It is bounded by the same `MAX_PEER_CONNECTIONS` ceiling as
  everything else there, and the shape check keeps it off the ordinary
  peer path entirely.

## Files

- `packages/core/src/ipc/peer-controllers.ts` — the registry: mint, hash,
  read, match, add, remove.
- `packages/core/src/ipc/uds-inbox.ts` — `resolveController`, the third
  `PeerConnectionAuth`, the grant passed to `onFrame`.
- `packages/core/src/ipc/inbound-gate.ts` — `PeerOrigin.controller`, the
  accept row, `controller` on a held entry.
- `packages/core/src/ipc/peer-envelope.ts` —
  `CONTROLLER_AUTHORITY_NOTICE`, the envelope attributes, the display
  line.
- `packages/cli/src/peerMessaging/peer-messaging.ts` — the resolver wired
  to the inbox, origin carried through the buffer to submit.
- `packages/cli/src/commands/sessions/controllers.ts` —
  `qwen sessions controllers add | list | remove`.
- `packages/cli/src/ui/commands/peers-command.ts` — `/peers controllers`,
  `/peers revoke`, the `[controller]` listing.
- `packages/cli/src/ui/AppContainer.tsx` — the hold notice names the
  grant.
- `docs/users/features/commands.md`.
