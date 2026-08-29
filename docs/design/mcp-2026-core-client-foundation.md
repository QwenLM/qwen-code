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

This slice of #8968 migrates configured MCP sessions to the v2 client, adds
opt-in automatic protocol negotiation for stdio sessions, and adds the first
MCP Apps host for daemon-backed WebShell sessions. Tool, prompt, resource-list,
and resource-read operations use the v2 cache-aware helpers when the negotiated
protocol is modern.

Remote HTTP / SSE / TCP clients stay on `versionNegotiation.mode = 'legacy'`.
SDK v2 rejects HTTP `server/discover` probe timeouts with no `initialize`
fallback, so auto-negotiation would drop working remote servers that ignore
unknown pre-initialize methods. Connecting to a 2026-07-28-only remote server
is deferred until that SDK gap closes.

The following remain separate follow-ups:

- modern-only remote (HTTP / SSE / TCP) protocol negotiation;
- interactive MRTR elicitation and approval across TUI, WebShell, headless, and
  ACP;
- MCP App initiated tool calls, links, downloads, messages, model-context
  updates, and fullscreen display;
- migration of Qwen Code's internal IDE, Computer Use, and embedded MCP server
  integrations, which are not configured external MCP sessions.

## Design

Configured stdio MCP clients default to `versionNegotiation.mode = 'legacy'`.
Setting `versionNegotiation: "auto"` opts a server into a `server/discover`
probe capped at 5s, and further shortened so the probe plus initialize fallback
still fit inside `discoveryTimeoutMs` (the discovery window clamp is
`[100ms, 300s]`; a budget that cannot cover both steps skips the probe and uses
`legacy`). Definitive modern evidence selects the stateless `2026-07-28`
protocol; legacy evidence — including a silent stdio server that never answers
the probe — falls back to the unchanged `initialize` flow.

The SDK performs opt-in stdio auto-negotiation on a disposable sibling process
before starting the session process, so the configured command runs twice per
connection. The default legacy policy skips the probe and retains the
single-process initialize flow for servers with non-idempotent startup side
effects or single-owner resources such as lockfiles.

Remote HTTP / SSE / TCP clients use `versionNegotiation.mode = 'legacy'` and
never send `server/discover`.

Modern sessions use the typed v2 list/read methods so the SDK can aggregate
pagination and honor `ttlMs` and `cacheScope`. Legacy sessions keep Qwen Code's
raw request path for prompts and resources because it intentionally tolerates
older servers that expose methods without declaring the matching capability.

Tool discovery uses the single cache-aware `tools/list` result for both schema
registration and annotations. Tool execution continues through the raw client
so progress, cancellation, timeout, permission checks, and output handling stay
inside the existing Qwen Code path.

Configured clients advertise the `io.modelcontextprotocol/ui` extension and
the `text/html;profile=mcp-app` resource type. When a server also advertises
that extension, tool discovery preserves its `ui://` resource URI. After a
successful call, Qwen Code reads and validates the matching HTML resource and
stores it in a structured display result while leaving the model-visible result
unchanged. A missing, oversized, malformed, or unreadable resource falls back
to the normal text result.

The daemon serves a static sandbox proxy before bearer authentication. It
contains no session data or credentials. WebShell loads that proxy in an
outer iframe that omits `allow-same-origin`, so even a same-URL `localhost`
load is an opaque origin and cannot read WebShell `sessionStorage`. When the
daemon is already on `127.0.0.1` or `[::1]`, the host also swaps onto
`localhost` for a second loopback origin. AppBridge and postMessage deliver
the validated HTML, tool input, and tool result to an inner sandboxed iframe.
The proxy validates parent and child origins, applies resource CSP as an HTTP
response header, and forwards AppBridge postMessage traffic between the two
frames. The host AppBridge schema-validates inbound messages; the proxy itself
does not filter payload shape. The inner App iframe also omits
`allow-same-origin`, giving untrusted HTML an opaque origin that cannot call
the daemon's loopback API as a same-origin client. The first host slice does
not advertise privileged App capabilities.

## Compatibility and safety

- No configured server is pinned to the modern protocol.
- Configured stdio servers use the single-process legacy flow by default and
  can opt into the extra negotiation process with `versionNegotiation: "auto"`.
- Legacy fallback remains the SDK's byte-compatible v1 sequence.
- Authorization and Qwen Code's MCP permission boundary are unchanged.
- The modern cache is private per client instance; no result is shared across
  workspaces or authorization principals.
- MCP App HTML is limited to 1 MiB and never enters model context.
- App HTML runs in a double-iframe sandbox. Both frames omit
  `allow-same-origin`, and the outer frame additionally uses a different
  loopback origin when one is available. Server-declared CSP is enforced by
  the daemon response.
- If the isolation origin is unavailable, WebShell displays the ordinary tool
  text rather than rendering the App.
- Compacted session history keeps `type: 'mcp_app'` with empty `html` and the
  original `fallbackText`; WebShell renders that text instead of mounting an
  empty sandbox.
- The host sends `ui/resource-teardown` and waits for it to settle before
  unloading the sandbox iframe.

## Verification

- A modern-only control transport must connect through `server/discover`, list
  and call a tool without `initialize`, and carry the modern request metadata.
- A real Streamable HTTP transport uses the legacy `initialize` handshake and
  must still send the protocol and method headers, plus the tool name header
  on `tools/call`. Modern-only remote negotiation is out of scope.
- A legacy control transport must fall back to `initialize` and retain existing
  discovery and call behavior.
- A cache-hinted modern list result must be reused without a second wire
  request.
- A mock stdio MCP server must advertise the Apps extension, return a `ui://`
  dashboard resource, and render that dashboard inside an actual daemon-backed
  WebShell transcript. The PR description includes the external test fixture
  used for this verification without shipping it in the product repository.
- Compacted replay of an App result must show fallback text and must not mount
  a sandbox iframe.
- Invalid App resource MIME types and unavailable resources must retain the
  ordinary text result.
- The sandbox route must reject CSP directive injection and remain a static,
  no-store pre-auth resource.
- Existing MCP client, transport-pool, tool, OAuth, and resource tests must
  continue to pass, followed by the repository build and typecheck.

## Demo

The external stdio demo used for verification advertises one
`show_revenue_dashboard` tool and its `ui://revenue-dashboard` resource. Its
reference implementation and daemon configuration are included in the PR
description.
