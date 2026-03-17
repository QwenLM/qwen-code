# Qwen Code Advanced, Security, Hooks & Other Settings Reference

## `security` — Security Settings

```jsonc
// ~/.qwen/settings.json
{
  "security": {
    "folderTrust": {
      "enabled": false, // folder trust feature (default: false)
    },
    "auth": {
      "selectedType": "dashscope", // current auth type (AuthType)
      "enforcedType": undefined, // enforced auth type (re-auth required if mismatch)
      "useExternal": false, // use external authentication flow
      "apiKey": "$API_KEY", // API key for OpenAI-compatible auth
      "baseUrl": "https://api.example.com", // base URL for OpenAI-compatible API
    },
  },
}
```

---

## `hooks` — Hook System

Run custom commands before or after agent processing.

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      // runs before agent processing
      {
        "matcher": "*.py", // optional: filter pattern
        "sequential": false, // run sequentially instead of in parallel
        "hooks": [
          {
            "type": "command", // required: "command"
            "command": "npm run lint", // required: command to execute
            "name": "lint-check", // optional: hook name
            "description": "Run linter before processing", // optional: description
            "timeout": 30000, // optional: timeout in ms
            "env": {
              // optional: environment variables
              "NODE_ENV": "development",
            },
          },
        ],
      },
    ],
    "Stop": [
      // runs after agent processing
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm run format",
            "name": "auto-format",
          },
        ],
      },
    ],
  },
}
```

### `hooksConfig` — Hook Control

```jsonc
{
  "hooksConfig": {
    "enabled": true, // master switch (default: true)
    "disabled": ["npm run lint"], // disable specific hook commands by name
  },
}
```

---

## `env` — Environment Variable Fallbacks

Low-priority environment variable defaults. Load order: system env vars > .env files > settings.json `env` field.

```jsonc
{
  "env": {
    "OPENAI_API_KEY": "sk-xxx",
    "TAVILY_API_KEY": "tvly-xxx",
    "NODE_ENV": "development",
  },
}
```

**Merge strategy**: `shallow_merge`

---

## `privacy` — Privacy Settings

```jsonc
{
  "privacy": {
    "usageStatisticsEnabled": true, // enable usage statistics collection (default: true)
  },
}
```

---

## `telemetry` — Telemetry Configuration

```jsonc
{
  "telemetry": {
    // TelemetrySettings object — typically does not need manual configuration
  },
}
```

---

## `webSearch` — Web Search Configuration

```jsonc
{
  "webSearch": {
    "provider": [
      {
        "type": "tavily", // "tavily" | "google" | "dashscope"
        "apiKey": "$TAVILY_API_KEY",
      },
      {
        "type": "google",
        "apiKey": "$GOOGLE_API_KEY",
        "searchEngineId": "your-cse-id",
      },
      {
        "type": "dashscope", // DashScope built-in search
      },
    ],
    "default": "tavily", // default search provider to use
  },
}
```

---

## `advanced` — Advanced Settings

```jsonc
{
  "advanced": {
    "autoConfigureMemory": false, // auto-configure Node.js memory limits
    "dnsResolutionOrder": "ipv4first", // DNS resolution order
    // "ipv4first" | "verbatim"
    "excludedEnvVars": ["DEBUG", "DEBUG_MODE"], // env vars to exclude from project context
    // merge strategy: union
    "bugCommand": {
      // bug report command configuration
      // BugCommandSettings
    },
    "tavilyApiKey": "xxx", // ⚠️ Deprecated — use webSearch.provider instead
  },
}
```
