# Subscription MCP web search

[English](subscription-mcp-web-search.md) | [简体中文](subscription-mcp-web-search.zh-CN.md)

## Problem and scope

Subscription inference works, but built-in `web_search` only supports DashScope credentials. The staging subscription service exposes MCP at `https://pre-api.qwen.ai/api/v1/mcp/web_search`, authenticated with the existing device access token. Integrate this service through the shared Core tool so CLI, VS Code and Desktop use the same behavior.

## Protocol evidence

The real SDK probe completed `initialize` (200), `notifications/initialized` (204), `tools/list` (200), and `tools/call` (200) at the complete URL. Server `qwen-web-search` 0.1.0 exposes `web_search`: required `query` string, 1–500 characters; optional `num` (1–20, default 10), `country`, `locale`, and `location`. A public query returned text blocks containing numbered results, URLs and summaries; no structured sources or MCP session ID was returned. Evidence is in `.qwen/e2e-tests/subscription-mcp-protocol.json`.

## Proposed implementation

Add a subscription variant to `WebSearchBackendConfig` and a small backend using the existing MCP SDK Streamable HTTP transport. Each search creates its own client, initializes, discovers `web_search`, calls it with `query`, and closes in `finally`. Preserve the service default result count. Join returned text blocks; extract only returned HTTP(S) links as unopened sources, leaving citation rules, output truncation, permissions and per-session usage limits to the existing tool. Reject queries above 500 characters and unsupported/error responses with safe error text.

For automatic search configuration, select this backend only when the active auth type is `qwen-subscription` in development. Explicit disabling or explicit alternate search model/endpoint configuration retains its existing meaning. Synchronize registration after successful auth changes, including an already initialized session; preserve bare, safe, managed-runtime, subagent and permission boundaries.

Every HTTP request obtains its token through `QwenSubscriptionSession.getAccessToken`. Pin the exact URL, reject redirects, use existing runtime proxy/session fetch options, combine caller cancellation with a total search deadline, and refresh once on HTTP 401. Do not store tokens in settings or expose raw authentication/transport errors. Short-lived clients avoid shared MCP pool and cross-workspace transport state.

## Boundaries and validation

Do not inject `mcpServers`, replace user MCP entries, change general MCP transport/pool behavior, add model-side search configuration knobs, or change DashScope search. A user-configured MCP server remains independent from the built-in tool.

Validate gate precedence and auth hot-switch registration, real SDK protocol/result mapping, dynamic tokens/401, cancellation/timeout, error redaction, exact destination/no redirects, and existing DashScope regressions. Finish with full build/typecheck/bundle and a real model-driven built-in search using the subscription model. Acceptance requires actual search results and source links, not merely a successful MCP connection. Native GUI behavior is claimed only if separately exercised. Verification passed: 1,090 focused tests, full build/typecheck/bundle, targeted lint/format and a real bundled CLI run. The member model discovered and invoked built-in search, received results, and cited the official repository. Search tools/call returned HTTP 200 with request ID `411b17f2-5d4e-406c-ba26-ad4918ff16a9`. The background memory extractor separately returned HTTP 405 after the successful conversation; native GUI search was not exercised. Details are in the E2E report.
