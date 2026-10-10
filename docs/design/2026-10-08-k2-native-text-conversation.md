# K2 original native text conversation

[English](2026-10-08-k2-native-text-conversation.md) | [简体中文](2026-10-08-k2-native-text-conversation.zh-CN.md)

## 1. Status and objective

Implemented follow-on to the committed private CSI foundations at `810744e` in
Draft PR #13526; tracker #13395 and proposal #12380 remain open. This document
specifies the next original-conversation prerequisite for complete K2. It
neither declares K2 complete nor enables public selection, native tools,
physical retirement or safe volume reuse.

The first bounded target is the actual original text-only producer:
private definition published before CREATE, original input/wake, user message,
model attempt start/terminal, optional successful assistant, and the atomic
turn-settled/next-checkpoint pair. Both ordinary success and tool-request
refusal followed by another turn must work. Fresh admission and full historical
replay use the same transition; a special fixture-only path is not acceptable.

## 2. Reproduced baseline gap and authoritative observations

At baseline `810744e`, `CsiNativeActivationProof.advance` accepts original
input/wake and the once-only initial checkpoint. `JdbcCsiActivationAdmission` calls it in fresh commit and
in every historical transaction while enforcing the original parent locks,
writer, activation, resource revision association and complete head equality.
A message after the accepted initial prefix refused at that baseline. The
implemented shared fold now checks original text messages, attempts and atomic
settlements under the bounded contract below.

The unchanged older ordinary Parts capture demonstrates actual producer shapes,
but its definition lacks `toolProfile`; it cannot establish private genesis.
A new independent capture must publish exactly `engine`, `sessionId` and the
reserved private `toolProfile` before original CREATE. Never insert fields into
captured raw resources or manufacture native events and then claim an original
private producer. The public Hosted whitelist remains closed.

The actual internal assembly, activation controller, text model runner and sink
can be invoked with an owned loopback provider/response collector. The diagnostic
caller composes ChatRecord-shaped inputs as the existing Hosted caller does;
that disclosed seam does not boot a private worker or grant a real deployment
qualification. The original sink produces messages and atomic settlement; it
does not produce `turn.started` or `wake.consumed` in this path.

This caller does not invoke the unexported `executeHostedTurn`. A private
profile enables text-delta streaming and settled-prompt history filtering in
that actual Hosted caller; those paths need separate original qualification.
The baseline bootstraps a registered SQL owner before native CREATE so both
halves retain the same original Session identity, without rewriting raw records.

## 3. State and transition contract

Retain only state derived from the accepted complete prefix: current original
input ID and text, the latest checkpoint reference/ID, global last message UUID,
current original model attempt route/ID/stage, and whether its assistant committed.
No new SQL authority or parallel recording projection is introduced. Renewal
preserves this state. A later valid atomic settlement alone clears current
input/attempt; individual messages, terminals or checkpoints cannot clear it.
The initial checkpoint may precede or follow the first input, as both orders
are produced by existing native callers.

| Original operation         | Required relationship                                                                                        | Result                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `submitInput`              | No unsettled input; original prompt/admission, wake and revision association retained                        | Pin current input; preserve global message/checkpoint state   |
| Initial `commitCheckpoint` | Existing once-only empty Harness contract; no duplicate or later standalone checkpoint                       | Pin latest complete checkpoint                                |
| User `commitMessage`       | Original prompt ID/text; record/envelope scope; unique UUID and exact global parent; before model start      | Advance original message chain                                |
| `hostedModelAttempt` start | Same current input; original route/budget snapshot and latest full checkpoint re-associated in this revision | Pin exact attempt and route                                   |
| Attempt terminal           | Same ID/route/checkpoint; one start then one observed terminal; original usage resource                      | Pin terminal state; retain current input                      |
| Assistant `commitMessage`  | Output-committed attempt; exact model/current input/parent; complete ordered text and thought Parts          | Advance chain, exactly once                                   |
| `settleTurn`               | Exactly ordered settled+checkpoint events; matching turn result and full next checkpoint                     | Atomically finish turn and retain new checkpoint/last message |

