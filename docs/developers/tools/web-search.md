# Web Search

Qwen Code supports web search capabilities through **MCP (Model Context Protocol)** integrations. Rather than a built-in search tool, web search is provided by connecting to external MCP servers, giving you full flexibility to choose the search service that best fits your needs.

## ⚠️ Breaking Change: Built-in `web_search` Tool Removed

> **Affected versions:** `V0.0.7+` through the last release with built-in web search support.

The built-in `web_search` tool and all its associated configuration have been **removed**. If you were using any of the following, you should migrate to the MCP-based approach described in this document:

| Removed                                                                | What to do                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `webSearch` block in `settings.json`                                   | Configure an MCP server in `mcpServers` instead (see below)                                 |
| `advanced.tavilyApiKey` in `settings.json`                             | Use the [Tavily MCP server](#tavily-websearch)                                              |
| `TAVILY_API_KEY` environment variable                                  | Use the [Tavily MCP server](#tavily-websearch)                                              |
| `DASHSCOPE_API_KEY` for web search                                     | Use the [Alibaba Cloud Bailian WebSearch MCP](#alibaba-cloud-bailian-websearch-recommended) |
| `GLM_API_KEY` for web search                                           | Use the [GLM WebSearch Prime MCP](#glm-websearch-prime-zhipuai)                             |
| `--tavily-api-key` / `--glm-api-key` / `--dashscope-api-key` CLI flags | Configure via `mcpServers` in `settings.json`                                               |

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

### Alibaba Cloud Bailian WebSearch (Recommended)

The official web search MCP service provided by Alibaba Cloud Bailian platform, powered by DashScope.

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
