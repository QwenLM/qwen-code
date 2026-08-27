# Provider-aware reasoning controls

## Motivation

The WebShell reasoning menu currently recognizes a small Qwen-only model
manifest. Extending that manifest by model ID alone is unsafe: the same
DeepSeek, GLM, or Kimi ID can be served by its first-party API, Alibaba
ModelStudio, a subscription endpoint, or an unrelated OpenAI-compatible
server, and those routes do not share a request contract.

This change makes the manifest depend on the active OpenAI protocol and the
parsed endpoint hostname. The WebShell only exposes controls whose wire shape
is documented for that route.

## Capability matrix

| Route                            | Models                                 | WebShell controls               | Request fields                        |
| -------------------------------- | -------------------------------------- | ------------------------------- | ------------------------------------- |
| DeepSeek API                     | `deepseek-v4-pro`, `deepseek-v4-flash` | Off, `high`, `max`              | `thinking.type`, `reasoning_effort`   |
| Alibaba Standard / Token Plan    | supported DeepSeek V4 IDs              | Off and documented effort tiers | `enable_thinking`, `reasoning_effort` |
| Z.AI                             | `GLM-5.2`                              | Off, `high`, `max`              | `thinking.type`, `reasoning_effort`   |
| Alibaba Standard                 | `glm-5.2`                              | Off, `high`, `max`              | `enable_thinking`, `reasoning_effort` |
| Alibaba Token Plan               | `glm-5.2`                              | Off / on                        | `enable_thinking`                     |
| Moonshot API                     | `kimi-k2.6`                            | Off / on                        | `thinking.type`                       |
| Moonshot API                     | `kimi-k3`                              | `low`, `high`, `max`; no off    | `reasoning_effort`                    |
| Alibaba Token Plan / Coding Plan | supported Kimi K2 IDs                  | Off / on                        | `enable_thinking`                     |

The route-specific allowlists also enforce plan availability. In particular,
Coding Plan does not gain DeepSeek controls, Coding Plan only recognizes its
documented Kimi IDs, Alibaba Coding Plan does not gain GLM 5.2 controls, and
thinking-only Kimi K2.7 models do not receive an off switch.

GLM 5.1, 5, 4.7, and 5-Turbo are deliberately outside this change. GLM 5.2
exposes only the two canonical levels accepted by both Alibaba descriptions on
the Standard endpoint. Subscription endpoints remain toggle-only because their
plan pages do not publish an effort contract. More levels can be added after an
endpoint-level contract or live probe removes the ambiguity.

## Design

Core owns one pure resolver that accepts the model ID, auth type, and base URL.
It parses the hostname and returns the reasoning capability for that exact
route. The CLI projects the result into ACP session options; WebUI maps those
options into WebShell controls.

Tiered capabilities declare whether thinking can be disabled. Existing models
remain disableable by default. Thinking-only models omit the `none` option, and
WebShell keeps the Thinking switch checked and disabled while leaving the
effort choices selectable.

Provider adapters remain responsible for the final request shape:

- DashScope flattens a supported non-Qwen `reasoning.effort` to the top-level
  `reasoning_effort` field and maps off to `enable_thinking: false`.
- First-party DeepSeek, Z.AI, and Moonshot routes use
  `thinking: { type: 'disabled' }` for off.
- Moonshot K3 receives a top-level `reasoning_effort` and never receives a
  disable field.

The resolver requires the OpenAI protocol for all new provider-aware entries.
Unknown, self-hosted, Anthropic-compatible, and spoofed hostnames receive no
new controls or provider-specific fields. Model IDs are matched as complete,
case-normalized IDs; aliases, vendor prefixes, preview names, and dated suffixes
do not inherit capabilities. The previously merged Qwen entries retain that
whole-ID behavior.

## Deliberate exclusions

- No new setup preset or model is added to the provider selector.
- No undocumented effort-to-budget mapping is introduced.
- DeepSeek Anthropic compatibility is excluded because a reliable disable
  contract is not documented.
- Moonshot direct `kimi-k2.5` is excluded because the provider has announced
  its retirement on August 31, 2026. Alibaba plans that still list the same ID
  remain supported.
- Alibaba Standard `kimi-k2.5` and `kimi-k2.6` are excluded because that route
  defaults thinking to off, while the existing toggle contract restores a
  provider or preset default when turning thinking on. Registering those IDs
  without a positive `enable_thinking: true` wire shape would expose a switch
  that does not enable thinking.
- Alibaba-hosted `kimi/kimi-k3` is excluded because its only documented effort
  value is `max`, which creates no meaningful setting.
- Generic `/effort` behavior and unrelated sampling parameters are unchanged.
