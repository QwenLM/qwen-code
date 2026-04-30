# call_llm

`call_llm` asks the configured Qwen backend for a focused completion from inside a session tool flow.

## Parameters

| Field | Type | Description |
|------|------|-------------|
| `prompt` | string | Instructions for the model |
| `attachments` | array | Optional files on disk |
| `model` | string | Optional Qwen model ID or short name |
| `systemPrompt` | string | Optional system prompt |
| `maxTokens` | number | Maximum output tokens |
| `temperature` | number | Sampling temperature |
| `thinking` | boolean | Request extended reasoning when supported |
| `outputFormat` | string | Optional structured output style |
| `outputSchema` | object | Optional JSON schema |

## Examples

```json
{
  "prompt": "Summarize the current implementation risk in three bullets.",
  "model": "qwen3-coder-flash"
}
```

```json
{
  "prompt": "Extract the API endpoints from this file.",
  "attachments": [{ "path": "/path/to/server.ts", "startLine": 1, "endLine": 200 }],
  "outputFormat": "extraction"
}
```
