# Peer messaging: admission control, and one receipt for a burst

Status: implemented alongside this document. Adds a fourth outcome
(`dropped`) below the inbound gate's accept/hold/refuse, plus the
reporting and sender-side pacing that make it usable.

## Problem

The gate decided _whether_ a message may act. Nothing decided how fast
messages may arrive.

### Everything downstream costs something per message

An accepted message goes to the input queue; a held one goes to the hold
buffer; each one draws a receipt. All three have ceilings, and all three
degrade badly when the ceiling is reached at socket speed rather than at
conversation speed. The hold buffer evicts its oldest entry per arrival,
so a flood walks a user's real backlog out of the buffer one message at a
time, receipting each eviction `expired`. The input queue simply fills.

### A flood starves exactly the receipts that matter

Every terminal outcome sends a receipt, and receipts share one outbound
ceiling (`MAX_CONCURRENT_SENDS`) with everything else the session sends.
Sends over the ceiling are dropped silently. So under a flood, the
receipts most likely to be lost are the ones belonging to the legitimate
messages arriving alongside it — the session gets quieter about the
things its user cares about, precisely when something is going wrong.

The same asymmetry shows in the transcript: a receipt per dropped message
means seventy lines for seventy dropped messages, which is the flood
reproduced inside the user's own scrollback.

### Nothing stopped a loop, and nothing stopped a repeat

Two sessions in the same review class auto-deliver to each other. A model
that answers a peer message with a peer message therefore closes a loop
that nothing bounded. Separately, a model in a retry loop re-sends the
same sentence with a fresh message id each time, which the gate's id
guard cannot see: it compares ids, and every one of them is new.

### A full queue was reported as an expiry

When the input queue could not take an accepted message, the gate
receipted `expired` — a word that means "a decision ran out". No decision
was pending, and the sender could not tell that answer from the one it
gets when the receiving session exits with the message unread.

### The sender learned all this a round trip too late

`sendToPeer` would write anything, any number of times. A model sending
its thirtieth message has already composed its thirty-first by the time
the answer to the first arrives.

## Design

**Meter arrivals before policy.** A token bucket per sender — 30 at once,
then one every two seconds — plus a global bucket of 32, then one a
second. A sender is identified by the reply address it puts on the frame,
which is self-asserted; the global bucket is what makes rotating it
pointless. The global figure is half the session's outbound send ceiling
of 64, because every admitted message draws its own receipt against that
ceiling: sized above it, one burst could occupy every slot, and the sends
it displaced are dropped silently — the starvation this metering exists
to prevent rather than to cause. It sits below both 50-message buffers
downstream, so the meter is what a rotating sender reaches first. Neither is a security boundary. A hostile same-uid process has
better options than flooding a socket; these bound the damage an ordinary
bug does.

**Judge repeats on the body.** The id guard cannot see a retry loop that
mints fresh ids, so the same body from one sender inside 30 seconds is a
drop. Only from another session: a process this session started, and a
controller the user minted a token for, are exempt. A hook that reports
two builds in thirty seconds is reporting two facts, and a user who says
"continue" twice to a voice front-end means it twice. Neither is the
model-driven repetition the check exists to stop, and both are still
metered by the buckets, which apply to every sender alike.

**Charge nothing for a message that was turned away.** The order inside
the meter is global bucket, then the repeat check, then the sender's own
bucket, and a token is taken only when all three pass. A repeat must not
also cost the sender the allowance it needs to say something new.

**Meter before the id lookups, not after.** The settled-id and held-id
lookups each answer with a receipt, so a peer looping on one id would
draw one outbound connection per message through them. The meter sits
above both.

**A drop leaves no trace.** No hold entry, no tombstone, no delivery. A
tombstone exists so a decided id cannot be decided twice; nothing was
decided here, and a sender that waits out its burst and retries should
find the gate it would have found if it had waited in the first place.

