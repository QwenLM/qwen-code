# Model Providers

Qwen Code allows you to configure multiple model providers through the `modelProviders` setting in your `settings.json`. This enables you to switch between different AI models and providers using the `/model` command.

## Overview

Use `modelProviders` to declare models per provider id that the `/model` picker can switch between. Each key is a provider id and its value is **an array of model definitions** (`ModelConfig[]`). For built-in providers the key must be a valid auth type (`openai`, `anthropic`, `gemini`, `vertex-ai`); a custom provider id (e.g. `idealab`) is allowed as long as you map it to a protocol via the top-level [`providerProtocol`](#custom-provider-ids-providerprotocol) setting. Each model entry requires an `id`; `envKey` is **optional and recommended** (when omitted, it falls back to the auth type's default env key, e.g. `OPENAI_API_KEY` for `openai`), with optional `name`, `description`, `baseUrl`, and `generationConfig`. Credentials are never persisted in settings; the runtime reads them from `process.env[envKey]`. Qwen OAuth models remain hard-coded and cannot be overridden.

> [!note]
>
> Earlier previews wrapped each provider's models in a `{ "protocol": ..., "models": [...] }` object. That shape has been reverted — the current value is the bare `ModelConfig[]` array shown throughout this page. A wrapped entry in an already-migrated (`$version: 4`) settings file is silently skipped, so update any old configs to the array form.

> [!note]
>
> Only the `/model` command exposes non-default auth types. Anthropic, Gemini, etc., must be defined via `modelProviders`. The `/auth` command lists three top-level options: **Alibaba ModelStudio** (with Coding Plan, Token Plan, and Standard API Key in its sub-menu), **Third-party Providers**, and **Custom Provider**. (Qwen OAuth is no longer a selectable dialog entry; its free tier was discontinued on 2026-04-15.)

> [!note]
>
> **Model uniqueness:** Models within the same `authType` are uniquely identified by the combination of `id` + `baseUrl`. This means you can define the same model ID (e.g., `"gpt-4o"`) multiple times under a single `authType` as long as each entry has a different `baseUrl` — for example, one pointing to OpenAI directly and another to a proxy endpoint. If two entries share both the same `id` and the same `baseUrl` (or both omit `baseUrl`), the first occurrence wins and subsequent duplicates are skipped with a warning.

> [!note]
>
> **Hot reload vs. restart:** `modelProviders` edits in `settings.json` are picked up by a running interactive session without a restart (the file watcher debounces ~300ms; reopen `/model` to see new entries, the current selection is kept). `providerProtocol` is read once at startup and **requires a restart**.

### Image generation routes

Set `supportsImageGeneration: true` when a route can be used by the built-in
`image_gen` tool. This capability is independent from image input support such
as `capabilities.vision` or `generationConfig.modalities.image`.

Use `imageOnly: true` when the route is dedicated to image generation and must
not appear in ordinary model selectors. For backward compatibility,
`imageOnly: true` also implies image-generation capability, so existing settings
do not need to be migrated.

A dual-role route can be selected both as the main model and through
`/model --image`:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "omni-model",
        "envKey": "MODEL_API_KEY",
        "baseUrl": "https://gateway.example.com/model-api",
        "supportsImageGeneration": true
      }
    ]
  }
}
```

A dedicated image route sets both fields. The legacy form with only
`imageOnly: true` remains valid:

```json
{
  "id": "image-model",
  "envKey": "MODEL_API_KEY",
  "baseUrl": "https://images.example.com/api/v1",
  "supportsImageGeneration": true,
  "imageOnly": true
}
```

The selected route must declare an explicit HTTPS `baseUrl` and a non-empty
`envKey`. Image generation uses the same endpoint and credential as the route;
if chat and image generation require different endpoints or credentials,
configure two routes instead.

## Configuration Examples by Auth Type

Below are comprehensive configuration examples for different authentication types, showing the available parameters and their combinations.

### Supported Auth Types

The `modelProviders` object keys must be valid `authType` values. Currently supported auth types are:

| Auth Type    | Description                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`     | OpenAI-compatible APIs (OpenAI, Azure OpenAI, local inference servers like vLLM/Ollama)                                                         |
| `anthropic`  | Anthropic Claude API                                                                                                                            |
| `gemini`     | Google Gemini API                                                                                                                               |
| `qwen-oauth` | Qwen OAuth (hard-coded, cannot be overridden in `modelProviders`)                                                                               |
| `vertex-ai`  | Google Vertex AI (uses the `gemini` protocol and the `@google/genai` SDK in Vertex AI mode; selecting it sets `GOOGLE_GENAI_USE_VERTEXAI=true`) |

> [!note]
> Vertex AI entries can authenticate with **Application Default Credentials**. Set `GOOGLE_CLOUD_PROJECT` (and optionally `GOOGLE_CLOUD_LOCATION`, which defaults to `global`) and leave `envKey` unset, along with every other key source the resolver reads: `GOOGLE_API_KEY`, `settings.security.auth.apiKey`, and the CLI key flags. Any API key value that reaches a Vertex entry switches the Google SDK to Vertex Express mode, which ignores the project, the location and your ADC credentials. An entry that declares an `envKey` is never routed to ADC, so a key that fails to be injected keeps failing on that variable instead of silently authenticating as a different principal.