Success requires an output-committed attempt and assistant. Observed no-tool
refusal requires an abandoned attempt, no assistant, and matching error result.
The next user after error continues from the previous original user UUID. No
invented tool intent or successful file outcome follows a refused tool SSE.

Every operation checks closed native event/payload/resource shapes, UUIDs,
current input, scope/cwd, activation/epoch, sequence and command/event identity,
record and content digests, strict UTF-8 and existing bounds. Original raw
resource bytes must belong to this exact journal revision and original
Session/workspace; a digest-valid reference from another revision is insufficient.

For a message exceeding the 64 KiB inline limit, validate its original
`managed-message-chunks` manifest and each ordered `managed-message-part` ref
in the same revision. The producer splits raw bytes at 60 KiB. Concatenate
validated part bytes before strict UTF-8/ChatRecord parsing; a character may
straddle a part boundary. Keep the original manifest digest for the event ref.

Model routes retain their actual version/turn/model/budget identity. Usage is
original telemetry, not grant authority: investigate actual native numeric and
cumulative shapes before defining constraints; do not assume provider numbers
are integer structural counters. Structural sequence/revision/epoch rules stay
unchanged. Unobserved retry, multiple attempt, non-null budget and cancellation
semantics remain pending full-K2 requirements.

## 4. Checkpoint and history contract

Settlement is one transaction containing `turn.settled` followed by
`checkpoint.committed`; incomplete or split pairs refuse before durable writes.
The new checkpoint covers the previously accepted prefix, excluding both new
settlement events, and names the previous checkpoint ID. Metadata points to the
same new state reference; the original turn-result resource supplies the content
digest. Full checkpoint state is checked, not just its identity: identity,
resume/recording, continuation, attempt, tools, runtime, approval, output and
follow-up must match the actual native contract.
The result timestamp, its independently generated `endedAt`, settlement event
time and checkpoint event time need not be equal; validate their own original
fields without introducing equality or monotonicity rules.

The baseline's text-only assembly leaves recording/API-history and other
optional groups empty. That precise contract must be recaptured with the new
private definition; it is not permission to strip richer production state.
Unsupported fields/phases remain refused until their original producer and
consumer relationship is qualified. Preserve definition/root references and
actual identity input digest; never replace them with an inferred prompt digest.

Fresh and historical paths retain identical semantics. Complete replay must
reconstruct pending input, original message ancestry, attempt and last checkpoint;
exact old command replay after later turns is read-only, including DRAINING.
Fresh conversation mutations require original READY admission and live activation.
A corrupted older message/route/checkpoint must fail the current history read,
not merely fresh parsing. Existing history limits and placement lock ordering stay.

## 5. Implementation and consumers

The implementation extends the existing shared proof and derived prefix, keeping genesis,
activation/renewal and initial-checkpoint consumers. The JDBC fold starts with an
empty derived prefix; collocated proof tests and real private CREATE/SQL tests
exercise the new transitions using original producer fixtures. The existing HTTP adapter
must associate any nested message-chunk resources as current main specifies.

No public route, whitelist entry, worker constructor, daemon ownership scope,
SQL migration, generic release exemption or durable fallback is added. Current
collectors accept only actual observed routes and preserve raw requests/responses;
unknown routes fail rather than returning a synthetic success.

## 6. Validation and acceptance

Before implementation, an independent test-engineer records global CLI capability
and then uses an explicitly disclosed internal test-script fallback. It generates
new original private records and demonstrates the actual Java SQL refusal on the
first currently unsupported message while retaining the accepted prior prefix.
Capture successful turns, genuine no-tool SSE refusal, next-turn recovery and
actual fractional telemetry where the current SDK carries it. Preserve all raw
bytes, actual imported-module/JAR origins, source/binary pins and owned cleanup.
Add a fifth successful turn with a 65,300-character ASCII prompt: verify the
input JSON fits 64 KiB while its original ChatRecord crosses the inline limit,
then capture the actual manifest, ordered parts and resource reads.

