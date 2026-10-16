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
- Cancellation of the minted-but-unrelayed window:
  `answerCommandByJournal`
  (`hosted-workspace-tool-turn.ts:5843-5903`) settles a `planned` entry
  `cancelled` (`settle` only from `planned`,
  `hosted-session-command-session.ts:392-412`); the recovery side answers
  identically (`sessionCommandJournalAnswer`,
  `packages/cli/src/serve/hosted-runtime-recovery.ts:1180-1225`).
- SSE: the public stream resumes by `Last-Event-ID` / `after`
  (`PublicAgentController.java:195-218`), the WebShell stream by
  `afterSequence` (`WebShellAgentController.java:125-134`).
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

   | Slice | Letters        | Waits for                                                                                                 | Why                                                                                                                                                                                                          |
   | ----- | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | 1     | **FG9a, FG9f** | nothing                                                                                                   | The round's owed semantics — probe-before-send and answer honesty under lost replies — with no in-flight PR touching them.                                                                                   |
   | 2     | **FG9d, FG9e** | nothing; ordered second only to bound slice size                                                          | Cancellation and SSE-gap letters reuse the slice-1 fixture and the FG8e observer unchanged.                                                                                                                  |
   | 3     | **FG9b, FG9c** | **#13918** (InnoDB lock guard convoy) and **#13986** (restart-proof held-Runtime drain) — both OPEN today | FG9b's markers assert the store-failure error taxonomy #13918 rewrites; FG9c's member/lead restart arms pin cold-load recovery the held-Runtime backfill (#13986) is reshaping. Same waiters as FG8 slice 3. |

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
   is fixed here; neither is papered over.

