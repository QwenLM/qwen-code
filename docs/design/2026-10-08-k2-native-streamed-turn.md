# K2: original streamed Hosted turn prerequisite

[English](2026-10-08-k2-native-streamed-turn.md) | [简体中文](2026-10-08-k2-native-streamed-turn.zh-CN.md)

Status: implemented and locally verified on 2026-10-08; Draft and maintainer
review remain required. Baseline: `fff718e71de0b80c3095152ea6b14335863c07f0`.
Continues [native text admission](2026-10-08-k2-native-text-conversation.md)
and [the connected file design](2026-10-07-k2-native-file-execution.md) in
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526).
This prerequisite does not finish the complete K2 objective.

## 1. Current gap and topology

Before this prerequisite, the SQL fold admitted original bounded text turns
without streaming.
The actual Hosted caller enables `HostedTextDeltaStream` and settled-prompt
history for a tool profile; the diagnostic producer previously composed its own
ChatRecords and exercised neither branch. The baseline SQL refused its first
`assistantDelta`. A successful provider response or hand-composed final message
cannot qualify those original consumers.

Hosted daemon owns the model, original Harness and Session Store connection.
Boot4 CSI worker owns the mount and context operations; its four current routes
do not run a model or construct the native file-tool composition. No
model/store/Broker boot fields are added to that worker.
Public Hosted and Spring CSI selection stays closed. Private internal attachment,
original CSI context installation, retained bind and actual file RPC remain
later steps in this same complete objective.

Baseline no-AK CI exposed a regression from preserving original no-tool Parts:
the old `answered` predicate treated thought-only text as a visible answer.
Independent reproduction confirmed it. The predicate now excludes thought Parts
while retaining complete Parts in durable messages. The existing packaged-process
thought-only/failed/cancelled history tests remain unchanged.

## 2. Shared original Hosted execution

Extract the complete existing turn runner into `hosted-harness-turn.ts` and call
it from the existing `executeHostedTurn` adapter. Keep original ChatRecord
creation in that production module and reuse it for the route's other records.
The diagnostic producer invokes this actual shared runner rather than writing
user/assistant/turn-result records itself. This is production code consumed by
the existing routes, not an export of an otherwise private function for tests.

Preserve original model-slot ownership, Harness checkpoint authorization, global
message ancestry, user commit, model attempt, streamed message ID consumption,
atomic settlement, recoverable error distinctions, callbacks, tool finish and
detached cleanup. Pass the existing workspace context, hooks and a tool-turn
constructor from the adapter; do not move acquisition earlier. Explicitly select
all-history or settled-history using the existing actual profile decision.
Settled-history keeps complete Parts from settled prompts, excludes an unsettled
prompt, and includes the current prompt only on existing tool-result resumption.

The shared runner's native no-tool diagnostic still refuses actual tool SSE.
It supplies no private file declarations, bind, preparation or dispatch grant.
Running that shared function is not proof of a private HTTP attachment route.

## 3. Original stream fold

Extend the existing derived `Prefix` with the current stream's message UUID,
first sequence, next ordinal and accumulated visible text. Preserve used IDs
across retraction and settlement; use no new SQL projection or authority.

`assistantDelta` is exactly one activation-scoped `message.delta` with payload
`messageId`, `turnId`, `role`, `text`. Require the current original input/user
and a started model attempt, no committed assistant, exact owner/activation,
and no checkpoint mutation. Both command/event IDs are
`assistant-delta:<turnId>:<messageId>:<ordinal>`. The first ordinal is zero;
later ordinals must be contiguous for that same original stream. Its digest is
SHA-256 of the original text's UTF-8 bytes, not a canonical payload hash.
Each nonempty chunk is at most 3,072 UTF-8 bytes; invalid Unicode is refused.

`assistantRetract` is exactly one `message.retracted` with payload `messageId`,
`turnId`, `fromSequence`. It must name the current stream and its first original
sequence. Command/event IDs are `assistant-retract:<turnId>:<messageId>`; digest
is SHA-256 of `<messageId>:<fromSequence>`. Clear the current stream but retain
its used UUID. A replacement stream starts at ordinal zero with a fresh UUID.
The original provider retry/fallback sequence must be observed before qualifying
it; the event alone does not authorize arbitrary additional model attempts.

