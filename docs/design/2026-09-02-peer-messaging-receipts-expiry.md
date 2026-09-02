# Telling a sender what actually happened

Date: 2026-09-02
Scope: `packages/core/src/ipc` (delivery statuses, inbound gate), the
`agents.crossSessionHeldExpiry` setting, and the `/peers` listing.

## Problem

A `send_message` call returns as soon as the frame is handed over; what
became of it arrives later as a receipt. Two of those receipts were wrong
or missing:

1. **A refusal reported itself as a decision.** A session whose
   `agents.crossSessionInbound` is `refuse` turns every peer message away
   at admission — nobody sees it. The sender was told `denied`, which
   means "a person reviewed this and said no". The sending model cannot
   tell those apart, and they call for opposite behaviour: a decision is
   worth raising with that person, a policy refusal means stop.
2. **A hold had no end.** A held message waited for a review that might
   never come — the user may not be at that terminal — and the sender had
   no way to distinguish "still waiting" from "never coming". The only
   thing that ever settled a hold was the session exiting, which sent
   `expired` at shutdown.

Both leave the sending session's model reasoning about a message it can
no longer learn anything about.

## Design

**A `refused` status.** Added to `PeerDeliveryStatus`, emitted by the gate
where the policy refuses, and accepted by the frame parser so it survives
the wire. Its description tells the sender not to re-send and to reach
that user another way. `denied` keeps its meaning: a person decided.

The distinction is drawn at the point of admission, which is the only
place it exists. A message that was *already parked* when the user
switches the setting to `refuse` is settled as `denied` — someone chose,
just after the fact — and the receipt state machine reflects that:
`refused` is reachable only from `pending`, never from `held`.

**A bounded hold.** `agents.crossSessionHeldExpiry` takes `1m`, `5m`,
`10m`, or `never`, defaulting to five minutes. A parked message that
reaches its lifetime is settled as `expired`, the sender is told, and the
UI is notified.

Three details matter:

- *One timer, re-armed.* The gate arms a single unref'd timer for whichever
  message expires first, rather than one timer per message. It is
  rescheduled after every change to the buffer.
- *Swept at every entry point, not only on the timer.* `admit`, `decide`
  and `reevaluate` sweep overdue entries before reading the buffer,
  because timers can be starved or slept through — a laptop that
  suspends for an hour must not wake up and deliver a message from
  before it slept.
- *Judged against the lifetime configured now.* Shortening the setting
  expires a backlog that is already too old; lengthening it extends what
  is still waiting. Of the two defensible readings, this one has the
  property that what `/peers` shows as remaining is what actually
  happens.

An unset or unrecognized setting value falls back to the default rather
than to `never`. Failing closed here means bounding how long a sender is
left waiting, not extending it indefinitely on a typo.

**`/peers` shows the deadline.** Each held message's line now says how
much time is left. A review screen that hides its own deadline invites
decisions that arrive after the sender has stopped listening. Remaining
time is rounded up, so "1 minute left" never means "already gone", and
anything under a minute reads as "less than a minute left" rather than
counting seconds nobody can act on.

## Trade-offs

- **Five minutes is a guess.** It is long enough for someone at the
  keyboard to notice `/peers` and short enough that a sender is not
  blocked for a whole session. Users who want the old behaviour set
  `never`.
- **A failed release does not restart the clock.** A message re-parked
  because the input queue was full keeps its original `heldAt`;
  otherwise a persistently full queue could keep a message alive
  indefinitely.
- **Sweeping on entry costs a scan per admission.** The buffer is capped
  at `MAX_HELD_MESSAGES`, so this is bounded and small.
- **Headless sessions are unaffected.** They bind no inbox today, so
  neither receipt reaches them; that arrives with headless participation.
- **The wire gains a value, not a version.** An older sender that does
  not know `refused` drops the receipt as unparseable and simply learns
  nothing — the same position it was in before. Frame version stays 1.

## Files

- `packages/core/src/ipc/peer-frames.ts` — the `refused` status, its
  description, and parser acceptance.
- `packages/core/src/ipc/peer-send.ts` — receipt transitions.
- `packages/core/src/ipc/inbound-gate.ts` — refusal receipt, expiry
  timer and sweep, `parseHeldExpiry`, `DEFAULT_HELD_EXPIRY_MS`.
- `packages/cli/src/config/settingsSchema.ts` — the setting.
- `packages/cli/src/ui/startInteractiveUI.tsx` — reads it into the gate.
- `packages/cli/src/peerMessaging/peer-messaging.ts` — passes it through
  and exposes the lifetime for the UI.
- `packages/cli/src/ui/commands/peers-command.ts` — remaining time.
- `docs/users/features/commands.md` — user-facing description.
