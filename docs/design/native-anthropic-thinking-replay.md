# Native Anthropic thinking replay

[English](native-anthropic-thinking-replay.md) | [简体中文](native-anthropic-thinking-replay.zh-CN.md)

## Problem

Shared history can contain `thought: true` parts without `thoughtSignature`,
whether from another provider or an incomplete historical response. Native
Anthropic requests currently serialize them as unsigned `thinking` blocks,
causing repeated HTTP 400 failures. Missing signatures alone do not establish
that persistence lost them. See [issue 15742](https://github.com/QwenLM/qwen-code/issues/15742).

## Decision

Enforce native replay constraints at the outgoing request boundary. Reuse the
existing message-level unsigned-thinking cleanup, independently of the outgoing
thinking configuration and model generation. Keep original stored history intact.

Split foreign-reasoning presentation from unsigned-thinking removal. The
converter receives `demoteForeignThoughtToText` separately, enabled only under
the existing adaptive proxy condition. Native requests discard unsupported
foreign thinking on completed turns without turning its summary into answer text.

| Endpoint                             | Unsigned thinking on completed turns                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| Native Anthropic, thinking on or off | Drop                                                               |
| Adaptive Claude proxy, thinking on   | Drop; preserve existing foreign-summary demotion                   |
| Adaptive Claude proxy, thinking off  | Preserve existing behavior                                         |
| Older compatible proxy               | Fill `signature: ''`                                               |
| DeepSeek                             | Preserve existing normalization, injection, and stripping behavior |

## Constraints

The cleanup preserves signed thinking. An unsigned block in an active tool-use
chain still fails locally: the client cannot reconstruct its opaque signature
or claim safe continuation. Its diagnostic describes missing session history
without blaming a proxy. Keep cleanup after assistant merging and orphan repair,
and before empty-thinking removal so malformed earlier steps remain observable.

No new user configuration, transcript migration, broad `Part[]` redesign, or
HTTP-error-driven retry is needed. Managed side queries already select thinking
stripping and do not opt into either newly separated behavior.

## Validation and acceptance

- Native missing and empty signatures are removed across manual and adaptive
  models, request-level thinking overrides, and disabled model reasoning.
- Explicit, SDK-default, and environment-provided native URLs select cleanup.
- Valid signed thinking, visible answers, and completed tool exchanges survive;
  thinking-only messages disappear and adjacent user messages merge.
- Foreign summaries do not become native answer text; proxy demotion and
  DeepSeek/older-proxy filling remain covered.
- Single-step and multi-step active tool loops fail before an SDK request,
  including an empty unsigned block in an earlier step.
- Conversion leaves stored input unchanged and supports subsequent replay.

Run the focused converter and generator tests, the workspace build and
typecheck, and the bundled request-conversion reproduction. Live native API
acceptance is a separate validation: fake test signatures do not prove
cryptographic replay or preserved-thinking prefix validity. Existing
`block_binding` behavior remains unchanged and must be included in live checks.

## Follow-up boundary

Investigate a concrete signature-loss or recovery/persistence divergence only
when original response and transcript evidence identifies it. This change
recovers completed history; it does not repair an active tool loop or close the
broader history-representation problem.
