# Web Search Tool (`web_search`)

This document describes the `web_search` tool.

## Description

Use `web_search` to perform a web search using the Tavily API. The tool returns a concise answer with sources when possible.

### Arguments

`web_search` takes one argument:

- `query` (string, required): The search query.

## How to use `web_search`

`web_search` calls the Tavily API directly. You must configure the `TAVILY_API_KEY` through one of the following methods:

1. **Settings file**: Add `"tavilyApiKey": "your-key-here"` to your `settings.json`
2. **Environment variable**: Set `TAVILY_API_KEY` in your environment or `.env` file
3. **Command line**: Use `--tavily-api-key your-key-here` when running the CLI

If the key is not configured, the tool will be disabled and skipped.

Usage:

```
web_search(query="Your query goes here.")
```

## `web_search` examples

Get information on a topic:

```
web_search(query="latest advancements in AI-powered code generation")
```

## Important notes

- **Response returned:** The `web_search` tool returns a concise answer when available, with a list of source links.
- **Citations:** Source links are appended as a numbered list.
- **API key:** Configure `TAVILY_API_KEY` via settings.json, environment variables, .env files, or command line arguments. If not configured, the tool is not registered.
