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
Strip `:batch` locally before normalization; other capability lookups retain
their existing token-limit and modality behavior.
Dated snapshots and numeric patch versions inherit a known model's capabilities.
Chat variants remain excluded. Use the existing `low`, `medium`, `high`, `xhigh`,
`max` ladder without adding CLI tiers.

GPT-5 and GPT-5.1 stop at high, except GPT-5.1-Codex-Max, which supports xhigh.
Known GPT-5.2, GPT-5.3 Codex, GPT-5.4 and GPT-5.5 variants support xhigh;
GPT-5.6 (Sol, Terra and Luna) supports max. Pro variants start at medium
(GPT-5 Pro only supports high). The listed GPT-5, Codex and Pro models require
thinking. GPT-5.1, GPT-5.2 and GPT-5.4 default to disabled;
Base GPT-5.5 and GPT-5.6 default to medium and support disabling.
GPT-5 Pro and GPT-5.5 Pro default to high; GPT-5.2 Pro and GPT-5.4 Pro
default to medium. These Pro variants require thinking.

The [GPT-5 family guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5)
names `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` and lists `minimal`, `low`,
`medium`, and `high`. Their `minimal` mode still uses reasoning; `none` was
introduced with [GPT-5.1](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.1).
The shared SDK union is not a per-model support list. Keep these three models
mandatory and do not translate an off request into unsupported `none`.

GPT-6 Astra supports all five tiers and requires thinking. Recognize its
exact identifier, dated snapshots, and provider prefixes; do not infer
capabilities for other GPT-6 variants. Its controls start enabled at medium
and reject off. The shared helper covers both GPT generations.
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
While reasoning is enabled, raw nested `reasoning`, including `null`, remains an explicit whole-object
override; it is not interpreted as a cleared flat field.
Sampling options unrelated to reasoning
must not suppress GPT's configured effort. The pipeline emits flat `none` on native GPT endpoints when thinking is disabled on models that support it; OpenRouter receives its nested disable shape.

Explicit model reasoning capabilities take precedence over the built-in tier
list and retain their declared disable field. GPT configured tiers are validated before provider mapping, then translated only after raw request overrides merge. Known mandatory GPT models still
cannot be disabled. The existing runtime-snapshot and ACP-route guards remain
in effect.

GPT overrides are excluded from the existing Qwen-specific ACP override
cleanup. Controls display the same clamped tier as the provider, while a shared
preference survives a model switch that uses the built-in GPT fallback for use on other models. Explicit configured capabilities retain their stricter reconciliation.
A saved off preference also survives when the mandatory constraint comes from
the GPT table over declared capabilities; an explicit configured `canDisable: false`
retains the existing strict reconciliation.
Raw request overrides may determine a different effective tier. Native flat
values and supported OpenRouter nested efforts report the effective raw tier;
OpenRouter sampling flat values do too when they suppress configured nested effort.
OpenRouter enabled flags and token budgets report enabled state with the model
default tier. Native nested values and unrecognized raw tiers remain opaque.
Any raw override that prevents replacing the configured tier rejects explicit
tier changes, including a tier equal to the displayed value, without persisting
or leaving a live mutation behind. OpenRouter extra-body-only flat fields do
not block configured nested effort; sampling flat fields do unless explicit
configured capabilities inject the nested object.

Explicitly disabling a non-mandatory model still works. Blocked raw overrides
advertise `enableValue: 'default'` only when the raw state permits thinking and
the configured reasoning default is not disabled. The thinking switch can then
restore the configured raw defaults after disabling. Otherwise, `canEnable: false`
disables the off switch without changing the saved preference. This also covers
configured tiers without a default and toggle-only controls. Direct blocked tier
requests still fail. Explicit `default` commands retain their reset semantics,
including off defaults. When
mandatory cleanup removes a raw flat `none` after it suppressed the configured
tier, controls report the model default and reject ineffective changes.
Generalizing CLI/SDK override reporting is
outside this change.

ACP uses the shared capabilities to advertise supported efforts, mandatory
thinking, and default enabled state. Existing Web Shell consumers use these
options. The thinking switch selects the advertised default effort when
turning a tiered model on, so a model whose API default is off can be enabled.
Welcome keeps switch-generated tiers tied to their source model and discards that
pending intent on a model change, preserving the target's existing preference;
an explicit compatible tier still migrates. Welcome model changes do not turn
existing max or none preferences into reset commands.
Disabled previews with `canEnable: false` reject pending enabling intent both
on model changes and when refreshed metadata is applied before the first prompt.
Previews with a raw override also reject pending explicit tiers while already
enabled: `enableValue: 'default'` or `canEnable: false` identifies controls
whose configured tier cannot replace the raw value.
Both cold workspace provider previews use the target provider's generation
defaults to project raw override state and the same enable constraints as a live
session. Provider defaults do not inherit ignored top-level generation settings.
For models that allow thinking to be disabled, a saved off preference remains
off in the preview. Enabling a raw-controlled model selects `default` when
permitted; raw configurations that cannot enable thinking prevent turning it
on before a session is created.
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
- [gpt-5-mini](https://developers.openai.com/api/docs/models/gpt-5-mini)
- [gpt-5-nano](https://developers.openai.com/api/docs/models/gpt-5-nano)
- [gpt-5.1-codex](https://developers.openai.com/api/docs/models/gpt-5.1-codex)
- [gpt-5.1-codex-max](https://developers.openai.com/api/docs/models/gpt-5.1-codex-max)
- [gpt-5.2](https://developers.openai.com/api/docs/models/gpt-5.2)
- [gpt-5.2-codex](https://developers.openai.com/api/docs/models/gpt-5.2-codex)
- [gpt-5.2-pro](https://developers.openai.com/api/docs/models/gpt-5.2-pro)
- [gpt-5.3-codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex)
- [gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [gpt-5.4-nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
- [gpt-5.5-pro](https://developers.openai.com/api/docs/models/gpt-5.5-pro)
- [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Model catalog, including the GPT-5.6 alias](https://developers.openai.com/api/docs/models)

Raw gateway extensions are preserved; their internal behavior cannot be inferred
from the native Chat Completions protocol.
