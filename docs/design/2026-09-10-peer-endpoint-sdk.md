# A peer endpoint for programs outside Qwen Code

[English](2026-09-10-peer-endpoint-sdk.md) | [简体中文](2026-09-10-peer-endpoint-sdk.zh-CN.md)

Status: implemented alongside this document. Adds `@qwen-code/sdk/peer`, a
standalone implementation of the cross-session protocol for a program that
is not a Qwen Code session.

## Problem

[Cross-Session Protocol](../users/features/cross-session-protocol.md)
describes everything a program outside Qwen Code must do to be found,
reached and answered: write a registry record, bind an inbox, present the
right token, frame its messages, and read receipts as state transitions.
Two things were missing.

### Nobody had implemented the page

Every reader and writer of the protocol was Qwen Code itself, and the page
was written from that code. Nothing showed the page was complete or
unambiguous. A rule that lived only in the code — how a record's file name
must agree with its PID, which token a receipt presents, when an inbox takes
a sibling socket name — could be missing from the page, and nothing would
notice until an outside program failed against a live session.

### Every consumer would write the protocol by hand

The first outside consumer, a voice front-end that directs a user's sessions
(#10118), needs exactly this: appear in the directory, send instructions as a
trusted controller, and hear back. Without a library it would reimplement
start tokens read from `/proc`, atomic record writes, socket placement, the
auth line, the message id grammar and the receipt state machine in its own
repository — each one a chance to disagree with the sessions it talks to.

## Design

**A second implementation, not a wrapper.** The module is written from the
protocol page using Node's own modules alone. Qwen Code's core is not a
runtime dependency of the SDK, and a wrapper around it would not have tested
the page anyway. The build refuses a bundle that contains any runtime
dependency or Qwen Code source.

**Tested against Qwen Code, in both directions.** A conformance suite runs
the endpoint against Qwen Code's own registry, inbox, directory and send path
in one process. Each lists and reaches the other; frames sent each way are
parsed and answered; a folded drop receipt settles a burst; a controller
token minted the way a user mints one is recognised, and a forged one is not.
The same suite feeds hostile lines, record files and names to both
implementations and requires the same verdicts, and pins every limit the
page publishes to Qwen Code's constants. A disagreement there means one of
the implementations, or the page, is wrong.

**Its own subpath, Node only.** `@qwen-code/sdk/peer` is a separate entry,
like the transports entry. The default and daemon entries are bundled for
browsers and must stay free of Node built-ins; this module needs sockets and
the filesystem.

**The shared record name when it is free.** An endpoint publishes
`<pid>.json`, the name every Qwen Code build with a registry can read. When
that name is held — by another endpoint in the same process, by a record from
another namespace or machine that collides on the PID, by a newer schema — it
publishes a minted `<pid>-<8 hex>.json` rather than overwrite something that
may be live. Only a record provably left by an earlier process with the same
PID is replaced.

**It finds, receives, sends and tracks — nothing more.** The inbox accepts
exactly one token, the endpoint's own. It keeps none of the review machinery
a Qwen Code session keeps for itself: no rate limits, no holds, no controller
grants. A program that joins the directory decides for itself what to do
with a message. It does remember the ids it has answered, so a sender that
retries an id gets the same answer instead of the program handling the
message twice.

**It never deletes what others wrote.** Listing reads the directory and
applies the page's liveness rules, but never removes a record or a socket
file. Clearing out dead sessions is left to Qwen Code sessions; a program
that merely joined has no business removing other processes' files.

**Trust comes only from a controller token.** A program has no review class
it can honestly assert, so what it sends is held for review by default. The
user grants delivery by minting a controller token, which the endpoint
presents in place of the recipient's own token. The record's `kind` and
`name` buy nothing, and the documentation says so.

**Its lifetime follows the program.** The open inbox keeps the process
running, as a server would. Closing removes the record and the socket, and an
exit hook does the same on `process.exit`. The endpoint installs no signal
handlers, which would change how the program exits; a process killed without
closing leaves a record that Qwen Code sessions clear once its start token
proves the process gone.

**On Linux, no record without its identity.** When the start token or the
PID namespace cannot be read, `start()` fails instead of publishing a record
that readers could neither trust nor ever clear away.

## Changes to the protocol page

Implementing the page from its text found two rules it left implicit. Both
are now stated in "Writing your own record":

- On Linux, `procStart` and `pidNs` are required. Every reader compares a
  record's `pidNs` with its own, so a record without one is never listed and
  never swept.
- When `<pid>.json` is already taken, a writer replaces it only when it can
  prove the file was left by an earlier process with the same PID — same
  `pidNs`, same boot id, different start ticks — and otherwise writes
  `<pid>-<8 hex>.json`. Readers accept both names, and the record in the way
  may belong to a live process in another namespace or on another machine.

The conformance suite found no disagreement between the page, Qwen Code and
the endpoint on anything else it covers.

## What it does not do

- Several endpoints behind one inbox. Two endpoints in one process each bind
  their own socket and publish their own record.
- Windows: there is no socket placement for it yet, so `start()` fails with
  `unsupported-platform`.
- Protection on the program's own inbox, such as rate limits or holds.
- Equivalents in the Python and Java SDKs.

## Verification

- Unit suites for frames, labels, registry reads and writes, the directory,
  the client, the inbox and the endpoint.
- The conformance suite described above.
- A public-surface test that pins the subpath's exports and its
  `package.json` entry.
- The build checks that the bundle stays within its budget and contains no
  runtime dependency, and that its declarations reference no internal
  package.

## Follow-ups

- Turn `agents.crossSessionMessaging` on by default, so a user's sessions
  can be reached without a settings change.
- Inbound delivery to sessions a program drives over ACP.
- Windows named pipes, for Qwen Code sessions and this endpoint alike.
