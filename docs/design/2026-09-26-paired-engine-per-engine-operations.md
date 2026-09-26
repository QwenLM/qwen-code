# Paired engine per-engine operations

[English](./2026-09-26-paired-engine-per-engine-operations.md) | [简体中文](./2026-09-26-paired-engine-per-engine-operations.zh-CN.md)

## Status

Slice B2c of #12737, the Stage B host integration for #12380, based on upstream
`f5ad9cb9b1`. It follows
[paired engine owner selection](./2026-09-26-paired-engine-owner-selection.md)
(B2a) and
[paired engine workspace runtime identity](./2026-09-26-paired-engine-workspace-runtime-identity.md)
(the first part of B2b), and applies the quarantine recovery decision recorded
in the #12737
[Q2/Q3 reply](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5846370487).
Acknowledged workspace-change delivery (the second part of B2b) and host wiring
(B2d) remain separate slices. No ordinary host constructs a paired Bridge yet.

## Problem and current behavior

A paired Bridge holds a Legacy and a Managed channel, but several operations
still behave as if only one channel existed.

- **Quarantine.** A channel whose cleanup failed, or whose abandoned restore or
  session creation is overdue, stops taking fresh sessions. Its existing
  sessions keep prompting with no bound, and the channel is retired only after
  every session drains, so a quarantined engine can hold sessions indefinitely.
- **Child resources.** The resource sampler polls one channel, and the daemon
  counts at most one ACP child per workspace runtime.
- **User language.** A language change reaches one live channel. A Managed
  channel that starts later receives nothing from the Bridge.
- **Preheat and keepalive.** They act on the Legacy channel only, which is
  intended but not defined anywhere.

## Scope

In scope, for paired Bridges: the quarantine recovery policy, per-engine child
resource aggregation, user-language delivery to every engine, and the Managed
preheat and keepalive semantics.

Out of scope: acknowledged workspace-change delivery and its quarantine cause
(B2b), host wiring and selector inputs (B2d), and a real Managed engine.
Single-factory Bridges keep their current behavior everywhere in this slice.

## Proposed design

### Quarantine recovery

A quarantine episode starts when a channel of a paired Bridge first becomes
unavailable for fresh sessions for any existing reason: restore cleanup failed,
new-session cleanup failed, or an abandoned restore or session creation whose
settlement is overdue. The Bridge records the start and arms a drain deadline,
`quarantineDrainTimeoutMs`, which defaults to 300 000 ms. The deadline is
measured once from the start and is never extended by activity.

While the episode lasts:

- The engine refuses fresh sessions as before. The channel refuses, with the
  same 503 `acp_channel_unavailable` classification and reason, any new work
  for its sessions: prompts, mid-turn messages, background turns, and side
  requests that start work in the child (content generation, side questions,
  recaps, fork agents, and the goal and workflow actions that start or resume
  work; pausing or clearing stays allowed). Turns that are already running
  continue and settle. A prompt queued before the episode began is refused when
  it reaches the head of its queue, and a mid-turn message the running turn
  never drained is removed from the queue view instead of starting a turn.
  Goal turns are started by the child itself and cannot be refused; they settle
  or are cancelled at the deadline.
- The Bridge closes the channel's settled sessions at the start and again
  whenever a session settles or its restore, creation or worktree reset
  finishes. A settled session has no queued or running prompt or automatic
  turn, no notification or side request in flight, no running background task
  and no work the child reports holding. The close is authorized locally and
  bounded, as for any condemned channel. Once the channel holds no work, it is
  retired early.
- No current cause ends the episode early. The #12737 decision lets only a
  validated acknowledgement of a missing workspace change clear a quarantine
  before the deadline; B2b adds that cause. An overdue settlement therefore
  retires the channel even if the late work settles afterwards.

At the deadline, the Bridge requests cancellation of running turns and then
terminates the channel with the existing escalation. The deadline triggers
cleanup; it is not evidence that the process exited.