> [!warning]
> A provider id that is neither a built-in protocol nor mapped via `providerProtocol` (e.g. a typo like `"openai-custom"`) cannot be routed, so its whole entry is **skipped** with a warning — its models simply won't appear in the `/model` picker. Use one of the supported auth type values above for built-in providers, or add a [`providerProtocol`](#custom-provider-ids-providerprotocol) mapping for a custom id.

### Custom provider ids (`providerProtocol`)

Built-in provider ids (`openai`, `gemini`, `anthropic`, `vertex-ai`, `qwen-oauth`) are routed to their SDK protocol automatically. To use a **custom** provider id — for example to group several OpenAI-compatible endpoints under a friendlier name — declare it under `modelProviders` and map it to a built-in protocol with the top-level `providerProtocol` setting:

```json
{
  "modelProviders": {
    "idealab": [
      {
        "id": "my-model",
        "envKey": "IDEALAB_API_KEY",
        "baseUrl": "https://idealab.example.com/v1"
      }
    ]
  },
  "providerProtocol": {
    "idealab": "openai"
  }
}
```

Without a matching `providerProtocol` entry, a custom provider id is skipped (see the warning above).

### SDKs Used for API Requests

Qwen Code uses the following official SDKs to send requests to each provider:

| Auth Type    | SDK Package                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `openai`     | [`openai`](https://www.npmjs.com/package/openai) - Official OpenAI Node.js SDK                  |
| `anthropic`  | [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) - Official Anthropic SDK |
| `gemini`     | [`@google/genai`](https://www.npmjs.com/package/@google/genai) - Official Google GenAI SDK      |
| `qwen-oauth` | [`openai`](https://www.npmjs.com/package/openai) with custom provider (DashScope-compatible)    |

This means the `baseUrl` you configure should be compatible with the corresponding SDK's expected API format. For example, when using `openai` auth type, the endpoint must accept OpenAI API format requests.

### OpenAI-compatible providers (`openai`)

This auth type supports not only OpenAI's official API but also any OpenAI-compatible endpoint, including aggregated model providers like OpenRouter and Requesty.

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-your-actual-openai-key-here",
    "OPENROUTER_API_KEY": "sk-or-your-actual-openrouter-key-here",
    "REQUESTY_API_KEY": "sk-your-actual-requesty-key-here"
  },
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "envKey": "OPENAI_API_KEY",
        "baseUrl": "https://api.openai.com/v1",
        "generationConfig": {
          "timeout": 60000,
          "maxRetries": 3,
          "retryInitialDelayMs": 3000,
          "retryMaxDelayMs": 30000,
          "enableCacheControl": true,
          "contextWindowSize": 128000,
          "modalities": {
            "image": true
          },
          "customHeaders": {
            "X-Client-Request-ID": "req-123"
          },
          "extra_body": {
            "enable_thinking": true,
            "service_tier": "priority"
          },
          "samplingParams": {
            "temperature": 0.2,
            "top_p": 0.8,
            "max_tokens": 4096,
            "presence_penalty": 0.1,
            "frequency_penalty": 0.1
          }
        }
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini",
        "envKey": "OPENAI_API_KEY",
        "baseUrl": "https://api.openai.com/v1",
        "generationConfig": {
          "timeout": 30000,
          "samplingParams": {
            "temperature": 0.5,
            "max_tokens": 2048
          }
        }
      },
      {
        "id": "openai/gpt-4o",
        "name": "GPT-4o (via OpenRouter)",
        "envKey": "OPENROUTER_API_KEY",
        "baseUrl": "https://openrouter.ai/api/v1",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 3,
          "samplingParams": {
            "temperature": 0.7
          }
        }
      },
      {
        "id": "openai/gpt-4o-mini",
        "name": "GPT-4o Mini (via Requesty)",
        "envKey": "REQUESTY_API_KEY",
        "baseUrl": "https://router.requesty.ai/v1",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 3,
          "samplingParams": {
            "temperature": 0.7
          }
        }
      }
    ]
  }
}
```

### Anthropic (`anthropic`)

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-your-actual-anthropic-key-here"
  },
  "modelProviders": {
    "anthropic": [
      {
        "id": "claude-3-5-sonnet",
        "name": "Claude 3.5 Sonnet",
        "envKey": "ANTHROPIC_API_KEY",
        "baseUrl": "https://api.anthropic.com/v1",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 3,
          "contextWindowSize": 200000,
          "samplingParams": {
            "temperature": 0.7,
            "max_tokens": 8192,
            "top_p": 0.9
          }
        }
      },
      {
        "id": "claude-3-opus",
        "name": "Claude 3 Opus",
        "envKey": "ANTHROPIC_API_KEY",
        "baseUrl": "https://api.anthropic.com/v1",
        "generationConfig": {
          "timeout": 180000,
          "samplingParams": {
            "temperature": 0.3,
            "max_tokens": 4096
          }
        }
      }
    ]
  }
}
```

