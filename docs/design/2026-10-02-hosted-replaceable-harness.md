# Hosted replaceable Harness — remove owner affinity (G3)

[English](2026-10-02-hosted-replaceable-harness.md) | [简体中文](2026-10-02-hosted-replaceable-harness.zh-CN.md)

Status: Steps 1 and 2 implemented in this PR (D1-D9); D10's Step 3 rows are
named follow-ups. Issue tracker: #12952 (Stage G). Code references are to
`main` @ `728c13de21` unless a decision notes a later refinement. This
design answers Q2 and Q3 of #12952 following the proposal in its comments,
and corrects one mechanism description from that proposal (see "Current
state", item 1).

## Problem and scope

Stage G externalized the authoritative Session history and proved writer
fencing and takeover. What remains is G3: a Hosted Session must not be pinned
to the Harness process generation that first served it. Today, restarting the
Hosted Harness alone leaves every bound Session failing with a generation
error until the Java control plane also restarts
(`managed-agent-server/README.md:185`). G3 removes that affinity so a live
control plane adopts the next Harness generation and Turns continue.

Scope, settled per the issue:

- **Hosted only.** The ordinary path keeps local storage and owner affinity.
  `session_execution_engine_unavailable` (`acpAgent.ts:1120`) and "a Managed
  failure never replays through Legacy" stay unchanged, guarded by existing
  tests.
- **"Any Harness" means any Harness process generation the same control plane
  can reach, one generation after another (Q3).** The connector holds one
  Harness base URL. Two live owner pairs, graceful handoff and cross-host
  takeover need lease handoff and routing that nothing merged provides; they
  get a separate tracker.
- **"Of the correct engine" means the same capability digest and a Harness
  that can read the journal its predecessor wrote.** A changed digest stays
  terminal.
- **Q2 is a G3 deliverable, not a prerequisite:** a gated proof that a
  _concurrently surviving_ former owner is fenced, as a freeze variant of an
  existing failover scenario (D7).

Out of scope: the public-Shell opt-in (tracked separately from G0's tail),
Step 3's model-round reissue and `await_action` settlement beyond what D5/D6
require (named follow-up slices below), and any multi-instance control-plane
work.

## Current state

Where the affinity lives (all verified at `728c13de21`):

1. **The control plane pins one Harness process generation.**
   `HostedHarnessClient` negotiates once in its constructor and keeps that
   boot ID (`HostedHarnessClient.java:107`). The connector builds the client
   exactly once (`QwenHostedHarnessConnector.java:395-410`); `close()` does
   not null the field and **no code path rebuilds it**. The coordinator treats
   `HostedHarnessGenerationException` as terminal
   (`HarnessCoordinator.java:178-180`), and `bindHarness` refuses a rebind
   once a Turn carries `submission_attempted` or an event epoch
   (`ManagedAgentStore.java:1240-1244`).
   Correction of the issue proposal's wording: generation mismatch is
   detected from the `X-Qwen-Harness-Boot-Id` **response header**
   (`HostedHarnessClient.validateGeneration`, lines 1067-1086) or by a local
   check against a cached session ref (`requireSessionRef`, lines 977-991),
   never by parsing a 409 body. Java parses no error-body code anywhere;
   daemon 409s (`hosted_session_already_attached`,
   `hosted_turn_recovery_required`) arrive as code-blind
   `DaemonHttpException`s and become indefinite post-admission retries
   (`HarnessCoordinator.java:184-193`, whose budget check is bypassed once
   `submissionAttempted` is true, lines 582-590). The connector's `create()`
   even swallows _any_ 409 into a silent load fallback (lines 301-305).
2. **The Session row is bound to a Harness boot ID.** A Turn that was
   submitted or admitted can only move through the recovery CAS
   (`bindRecoveredHarness`, `ManagedAgentStore.java:1270-1281`). No method
   clears `submission_attempted` or a per-turn epoch; only session-lifecycle
   completes clear them (CLOSE/ARCHIVE/DELETE, lines 719-731).
3. **The journal writer lease is exclusive while alive** and its holder renews
   at half-life (`http-managed-session-store.ts:889-902`;
   `ManagedSessionStore.java:197-210`). A successor waits for expiry (60 s
   default, `application.yml` `session-store.writer-lease-duration`) or a
   seal. Store-level fencing is already proven
   (`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`).

Items 2 and 3 are the fencing G3 keeps. Item 1 is the affinity G3 removes.

What already works (the G3 machinery mostly exists):

- The coordinator already has a takeover-load branch: a Session row with a
  `harness_boot_id` attaches through `recoverManagedRuntime`, which sends the
  takeover load from #13083 (`HarnessCoordinator.java:231-239`).
- `bindRecoveredHarness` is exactly the compare-and-swap an adoption needs;
  `recordRecoveryAdmission` re-keys the epoch.
- The TS takeover load settles `await_runtime` / `results_ready` parkings and
  refuses the rest (`recoverHostedRuntimeTurn`,
  `hosted-runtime-recovery.ts:218`).
- Event streaming reads the journal by sequence
  (`hosted-harness-session.ts:2240-2245`), so a stored event cursor is valid
  on any generation.
- The three failover E2E modes prove sequential replacement when an operator
  kills both owners deliberately; the 2026-09-30 design records the three
  follow-ups G3 now addresses (lost-reply takeover load, 30 s timeout vs
  120 s load, `message.delta` rollback).

Two distinct events currently share the code
`hosted_harness_generation_mismatch` (the client exception at
`HarnessCoordinator.java:178` and the DB bind refusal at line 325). Only the
first is adoption-eligible; the design names them "wire mismatch" and "bind
refusal" below.

## Decisions

### D1 — Adoption is centralized in the connector, at retry boundaries

On any `HostedHarnessGenerationException`, one adoption runs in the
connector: the monitor is taken only for the client handoff and the cache
churn happens outside it (a `computeIfAbsent` bin lock is held across an
in-flight load, so map work under the monitor would invert the lock order).
**Cached Attachments are evicted by boot identity — only entries minted
under the boot now serving stay — and each `pendingRecovery` marker follows
its attachment.** They re-mint on demand, a stale ref observed after
another thread's rebuild cannot retry-loop on itself, and entries a
concurrent rebuild already minted under the new generation survive. When
the exception's actual boot ID differs from the client's, the old client is
also closed and the field cleared; the next call rebuilds (renegotiation
applies the digest gate, D2). The exception is then rethrown so callers
reach their existing retry mechanics. Nothing adopts mid-stream:
`consumeStream` embeds the attach-time boot ID in every recorded event
source key (`HarnessCoordinator.java:398-401`),
so a torn stream dies by exception and the Turn is adopted at its next
dispatch attempt. In `HostedHarnessClient` this slice adds the
recovery-only load timeout (D9b), the journal-contract feature check
(D9c), the error-body accessors D5 parses, and the header-less-404
classification recorded in Boundaries.

### D2 — The digest gate stays terminal

A renegotiated capability digest different from the configured one keeps
throwing `HostedHarnessCapabilityMismatchException`
(code `managed_capability_mismatch`) and the coordinator keeps failing the
Turn terminally. "Replaceable" never crosses an engine boundary.

### D3 — The coordinator stops failing on wire mismatch

The `HostedHarnessGenerationException` catch in `HarnessCoordinator.coordinate()`
becomes `transientFailure` instead of terminal `fail`. The next dispatch
attempt goes through the existing recovery attach: `session.harnessBootId()
!= null` selects `recoverManagedRuntime` (the takeover load) with the rebuilt
client; on success `bindRecoveredHarness(expected = old boot ID)` CASes the
row to the new generation. `bindHarness` refusals and post-admission turns
keep moving through the recovery branch only. The "bind refusal" path
keeps its shape and is still reached — it is D4's trigger: a refusal on a
marked but never-admitted Turn withdraws the mark and rebinds, and the
terminal `hosted_harness_generation_mismatch` remains for the case where
the rebind also loses, or the withdrawal CAS does. One bypass is
deliberate: with no recovery to rebind through, a `CANCELLING` Turn on a
plain attach settles by `harness.cancel` directly, BEFORE the bind — the
bind exists for submissions, and a cancel must never die stamped
`hosted_harness_generation_mismatch` while the Turn it names cannot be
cancelled (everything queued behind it wedges on the block it leaves).
The cancel route is honest about what it can abort (R10-3): it 409s with
`hosted_turn_recovery_required` when no live execution exists but the
journal still holds the Turn unsettled (a parked approval whose owner
died with its generation), and the coordinator then adopts the attach's
epoch and streams instead of re-issuing a no-op cancel — the replay
surfaces the parked Action, whose durable resolution a later redispatch
settles as the cancel.

### D4 — A marked-but-never-admitted Turn withdraws its submission mark

New store primitive `withdrawSubmissionAttempted`, modeled on
`bindRecoveredHarness`'s CAS: owner + live dispatch lease + status
`IN ('ACCEPTED','RUNNING','CANCELLING')` +
`submission_attempted = TRUE AND harness_event_epoch IS NULL` → set
`submission_attempted = FALSE`. No new columns, no Flyway migration.

Placement: in `runClaimed`'s fresh branch, when `bindHarness` refuses
because the Session row names an older generation while the Turn has no
epoch (never admitted), the coordinator withdraws the mark and retries the
bind against the attachment the takeover load just produced.

Safety condition, stated precisely (this corrects the proposal's "the 409
proves non-admission" shortcut): withdrawing is safe because **re-submission
is idempotent at the journal**. `submitInput` commits with `commandId =
promptId` (`hosted-harness-session.ts:1481-1491`), so an admission that did
happen at the old generation before its reply was lost replays as the exact
same transaction when the Turn re-submits on the new generation
(`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`
covers exact replay). The boot-ID middleware rejecting before any Session
route (`hosted-harness-contract.ts:68-83`) is the common case, not the
invariant; the journal `commandId` is the invariant.

Boundary of that idempotency (R10-4): replay exists only for an admission
whose Turn settled. One still unsettled answers the resubmit with the
coded 409 `hosted_prompt_recovery_required` instead — and a null epoch
only ever proved the admission REPLY was lost, never that the admission
did not land. The withdraw arm therefore resubmits exactly once; on the
coded refusal (which it may honour only when this Turn's own submission
mark already stood — otherwise the code names a _different_ Turn's parked
input and stays a fail-closed pre-admission failure meeting the retry
budget) it adopts the attachment's epoch through
`recordRecoveryAdmission` **keeping the consumed watermark**, and opens
the stream. Replay then surfaces the parked Turn (a pending Action
resolves durably, and a later redispatch drives what it unlocks) instead
of the mark churn the withdraw arm would otherwise repeat forever.

That kept watermark is the same rule the two plain-attach
epoch-migration arms now follow (R10-3): when the epoch moves to the
newly attached generation, `harness_last_event_id` does **not** move to
the attach's journal tail. Anything the prior generation committed but
never delivered — including the Turn's own `turn.settled` — must still
replay from the consumed cursor; nothing on the plain-attach path can
produce another terminal event, so advancing the cursor to the tail
would wedge the Turn RUNNING with its settle committed and invisible.

### D5 — "Cannot be taken over" becomes typed and terminal; "retry later" stays retriable

TS: `recoverHostedRuntimeTurn` returns a discriminated result instead of
`undefined` for the deterministic decline states, each a stable function of
the journal — `await_action` (an approval group in `requested` state),
`model_start` (no checkpoint yet, or a checkpoint at another model-start
phase; also the load route's answer for a parked Turn on a no-tool Session —
a cancellation-only load of that shape keeps the baseline retriable 409 on
EVERY arm, first load or already-attached redrive alike, because no kernel
is consulted on the no-tool path and a minted plain attach would wedge the
coordinator on a no-op cancel (R10-1)),
`shell_in_flight` (a Shell execution was in flight — produced only on a
drive-recovery load, where the drives cannot be rebuilt; a passive load
parks the same journal state instead), `batch_not_durable` (parked before
`await_runtime` without durable args), `checkpoint_blocked` (the checkpoint
no longer parses back to a runnable state), `unresolved_after_settle` (the
checkpoint names another Turn, or the state after settling is still not
runnable), `turn_settled` (settled in the journal with the terminal record
not yet projected — rebind-and-keep-reading is Step 3's row; in the
meantime the route answers the plain attach for BOTH load shapes,
because a Turn written turn_settled completed and must never be stamped
a terminal failure — the daemon's own projection writes the terminal
record once the plain attach is admitted).

`checkpoint_blocked` fires only on durable verdicts (`opaque_state`,
`invalid_state`, `identity_mismatch`). A transient Managed Session Store
failure erased into `missing_state` / `missing_checkpoint` by the
authorization layer is re-thrown as transient, never a decline: the
boundary is deliberately narrow so one store blip during a takeover load
cannot terminally fail a Turn whose journal is intact. The load route's
restore guard applies the same read before the takeover branch runs,
because the restore bundle collapses both verdict kinds into one `blocked`
bit — there a durable reason becomes the typed decline for a drive
takeover, while a bare load and every cancellation-only load keep the
retriable 409. A plain attach never makes the journal's unsettled state
writable: whatever the takeover answered, the prompt route itself refuses
a fresh promptId while ANY input is unsettled
(`hosted_turn_recovery_required` — the SESSION-level wedge: the
prompt-scoped code `hosted_prompt_recovery_required` names only the
requested prompt's own unsettled duplicate, so the coordinator proves a
lost-reply adoption from it; a session-scope refusal must never mint
that proof (R11-1)), so no admission can stack onto a parked Turn's
mid-flight checkpoint (R10-2).

R11 narrowed `inapplicable` itself: it survives only where a plain attach
pays — a requested approval (the resolve route writes the decision
durably) and `turn_settled` (checkpoint says settled, journal never
landed the record). The bare branch's settle conditions never ran on the
takeover arms, so both arms now compute the same projection inline: the
load writes the missing terminal record itself, or keeps the baseline
retriable refusal when the projection cannot pay either (R11-2). Every
other parked state (`initial`, durably `blocked`, model-start or unknown
phase, a checkpoint naming another Turn) THROWS on the cancellation side
into that same retriable refusal, so the only attach a takeover mints is
one a settlement route genuinely pays. A passive re-attach through
createOrLoad carries the recovery snapshot exactly like the recovery
load, so the connector restores the `pendingRecovery` marker there —
otherwise a boot-identity adoption evicts the stale-boot entry, puts a
snapshot-carrying attachment under the live boot, and the next dispatch's
cached branch answers "nothing parked" (R11-3).

The remaining no-tool cancellation wedge (Arm B) is closed with the same
settlement principle, this time fed by intent rather than by state: a
Turn with no Runtime work whose Harness generation died can never be
driven, so its cancelled terminal can only be a journal record — and only
an EXPLICIT cancellation may write it. `LoadHarnessSession` therefore
carries the boolean `cancellationTakeover` (set ONLY by
`recoverManagedRuntime`'s cancellation arm; a plain passive re-attach
shares the passive wire shape and must never mint anything). With the
signal present, the load settles the park into the journal itself, through
a separation that splits tool CONFIGURATION from the Turn's unpaid
Runtime work (checkpointless, a bootstrap checkpoint naming no Turn,
every tool item settled and consumed, or an approval whose durable
record already ended — an ended approval settleable only with the
signal, regardless of the user's side). Without the signal the branch
keeps the baseline retriable refusal for cancels and the typed
`model_start` decline for drives; with work unpaid the recovery-cancel
of the kernel's report stays the faithful settlement. The writer fence
on the very load proves the producing generation can never write again
(P1-1).

The stale checkpoint copy of an approval is not the authority posthumously
either: the recovery kernel cross-reads `authority.action(requestId)`.
While the record stays requested the takeover keeps its inapplicable
plain attach (the resolve route pays that wait); when the record says
the wait ended, the kernel never slips it back into a resumable
continuation — expired or cancelled stays transient (the route refusal),
while a decided wait is advanced through its own durable gate ONLY on a
drive load — a cancellation-only load never crosses it (P1-2).

Round 9 measured the separation on the real stack and tightened two of
its readings (R9):

- "Unpaid Runtime work" is read off the work itself, never off whether
  the checkpoint names this Turn. A checkpoint naming an EARLIER Turn
  whose tool items all settled and were consumed owes nothing to a
  cancelled Turn that never reached a tool call — Turn 1 completing is
  exactly that shape. A no-tool Session cannot owe Runtime work by
  definition either, so its cancellation arm settles unconditionally:
  gating it on the authorization state (a blocked restore basis is the
  NORMAL state of a no-tool Session with history) re-wedged every
  cancelled Turn after the first there.
- The plain-cancel coded refusal is not a verdict to retry, it is the
  signal to escalate: when `harness.cancel` answers 409
  `hosted_turn_recovery_required` on a live plain-attach coordination,
  the coordinator sends the cancellation takeover load over that same
  attachment (`recoverManagedCancellation`). On the wire the connector's
  healthy-attachment shortcut must NOT absorb that call, or the load
  never leaves the process; a recovered Runtime park it reports is
  cancelled through its checkpoint admission, a plain-settled park needs
  none, and the stream the coordination already runs lands the settle
  either way (R9-P1-2).
- The cancellation signal pays identically on EVERY load shape (R9-2):
  a takeover load forced onto a Session ALREADY attached in this daemon
  used to fall into the passive kernel — which never advances a durable
  wait passively, so a park whose approval ended after the attach was
  thrown back as an unknown phase. The attached branch now runs the
  same separation the first load does (signal + no-tool arm + owed-work
  gate + durable cross-read) and settles through
  `settleCancelledHarnessTurn` into the journal the already-running
  stream reads. Round 10's real-stack repro — attach plain with the
  approval requested, resolve the decision after the attach, then load
  with the cancel signal — is its witness shape.
- A cancelled terminal whose park was an approval wait must close the
  WAIT before the terminal record lands (R9-3): the record sink only
  advances next-turn checkpoints at a model-start phase, so writing just
  `turn_result` left the checkpoint at `await_action` and the next
  prompt's harness refused it as not-a-model-start — the old Turn ended
  cleanly while the Session could never run again. The settle now first
  advances the ended wait through its own durable gate
  (`resolveDurableWait` → `model_output_committed`, a model-start family
  phase); the decision is the USER's and nothing resumes — the Turn
  dies immediately after. Only an ENDED record crosses the gate here,
  exactly the cross-read the caller's gate already made.
- The cancellation settle reads as honestly as it pays (R9-5): the
  wait's in-place re-read cannot degrade into "nothing to close". A
  transient store fault surfacing between the caller's gate and the
  settle's own wait-check used to be swallowed as `undefined`, so the
  terminal landed over a wait the fault hid — and the Session's next
  prompt then found the stale checkpoint it left behind, exactly the
  defective shape the round-11 probe built by injecting one real
  transport fault into that read. The helper now propagates the fault
  into the caller's try-catch: the baseline retriable refusal answers,
  the store's retry ladder owns the retry, and the same shape settles
  identically once the fault has passed.
- The authority itself converts the same class of store fault in place
  (R9-5'): TransportError becomes a `blocked/missing_state` verdict,
  never an exception, so propagation alone still settled past it.
  Fault-shaped verdicts (`missing_state`, `opaque_state`,
  `invalid_state`) are refused there too; `missing_checkpoint` stays
  payable as the Arm B park's honest form.
- The escalation itself is paced (R9-4): a cancellation takeover load
  forced per ~500 ms lease-renewal tick against a wait that cannot
  settle yet only buys daemon work at ~4 requests/s — the coordinator
  paces it per Turn (5 s minimum interval), letting the cheap
  plain-cancel retry carry the wait between attempts. And the cancelled
  settle re-reads the journal's own terminal before writing: a redriven
  load that lands inside the stream's landing window is a re-answer,
  never a second `turn_result` meeting the event-id CAS
  (`turn:<id> is already committed`).

Thrown errors stay transient, exactly as today. The load route answers
declines with new 409 code `hosted_turn_recovery_declined` plus a `reason`
field; inside the takeover branch, `hosted_turn_recovery_required` is
thereafter emitted for transient states only (its earlier refusals — a
non-ok restore bundle, an unverifiable workspace publication — predate
this taxonomy and are unchanged). `hosted-tool-approval.ts:247`'s uses are
transient and unchanged.

Java: code-blindness is kept everywhere except one call site. The
connector's `recoverManagedRuntime` parses the 409 body of its own load
response; on `hosted_turn_recovery_declined` it throws a typed
`HostedHarnessRecoveryDeclinedException` carrying the reason, and the
coordinator fails the Turn as `managed_runtime_recovery_blocked` — the
existing code with one new producer, also the observable pattern #13054
asks for. No global HTTP-code table is introduced.

### D6 — The takeover load is idempotent

A takeover load whose reply was lost is redriven against the Session it
already attached: the route re-runs the recovery and re-answers from the
attached state. Nothing is ever consumed, so an unconfirmed continue or
cancel cannot damage the next re-answer either — the lost-reply family is
closed by construction, without a snapshot to roll back symmetrically. The
re-answer re-proves identity: the caller must name the tenant/workspace
the attachment was opened with (held on the attached session's own key),
so the harness token alone no longer drives a stranger's session. A
continue/cancel whose reply was the lost one is still unconsumed: it
re-runs, not replays. The verdicts apply verbatim: a drive redrive of an
immovable Turn declines with its typed reason, and a no-tool or
cancellation-side redrive answers the plain attach (the kernel's
inapplicable shape). The lost-reply follow-up recorded by the 2026-09-30
design is closed — including the drive-reply-lost-then-cancel cell, which
recomputes the cancellation-shape answer on the redrive instead of
requiring a widened replay. The `opening.has(sessionId)` refusal (a
takeover currently in flight) is unchanged and stays retriable.

### D7 — Q2 gate: the freeze variant (test-only unless it finds a defect)

A continuation-scenario arm in `scripts/run-managed-agent-server-e2e.ts`:
SIGSTOP the original Harness (the journal writer) and SIGKILL the original
Spring JVM (`crashProcess`, exactly as the continuation mode kills it), keep
the Harness home, let the leases lapse (the existing SQL waits work
unchanged against a frozen writer), let the replacement finish the Turn,
then SIGCONT the frozen Harness and assert:

- no journal transaction from the _old writer generation_ after the wake
  (counted straight off `qwen_managed_session_journal_tx`; lease renewal
  touches `writer_lease_until` only and the heartbeat route writes
  nothing, so the head's revision moves only with real commits — the fence
  metric is the writer's identity, not the head's revision),
- the public transcript still holds only the replacement's answer and one
  terminal event,
- `managed_agent_session.harness_boot_id` is still the replacement's.

Why the Spring must actually die (a refinement discovered by the first CI
run of this arm): reclaiming a workspace binding requires death evidence
from `/proc` liveness via the trusted host identity, and a SIGSTOPped JVM
still reads as alive there — so with a merely-stopped Spring the
replacement's reconcile times out (`runtime_broker_reconcile_timeout`) and
the Turn never completes. Resource-level (Broker/worker) takeover of a
surviving owner is therefore structurally out of reach today; the arm
fences at the journal writer level instead. That discharges the exit
check's journal half — a fenced former owner cannot mutate the journal —
but not its binding half: `managed_agent_session` is written only by a
Spring, and this arm's former Spring is dead by construction, so "cannot
mutate the newer binding" is not proven by this gate (see Boundaries).
The replacement Spring inherits the original's port, because the frozen
Harness's journal-store URL was fixed at load: on wake its store calls
meet a live, fencing control plane rather than a dead socket — otherwise
the post-wake assertions would hold by disconnection, not fencing.
Teardown re-continues the
frozen Harness before stopping the children, through the children
registry's startup-name lookup (one constant names both the registry
entry and the wake lookup; a miss fails the run instead of leaving a
wedged writer). The same PR also wires `npm run test:e2e:managed-session-failover` into the
`hosted-harness-mysql` CI job — the 2026-09-26 fault-gates design had
scoped that arm out deliberately, and this slice supersedes that older
decision so it runs under the gate.

### D8 — E2E: the Harness-only restart arm

One runner switch, stacked on the three scenarios, that kills only the
Harness (`crashChild(harness.child, …)` at the existing crash block, lines
1130-1135), restarts a fresh Harness on the **same port** (free after
SIGKILL; the live Spring's `HARNESS_BASE_URL` was fixed at JVM start), keeps
the original Spring, Broker and `runtimeHome`, deletes `harnessHome` (the
journal is remote; the new process must prove it needs nothing local), and
reuses the existing lease-expiry waits. Post-restart assertions: the idle
Session's next Turn completes and the model boundary sees Turn 1's prompt
and answer; `managed_agent_session.harness_boot_id` moved to the new
generation **without a Spring restart**; the in-flight and continuation
arms keep their current assertions. The before picture is produced by the
same arm on `main`: it must fail with the generation error the README
documents. The README sentence at `:185` is deleted. With Spring and its
Broker alive the worker is not orphaned and no W0e reclaim is needed, so
this arm drops the Linux guard for the workspace-turns scenarios in code;
the kill-both modes keep it. The arms also pin what makes them
Harness-only restarts rather than kill-boths in disguise: the surviving
Spring, Broker and durable Worker keep serving the same
`runtime_session_id`, and the live Broker re-dispatches on the
generation it already owns (exactly `'0'` or `'1'` — never `'1'`-only,
never unbounded). Every lane that runs these arms is Linux
(`hosted-harness-mysql` is ubuntu-only), so darwin stays an unverified
expectation, not a decision gate waiting on a first run that cannot
happen.

### D9 — Production defaults made consistent (settled, per the issue)

- **D9a, retry budget vs writer lease.** A 409 on the recovery attach
  path of a bound Session is exempt from the pre-admission retry cap only
  when its body carries the lease's OWN code
  (`managed_session_writer_conflict`) — the one refusal that provably
  ends when the fenced writer lease lapses. The exemption is keyed on
  the lease itself, not the code family: `hosted_turn_recovery_required`
  covers arbitrary takeover failures, including refusals no retry can
  change, and exempting those wedged durable refusals in an unbounded
  retry (R6-1).
  `hosted_prompt_recovery_required` is deliberately absent: it can only
  arrive after the submission mark is set, where the exemption gate is
  already bypassed, so listing it could never change an outcome.
  Everything else
  meets the budget, including `hosted_session_already_attached`, which
  reads as a transient conflict but is permanent: the daemon drops an
  attachment only on an explicit detach or delete and this control plane
  never detaches, so exempting it would spin forever on a Spring restart
  against a surviving Harness. The guarantee is scoped to the window it
  constrains: a permanently absent Harness still ends a pre-admission Turn
  as `hosted_harness_unavailable`, while a Turn carrying the submission
  mark retries on its own path regardless of the code — the budget never
  consulted those Turns (that is `transientFailure`'s contract, not a
  lease exemption).
- **D9b, request timeout vs takeover load.** `HostedHarnessClient.loadSession`
  uses a dedicated `load-timeout` (default 120 s, env-overridable like the
  other knobs) only when the request carries a recovery flag
  (`passiveManagedRuntimeRecovery` or `driveRuntimeRecovery`); plain attach
  loads stay on `request-timeout` (30 s) because they also run under the
  connector's `ConcurrentHashMap` bin locks.
- **D9c, journal-contract marker.** Capability negotiation requires a
  `features` token naming the journal contract,
  `managed_session_journal_delta_v1`. A Harness too old to read
  `message.delta` journals is refused once at (re)negotiation — on a
  coordinator's dispatch path that lands as the terminal turn code
  `hosted_harness_protocol_error` — instead of failing every Session open
  with `managed_session_open_failed`.

### D10 — Step 3 stays a named follow-up, minus its cheap row

D4 already delivers the proposal table's first row (submission attempted,
never admitted → re-submitted after withdrawal). The remaining rows — model
round reissue with partial-text retraction (`before_model`; mechanism
already proven by `--continuation-failover`, which retracts a dead owner's
published prefix), `await_action` settle-as-cancelled with Runtime-Session
release (safe per `managed-harness-factory.ts:541-547`; the MCP profile
must be checked first), and `turn_settled` rebind-and-keep-reading — are
follow-up slices on top of D5's typed-decline contract. Shell parkings stay
declined with the typed outcome; real Shell takeover belongs to the Shell
work item. G3's functional scope is Steps 1+2 (D1-D9), but the issue does
NOT close on the model-round slice alone: the Boundaries bullet keeps
#12952's Q2 half open until a separate multi-instance control-plane
tracker proves it, so closing waits on both.

## Changes and ownership

| Layer                     | Files                                                                                       | Change                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Java qwencode             | `HostedHarnessClient.java`, `DaemonHttpException.java`                                      | per-request load timeout; error-body code accessor (no global code table)                                                                       |
| Java managed-agent-server | `QwenHostedHarnessConnector.java`, new `HostedHarnessRecoveryDeclinedException.java`        | D1 adoption (client rebuild + cache invalidation), D5 single-site 409-code parse in `recoverManagedRuntime` throwing the typed exception        |
| Java managed-agent-server | `HarnessCoordinator.java`                                                                   | D3 catch change, D4 withdrawal use, D9a exemption                                                                                               |
| Java managed-agent-server | `ManagedAgentStore.java`, `AgentStateStore.java`                                            | `withdrawSubmissionAttempted` CAS and its store-interface signature (D4)                                                                        |
| Java managed-agent-server | `ActionResponseCoordinator.java`                                                            | terminal capability-mismatch catch completing the action outbox as FAILED with the mismatch code (honest terminal, unlike the lifecycle outbox) |
| Java managed-agent-server | `SessionLifecycleCoordinator.java`                                                          | comment only: why a capability mismatch keeps retrying instead of completing (the lifecycle outbox has no FAILED vocabulary)                    |
| Java qwencode             | `LoadHarnessSession.java`                                                                   | `isRuntimeRecoveryLoad()` flag accessor (D9b)                                                                                                   |
| Java managed-agent-server | `ManagedAgentProperties.java`, `application.yml`                                            | `load-timeout` (D9b)                                                                                                                            |
| TS CLI                    | `hosted-harness-session.ts`                                                                 | decline-code mapping (D5), recompute-and-re-answer idempotent redrive on the attached Session (D6)                                              |
| TS CLI                    | `hosted-runtime-recovery.ts`                                                                | discriminated decline result (D5), reusing core's `HARNESS_MODEL_START_PHASES`                                                                  |
| TS CLI                    | `capabilities.ts`, `routes/capabilities.ts`, `qwen-serve-protocol.md`                       | `managed_session_journal_delta_v1` feature token (D9c)                                                                                          |
| Java qwencode             | `HostedHarnessClient.java` (negotiation)                                                    | hardcoded `managed_session_journal_delta_v1` feature check (D9c) — no config knob by design                                                     |
| TS core                   | `managed-harness-checkpoint.ts`                                                             | nothing; D5's naming reuses `HARNESS_MODEL_START_PHASES`                                                                                        |
| Runner + CI               | `scripts/run-managed-agent-server-e2e.ts`, `package.json`, `.github/workflows/sdk-java.yml` | D7 freeze arm, D8 Harness-only arm, `--session-failover` step                                                                                   |
| Docs                      | `managed-agent-server/README.md`                                                            | delete the generation-error sentence; document adoption behavior                                                                                |
| Unit tests                | collocated `*.test.*` per file above                                                        | per-decision coverage; see validation                                                                                                           |

Ownership follows the shared-bean structure: `HarnessCoordinator`,
`SessionLifecycleCoordinator`, `ActionResponseCoordinator` and
`ManagedAgentService` all inject the same connector bean, so D1 needs no
per-caller change. The three coordinators' retry mechanics do the rest.
`ManagedAgentService` differs: its one synchronous Harness attach (rename)
has no retry mechanics, so a generation change mid-call — and likewise a
capability digest mismatch from the same attach — surfaces as a
client-visible `hosted_harness_unavailable` (503); the retrying client's
next attempt lands on the adopted (or realigned) generation.

## Validation and acceptance

Unit tests (collocated):

- Connector: concurrent mismatches close the stale client exactly once and
  build no real client during the race (the replacement is injected); an
  equal-boot mismatch evicts only entries minted under another boot and
  keeps the live client's recovery markers; `recoverManagedRuntime` maps
  `hosted_turn_recovery_declined` + reason to the typed exception and
  leaves other 409s code-blind. The digest gate is pinned where it lives —
  the client's construction-time negotiation check
  (`HostedHarnessClientTest`); the coordinators' terminal catches for it
  have no test, and the connector adds no third gate.
- Coordinator: wire mismatch schedules a retry, not a fail; a bound
  Session's recovery attach meets the pre-admission budget on everything
  but a lease-coded 409, and the same 409 exempts nothing on an unbound
  one; decline → `managed_runtime_recovery_blocked`.
- Store: the withdraw sequence binds refuse → withdraw → rebind → mark →
  submit at the coordinator; a second withdrawal loses the CAS (the
  real-MySQL guard test of the CAS itself stays a follow-up with the
  store IT family).
- TS: every decline reason except `await_action` is produced from its
  journal state by a test (the `await_action` fixture and the
  route-level 202-replay watermark pin stay Step 3 debts); a transiently
  blocked authorization (`missing_state`) throws rather than declining
  while a durable verdict (`opaque_state`) goes terminal; a redriven
  takeover load re-answers from the attached state (200 with the
  recomputed report; plain repeats still meet
  `hosted_session_already_attached`), and a lost cancellation report
  cannot wedge the next re-answer (nothing is consumed).

E2E (runner arms, all against the packaged stack):

1. Baseline on `main`: the D8 arm fails with the generation error the
   README documented before this PR deleted that sentence, proving the test
   is load-bearing.
2. D8 Harness-only restart × three scenarios: idle next-Turn context,
   in-flight, continuation — existing assertions hold, `harness_boot_id`
   moves without a Spring restart.
3. D7 freeze arm: post-SIGCONT assertions as listed. Deleting any of them
   fails the arm.
4. CI: `hosted-harness-mysql` gains the D7 arm, the D8 arms and
   `--session-failover`, and the job ceiling moves from 60 to 120 minutes
   so the step ceilings sum to 104 (12 + 8×10 + 12, the workspace-output gates added their own step) plus the uncapped
   setup steps keep headroom.

The lost-reply race behind D4 (the old generation admits, its 202 reply is
dropped, the Harness restarts, and the Turn must complete with exactly one
journal admission for its `promptId`'s `command_id`) needs a new
submit-reply-dropping proxy between Spring and the Harness that the runner
does not have yet. It is a follow-up test arm, not part of this slice; the
backstop it would exercise is the store-level exact replay already covered
by `ManagedSessionStoreIntegrationTest`.

Acceptance = the #12952 G3 exit check: two successive owner generations
serve one Session with no operator-chosen affinity (D8 arms); a fenced
former owner cannot mutate the journal (D7 arm — the binding half is
scoped into Boundaries); a Session with no runnable engine still fails
closed and a Managed failure still causes no Legacy replay (unchanged
tests).

## Boundaries and open questions

- Sequential generations only. Two live owner pairs, graceful handoff,
  cross-host takeover → separate tracker (multi-instance control plane).
- The binding half of the Q2 exit check is unproven by D7:
  `managed_agent_session.harness_boot_id` moves only through a Spring,
  and D7's former Spring must die (the `/proc`-liveness reason in D7), so
  no current gate exercises a surviving former control plane trying to
  re-assert the older binding. Same follow-up tracker as the
  multi-instance work; #12952's Q2 stays open on this half.
- A Harness answer of 404 without the boot-ID header means the bootstrap
  delegating app has no runtime yet, so `HostedHarnessClient` classifies
  it as transport (transient), not a protocol defect. A permanently
  unstarted runtime therefore spends the pre-admission retry budget and
  the Turn ends `hosted_harness_unavailable`; Sessions already admitted
  keep the existing transport-retry semantics.
- The Broker side of a frozen former owner: #12964 tests and Broker fault
  gates, not D7.
- `#13054`: D5's pattern (typed decline → typed terminal turn outcome) is
  the answer its bound-Turn Workspace-refusal case should reuse; this design
  does not itself change Workspace-refusal handling.
- Step 3's model-round slice: the G1 design records that a _same-generation_
  retry after the first streamed chunk stays terminal
  (`cannot retract a published model attempt`); retraction exists only
  cross-generation. The slice must not weaken that.
- `await_action` settlement depends on the MCP profile's approval wiring;
  verify before relying on `managed-harness-factory.ts:541`.
- Harness-only arm on darwin: the Linux guard is dropped in code and the
  arm is expected to pass without the W0e reclaim, but every lane that
  runs it is Linux, so darwin stays unverified — recorded here as a gap,
  not gating anything.
- Nit found while mapping (not G3 work): the runner's Linux-guard message
  says "dead worker" where the reclaim actually retires an orphaned,
  still-alive worker's ownership. (The sibling nit — the stale step
  decomposition in `sdk-java.yml` — no longer applies: this PR rewrote that
  comment.)
