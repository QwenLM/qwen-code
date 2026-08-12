# MCP 2026 core client foundation

## Context

Qwen Code's configured MCP sessions currently use the v1 TypeScript SDK. A
server that only implements the MCP `2026-07-28` stateless protocol cannot
complete the legacy `initialize` handshake, while unconditionally switching to
the modern protocol would break existing servers.

The official TypeScript SDK v2 already owns the wire-level compatibility
logic: `server/discover` negotiation, legacy fallback, per-request metadata and
HTTP headers, pagination, and cache-hint handling. Qwen Code should configure
that behavior rather than duplicate it.

## Scope

This first slice of #8968 migrates configured MCP sessions to the v2 client and
opts them into automatic protocol negotiation. It also routes tool, prompt,
resource-list, and resource-read operations through the v2 cache-aware helpers
when the negotiated protocol is modern.

The following remain separate follow-ups:

- interactive MRTR elicitation and approval across TUI, WebShell, headless, and
  ACP;
- the MCP Apps capability, `ui://` resource host, AppBridge, lifecycle, and
  security boundary;
- migration of Qwen Code's internal IDE, Computer Use, and embedded MCP server
  integrations, which are not configured external MCP sessions.

## Design

Each configured MCP client uses SDK v2 with `versionNegotiation.mode = 'auto'`.
The SDK sends `server/discover` first. Definitive modern evidence selects the
stateless `2026-07-28` protocol; legacy evidence falls back to the unchanged
`initialize` flow.

Modern sessions use the typed v2 list/read methods so the SDK can aggregate
pagination and honor `ttlMs` and `cacheScope`. Legacy sessions keep Qwen Code's
raw request path for prompts and resources because it intentionally tolerates
older servers that expose methods without declaring the matching capability.

Tool discovery uses the single cache-aware `tools/list` result for both schema
registration and annotations. Tool execution continues through the raw client
so progress, cancellation, timeout, permission checks, and output handling stay
inside the existing Qwen Code path.

## Compatibility and safety

- No configured server is pinned to the modern protocol.
- Legacy fallback remains the SDK's byte-compatible v1 sequence.
- Authorization and Qwen Code's MCP permission boundary are unchanged.
- The modern cache is private per client instance; no result is shared across
  workspaces or authorization principals.
- This slice does not render remote HTML or add a new tool execution path.

## Verification

- A modern-only control transport must connect through `server/discover`, list
  and call a tool without `initialize`, and carry the modern request metadata.
- A real Streamable HTTP transport must send the negotiated protocol and method
  headers, plus the tool name header on `tools/call`.
- A legacy control transport must fall back to `initialize` and retain existing
  discovery and call behavior.
- A cache-hinted modern list result must be reused without a second wire
  request.
- Existing MCP client, transport-pool, tool, OAuth, and resource tests must
  continue to pass, followed by the core build and typecheck.