The final assistant must use the current stream UUID and exactly the concatenated
non-thought text Parts. Retain all original thought/text Parts. Consuming that
reserved UUID does not insert it into used IDs twice; a retracted or unrelated
UUID cannot be substituted. Legacy qualified non-streaming messages remain
valid. Original error settlement after a provider failure must be observed;
do not erase, invent a retraction for, or treat its published prefix as a
committed assistant. A valid original atomic settlement clears current stream
state with input/attempt, preserving message ancestry and used IDs.

Fresh admission and full cold replay use this same fold. Current-revision
resources, original digests and checkpoint coverage rules stay intact. Old exact
command replay is read-only, including DRAINING; fresh streamed mutations require
READY. Unknown stream shapes, gaps, mismatched text/UUID/turn/activation and
invalid original history refuse without durable changes.

## 4. Affected consumers and validation

Production consumers are the existing Hosted prompt, resume, wake and settle
projection callers; original SSE/transcript delta deduplication/retraction;
Java native fresh commit and full-history admission; original checkpoint replay.
Files are the shared runner and adapter, `CsiNativeActivationProof`, collocated
tests, original generator/helper and this complete bilingual design pair.
No daemon route ownership or SQL schema changes in this prerequisite.

Before source changes, independent test-engineer records global CLI capability,
then uses an explicit production-module test-script fallback and a real registered
private CREATE/Spring/JDBC transaction. Capture actual stream bytes, provider
requests, full table inventories and the expected first-delta refusal. Preserve
baseline failures and source/dependency/origin pins; clean only owned resources.

After changes, invoke the actual shared production runner and admit unchanged
original transactions in Java. Cover success, actual no-tool error and following
turn, multiple Unicode chunks including the 3,072-byte boundary, thought Parts,
settled history in the next actual provider request, original partial-output
retry/retraction and failure where reproducible. Structurally valid refusal
controls must be signed with matching generic digests so they reach the semantic
gate. Structural-parser and head-CAS refusals are recorded separately and do not
qualify stream semantics. Verify old replay,
full current history, corruption, DRAINING and complete before/after SQL equality.
Run build/typecheck/bundle, focused Java/CLI tests, required static checks,
independent verification, two clean diff audits and genuine native review.

## 5. Acceptance and remaining full K2

Accept this prerequisite only for observed original shared-runner and SQL stream
behavior, with fresh evidence bound to actual inputs. Preserve ordinary Hosted
behavior in focused regression tests. Report missing cases explicitly.

Bounded independent verification observed five original shared-runner turns and
seven provider requests, accepted 42 active original transactions and replayed
all 42 read-only. Two actual retry retractions, terminal partial-output error,
no-tool SSE error, complete thought Parts and following settled history were
retained. The final original activation release remained refused. Stored-stream
corruption and original next-input ACTIVE/DRAINING controls retained full
53-table values and ownership. Three initially head-CAS-blocked controls were
preserved; separate current-head, correctly signed before-user/after-terminal/
after-assistant controls reached CSI409. An empty delta's original TypeScript
structural refusal is disclosed separately. Three unchanged packaged history
cases passed with retry zero; actual-bundle request capture preserved durable
thought Parts while excluding unanswered A and retaining completed B/C history.
These are production-module/owned collector/direct Spring-JDBC-H2 diagnostics
with synthetic Pod metadata, not private HTTP or worker/CSI/cloud qualification.

Production private Broker composition is also disconnected: the existing
Embedded resolver/provisioner and public Hosted create/load cannot authorize
this profile. A private operator composition must connect original registration,
CSI provisioning/reservation, current SQL readback and post-transaction context
installation to an authenticated internal Hosted attachment. Installation needs
current-authority rechecks after RPC without holding SQL locks across it; a
receipt, restored journal head or resource bytes alone cannot authorize bind.

Private internal Hosted attachment, CSI install/holder/bind trust, full original
batch reservation and schema2 preparation, native file execution/results/consumption,
all asynchronous writer closure, aggregate DRAINED, original writer/descendant
termination, every NodeUnpublish, atomic RELEASED and safe repeated volume handoff,
public selection and fresh complete cluster acceptance remain required K2 work.
No local fixture, green CI or prior cloud run substitutes for that acceptance.
Maintainer retirement/retention/LOST decisions and genuine review stay open.
