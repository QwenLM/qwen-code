# Interleaved assistant replay

[English](interleaved-assistant-replay.md) | [简体中文](interleaved-assistant-replay.zh-CN.md)

Date: 2026-10-26. Status: local implementation; acceptance checks below remain a verification plan.

## Problem and scope

An assistant can emit reasoning summary `R1`, message `M1`, reasoning summary
`R2`, and message `M2` in that order. The previous Chat Completions conversion
collected all reasoning into `reasoning_content: R1R2` and all messages into
`content: M1M2`. Merging consecutive assistant messages repeated that loss of
order. The UI also placed later reasoning above earlier assistant output.

This change preserves reasoning/message order in outbound Chat history and in
the streaming UI. It covers the
[Chat converter](../../packages/core/src/core/openaiContentGenerator/converter.ts),
[strict-provider adaptation](../../packages/core/src/core/openaiContentGenerator/provider/utils.ts),
and [streaming UI hook](../../packages/cli/src/ui/hooks/use-llm-stream.ts).
Shared history, session persistence, and Responses replay signatures retain
their existing representation.

## Replay conversion

`processContent` flushes the current assistant segment when reasoning follows
message content or a tool call. `normalizeAssistantMessages` preserves new
reasoning segments instead of flattening them into the preceding message. With
`A(R, M)` denoting one assistant message, the intended mapping is:

```text
R1, M1, R2, M2
→ A(R1, M1), A(R2, M2)
```

Each segment carries its own `reasoning_content` and `content`. A reasoning-only
segment uses `content: ""`; a tool-only message may use `content: null`.

### Tool batches and observation order

A consecutive assistant run ends at the next non-assistant message. Collect
its tool calls in original order and attach the batch to its final assistant
segment. Matching tool results must immediately follow as a contiguous block;
split tool media follows that block.

```text
R1, M1, F1, R2, M2, F2, O1, O2
→ A(R1, M1), A(R2, M2, tools=[F1, F2]), O1, O2
```

Here `Fi` is a tool call and `Oi` its result. Chat cannot represent the original
call/reasoning interleaving while also requiring results directly after their
calling message. Grouping the calls delays their placement in the replay, but
keeps the reasoning/message sequence and complete tool batch. Moving `O1`
before `R2` would instead imply that the model had already observed a result
that was not available when it produced `R2`; the converter must not do this.

Orphan cleanup matches results only within the following result block and
does not search past an ordinary assistant or user message. Existing call-ID
deduplication and orphan removal remain in effect. Normalize again after
cleanup so newly adjacent segments obey the same rules.

## Provider adaptation and limits

The conversion builds outbound messages without rewriting shared history.
Responses `thoughtSignature`, item metadata, and `encrypted_content` remain
available to the Responses replay path. Chat has no standard equivalent for
that encrypted payload, so it must not be copied into message text or an
invented Chat field. A readable reasoning summary can be replayed through
`reasoning_content` when the destination supports it.

Mistral and Cerebras remove `reasoning_content` at the outbound boundary. The
adapter also removes a reasoning-only segment that becomes empty because of
that removal; it retains messages carrying text, tool calls, or other payload.
This filtering must not mutate the shared source message.

Consecutive Chat assistant messages preserve the serialized segment order,
but do not recreate Responses item identities or same-turn semantics. A target
endpoint may reject consecutive assistants, ignore reasoning, or merge messages
itself. Claiming compatibility with a specific endpoint requires separate
validation; this change does not establish universal lossless cross-protocol replay.

## UI ordering

When visible reasoning resumes after assistant output, stage the preceding
output before rendering the new summary. Store completed reasoning episodes
in the same ordered pending sequence and retain the existing collapsible
`gemini_thought` presentation, duration, and long-summary handling.

Keep a staged summary's completion state separate from its pending placement.
Once the next message starts, it must show a completed, clickable summary;
a stable thought-group key keeps its expansion state across continuation rows
and the later history commit.

A completed tool group stays before every pending segment of the response
that follows its results, including staged text and reasoning. Active tool
groups retain their existing display position.

Commit that sequence in order at normal completion, tool, cancellation, and
visible control-message boundaries. Keep interleaved pending output discardable
for a fresh retry or model fallback, so a failed attempt cannot leave later
reasoning attached to an earlier answer. Opaque signatures are replay data,
not display text.

## Validation and acceptance

Verification will cover the following criteria:

- Converter tests will assert the exact `R1,M1,R2,M2` mapping, reasoning-only
  segments, consecutive source messages, and source-history immutability.
- Tool cases will include interleaved reasoning and parallel calls, text between
  calls, duplicate IDs, missing results, and split media. Each surviving call
  will have one adjacent result; no result will move before later reasoning.
- Provider tests will check that reasoning removal deletes only newly empty
  segments and retains text/tool payloads without mutating their source.
- UI tests will check live and committed order, collapsible summaries, long
  summaries, completed-but-staged summaries, expansion across commit,
  completed tools before their continuation, cancellation, control boundaries,
  retry, and model fallback.
- The built converter → provider → SDK pipeline will send requests to a strict
  loopback HTTP mock to verify wire order and tool-call/result validity.
  Responses replay will be checked to retain its signatures and item order.

Acceptance will require these checks to pass, no opaque signature in Chat text
or UI output, and matching English/Chinese documentation. Provider-specific
failures will be addressed at the outbound adapter rather than by flattening
the shared history. Remote endpoint checks are required only when claiming
compatibility with that endpoint; they are outside this local fix's acceptance.
