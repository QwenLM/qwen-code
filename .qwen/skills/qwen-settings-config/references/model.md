# Qwen Code Model Settings Reference

## `model` — Model Configuration

```jsonc
// ~/.qwen/settings.json
{
  "model": {
    "name": "qwen-max", // model name
    "maxSessionTurns": -1, // max session turns (-1 = unlimited)
    "sessionTokenLimit": 100000, // session token limit
    "skipNextSpeakerCheck": true, // skip next-speaker check (default: true)
    "skipLoopDetection": true, // disable all loop detection (default: true)
    "skipStartupContext": false, // skip workspace context injection at startup
    "chatCompression": {
      // chat compression settings
      // ChatCompressionSettings
    },
    "generationConfig": {
      // generation configuration
      "timeout": 30000, // request timeout in ms
      "maxRetries": 3, // max retry attempts
      "enableCacheControl": true, // enable DashScope cache control (default: true)
      "schemaCompliance": "auto", // tool schema compliance mode
      //   "auto" | "openapi_30" (for Gemini compatibility)
      "contextWindowSize": 128000, // override model's default context window size
    },
    "enableOpenAILogging": false, // enable OpenAI API request logging
    "openAILoggingDir": "./logs/openai", // log directory
  },
}
```

### Common Scenarios

#### Switch Model

```jsonc
{
  "model": {
    "name": "qwen-plus", // or "qwen-max", "gpt-4o", etc.
  },
}
```

#### Configure OpenAI-Compatible Endpoint

```jsonc
{
  "modelProviders": {
    "openai-compatible": [
      {
        "name": "my-custom-model",
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "$CUSTOM_API_KEY",
        "model": "gpt-4-turbo",
      },
    ],
  },
}
```

#### Adjust Request Timeout

```jsonc
{
  "model": {
    "generationConfig": {
      "timeout": 60000, // 60 second timeout
      "maxRetries": 5, // max 5 retries
    },
  },
}
```

#### Enable Request Logging

```jsonc
{
  "model": {
    "enableOpenAILogging": true,
    "openAILoggingDir": "./logs/openai",
  },
}
```

---

## `modelProviders` — Model Provider Configuration

Model configs grouped by authType. Used to configure custom model endpoints.

```jsonc
{
  "modelProviders": {
    "openai-compatible": [
      {
        "name": "my-custom-model",
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "$CUSTOM_API_KEY",
        "model": "gpt-4-turbo",
      },
    ],
  },
}
```

---

## `codingPlan` — Coding Plan

```jsonc
{
  "codingPlan": {
    "version": "sha256-hash", // template version hash, used to detect template updates
  },
}
```

Typically does not need manual configuration.
