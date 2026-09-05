# Routify `session_id` Header

## Summary

Qwen Code attaches its current session ID as the `session_id` HTTP header only when the outbound LLM request hostname is one of the three Routify endpoints documented by ModelRouter: `routify.alibaba-inc.com`, `routify-online.alibaba-inc.com`, or `routify-pub.alibaba-inc.com`.

The behavior is intentionally not configurable. Qwen Code does not attach the header to subdomains, other `alibaba-inc.com` hosts, or non-Routify providers. Standard fetch redirect behavior applies after the initial destination check, so a Routify response can forward the header by redirecting the request.

## Motivation

Routify's ModelRouter accepts `session_id` as a session-affinity and traffic-marking value. Qwen Code already maintains a session ID, but it is currently local metadata and never reaches the ModelRouter request. Reusing it gives Routify one stable affinity value per CLI session without creating another identifier.

## Security boundary

A session ID is a stable cross-request identifier. The implementation therefore requires HTTPS and compares the parsed request hostname to a fixed set of three ModelRouter hostnames. It does not use suffix matching, wildcards, path matching, or a user-configurable allowlist. Invalid URLs fail closed.

The Qwen Code session ID replaces any custom `session_id` value on an eligible request so the affinity marker cannot disagree with the active session. All other existing headers, including authorization, are preserved.

## Request lifecycle

OpenAI-compatible and Anthropic clients receive a fetch wrapper. The wrapper reads `Config.getSessionId()` immediately before each HTTP request. This matters because `/clear` starts a new session without rebuilding the SDK client.

Gemini requests use the SDK's request-level `httpOptions.headers`. The header is rebuilt for generate, streaming generate, and embedding requests. Gemini injection requires an explicit Routify `baseUrl`; implicit SDK endpoints remain unchanged.

## Provider coverage

- The default OpenAI-compatible provider covers Routify's OpenAI protocol and subclasses that inherit its client construction.
- DashScope has a separate client constructor and is integrated explicitly.
- Anthropic uses the same per-request fetch wrapper.
- Gemini and Vertex use request-level HTTP options when the base URL points to Routify.

Non-LLM traffic, other domains, MCP requests, tool fetches, subprocesses, `traceparent`, request IDs, and body metadata are out of scope.

## Verification

Unit tests cover exact-host and HTTPS matching, rejection of lookalike hosts, invalid URLs, preservation and precedence of combined `Request` and init headers, empty values, session rotation, and the shared runtime-fetch wrapper. Provider tests verify the OpenAI-compatible construction paths install a working correlation layer, and Gemini tests cover constructor destinations, generation, embedding, and successive requests observing a changed session ID.
