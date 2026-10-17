# Forced tool-choice capability for OpenAI-compatible endpoints

[English](2026-10-11-forced-tool-choice-capability.md) | [简体中文](2026-10-11-forced-tool-choice-capability.zh-CN.md)

## 1. Status

Implemented and verified, 2026-10-11, on branch
`fix/tool-choice-optout-13807`, baseline `263d47e29d`. The implementation is
delivered in the same change; section 9 records the executed validation
results. The one remaining gap is live `fm serve` verification, which is
macOS-only (section 9).

## 2. Problem

The macOS Foundation Models server (`fm serve`) rejects `tool_choice:
"required"` and named tool choices with HTTP 500 `An unsupported generation
guide was used.` ([#13807](https://github.com/QwenLM/qwen-code/issues/13807)).

Every internal structured-output query goes through `generateJson`
(`packages/core/src/core/baseLlmClient.ts:500`), which unconditionally forces
a tool call: it always sends `toolConfig.functionCallingConfig.mode = ANY`
(`baseLlmClient.ts:563-571`), and the Chat Completions pipeline translates
that mode into `tool_choice: 'required'` on the wire
(`packages/core/src/core/openaiContentGenerator/pipeline.ts:1336-1343`).

Consequence: on any OpenAI-compatible endpoint that rejects forced tool
choice, every structured side query (session titles, summaries, memory
selection, the permission classifier, compaction helpers, fork-tool
sub-queries) fails with 500 — the wire shape that works everywhere else is
fatal on this class of endpoint.

The `response_format` escape hatch is not available either:
`buildResponseFormat` is gated to official OpenAI endpoints
(`pipeline.ts:1631`, `packages/core/src/core/openaiContentGenerator/prefix-caching.ts:34-47`),
so `fm serve` never receives it (see also non-goals in section 5).

The endpoint needs a way to decline forced tool choice so that
`generateJson`'s existing prose fallback takes over
(`baseLlmClient.ts:615-620`).

## 3. Current state (verified at `263d47e29d`)

### 3.1 Where `tool_choice` is written

- Chat Completions: `pipeline.ts:1337-1339` writes `'required'` when
  `fcMode === 'ANY'`; `pipeline.ts:1340-1342` writes `'none'` when
  `fcMode === 'NONE'`; `fcMode` is read at `pipeline.ts:1336`. These are the
  only writes of `tool_choice` on this wire.
- DashScope suppression already exists: it deletes `'required'` after
  `provider.buildRequest` when thinking is active
  (`pipeline.ts:1591-1616`); `isDashScope` is computed per request
  (`pipeline.ts:1379-1381`).
- Sibling wires also force: Responses translates `ANY` to `'required'`
  (`packages/core/src/core/openaiResponsesContentGenerator/responses-pipeline.ts:453-458`,
  write at `:455`) and Anthropic maps `ANY` to `{ type: 'any' }`
  (`packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts:1244-1254`,
  attached at `:859`, `:886`).

### 3.2 `generateJson` and the fallback

- `generateJson` (`baseLlmClient.ts:500-645`) registers a
  `respond_in_schema` tool (`:518-530`) and always forces ANY (`:563-571`).
- Response handling: a `respond_in_schema` function call wins (`:604-613`);
  otherwise the response text is passed through `parseLooseJsonObject`
  (`:615-620`, implementation `:410-437`), which strips a ```json fence,
takes the substring from the first `{`to the last`}`, accepts only a JSON
object (never an array), and returns `null`on any failure. When it returns`null`, `generateJson`returns`{}` (`:620`).
- `forkedAgent` reaches the same pipeline with the same forced config when it
  does not preserve tools (`packages/core/src/agents/forkedAgent.ts:566-591`),
  so a guard at the translation site covers both callers.

### 3.3 Provider and configuration plumbing

- A custom endpoint such as `http://localhost:1976/v1` matches no built-in
  detection and falls back to `DefaultOpenAICompatibleProvider`
  (`packages/core/src/core/openaiContentGenerator/index.ts:62-133`).
- `ModelGenerationConfig` is a direct `Pick<ContentGeneratorConfig, ...>`
  (`packages/core/src/models/types.ts:47-70`), so provider entries feed
  content-generator resolution without shape conversion. The runtime field
  list is `MODEL_GENERATION_CONFIG_FIELDS`
  (`packages/core/src/models/constants.ts:21-43`); `PROVIDER_SOURCED_FIELDS`
  (`:60-63`) spreads it for source tracking
  (`packages/core/src/core/contentGenerator.ts:285`).
- Resolution path: `models/modelRegistry.ts:445-471` spreads the entry's
  `generationConfig` (`:451`); `models/modelsConfig.ts:356-362` returns the
  resolved model; `BaseLlmClient.resolveForModel` (`baseLlmClient.ts:844-913`)
  builds the per-model generator (`:874-880`) which reaches the pipeline with
  this config (`openaiContentGenerator/types.ts:146-151`,
  `pipeline.ts:518-536`).
- The setup wizard feeds `generationConfig` through
  `packages/core/src/providers/types.ts:162-170` (`advancedConfig`) and
  `packages/core/src/providers/provider-config.ts:106-139`
  (`buildAdvancedGenerationConfig`).

## 4. Goals

1. Let a provider/model entry declare that its endpoint does not support
   forced tool choice, so `generateJson` side queries stop failing with 500.
2. Keep the default wire behavior byte-identical: endpoints that support
   forced tool choice are unaffected.
3. Reuse the existing prose fallback and its tests as the safety net; no new
   parsing layer and no changes to `generateJson`.
4. Make the declaration flow through the existing model configuration path
   (`modelProviders[].generationConfig` → resolved model → per-model
   generator → pipeline) without a new provider class or hostname heuristic.

## 5. Non-goals

- **No hostname auto-detection.** Do not add an `isFoundationModelsProvider`
  style check or special-case `localhost:1976`. Port and host vary, and other
  custom endpoints share the same limitation; a user-declared capability
  generalizes where a heuristic overfits.
- **No change to `isOfficialOpenAIEndpoint` / `buildResponseFormat`**
  (`pipeline.ts:1621-1648`). Broadening `response_format` is a separate
  regression surface: third-party endpoints reject the field (`pipeline.ts:1624-1630`).
- **No retry on 500.** Retrying without `tool_choice` after matching a
  third-party error string is brittle and was rejected in triage.
- **No changes to the Responses wire or Anthropic** in this change
  (`responses-pipeline.ts:453-458`,
  `anthropicContentGenerator.ts:1244-1254`). They keep forcing; extension is
  a follow-up decision (section 8, section 11).
- **No change to the `'NONE'` branch.** `tool_choice: 'none'` stays as is;
  #13807 documents rejection of `required` and named choices only.

## 6. Design

### 6.1 Field and default

New optional field on `ContentGeneratorConfig`:

```ts
// When false, the endpoint rejects forced tool selection (`tool_choice:
// "required"`), so the pipeline must not force a tool call for structured
// side queries. Default: true (force, current behavior).
supportsForcedToolChoice?: boolean;
```

- Default `true`: absent/`undefined` means the current behavior; only an
  explicit `false` opts out.
- Positive polarity (`supports...`) matches `thinkingMandatory`
  (`contentGenerator.ts:186-188`) and reads better than a negated flag.
- The field is declared on the model entry, next to the endpoint it applies
  to, in `modelProviders[].generationConfig`:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "system",
        "baseUrl": "http://localhost:1976/v1",
        "generationConfig": { "supportsForcedToolChoice": false }
      }
    ]
  }
}
```

### 6.2 Guard at the write site

In `pipeline.ts`, extend the condition at `:1337`:

```ts
if (
  fcMode === 'ANY' &&
  this.contentGeneratorConfig.supportsForcedToolChoice !== false
) {
  (baseRequest as unknown as Record<string, unknown>)['tool_choice'] =
    'required';
} else if (fcMode === 'NONE') {
  (baseRequest as unknown as Record<string, unknown>)['tool_choice'] = 'none';
}
```

- The field is omitted entirely when suppressed; the pipeline does not send
  `'auto'` as a substitute. Omission is the widest-compatible shape (no
  unknown field for validating gateways) and is semantically the OpenAI
  default anyway.
- Guarding the write avoids writing at `:1337` and deleting at `:1615`. The
  DashScope suppression (`:1591-1616`) stays untouched: if both apply, the
  later delete is a harmless no-op.
- This single site covers `generateJson` and the `forkedAgent` path
  (section 3.2), because both reach the same pipeline.

### 6.3 Plumbing path (settings → guard)

1. **Type.** Add `supportsForcedToolChoice?: boolean` to
   `ContentGeneratorConfig` (`contentGenerator.ts:82-208`, near
   `thinkingMandatory` at `:186-188`).
2. **Model scope.** Add the key to `ModelGenerationConfig`
   (`models/types.ts:47-70`) and to `MODEL_GENERATION_CONFIG_FIELDS`
   (`models/constants.ts:21-43`). `PROVIDER_SOURCED_FIELDS`
   (`models/constants.ts:60-63`) spreads that list, so source tracking
   (`contentGenerator.ts:285`) picks the field up automatically; a test
   should assert the resolved config keeps it.
3. **Resolution.** The value flows through `modelRegistry.ts:451`
   (`resolveModelConfig` spread), `modelsConfig.ts:356-362`
   (`getResolvedModel`), and `BaseLlmClient.resolveForModel`'s per-model
   generator (`baseLlmClient.ts:874-880`), which builds the pipeline config
   (`openaiContentGenerator/types.ts:146-151`, `pipeline.ts:520`, `:528`).
4. **Settings schema and docs.** Add the property metadata to the settings
   schema generation-config surface (`packages/cli/src/config/settingsSchema.ts:1972-2140`)
   and document it in `docs/users/configuration/model-providers.md`
   (`generationConfig` examples at 282-420) and
   `docs/users/configuration/settings.md` (`model.generationConfig` table at
   197). Note that `modelProviders` entries are validated loosely
   (`settingsSchema.ts:393-403`), so the property is schema-validated only on
   the `model.generationConfig` node; the `modelProviders[]` entry surface is
   documented but not schema-validated.
5. **Wizard (open question).** Exposing a toggle in the custom-provider setup
   flow (`providers/types.ts:162-170`,
   `providers/provider-config.ts:106-139`) is optional and deferred; the
   minimal surface is settings + docs.

### 6.4 Fallback semantics

When the guard suppresses `tool_choice`, the request still carries the
`respond_in_schema` tool. On `fm serve`, the tool `parameters` schema is
applied as a generation guide and the object arrives as prose content with
`tool_calls: null` (per the reporter's guide). `generateJson` then:

1. finds no function call (`baseLlmClient.ts:604-613`);
2. reads the text (`:615`) and runs `parseLooseJsonObject` (`:617`,
   `:410-437`);
3. returns the parsed object, or `{}` when the text is not a usable JSON
   object (`:620`).

`{}` is a silent degradation (empty titles/suggestions, `failUnavailable`
classifier behavior), not an error. It is accepted as strictly better than
the current 500 (section 8).

## 7. Constraints

- **Behavior-preserving default.** Absent field ⇒ identical request bodies
  and unchanged existing tests; the existing `tool_choice` contracts
  (`pipeline.test.ts:758`, `:837`, `:868`, `:1203`) must pass untouched.
- **Type and runtime list move together.** `ModelGenerationConfig`
  (`models/types.ts:47-70`) and `MODEL_GENERATION_CONFIG_FIELDS`
  (`models/constants.ts:21-43`) must be updated in the same change, or the
  field is dropped during source tracking (`contentGenerator.ts:285`).
- **Model-scoped declaration.** The supported configuration surface is the
  per-model provider entry (`modelProviders[].generationConfig`), matching
  how other request-shaping fields are declared for provider models
  (`docs/users/configuration/settings.md:197`).
- **No changes to `isOfficialOpenAIEndpoint` or `buildResponseFormat`**
  (`prefix-caching.ts:34-47`, `pipeline.ts:1621-1648`).
- **No new provider class, no hostname check, no retry logic.**

## 8. Risks & accepted debt

1. **Flag `false` on a capable endpoint.** If a user disables forced tool
   choice on an endpoint that supports it, thinking-heavy models may skip the
   tool call and `generateJson` silently returns `{}`
   (`baseLlmClient.ts:563-568` documents why forcing exists). Mitigations:
   default `true`, explicit opt-out only, docs, and tests that pin both
   branches. This is the accepted debt for #13807: silent `{}` degradation is
   preferable to a 500 on every side query.
2. **Fallback is object-only.** `parseLooseJsonObject` rejects arrays and
   malformed JSON (`baseLlmClient.ts:422-436`), so `{}` remains possible even
   when the model emits content. Pinned by
   `baseLlmClient.test.ts:293-320`.
3. **`fm serve` prose behavior not verified live.** The "schema-as-guide →
   parseable prose" claim comes from the reporter's guide; there is no macOS
   environment in CI. The reporter has offered to re-verify.
4. **Sibling wires still force.** A user running `wireApi: 'responses'`
   against such an endpoint keeps the 500
   (`responses-pipeline.ts:453-458`). Documented; covering it can be a
   follow-up (section 11).
5. **`tool_choice: 'none'` still reaches the wire.** #13807 documents
   rejection of `required`/named choices only; if a future endpoint rejects
   any `tool_choice`, the gate must be widened (section 11).
6. **DashScope redundancy.** With the flag `false` on DashScope, the
   suppression at `pipeline.ts:1615` becomes redundant but remains harmless.

## 9. Validation results

Executed 2026-10-11 on branch `fix/tool-choice-optout-13807`; per repository
convention, package tests ran from the package directory. TDD red baseline
(before implementation): the four targeted core files below reported
6 failed / 481 passed, pinning the missing capability.

| Command                                                                                                                                                                                                 | What it pins                                                                                                                                                                                       | Result                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/core && npx vitest run src/core/openaiContentGenerator/pipeline.test.ts src/core/baseLlmClient.test.ts src/models/content-generator-config.test.ts src/models/modelConfigResolver.test.ts` | `false` suppresses `'required'`; `undefined` keeps it; DashScope and GLM contracts unchanged; prose fallback and per-model resolution unchanged; the field survives resolution and source tracking | 487/487 passed ✅ (pipeline 290, baseLlmClient 94, content-generator-config 41, modelConfigResolver 62)                                                                                                  |
| `cd packages/cli && npx vitest run src/config/settingsUtils.test.ts`                                                                                                                                    | the `model.generationConfig` schema node accepts a boolean `supportsForcedToolChoice` (the `modelProviders[]` entry surface is documented but not schema-validated)                                | 67/67 passed ✅                                                                                                                                                                                          |
| `npm run build --workspace=@qwen-code/qwen-code-core`                                                                                                                                                   | compilation of the new field and guard                                                                                                                                                             | ✅                                                                                                                                                                                                       |
| `npm run typecheck` (repository root)                                                                                                                                                                   | repository-wide type checking                                                                                                                                                                      | ✅                                                                                                                                                                                                       |
| Mutation check: remove `supportsForcedToolChoice !== false` from the guard, rebuild core, run `pipeline.test.ts`                                                                                        | the tests actually pin the guard                                                                                                                                                                   | Mutated: 1 failed / 289 passed — `AssertionError: expected 'required' to be undefined` at `pipeline.test.ts:886`; restored: 290/290 passed ✅; `git diff` sha256 identical before and after (`dcf0bce…`) |
| Manual: macOS, `fm serve`, fast model `openai:system\0http://localhost:1976/v1`, flag `false`                                                                                                           | side queries stop 500ing; prose parsing yields objects; default config unchanged where supported                                                                                                   | Pending — not run (macOS only); the reporter should re-verify                                                                                                                                            |

The manual check is environment-gated (macOS only) and cannot run in this
Linux workspace.

## 10. Acceptance criteria

- [x] An entry with `generationConfig.supportsForcedToolChoice: false` ships
      no `tool_choice` field for `fcMode: 'ANY'` queries on Chat Completions.
- [x] Absent or `true` leaves request bodies unchanged; existing pipeline
      tests pass without edits.
- [x] The value flows settings → resolved model → per-model generator →
      `contentGeneratorConfig` in the pipeline, and source tracking retains
      it after provider resolution.
- [ ] `generateJson` recovers a JSON object from prose via
      `parseLooseJsonObject` and returns `{}` when nothing parses. Unit tests
      are green; live `fm serve` prose recovery has not been observed and the
      reporter should re-verify.
- [x] Targeted unit tests, `npm run build`, `npm run typecheck`, and
      `npm run lint` are green.
- [x] `docs/users/configuration/model-providers.md` documents the field with
      the `fm serve` example, and `docs/users/configuration/settings.md`
      documents it in the settings table, since the field is also accepted
      under `model.generationConfig` for runtime models.
- [x] No change to `isOfficialOpenAIEndpoint`, `buildResponseFormat`, the
      Responses wire, or Anthropic.

## 11. Open questions

1. **Wizard and schema exposure.** Should the custom-provider setup flow
   (`providers/types.ts:162-170`) grow a toggle, or is settings + docs the
   intended surface for now?
2. **Wire coverage.** Extend suppression to the Responses wire and Anthropic
   in this change, or track it as a follow-up?
3. **Observability.** Should suppression emit a `debugLogger` line analogous
   to the DashScope drop (`pipeline.ts:1611-1614`)?
4. **`'none'` branch.** If an endpoint rejects any `tool_choice` value, is
   gating `'none'` the same way in scope later?
