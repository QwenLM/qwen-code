# Anthropic Proxy Unsigned Thinking Recovery

## Problem

Claude 4.6+ uses adaptive thinking by default in the Anthropic content generator. Some Anthropic-compatible proxies do not preserve the opaque signature returned with a thinking block. Qwen Code then replays that block without a signature on the next turn, and the proxy rejects the request.

An empty signature is not a valid replacement for a Claude signature. It is a DeepSeek-specific compatibility behavior and must not be generalized to every Anthropic-compatible endpoint.

Anthropic documents signatures as opaque encrypted values. Thinking blocks may be omitted from prior completed turns, but an active tool loop must be replayed completely and unchanged; see the [extended thinking documentation](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).

## Behavior

For a non-Anthropic-native, non-DeepSeek endpoint using a recognized Claude 4.6+ model with thinking enabled:

- Remove assistant thinking blocks whose signature is missing or empty from completed turns outside the active tool loop. Keep the visible assistant content unchanged.
- If an unsigned thinking block belongs to the active tool loop, stop locally with an actionable error. Claude requires every thinking block in an interleaved tool loop to be replayed completely and unmodified, so the client cannot recover that turn. Thinking from an older, completed tool loop may be omitted.
- Preserve every non-empty signature byte-for-byte.

Native Anthropic endpoints, DeepSeek endpoints, non-Claude models, and requests without thinking retain their existing behavior.

## Scope

The request converter owns the history cleanup because it already handles provider-specific thinking normalization. The generator enables the cleanup only for the affected proxy/model/request combination.

Streaming signature event-shape normalization is out of scope. If a proxy sends a valid signature in a nonstandard event shape, that should be addressed separately without changing the missing-signature fallback.

This recovery runs after a thinking part already exists in conversation history, which is the Claude Opus 4.6 summarized-thinking failure reported in #6888. Persisting signature-only streams, including the default omitted-thinking response used by newer models, is a separate ingestion concern and is not changed here.

The proxy and model checks deliberately fail closed for an active unsigned tool loop. A custom backend that uses a canonical Claude 4.6+ model name but does not enforce Claude's signed-thinking protocol must either preserve signatures or disable reasoning for a new session.

## Verification

- Reproduce a proxy request containing adaptive thinking and an unsigned assistant history block.
- Verify completed unsigned thinking is removed while visible text remains.
- Verify signed thinking is unchanged.
- Verify an unsigned active tool-use turn fails locally with guidance to preserve signatures, while a completed tool loop remains recoverable.
- Verify native Anthropic and DeepSeek behavior remains unchanged.