### Google Gemini (`gemini`)

```json
{
  "env": {
    "GEMINI_API_KEY": "AIza-your-actual-gemini-key-here"
  },
  "modelProviders": {
    "gemini": [
      {
        "id": "gemini-2.0-flash",
        "name": "Gemini 2.0 Flash",
        "envKey": "GEMINI_API_KEY",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "capabilities": {
          "vision": true
        },
        "generationConfig": {
          "timeout": 60000,
          "maxRetries": 2,
          "contextWindowSize": 1000000,
          "schemaCompliance": "auto",
          "samplingParams": {
            "temperature": 0.4,
            "top_p": 0.95,
            "max_tokens": 8192,
            "top_k": 40
          }
        }
      }
    ]
  }
}
```

For a vision model that can also follow the normal Qwen Code agent policy and use tools, opt in to full-turn image routing with both capabilities:

```json
"capabilities": {
  "vision": true,
  "agent": true
}
```

When a text-only primary uses that model as its configured vision fallback, the complete image-bearing turn stays on that exact provider, model, and endpoint across tool calls and retries. The next independent turn returns to the primary, and each model request receives only media modalities supported by its target. Omit `agent` (or set it to `false`) to keep the safer Vision Bridge transcription flow.

### Local Self-Hosted Models (via OpenAI-compatible API)

Most local inference servers (vLLM, Ollama, LM Studio, etc.) provide an OpenAI-compatible API endpoint. Configure them using the `openai` auth type with a local `baseUrl`:

```json
{
  "env": {
    "OLLAMA_API_KEY": "ollama",
    "VLLM_API_KEY": "not-needed",
    "LMSTUDIO_API_KEY": "lm-studio"
  },
  "modelProviders": {
    "openai": [
      {
        "id": "qwen2.5-7b",
        "name": "Qwen2.5 7B (Ollama)",
        "envKey": "OLLAMA_API_KEY",
        "baseUrl": "http://localhost:11434/v1",
        "generationConfig": {
          "timeout": 300000,
          "streamIdleTimeoutMs": 600000,
          "maxRetries": 1,
          "contextWindowSize": 32768,
          "samplingParams": {
            "temperature": 0.7,
            "top_p": 0.9,
            "max_tokens": 4096
          }
        }
      },
      {
        "id": "llama-3.1-8b",
        "name": "Llama 3.1 8B (vLLM)",
        "envKey": "VLLM_API_KEY",
        "baseUrl": "http://localhost:8000/v1",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 2,
          "contextWindowSize": 128000,
          "samplingParams": {
            "temperature": 0.6,
            "max_tokens": 8192
          }
        }
      },
      {
        "id": "local-model",
        "name": "Local Model (LM Studio)",
        "envKey": "LMSTUDIO_API_KEY",
        "baseUrl": "http://localhost:1234/v1",
        "generationConfig": {
          "timeout": 60000,
          "samplingParams": {
            "temperature": 0.5
          }
        }
      }
    ]
  }
}
```

For queued or slow local OpenAI-compatible servers, `streamIdleTimeoutMs`
controls how long this model may stay silent between streamed chunks. It
overrides the global `QWEN_STREAM_IDLE_TIMEOUT_MS` value for the selected
provider entry; set it to `0` to disable the idle guard. The separate 15-minute
stream lifetime cap still applies unless `QWEN_STREAM_MAX_LIFETIME_MS` is raised
or disabled.

For local servers that don't require authentication, you can use any placeholder value for the API key:

```bash
# For Ollama (no auth required)
export OLLAMA_API_KEY="ollama"

# For vLLM (if no auth is configured)
export VLLM_API_KEY="not-needed"
```

> [!note]
>
> The `extra_body` parameter is **only supported for OpenAI-compatible providers** (`openai`, `qwen-oauth`). It is ignored for Anthropic, and Gemini providers.

> [!note]
>
> **About `envKey`**: The `envKey` field specifies the **name of an environment variable**, not the actual API key value. For the configuration to work, you need to ensure the corresponding environment variable is set with your real API key. There are two ways to do this:
>
> - **Option 1: Using a `.env` file** (recommended for security):
>   ```bash
>   # ~/.qwen/.env (or project root)
>   OPENAI_API_KEY=sk-your-actual-key-here
>   ```
>   Be sure to add `.env` to your `.gitignore` to prevent accidentally committing secrets.
> - **Option 2: Using the `env` field in `settings.json`** (as shown in the examples above):
>   ```json
>   {
>     "env": {
>       "OPENAI_API_KEY": "sk-your-actual-key-here"
>     }
>   }
>   ```
>
> Each provider example includes an `env` field to illustrate how the API key should be configured.

## Alibaba Cloud Coding Plan

Alibaba Cloud Coding Plan provides a pre-configured set of Qwen models optimized for coding tasks. This feature is available for users with Alibaba Cloud Coding Plan API access and offers a simplified setup experience with automatic model configuration updates.

