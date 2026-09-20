# Parameterless tool `parameters` opt-in

[简体中文](./2026-09-17-parameterless-tool-parameters.zh-CN.md)

Status: implemented.

## Problem

A function tool that takes no arguments is sent without a `parameters` object.
Strict OpenAI-compatible servers that type `tools[].function.parameters` as a
required Pydantic field reject the whole request over it — `Field required` on
`tools[].function.parameters`, reported against TabbyAPI. The request fails
before the model sees any tool, so no tool call can be made at all.

## Why the field is omitted today

The omission is deliberate, not an oversight. Commit `03005a2bbf`
(`fix(core): omit parameterless OpenAI tool schemas`, #11431) added it on top of
the grammar relaxation from #10080, and the lineage in that commit message runs
#10520 → #11410 → #11431:

- `relaxSchemaForFunctionCalling` strips an empty `properties` object, so a
  zero-argument schema reaches the wire as a bare `{ "type": "object" }`.
- That bare shape is what #11410 reports as an HTTP 400 on llama.cpp, LM Studio
  and vLLM — the endpoints #10080 was written for.
- MiniMax needs the field to be present instead, with `{ "type": "object",
"properties": {} }` (#11834), and already injects it one layer down in its own
  provider.

So the two sides of the spec disagree, and the shapes that satisfy one reject the
other. The converter cannot pick a shape that serves both.

## Decisions

### Opt in per route, do not sniff the endpoint

`model.generationConfig.toolParametersMandatory` (default `false`) selects the
behaviour, alongside the existing `splitToolMedia` and `toolResultContentFormat`
strict-server keys. Endpoint sniffing was rejected: a self-hosted server shares
`localhost` with llama.cpp, LM Studio, Ollama and vLLM — exactly the endpoints
that need the omission — and TabbyAPI's port is configurable, so the URL carries
no fact that separates it.

Provider selection cannot be the gate either. Four of the nine vendor predicates
in `openaiContentGenerator/provider/` match on the model id as well as the
hostname: a `deepseek` substring (`deepseek.ts`), a `glm-` prefix (`zai.ts`), a
`mimo-` prefix (`mimo.ts`) and seven Mistral markers (`mistral.ts`). A local
server serving a `deepseek-v4.1-flash` or `glm-4.6` distill is therefore routed
to that vendor's provider at any baseUrl, loopback included, and only MiniMax
injects a `parameters` schema among them. The opt-in is read per request instead.

The field is declared on `ContentGeneratorConfig`, added to
`ModelGenerationConfig` and `MODEL_GENERATION_CONFIG_FIELDS` so a
`modelProviders` entry can set it per model, and documented in
`docs/users/configuration/settings.md`.

### Repair at the outbound boundary, not in the converter

`DefaultOpenAICompatibleProvider` fills `parameters: { "type": "object",
"properties": {} }` for any tool whose `parameters` is `undefined`, gated on the
opt-in. Every vendor provider chains `super.buildRequest`, so the repair reaches
a route whichever provider owns it; DashScope assembles its request from scratch
and calls the same repair from its merge step. The map itself lives in
`provider/utils.ts`, which MiniMax also uses for its unconditional injection.

Doing it in the converter instead would mean choosing one shape for every
OpenAI-compatible route, and `provider/minimax.ts` records that constraint
explicitly.

Acting on the request rather than the tool list also covers the two ways a tool
can end up with no `parameters` at all: one that declares an empty argument
list, which the converter reduces to `undefined`, and one that declares no
schema at all, which never receives a schema. A converter-side fix only reaches
the first.

A third shape is left alone because it already carries the field: a schema
declared as `{ "type": "object" }` with no `properties` key. The converter
reduces only a schema that declares an empty `properties` object, or one whose
`properties` is absent together with `additionalProperties: false`, so a bare
object meets neither condition, `relaxSchemaForFunctionCalling` leaves it
intact, and the repair — which keys on `parameters === undefined` — leaves it
untouched. An opted-in request therefore carries the empty-object schema for the
tools above and the declared shape for a tool that publishes this one. The field
is present either way, and the TabbyAPI run below records HTTP 200 for the bare
shape, so this is a shape split rather than a rejected request. An MCP tool
registered with an empty argument list is not an instance of this carve-out: the
SDK publishes it as `{ "type": "object", "properties": {} }`, which the converter
does reduce, so the opt-in rewrites it. Filling `properties` on the tools the
repair leaves alone, so that every parameterless tool ships one shape, is
recorded under Not in scope; the user-facing documents qualify the promise the
same way.

### Shape

`{ "type": "object", "properties": {} }`, the empty-object schema MiniMax
already injects for its own endpoint (#11834). One shape now serves both the
opt-in repair and MiniMax's unconditional injection, so an opted-in route
behaves the same whichever provider owns it. A server that only checks field
presence accepts this schema. The bare `{ "type": "object" }` this branch first
shipped with is what #11410 reports as an HTTP 400 on llama.cpp, LM Studio and
vLLM — routes that must keep the omission, and therefore never opt in.

### No separate provider

The first shape of this change added a dedicated provider and a branch for it
below the nine vendor predicates, with a comment stating those were all hostname
checks. That was wrong: the branch sat below the four model-name predicates
above, so a strict gateway serving a `deepseek`, `glm-`, `mimo-` or `mistral`
model id got the vendor provider, the flag was never read, and the server
answered the same `Field required` the setting exists to prevent — with nothing
logged to connect the switch to an unchanged wire. Reordering would have cost
those routes the content-part handling their providers exist for, which
`deepseek.ts` and `zai.ts` document as deliberate for self-hosted sglang, vLLM
and ollama deployments. The repair therefore composes with whatever provider was
selected, and no provider class or selection branch is involved.

`zai.ts` warns once when a `glm-*` model on a non-Z.ai hostname leaves
`reasoning_effort` unflattened. The repair needs no such warning: it is not
hostname-gated, so it applies wherever the user opted in.

## Limits and risks

- The provider holds the `ContentGeneratorConfig` it was built with, so the
  opt-in is read when the request provider for a route is built. An edit under
  `modelProviders` is consumed by the settings hot reload: the watcher classifies
  the change at the `modelProviders` leaf — the longest schema key that is a
  prefix of the changed path, which does not require a restart — and the listener
  reloads the model registry and refreshes the auth, which rebuilds the provider,
  so the value applies to the next request. An edit under `model.generationConfig`
  has no such consumer, so it applies on the next model switch or restart.
  Neither reaches a request already in flight, and neither is hot-reloaded in
  bare mode, where settings are not watched. The `qwen-oauth` hot-update path
  copies a fixed field set without rebuilding the provider, and is not a route
  this opt-in can serve.
- The opt-in is scoped to a route, not inherited by one. A side model — a
  subagent, a fork, or a `baseLlmClient` target — whose `baseUrl` differs from
  the parent's loses the parent's value, and one that shares it keeps it. An
  explicit `generationConfig.toolParametersMandatory` on the side model's own
  entry always wins, including `false`.
- The field is added, never removed. A route whose server rejects a present
  `parameters` object stays out of the opt-in and is unaffected.
- The injected `properties` object is added after conversion, so it survives the
  step where `relaxSchemaForFunctionCalling` strips an empty `properties` from
  every converted schema. A server that rejects an empty `properties` object
  must not opt in.
- Reading `parameters === undefined` tests the value, not key presence: the
  converter emits the key with an `undefined` value, and a key-presence test
  would skip every tool that needs the repair.
- DashScope does not chain `super.buildRequest`, so its two return paths reach
  the repair through its own merge step. A provider that assembles a request the
  same way has to call it too.

## Not in scope

- Changing the converter's default omission, or the shapes
  `relaxSchemaForFunctionCalling` produces.
- Filling `properties` on a parameterless tool whose schema already carries the
  field, so that every parameterless tool ships one shape.
- Detecting TabbyAPI, or any other self-hosted server, from its URL.
- The Responses wire (`openaiResponsesContentGenerator`), which omits the field
  the same way; the report concerns Chat Completions.
- The Anthropic and Gemini generators, which have no equivalent constraint.

## Verification

- Unit tests pin the wire per route. The four model-name routes — DeepSeek, Z.ai,
  MiMo and Mistral ids at `http://localhost:5000/v1` — assert that the vendor
  provider stays selected and the schema is present. The plain route asserts the
  omission by default and the schema when opted in, including a tool that
  declares no schema at all. DashScope and MiniMax assert both arms. A declared
  schema passes through unchanged and a request without tools stays tool-free.
  With the repair disabled the seven flag-dependent cases go red while the
  MiniMax and omission cases stay green, so the suite discriminates on the flag
  rather than on the provider class.
- Existing converter tests still pin the default omission, including
  `expect(JSON.stringify(result.slice(0, 5))).not.toContain('parameters')`.
- #11956's confirmed capture is a model-name route — `deepseek-v4.1-flash`
  through a gateway, `400 litellm.BadRequestError: ... tools[5].function:
missing field parameters` — which is the arm that used to be shadowed. The unit
  case for a `deepseek` id at a loopback baseUrl pins it; a live re-run against
  that gateway is still outstanding.
- Re-checked on the same live TabbyAPI route (`http://localhost:5000/v1`) on
  2026-09-19 with three payloads differing only in that field: omitted → HTTP 422
  with `{"type":"missing","loc":["body","tools",0,"function","parameters"],
"msg":"Field required"}`, `{ "type": "object" }` → HTTP 200, and the shipped
  `{ "type": "object", "properties": {} }` → HTTP 200. The CLI on that route
  fails with `422 status code (no body)` by default and completes normally once
  the key is set on the matching `modelProviders` entry. Run record:
  `.qwen/e2e-tests/2026-09-19-tool-parameters-shape-ab.md`. The earlier 2026-09-17
  run on the same route recorded HTTP 200 with the bare shape and is
  `.qwen/e2e-tests/2026-09-17-tool-parameters-mandatory-results.md`.
- Reported, not measured here: comments on two other strict Rust/serde gateways
  (`api-inference.modelscope.cn`, `apihub.agnes-ai.com`) say the
  properties-bearing shape was accepted there as a local patch. Every one of
  those reports predates the shape change, so they corroborate the choice rather
  than verify it.
