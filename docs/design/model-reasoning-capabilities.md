# Model reasoning capabilities

## Goal

Expose accurate reasoning controls for common Alibaba Cloud Coding Plan and
Token Plan models without inventing effort levels that their Chat Completions
APIs do not support.

## Research

Alibaba Cloud documents `qwen3.8-max` with native `low`, `medium`, and `xhigh`
reasoning effort levels. It documents `qwen3.6-plus`, `qwen3.6-flash`,
`qwen3.7-plus`, `qwen3.7-max`, and `qwen3.5-plus` as hybrid-thinking models that
can enable or disable thinking, but use an integer thinking budget instead of
discrete Chat Completions effort levels.

The registered capabilities therefore are:

| Exact model id  | Thinking | Effort control           |
| --------------- | -------- | ------------------------ |
| `qwen3.8-max`   | Optional | `low`, `medium`, `xhigh` |
| `qwen3.7-max`   | Optional | None                     |
| `qwen3.7-plus`  | Optional | None                     |
| `qwen3.6-plus`  | Optional | None                     |
| `qwen3.6-flash` | Optional | None                     |
| `qwen3.5-plus`  | Optional | None                     |

Sources:

- [Qwen Code and Coding Plan model ids](https://help.aliyun.com/zh/model-studio/qwen-code)
- [Thinking modes and defaults](https://help.aliyun.com/zh/model-studio/deep-thinking)
- [Chat Completions thinking parameters](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

## Design

The model manifest distinguishes tiered reasoning from toggle-only reasoning
and continues to match exact model ids. Toggle-only models produce the same ACP
configuration option as tiered models, with two values: `none` and `default`.
Selecting `none` disables thinking for the live session. Selecting `default`
clears the session override so the existing model or provider default applies.

The daemon marks toggle-only options in ACP metadata. WebShell maps them to an
empty effort list, renders only the Thinking switch, and shows `Thinking` or
`Thinking Off` on the model chip. Existing tiered controls retain their effort
rows and labels.

Opening the controls does not mutate generation settings. No provider,
authentication, persistence, or runtime-snapshot behavior changes.

## Deferred models

DeepSeek, GLM, Kimi, and Grok models are not registered here. Their reasoning
parameters or defaults vary between direct and Alibaba Cloud endpoints, while
the current manifest is keyed only by model id. Registering them before the
provider path carries the relevant capability context could display a control
whose selected value is not sent correctly.

Qwen aliases, dated variants, coder models, and models with a preset default
that differs from the model default are also deferred. They require separate
capability or resolved-configuration semantics rather than broadened matching.

## Compatibility

Older ACP clients can continue to treat the option as a normal select. Older
daemons do not advertise the toggle-only metadata, so current WebShell keeps
the controls hidden unless the capability is explicit.