### Overview

When you authenticate with an Alibaba Cloud Coding Plan API key using the `/auth` command, Qwen Code automatically configures the following models:

| Model ID               | Name                 | Description                                               |
| ---------------------- | -------------------- | --------------------------------------------------------- |
| `qwen3.5-plus`         | qwen3.5-plus         | Advanced model with thinking enabled                      |
| `qwen3.6-plus`         | qwen3.6-plus         | Latest model with thinking enabled (Pro subscribers only) |
| `qwen3.7-plus`         | qwen3.7-plus         | Advanced model with thinking enabled                      |
| `qwen3-coder-plus`     | qwen3-coder-plus     | Optimized for coding tasks                                |
| `qwen3-coder-next`     | qwen3-coder-next     | Experimental coding model                                 |
| `qwen3-max-2026-01-23` | qwen3-max-2026-01-23 | Latest max model with thinking enabled                    |
| `glm-5`                | glm-5                | GLM model with thinking enabled                           |
| `glm-4.7`              | glm-4.7              | GLM model with thinking enabled                           |
| `kimi-k2.5`            | kimi-k2.5            | Kimi model with thinking and vision/video support         |
| `MiniMax-M2.5`         | MiniMax-M2.5         | MiniMax model with thinking enabled                       |

### Setup

1. Obtain an Alibaba Cloud Coding Plan API key:
   - **China**: <https://bailian.console.aliyun.com/?tab=model#/efm/coding_plan>
   - **International**: <https://modelstudio.console.alibabacloud.com/?tab=dashboard#/efm/coding_plan>
2. Run the `/auth` command in Qwen Code
3. Select **Alibaba ModelStudio**, then choose **Coding Plan** from the sub-menu
4. Select your region
5. Enter your API key when prompted

The models will be automatically configured and added to your `/model` picker.

### Regions

Alibaba Cloud Coding Plan supports two regions:

| Region               | Endpoint                                        | Description             |
| -------------------- | ----------------------------------------------- | ----------------------- |
| China                | `https://coding.dashscope.aliyuncs.com/v1`      | Mainland China endpoint |
| Global/International | `https://coding-intl.dashscope.aliyuncs.com/v1` | International endpoint  |

The region is selected during authentication and stored in `settings.json` under the `modelProviders` configuration. To switch regions, re-run the `/auth` command and select a different region.

### API Key Storage

When you configure Coding Plan through the `/auth` command, the API key is stored using the reserved environment variable name `BAILIAN_CODING_PLAN_API_KEY`. By default, it is stored in the `env` field of your `settings.json` file.

> [!warning]
>
> **Security Recommendation**: For better security, it is recommended to move the API key from `settings.json` to a separate `.env` file and load it as an environment variable. For example:
>
> ```bash
> # ~/.qwen/.env
> BAILIAN_CODING_PLAN_API_KEY=your-api-key-here
> ```
>
> Then ensure this file is added to your `.gitignore` if you're using project-level settings.

### Automatic Updates

Coding Plan model configurations are versioned. When Qwen Code detects a newer version of the model template, you will be prompted to update. Accepting the update will:

- Replace the existing Coding Plan model configurations with the latest versions
- Preserve any custom model configurations you've added manually
- Leave your selected model unchanged; if it is no longer in the updated
  configuration, use `/model` to choose a new one

The update process refreshes the model configurations and features without
changing your selected model.

### Manual Configuration (Advanced)

