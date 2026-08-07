---
description: "Qwen Code custom API key auth wizard PRD. Design an in-terminal setup flow for custom OpenAI, Anthropic, and Gemini-compatible providers."
---

# Custom API Key Auth Wizard PRD

## Summary

Improve the `/auth -> API Key -> Custom API Key` experience by replacing the current documentation-only screen with an in-terminal setup wizard for custom API providers.

Qwen Code supports multiple API protocols through `authType` / `modelProviders` keys, including `openai`, `anthropic`, and `gemini`. Therefore, the custom setup wizard should start by asking users to select the protocol, then collect endpoint, key, and model information for that protocol.

The wizard guides users through:

```text
Select Protocol -> Enter Base URL -> Enter API Key -> Enter Model IDs -> Review JSON -> Save + authenticate
```

This keeps the custom API key setup inside Qwen Code, reduces the need to manually edit `settings.json`, and makes the final configuration transparent by showing the generated JSON before saving.

## Background

Today, selecting `Custom API Key` in `/auth` shows a static information screen:

```text
Custom Configuration

You can configure your API key and models in settings.json

Refer to the documentation for setup instructions
https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/

Esc to go back
```

This requires users to leave the CLI, read documentation, understand `settings.json`, manually configure `modelProviders`, choose an `envKey`, add API keys, and then return to Qwen Code. Users have reported that this flow is difficult and disconnected from the rest of the `/auth` experience.

The current ModelStudio Standard API key path already provides a guided setup flow:

```text
Alibaba Cloud ModelStudio Standard API Key
└─ Select Region
   └─ Enter API Key
      └─ Enter Model IDs
         └─ Save + authenticate
```

Custom API key setup should offer a similar guided experience, while also respecting that Qwen Code supports multiple provider protocols.

## Problem Statement

The custom API key path is currently a dead end inside `/auth`:

```text
/auth
└─ Select Authentication Method
   ├─ Alibaba Cloud Coding Plan
   ├─ API Key
   │  └─ Select API Key Type
   │     ├─ Alibaba Cloud ModelStudio Standard API Key
   │     │  ├─ Select Region
   │     │  ├─ Enter API Key
   │     │  ├─ Enter Model IDs
   │     │  └─ Save + authenticate
   │     │
   │     └─ Custom API Key
   │        └─ Documentation-only screen
   │
   └─ Qwen OAuth
```

This causes several usability issues:

- Users cannot finish custom provider setup from `/auth`.
- Users need to understand low-level settings concepts before they can authenticate.
- Users may not know which fields are required: `authType`, `baseUrl`, `envKey`, `modelProviders`, `model.name`, and `security.auth.selectedType`.
- Users may accidentally conflict with existing environment variables or overwrite existing provider configuration.
- Users do not get immediate authentication feedback after editing settings manually.

## Goals

1. Let users configure a custom API provider completely inside `/auth`.
2. Support the main protocols Qwen Code supports in `modelProviders`: `openai`, `anthropic`, and `gemini`.
3. Keep the flow close to the existing ModelStudio Standard flow.
4. Treat `baseUrl` as the custom-provider equivalent of `region`.
5. Automatically generate a Qwen-managed private `envKey` from the selected protocol and input `baseUrl`.
6. Store the API key under `settings.json.env`, consistent with the current Qwen-managed credential pattern.
7. Avoid conflicts with user shell environment variables by using a Qwen-specific generated key name.
8. Show the generated JSON before saving so users can review the exact settings changes.
9. Preserve unrelated existing `modelProviders` entries.
10. Authenticate immediately after saving and show success or failure feedback.

## Non-goals

1. Do not require users to manually enter `envKey`.
2. Do not introduce provider name as a separate concept.
3. Do not add advanced `generationConfig`, `capabilities`, or per-model overrides to the wizard.
4. Do not remove the documentation link entirely; it should remain available for advanced configuration.
5. Do not change the existing Coding Plan or ModelStudio Standard API key flows.
6. Do not attempt to auto-detect protocol from `baseUrl` in the first version; users select the protocol explicitly.

