# Rename `Gemini` fork-residue identifiers to `Llm`

## Problem

`#4063` item 6: the codebase still carries the `Gemini` prefix inherited from
the upstream Gemini CLI fork. Measured on `origin/main` (`43d46be912f4`):

- **~271 files** contain a `Gemini` token.
- **~4000 `Gemini` token occurrences** across `packages/core/src` and
  `packages/cli/src`, split into two shapes:
  - **PascalCase type/component names** (token-prefix): `GeminiClient`,
    `GeminiChat`, `GeminiEventType`, …
  - **camelCase function/variable names** (token-infix): `getGeminiClient`,
    `convertGeminiRequestToOpenAI`, `useGeminiStream`, `setGeminiMdFilename`, …

`GeminiClient` is the generic LLM client, not a Gemini-specific type, and the
repo has already adopted the `Llm` prefix elsewhere (`BaseLlmClient`,
`LlmRewriter`, `LlmContent`, `LlmOutputLanguage`, `LlmSpan`). The `Gemini`
residue is brand mismatch that confuses contributors and blocks a coherent
naming scheme.

## Proposal

Rename the local `Gemini` identifiers to `Llm`, with these exceptions:

1. **Memory filename** — `GeminiMdFilename` (+ `set/get/getAll/getCurrent`,
   `GeminiMdFileCount`) is the project memory file (`QWEN.md`), a memory
   concept, not an LLM client. → `Memory*`. The loader
   `loadHierarchicalGeminiMemory` (a thin wrapper around core's
   `loadServerHierarchicalMemory`) belongs to the same family: →
   `loadHierarchicalMemory`.
2. **UI spinners** — `GeminiRespondingSpinner` / `GeminiSpinner` drop the
   prefix. → `RespondingSpinner` / `Spinner`.
3. **Gemini extension format (keep as-is)** — `packages/core/src/extension/
gemini-converter.ts` converts _upstream Gemini CLI extension_ configs
   (`GeminiExtensionConfig`, `convertGeminiToQwenConfig`,
   `convertGeminiExtensionPackage`, `isGeminiExtensionConfig`). The `Gemini`
   here denotes a real external format, not the generic LLM client. **Not part
   of this rename.**
4. **`@google/genai` SDK types (out of scope)** — `Content`,
   `GenerateContentParameters`, `Part`, … are imported from `@google/genai`
   (mostly `cli/src/acp-integration`). These belong to `#4063` item 1
   (de-Google the type system), not this rename.

`@qwen-code/qwen-code-core` is also published as a standalone package. Names
already exported from its root barrel, `Config`, or supported deep-import paths
remain as deprecated aliases until a future major release; repository consumers
use only the new names.

## Symbol map

Local type/class/enum names (PascalCase, → `Llm*`):

| Current                                              | Definition                                                                | New                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `GeminiClient`                                       | `core/src/core/client.ts:375` class                                       | `LlmClient`                                    |
| `GeminiChat`                                         | `core/src/core/geminiChat.ts:1853` class                                  | `LlmChat`                                      |
| `GeminiEventType`                                    | `core/src/core/turn.ts:62` **and** `cli/src/ui/types.ts:42` (two enums)   | `LlmEventType`                                 |
| `GeminiContentGenerator`                             | `core/src/core/geminiContentGenerator/geminiContentGenerator.ts:61` class | `LlmContentGenerator`                          |
| `GeminiCodeRequest`                                  | `core/src/core/geminiRequest.ts:15` type                                  | `LlmCodeRequest`                               |
| `GeminiChatSendOptions`                              | `core/src/core/geminiChat.ts:448` interface                               | `LlmChatSendOptions`                           |
| `GeminiErrorEventValue` / `GeminiFinishedEventValue` | `core/src/core/turn.ts:112/122`                                           | `LlmErrorEventValue` / `LlmFinishedEventValue` |
| `GeminiRespondingSpinner` / `GeminiSpinner`          | `cli/src/ui/components/GeminiRespondingSpinner.tsx:32/59`                 | `RespondingSpinner` / `Spinner`                |

camelCase functions/variables (token-infix, → `Llm*`), highest-frequency first:

