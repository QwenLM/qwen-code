---
description: "Enable web search in Qwen Code. Connect MCP servers for internet access and enhance your AI coding agent with real-time information."
---

# Web Search

Qwen Code provides web search two ways:

1. **Built-in `web_search` tool** (opt-in) — backed by the DashScope Responses API server-side search. Works with a standard Bailian (DashScope) API key; no extra provider or MCP setup.
2. **MCP (Model Context Protocol) integrations** — connect any external search service (Tavily, GLM, and others). Use this when you don't have a DashScope key.

## Built-in `web_search` (opt-in)

The built-in tool issues a self-contained search request to a small auxiliary model with DashScope's server-side `web_search` (and `web_extractor`) tools, and returns the narrated findings plus source URLs. It never activates implicitly — two settings are required:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-plus",
        "envKey": "DASHSCOPE_API_KEY",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
    ]
  },
  "tools": {
    "webSearch": {
      "enabled": true,
      "model": "qwen3.6-plus"
    }
  }
}
```

| Setting                        | Env override           | Meaning                                                                                                                                                          |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.webSearch.enabled`      | `ENABLE_WEB_SEARCH`    | Opt-in flag. Required.                                                                                                                                           |
| `tools.webSearch.model`        | `WEB_SEARCH_MODEL`     | Search model selector, resolved against `modelProviders` like `fastModel` (`modelId` or `authType:modelId`). Required — no default. Recommended: `qwen3.6-plus`. |
| `tools.webSearch.webExtractor` | `WEB_SEARCH_EXTRACTOR` | Let the search agent open result pages for better-grounded answers (default `true`; billed separately by DashScope).                                             |

### Env-only configuration (no settings.json)

For environments where you cannot write a settings file (locked-down containers, CI
with env injection only), the tool can be configured entirely through environment
variables — no `modelProviders` entry needed:

```bash
export ENABLE_WEB_SEARCH=true
export WEB_SEARCH_MODEL=qwen3.6-plus
export WEB_SEARCH_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export DASHSCOPE_API_KEY=sk-...        # or set WEB_SEARCH_API_KEY instead
```

`WEB_SEARCH_BASE_URL` mirrors a `modelProviders` entry's `baseUrl` and must be a
DashScope-compatible endpoint; when it is set, it takes precedence over
`modelProviders` resolution and `WEB_SEARCH_MODEL` is used as the plain DashScope
model id. The API key is read from `WEB_SEARCH_API_KEY` if set, otherwise from
`DASHSCOPE_API_KEY`. Misconfiguration still surfaces as a startup notice.

Notes:

- The selector must resolve to a DashScope-compatible `modelProviders` entry carrying a direct API key via `envKey`. Your main model can be any provider — only the search side request needs a DashScope entry. Qwen OAuth cannot back the tool.
- If enabled but misconfigured, the tool stays off and a startup notice explains which condition failed.
- Searches bill your DashScope key (`usage.x_tools` counts). The tool asks for confirmation by default; approving with "always allow" persists a standard `WebSearch` permission rule, like other tools.
- There is no client-side model allowlist; a model the Responses endpoint does not serve fails loudly on first use.

## MCP alternatives

If you don't have a DashScope key, web search is available by connecting an external MCP server — see the services below.

## ⚠️ Historical Breaking Change: original built-in `web_search` removed

> **Affected versions:** `V0.0.7+` through the last release with the original multi-provider built-in web search.

The original built-in `web_search` tool (Tavily/Google/GLM/DashScope multi-provider) and its configuration were **removed**. The new opt-in built-in tool above is a different implementation with different configuration. If you were using any of the following, migrate either to the new built-in tool (DashScope) or to MCP:

| Removed                                                                | What to do                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `webSearch` block in `settings.json`                                   | Configure an MCP server in `mcpServers` instead (see below)       |
| `advanced.tavilyApiKey` in `settings.json`                             | Use the [Tavily MCP server](#tavily-websearch)                    |
| `TAVILY_API_KEY` environment variable                                  | Use the [Tavily MCP server](#tavily-websearch)                    |
| `DASHSCOPE_API_KEY` for web search                                     | Use the [built-in `web_search` tool](#built-in-web_search-opt-in) |
| `GLM_API_KEY` for web search                                           | Use the [GLM WebSearch Prime MCP](#glm-websearch-prime-zhipuai)   |
| `--tavily-api-key` / `--glm-api-key` / `--dashscope-api-key` CLI flags | Configure via `mcpServers` in `settings.json`                     |

### Migration Examples

**Before (Tavily via built-in tool):**

```json
{
  "webSearch": {
    "provider": [{ "type": "tavily", "apiKey": "tvly-xxx" }],
    "default": "tavily"
  }
}
```

**After (Tavily via MCP):**

```json
{
  "mcpServers": {
    "tavily": {
      "httpUrl": "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-xxx"
    }
  }
}
```

---

**Before (DashScope via built-in tool):**

```json
{
  "webSearch": {
    "provider": [{ "type": "dashscope", "apiKey": "sk-xxx" }],
    "default": "dashscope"
  }
}
```

**After (Alibaba Cloud Bailian WebSearch via MCP):**

```json
{
  "mcpServers": {
    "WebSearch": {
      "httpUrl": "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
      "headers": {
        "Authorization": "Bearer sk-xxx"
      }
    }
  }
}
```

---

## Supported MCP Web Search Services

### Alibaba Cloud Bailian WebSearch

The official web search MCP service provided by Alibaba Cloud Bailian platform, powered by DashScope. If you have a DashScope key, prefer the built-in `web_search` tool above — it uses a stronger search path than this MCP service.

- **MCP Marketplace:** https://bailian.console.aliyun.com/cn-beijing?tab=mcp#/mcp-market/detail/WebSearch
- **Cost:** Paid (billed via Alibaba Cloud DashScope)
- **Get API Key:** https://help.aliyun.com/zh/model-studio/get-api-key
- **Best for:** Chinese-language queries, access to Chinese web content, integration with the Alibaba Cloud ecosystem

#### Setup

**Method 1: CLI command**

```bash
qwen mcp add WebSearch \
  -t http \
  "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp" \
  -H "Authorization: Bearer ${DASHSCOPE_API_KEY}"
```

**Method 2: `settings.json`**

```json
{
  "mcpServers": {
    "WebSearch": {
      "httpUrl": "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
      "headers": {
        "Authorization": "Bearer ${DASHSCOPE_API_KEY}"
      }
    }
  }
}
```

Replace `${DASHSCOPE_API_KEY}` with your actual API key, or set it as an environment variable so Qwen Code picks it up automatically.

---

### Tavily WebSearch

A production-ready MCP server providing real-time web search, extract, map, and crawl capabilities.

- **Repository:** https://github.com/tavily-ai/tavily-mcp
- **Cost:** Paid (free tier available)
- **Get API Key:** https://app.tavily.com/home
- **Best for:** General-purpose web search with high-quality AI-generated answers

#### Available Tools

- `tavily_search` — Real-time web search
- `tavily_extract` — Intelligent data extraction from web pages
- `tavily_map` — Create a structured map of a website
- `tavily_crawl` — Systematically explore websites

#### Setup

**Method 1: CLI command (Remote MCP)**

```bash
qwen mcp add tavily \
  -t http \
  "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
```

**Method 2: `settings.json` (Remote MCP)**

```json
{
  "mcpServers": {
    "tavily": {
      "httpUrl": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
    }
  }
}
```

Replace `${TAVILY_API_KEY}` with your actual API key, or set it as an environment variable.

**Method 3: `settings.json` (Local NPX)**

```json
{
  "mcpServers": {
    "tavily-mcp": {
      "command": "npx",
      "args": ["-y", "tavily-mcp@latest"],
      "env": {
        "TAVILY_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

### GLM WebSearch Prime (ZhipuAI)

The official web search Remote MCP service provided by ZhipuAI (智谱AI), designed for GLM Coding Plan users. Provides real-time web search including news, stock prices, weather, and more.

- **Documentation:** https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server
- **Cost:** Included in GLM Coding Plan subscription (Lite: 100 calls/month, Pro: 1,000/month, Max: 4,000/month)
- **Get API Key:** https://open.bigmodel.cn/apikey/platform
- **Best for:** Chinese-language queries, real-time information retrieval

#### Available Tools

- `webSearchPrime` — Web search returning page title, URL, summary, site name, and favicon

#### Setup

**Method 1: CLI command**

```bash
qwen mcp add web-search-prime \
  -t http \
  "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp" \
  -H "Authorization: Bearer ${GLM_API_KEY}"
```

**Method 2: `settings.json`**

```json
{
  "mcpServers": {
    "web-search-prime": {
      "httpUrl": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "headers": {
        "Authorization": "Bearer ${GLM_API_KEY}"
      }
    }
  }
}
```

Replace `${GLM_API_KEY}` with your actual ZhipuAI API key, or set it as an environment variable.

---
