# Web Search Tool (`web_search`)

This document describes the `web_search` tool for performing web searches using multiple providers.

## Description

Use `web_search` to perform a web search and get information from the internet. The tool supports multiple search providers and returns a concise answer with source citations when available.

### Supported Providers

1. **DashScope** (Official, Free) - Automatically available for Qwen OAuth users (200 requests/minute, 2000 requests/day)
2. **Tavily** - High-quality search API with built-in answer generation
3. **Google Custom Search** - Google's Custom Search JSON API

### Arguments

`web_search` takes two arguments:

- `query` (string, required): The search query
- `provider` (string, optional): Specific provider to use ("dashscope", "tavily", "google")
  - If not specified, uses the default provider from configuration

## Configuration

### Method 1: Settings File (Recommended)

Add to your `settings.json`:

```json
{
  "webSearch": {
    "provider": [
      { "type": "dashscope" },
      { "type": "tavily", "apiKey": "tvly-xxxxx" },
      {
        "type": "google",
        "apiKey": "your-google-api-key",
        "searchEngineId": "your-search-engine-id"
      }
    ],
    "default": "dashscope"
  }
}
```

**Notes:**

- DashScope doesn't require an API key (official, free service)
- **Qwen OAuth users:** DashScope is automatically added to your provider list, even if not explicitly configured
- Configure additional providers (Tavily, Google) if you want to use them alongside DashScope
- Set `default` to specify which provider to use by default (if not set, priority order: Tavily > Google > DashScope)

### Method 2: Environment Variables

Set environment variables in your shell or `.env` file:

```bash
# Tavily
export TAVILY_API_KEY="tvly-xxxxx"

# Google
export GOOGLE_API_KEY="your-api-key"
export GOOGLE_SEARCH_ENGINE_ID="your-engine-id"
```

### Method 3: Command Line Arguments

Pass API keys when running Qwen Code:

```bash
# Tavily
qwen --tavily-api-key tvly-xxxxx

# Google
qwen --google-api-key your-key --google-search-engine-id your-id

# Specify default provider
qwen --web-search-default tavily
```

### Backward Compatibility (Deprecated)

⚠️ **DEPRECATED:** The legacy `tavilyApiKey` configuration is still supported for backward compatibility but is deprecated:

```json
{
  "advanced": {
    "tavilyApiKey": "tvly-xxxxx" // ⚠️ Deprecated
  }
}
```

**Important:** This configuration is deprecated and will be removed in a future version. Please migrate to the new `webSearch` configuration format shown above. The old configuration will automatically configure Tavily as a provider, but we strongly recommend updating your configuration.

## Disabling Web Search

If you want to disable the web search functionality, you can exclude the `web_search` tool in your `settings.json`:

```json
{
  "tools": {
    "exclude": ["web_search"]
  }
}
```

**Note:** This setting requires a restart of Qwen Code to take effect. Once disabled, the `web_search` tool will not be available to the model, even if web search providers are configured.

## Usage Examples

### Basic search (using default provider)

```
web_search(query="latest advancements in AI")
```

### Search with specific provider

```
web_search(query="latest advancements in AI", provider="tavily")
```

### Real-world examples

```
web_search(query="weather in San Francisco today")
web_search(query="latest Node.js LTS version", provider="google")
web_search(query="best practices for React 19", provider="dashscope")
```

## Provider Details

### DashScope (Official)

- **Cost:** Free
- **Authentication:** Automatically available when using Qwen OAuth authentication
- **Configuration:** No API key required, automatically added to provider list for Qwen OAuth users
- **Quota:** 200 requests/minute, 2000 requests/day
- **Best for:** General queries, always available as fallback for Qwen OAuth users
- **Auto-registration:** If you're using Qwen OAuth, DashScope is automatically added to your provider list even if you don't configure it explicitly

### Tavily

- **Cost:** Requires API key (paid service with free tier)
- **Sign up:** https://tavily.com
- **Features:** High-quality results with AI-generated answers
- **Best for:** Research, comprehensive answers with citations

### Google Custom Search

- **Cost:** Free tier available (100 queries/day)
- **Setup:**
  1. Enable Custom Search API in Google Cloud Console
  2. Create a Custom Search Engine at https://programmablesearchengine.google.com
- **Features:** Google's search quality
- **Best for:** Specific, factual queries

## Important Notes

- **Response format:** Returns a concise answer with numbered source citations
- **Citations:** Source links are appended as a numbered list: [1], [2], etc.
- **Multiple providers:** If one provider fails, manually specify another using the `provider` parameter
- **DashScope availability:** Automatically available for Qwen OAuth users, no configuration needed
- **Default provider selection:** The system automatically selects a default provider based on availability:
  1. Your explicit `default` configuration (highest priority)
  2. CLI argument `--web-search-default`
  3. First available provider by priority: Tavily > Google > DashScope

## Troubleshooting

**Tool not available?**

- **For Qwen OAuth users:** The tool is automatically registered with DashScope provider, no configuration needed
- **For other authentication types:** Ensure at least one provider (Tavily or Google) is configured
- For Tavily/Google: Verify your API keys are correct

**Provider-specific errors?**

- Use the `provider` parameter to try a different search provider
- Check your API quotas and rate limits
- Verify API keys are properly set in configuration

**Need help?**

- Check your configuration: Run `qwen` and use the settings dialog
- View your current settings in `~/.qwen-code/settings.json` (macOS/Linux) or `%USERPROFILE%\.qwen-code\settings.json` (Windows)