## Target Users

- Users who bring their own custom API endpoint.
- Users configuring providers such as OpenAI-compatible APIs, Anthropic-compatible APIs, Gemini-compatible APIs, vLLM, Ollama, LM Studio, or internal gateways.
- Users who prefer setting up authentication from the CLI rather than manually editing `settings.json`.

## Supported Protocols

The wizard should initially expose these protocol options:

```text
openai
anthropic
gemini
```

Each protocol maps directly to a `modelProviders` key and `security.auth.selectedType` value.

| Protocol option      | Auth type / modelProviders key | Notes                                                                             |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| OpenAI-compatible    | `openai`                       | OpenAI, OpenRouter, Fireworks, local OpenAI-compatible servers, internal gateways |
| Anthropic-compatible | `anthropic`                    | Anthropic-compatible endpoints                                                    |
| Gemini-compatible    | `gemini`                       | Gemini-compatible endpoints                                                       |

## User Experience Overview

### Updated `/auth` tree

```text
/auth
└─ Select Authentication Method
   ├─ Alibaba Cloud Coding Plan
   │  └─ Select Region
   │     └─ Enter API Key
   │        └─ Save + authenticate
   │
   ├─ API Key
   │  └─ Select API Key Type
   │     ├─ Alibaba Cloud ModelStudio Standard API Key
   │     │  ├─ Select Region
   │     │  ├─ Enter API Key
   │     │  ├─ Enter Model IDs
   │     │  └─ Save + authenticate
   │     │
   │     └─ Custom API Key
   │        ├─ Select Protocol
   │        ├─ Enter Base URL
   │        ├─ Enter API Key
   │        ├─ Enter Model IDs
   │        ├─ Review generated JSON
   │        └─ Save + authenticate
   │
   └─ Qwen OAuth
```

### Custom API Key state machine

```text
api-key-type-select
  │
  └─ CUSTOM_API_KEY
      │
      ▼
custom-protocol-select
      │ Enter
      ▼
custom-base-url-input
      │ Enter
      │ generate envKey from protocol + baseUrl
      ▼
custom-api-key-input
      │ Enter
      ▼
custom-model-id-input
      │ Enter
      ▼
custom-review-json
      │ Enter
      ▼
save settings + refreshAuth(selectedProtocol)
```

### Escape behavior

```text
custom-review-json
  Esc -> custom-model-id-input

custom-model-id-input
  Esc -> custom-api-key-input

custom-api-key-input
  Esc -> custom-base-url-input

custom-base-url-input
  Esc -> custom-protocol-select

custom-protocol-select
  Esc -> api-key-type-select
```

## Detailed Interaction Design

### Step 1: Select Protocol

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Select Protocol                             │
│                                                              │
│  ◉ OpenAI-compatible                                         │
│    OpenAI, OpenRouter, Fireworks, vLLM, Ollama, LM Studio    │
│                                                              │
│  ○ Anthropic-compatible                                      │
│    Anthropic-compatible endpoints                            │
│                                                              │
│  ○ Gemini-compatible                                         │
│    Gemini-compatible endpoints                               │
│                                                              │
│ Enter to select, ↑↓ to navigate, Esc to go back              │
└──────────────────────────────────────────────────────────────┘
```

The selected protocol determines:

- The `modelProviders` key to update.
- The `security.auth.selectedType` value to persist.
- The protocol label shown on later screens.
- The `refreshAuth()` auth type used after saving.

### Step 2: Enter Base URL

`baseUrl` is the custom-provider equivalent of region selection. It should come before API key entry because it determines which endpoint the API key belongs to.

For OpenAI-compatible:

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Base URL                                    │
│                                                              │
│ Protocol: OpenAI-compatible                                  │
│                                                              │
│ Enter the OpenAI-compatible API endpoint.                    │
│                                                              │
│ Base URL: https://openrouter.ai/api/v1_                      │
│                                                              │
│ Examples:                                                    │
│   OpenAI:      https://api.openai.com/v1                     │
│   OpenRouter: https://openrouter.ai/api/v1                   │
│   Fireworks:  https://api.fireworks.ai/inference/v1          │
│   Ollama:     http://localhost:11434/v1                      │
│   LM Studio:  http://localhost:1234/v1                       │
│                                                              │
│ Enter to continue, Esc to go back                            │
└──────────────────────────────────────────────────────────────┘
```