**The repeat record is rolled back wherever a message is settled unseen.**
A body is recorded when it is admitted, but admission is not arrival: the
gate can still refuse it, park it into a full buffer, or hand it to a
session that is shutting down. Left in place, the record turns the
sender's honest retry into a `duplicate` — a verdict whose whole premise
is that the content is already at the far side. The rollback restores
what the admission displaced rather than clearing the slot, so the body
admitted _before_ the failed one keeps its own protection, and it leaves
the token spent, which is the only bound on how often a peer can make the
receiver attempt a delivery that cannot land.

**One receipt for a burst.** The first drop from a sender answers
immediately — while the sender can still stop — and the rest are folded
into one receipt every five seconds that names the ids it stands for.
A `dropped` receipt carries `dropReason` (`rate-limited`, `duplicate`,
`queue-full`) and `droppedMsgIds`, so the sender moves every message it
lost to a terminal state from one frame. Receipts are capped globally at
40 a minute and are best-effort throughout: past the cap they are not
sent, because more of them would not help.

**One transcript line per sender per minute**, carrying the count of what
it stands for. A message about a flood must not scale with the flood.

**A full buffer is a drop, not an expiry.** Both of them: the input queue
and, now, the hold buffer. The hold buffer used to evict its oldest entry
to make room, so an arrival could destroy a message the user had not
reviewed yet and its uninvolved sender was told `expired` — a flood
walked the backlog out one message at a time, which is the first thing
the Problem section above names. It now turns the newcomer away with
`queue-full` instead, the same shape the accept path already had: the
cost falls on the sender that could not fit, it is told the truth, and it
can retry. With no eviction left, `expired` means only that a hold ran
out, that the session exited with the message unread, or that it arrived
during shutdown.

**Mirror the receiver's bucket on the sending side.** Each session tracks
what it has sent to each address — and the last body it sent there — with
the same arithmetic the receiver uses, and refuses a send the receiver
would drop, whether for rate or for repetition — so the model is told
to batch _before_ the message is written, and the receiver never spends a
connection on one it was going to turn away. The mirror is keyed by
socket path, which is what the receiver meters by and what changes when a
session restarts. It can only be approximate, since other sessions share
that bucket, so it is never stricter than the real limit and a
`rate-limited` receipt empties it: the receiver is the authority on its
own level. A frame that provably never left refunds its token.

## Trade-offs

**No hop chain.** Cutting a relay loop properly means carrying the path a
message travelled on the frame and knowing, at send time, which inbound
message the current turn is answering. That plumbing does not exist yet.
The buckets bound the loop to one message every two seconds in the
meantime, and an added field would not break any reader, so this stays a
separate change.

**No settings.** A session's protection against a peer that outruns it is
not something the peer's user, or a cloned repository, should be able to
widen. The limits are constants an order of magnitude above what a person
or a well-behaved model reaches.

**The model is not told about drops on the receiving side, and is told
about its own only through the send that fails.** Receipts go to the
user's transcript, as they have since receipts existed; the predictive
refusal is what reaches the model, and it arrives with the advice that
matters — batch, or wait.

**Evicting a sender's meter can forget its last body.** The sender table
is capped at 256 and prefers to evict a meter whose bucket has refilled,
which at worst admits one repeat. A bounded map is worth that; a meter
that is currently holding a flood back is not evicted first.

**Bodies are remembered as digests.** A frame can carry a megabyte, and
keeping the last one per sender would be a quarter of a gigabyte held to
answer "same or not". A digest collision would drop one message as a
repeat, and its sender is told.

## Files

- `packages/core/src/ipc/peer-admission.ts` — the meter and its limits.
- `packages/core/src/ipc/peer-drop-reports.ts` — folding receipts and
  throttling notices.
- `packages/core/src/ipc/inbound-gate.ts` — the `dropped` outcome, and
  the queue-full path.
- `packages/core/src/ipc/peer-frames.ts` — the `dropped` status,
  `dropReason` and `droppedMsgIds`.
- `packages/core/src/ipc/peer-send.ts` — the sender-side mirror and the
  receipt transitions.
- `packages/cli/src/peerMessaging/peer-messaging.ts` — wiring, and
  applying a folded receipt.
- `packages/cli/src/ui/AppContainer.tsx` — the two transcript lines.
