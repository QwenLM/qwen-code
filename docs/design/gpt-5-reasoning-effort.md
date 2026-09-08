# GPT reasoning effort

GPT-5 models currently lack model-specific reasoning controls in ACP and Web
Shell previews. The OpenAI pipeline also sends the internal `reasoning.effort`
object to Chat Completions, which expects `reasoning_effort`. Configuring
`samplingParams` bypasses the internal effort entirely. GPT-6 Astra has the
same gaps when it falls through to the generic provider behavior.

## Design

Share GPT model capabilities in core's existing reasoning-effort module.
Recognize an explicit list of documented GPT-5 models and GPT-6 Astra; unknown
minor versions and family suffixes keep the generic provider behavior. Reuse
the shared model normalizer for provider prefixes, whitespace and routing tags.
Dated snapshots and numeric patch versions inherit a known model's capabilities.
Chat variants remain excluded. Use the existing `low`, `medium`, `high`, `xhigh`,
`max` ladder without adding CLI tiers.

GPT-5 and GPT-5.1 stop at high, except GPT-5.1-Codex-Max, which supports xhigh.
Known GPT-5.2, GPT-5.3 Codex, GPT-5.4 and GPT-5.5 variants support xhigh;
GPT-5.6 (Sol, Terra and Luna) supports max. Pro variants start at medium
(GPT-5 Pro only supports high). The listed GPT-5, Codex and Pro models require
thinking. GPT-5.1, GPT-5.2 and GPT-5.4 default to disabled;
GPT-5.5 and GPT-5.6 default to medium and support disabling.

GPT-6 Astra supports all five tiers and requires thinking. Recognize its
exact identifier, dated snapshots, and provider prefixes; do not infer
capabilities for other GPT-6 variants. Its controls start enabled at medium
and reject off. Rename the shared helper to cover both GPT generations.
The pipeline's mandatory-thinking check must consume the same capabilities
for the wire model, including flat disable values and automatic OpenRouter
off requests.

Chat Completions providers, including DashScope-compatible gateways serving
GPT models, map configured effort to the flat wire
field and clamp to the model's supported subset. Explicit `samplingParams`
and `extra_body` reasoning overrides keep their existing priority. OpenRouter
keeps its nested reasoning protocol. Only the translated effort is removed
from the nested object; sibling values such as the reasoning budget remain.
Nullish and empty-string flat placeholders do not suppress configured effort.
Raw nested `reasoning`, including `null`, remains an explicit whole-object
override; it is not interpreted as a cleared flat field.
Sampling options unrelated to reasoning
must not suppress GPT's configured effort. The pipeline emits `none` when
thinking is disabled on models that support it.

GPT overrides are excluded from the existing Qwen-specific ACP override
cleanup. Controls display the same clamped tier as the provider, while the
global preference survives a GPT model switch for use on other models.
Raw request overrides may determine a different effective tier. Flat overrides
inform the enabled state; nested OpenRouter switches are interpreted only on
OpenRouter hosts. Other raw nested values remain opaque: controls show the
model default and reject tier changes that cannot replace that override,
including a tier equal to the displayed default. Explicitly disabling a
non-mandatory model still works. When mandatory cleanup removes a raw flat
`none` after it suppressed the configured tier, controls report the model
default and reject ineffective changes; OpenRouter's retained configured
nested effort remains distinct. Generalizing CLI/SDK override reporting is
outside this change.

ACP uses the shared capabilities to advertise supported efforts, mandatory
thinking, and default enabled state. Existing Web Shell consumers use these
options. The thinking switch selects the advertised default effort when
turning a tiered model on, so a model whose API default is off can be enabled.
ACP `default` retains its reset semantics. There are no new daemon routes or persistence
formats. Responses-only models still require a compatible Chat Completions
gateway; adding a Responses transport is outside this change.
GPT-6 Astra supports Chat Completions, but its official tool-calling API
requires Responses; the configured gateway remains responsible for that
compatibility.

## Affected areas and validation

- Core reasoning-effort capabilities and tests.
- Default OpenAI provider request mapping and tests.
- OpenAI pipeline sampling and disable handling and tests.
- CLI ACP model configuration and tests.

Verify global CLI baseline and local bundled CLI with a local recording mock
endpoint, plus focused core/CLI tests, build, typecheck, formatting, and lint.
The E2E plan and results live in `.qwen/e2e-tests/gpt-5-reasoning-effort.md`.
Live tests use the user's configured providers with isolated settings and
runtime directories. GPT-5.5 and GPT-5.6 Sol pass; GPT-5.4 is unavailable on
the configured gateway. GPT-6 Astra's pre-extension bundle returns real
responses but sends nested high, clamps max to xhigh, and loses effort with
sampling parameters. Its live verification plan is
`.qwen/e2e-tests/gpt-6-reasoning-effort-live.md`.

## Sources

- [Chat Completions request](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [GPT-5](https://developers.openai.com/api/docs/models/gpt-5)
- [GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1)
- [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)
- [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5 Pro](https://developers.openai.com/api/docs/models/gpt-5-pro)
- [GPT-5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-6 reasoning and transport requirements](https://developers.openai.com/api/docs/guides/latest-model)

Raw gateway extensions are preserved; their internal behavior cannot be inferred
from the native Chat Completions protocol.
