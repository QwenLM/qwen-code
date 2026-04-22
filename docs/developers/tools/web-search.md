# Web Search Tool (`web_search`)

This document describes the `web_search` tool for performing web searches using multiple providers.

## Description

Use `web_search` to perform a web search and get information from the internet. The tool supports multiple search providers and returns a concise answer with source citations when available.

### Supported Providers

1. **DashScope** (Official) - Available when explicitly configured in settings
2. **Tavily** - High-quality search API with built-in answer generation
3. **Google Custom Search** - Google's Custom Search JSON API
4. **GLM (ZhipuAI)** - ZhipuAI Web Search API with multiple engine options

### Arguments

`web_search` takes two arguments:

- `query` (string, required): The search query
- `provider` (string, optional): Specific provider to use ("dashscope", "tavily", "google", "glm")
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
      },
      {
        "type": "glm",
        "apiKey": "your-zhipuai-api-key",
        "searchEngine": "search_std"
      }
    ],
    "default": "dashscope"
  }
}
```

**Notes:**

- DashScope web search currently requires qwen-oauth credentials; it must be explicitly listed in `webSearch.provider` to be used
- Configure additional providers (Tavily, Google, GLM) if you want alternatives
- Set `default` to specify which provider to use by default (if not set, priority order: Tavily > Google > GLM > DashScope)

### Method 2: Environment Variables

Set environment variables in your shell or `.env` file:

```bash
# Tavily
export TAVILY_API_KEY="tvly-xxxxx"

# Google
export GOOGLE_API_KEY="your-api-key"
export GOOGLE_SEARCH_ENGINE_ID="your-engine-id"

# GLM (ZhipuAI)
export GLM_API_KEY="your-zhipuai-api-key"
```

### Method 3: Command Line Arguments

Pass API keys when running Qwen Code:

```bash
# Tavily
qwen --tavily-api-key tvly-xxxxx

# Google
qwen --google-api-key your-key --google-search-engine-id your-id

# GLM (ZhipuAI)
qwen --glm-api-key your-zhipuai-api-key

# Specify default provider
qwen --web-search-default glm
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

- **Cost:** Paid
- **Configuration:** Must be explicitly configured in `settings.json` web search providers
- **Rate limit:** 15 RPS (shared across all API keys under the same Aliyun account)
- **Best for:** General queries

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

### GLM (ZhipuAI)

- **Cost:** Paid (see https://bigmodel.cn for pricing)
- **Sign up:** https://bigmodel.cn
- **Configuration:**
  ```json
  {
    "type": "glm",
    "apiKey": "your-zhipuai-api-key",
    "searchEngine": "search_std",
    "maxResults": 10,
    "searchRecencyFilter": "noLimit",
    "contentSize": "medium"
  }
  ```
- **Search engines:** `search_std` (standard), `search_pro` (advanced), `search_pro_sogou` (Sogou), `search_pro_quark` (Quark)
- **Features:** Intent recognition, multi-engine support, recency filter, domain whitelist
- **Best for:** Chinese-language queries, access to Chinese web content
- **Server-side limitations (informational):**
  - `maxResults` (`count`) is not strictly honored by `search_std`/`search_pro` engines — the server currently returns a fixed number of results regardless of the requested count
  - `searchDomainFilter` is treated as a hint (whitelist), not a hard constraint — results from outside the specified domains may still appear

## Important Notes

- **Response format:** Returns a concise answer with numbered source citations
- **Citations:** Source links are appended as a numbered list: [1], [2], etc.
- **Multiple providers:** If one provider fails, manually specify another using the `provider` parameter
- **Default provider selection:** The system automatically selects a default provider based on availability:
  1. Your explicit `default` configuration (highest priority)
  2. CLI argument `--web-search-default`
  3. First available provider by priority: Tavily > Google > GLM > DashScope

## Troubleshooting

**Tool not available?**

- Ensure at least one provider (DashScope, Tavily, Google, or GLM) is configured in `settings.json`
- For Tavily/Google/GLM: Verify your API keys are correct

**Provider-specific errors?**

- Use the `provider` parameter to try a different search provider
- Check your API quotas and rate limits
- Verify API keys are properly set in configuration

**Need help?**

- Check your configuration: Run `qwen` and use the settings dialog
- View your current settings in `~/.qwen-code/settings.json` (macOS/Linux) or `%USERPROFILE%\.qwen-code\settings.json` (Windows)