If you prefer to manually configure Coding Plan models, you can add them to your `settings.json` like any OpenAI-compatible provider:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder-plus",
        "name": "qwen3-coder-plus",
        "description": "Qwen3-Coder via Alibaba Cloud Coding Plan",
        "envKey": "YOUR_CUSTOM_ENV_KEY",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1"
      }
    ]
  }
}
```

> [!note]
>
> When using manual configuration:
>
> - You can use any environment variable name for `envKey`
> - You do not need to configure `codingPlan.*`
> - **Automatic updates will not apply** to manually configured Coding Plan models

> [!warning]
>
> If you also use automatic Coding Plan configuration, automatic updates may overwrite your manual configurations if they use the same `envKey` and `baseUrl` as the automatic configuration. To avoid this, ensure your manual configuration uses a different `envKey` if possible.

## Resolution Layers and Atomicity

The effective auth/model/credential values are chosen per field using the following precedence (first present wins). You can combine `--auth-type` with `--model` to point directly at a provider entry; these CLI flags run before other layers.

| Layer (highest → lowest)   | authType                            | model                                           | apiKey                                            | baseUrl                                            | apiKeyEnvKey           | proxy                             |
| -------------------------- | ----------------------------------- | ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | ---------------------- | --------------------------------- |
| Programmatic overrides     | `/auth`                             | `/auth` input                                   | `/auth` input                                     | `/auth` input                                      | —                      | —                                 |
| Model provider selection   | —                                   | `modelProvider.id`                              | `env[modelProvider.envKey]`                       | `modelProvider.baseUrl`                            | `modelProvider.envKey` | —                                 |
| CLI arguments              | `--auth-type`                       | `--model`                                       | `--openai-api-key`                                | `--openai-base-url`                                | —                      | —                                 |
| Environment variables      | —                                   | Provider-specific mapping (e.g. `OPENAI_MODEL`) | Provider-specific mapping (e.g. `OPENAI_API_KEY`) | Provider-specific mapping (e.g. `OPENAI_BASE_URL`) | —                      | —                                 |
| Settings (`settings.json`) | `security.auth.selectedType`        | `model.name`                                    | `security.auth.apiKey`                            | `security.auth.baseUrl`                            | —                      | —                                 |
| Default / computed         | Falls back to `AuthType.QWEN_OAUTH` | Built-in default (OpenAI ⇒ `qwen3.5-plus`)      | —                                                 | —                                                  | —                      | `Config.getProxy()` if configured |

\*When present, CLI auth flags override settings. Otherwise, `security.auth.selectedType` or the implicit default determine the auth type. Qwen OAuth and OpenAI are the only auth types surfaced without extra configuration.

> [!note]
>
> `--openai-api-key` and `--openai-base-url` are the only credential CLI flags. They apply to the active OpenAI-compatible provider regardless of its name — there are no `--anthropic-*` / `--gemini-*` credential flags. Provider-specific credentials that aren't passed on the CLI are resolved from environment variables (see the row below).

> [!warning]
>
> **Deprecation of `security.auth.apiKey` and `security.auth.baseUrl`:** Directly configuring API credentials via `security.auth.apiKey` and `security.auth.baseUrl` in `settings.json` is deprecated. These settings were used in historical versions for credentials entered through the UI, but the credential input flow was removed in version 0.10.1. These fields will be fully removed in a future release. **It is strongly recommended to migrate to `modelProviders`** for all model and credential configurations. Use `envKey` in `modelProviders` to reference environment variables for secure credential management instead of hardcoding credentials in settings files.

## Generation Config Layering: The Impermeable Provider Layer

The configuration resolution follows a strict layering model with one crucial rule: **the modelProvider layer is impermeable**.

### How it works

1. **When a modelProvider model IS selected** (e.g., via `/model` command choosing a provider-configured model):
   - The entire `generationConfig` from the provider is applied **atomically**
   - **The provider layer is completely impermeable** — lower layers (CLI, env, settings) do not participate in generationConfig resolution at all
   - All fields defined in `modelProviders[].generationConfig` use the provider's values
   - All fields **not defined** by the provider are set to `undefined` (not inherited from settings)
   - This ensures provider configurations act as a complete, self-contained "sealed package"

   If a model is listed in `modelProviders`, put all model-specific
   generation settings for that model in the matching provider entry. Top-level
   `model.generationConfig` values, including `contextWindowSize`,
   `modalities`, `customHeaders`, and `extra_body`, are ignored for provider
   models. Configure those fields under
   `modelProviders[authType][].generationConfig` for them to apply.

2. **When NO modelProvider model is selected** (e.g., using `--model` with a raw model ID, or using CLI/env/settings directly):
   - The resolution falls through to lower layers
   - Fields are populated from CLI → env → settings → defaults
   - This creates a **Runtime Model** (see next section)

### Per-field precedence for `generationConfig`

| Priority | Source                                        | Behavior                                                                                                 |
| -------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1        | Programmatic overrides                        | Runtime `/model`, `/auth` changes                                                                        |
| 2        | `modelProviders[authType][].generationConfig` | **Impermeable layer** - completely replaces all generationConfig fields; lower layers do not participate |
| 3        | `settings.model.generationConfig`             | Only used for **Runtime Models** (when no provider model is selected)                                    |
| 4        | Content-generator defaults                    | Provider-specific defaults (e.g., OpenAI vs Gemini) - only for Runtime Models                            |

### Dynamic values in `customHeaders`

A `customHeaders` value may contain the placeholder `${session_id}`, which is
expanded per request with the current Qwen Code session ID. Use it for gateways
that require a stable per-conversation identifier — OpenCode Go, for example,
rejects requests without `x-opencode-session`:

```json
{
  "generationConfig": {
    "customHeaders": {
      "x-opencode-session": "${session_id}"
    }
  }
}
```

Because the value is resolved per request rather than baked into the SDK client,
`/new` and `/resume` rotate it without a restart.

⚠️ **Two steps are required.** The provider entry above is only half of it — a
placeholder is inert until you also switch on
[`outboundCorrelation.allowDynamicHeaderValues`](settings.md#outboundcorrelation):

```json
{
  "outboundCorrelation": {
    "allowDynamicHeaderValues": true
  }
}
```

Until you do, a value containing a placeholder is **dropped** rather than sent,
and Qwen Code prints a warning at startup naming the header and this setting.
The header is never sent with a literal `${session_id}` in it.

The switch is global because it is a consent decision, separate from _where_ the
value goes: an expanded value carries live session state to whoever receives it,
and the switch controls only whether `${session_id}` may be expanded. It does not
identify which settings source supplied the header.

**Privacy note:** the session ID is a stable identifier for the life of a
conversation, so any host you send it to can group every request of that
conversation. Which hosts those are is decided by which provider entries carry
the header — there is no separate host list to keep in sync with your `baseUrl`.

### Atomic field treatment

The following fields are treated as atomic objects - provider values completely replace the entire object, no merging occurs:

- `samplingParams` - Temperature, top_p, max_tokens, etc.
- `customHeaders` - Custom HTTP headers (may contain `${session_id}`; see [Dynamic values](#dynamic-values-in-customheaders))
- `extra_body` - Extra request body parameters

### Example

```jsonc
// User settings (~/.qwen/settings.json)
{
  "model": {
    "generationConfig": {
      "timeout": 30000,
      "samplingParams": { "temperature": 0.5, "max_tokens": 1000 }
    }
  }
}

