# GPT-5 reasoning effort

GPT-5 models currently lack model-specific reasoning controls in ACP and Web
Shell previews. The OpenAI pipeline also sends the internal `reasoning.effort`
object to Chat Completions, which expects `reasoning_effort`. Configuring
`samplingParams` bypasses the internal effort entirely.

## Design

Share GPT-5 model capabilities in core's existing reasoning-effort module.
Recognize GPT-5 and GPT-5.x identifiers, dated variants, Codex and Pro variants,
and OpenRouter's `openai/` prefix. Exclude ChatGPT chat variants, which do not
expose the same reasoning controls. Use the supported subset of the existing
`low`, `medium`, `high`, `xhigh`, `max` ladder; do not add CLI tiers.

GPT-5 and GPT-5.1 stop at high, except GPT-5.1-Codex-Max, which supports xhigh.
GPT-5.2 through GPT-5.5 support xhigh, and GPT-5.6 supports max. Pro variants
start at medium (GPT-5 Pro only supports high). GPT-5 and Codex/Pro variants
require thinking. Other GPT-5.x models can disable it; GPT-5.1 through GPT-5.4
default to disabled and GPT-5.5/5.6 default to medium.

The default Chat Completions provider maps configured effort to the flat wire
field and clamps to the model's supported subset. Explicit `samplingParams`
and `extra_body` reasoning overrides keep their existing priority. OpenRouter
keeps its nested reasoning protocol. Sampling options unrelated to reasoning
must not suppress GPT-5's configured effort. The pipeline emits `none` when
thinking is disabled on models that support it.

GPT overrides are excluded from the existing Qwen-specific ACP override
cleanup. As with the existing generic effort command, the displayed tier is
the requested preference; raw request overrides may determine a different
effective tier. Generalizing override reporting is outside this change.

ACP uses the shared capabilities to advertise supported efforts, mandatory
thinking, and default enabled state. Existing Web Shell consumers use these
options without new UI code. There are no new daemon routes or persistence
formats. Responses-only models still require a compatible Chat Completions
gateway; adding a Responses transport is outside this change.

## Affected areas and validation

- Core reasoning-effort capabilities and tests.
- Default OpenAI provider request mapping and tests.
- OpenAI pipeline sampling and disable handling and tests.
- CLI ACP model configuration and tests.

Verify global CLI baseline and local bundled CLI with a local recording mock
endpoint, plus focused core/CLI tests, build, typecheck, formatting, and lint.
The E2E plan and results live in `.qwen/e2e-tests/gpt-5-reasoning-effort.md`.

## Sources

- [Chat Completions request](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [GPT-5](https://developers.openai.com/api/docs/models/gpt-5)
- [GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1)
- [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)
- [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5 Pro](https://developers.openai.com/api/docs/models/gpt-5-pro)
- [GPT-5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)

No open questions remain for this scope.