For Anthropic-compatible:

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Base URL                                    │
│                                                              │
│ Protocol: Anthropic-compatible                               │
│                                                              │
│ Enter the Anthropic-compatible API endpoint.                 │
│                                                              │
│ Base URL: https://api.anthropic.com/v1_                      │
│                                                              │
│ Enter to continue, Esc to go back                            │
└──────────────────────────────────────────────────────────────┘
```

For Gemini-compatible:

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Base URL                                    │
│                                                              │
│ Protocol: Gemini-compatible                                  │
│                                                              │
│ Enter the Gemini-compatible API endpoint.                    │
│                                                              │
│ Base URL: https://generativelanguage.googleapis.com_         │
│                                                              │
│ Enter to continue, Esc to go back                            │
└──────────────────────────────────────────────────────────────┘
```

Validation:

- Required.
- Must start with `http://` or `https://`.
- Trim leading and trailing whitespace.
- Preserve the normalized string as entered, except trimming.

On valid submit:

- Generate the Qwen-managed `envKey` from selected protocol and `baseUrl`.
- Move to API key input.

### Step 3: Enter API Key

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · API Key                                     │
│                                                              │
│ Protocol: OpenAI-compatible                                  │
│ Endpoint: https://openrouter.ai/api/v1                       │
│                                                              │
│ Enter the API key for this endpoint.                         │
│                                                              │
│ API key: sk-or-v1-••••••••••••••••_                          │
│                                                              │
│ Enter to continue, Esc to go back                            │
└──────────────────────────────────────────────────────────────┘
```

Validation:

- Required.
- Trim leading and trailing whitespace.

Notes:

- The input may initially use the existing text input behavior for consistency with nearby flows.
- The review screen should mask the API key.

### Step 4: Enter Model IDs

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Model IDs                                   │
│                                                              │
│ Protocol: OpenAI-compatible                                  │
│ Endpoint: https://openrouter.ai/api/v1                       │
│                                                              │
│ Enter one or more model IDs, separated by commas.            │
│                                                              │
│ Model IDs: qwen/qwen3-coder,openai/gpt-4.1_                  │
│                                                              │
│ Enter to continue, Esc to go back                            │
└──────────────────────────────────────────────────────────────┘
```

Validation:

- Required.
- Split by comma.
- Trim each model ID.
- Remove empty entries.
- Deduplicate entries while preserving order.
- At least one model ID must remain.

Model naming:

- `id` and `name` should be the same.
- No separate provider name is requested from the user.

Example:

```text
Input:
qwen/qwen3-coder, openai/gpt-4.1, qwen/qwen3-coder

Normalized:
qwen/qwen3-coder, openai/gpt-4.1
```

### Step 5: Review JSON

Before saving, show the generated JSON snippet that will be written or merged into `settings.json`.

OpenAI-compatible example:

```text
┌──────────────────────────────────────────────────────────────┐
│ Custom API Key · Review                                      │
│                                                              │
│ The following JSON will be saved to settings.json:           │
│                                                              │
│ {                                                            │
│   "env": {                                                   │
│     "QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1":│
│       "sk-••••••••••••••••"                                  │
│   },                                                         │
│   "modelProviders": {                                        │
│     "openai": [                                              │
│       {                                                      │
│         "id": "qwen/qwen3-coder",                           │
│         "name": "qwen/qwen3-coder",                         │
│         "baseUrl": "https://openrouter.ai/api/v1",          │
│         "envKey": "QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1"│
│       }                                                      │
│     ]                                                        │
│   },                                                         │
│   "security": {                                              │
│     "auth": {                                                │
│       "selectedType": "openai"                              │
│     }                                                        │
│   },                                                         │
│   "model": {                                                 │
│     "name": "qwen/qwen3-coder"                              │
│   }                                                          │
│ }                                                            │
│                                                              │
│ Enter to save, Esc to go back                                │
└──────────────────────────────────────────────────────────────┘
```