Session entries, IDs, admission slots and owners stay allocated until the
channel's root process is seen to exit, as for any exit. The engine keeps
refusing fresh sessions longer, until the process registry confirms that the
child's whole process tree is gone (the same release that workspace runtime
stop waits for; a channel without a registry uses its exit). This holds while a
channel that drained early is still terminating, too, and a workspace runtime
stop reports `stopping` until then. If the child is not confirmed gone one
initialization budget (at least 15 s, the registry's own termination window)
after the deadline's escalation, or after its root exited, the refusal reason
becomes `channel_exit_unverified`, and the daemon log and telemetry report that
operator action may be required.

After that, each session can be restored on demand. The owner selector sends it
to a fresh channel of the same engine, and that engine decides whether its
persisted state is safe to restore; an unresolved tool effect or incomplete
recovery proof stays blocked there for reconciliation. The Bridge never replays
a turn and never falls back to the other engine.

Single-factory Bridges keep their current quarantine behavior: existing
sessions keep prompting and the channel is retired after they drain. Applying
the drain deadline to them is a separate decision.

### Child resources

The resource refresh polls every live channel, each at most once at a time. The
Bridge snapshot then combines the fresh readings: RSS and CPU are summed (CPU is
already a share of the whole machine, so the sum stays clamped to 100), the age
is that of the oldest reading, heap high-water marks keep their maxima, and the
unclassified heap space names are merged. The snapshot also states how many
children it covers and how many of them reported heap marks. The daemon counts
live ACP children per runtime from the Bridge's live channel count and adds each
snapshot's child count, capped by that count, to `sampled`, so
`sampled <= activeAcpChildren` holds with two engines. For a paired primary
workspace the resource chart shows the sum of its children.

Legacy is still read as workspace control, as before. Reading a Managed child
is only an observation: it neither re-arms that channel's idle timer nor
retires the channel on a slow answer, so an open dashboard does not decide how
long a Managed child lives.

### User language

`setUserLanguage` sends the change to every live channel of the Bridge and adds
up their refreshed and failed session counts. A channel whose call fails counts
as one failure; the call rejects only when no channel is live or every channel
fails. The Bridge also remembers the last requested language and sends it to a
newly started Managed channel before that channel's first session request. A
failure there is logged and does not block the session. Legacy channels keep
reading the persisted setting when they start.

### Preheat and keepalive

Preheat starts only the Legacy channel, which owns workspace control, and
keepalive extends only its idle deadline. A Managed channel is never preheated:
it starts with its first Managed session or restore, stays up while it has
sessions or in-flight work, and is then reclaimed by the ordinary idle timeout.
Managed work never extends Legacy's keepalive, and neither Legacy keepalive nor
resource sampling keeps a Managed channel up.

## Files and consumers

| Area              | Files                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Quarantine        | `acp-bridge` `session-control-plane.ts`, `bridgeErrors.ts`, `bridgeOptions.ts`                                           |
| Child resources   | `acp-bridge` `session-control-plane.ts`, `bridgeTypes.ts`; CLI `daemon-status.ts`                                        |
| User language     | `acp-bridge` `session-control-plane.ts`                                                                                  |
| Preheat/keepalive | Tests only; behavior is unchanged                                                                                        |
| Tests             | `acp-bridge` `execution-engines.test.ts`, `bridge-worktree-reset.test.ts`; CLI `daemon-status.test.ts`, `server.test.ts` |

No daemon route is added. The language route and the status route keep their
shapes; only the values they aggregate change. The new refusal reason is carried
by the existing 503 `acp_channel_unavailable` body.

## Validation and acceptance criteria

Each behavior is covered on a paired Bridge, not only on Legacy.

1. A quarantined channel refuses new prompts, mid-turn messages, background
   turns and side requests while a running turn settles; the other engine keeps
   accepting work.
2. Settled sessions on a quarantined channel are closed, a session with a side
   request or notification in flight is kept until it answers, and the channel
   retires before the deadline once it drains.
3. The deadline is not extended by activity. At the deadline running turns are
   cancelled and the channel is terminated; admission and IDs are released only
   when the exit is observed, the engine reopens only once the process tree is
   released, and a child not confirmed gone keeps the engine refused with
   `channel_exit_unverified`.
4. After that, a closed session restores on demand on a fresh channel of the
   same engine.
5. An overdue settlement retires the channel like a failed cleanup; sessions
   whose restore, creation or worktree reset finishes during the episode are
   drained too.
6. Resource snapshots cover both engines, and the daemon's child counts stay
   consistent.
7. A language change reaches both engines, and a Managed channel that starts
   later receives the remembered language before its first session.
8. Preheat and keepalive affect only Legacy; a Managed channel is reclaimed by
   its idle timeout while Legacy is kept alive.
9. Single-factory quarantine behavior is unchanged.

## Risks and open questions

- Blocking new prompts on a quarantined channel is a deliberate change from the
  #12698 paired behavior, and so is retiring a channel for an overdue
  settlement that could still clear: the #12737 decision reserves early
  clearing for acknowledged workspace changes.
- Closing settled sessions interrupts clients that are attached but idle; they
  restore the session on a fresh channel of the same engine.
- Keeping the engine closed until the process tree is released delays its fresh
  sessions while a drained channel terminates, normally by at most one
  initialization budget. A child that never goes away keeps the engine closed
  until an operator intervenes; clients see a retryable 503 meanwhile.
- Session entries, IDs and admission are released when the root process exits,
  as for any channel exit; only the engine gate waits for the registry to
  release the process tree. Holding admission until that release too is
  possible if the #12737 decision means physical cleanup in that stricter
  sense.
- The remembered language is per Bridge instance and in memory. A Managed host
  that starts after a daemon restart relies on its own settings loading.
- Selector inputs (Q1) and the Hosted boundary (Q4) are still open for B2d.
