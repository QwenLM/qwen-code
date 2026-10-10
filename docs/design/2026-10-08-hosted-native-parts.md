# Preserve native model Parts for the K2 conversation prerequisite

[English](2026-10-08-hosted-native-parts.md) |
[简体中文](2026-10-08-hosted-native-parts.zh-CN.md)

Status: implemented and independently verified as a local no-tool producer
prerequisite; private Java conversation admission remains pending. Source baseline:
`88c72fa1a8c30826a3995f32beebe3abc64203f8`.
This is a prerequisite within K2 and Draft PR #13526, tracked by #13395.
The [batch design](2026-10-08-k2-native-batch-reservation.md) describes the
remaining private conversation, allocation and execution work.

## 1. Problem and current behavior

At the source baseline, the Hosted model caller accumulated display text from
stream events and returned only that text and the model name in the no-tool
branch. Its main and recovery consumers consequently reconstructed a single
text Part when writing the assistant. The actual provider history can contain
additional Parts, including reasoning with `thought: true`; those were lost at
this boundary.
The tool branch already clones the complete final model history, preserves
Part order and associates function IDs with the actual streamed calls.

K2 needs the original assistant, including full Part positions, before it can
qualify a conversation or a batch. Constructing an empty tool callback to reach
the existing Parts return would conceal the missing no-tool behavior and would
not connect a private Runtime Session.

## 2. Proposed change and consumers

Read and clone the actual final model history in both branches. Return its
complete Parts with the existing display text and model name. Keep the existing
model-role and missing-history refusal. Retain the tool branch's actual
function count, name and call-ID checks and all no-tool stream refusals.
Do not rebuild the Parts from display text or introduce a feature flag.

`MessageDisplay` suppression must return both empty text and empty Parts in
either branch, so a suppressed answer does not become durable assistant content.
Retry, fallback, continuation and Stop decisions remain in their current order.
The final model history, after these decisions, is the source of returned Parts.
The cloned array must not alias provider history. A hook-generated stop reason
continues to use its existing explicit synthetic text Part.

The production change is limited to
`packages/cli/src/serve/hosted-harness-model.ts` and its collocated tests.
Both assistant consumers in `hosted-harness-session.ts` already consume
`result.parts` before their legacy text fallback; they need no new selector.
Message projection and future model history consequently receive the retained
Parts through the existing sink. There are no new daemon routes or APIs.

## 3. Original producer capture and boundaries

Use an owned loopback OpenAI-compatible provider and the actual CLI
settings/config/provider SDK. Isolate configuration with `QWEN_HOME` and
runtime artifacts with `QWEN_RUNTIME_DIR` in owned child processes. Point
`QWEN_CODE_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at owned
empty settings; use a controlled child environment with only owned provider
credentials and endpoint, without inherited proxy/provider overrides. Observe
actual endpoint requests; environment assignment alone does not prove routing.
The provider fixture supplies deterministic SSE reasoning and answer content.
It is controlled protocol infrastructure, not a live external model.

Capture the original text sequence using a complete `openManagedSession`
Session, `submitInput`, the real model-slot controller and model scope, Harness,
model caller and sink. Write ordinary ChatRecords using the existing Hosted
shape; the authority must generate the original events, resources and hashes.
Capture user, started/terminal attempt, assistant, atomic settlement/checkpoint
and a next turn on the same Session. Preserve raw bytes and both parent chains.
The private Hosted turn caller is not exported, so this owned capture composes
ordinary ChatRecords at that caller seam using the existing Hosted shape. The
Session, controller, model scope, model caller and sink remain original and
unpatched; this is not a public HTTP turn or a private production runner.
An owned HTTP store collector proves producer output, not private Java/SQL
admission or a production private Harness runner.

This change does not open the public private-profile selector, admit these
conversation events in Java, allocate a batch, execute a tool or qualify CSI
retirement. The generic Session close used for owned test cleanup is not
physical writer termination, DRAINED/RELEASED or NodeUnpublish evidence.

## 4. Validation and acceptance

The independent baseline attempted the globally installed CLI (0.24.6) and
recorded the internal-entry boundary. The actual built Hosted caller reproduced
the gap with the owned provider: both completed turns omitted Parts, assistant
resources lost reasoning and the next request omitted `reasoning_content`.
The same original Session captured three turn scenarios, including a real
no-tool tool-request refusal. These are producer observations, not SQL admission.

After implementation, focused CLI tests cover full ordered Parts, cloning,
suppression in both branches, unavailable history, original tool refusals and
retry/fallback behavior. Build, typecheck and bundle before independent
verification against the changed build. Verify complete returned Parts reach
the original assistant resource and that the next-turn request retains them.
Record actual native grammar and unsupported private consumer boundaries.

Independent verification against the changed build passed three unique turn
scenarios: two completed reasoning/answer turns retain full ordered Parts in
the original assistant bytes and projection, the next actual provider request
retains `reasoning_content`, and a real tool-request SSE is still refused
without assistant or tool intent. All 19 data/byte/protocol audit predicates
matched; these are separate from unit-test and CLI metadata counts. The two
focused CLI files report 272 passing test cases, and build, typecheck, bundle
and scoped lint pass. Owned processes, ports and temporary files were cleaned.
The collector/composition seam and Darwin environment retain the limits above;
none of these observations qualify Java/SQL, a deployed CSI worker or full K2.

Acceptance requires the original no-tool producer to preserve its actual Parts
without a fake tool branch, while suppression and existing tool behavior remain
unchanged. The independent report must distinguish producer capture from SQL
acceptance and retain owned cleanup and exact executable provenance. Native
conversation admission remains a subsequent shared fresh/history fold change.

## 5. Risks and remaining questions

Retaining provider Parts changes ordinary no-tool transcript contents. Verify
display suppression and history reuse explicitly; do not equate visible text
with every persisted Part. The existing resource size limits still apply.
Provider-specific Part fields remain original provider data, not a new K2 grant.

The next conversation design must determine closed message/model-attempt,
usage and checkpoint semantics from these actual captures. No inferred
`modelAttemptId` field, hand-authored event sequence or full-K2 claim is accepted
as a substitute for that evidence.