| Current                                                                                                                            | New                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `getGeminiClient`                                                                                                                  | `getLlmClient`                                                                                                           |
| `mockGeminiClient`                                                                                                                 | `mockLlmClient`                                                                                                          |
| `convertOpenAIChunkToGemini`                                                                                                       | `convertOpenAIChunkToLlm`                                                                                                |
| `convertGeminiRequestToOpenAI`                                                                                                     | `convertLlmRequestToOpenAI`                                                                                              |
| `convertOpenAIResponseToGemini`                                                                                                    | `convertOpenAIResponseToLlm`                                                                                             |
| `responseSubmittedToGemini`                                                                                                        | `responseSubmittedToLlm`                                                                                                 |
| `useGeminiStream`                                                                                                                  | `useLlmStream`                                                                                                           |
| `convertGeminiRequestToAnthropic`                                                                                                  | `convertLlmRequestToAnthropic`                                                                                           |
| `setGeminiMdFilename` / `getAllGeminiMdFilenames` / `getCurrentGeminiMdFilename` / `getGeminiMdFileCount` / `setGeminiMdFileCount` | `setMemoryFilename` / `getAllMemoryFilenames` / `getCurrentMemoryFilename` / `getMemoryFileCount` / `setMemoryFileCount` |
| `mockGeminiResponse` / `mockGeminiClientInstance` / `MockedGeminiClientClass`                                                      | `mockLlmResponse` / `mockLlmClientInstance` / `MockedLlmClientClass`                                                     |
| `convertGeminiToolsToOpenAI` / `convertGeminiToolsToAnthropic`                                                                     | `convertLlmToolsToOpenAI` / `convertLlmToolsToAnthropic`                                                                 |
| `convertGeminiToolParametersToOpenAI`                                                                                              | `convertLlmToolParametersToOpenAI`                                                                                       |
| `newGeminiMessageBuffer` / `makeGeminiHistoryItem` / `extractGeminiContent` / `buildGeminiChunk` / `recordGeminiChunk`             | `newLlmMessageBuffer` / `makeLlmHistoryItem` / `extractLlmContent` / `buildLlmChunk` / `recordLlmChunk`                  |
| `createInitializedGeminiClient` / `createGeminiContentGenerator`                                                                   | `createInitializedLlmClient` / `createLlmContentGenerator`                                                               |
| `mapAnthropicFinishReasonToGemini` / `convertAnthropicResponseToGemini`                                                            | `mapAnthropicFinishReasonToLlm` / `convertAnthropicResponseToLlm`                                                        |
| `pendingGeminiHistoryItems` / `skipGeminiInitialization`                                                                           | `pendingLlmHistoryItems` / `skipLlmInitialization`                                                                       |
| `loadHierarchicalGeminiMemory`                                                                                                     | `loadHierarchicalMemory` (memory family, exception #1)                                                                   |

## File renames

Non-test files; `gemini-converter.ts` is intentionally NOT renamed (see above).

| Current                                                                   | New                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/cli/src/gemini.tsx`                                             | `packages/cli/src/llm.tsx`                                              |
| `packages/cli/src/ui/components/GeminiRespondingSpinner.tsx`              | `packages/cli/src/ui/components/RespondingSpinner.tsx`                  |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`                            | `packages/cli/src/ui/hooks/use-llm-stream.ts`                           |
| `packages/core/src/core/geminiChat.ts`                                    | `packages/core/src/core/llm-chat.ts`                                    |
| `packages/core/src/core/geminiContentGenerator/geminiContentGenerator.ts` | `packages/core/src/core/llm-content-generator/llm-content-generator.ts` |
| `packages/core/src/core/geminiContentGenerator/index.ts`                  | `packages/core/src/core/llm-content-generator/index.ts`                 |
| `packages/core/src/core/geminiRequest.ts`                                 | `packages/core/src/core/llm-request.ts`                                 |

The old `geminiRequest.ts` and `geminiChat.ts` paths remain as deprecated
re-export shims until a future major release.

## Phasing

Two pull requests. The core LLM symbols are strongly coupled (`GeminiClient`
holds a `GeminiChat`, converters reference `GeminiEventType`), so the core must
move as one atomic PR.

**PR 1 — independent small families** (no cross-package risk, small diff):

- Memory filename: `GeminiMdFilename` family → `Memory*`, and
  `loadHierarchicalGeminiMemory` → `loadHierarchicalMemory` (memory loader,
  exception #1).
- UI spinners: `GeminiRespondingSpinner` / `GeminiSpinner` →
  `RespondingSpinner` / `Spinner`, and `GeminiRespondingSpinner.tsx` →
  `RespondingSpinner.tsx`.
- Leaf types: `GeminiCodeRequest`, `GeminiChatSendOptions`,
  `GeminiErrorEventValue`, `GeminiFinishedEventValue`, and `geminiRequest.ts` →
  `llm-request.ts`.
- Deprecated compatibility aliases for the public core exports, `Config`
  memory count input/accessors, memory filename helpers, and the old request
  module path.

**PR 2 — core LLM layer (atomic)**:

- `GeminiClient` → `LlmClient` (barrel + 4 importing packages) and all
  `get/mock/create…GeminiClient`.
- `GeminiChat` → `LlmChat` (`geminiChat.ts` → `llm-chat.ts`),
  `GeminiContentGenerator` → `LlmContentGenerator`
  (`geminiContentGenerator/` → `llm-content-generator/`).
- `GeminiEventType` (both enums) → `LlmEventType`.
- Stream layer: `useGeminiStream` → `useLlmStream` (`use-llm-stream.ts`),
  `gemini.tsx` → `llm.tsx`.
- Protocol converters: `convert*ToGemini*` / `convertGemini*To*` → `Llm`.
- Deprecated compatibility aliases for the published core classes, event
  types, `Config` client access/initialization option, and old chat module
  path.

## Risks

- **git blame loss**: every rename loses history (noted in AGENTS.md). Accept
  the cost once; do not rename the same file twice.
- **Cross-package barrel**: `GeminiClient` and `GeminiEventType` are exported via
  the `@qwen-code/qwen-code-core` barrel. `sdk-typescript` and `acp-bridge`
  import them; PR 2 must update those packages.
- **Published package compatibility**: renamed public symbols remain as
  deprecated aliases until a future major release. Remove them only in a planned
  major release after consumers have had time to migrate.
- **Two `GeminiEventType` enums**: `core/src/core/turn.ts` and
  `cli/src/ui/types.ts` define the same name. Rename both and verify their
  relationship (distinct enums vs re-export) before PR 2.
- **Test mock coupling**: when a module moves or a symbol renames, both the
  `vi.mock(...)` first argument AND the `typeof import(...)` type annotation
  must be updated together (lesson from `#9146`).
- **License headers**: moved files keep the original `2025 Google LLC` header.

## Verification

- `cd packages/core && npx tsc --noEmit`
- `cd packages/cli && npx tsc --noEmit`
- Targeted unit tests per renamed module
- Legacy-name grep results are confined to the documented compatibility aliases
  and `geminiRequest.ts` shim; active repository consumers use the new names.
- `npm run lint` (kebab-case filenames are enforced)
