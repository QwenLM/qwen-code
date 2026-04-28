# Web Fetch Tool (`web_fetch`)

This document describes the `web_fetch` tool for Qwen Code.

## Description

Use `web_fetch` to fetch content from a specified URL and process it using an AI model. The tool takes a URL and a prompt as input, fetches the URL content, and processes the content with the prompt using a small, fast model.

### Arguments

`web_fetch` takes three arguments:

- `url` (string, required): The URL to fetch content from. Must be a fully-formed valid URL starting with `http://` or `https://`.
- `prompt` (string, required): The prompt describing what information you want to extract from the page content.
- `format` (string, optional): Controls only the `Accept` header sent to the server, indicating your content preference. **All fetched content is normalized to plain text for LLM processing**, regardless of the format specified. Defaults to `"auto"` if not specified.
  - `"auto"` (default): Prefers markdown via content negotiation (`Accept: text/markdown, text/html`), accepts HTML as fallback. **Recommended for most use cases** as it can reduce token usage by up to 80% for servers that support markdown.
  - `"markdown"`: Sends `Accept: text/markdown`. Use when you explicitly need markdown content.
  - `"html"`: Sends `Accept: text/html`. Use when the server requires HTML in the Accept header. Content is still converted to plain text for LLM processing.
  - `"text"`: Sends `Accept: text/plain`. Use when you specifically need plain text content.

## How to use `web_fetch` with Qwen Code

To use `web_fetch` with Qwen Code, provide a URL and a prompt describing what you want to extract from that URL. The tool will ask for confirmation before fetching the URL. Once confirmed, the tool will fetch the content directly and process it using an AI model.

The tool automatically:

- Converts HTML to text when necessary
- Handles GitHub blob URLs (converting them to raw URLs)
- Upgrades HTTP URLs to HTTPS for security
- Supports content negotiation for markdown (reduces token usage significantly)

Usage:

```
web_fetch(url="https://example.com", prompt="Summarize the main points of this article")
```

With format specification:

```
web_fetch(url="https://example.com", prompt="Get the raw content", format="markdown")
```

## `web_fetch` examples

Summarize a single article:

```
web_fetch(url="https://example.com/news/latest", prompt="Can you summarize the main points of this article?")
```

Extract specific information:

```
web_fetch(url="https://arxiv.org/abs/2401.0001", prompt="What are the key findings and methodology described in this paper?")
```

Analyze GitHub documentation:

```
web_fetch(url="https://github.com/QwenLM/Qwen/blob/main/README.md", prompt="What are the installation steps and main features?")
```

Get markdown content (for servers supporting Markdown for Agents):

```
web_fetch(url="https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/", prompt="Extract the key information", format="markdown")
```

## Important notes

- **Single URL processing:** `web_fetch` processes one URL at a time. To analyze multiple URLs, make separate calls to the tool.
- **URL format:** The tool automatically upgrades HTTP URLs to HTTPS and converts GitHub blob URLs to raw format for better content access.
- **Content negotiation:** The tool supports "Markdown for Agents" content negotiation. When using `format="auto"` (default), it sends `Accept: text/markdown, text/html` headers, allowing servers that support markdown to return it directly instead of HTML. This can reduce token usage by up to 80%.
- **Content processing:** The tool fetches content directly and processes it using an AI model. When the server returns HTML, it converts it to readable text format. When the server returns markdown or plain text, it uses the content as-is.
- **Output quality:** The quality of the output will depend on the clarity of the instructions in the prompt.
- **Model routing:** The content-processing LLM call uses the configured [`fastModel`](../../users/configuration/settings.md#fastmodel) when available, falling back to the main session model. Because the work is a compression/extraction task rather than deep reasoning, routing through a smaller model reduces latency and cost when `fastModel` is configured.
- **MCP tools:** If an MCP-provided web fetch tool is available (starting with "mcp\_\_"), prefer using that tool as it may have fewer restrictions.

## Markdown for Agents Support

Qwen Code's `web_fetch` tool implements support for [Cloudflare's Markdown for Agents](https://blog.cloudflare.com/markdown-for-agents/) specification. This feature allows websites to serve markdown content directly to AI agents, significantly reducing token usage compared to parsing HTML.

### How it works

1. The `format` parameter controls **only** the `Accept` header sent to the server (it does not affect the output format):
   - `format="auto"`: sends `Accept: text/markdown, text/html`
   - `format="markdown"`: sends `Accept: text/markdown`
   - `format="html"`: sends `Accept: text/html`
   - `format="text"`: sends `Accept: text/plain`
2. If the server supports markdown, it returns `Content-Type: text/markdown`
3. The tool uses markdown or plain text content directly without conversion
4. If the server returns HTML, it converts to readable text format for LLM processing
5. All content is normalized to text before being processed by the AI model

### Benefits

- **Token efficiency:** Markdown content typically uses 80% fewer tokens than equivalent HTML
- **Better structure:** Markdown preserves semantic structure (headings, lists, etc.)
- **Backward compatible:** Works with all websites, enhanced experience for supporting servers

### Example servers supporting markdown

- Cloudflare Developer Documentation
- Cloudflare Blog
- Any website using Cloudflare's "Markdown for Agents" feature
