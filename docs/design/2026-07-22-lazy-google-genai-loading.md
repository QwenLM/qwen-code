# Lazy `@google/genai` loading

- **Issue**: #7264 candidate 3
- **Scope**: ACP cold-start import closure
- **Status**: implemented and validated

## Problem

The bundled ACP runtime currently reaches the `@google/genai` Node entry through nine eager runtime import sites. The SDK contributes 755,788 bytes to a shared 1,196,331-byte chunk containing 77 inputs, including `google-auth-library` and `gaxios`. Because the ACP bootstrap imports the full CLI entry before answering `initialize`, this chunk is parsed and evaluated even though bootstrap deliberately skips Gemini client initialization and MCP discovery.

Changing the eager imports to `import()` is not sufficient. ACP session creation calls `ensureAuthenticated()` and `createContentGenerator()` before returning the session response. The existing provider imports and `LoggingContentGenerator` construction would therefore load the SDK during `newSession`, moving work out of `channel.initialize` without improving process-to-first-session.

## Design

### Lightweight synchronous compatibility values

Core orchestration uses only a small synchronous subset of the SDK outside provider implementations: `FinishReason`, `FunctionCallingConfigMode`, `createUserContent`, and `createModelContent`. A package-local compatibility module provides those values while retaining SDK types as type-only imports. Its content conversion mirrors the SDK's validation and output shape so existing callers keep the same behavior without evaluating the SDK.

Provider implementations continue to use the official SDK classes. In particular, this change does not copy or replace `GenerateContentResponse`.

### Single-flight lazy content generator

`createContentGenerator()` still validates configuration, preloads the runtime fetch implementation, and performs Qwen OAuth credential acquisition at its current point in the session lifecycle. It returns a private lazy `ContentGenerator` whose memoized loader constructs the selected provider and wraps it in `LoggingContentGenerator` on the first asynchronous content-generator operation.

All four asynchronous operations share the same loader promise:

- `generateContent`
- `generateContentStream`
- `countTokens`
- `embedContent`

Concurrent first calls therefore import and construct the provider once. `useSummarizedThinking()` remains synchronous and is supplied from the selected provider's known behavior: true for Gemini/Vertex and false for OpenAI, Qwen OAuth, and Anthropic.

Qwen OAuth credential acquisition remains eager within `createContentGenerator()`. An expired or missing cached credential therefore continues to reject ACP session creation rather than producing an apparently usable session that fails only on its first prompt.

Dynamic-import failures retain the existing background-update restart message, although provider-chunk failures now surface on first generator use. An auth refresh replaces the lazy generator, which also provides the retry boundary after a failed loader.

### MCP first use

`mcpToTool` is loaded dynamically inside `discoverTools()`. This preserves the SDK's pagination, duplicate-name handling, callable-tool fallback, and MCP usage header side effect. Configurations with MCP servers may therefore evaluate `@google/genai` during background MCP discovery before the first model prompt. This is an intentional first-use exception: replacing `mcpToTool` would duplicate experimental SDK behavior and materially widen the regression surface.

The guaranteed boundary is that `@google/genai` is absent from the ACP bootstrap static closure. With no configured MCP server, it remains unloaded through session creation and loads on the first `ContentGenerator` operation.

### Bundle guard

The serve fast-path metafile guard adds `@google/genai` to the ACP forbidden-package list. Dynamic chunks remain allowed. This makes a future static re-import fail CI with its output import path.

## Downstream consumer audit

There are three direct production creation paths. `Config.refreshAuth()` owns the main-session generator. `BaseLlmClient` owns cached per-model generators for routed side requests. `createRuntimeContentGeneratorView()` owns dedicated generators used by the in-process agent backend, subagent manager, and forked agents. Each path stores and consumes only the `ContentGenerator` interface, so the private lazy wrapper preserves its ownership and routing boundary.

The interface consumers call only `generateContent`, `generateContentStream`, `countTokens`, `embedContent`, and `useSummarizedThinking`. The main chat path, prompt hooks, memory/goal/side queries, vision routing, subagents, and session resume do not inspect the concrete provider or unwrap `LoggingContentGenerator`; a repository-wide search found no production `instanceof` or `getWrapped()` caller. MCP tool discovery is separate from generator ownership and keeps the SDK-provided `mcpToTool` adapter behind its own first-use import.

## Alternatives rejected

