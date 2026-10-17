# Session relay fault gates (FG9)

[English](2026-10-15-session-relay-fault-gates.md) | [简体中文](2026-10-15-session-relay-fault-gates.zh-CN.md)

## Problem and scope

Issue #14164 is the FG9 slice of #12380's Stage F, split out of the #14054
umbrella: FG6/FG7/FG8-style multi-process fault gates for the two
relay-bearing domains enabled since FG7 — `session_message` (#13822, record
contract #13786) and `session_command` (#13928 / #13955 / #13974). Their
risk shape is new: **no OS process, but a side effect that crosses a Session
boundary and lands in another participant's durable journal.** A duplicated
member message is user-visible and cannot be retracted; a receipt that says
"reached" for a recipient who was never reached is a lie the record cannot
later correct. The relay's replay-stability rule (#13955) is exactly a
fault-gate subject — three replay-stable steps, each with a failure mode
that today only functional tests prove:

1. a committed inbound receipt answers again byte for byte;
2. the messages of each roster position already committed under the command
   id are probed first (`msgc_` = `sha256(lead \0 commandId \0 position)`),
   so a recipient reached on an earlier run is reported as reached and is
   never sent twice;
3. only then do the fresh admission gates apply (team membership, the
   running-unstopped head of the sender's chain).

This slice adds the gates, following the FG8 shape: one Java IT class with
in-JVM Spring, one probe serving the driver its JDBC ground truth, one
TypeScript fault driver owning the packaged Harness and the fault-injecting
proxy, a fault-fired witness per case, and a named mutation check per
letter. It touches **no production code**.

The semantics under gate, with their load-bearing lines at `main` =
`37f8e851c7` (verified 2026-10-15):

- A member's `send_message` rides a `session_command`: the member's own
  journal gains the outbound entry (`planned`) before the Turn parks —
  `acceptSessionCommand`
  (`packages/cli/src/serve/hosted-workspace-tool-turn.ts:5670-5730`,
  `commands.runCommand` at `:5723-5730`); the command id is
  `sessionCommandId` = `sha256(senderSessionId \0 promptKey \0 callId)`
  (`packages/core/src/managed-runtime/managed-session-command-operations.ts:32-40`).
  The parked wait polls every 250 ms, `COMMAND_WAIT_MS` = 2 minutes from
  the entry's own commit, and the decision-4 timeout lock is durable
  (`harnessCommandLocked` re-arms across restarts).
- The Java relay `SessionMessageRelay.workCommand`
  (`packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/SessionMessageRelay.java:487-598`)
  passes the command `planned → handover → execute → answered`: the lead's
  Harness runs `execute` /
  `executeMemberMessage`
  (`packages/cli/src/serve/hosted-session-command-session.ts:556-930`),
  which answers from the committed receipt first
  (`existingReply`, `:509-528`), then probes each roster position's
  `msgc_` record before sending (`:753-768`), mints each send through
  `sendToRunningMember` on the recipient's journal under
  `memberMessageId` (`packages/cli/src/serve/hosted-member-chain.ts:96-110`)
  keyed by the original `executionCallId` = commandId (`:887-907`), and
  commits its inbound receipt (`commitInboundReceipt`, `:462-507`) like a
  board write.
- One sender's commands pass strictly in order
  (`olderOpenCommand`, `SessionMessageRelayStore.java:199+`); a command
  whose sender already settled it terminal is classified, never executed
  twice — decision 2 at `SessionMessageRelay.java:535-542`.
- The send loop's honesty text: a `committed` position is reported
  `sent.` without a re-send (`hosted-session-command-session.ts:885-890`),
  an unreachable position names its reason
  (`notReachedText`, `:859-881`), the heading counts reached-of-N
  (`:895-902`), and the receipt is committed refused when nothing was
  reached.
- Cancellation of the minted-but-unrelayed window (re-verified for slice
  2 at `main` = `5af87595f3`): the parked wait's abort arm
  (`hosted-workspace-tool-turn.ts:5976-5984`) answers through
  `answerCommandByJournal` (`:6047-6117`), which settles a `planned`
  entry `cancelled` and an `accepting` one `unknown`, re-reading the
  journal when its settle loses a race (`settle`'s from-table,
  `hosted-session-command-session.ts:403-422`: `cancelled` only from
  `planned`); the relay discovers only `planned`, `accepting` and
  `unknown` entries (`HANDOVER_SQL`,
  `SessionMessageRelayStore.java:73-90`), and an entry it already
  claimed whose sender settled it terminal is classified without an
  execute (decision 2, `SessionMessageRelay.java:539-549`). The recovery
  side answers identically (`sessionCommandJournalAnswer`,
  `packages/cli/src/serve/hosted-runtime-recovery.ts:1180-1225`).
- SSE: the public stream resumes by `Last-Event-ID` / `after`
  (`PublicAgentController.java:198-218`, `parseSequence` `:291`), the
  WebShell stream by `afterSequence` (`WebShellAgentController.java:131-140`);
  both replay through the one `streamEvents` read
  (`ManagedAgentService.java:1621-1624`) and then tail the live hub.
- Ground-truth tables: `ma_session_record` (journal: `domain`,
  `record_id` = `cmd_`/`msgc_`, `revision`, `delivery_state`,
  `record_resource_id`) and `ma_delivery` (relay ledger:
  `transport_state`, `claim_generation`, `attempt_count`,
  `available_at`, `last_error`), both in
  `packages/managed-agent-server/src/main/resources/db/managed-schema/V1__managed_schema.sql:285-325`,
  `:943-981`.

## Current state

- `MANAGED_SESSION_ENABLED_DOMAINS` holds both gated domains with their
  enabling comments: `session_message` — "H4d-b: produced by send_message
  and the control plane's relay" — and `session_command` — "H4e-b3:
  produced by member board tools and the control plane's relay"
  (`packages/core/src/managed-runtime/managed-session-records.ts:141-146`).
  `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS` is
  `Object.freeze(['email'])` (`:265-267`), so nothing here assumes a
  second provider, and `MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` is
  `true` (`:241`), so a continuation is a legal shape for a relayed run.
- The domain-level fault coverage that exists today is channel-only
  (FG7) plus `monitor_run`/background-shell (FG8). The five hosted
  fault-gate suites contain zero occurrences of `session_command` or
  `session_message` replay/fan-out injections (the #14054 keyword check,
  reproduced here at `37f8e851c7`).
- The replay-stable semantics the letters pin are today proved only by
  functional tests:
  `packages/cli/src/serve/hosted-session-command-session.test.ts`
  — receipt re-answer (`:1002`), receipt conflict (`:1033`),
  probe-before-send (`:1350`), roster-changed re-execution (`:1376`),
  `*` fan-out (`:1100`), reached/unreached text (`:1122-1191`);
  `HostedTeamMemberCommandMySqlIT` covers the board-command pass
  end to end on MySQL, including a parked member whose Harness dies and
  whose wait a new worker wakes.
- The lane machinery FG9 reuses (all delivered by FG8, #14120): the
  in-JVM Spring + packaged Harness fixture with per-case evidence under
  `target/fgN-cases/`, the per-letter selectors `-Dqwen.fgNa.case`, the
  probe-serves-JDBC discipline, the store-fronting lose-once/hold proxy
  (FG8f), the dual-surface SSE `Observer` (FG8e), the FG7b SQL-trigger
  DDL shape for store failures, `hosted-relay-headers.test.ts`'s roster
  witness, `check-failsafe-reports.js hosted`, and the
  `hosted-harness-mysql` lane with its budget pins in
  `scripts/tests/hosted-process-ci.test.js`.

## Scope decisions

1. **FG9 only; three landing slices.** The sibling rounds (FG8's
   remaining slices on #14163, FG10 on #14165), the `team_state` /
   `team_task` storage-failure fold into `HostedTeamLeadMySqlIT` /
   `HostedTeamMemberCommandMySqlIT`, and the `team_message`/`team_plan`
   deliberately-disabled record bodies all stay out (tracked on #14054).
   The slices land in this order, each its own PR in the FG8 shape:

   | Slice | Letters        | Waits for                                                                                                                                | Why                                                                                                                                                                                                          |
   | ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | 1     | **FG9a, FG9f** | nothing                                                                                                                                  | The round's owed semantics — probe-before-send and answer honesty under lost replies — with no in-flight PR touching them.                                                                                   |
   | 2     | **FG9d, FG9e** | nothing; ordered second only to bound slice size                                                                                         | Cancellation and SSE-gap letters reuse the slice-1 fixture, adding the H4e-b3 relay hold, a second proxy in front of the public API and an in-JVM port of the FG8e observer (see _Fixture design_).          |
   | 3     | **FG9b, FG9c** | **#13918** (InnoDB lock guard convoy) and **#13986** (restart-proof held-Runtime drain) — both merged since (`53a24a5ddf`, `c24e99e9cb`) | FG9b's markers assert the store-failure error taxonomy #13918 rewrites; FG9c's member/lead restart arms pin cold-load recovery the held-Runtime backfill (#13986) is reshaping. Same waiters as FG8 slice 3. |

   The gate ledger below specifies all six letters so the round is
   reviewable as one design; each slice's PR implements its letters and
   marks them delivered on the tracker. A letter's injection points and
   assertions are re-verified against the merged prerequisites when its
   slice lands.

2. **One IT class; no Spring kill; per-letter selectors.** All six
   letters live in `HostedSessionRelayFaultGatesIT` with in-JVM Spring,
   `-Dqwen.fg9a.case` … `-Dqwen.fg9f.case`, a shared
   `HostedSessionRelayProbe`, and evidence under
   `target/fg9-cases/<letter>/<case>/` rebuilt per letter. FG9c kills the
   packaged Harness only — never the Spring control plane — so its POSIX
   signals confine it to Linux/macOS, same as FG6c/FG7c/FG8c.

3. **Per-class private copies, swept later by #14147.** The lane's
   deliberate convention (FG6e, the FG7 drivers, FG8 #14120) is a
   per-class private copy of the observer/proxy/authentication helpers;
   #14147 (`status/blocked`) owns the one-PR sweep that moves every gate
   class together. FG9 follows the convention — a new private copy joins
   the sweep — because #14147's own note holds that a half-extraction is
   worse than the copies, and the sweep deliberately waits until no new
   copies are being written. The #14164 body's "land after #14147" note
   is recorded as overridden by this ordering, which is the same call
   #14120 made.

4. **#14062 / #14063 are pinned as fixture constraints, not regressed.**
   #14062 (`encodeToolInput` overflow is thrown, not refused): every
   scripted relay message stays well inside `maxBytes`, so no arm
   exercises the thrown-overhead path. #14063 (a re-send in a _later_
   Turn mints a fresh command id and duplicates): FG9f arms re-drive only
   the _same_ command id (same prompt key, same call id, across faults
   and restarts); the fresh-command-id duplicate shape is never scripted,
   and no assertion contradicts the current behavior there. Neither bug
   is fixed here; neither is papered over. #14063 has since closed with
   #14296 (`9280ef9845`), which corrected the member-message timeout
   guidance; FG9d asserts the corrected answer texts verbatim, and the
   fresh-command-id shape stays unscripted. #14062 is still open.

5. **#13339 discipline.** The lane has no quarantine or retry mechanism.
   FG9 therefore: (a) adds only the new `Hosted*IT` class and never
   modifies `HostedWorkspaceToolTurnIT`; (b) gives every case a
   fault-fired witness (drop counters, `fg9b_fire` counts, held kill
   points,
   the aborted stream's unread proof, JDBC rows committed beyond the
   resume cursor) so a gate can never go silently green; (c) scopes all
   JDBC mutations (seeds, triggers) to the case tenant; (d) keeps the
   FG8 fixture lessons — the watch's idle window outlives the 60 s
   events poll, and producers whose stop is asserted never exit on their
   own.

6. **Closeability is stated on the tracker.** One PR per slice; #14164
   closes with slice 3. The triage thread asked for exactly this
   statement (#12872's tracker outlived its own delivery); each slice PR
   records its letters' delivery in an #14164 comment.

## The gate ledger

Ground truth is JDBC over the `ma_session_record` journal rows
(`session_command` and `session_message` domains), the `ma_delivery`
relay ledger, the public-event ledger for FG9e, and the captured Spring
and Harness logs. Every case asserts its fault actually fired:
`FG9_DROPPED <what>` / `FG9_HELD <what>` proxy counters and the commit
log (FG9a, FG9d, FG9f), the trigger's own fire count in `fg9b_fire`
(FG9b), the held commit the kill lands on (FG9c), or the
resume-cursor JDBC witness (FG9e). `one row` always means the journal
holds exactly one record with that id at its expected revision; the
sender's view is compared against the committed receipts byte for byte
(`sessionCommandReplyBytes`,
`managed-session-command-operations.ts:205-208`).

The shared fixture (all letters): a scripted-model lead creates one team
and launches three members — alice, bob, carol — on the packaged
Harness; alice's scripted `send_message` calls are the relay traffic.
Named sends go to bob; the `*` broadcast fans out to bob and carol
(alice is never her own recipient,
`hosted-session-command-session.ts:815-855`).

### FG9a — lost replies (slice 1)

One lose-once **store proxy** fronts the Session-Store base URL; the
Harness connection stays direct — the axis decision taken at landing
(see _Fixture design_). The proxies are in-JVM fixtures, defaulting to
pass-through and armed per case by commit/verb shape — the journal
transaction's operation name and the record id prefix (`cmd_` =
outbound command, `msgc_` = minted member message; operation verbs
`sendSessionCommand` / `commitSessionCommandReceipt` /
`sendSessionMessage` / execute kind). A lost reply forwards the request,
consumes the committed upstream response, then destroys the reply; the
client's bounded uncertain-error retry re-drives by the original
transaction identity. Each retry resolves through the original command
id and roster position.

| Case                     | Injection                                                                                           | Expect                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admission-commit-reply` | Drop the reply to alice's outbound `session_command` commit (`planned`) after the commit landed     | Exactly one `session_command` row for the command id (never two mints), one `ma_delivery` row; the relay hands over, the fan-out completes, the answer returns; the member's turn settles once                                                           |
| `receipt-commit-reply`   | Drop the reply to the lead's inbound-receipt commit after it landed                                 | Exactly one receipt at revision 1 on the lead's journal; the relay's `answered` copy is byte-identical to the receipt's `replyRef` bytes; the member's consumed answer equals the committed reply, never a paraphrase                                    |
| `fanout-step-reply`      | During a `*` broadcast, drop the reply to one roster position's `msgc_` mint commit after it landed | Exactly one `msgc_` row per position (no double mint); both recipients deliver exactly once (one `accepted` + one `consumed` per recipient journal); the receipt names every position's outcome; the send loop's `sent` count matches the committed rows |

The fourth draft case, `execute-reply-lost` (a harness-fronted drop of
the `execute` verb's response), was removed at landing: it was the only
case that needed the harness proxy, whose warm/createOrLoad poison the
axis probes pinned, and the durable-identity assertions it staged are
already pinned by the three store-boundary cases — each of them loses a
reply to a commit whose retry must resolve through the original
transaction identity (mint-reply, receipt-reply, fanout mint-reply).
Step 2 (probe-before-send) is exercised under a real kill in slice 3
(`lead-kill-mid-fanout`), because no reply manipulation alone can
strand a command minted-but-unreceipted — the relay retry always finds
step 1 first; the slice records this mechanics note instead of staging
a sham.

### FG9f — partial broadcast (slice 1)

The `*` fan-out is the only place in this capability where one command
produces N cross-Session effects, so it is the only place "at most once
per recipient" can fail while every individual step looks correct. These
cases make the fan-out's answer ambiguous the three ways the issue
names, all on the slice-1 fixture.

| Case                 | Injection                                                                                                                                                  | Expect                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `partial-timeout`    | Hold the second `sendSessionMessage` commit (carol's `msgc_` mint) past the point the relay attempt fails, then release after the retry evidence lands     | A position minted on the earlier attempt is reported `sent.` and is not sent twice — exactly one `msgc_` row per position; the held position is sent on the re-run and delivered once; the sender's settled answer equals the committed receipts' exact bytes; the attempt counter and the `holding carol-mint` proxy witness prove the hold-and-retry shape |
| `roster-changed`     | A recipient's member run finishes (scripted DONE carol) between the execute attempt and the relay's delivery, while the live position (bob) stays attached | Exactly one `msgc_` row (bob's; carol is refused before any mint); the receipt reads `1 of 2` with `- bob: sent.` and `- carol: not reached: it has finished; the leader may give it more work, a peer cannot.`, never silently skipped; the sender's view matches the committed receipts exactly                                                            |
| `recipient-stopping` | A recipient is `stopRequested` on an attached run (carol WAIT; the scripted `request_shutdown` is gated on her first model contact) before the send        | Exactly one `msgc_` row (bob's); the position whose head is stopping is answered `- carol: not reached: it is being stopped.`, never silently skipped; the recipient's cancelled run carries zero fabricated delivery; nothing is re-minted on the re-run                                                                                                    |

`roster-changed` and `recipient-stopping` pin the honesty of the
_answer text_ under stale roster and a stopping head — the two places a
bug reports `reached` when it did not, or silently drops a position
from the report.

### FG9d — cancellation (slice 2, delivered)

The cancel is the public `agent.session.cancel` on alice's own Session:
admitted durably as `CANCELLING` with one `turn.cancel.requested`, then
carried to the Harness by the coordinator, which aborts her parked wait;
the wait's journal answer (`answerCommandByJournal`) decides what the
call is told and what the entry becomes. The cases pin the two windows
in which that answer can be wrong: before the relay's first claim, held
with the H4e-b3 relay hold, and while the handover commit is in flight.

| Case                     | Injection                                                                                                                                                                                                                        | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cancel-after-mint`      | Hold the relay before alice sends; cancel her Turn once her command committed `planned`                                                                                                                                          | The send never left: the entry settles `cancelled` at revision 2 with no reply; alice's call is answered once, with the not-sent text; no receipt on the lead, no `msgc_`, nothing on bob's journal; the Turn ends `CANCELLED` with one `turn.cancel.requested` and one `turn.cancelled`; and the relay never claims the command — zero ledger rows for it once every other delivery settled, because its discovery reads only `planned`, `accepting` and `unknown` entries                                                                                                                                                                                                                                                                                                                                                          |
| `cancel-reply-lost`      | The same window, with the cancel POST sent through a second lose-once proxy in front of the public API, which drops its reply after it committed; the client re-issues the same cancel under the same `Idempotency-Key` directly | The re-issue answers `202` `replayed: true` for the same Turn; one request receipt for the key; one `turn.cancel.requested` and one `turn.cancelled` — no duplicate cancellation; and every `cancel-after-mint` expectation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cancel-during-handover` | Hold the reply of the relay's handover commit (`commitSessionCommand`, revision 2 on alice's journal) at the store proxy; cancel her Turn; release it 2 s after the durable `CANCELLING`                                         | The Harness answers the cancel only after the held commit (its cancel route's duration covers the hold), so the abort reads the handed-over entry and can no longer withdraw it — never both "not sent" and a delivery: the entry never reads `cancelled`; it walks planned → accepting → unknown (the cancel's settle) → accepted (the receipt copied back), revision 4; alice's call is answered once, with the reached-the-leader text; one receipt at revision 1, whose reply alice holds byte for byte. The relay's execute races alice's run settling after the cancel, and the receipt says which arm it took: answered `Message sent to bob.` with one `msgc_` delivered and consumed once, or refused `Your run has ended or is being stopped; …` with none — both honest, and the gate asserts whichever the receipt names |

Mechanics notes recorded at landing:

- A command withdrawn before the relay's first claim never enters the
  ledger at all: the slice-1 draft's "the relay classifies the ledger row
  `done`" holds only for a command the relay already claimed (decision
  2), which no reply manipulation in this window produces. The gate
  asserts the zero-row shape, read after every other delivery of the
  case settled.
- The Harness orders a cancel behind the Session's in-flight store
  commit: its cancel route answered only once the held handover reply
  was released (2.3–3.3 s across the landing runs, each covering the
  beat the case holds the reply past the cancel). So with the handover
  commit in flight the abort always reads the handed-over entry, and its
  journal answer settles `unknown`; the gate witnesses the overlap from
  the Harness's own request log (the cancel route's `durationMs` ≥
  1.5 s). The reverse window — the cancel's settle in flight when the
  relay arrives — is not reachable at the store boundary: the settle's
  commit lands before its reply is held, and the relay decides by
  committed state (it discovers only `planned`, `accepting` and
  `unknown` entries and re-reads the record right after its claim), so
  an in-flight settle is `cancel-after-mint`'s zero-claim shape.

### FG9e — SSE gap (slice 2, delivered)

Two cases instead of the draft's four: each observes one `*` broadcast on
one surface from both of its ends — the sender (alice) and a recipient
(bob) — because both ends ride the same relay and the same team boot,
and the fork budget (#14148) pays for every team boot. The public and
WebShell streams are served by the in-JVM Spring; the injection is the
client's own abort (its HttpClient's `shutdownNow`) and resume, so the
letter needs no proxy. Each stream is cut only once its client holds
every committed event, resumes only after JDBC proves events committed
beyond its cursor, and the client's whole view (the cut frames, then the
resumed ones) must be one sequence from 1 with no gap and no duplicate,
frame for frame the committed row as that surface serves it.

| Case              | Injection                                                                                                                                                                                                                                                                                                | Expect                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-resume`   | Hold the relay; open alice's and bob's public streams; cut alice's once her command is `planned`, then release the relay, so the whole relay runs while she is disconnected; cut bob's once both `msgc_` are minted and before his delivery; let every delivery settle; resume both with `Last-Event-ID` | Nothing relayed before alice's cut (no `msgc_`) and nothing on bob's journal at his; both Sessions committed events beyond their cursors while cut; both resumed views continuous and exactly the ledger (snake_case, second `created_at`); alice's Turn terminal once and her post-relay answer once; bob's launch Turn terminal once |
| `webshell-resume` | Same over the WebShell stream, resumed with `afterSequence`                                                                                                                                                                                                                                              | Same over the WebShell envelope (camelCase, millisecond `createdAt`)                                                                                                                                                                                                                                                                   |

Mechanics notes recorded at landing:

- The Turn that reads a relayed message is the Harness's own wake Turn
  and is not projected to the public ledger, so a recipient's stream
  carries no projection of the message itself: bob's tail is his launch
  Turn ending after his latch releases, while his delivery and
  consumption land (JDBC) during the cut. The draft's "the recipient's
  consumption event appears exactly once" has no event to count; the
  recipient end pins instead that a stream cut across its delivery
  resumes with no gap and no duplicate, frame for frame its ledger. The
  sender's end is the relay-dependent one: her Turn's tail commits only
  after the relay answered.
- The expired-cursor `resync_required` arm (open question 3) is not
  armed: the resync answer belongs to the Session stream's replay floor,
  whichever capability produced the events, and the FG8 tracker
  (#14163) owns that one case (`cursor-expired-resync`), which its
  design deferred and its slice 2 (#14334) has not yet delivered.

### FG9b — store failures (slice 3, delivered)

The fault is a test-only trigger on `ma_session_record`, scoped to the
case tenant, one Session and one record shape, refusing every matching
write until the case drops it — the FG8b shape, with each fire also
counted in a MyISAM side table, since Spring flattens the `SIGNAL` into a
500 `internal_error` and the `FG9B_<CASE>` text never leaves its own log.
The draft's one-shot arm never reaches the Session: the store client's
bounded uncertain-error retry (three attempts, 250 ms apart) heals it
inside the commit call. Past the third refusal the Session's authority
latches its writes (`writesStopped` — the refused transaction's sequences
may already be on disk), and a latched writer admits no retry at all:
dropping the trigger heals nothing. Each case therefore drops the trigger
and restarts the Harness cold, and what it pins is the cold load's
healing — through the original command, never a second entry, mint or
receipt. The lead's own Turn has settled before every arm, and bob and
carol stay parked on their model latches across it (see _Fixture
design_).

| Case                      | Injection                                                                       | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbound-commit-refused` | Refuse the insert of alice's outbound `session_command` (`planned`)             | While latched: the trigger fired exactly three times; the Harness logs her Turn `recovery blocked: ManagedSessionWritesStoppedError`; no entry, no ledger row, no answer, and the Turn stays `RUNNING` rather than settling over its call. After the drop and a cold restart (a new writer generation holds her Session): her parked call is answered once, from the journal, with the not-sent text; her journal still holds no `session_command` and the store accepted no `sendSessionCommand` commit for her at all — answered, never minted afresh; no receipt, no `msgc_`, nothing on bob's journal |
| `receipt-commit-refused`  | Refuse the insert of the lead's inbound receipt                                 | The execute probed bob's position and minted it before its receipt, so the Harness logs the execute `failed in its store` (503 `session_command_failed`) with one `msgc_` and no receipt; alice's entry stays `accepting`, unanswered. After the lead's cold load the relay's retry re-executes: the probe finds the minted position — one `sendSessionMessage` commit on the lead across the whole case — and the one receipt answers `Message sent to bob.\n- bob: sent.`, which alice holds; one delivery to bob                                                                                       |
| `answered-commit-refused` | Refuse the `accepted` write on alice's entry — the relay's `answered` copy-back | The lead's half is durable (its receipt and bob's `msgc_`) while alice's entry stays `accepting`, unanswered. After her cold load the relay's retry re-executes into the stored receipt — no second receipt commit, no second mint — and copies it back once: her entry walks planned → accepting → accepted → consumed (revision 4), holding the receipt's reply byte for byte, and her call is answered once                                                                                                                                                                                            |

Mechanics notes recorded at landing:

- A refused journal commit latches the whole Session's authority, not
  just the call ("a stopped writer admits no retry at all; a blocked
  Session never recovers alone"). Nothing in the relay heals it; the
  draft's "after the harness reloads" is the only healing, and the
  receipt case's "the relay re-drives once the trigger drops" happens
  only after it. Meanwhile the relay keeps retrying with backoff: the
  message relay spends an attempt on each `writes_stopped` refusal
  (1 s doubling to the 300 s cap), so a latch left alone for a minute
  pushes the next retry out by minutes. Each case restarts within
  seconds of the third fire.
- The `answered` verb mislabels a store failure. `runCommandOperation`'s
  `answered` arm answers `ManagedSessionRecordError` as an invalid
  request, and both the store's `ManagedSessionStoreHttpError` and the
  latch's `ManagedSessionWritesStoppedError` extend it — so the relay
  reads 400 `invalid_command_operation`, with no stderr line, where
  `execute` answers 503 `session_command_failed`. The relay defers
  either the same way and delivery is unaffected; the gate pins the
  outcome, not the code, and the mislabel is tracked separately (#14419).
- A Turn still open on the lead when its Session latched or its Harness
  died kept the workspace its dead owner held: in the probes the cold
  lead churned on `workspace_unavailable` and
  `hosted_session_already_attached` (writer generation 2 → 12 within two
  minutes), executed nothing, and alice's wait ran out into `unknown`.
  The fixture's lead used to answer its closing round with empty text,
  which the model client retries for ~20 s, so its Turn was still open
  when the arm fired; see _Fixture design_ for the fix and the settle
  wait.

### FG9c — process crashes (slice 3, delivered)

POSIX-only. The case SIGKILLs the packaged Harness and its descendants —
every team Session it hosts dies with it — and starts a cold one (new
`HOME`/`QWEN_HOME`) on the same port; a new writer generation on the
Session under test is the takeover's witness. Each kill lands on a commit
the store accepted whose reply the store proxy holds, so the dead process
never learned it landed: the sharpest window of each step. bob and carol
stay parked on their model latches across the kill, and their re-driven
rounds are the ones that count.

| Case                     | Injection                                                                                                                                                                                   | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead-kill-mid-fanout`   | A `*` broadcast to bob and carol; hold the reply of the lead's first `sendSessionMessage` commit; SIGKILL the Harness while it is held; restart cold                                        | At the kill one `msgc_` committed and no receipt. After the lead's cold load the relay's retry re-executes: the probe reports the first position `sent.` from the journal and mints only the second — two `sendSessionMessage` commits across the case, one per position — and the one receipt answers `Message sent to every other member of team "review".\n- bob: sent.\n- carol: sent.`, which alice holds; each recipient delivers and consumes once |
| `member-kill-after-mint` | Hold the relay; hold the reply of alice's `sendSessionCommand` commit; SIGKILL the Harness while it is held; restart cold; release the relay once a new writer generation holds her Session | The entry the dead process never acknowledged is the one command: the same id, one `sendSessionCommand` commit across the case, revision 4 (planned → accepting → accepted → consumed). The takeover resumed her parked wait from the journal, and her call is answered once, `Message sent to bob.\n- bob: sent.`; one `msgc_`, one delivery                                                                                                             |

Mechanics notes recorded at landing:

- The H4e-b3 restart case (`memberHarnessRestartDuringCommandWait`)
  kills after the planned entry was acknowledged and the wait parked;
  `member-kill-after-mint` moves the kill into the commit's own reply,
  the window in which only the journal knows the entry exists. The park
  is committed before the outbound, so the takeover resumes it through
  `resumeCommandWaitRuns`, which reads the journal and never calls
  `runCommand` again; a park whose outbound never committed takes that
  function's never-committed arm instead, which is the arm FG9b's
  `outbound-commit-refused` reaches.
- Members killed mid-model-round are not lost: the coordinator re-drives
  their round on the new generation, and the killed round's exchange
  returns into a dead connection once its latch opens, which the model
  fixture ignores by Harness generation.

## Fixture design

**Shape decision: the H4e-b3 Java IT, not the FG8 driver+probe split.**
FG9's traffic is the relay itself — scripted model tool calls, JDBC
seeds, public-API cancels and inputs, harness kills and restarts — and
that entire choreography already exists in Java:
`HostedTeamMemberCommandMySqlIT` (team bootstrap, scripted members,
relay hold, harness-kill takeover) and `HostedTeamLeadMySqlIT`. The
FG7/FG8 drivers exist because those rounds needed things Java cannot do
well — real `node -e` background producers, FIFOs, SIGSTOP of an OS
worker, channel adapter recording. FG9 needs none of those; the only
outside world it must rig is two HTTP boundaries, and both can be rigged
inside the gate JVM. A Java-only fixture keeps every stale-proof latch
in-process and removes the whole driver↔probe results protocol
(driver.json, `FG9_CASE_OK` markers, results files) — no
`hosted-…-driver.ts`, so the `hosted-relay-headers.test.ts` roster
witness is untouched and #14147's sweep list does not grow.

`HostedSessionRelayFaultGatesIT` starts one in-JVM
`ManagedAgentServerApplication` per letter the way the H4e ITs do
(MySQL properties mandatory — absence fails, not skips; embedded broker
on a pinned port; `temporary`-scoped runtime state). Spring boots once
per letter; the cases of a letter run sequentially on that stack, each
with a fresh tenant, a fresh team (lead + alice + bob + carol) and a
fresh case directory under `target/fg9-cases/<letter>/<case>/` (the FG7
lesson: evidence in `@TempDir` evaporates) — harness logs, proxy logs
and the case's arming plan land there. Per-letter selectors
`-Dqwen.fg9a.case` … restrict a letter to one case (FG8 shape).

**The scripted model** is the H4e-b3 choreography with FG9's call set:
the lead's plan — `team_create`, then `agent` launches for alice, bob,
carol in birth order (a launch beside a team create is its batch
refusal), and nothing else unless a case asks; each member's plan is
marker-driven off the member launch prompt — alice's plan carries the
case's `send_message` calls (named bob, or `"*"` for the broadcast
cases; a second call when a case needs two sends), bob stays parked
running for most cases, carol carries the per-case profile — quick
finish (roster-changed), hold-until-release (partial-timeout), or
stopping via a scripted lead `request_shutdown`
(receipt-never-arrives). Wakes that arrive beside a busy Turn ride its
followUp, so member reports are sequenced the way the H4e-b3 javadoc
documents.

**One in-JVM lose-once/hold HTTP proxy** rigs the only boundary the
letters need — the Session-Store — and the Harness connection stays
direct (the landing's axis-A decision):

- the **store proxy** fronts the Session-Store: every harness-hosted
  Session's `managedSessionStore` connection is pointed at it via the
  Spring property `--qwen.managed-agent.session-store.base-url`, with
  the proxy forwarding to the real Spring port. It parses each request
  (method, path, JSON body) and arms by commit shape — the journal
  transaction's operation name (`sendSessionCommand`,
  `commitSessionCommandReceipt`, `sendSessionMessage`) over the
  `/transactions:commit[-v2]` endpoints, with an occurrence counter on
  the rule itself (a DROP fires on the first N matching requests, a
  HOLD only on the Nth).
- the **harness connection is direct**: the axis probes ruled a
  harness-fronted proxy out — a proxied warm/createOrLoad chain hands
  the connector nothing but resident-vs-attach conflicts
  (`hosted_session_already_attached`, `managed_session_writer_conflict`)
  while the same wiring direct completes every team — and nothing
  slice 1 stages needs a harness-side drop point at all.

The proxy logs every armed operation by name (`PROXY passthru|armed|
dropped|holding|release|released <rule>`); those lines are the
fault-fired witnesses the letters assert with `countOps`. Production
timeouts stay at their defaults except FG9f's `partial-timeout`, where
`qwen.managed-agent.harness.request-timeout` is lowered to 3 s for the
letter so the held mint forces a relay-side timeout-and-retry quickly,
and FG9e's stream heartbeat (below).

**Slice 2 additions.** Five pieces, all inside the gate JVM:

- the **relay hold** is the H4e-b3 one: `SchedulerHold` parks a task on
  the one-thread `messageRelayScheduler`, so no scan — and with it no
  claim or handover — runs until the case releases it; FG9d's
  `cancel-after-mint` / `cancel-reply-lost` and both FG9e cases take it
  before alice sends;
- a **second proxy instance** fronts the public API for the client's own
  cancel POST in `cancel-reply-lost` only (everything else talks to
  Spring directly), with the same drop-after-commit disposition;
- the **observer** is an in-JVM port of FG8e's: one HttpClient per
  stream (HTTP/1.1), so a cut is that client's `shutdownNow`; it checks
  each frame's SSE `id`/`event` against its payload's
  `sequence`/`type`, and the comparison maps each ledger row the way
  the surface serves it (snake_case and seconds publicly, camelCase and
  milliseconds on the WebShell, nulls omitted). The authentication
  filter now covers `/api/agent/web-shell/v1/*` and async dispatch, as
  FG8's does;
- FG9e runs the stream heartbeat at 2 s. A stream the client cut stays
  open server-side until its next write fails, and an open stream holds
  Spring's graceful shutdown for its whole 30 s window; FG8e's 60 s
  events poll/heartbeat is not reused, since the resumed views here are
  almost entirely replay and a long heartbeat only keeps cut streams
  alive;
- Spring and the embedded broker bind ephemeral ports that are read back
  after boot, and both proxies take their upstream only then: the first
  full-class run found Spring's pre-picked port taken by the time Spring
  bound it (`PortInUseException`) — any ephemeral bind or connection
  between the pick and Spring's own bind can take it, and the second
  proxy adds one more. The Harness port is still picked
  ahead, as in the sibling H4e ITs, because Spring's connector is
  configured with it before the Harness starts.

**Witness-then-release choreography.** The slice's hardest ordering
productions — recorded alongside the landing, since each cost its own
probe round: a peer send to a finished member is refused before any
mint lands (`not reached: it has finished; the leader may give it more
work, a peer cannot.` for a broadcast); a member parked on a scripted
model latch still accepts mints while its deliveries retry with
`session_message_not_ready`. The fixture therefore holds bob/carol WAIT
on per-case latches through each case's own mint witness
(`awaitMsgcMinted` on the `msgc_` rows themselves) and releases them
only afterwards, so every position mints while alive and the chain
still settles; the scripted `request_shutdown` for `recipient-stopping`
holds at the lead's plan until the target's first model contact (the
`stophit` latch), because cancelling a not-started run is honest data
but no contact, and the case's roster gate waits for the contact
forever otherwise; the member-session lookup reads `childSessionId` at
the child-run record body's _top_ level, the widened contract's shape,
and slice 2, which reads a member Session before any relay work, waits
for that attach to land, since it can trail the member's first model
call;
and `settleAndCheckDelivered` scopes its terminal-set poll to
`delivery_kind = 'SESSION_MESSAGE'`, because the three child-launch
`<childRunId>` deliveries stay `delivered` by construction once the
scripted lead completes before the latched members — orchestration
bookkeeping, not relay work the case owes.

**Store-failure triggers** (slice 3, FG9b) follow FG8b rather than
FG7b: a `BEFORE INSERT` or `BEFORE UPDATE` trigger on `ma_session_record`
whose condition names the case tenant, the Session, the `session_command`
domain and, for the copy-back, `NEW.delivery_state = 'accepted'`; it
inserts the case name into the MyISAM `fg9b_fire` table and then
`SIGNAL SQLSTATE '45000'` with the text `FG9B_<CASE>`. Spring answers the
store client a 500 (`internal_error`), so the fire count is the
attribution. The case drops its trigger before the restart; teardown
drops any left over and the side table.

**Kill arms** (slice 3, FG9c, and FG9b's cold restart) are the H4e-b3
restart mechanics: the Harness's descendants and then the Harness itself
`destroyForcibly()`, a fresh `startHarness()` on the same port (new
`HOME`/`QWEN_HOME` — genuinely cold), and the writer-generation
takeover witness on the Session under test. `member-kill-after-mint`
keeps the relay held across the kill and releases it only after the
takeover, as H4e-b3 does. POSIX only; every letter keeps
`@Timeout(600)`.

**Slice 3 additions.** Four pieces, all inside the gate JVM:

- the lead's **closing round answers with text** (`LEAD_REPORT done`)
  instead of an empty response, which the model client retries four
  times (2.5–8.2 s apart, ~20 s in all) before it settles the Turn, so
  the lead's Turn — and every wake Turn that reads a member's result —
  used to stay open for that long. Slices 1 and 2 never depended on it;
  the full class is re-measured green with it;
- FG9b and FG9c **wait for the lead's Turn to settle**
  (`awaitLeadSettled`) before arming, and keep bob and carol on WAIT
  across the arm, so no lead Turn is open in the fault window;
- the store proxy now logs each commit's `op=<operation>` and the
  upstream `status=`, and `journalCommits(session, operation)` counts
  the commits the store accepted. It is the "never minted twice"
  witness: `ma_session_record` keeps one row per record id, and a
  re-mint under the same id would leave no second row behind;
- the Harness log is appended across restarts, and each restart bumps a
  generation the model fixture uses to ignore the dead exchanges of the
  rounds the kill interrupted.

**CI.** The class name places it in the `hosted-harness-mysql` lane
(`Hosted*IT` include; `check-failsafe-reports.js hosted` enforces it
ran). The update set, in one diff per slice:

- `.github/workflows/sdk-java.yml` — `target/fg9-cases/` joins the
  report-upload paths next to `fg7-cases/` and `fg8-cases/`.
- `scripts/tests/hosted-process-ci.test.js` — the new class's
  per-method `@Timeout` budget is pinned with the FG8 precedent
  (`@Timeout` + healthy allowance ≤ fork budget), and any moved
  lane budgets (fork / Verify step / job) change in the same diff as
  the yaml, re-measured with the new class green.
- `packages/managed-agent-server/pom.xml` — a
  `hosted-session-relay-gates` focused profile copies
  `hosted-monitor-run-gates` for local runs.

Slice 2 moves only the healthy allowance, re-measured with the four-letter
class green (308–314 s healthy locally across three runs, ~534 s budgeted
at the same 1.7×, up from slice 1's ~300 s): 2400→2640 s. The hosted fork,
which #14334 raised to 3600 s for the five FG8 letters, already covers one
600 s ceiling plus that runtime (3240 s), so the fork, the Verify step and
the job ceiling stay where #14334 left them.

Slice 3 re-measures the six-letter class at 528–557 s healthy locally
across three runs (FG9b 129–137 s, FG9c 100–109 s; the four earlier
letters unchanged at ~310 s, as on lane run 38957583765, whose class ran
310 s), ~950 s budgeted at the same 1.7×, ~416 s over slice 2's ~534 s.
The allowance composes with the letters that moved it while this slice
was open — FG8c's crash letter (#14407, 2640→2930 s) and FG10a's workflow
digest letter (#14390, 2930→2963 s): 2963 − 534 + 950 ≈ 3380 s. One 600 s
ceiling plus that no longer fits the 3600 s fork, so the fork moves
3600→3990 s; the Verify step, which must wrap the fork plus its 600 s,
moves 75→80 minutes (210 s of margin), and the job ceiling 320→325 to stay
above the summed step ceilings (310) plus the uncapped setup steps.

## Mutation checks

Each mutation is applied, shown to turn exactly its gate red, then
reverted, following the FG6/FG7/FG8 documented manual procedure. The
slice-1 mutations below are committed with this design; slices 2 and 3
follow them.

1. FG9a — the store client's uncertain-error retry mints a fresh
   transaction identity instead of re-driving the original:
   `admission-commit-reply` red (a second `session_command` row or a
   refused duplicate).
2. FG9f — `executeMemberMessage`'s committed-position probe neutralized
   (the `committed` set always empty): `partial-timeout` red — the
   earlier position is minted again (a second `msgc_` row for it, or the
   mint's idempotency conflict surfaces in the send loop).
3. FG9f — the not-reached text omitted from the receipt (unreached
   positions silently dropped from the report): `roster-changed` red at
   the named-reason assertion.
4. FG9a — `existingReply` bypassed (an `execute` always runs fresh
   steps): `receipt-commit-reply` red — the receipt re-commits (a
   second revision) or the answer bytes diverge byte for byte.

Slice 2, each run against its case alone (`-Dqwen.fg9d.case` /
`-Dqwen.fg9e.case`); the two Harness-side mutations patch the packaged
bundle's chunk in place and restore it byte for byte:

5. FG9d — the cancel's journal answer still says "not sent" but leaves
   the entry `planned` (the `planned` arm's `settle(…, 'cancelled')`
   dropped): `cancel-after-mint` red — the entry stays `planned` and
   never settles `cancelled`, so a released relay would hand it over.
6. FG9d — the cancel's request digest not stable across a retry (a
   per-call nonce): `cancel-reply-lost` red — the re-issued cancel
   answers `409 idempotency_conflict` instead of the committed admission.
7. FG9d — the cancel tells a handed-over sender its message was not
   sent (the journal answer's `accepting` arm answers with the `planned`
   text while the entry still settles `unknown`):
   `cancel-during-handover` red at the answer assertion — a sender told
   to send again duplicates a message the relay delivers. The stronger
   regression, the cancel withdrawing the handed-over entry itself, is
   refused three deep: the journal answer settles `unknown`, `settle`
   admits `cancelled` only from `planned`, and the record contract's
   delivery transitions (`managed-extension-record.ts:183-187`) never
   leave `accepting` for `cancelled`; with the first two mutated, the
   third refuses every settle, the Turn ends recovery-blocked and never
   leaves `CANCELLING`, and this case is red at that wait.
8. FG9e — the public `Last-Event-ID` cursor read one short:
   `public-resume` red (a duplicate at the resume boundary).
9. FG9e — the WebShell `afterSequence` cursor read one long on a resume:
   `webshell-resume` red (a gap at the resume boundary).

Slice 3, each run against its case alone (`-Dqwen.fg9b.case` /
`-Dqwen.fg9c.case`); the Harness-side ones patch the bundle's chunk in
place and restore it byte for byte, the relay one patches the Java
source:

10. FG9b — the cold load tells a never-committed outbound it reached the
    leader (`resumeCommandWaitRuns`' never-committed arm answers with the
    `accepting` text): `outbound-commit-refused` red at the answer
    assertion — a sender told her message may have landed never sends
    the one that did not.
11. FG9b — the execute answers without its durable receipt (the receipt
    commit's failure swallowed): `receipt-commit-refused` red — the
    execute answers 202, so the store failure the case waits for never
    happens, and the reply alice would hold has no receipt behind it.
12. FG9b — the relay classifies the command done when its `answered`
    copy-back failed: `answered-commit-refused` red — her entry is never
    answered, and her wait runs out into `unknown`.
13. FG9c — each execution derives fresh `msgc_` ids (the command id
    salted per run, so the ids are not replay-stable):
    `lead-kill-mid-fanout` red — the re-execution sends position 1 again
    under a new id (three `msgc_` for two positions). Neutralizing only
    the send loop's committed-position probe (slice 1's mutation 2) is
    an equivalent mutant at this kill point: `sendToRunningMember`
    answers a re-driven send of the same id and content `sent` without
    a commit, and each guard alone keeps position 1 from a second send.
    Both rest on the replay-stable id, which is what this mutation
    breaks.
14. FG9c — the cold load reads a parked entry as never committed
    (`resumeCommandWaitRuns` takes its never-committed arm with the
    record present): `member-kill-after-mint` red — alice is told "not
    sent" while her entry stays live, the relay delivers it anyway, and
    the copied-back reply is never consumed.

## Validation and acceptance

- `npm run build && npm run typecheck`; ESLint clean on the driver;
  `hosted-relay-headers.test.ts` green with the new roster entry.
- The module's surefire suite, Checkstyle, and SpotBugs green.
- The new class green on a local MySQL/MariaDB (the CI lane is MySQL
  8.4): every case firing its declared fault — each drop counter, hold
  counter, `fg9b_fire` count and held kill point observed — per-letter
  selectors working, and the happy path (a broadcast with no injection)
  green with exactly one `msgc_` row per position.
- Every slice-1 and slice-2 mutation above individually red; source
  restored; the gate green again. Slice 3 repeats the procedure for its
  mutations.
- `hosted-process-ci.test.js` green with any moved budgets, and
  `check-failsafe-reports.js hosted` satisfied after a full lane run.
- Two consecutive clean open-ended and reverse audit rounds per
  AGENTS.md.
- This design lands in both languages; #14164 gains a comment recording
  the slice split and the closeability statement, and each slice PR
  marks its letters delivered there (decision 6).

## Open questions

1. Resolved at landing: no `execute`-verb arming is staged in slice 1.
   The harness-fronted proxy was ruled out by probes (a proxied
   warm/createOrLoad chain breeds resident-vs-attach conflicts), so the
   axis keeps the Harness connection direct; the three store-boundary
   letters carry step 1's replay-stable assertions.
2. Whether the broadcast roster should grow to four members (three
   recipients) to sharpen the partial arms' decisiveness — cost is one
   more scripted member per case; decided at implementation.
3. Resolved at slice 2: FG9e does not arm the expired-cursor
   `resync_required` case. The resync answer belongs to the Session
   stream's replay floor whichever capability produced the events, and
   the FG8 tracker (#14163) still owes that one case.