// modelProviders configuration
{
  "modelProviders": {
    "openai": [{
      "id": "gpt-4o",
      "envKey": "OPENAI_API_KEY",
      "generationConfig": {
        "timeout": 60000,
        "samplingParams": { "temperature": 0.2 }
      }
    }]
  }
}
```

When `gpt-4o` is selected from modelProviders:

- `timeout` = 60000 (from provider, overrides settings)
- `samplingParams.temperature` = 0.2 (from provider, completely replaces settings object)
- `samplingParams.max_tokens` = **undefined** (not defined in provider, and provider layer does not inherit from settings — fields are explicitly set to undefined if not provided)

When using a raw model via `--model gpt-4` (not from modelProviders, creates a Runtime Model):

- `timeout` = 30000 (from settings)
- `samplingParams.temperature` = 0.5 (from settings)
- `samplingParams.max_tokens` = 1000 (from settings)

The merge strategy for `modelProviders` itself is REPLACE: the entire `modelProviders` from project settings will override the corresponding section in user settings, rather than merging the two.

## Reasoning / thinking configuration

The optional `reasoning` field under `generationConfig` controls how aggressively the model reasons before responding. The Anthropic and Gemini converters always honor it. The OpenAI-compatible pipeline honors it **unless** `generationConfig.samplingParams` is set. Known GPT-5 models and GPT-6 Astra are an exception: unrelated sampling keys do not suppress configured effort. See "Interaction with `samplingParams`" below.

```jsonc
{
  "modelProviders": {
    "openai": [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "baseUrl": "https://api.deepseek.com/v1",
        "envKey": "DEEPSEEK_API_KEY",
        "generationConfig": {
          // The four-tier scale:
          //   'low'    | 'medium' — server-mapped to 'high' on DeepSeek
          //   'high'   — default reasoning intensity
          //   'max'    — DeepSeek-specific extra-strong tier
          // Or set `false` to disable reasoning entirely.
          "reasoning": { "effort": "max" },
        },
      },
    ],
  },
}
```

### Per-provider behavior

| Protocol / provider                           | Wire shape                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI / DashScope** (`qwen3.8-max` family) | Flat `reasoning_effort: <effort>` body parameter                                     | The `/effort` tiers are passed through for any model id starting with `qwen3.8-max` (including dated snapshots and `-latest` aliases); DashScope applies any model-specific mapping. This family's ladder stops at `xhigh`, so a configured `max` is clamped to `xhigh` (logged once) rather than sent and rejected. An explicit `reasoning_effort` in `samplingParams` or `extra_body` is a verbatim override and is not clamped. When `reasoning_effort` and `thinking_budget` conflict, the normal `extra_body` > `samplingParams` > `reasoning` precedence keeps only the higher-priority field; an explicit same-layer pair keeps `reasoning_effort`, matching the provider's behavior before cross-layer resolution. If a static field wins, `/effort` reports that field instead of implying the requested tier is effective. When an effort tier wins, a conflicting `enable_thinking` is also dropped. An explicit `enable_thinking: false` in `extra_body` is honoured rather than dropped: it overrides the configured tier as `reasoning_effort: 'none'`, one of the few places `extra_body` does not win verbatim. Other Qwen models continue to map a selected effort to `enable_thinking: true`; a `reasoning_effort` override passes through there unless it conflicts with a `thinking_budget` (a pair DashScope rejects), in which case the inert `reasoning_effort` is dropped and both `enable_thinking` and `thinking_budget` survive. |
| **OpenAI / DeepSeek** (`api.deepseek.com`)    | Flat `reasoning_effort: <effort>` body parameter                                     | When `reasoning.effort` is set in the nested config shape, it's rewritten to flat `reasoning_effort` and `'low'`/`'medium'` are normalized to `'high'`, `'xhigh'` to `'max'` — mirroring DeepSeek's [server-side back-compat](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion). Top-level `samplingParams.reasoning_effort` or `extra_body.reasoning_effort` overrides skip this normalization and ship verbatim. `max` is accepted only on a real DeepSeek hostname; a `deepseek`-named model on another host keeps the generic `xhigh` ceiling, matching the hostname gate on the reshape itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **OpenAI / Z.ai** (`z.ai`, `bigmodel.cn`)     | Flat `reasoning_effort: <effort>` body parameter                                     | GLM-5.2+ on a Z.ai host takes the full ladder, `max` included, and the nested `reasoning.effort` is rewritten to the flat field. Older GLM ids, and a `glm-*` model reached on any other host, keep the generic `xhigh` ceiling: the model name alone says nothing about what that endpoint accepts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **OpenAI** (other compatible servers)         | Known GPT-5 / GPT-6 Astra: flat `reasoning_effort`; other models: nested `reasoning` | GPT effort is clamped in both directions to the supported subset for the known model. GPT-5.6 and GPT-6 Astra allow `max`, while earlier models have lower ceilings. Tiers below the model floor are raised: GPT-5 Pro accepts only `high`; GPT-5.2 Pro, GPT-5.4 Pro and GPT-5.5 Pro raise `low` to `medium`. OpenRouter retains nested `reasoning`. Unknown model names keep the generic `xhigh` ceiling and nested shape. Explicit reasoning values in `samplingParams` / `extra_body` bypass the configured-tier clamp.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Anthropic** (real `api.anthropic.com`)      | `output_config: { effort }` plus the `effort-2025-11-24` beta header                 | Real Anthropic accepts `'low'`/`'medium'`/`'high'` only. `'max'` is **clamped to `'high'`** with a `debugLogger.warn` line (once per generator); if you want max effort, switch the baseURL to a DeepSeek-compatible endpoint that supports it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Anthropic** (`api.deepseek.com/anthropic`)  | Same `output_config: { effort }` + beta header                                       | `'max'` is passed through unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Gemini** (`@google/genai`)                  | `thinkingConfig: { includeThoughts: true, thinkingLevel }`                           | `'low'` → `LOW`, `'high'`/`'max'` → `HIGH`, others → `THINKING_LEVEL_UNSPECIFIED` (Gemini has no `MAX` tier).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### `reasoning: false`

Setting `reasoning: false` (the literal boolean) explicitly disables thinking on models that support disabling — useful for cheap side queries that don't benefit from reasoning. This is honored at the request level too via `request.config.thinkingConfig.includeThoughts: false` for one-off calls (e.g. suggestion generation).

On a `api.deepseek.com` baseURL, the OpenAI pipeline emits the explicit `thinking: { type: 'disabled' }` field that DeepSeek V4+ requires — the server-side default is `'enabled'`, so simply omitting `reasoning_effort` would still pay thinking latency/cost. Self-hosted DeepSeek backends (sglang/vllm) and other OpenAI-compatible servers do **not** receive this field; if you need to disable thinking on those, inject `thinking: { type: 'disabled' }` (or whatever knob your inference framework exposes) via `samplingParams`/`extra_body`.

For known GPT models that allow disabling, non-OpenRouter endpoints receive `reasoning_effort: 'none'`; OpenRouter receives nested `reasoning: { enabled: false }` instead. Mandatory-thinking models reject off in model controls and omit unsupported disable values from requests, so `reasoning: false` cannot turn their thinking off. An explicit model reasoning capability takes precedence over the built-in tier list and selects the native disable field; OpenRouter keeps its provider-level disable behavior. The built-in mandatory set is `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.2-pro`, `gpt-5.4-pro`, `gpt-5.5-pro`, and `gpt-6-astra`.

On an `openrouter.ai` baseURL, the OpenAI pipeline emits OpenRouter's provider-level `reasoning: { enabled: false }` field when reasoning is disabled. Mandatory-thinking models do not receive this disable field. Other OpenAI-compatible servers do not automatically receive this OpenRouter-specific field; use their native disable knob.

### Interaction with `samplingParams` (OpenAI-compatible only)

> [!warning]
>
> Except for known GPT models and models with explicit reasoning capabilities, when `generationConfig.samplingParams` is set on an OpenAI-compatible provider, the pipeline ships those keys to the wire **verbatim** and skips the separate `reasoning` injection entirely. So a config like `{ samplingParams: { temperature: 0.5 }, reasoning: { effort: 'max' } }` will silently drop the reasoning field on OpenAI/DeepSeek requests. A `reasoning` object placed inside `samplingParams` is your own value and ships unchanged while reasoning is enabled: the effort ceiling above applies only to the tier the pipeline injects from `/effort`.
>
> Known GPT-5 models and GPT-6 Astra keep configured effort alongside unrelated sampling keys. For example, `{ samplingParams: { temperature: 0.5 }, reasoning: { effort: 'max' } }` sends `temperature: 0.5` and flat `reasoning_effort: 'xhigh'` on GPT-5.4, or `'max'` on GPT-5.6 / GPT-6 Astra. On an `openrouter.ai` baseURL the same clamped tier ships as nested `reasoning: { effort }` instead. On non-OpenRouter endpoints, explicit flat reasoning overrides win; nullish or empty-string flat placeholders allow the configured tier. On OpenRouter, a sampling flat override suppresses configured nested effort unless explicit model capabilities inject it; an extra-body-only flat override does not replace the configured nested effort.
>
> DashScope Qwen models are another exception: their provider reads `reasoning` directly and maps it to `reasoning_effort` or `enable_thinking`. On the qwen3.8-max family, provider-specific `samplingParams` fields still take precedence when the wire parameters conflict; on older qwen hybrids, a configured effort tier collapses to `enable_thinking: true`, which overrides a `samplingParams.enable_thinking` value.
>
> For other models, include the provider's reasoning knob directly when using `samplingParams` — for DeepSeek that is `samplingParams.reasoning_effort`. Known GPT models map configured effort automatically; only add a raw override when intentionally bypassing that mapping. Raw nested `reasoning`, including `null`, remains a whole-object override while reasoning is enabled. Disabling via `reasoning: false` or request-level `includeThoughts: false` removes the nested value, including raw overrides in either layer. Non-OpenRouter GPT requests then send `reasoning_effort: 'none'` when disabling is allowed; OpenRouter uses its nested disable field instead. Mandatory-thinking models receive neither substitute. Outside OpenRouter its meaning depends on the gateway, so model controls show the model default. Any raw override that blocks a configured tier causes an explicit tier change to fail without saving a preference. The thinking switch restores configured raw defaults after disabling only when they permit thinking. If the raw state or configured reasoning default is off, the thinking switch cannot be turned on and the saved preference is retained. This also applies when explicit capabilities omit a default tier or expose only a thinking toggle. An explicit default command still resets the preference. Remove the blocking raw override to choose a different tier.
>
> The Anthropic and Gemini converters are unaffected — they always read `reasoning.effort` directly regardless of `samplingParams`.

### `budget_tokens`

You can pin an exact thinking-token budget by including `budget_tokens` alongside `effort`:

```jsonc
"reasoning": { "effort": "high", "budget_tokens": 50000 }
```

For Anthropic this becomes `thinking.budget_tokens`. For OpenAI/DeepSeek the field is preserved but currently ignored by the server — `reasoning_effort` is the load-bearing knob.

## Provider Models vs Runtime Models

Qwen Code distinguishes between two types of model configurations:

### Provider Model

- Defined in `modelProviders` configuration
- Has a complete, atomic configuration package
- When selected, its configuration is applied as an impermeable layer
- Appears in `/model` command list with full metadata (name, description, capabilities)
- Recommended for multi-model workflows and team consistency

### Runtime Model

- Created dynamically when using raw model IDs via CLI (`--model`), environment variables, or settings
- Not defined in `modelProviders`
- Configuration is built by "projecting" through resolution layers (CLI → env → settings → defaults)
- Automatically captured as a **RuntimeModelSnapshot** when a complete configuration is detected
- Allows reuse without re-entering credentials

### RuntimeModelSnapshot lifecycle

When you configure a model without using `modelProviders`, Qwen Code automatically creates a RuntimeModelSnapshot to preserve your configuration:

```bash
# This creates a RuntimeModelSnapshot with ID: $runtime|openai|my-custom-model
qwen --auth-type openai --model my-custom-model --openai-api-key $KEY --openai-base-url https://api.example.com/v1
```

The snapshot:

- Captures model ID, API key, base URL, and generation config
- Persists across sessions (stored in memory during runtime)
- Appears in the `/model` command list as a runtime option
- Can be switched to using `/model $runtime|openai|my-custom-model`

### Key differences

| Aspect                  | Provider Model                    | Runtime Model                              |
| ----------------------- | --------------------------------- | ------------------------------------------ |
| Configuration source    | `modelProviders` in settings      | CLI, env, settings layers                  |
| Configuration atomicity | Complete, impermeable package     | Layered, each field resolved independently |
| Reusability             | Always available in `/model` list | Captured as snapshot, appears if complete  |
| Team sharing            | Yes (via committed settings)      | No (user-local)                            |
| Credential storage      | Reference via `envKey` only       | May capture actual key in snapshot         |

### When to use each

- **Use Provider Models** when: You have standard models shared across a team, need consistent configurations, or want to prevent accidental overrides
- **Use Runtime Models** when: Quickly testing a new model, using temporary credentials, or working with ad-hoc endpoints

## Selection Persistence and Recommendations

> [!important]
>
> Define `modelProviders` in the user-scope `~/.qwen/settings.json` whenever possible and avoid persisting credential overrides in any scope. Keeping the provider catalog in user settings prevents merge/override conflicts between project and user scopes and ensures `/auth` and `/model` updates always write back to a consistent scope.

- `/model` and `/auth` persist `model.name` (where applicable) and `security.auth.selectedType` to the closest writable scope that already defines `modelProviders`; otherwise they fall back to the user scope. This keeps workspace/user files in sync with the active provider catalog.
- Without `modelProviders`, the resolver mixes CLI/env/settings layers, creating Runtime Models. This is fine for single-provider setups but cumbersome when frequently switching. Define provider catalogs whenever multi-model workflows are common so that switches stay atomic, source-attributed, and debuggable.
