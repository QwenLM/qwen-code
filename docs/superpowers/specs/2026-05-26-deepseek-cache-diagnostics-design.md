# DeepSeek Cache Diagnostics Design

## Goal

Add a small, mergeable P0 diagnostics layer that helps Qwen Code operators see whether DeepSeek cache-sensitive tool prefixes are stable across turns, without changing request behavior or logging prompt text, tool descriptions, tool parameters, or tool outputs.

This spec intentionally does not implement a static tool manifest protocol, semantic cache, sidecar cache, or subagent prefix DAG. Those ideas need separate specs after this baseline proves where request drift is happening.

## Context

DeepSeek cache hits depend on exact prefix reuse. The user-provided research report highlights a public Qwen Code case where ToolSearch reduced prompt size but lowered DeepSeek cache hit rate because the tool schema prefix changed across requests.

The current code already has several P0 defenses:

- `packages/cli/src/config/config.ts` auto-denies `tool_search` for `deepseek-v3`, `deepseek-v4`, and `deepseek-chat` style model names unless the user explicitly enables ToolSearch.
- `packages/core/src/core/client.ts` eagerly reveals deferred tools when ToolSearch is unavailable, which keeps schemas visible in the initial declaration list.
- `packages/core/src/core/openaiContentGenerator/provider/deepseek.ts` adapts DeepSeek request shape for content flattening and `reasoning_effort`.
- `packages/core/src/utils/runtimeDiagnostics.ts` already records OpenAI wire request sizes and tool schema byte counts when `QWEN_CODE_PROFILE_RUNTIME=1`.

The missing piece is a stable, privacy-preserving fingerprint for the tool declaration prefix. Today diagnostics can say "tools changed size"; they cannot say whether the same tool set reordered, whether schema bytes changed, or whether DeepSeek-related requests are using a stable tool manifest.

## Proposed Approach

Add provider-aware cache-stability diagnostics to the existing runtime diagnostics path.

For each OpenAI-compatible wire request, record a `cacheStability` object with hashes and small metadata derived from `request.tools`. For DeepSeek-hosted requests, mark the diagnostics as cache-sensitive so operators know these values affect cost. The first implementation is observational only: it must not reorder tools, mutate schema objects, or change provider requests.

The recommended shape is:

```ts
interface OpenAICacheStabilityDiagnostics {
  provider?: 'deepseek' | 'openai-compatible';
  toolNames: string[];
  toolNameSequenceHash: string;
  toolNameSetHash: string;
  toolSchemaHash: string;
  canonicalToolManifestHash: string;
}
```

The fields mean:

- `provider`: `deepseek` when the configured base URL hostname is `api.deepseek.com` or a subdomain; otherwise omitted or `openai-compatible`.
- `toolNames`: function names in the exact wire order sent to the provider.
- `toolNameSequenceHash`: hash of the ordered tool-name sequence.
- `toolNameSetHash`: hash of the sorted tool-name set.
- `toolSchemaHash`: hash of the exact `request.tools` JSON shape as sent on the wire.
- `canonicalToolManifestHash`: hash of a canonical manifest sorted by function name. Each entry should store only the function name plus hashes of the description and parameters after recursive key sorting.
- `toolSchemaBytes`: keep the existing byte count.

These fields allow three useful comparisons:

- Same `toolNameSetHash`, different `toolNameSequenceHash`: tool order drift.
- Same `toolNameSequenceHash`, different `canonicalToolManifestHash`: schema content drift.
- Same `canonicalToolManifestHash`, different `toolSchemaHash`: serialization/key-order drift.

## Architecture

### Runtime Diagnostics

Extend `packages/core/src/utils/runtimeDiagnostics.ts`.

Responsibilities:

- Keep summarization privacy-preserving.
- Compute stable SHA-256 hashes for tool diagnostics.
- Keep existing public summaries backward-compatible by adding optional fields.
- Export small pure helpers so unit tests can exercise canonicalization directly.

The diagnostics collector remains disabled unless `QWEN_CODE_PROFILE_RUNTIME=1`, matching current behavior.

### OpenAI Pipeline

Extend `packages/core/src/core/openaiContentGenerator/pipeline.ts`.

Responsibilities:

- Pass provider context into `runtimeDiagnostics.recordOpenAIWireRequest`.
- Use `isDeepSeekHostname(this.contentGeneratorConfig)` for DeepSeek-hosted detection.
- Avoid model-name-only DeepSeek detection for cache-sensitive provider labeling because self-hosted DeepSeek-compatible models might not share DeepSeek billing/cache behavior.

### Documentation

Update `docs/users/configuration/model-providers.md` or the runtime diagnostics section of settings docs.

Responsibilities:

- Explain that DeepSeek uses exact-prefix cache behavior and that stable tool schemas matter.
- Show how to enable `QWEN_CODE_PROFILE_RUNTIME=1`.
- Explain how to interpret the new hashes.
- Reiterate that diagnostics store hashes and sizes, not prompt text or schema bodies.

## Data Flow

1. Qwen Code builds a Gemini request with tool declarations.
2. The OpenAI pipeline converts it to an OpenAI-compatible request.
3. The provider reshapes the request as needed.
4. Before dispatch, the pipeline records runtime diagnostics.
5. Runtime diagnostics extracts OpenAI tool definitions, computes hashes, and stores the summary in the in-memory snapshot.
6. Existing stats/debug surfaces can read the snapshot without needing provider request bodies.

## Privacy And Safety

The diagnostics must not retain:

- user prompt text,
- system prompt text,
- tool descriptions,
- JSON schema bodies,
- tool arguments,
- tool outputs,
- API keys or headers.

The hasher may read tool descriptions and schemas transiently in memory, but the stored snapshot must contain only names, counts, byte lengths, and hashes.

The diagnostics may retain:

- tool names,
- counts,
- byte lengths,
- SHA-256 hashes of tool manifests,
- provider label.

Tool names are already surfaced in other diagnostics paths, but this spec still treats them as operational metadata rather than user content.

## Error Handling

Diagnostics must never block a model request. If hashing or canonicalization encounters unexpected input, it should fall back to an empty or partial cache-stability summary and continue.

Circular structures should be handled with the existing safe stringification style. Request tools are normally JSON-compatible, so circular input is a defensive case, not the expected path.

## Testing

Use TDD for implementation.

### Unit Tests

Add focused tests in `packages/core/src/utils/runtimeDiagnostics.test.ts`:

- OpenAI summaries include cache-stability hashes and ordered tool names.
- The summary still does not contain prompt text, tool descriptions, schema property names from sensitive fixtures, or user content.
- `toolNameSetHash` remains stable when tools are reordered.
- `toolNameSequenceHash` changes when tools are reordered.
- `canonicalToolManifestHash` remains stable when equivalent schema objects use different key insertion order.
- `toolSchemaHash` changes when the exact wire schema changes.

### Pipeline Tests

Add or update tests in `packages/core/src/core/openaiContentGenerator/pipeline.test.ts`:

- DeepSeek hostname requests pass provider context to runtime diagnostics.
- Non-DeepSeek OpenAI-compatible requests do not get marked as DeepSeek cache-sensitive.

### Config Regression Test

Add a regression case in `packages/cli/src/config/config.test.ts` for the user-facing model name `deepseek-v4-pro`, confirming ToolSearch remains auto-denied unless explicitly enabled.

## Rollout

This is safe to merge behind the existing `QWEN_CODE_PROFILE_RUNTIME=1` diagnostics gate. No new user-facing feature flag is required because the change is observational and disabled by default.

Rollback is simple: remove the optional fields or stop passing provider context. Since the request body is not mutated, rollback should not affect model behavior.

## Non-Goals

- Do not reorder tools in this change.
- Do not change ToolSearch behavior.
- Do not add a static tool manifest protocol.
- Do not add local semantic cache or object storage.
- Do not add prompt/body hashes that fingerprint full user messages.
- Do not change DeepSeek request generation other than diagnostics metadata.

## Acceptance Criteria

- Runtime diagnostics can distinguish tool set drift, tool order drift, schema drift, and serialization drift.
- DeepSeek-hosted OpenAI-compatible requests are labeled as cache-sensitive in diagnostics.
- Tests prove no prompt text, tool descriptions, schema bodies, tool args, or tool outputs are retained.
- The implementation has no behavioral effect when diagnostics are disabled.
- The docs explain how to enable and interpret the new diagnostics.