5. **#13339 discipline.** The lane has no quarantine or retry mechanism.
   FG9 therefore: (a) adds only the new `Hosted*IT` class and never
   modifies `HostedWorkspaceToolTurnIT`; (b) gives every case a
   fault-fired witness (drop counters, `FG9B_*` markers, kill markers,
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
log (FG9a, FG9d, FG9f), `FG9B_<case>` SQLException markers (FG9b), kill
markers read from the producer's own progress (FG9c), or the
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

### FG9d — cancellation (slice 2)

| Case                     | Injection                                                                                                                                    | Expect                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cancel-after-mint`      | Cancel alice's Turn (public `agent.session.cancel`) after her outbound `session_command` committed `planned` but before the relay's handover | The cancelled send produces no delivery: zero `msgc_` rows, zero recipient journal rows; the sender entry settles `cancelled` (`answerCommandByJournal`, `settle` only from `planned`); the relay classifies the ledger row `done` without an execute; the sender's turn ends cancelled with no fabricated reply                           |
| `cancel-reply-lost`      | Drop the reply to the cancel POST after the cancel committed; the client re-issues the same cancel                                           | The re-issued cancel answers the same committed state — one cancel journal entry, one settled terminal state; no duplicate cancellation event; the entry stays undelivered                                                                                                                                                                 |
| `cancel-during-handover` | Cancel while the relay's handover attempt is outstanding (the handover verb's reply held at the proxy until the cancel lands, then released) | Only a physically settled relay produces a terminal state: either the handover raced the cancel and the committed receipt answers honestly, or the cancelled entry blocks the relay from executing — never both, never a delivered message on a cancelled send; the outcome the journal holds is one of the two, and the gate proves which |

### FG9e — SSE gap (slice 2)

The public and WebShell streams are served by the in-JVM Spring; the
client aborts and resumes are the injection, so this letter needs no
proxy. A `*` broadcast in flight supplies the relay traffic. Each case
aborts the stream mid-relay, lets the relay progress while disconnected
— the JDBC witness proves committed rows beyond the cursor before the
resume — and reconnects only then, so the replay is never vacuous.

| Case                        | Injection                                                                   | Expect                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public-sender-resume`      | Abort the sender's public stream mid-fan-out; resume with `Last-Event-ID`   | The replayed sequence is duplicate-free and gap-free from the cursor; the receipt and minted messages commit beyond the cursor while disconnected (JDBC); the terminal turn event appears exactly once |
| `webshell-sender-resume`    | Abort the sender's WebShell stream mid-fan-out; resume with `afterSequence` | Same continuity assertions over the WebShell envelope                                                                                                                                                  |
| `public-recipient-resume`   | Abort a recipient's public stream between the mint and the delivery; resume | The minted message's projection replays in order without loss or duplication; the recipient's consumption event appears exactly once                                                                   |
| `webshell-recipient-resume` | Same over the recipient's WebShell stream                                   | Same assertions                                                                                                                                                                                        |

### FG9b — store failures (slice 3, after #13918)

Test-only SQL triggers, tenant- and scope-scoped, installed and dropped
per case like FG7b/FG6f, `SIGNAL SQLSTATE` text `FG9B_<case>` asserted
in the captured Spring output. The error codes these cases assert are
the post-#13918 taxonomy, re-pinned at slice landing.

| Case                      | Injection                                                                     | Expect                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbound-commit-refused` | One-shot trigger fails the member's outbound `session_command` commit         | Zero downstream effects: no `ma_delivery` row, no execute, no `msgc_` rows; the sender's parked wait keeps its recoverable state; no duplicate journal rows after the harness reloads (the mint is re-driven only through the original call's own replay, never minted afresh)  |
| `receipt-commit-refused`  | One-shot trigger fails the lead's inbound-receipt commit                      | The execute fails without a receipt; the relay re-drives once the trigger drops, and the re-run answers through the probe (positions already committed are `sent.`), never re-sending; the recipient's view is not advanced by the failed receipt — one delivery, no duplicates |
| `answered-commit-refused` | One-shot trigger fails the `answered` write-back commit on the member journal | The relay retries the `answered` verb; exactly one `accepted` revision carries the reply; the member's parked wait consumes exactly once; no duplicate reply bytes on the journal                                                                                               |

### FG9c — process crashes (slice 3, after #13986)

POSIX-only. The driver owns the Harness child process and signals it;
cold-load assertions are written against the #13361 branch-tagged 409
arm names, re-pinned against the merged #13986 surface at slice landing.
A Harness kill here kills every team session it hosts — the two cases
differ only in which relay window the kill lands in.

| Case                     | Injection                                                                                                     | Expect                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead-kill-mid-fanout`   | SIGKILL the Harness after the first `msgc_` mint commit (witnessed at the store proxy) and before the receipt | Restart: the unsettled command is never re-minted (one `session_command` row); the re-execution probes position 1 committed — reported `sent.`, never re-sent — and sends position 2 exactly once; the receipt commits honestly; both recipients deliver once                             |
| `member-kill-after-mint` | SIGKILL the Harness after alice's outbound `session_command` commit and before her wait's first checkpoint    | Reopen: the minted-but-unwaited entry does not become an invisible duplicate — one `session_command` row, the wait resumes from the journal (`sessionCommandJournalAnswer` arms, `hosted-runtime-recovery.ts:1180-1225`); the relay completes the command; the sender's turn answers once |

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
letter so the held mint forces a relay-side timeout-and-retry quickly.

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
the child-run record body's _top_ level, the widened contract's shape;
and `settleAndCheckDelivered` scopes its terminal-set poll to
`delivery_kind = 'SESSION_MESSAGE'`, because the three child-launch
`<childRunId>` deliveries stay `delivered` by construction once the
scripted lead completes before the latched members — orchestration
bookkeeping, not relay work the case owes.

**Store-failure triggers** (slice 3, FG9b) copy the FG7b DDL shape with
`SIGNAL SQLSTATE` text `FG9B_<case>`, scoped to the case tenant and
record-id prefix, asserted in the captured Spring output, dropped in
teardown.

**Kill arms** (slice 3, FG9c) are the H4e-b3 restart mechanics verbatim:
`harness.destroyForcibly()`, a fresh `startHarness()` (new
`HOME`/`QWEN_HOME` = genuinely cold), the writer-generation takeover
witness, and the relay hold before and after so the kill always lands
mid-flight. POSIX only; both slices keep `@Timeout(600)` per letter.

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

## Mutation checks

Each mutation is applied, shown to turn exactly its gate red, then
reverted, following the FG6/FG7/FG8 documented manual procedure. The
slice-1 mutations below are committed with this design; slices 2 and 3
refine theirs when those letters land.

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

Planned, refined at slice landing: FG9d — the cancel settle accepting a
settle from a non-`planned` state (`cancel-after-mint` red on the second
settle's conflict); FG9e — the per-letter replay-boundary off-by-one
pair from the FG8e mutations re-applied to the relay ledger projection;
FG9b — the refused outbound commit proceeding to mint a delivery row
(`outbound-commit-refused` red at the zero-delivery assertion); FG9c —
the cold load treating a parked command wait as clean
(`member-kill-after-mint` red at the resume-from-journal assertion).

## Validation and acceptance

- `npm run build && npm run typecheck`; ESLint clean on the driver;
  `hosted-relay-headers.test.ts` green with the new roster entry.
- The module's surefire suite, Checkstyle, and SpotBugs green.
- The new class green on a local MySQL/MariaDB (the CI lane is MySQL
  8.4): every case firing its declared fault — each drop counter, hold
  counter, `FG9B_*` marker and kill marker observed — per-letter
  selectors working, and the happy path (a broadcast with no injection)
  green with exactly one `msgc_` row per position.
- Every slice-1 mutation above individually red; source restored; the
  gate green again. Slices 2/3 repeat the procedure for their mutations.
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
3. Whether FG9e needs the expired-cursor `resync_required` arm the FG8e
   slice deferred — left to slice 2's landing, same replay-floor
   mechanics question.