Anthropic-compatible example:

```json
{
  "env": {
    "QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_ANTHROPIC_COM_V1": "sk-••••"
  },
  "modelProviders": {
    "anthropic": [
      {
        "id": "claude-sonnet-4-5",
        "name": "claude-sonnet-4-5",
        "baseUrl": "https://api.anthropic.com/v1",
        "envKey": "QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_ANTHROPIC_COM_V1"
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "anthropic"
    }
  },
  "model": {
    "name": "claude-sonnet-4-5"
  }
}
```

The displayed JSON should:

- Use the selected protocol as the `modelProviders` key.
- Use the selected protocol as `security.auth.selectedType`.
- Use the actual generated `envKey`.
- Mask the API key.
- Use the user-entered `baseUrl`.
- Use `id === name` for each model.
- Show `model.name` set to the first normalized model ID.

If the JSON is too wide for the current terminal, wrapping is acceptable. The goal is transparency, not copy-paste-perfect formatting.

### Step 6: Save and Authenticate

On Enter from the review screen:

```text
save:
  env[generatedEnvKey] = apiKey
  modelProviders[selectedProtocol] = [
    ...new custom configs using generatedEnvKey,
    ...existing configs whose envKey !== generatedEnvKey
  ]
  security.auth.selectedType = selectedProtocol
  model.name = firstModelId
  reloadModelProvidersConfig()
  refreshAuth(selectedProtocol)
```

Success message:

```text
Custom API Key authenticated successfully. Settings updated with generated env key and model provider config.
Tip: Use /model to switch between configured models.
```

Failure message should preserve the existing authentication failure pattern, with additional user-facing hints if possible:

```text
Failed to authenticate. Message: <error>

Please check:
- Base URL is compatible with the selected protocol
- API key is valid for this endpoint
- Model ID exists for this provider
```

## Env Key Generation

The wizard should not ask users to enter an `envKey`.

Qwen-managed API keys are stored in `settings.json.env`, so the env key should be generated automatically under a Qwen-specific namespace. This avoids collisions with user-managed shell environment variables and prevents multiple custom endpoints from overwriting each other.

### Format

```text
QWEN_CUSTOM_API_KEY_${PROTOCOL}_${NORMALIZED_BASE_URL}
```

Including the protocol avoids collisions when the same endpoint is used under different protocol adapters.

### Examples

```text
Protocol: openai
Base URL: https://api.openai.com/v1
-> QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_API_OPENAI_COM_V1

Protocol: openai
Base URL: https://openrouter.ai/api/v1
-> QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1

Protocol: anthropic
Base URL: https://api.anthropic.com/v1
-> QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_ANTHROPIC_COM_V1

Protocol: gemini
Base URL: https://generativelanguage.googleapis.com
-> QWEN_CUSTOM_API_KEY_GEMINI_HTTPS_GENERATIVELANGUAGE_GOOGLEAPIS_COM

Protocol: openai
Base URL: http://localhost:11434/v1
-> QWEN_CUSTOM_API_KEY_OPENAI_HTTP_LOCALHOST_11434_V1
```

### Normalization rule

```text
protocol
  -> trim
  -> uppercase
  -> replace every non A-Z / 0-9 character with _

baseUrl
  -> trim
  -> uppercase
  -> replace every non A-Z / 0-9 character with _
  -> collapse consecutive _ characters
  -> remove leading/trailing _

return QWEN_CUSTOM_API_KEY_${NORMALIZED_PROTOCOL}_${NORMALIZED_BASE_URL}
```

Pseudo-code:

```ts
function generateCustomApiKeyEnvKey(protocol: string, baseUrl: string): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

  return `QWEN_CUSTOM_API_KEY_${normalize(protocol)}_${normalize(baseUrl)}`;
}
```

## Settings Write Design

Given user input:

```text
Protocol: openai
Base URL: https://openrouter.ai/api/v1
API key: sk-or-v1-xxx
Model IDs: qwen/qwen3-coder,openai/gpt-4.1
```