- **Only make the current imports dynamic**: improves `channel.initialize` but loads the same SDK during `newSession`, so it does not address process-to-first-session.
- **Delay `GeminiClient.initialize()` itself**: changes chat construction, resume, tool registration, session readiness, and authentication error timing.
- **Copy `GenerateContentResponse`**: risks prototype and getter drift across SDK upgrades and changes the runtime objects returned by OpenAI and Anthropic adapters.
- **Replace `mcpToTool` locally**: duplicates an experimental SDK adapter and drops or must reproduce its process-global MCP telemetry behavior.
- **Import undocumented SDK internals**: `@google/genai` exposes no supported lightweight subpath for these helpers and classes.

## Compatibility and failure paths

- Provider validation remains in `createContentGenerator()`.
- Qwen OAuth credential checks remain before ACP session registration.
- The first loader is single-flight across concurrent prompts and side queries.
- An already-aborted first request may still complete module evaluation, because ESM imports are not cancellable; the provider receives the original aborted signal afterward.
- Model configuration is captured by reference as today, so same-provider model changes made before first use are observed by the provider constructor.
- Auth/provider changes rebuild the lazy generator through the existing `refreshAuth()` path.
- A missing dynamic chunk after a background CLI update produces the existing restart guidance.

## Verification

Unit tests cover helper parity, deferred construction, Qwen credential timing, single-flight behavior, provider-specific summarized-thinking values, deferred module failures, and MCP discovery behavior. The bundled metafile must show `@google/genai` absent from the ACP static closure while retaining it in dynamic provider/MCP chunks.

The 2C4G acceptance run follows #7264: 30 paired serial cold starts, `channel.initialize` P50/P95, process-to-first-session, preheated/warm behavior, concurrent first sessions, telemetry on/off, and peak RSS. Because this change moves work later, it additionally records session-response-to-first-token and process-to-first-token for an immediate first prompt. A startup win that is fully repaid as a first-token regression is reported rather than treated as a successful optimization.

## Results

The control was the then-current `origin/main` at `dd2552018a72a2b5795977211f06435711e5f99a`, which already includes the lazy telemetry/protocol work and the lazy-undici change. The candidate was the exact final working-tree bundle. Both were built from the same lockfile and tested on the supplied Alibaba Cloud host with 2 vCPUs, approximately 3.5 GiB RAM, no swap, and bundled Node.js 22.23.1.

The ACP static closure dropped from 14,279,497 bytes to 13,280,177 bytes (999,320 bytes). The control closure contained 755,788 bytes attributed directly to `@google/genai`; the candidate contained zero. The SDK remains present in dynamic chunks for provider and MCP first use.

With telemetry enabled to an outfile, 30 alternating paired cold starts produced:

| Metric                   | Control P50 / P95  | Candidate P50 / P95 | P50 delta |
| ------------------------ | ------------------ | ------------------- | --------- |
| `channel.initialize`     | 984.9 / 1010.6 ms  | 954.8 / 972.5 ms    | -30.1 ms  |
| cold `POST /session`     | 1293.1 / 1316.0 ms | 1252.4 / 1291.3 ms  | -40.7 ms  |
| process to first session | 1924.6 / 1951.1 ms | 1858.7 / 1901.0 ms  | -65.9 ms  |
| `phase.gemini_import`    | 536.3 / 550.2 ms   | 517.2 / 526.5 ms    | -19.1 ms  |
| peak RSS                 | 414.6 / 427.1 MiB  | 406.5 / 420.5 MiB   | -8.0 MiB  |

After a three-second preheat, `channel.initialize` remained 32.7 ms faster at P50, while `POST /session` improved by 4.8 ms. Concurrent first sessions, telemetry disabled, and legacy single-session mode all succeeded; every process tree was cleaned up and telemetry-disabled mode emitted zero records.

An additional telemetry-off run issued an immediate real OpenAI-compatible prompt in 30 alternating pairs. All 60 prompts completed. Process-to-session improved by 53.4 ms at P50 and the candidate was faster in 28 of 30 pairs. Prompt-to-first-token was effectively neutral under model-network variance: candidate P50 was 24.2 ms faster and candidate was faster in 16 of 30 pairs; P95 was 297.6 ms slower because both variants had unrelated multi-second network outliers. End-to-end process-to-first-token P50 improved by 57.6 ms, with candidate faster in 19 of 30 pairs. This rules out a demonstrated median cost shift, but the first-token tail is not attributable enough to claim an additional model-call performance win.