The new baseline produced 33 original transactions and 46 resources: its
32-transaction active conversation prefix ends at sequence 41; the final
`releaseActivation` at sequence 42 is original collector cleanup. Preserve that
transaction and separately require the existing private retirement guard to
refuse it without durable changes. Collector close is not retirement-close.
Fresh SQL accepted the first four transactions and refused the next original
user message with `409 csi_original_activation_unavailable`; all 53 table values,
ownership and the first-activation pin remained unchanged. The first diagnostic
window cancelled without complete provider logs; the second recorded a provider
classifier rejecting the SDK's appended date-reminder text Part and causing
500 retries. Both failures stay separate from this corrected window.

After implementation, run the same unmodified active producer prefix through
real private CREATE, complete fresh SQL admission, current history replay and
read-only old command replay. Verify positive and refusal/fault cases separately:
wrong prompt/model/parent/order; changed route/attempt/checkpoint; duplicate starts
or assistant; incomplete settlement pair; checkpoint including settlement rather
than prior prefix; wrong predecessor/full recording/input digest; crossed/missing
revision association; byte/hash/length/UTF-8 mismatch; READY/DRAINING and corrupt
old history. Assert complete before/after table values on refusal, not only the
exception. Test error-to-next-turn continuation and preserved complete Parts.

Independent postimplementation verification finished on the working-tree component
at `2026-10-08T06:35:40Z`: five original scenarios and 14 native data predicates;
128 main SQL/data predicates, 10 supplementary predicates, and three corrected
split-settlement predicates. Counts stay separate from JUnit and earlier suites.
All 32 untouched active transactions accepted through sequence 41, the original
pin stayed 2, old settlement/full-history replay remained read-only, and original
release42 refused. The new long user record was 65,748 bytes, with original parts
61,440 + 4,308; do not reuse the baseline's byte lengths for this new capture.

The main derivatives included 19 CSI 409 refusals with every value in all 53 tables,
ownership and pin unchanged, including invalid UTF-8. The first split derivative
hit the existing API record-count boundary instead; a separate original one-turn
capture supplies a correctly signed/count-matching split refusal, followed by
acceptance and read-only replay of the unchanged atomic pair. Separate real CREATE
controls verify duplicate start/assistant refusal and an unchanged original input
accepted under READY inside an explicitly rolled-back diagnostic transaction,
then refused after persisted DRAINING. Missing exact-revision references and
corrupt older bytes also block current history without durable changes.

The first verification window's finite-negative usage rejection expectation was
wrong: production accepted that telemetry. Its failed assertion/receipt/table
changes remain separate from successful windows. The earlier split API-boundary
observation and initial audit's guessed JAR-locator error are also retained.
The corrected audit records 5,878 unchanged execution inputs, 168 unchanged selected
baseline files, 122 isolated dependency JARs and 2,287 actual Node origins.
Thirteen owned process groups, eight ports, four H2 databases and 156 temporary
files were cleaned. The frozen report is bound to that precommit component, not
silently relabelled as subsequent committed-head or physical CSI acceptance.

The local verification includes current build/typecheck/bundle, focused Java and
Core HTTP tests, and explicit Java static checks. A first full lint found two
undeclared Node globals in the new test-only caller; explicit `node:url` import
and `globalThis.AbortSignal` access address those rules. Four fresh generator/SQL
tests and full lint passed after that test-only change. Initial build-order setup
failures and lint failures stay preserved. Final committed checks and two clean
full contribution audits remain required submission steps.

The genuine native review captured all nine changed files, including every new
file, and loaded the current repository rules. Workflow emission stopped because
this environment lacks a Qwen session-exported `QWEN_CODE_PROJECT_DIR`; no review
wave or approval verdict ran. The repository review skill requires reporting the
restriction and stopping instead of dispatching individual agents as a substitute.
Keep this review incomplete and the PR Draft pending genuine maintainer review.

## 7. Remaining complete K2 work

This transition is a prerequisite, not a substitute for atomic all-member batch
and cold recovery, original history/schema2 preparation, retained composer/native
execution/outcomes/Hosted consumption, complete lifecycle/asynchronous writer cut,
aggregate DRAINED, original writer/descendant termination, every NodeUnpublish,
atomic RELEASED/safe same-volume handoff, public selection and fresh complete
cluster acceptance. Deadline, retry/budget and richer Parts/checkpoint semantics
must be qualified in their original production topology. Maintainer retirement,
retention and LOST-work decisions remain open; no authority is guessed here.
