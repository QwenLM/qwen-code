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
no fact that separates it. Every existing hostname check in
`openaiContentGenerator/provider/` matches a public vendor domain; none matches a
loopback address.

The field is declared on `ContentGeneratorConfig`, added to
`ModelGenerationConfig` and `MODEL_GENERATION_CONFIG_FIELDS` so a
`modelProviders` entry can set it per model, and documented in
`docs/users/configuration/settings.md`.

### Repair one layer down, not in the converter

`ToolParametersMandatoryOpenAICompatibleProvider` overrides `buildRequest` and
fills `parameters: { "type": "object" }` for any tool whose `parameters` is
`undefined` after conversion, the same place MiniMax performs its equivalent
repair. Doing it in the converter instead would mean choosing one shape for
every OpenAI-compatible route, and `provider/minimax.ts` records that
constraint explicitly.

Acting on the request rather than the tool list also covers both ways a tool can
end up without the field: one that declares an empty argument list, which the
converter reduces to `undefined`, and one that declares no schema at all, which
never receives a schema. A converter-side fix only reaches the first.

### Shape

`{ "type": "object" }`, the shape that the report says the endpoint accepts.
MiniMax keeps `{ "type": "object", "properties": {} }`, the shape its own
endpoint accepts. Both satisfy a server that only checks field presence.

### Selection order

The opt-in is checked after every vendor hostname check, so a route that matches
a vendor domain keeps that vendor's provider — MiniMax injects its own shape, and
must not be displaced by a generic one.

## Limits and risks

- The opt-in is read when the route's provider is built, so it takes effect on
  the next model switch or restart, not on the request in flight. The
  `qwen-oauth` hot-update path copies a fixed field set without rebuilding the
  provider, and is not a route this opt-in can serve.
- The opt-in is per model route. A user who points several routes at servers with
  opposite requirements must set the key only on the route that needs it.
- The field is added, never removed. A route whose server rejects a present
  `parameters` object stays on the default provider and is unaffected.
- Reading `parameters === undefined` tests the value, not key presence: the
  converter emits the key with an `undefined` value, and a key-presence test
  would skip every tool that needs the repair.

## Not in scope

- Changing the converter's default omission, or the shapes
  `relaxSchemaForFunctionCalling` produces.
- Detecting TabbyAPI, or any other self-hosted server, from its URL.
- The Responses wire (`openaiResponsesContentGenerator`), which omits the field
  the same way; the report concerns Chat Completions.
- The Anthropic and Gemini generators, which have no equivalent constraint.

## Verification

- Unit tests cover the opt-in predicate (set, unset, explicitly false), provider
  selection (selected, not selected, MiniMax still winning while opted in), and
  `buildRequest` (no `parameters` key, `parameters: undefined`, a declared schema
  passed through unchanged, a request without tools).
- Existing converter tests still pin the default omission, including
  `expect(JSON.stringify(result.slice(0, 5))).not.toContain('parameters')`.
- Checked against a live TabbyAPI route (`http://localhost:5000/v1`): a payload
  A/B showed HTTP 422 with `{"type":"missing","loc":["body","tools",0,"function",
"parameters"],"msg":"Field required"}` when the field is omitted, and HTTP 200
  with `"parameters": { "type": "object" }`. The CLI on that route fails with
  `422 status code (no body)` by default and completes normally once the key is
  set on the matching `modelProviders` entry. Run record:
  `.qwen/e2e-tests/2026-09-17-tool-parameters-mandatory-results.md`.
