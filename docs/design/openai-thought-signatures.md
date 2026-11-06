# OpenAI-compatible Gemini thought signatures

[English](openai-thought-signatures.md) | [简体中文](openai-thought-signatures.zh-CN.md)

Date: 2026-11-03. Status: implemented locally; Idealab tool continuation, session resume, and Kimi/DeepSeek fresh-session and Gemini-history switching checks are verified. Official Google dual-field replay remains an acceptance gate.

## Problem and scope

Gemini can require an opaque thought signature on a previous function call before it accepts the next request after a tool result. The OpenAI Chat converter discarded that signature when reading a response and when rebuilding assistant history. The first tool call therefore succeeded, but the following model request failed with HTTP 400.

This change covers signed function calls in non-streaming and streaming Chat Completions, subsequent request replay, and JSONL recording/resume. It does not change reasoning text, tool execution, provider configuration, or native Gemini, Anthropic, and Responses conversion.

The matching upstream report is [QwenLM/qwen-code#1187](https://github.com/QwenLM/qwen-code/issues/1187). The closed, unmerged [#1202](https://github.com/QwenLM/qwen-code/pull/1202) did not cover the official Google OpenAI field shape.

## Wire contract and evidence

The internal representation is the existing Gemini Part shape:

```json
{
  "functionCall": { "id": "call_read", "name": "read_file", "args": {} },
  "thoughtSignature": "sig-a"
}
```

Two OpenAI-compatible wire dialects are in scope:

```text
tool_calls[].thoughtSignature
tool_calls[].extra_content.google.thought_signature
```

The nested form is documented by [Google's thought-signature guidance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures). The direct form is the observed Idealab mapping.

Minimal live replay experiments established:

| Replay shape             | Idealab result                           | Official Google evidence                                                             |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Direct only              | Accepted with HTTP 200                   | #1202 testing failed with missing signature, consistent with the field being ignored |
| Nested only              | Rejected with missing-signature HTTP 400 | Required official shape                                                              |
| Both with the same value | Accepted with HTTP 200                   | Not yet live-tested                                                                  |

Signatures belong to individual tool calls. Parallel calls must not inherit one shared signature; the official protocol can sign only the first parallel call.

## Design

### Capture

`converter.ts` reads either field as a string. Identical dual fields represent one signature. Conflicting dual values are ambiguous and are not guessed or combined. Malformed containers and non-string values are not stringified.

Non-streaming conversion attaches the value directly to the emitted function-call Part. Streaming conversion passes it to the existing `StreamingToolCallParser`.

### Streaming correlation

The parser stores one optional signature in each existing tool-call metadata slot. It resolves the existing `actualIndex`, including same-index collision remapping, before saving the signature. Signature-only deltas are metadata, not argument fragments and not phantom calls.

The implementation covers signatures before or after arguments, signatures on the finish delta, repeated complete-argument replay, id-less calls, and late signatures after remapping. Values are opaque and are not concatenated. Existing reset and malformed-call validation continue to apply.

### Replay

Outbound conversion emits both fields with the same original value. This avoids durable dialect metadata, endpoint detection, provider settings, and per-history dispatch. It also allows a history containing calls captured from different dialects to use one representation.

Dual-write is a compatibility superset, not exact-source replay. Official Google acceptance must be verified before claiming official dual-field support. If it fails, the fallback is per-call `partMetadata` dialect provenance with exact-source output, not URL inference or an automatic alternate-format retry.

Unsigned calls retain the standard OpenAI shape. Unknown `extra_content` extensions are not copied.

### Recording and resume

`redactStructuredOutputArgsForRecording` now retains `thoughtSignature` while preserving structured-output argument redaction. This is required because in-memory consolidation already retains the Part, but the recording boundary previously rebuilt function calls without sibling fields. Existing API-history reconstruction preserves the recorded signature.

## Boundaries and risks

- Old sessions whose signatures were already discarded cannot be repaired. The fix does not fabricate signatures or automatically use `skip_thought_signature_validator`.
- Dual-write duplicates opaque values and can increase request size and wire-log volume.
- A strict non-Gemini provider may reject either extension when signed history is switched across models. Shape preservation does not establish cross-model signature validity.
- Logging-only projections are outside the runtime fix unless they feed a subsequent model request.
- No official Google dual-field result is claimed yet. That check is required before upstream acceptance of the dual-write design.

## Validation and acceptance

Unit coverage includes direct, nested, and identical dual input; conflicting values; fragmented streaming arguments; signature-only and finish deltas; parallel calls; remapping; exact dual-field replay; unsigned compatibility; ordinary recording; and structured-output redaction. A separate `llm-chat` recording test drives the actual persistence call path.

Acceptance requires the focused core tests, repository build, type checking, and bundle to pass. End-to-end acceptance uses `node dist/cli.js` with `gemini-4-argon` to prove that a real tool result is followed by a successful model request and that the replay log contains both fields. A second process must resume that session and complete another tool continuation with historical signatures intact.

Official Google nested-only and dual-field replay remain separate acceptance checks. Provider-switching behavior must not be described as universally compatible without its own endpoint tests.
