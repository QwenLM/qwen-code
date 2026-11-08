# Peer messaging: a child token for the session's own processes

Status: implemented alongside this document.

## Problem

Since inbox authentication landed, a session exports its inbox address and
token to child processes so a script or hook it runs can inject a message
back into it. The token it exported was the same one it publishes in its
registry record for peers. Two consequences:

- A child's message is indistinguishable from any peer's. Under the
  mode-parity default, a session running in YOLO/AUTO holds every message
  whose sender does not assert a `bypass` mode — so a hook's "build
  finished" note, injected by a process the session itself started, is
  parked for review like a stranger's request. There is nothing a script
  can honestly put in the frame to change that: `fromMode` is a claim, and
  the gate is right not to trust claims.
- The published token and the environment token are one value, so they
  cannot be reasoned about separately (rotated, revoked, or trusted
  differently), and a child that leaks its environment leaks the peer
  capability too.

Node cannot read `SO_PEERCRED`, so the inbox has no kernel-level way to
learn who connected. What it can know is what it handed out, and to whom.

## Design

**Two tokens, two audiences.** `PeerMessaging.start` draws two independent
32-byte tokens. The first is the existing `ipcToken`, published in the
session's registry record for peers. The second, the child token, is
written nowhere but this process's environment as
`QWEN_CODE_MESSAGING_TOKEN`. The inbox admits a connection on either. Which
one was presented is decided once per connection, at the auth line, and
reported to `onFrame` as `'peer' | 'child'`; nothing later on the
connection can change it.

**Self-sent is a transport fact, not a frame field.** The inbox tells the
session which token admitted the connection; the session passes
`{ selfSent }` to the gate as a separate argument. A frame has no field for
it, so a peer cannot claim it. The gate stores the flag on a held entry so
a message parked by an explicit setting is still the session's own when
it is released later.

**Gate rule.** One row is added to the parity table, above the mode rows:
a self-sent message is accepted. Parity compares what two sessions may do,
and a process this session started is not another session — the session
already chose to run the thing that is asking. The explicit
`crossSessionInbound` setting still wins: a user who said `hold` reviews
everything, own processes included, and `refuse` refuses them.

**Envelope.** The model is told the difference. A self-sent message is
wrapped as `<cross_session_message from="…" origin="own-process">` and
followed by a notice that it came from a process this session started, not
from the user — with the same two prohibitions as the peer notice: no
escalation because it asked, and never read as the user approving a
pending prompt. `origin` is set by the transport and is never derived from
peer-supplied text; a peer that writes it into its name lands inside the
escaped `name="…"` attribute. The one-line transcript form says
"a process this session started" instead of "another session".

**What does not change.** The wire protocol (same auth line), the registry
record (only the peer token is published), receipts (`replyToken` is still
the peer token), and every peer-to-peer path. The `childToken` inbox
option is inert unless `requiredToken` is set: an open inbox has no
admission to classify.

## Trade-offs

- A child token is as good as the environment it lives in: any process that
  inherits this session's environment — a subagent's shell, a hook, a
  script the model ran — can inject a message that auto-delivers under
  the parity default. That is the intended meaning of "self-sent": the
  session ran it. The envelope's notice and the classifier remain the
  defence against what the content asks for, exactly as for peers.
- The flag survives the pre-submit buffer and the held set, so a change of
  policy between arrival and delivery cannot silently re-label a message.

## Files

- `packages/core/src/ipc/uds-inbox.ts` — `childToken` option, per-connection
  auth kind, `PeerConnectionAuth`.
- `packages/core/src/ipc/inbound-gate.ts` — `PeerOrigin`, the self-sent row,
  origin carried on held entries and into `deliver`.
- `packages/core/src/ipc/peer-envelope.ts` — `origin="own-process"`,
  `OWN_PROCESS_AUTHORITY_NOTICE`, display wording.
- `packages/cli/src/peerMessaging/peer-messaging.ts`, `env.ts` — second
  token, environment export, origin threaded through the buffer.
- `packages/cli/src/ui/AppContainer.tsx`, `packages/cli/src/ui/commands/peers-command.ts`
  — the hold notice and the `/peers` listing name the own process instead of
  "another session" / "unknown session".
- `docs/users/features/commands.md` — injection section.