The wizard should produce:

```json
{
  "env": {
    "QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1": "sk-or-v1-xxx"
  },
  "modelProviders": {
    "openai": [
      {
        "id": "qwen/qwen3-coder",
        "name": "qwen/qwen3-coder",
        "baseUrl": "https://openrouter.ai/api/v1",
        "envKey": "QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1"
      },
      {
        "id": "openai/gpt-4.1",
        "name": "openai/gpt-4.1",
        "baseUrl": "https://openrouter.ai/api/v1",
        "envKey": "QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1"
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen/qwen3-coder"
  }
}
```

For `anthropic`, the same structure is used, except:

```text
modelProviders.anthropic
security.auth.selectedType = anthropic
refreshAuth(anthropic)
```

For `gemini`, the same structure is used, except:

```text
modelProviders.gemini
security.auth.selectedType = gemini
refreshAuth(gemini)
```

### Persist scope

Use the same persist-scope strategy as model selection and the existing API-key flows:

```text
getPersistScopeForModelSelection(settings)
```

This keeps behavior consistent with existing `modelProviders` ownership rules.

### Backup

Before writing, back up the target settings file, consistent with existing Coding Plan and ModelStudio Standard flows.

### Process env sync

After writing `settings.json.env[generatedEnvKey]`, immediately sync:

```text
process.env[generatedEnvKey] = apiKey
```

This ensures `refreshAuth(selectedProtocol)` can use the newly entered key in the same session.

### Model provider merge rule

For the generated env key:

```text
generatedEnvKey = QWEN_CUSTOM_API_KEY_${PROTOCOL}_${NORMALIZED_BASE_URL}
```

Update `modelProviders[selectedProtocol]` as follows:

```text
newConfigs = normalizedModelIds.map(modelId => ({
  id: modelId,
  name: modelId,
  baseUrl,
  envKey: generatedEnvKey,
}))

existingConfigs = settings.merged.modelProviders?.[selectedProtocol] ?? []

preservedConfigs = existingConfigs.filter(config =>
  config.envKey !== generatedEnvKey
)

updatedConfigs = [
  ...newConfigs,
  ...preservedConfigs,
]
```

Rationale:

- Reconfiguring the same protocol + `baseUrl` replaces old models for that endpoint.
- Configuring a different protocol or `baseUrl` uses a different env key and does not overwrite previous custom endpoints.
- Coding Plan, ModelStudio Standard, and other user configs are preserved unless they use the same generated env key under the same protocol.
- New configs are placed first so the newly configured models are immediately visible and selected by default.

## Error Handling

### Protocol validation error

The protocol must be one of:

```text
openai
anthropic
gemini
```

### Base URL validation error

```text
Base URL cannot be empty.
```

```text
Base URL must start with http:// or https://.
```

### API key validation error

```text
API key cannot be empty.
```

### Model IDs validation error

```text
Model IDs cannot be empty.
```

### Authentication failure

Use the existing failure mechanism where possible, but the user-facing error should help users recover:

```text
Failed to authenticate. Message: <message>

Please check:
- Base URL is compatible with the selected protocol
- API key is valid for this endpoint
- Model ID exists for this provider
```

## Documentation Link

The wizard should still expose the existing model providers documentation for advanced users.

Recommended placement:

- On the review screen footer, or
- As secondary text on the base URL screen.

Suggested copy:

```text
Need advanced generationConfig or capabilities? See:
https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
```

## Implementation Notes

Expected `AuthDialog` view levels:

```ts
type ViewLevel =
  | 'main'
  | 'region-select'
  | 'api-key-input'
  | 'api-key-type-select'
  | 'alibaba-standard-region-select'
  | 'alibaba-standard-api-key-input'
  | 'alibaba-standard-model-id-input'
  | 'custom-protocol-select'
  | 'custom-base-url-input'
  | 'custom-api-key-input'
  | 'custom-model-id-input'
  | 'custom-review-json';
```

Expected custom protocol type:

```ts
type CustomApiProtocol =
  | AuthType.USE_OPENAI
  | AuthType.USE_ANTHROPIC
  | AuthType.USE_GEMINI;
```

Expected new state in `AuthDialog`:

```ts
const [customProtocol, setCustomProtocol] = useState<CustomApiProtocol>(
  AuthType.USE_OPENAI,
);
const [customProtocolIndex, setCustomProtocolIndex] = useState<number>(0);
const [customBaseUrl, setCustomBaseUrl] = useState('');
const [customBaseUrlError, setCustomBaseUrlError] = useState<string | null>(
  null,
);
const [customApiKey, setCustomApiKey] = useState('');
const [customApiKeyError, setCustomApiKeyError] = useState<string | null>(null);
const [customModelIds, setCustomModelIds] = useState('');
const [customModelIdsError, setCustomModelIdsError] = useState<string | null>(
  null,
);
```

Expected new UI action:

```ts
handleCustomApiKeySubmit: (
  protocol: CustomApiProtocol,
  baseUrl: string,
  apiKey: string,
  modelIdsInput: string,
) => Promise<void>;
```

Expected helper functions:

```ts
generateCustomApiKeyEnvKey(protocol: string, baseUrl: string): string
normalizeCustomModelIds(modelIdsInput: string): string[]
maskApiKey(apiKey: string): string
```

## Acceptance Criteria

### UX

- Selecting `/auth -> API Key -> Custom API Key` opens the custom wizard instead of the documentation-only page.
- The first custom wizard step asks for protocol.
- The second step asks for Base URL and displays the selected protocol.
- The third step asks for API key and displays the selected protocol and endpoint.
- The fourth step asks for model IDs and displays the selected protocol and endpoint.
- The review step displays the generated JSON, including masked API key, selected protocol, and generated env key.
- Pressing Enter on the review step saves settings and attempts authentication.
- Pressing Esc navigates back one step at a time.

### Settings

- The API key is written to `settings.json.env[generatedEnvKey]`.
- `generatedEnvKey` is derived from selected protocol and `baseUrl` using the Qwen private namespace.
- `modelProviders[selectedProtocol]` receives one entry per normalized model ID.
- Each custom model entry uses `id === name`.
- `security.auth.selectedType` is set to the selected protocol.
- `model.name` is set to the first normalized model ID.
- Existing entries under `modelProviders[selectedProtocol]` with a different `envKey` are preserved.
- Existing entries under `modelProviders[selectedProtocol]` with the same generated `envKey` are replaced.
- Entries under other `modelProviders` protocol keys are preserved.

### Authentication

- The generated env key is synced to `process.env` before auth refresh.
- The app reloads model provider config before `refreshAuth(selectedProtocol)`.
- Successful auth closes the auth dialog and shows a success message.
- Failed auth keeps the user in the auth flow and shows an actionable error.

### Tests

- Add or update `AuthDialog` tests to cover the custom wizard path.
- Add tests for protocol selection.
- Add tests for env key generation from protocol and base URL.
- Add tests for model ID normalization and deduplication.
- Add tests for settings merge behavior:
  - same generated env key replaces old custom entries under the same protocol;
  - different env keys are preserved;
  - other protocol keys are preserved;
  - Coding Plan and ModelStudio Standard entries are preserved.
- Add tests for generated JSON preview content where practical.

## Open Questions

1. Should the API key input be masked during typing, or only masked on the review screen?
2. Should local endpoints such as `http://localhost:11434/v1` allow empty or placeholder API keys for servers that do not require authentication?
3. Should the generated JSON preview show only the patch being applied, or the resulting full relevant settings subtree after merge?
4. Should Vertex AI be included in this custom API key wizard, or remain outside because its auth setup differs from simple API-key providers?

For the first version, recommended defaults are:

- Support `openai`, `anthropic`, and `gemini`.
- Use existing input behavior during typing.
- Require non-empty API key for consistency with API-key auth flows.
- Show the patch-style JSON that will be saved or updated.
- Keep Vertex AI out of the custom API key wizard until a separate product decision is made.
