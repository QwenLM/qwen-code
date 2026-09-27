# Cross-Session Protocol

This page is the contract for a program that wants to take part in
cross-session messaging without being a Qwen Code session: a voice
front-end, a relay daemon, a script that watches a build. It describes
what a session writes to the registry, what its inbox reads off a
connection, and what it sends back. Everything here is what the code
does today at schema version 1 and frame version 1; the last section
says what may change and how you will know.

For a Node program, `@qwen-code/sdk/peer` implements the joining side of
this page — the record, the inbox, the auth line, frames and receipts — with
nothing but Node, and its tests run it against Qwen Code's own implementation
in both directions. It applies none of §6 to its own inbox: a program that
needs rate limits, holds or a duplicate window applies them itself. Use it, or
read on to write your own.

Every value that crosses a process boundary is untrusted on arrival and
validated by the reader. Where this page says a field "must" have some
shape, a value that does not is dropped, never rejected with an error.

## 1. The session registry

A running session publishes one record:

```
$QWEN_HOME/sessions/<pid>.json            (directory 0700, file 0600)
$QWEN_HOME/sessions/<pid>-<8 hex>.json    (a process hosting several sessions)
```

`$QWEN_HOME` defaults to `~/.qwen`. The file name is keyed by the
writer's PID — either the bare PID, or the PID, a dash, and eight
lowercase hex characters minted at registration (see "Several records
from one process" below). A record whose `pid` field disagrees with the
PID prefix of its file name — compared in canonical decimal form, so a
zero-padded name agrees with nothing — is ignored.

```json
{
  "schemaVersion": 1,
  "pid": 41337,
  "procStart": "a1b2c3d4-…-boot-uuid:8895124",
  "pidNs": 4026531836,
  "sessionId": "8e016be8-5b48-4c13-ad22-1f5326ae64ac",
  "cwd": "/home/me/project",
  "name": "project-3f",
  "startedAt": 1788959000000,
  "qwenVersion": "0.23.0",
  "kind": "tui",
  "ipcPath": "/run/user/1000/qwen-socks/41337.sock",
  "ipcToken": "c0ffee…64 hex…"
}
```

| Field           | Meaning                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Always `1`. A reader skips a record with a higher version and never deletes it.                                                                                                                                                                                                                       |
| `pid`           | The writer's process id. Must equal the PID the file name is keyed by: the whole name for the bare form, the digits before the `-<8 hex>` suffix for the minted one.                                                                                                                                  |
| `procStart`     | `<boot id>:<process start ticks>` on Linux (`/proc/sys/kernel/random/boot_id` and field 22 of `/proc/<pid>/stat`); `null` elsewhere. Guards against PID reuse, and against records written on another machine that shares this home directory.                                                        |
| `pidNs`         | Inode number of `/proc/self/ns/pid` on Linux; `null` elsewhere. A reader only lists and sweeps records from its own namespace.                                                                                                                                                                        |
| `sessionId`     | The session's id. `/clear` and `/resume` swap it under the same PID, so re-read the record before each send.                                                                                                                                                                                          |
| `cwd`           | Working directory at registration.                                                                                                                                                                                                                                                                    |
| `name`          | Display name. Derived from the cwd basename (Unicode letters, marks, digits, `.`, `_`, `-`; up to 32 code points) plus `-` and the first two hex characters of `sha256(sessionId)`, unless the writer chose one. Not unique.                                                                          |
| `startedAt`     | Epoch milliseconds. Newest first is the listing order and the tie-break between twins.                                                                                                                                                                                                                |
| `qwenVersion`   | Free text or `null`.                                                                                                                                                                                                                                                                                  |
| `kind`          | What registered: `tui` (someone at a terminal), `headless`, `serve`, `external`. Lowercase ASCII, digits and dashes, at most 16 characters; anything else is dropped on read. Absent means a writer older than the field, which reads as `tui`. A label for listings — never a credential; see below. |
| `ipcPath`       | The inbox socket, present only while it is bound. Absent means discoverable but not messageable.                                                                                                                                                                                                      |
| `ipcToken`      | 64 hex characters. What a connection to `ipcPath` presents on its auth line. Absent means the inbox requires none (records from older builds).                                                                                                                                                        |

**A record is a self-report.** Every field in it was written by the
process it describes, so `name`, `cwd` and `kind` are claims, not facts a
reader can lean on. Nothing that decides what a sender may do reads
them — that is settled by what a connection presents (§3) and by the
receiving session's own policy (§6). Set `kind` so a listing can group
sessions honestly; do not expect it to buy you anything.

**Writing your own record.** An external process that wants to be
found — listed by `qwen sessions ps`, addressable from `send_message`,
able to receive receipts — writes the same record for itself: its own
`pid`, `procStart` and `pidNs` computed the same way, a `sessionId` it
mints (any UUID), `kind: "external"`, a `name` (yours, or derived the
same way; it is flattened to one line and bounded when displayed), and
`ipcPath` + `ipcToken` for an inbox it binds itself (§2). On Linux,
`pidNs` is required: every reader compares it with its own, so a record
without one is never listed — and never swept. `procStart` is required too,
for a different reason: without it a reader falls back to plain PID liveness
and cannot tell a recycled PID from the process that wrote the record. Write
to a temp file in the same directory and `rename` over the target; create
the file 0600; refuse to write through a symlink. If `<pid>.json` already
holds something you cannot prove was left by an earlier process with your
PID — same `pidNs`, same boot id, different start ticks — write
`<pid>-<8 hex>.json` instead of replacing it: readers accept both names,
and the record there may belong to a live process in another namespace or
on another machine. Remove the record on exit. A record whose process is
gone is swept by the next session that lists, but only when `procStart`
proves the PID is not merely reused. `PeerEndpoint.start()` in
`@qwen-code/sdk/peer` does all of this, and removes the record again on
`close()`.

**Reading.** Anything that can read the directory can read every record,
including tokens: being able to discover a session and being able to
authenticate to it are one capability by design. Do not print
`ipcToken` anywhere a model or a log can see it.

**Liveness.** A record is live when all of these hold: the file name is
`<pid>.json` or `<pid>-<8 hex>.json` and its PID prefix equals `pid`;
`pidNs` equals the reader's; the boot id inside
`procStart` equals the reader's (or `procStart` is `null`); and the PID
is alive with the same start ticks. A live record with an `ipcPath`
still has to be dialed before it is advertised as reachable — a socket
file outlives a crash.

**Refs.** Displayed handles use `ref = sha256(sessionId)[0:6]`. Two
sessions may share a `name`; the address grammar a sender types is
`name`, `name [ref]`, `[ref]` or the bare `ref`, and an ambiguous
`name` is an error rather than a guess.

**Several records from one process.** Any `qwen --acp` child — spawned
by the daemon, or driven directly by an editor or another client —
writes one record per session, named `<pid>-<8 hex>.json`, from its
first session on. The suffix is minted at
registration and never changes; a session id swapped underneath is a
patch to the record, not a rename of it. Every one of them carries the
same `ipcPath`, because the process binds one inbox for all its sessions
and tells them apart by the `toSessionId` on each frame — so **always
send `toSessionId`**: a frame without one that reaches such a process is
answered `misaddressed`, since there is no single session it could have
meant. Liveness, sweeping and the namespace and boot guards read the
record exactly as they do for the bare name; only the PID/filename
agreement check differs, and only in comparing `pid` against the digits
before the suffix rather than the whole name.

## 2. The inbox socket

One UNIX domain socket per session, at the first of these that binds:

1. `$XDG_RUNTIME_DIR/qwen-socks/<pid>.sock`
2. `$TMPDIR/qwen-socks-<16 hex>/<pid>.sock`
3. `/tmp/qwen-socks-<16 hex>/<pid>.sock`

The directory is 0700 and the socket 0600. A path longer than 103 bytes
is skipped. When the PID-keyed name is already held by a live listener
(two PID namespaces sharing a runtime directory), the session binds
`<pid>-<8 hex>.sock` next to it instead. Peers never derive a socket
path; they read `ipcPath` from the record.

A connection carries newline-delimited JSON, one object per line, UTF-8.
A single line longer than 1 MiB (measured in UTF-16 code units) drops
the connection. A connection that goes 30 seconds without completing a
line that parses is dropped; junk lines do not extend the deadline. The
listener accepts at most 64 connections at once.

The expected exchange is one message per connection: connect, write the
auth line and the frame in one write, half-close, wait for the peer to
close. The receiver never writes on the same connection; anything it
has to say comes back as a separate connection to your own `ipcPath`.

## 3. The auth line

When the target record has an `ipcToken`, the first line must be:

```json
{ "msgV": 1, "type": "auth", "token": "<token>" }
```

Three kinds of token are accepted, and the inbox remembers which one it
saw:

| Presented                                                                     | The inbox concludes            | Effect                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| The `ipcToken` from the target's registry record                              | an ordinary peer               | subject to policy and mode parity (§6)                                           |
| `QWEN_CODE_MESSAGING_TOKEN` from the target's own environment                 | a process that session started | delivered under the parity default; `origin="own-process"`                       |
| A controller token `qpc_<64 hex>` minted with `qwen sessions controllers add` | a program the user trusts      | delivered under the parity default; `origin="controller"` with the grant's label |

A first line that is not an auth line, or that presents a token matching
none of the three, drops the connection silently. When the record has no
`ipcToken`, do not send an auth line; an older inbox reads it as an
unknown frame type and skips it, so leading with one is always safe.

Nothing here authenticates the _sender_: a token proves the connection is
allowed, not who opened it. `from`, `fromName`, `fromMode` and every
field of the record are claims.

This is also the whole of the trust model. A program the user wants
driving their sessions gets a controller token, minted by hand and given
to that one program; it is what makes the difference between a message
that is delivered and one that waits for review. Writing
`kind: "external"` or a familiar-looking `name` buys nothing.

## 4. The user frame

```json
{
  "msgV": 1,
  "msgId": "5f1d0c9e-3b2a-4e8f-9c7d-1a2b3c4d5e6f",
  "type": "user",
  "from": "/run/user/1000/qwen-socks/40011.sock",
  "replyToken": "<my own ipcToken>",
  "fromName": "project-3f",
  "fromMode": "prompting",
  "toSessionId": "8e016be8-…",
  "priority": "next",
  "message": { "role": "user", "content": "build finished, 0 failures" }
}
```

| Field         | Rule                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msgV`        | Number. Must be ≤ 1; higher is dropped.                                                                                                                                                                                       |
| `msgId`       | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, and must not canonicalize (dashes stripped, lower-cased) to `all`. Use a fresh UUID per message: the receiver remembers ids it has settled and repeats the old verdict for a re-sent one. |
| `type`        | `"user"`.                                                                                                                                                                                                                     |
| `from`        | Your `ipcPath`, if you have one. Where receipts go. Absent means no receipts.                                                                                                                                                 |
| `replyToken`  | Your `ipcToken`, so the receiver can authenticate its receipts to you.                                                                                                                                                        |
| `fromName`    | Display name; flattened to one line, at most 200 characters.                                                                                                                                                                  |
| `fromMode`    | `"prompting"` (a person reviews each action) or `"bypass"` (some actions apply without review). Absent means "asserts nothing", which is held for review (§6).                                                                |
| `toSessionId` | The `sessionId` you read from the record. A receiver holding a different id answers `misaddressed`. Always send it.                                                                                                           |
| `priority`    | `"now"` or `"next"`; anything else reads as `"next"`. Carried for a future interrupt path; today the receiver queues both for the next turn.                                                                                  |
| `message`     | `role` must be `"user"`; `content` a non-empty string.                                                                                                                                                                        |

Unknown fields are ignored.

## 5. The delivery-status frame

The receiver reports what became of a message with one control frame per
outcome, sent to the message's `from` and authenticated with its
`replyToken`:

```json
{
  "msgV": 1,
  "msgId": "<fresh id>",
  "type": "control",
  "action": "delivery_status",
  "status": "held",
  "origMsgId": "5f1d0c9e-…",
  "from": "/run/user/1000/qwen-socks/41337.sock",
  "reason": "Your message is held for the recipient user to review …"
}
```

| `status`       | When                                                                                                                                                      | What to do                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `held`         | Parked for the user to review. Repeated on a retry, and on a release that could not be queued.                                                            | Wait; a decision or an expiry follows.                                             |
| `delivered`    | Queued for the model.                                                                                                                                     | Nothing. Not proof it was read.                                                    |
| `denied`       | A person reviewed it and said no.                                                                                                                         | Do not re-send.                                                                    |
| `refused`      | The session's policy turns peer messages away; nobody saw it. Only ever the first receipt.                                                                | Stop; reach that user another way.                                                 |
| `expired`      | A held message ran out its wait, the session exited with it unread, or it arrived while that session was shutting down. Can follow `held` or `delivered`. | Re-send later if it still matters.                                                 |
| `misaddressed` | `toSessionId` does not match the session at that address.                                                                                                 | Re-read the registry.                                                              |
| `dropped`      | The inbox turned it away before any policy ran (§6).                                                                                                      | Treat as unsent. Do not retry in a loop; fold what matters into one later message. |

A `dropped` receipt carries two more fields. `dropReason` is
`rate-limited`, `duplicate` or `queue-full`. `droppedMsgIds` lists up to
256 further ids the same receipt settles: a burst is answered with one
receipt rather than one each, so a sender moves every message it lost to
a terminal state from a single frame. Both are meaningless on any other
status and are ignored there.

`reason` is free text for a human. Order of receipts is not guaranteed
across connections; apply them as state transitions:

```
pending   → held | delivered | denied | refused | expired | misaddressed | dropped
held      → delivered | denied | expired | misaddressed
delivered → expired | misaddressed
```

Anything else is a repeat and should be ignored. A receipt for an id you
never sent is noise; ignore it. Receipts are best-effort on the
receiver's side: a full outbound limit or a dead `from` loses them
silently, so a sender must tolerate never hearing back.

Your own inbox receives these frames from the sessions you messaged. If
you only ever send, bind an inbox and give `from` anyway: without one you
are blind to every outcome above.

## 6. What the receiver does with a message

In order:

1. **Admission.** Per sender: a burst of 30, then one message every two seconds. All senders together: a burst of 32, then one a second — a sender names itself on the frame, so rotating that name buys a fresh allowance from the first limit but not the second. The same body from another session inside 30 seconds is a `duplicate`; a process the session started and a trusted controller are exempt from that check, and rate-limited like everyone else. A dropped message is never held, never delivered, and leaves no record, so a sender that waits out its burst and retries still lands.
2. **Settled ids.** A `msgId` the gate already decided repeats its earlier verdict.
3. **Policy.** `agents.crossSessionInbound` set to `accept`, `hold` or `refuse` wins. Unset: a process the session started or a trusted controller is accepted; otherwise a message is accepted only when `fromMode` names the same review class the receiver is in, and held in every other case, including when `fromMode` is absent.
4. **Hold.** Up to 50 messages wait. A message arriving at a full buffer is `dropped` with `queue-full` rather than evicting one already parked. A held message expires after `agents.crossSessionHeldExpiry` (`1m`, `5m`, `10m`, `never`; default `5m`). The user releases or denies from `/peers`; a mode change re-evaluates the backlog.
5. **Queue.** An accepted message joins the session's input queue, which holds at most 50 from peers. A full queue is `dropped` with `queue-full` too.

A sender does not have to discover the limits the hard way: a Qwen Code
session mirrors them per address and refuses its own send before writing
it, telling its model to batch instead.

The model sees a delivered message as:

```
<cross_session_message from="/run/user/1000/qwen-socks/40011.sock" name="project-3f">
build finished, 0 failures
</cross_session_message>
```

followed by a notice stating the sender's authority. `origin="own-process"`
or `origin="controller" controller="<label>"` is added by the receiver
from what the connection presented, never from the frame; a controller's
label comes from the grant the user minted, not from `fromName`. Tags
that look like the envelope are defanged inside `content`.

## 7. Compatibility

- A reader ignores fields it does not know. Adding a field to a record or
  a frame is not a breaking change.
- `schemaVersion` and `msgV` are bumped only for a change to the shape of
  existing fields. A reader drops a frame or skips a record with a
  version above what it knows, and never deletes such a record.
- New `status` values may appear; treat an unknown one as "no transition"
  and keep waiting. The same goes for a `kind` you do not recognize:
  show it, do not correct it.
- Constants that may change without notice: the burst and rate figures,
  the hold ceiling and expiry choices, the 1 MiB line cap, the 30-second
  line deadline, the 64-connection cap.

## 8. Not settled yet

- **Name yielding.** Two sessions in one directory can register the same
  `name`; today they are told apart only by `ref`. A registration that
  yields to a live name, and a control frame that tells peers a session
  renamed itself, are both still to come.
- **Same-name reporting.** `qwen sessions ps` and `list_agents` do not
  flag records that still collide.
- **Inbound messages to ACP-driven sessions.** A session a program
  drives over ACP — daemon-spawned or not — registers and can send, but
  answers `refused` to anything sent to it: a hold is a question put to
  a person, and nobody is watching a hold list on its behalf. Where a
  held message should surface for those sessions — its client, or the
  daemon's own API — is still open.
- **Sessions behind one inbox are one sender to every peer.** A process
  hosting several sessions sends with one `from` address, so a
  receiver's per-sender budget and duplicate window (§6) are shared by
  all of that process's sessions at once: a busy sibling can spend
  another's allowance, and a body just sent to one cannot be repeated
  to its sibling inside the window. Per-session accounting would have
  to trust a frame-asserted field, which §3's trust model rules out.
