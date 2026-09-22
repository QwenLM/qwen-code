# MCP 2026 core client foundation

[English](mcp-2026-core-client-foundation.md) | [简体中文](mcp-2026-core-client-foundation.zh-CN.md)

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
- links, downloads, messages, model-context
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
unchanged. A missing, oversized, malformed, or unreadable resource still
produces an `mcp_app` display with empty `html`, whose `fallbackText` leads
with `Warning: MCP App '<uri>' from '<server>' could not be displayed:
<reason>` ahead of the normal tool text; the model-visible result stays the
plain tool text.

For larger or slower Apps such as Amplitude (#11945), a server can set
`appResourceMaxBytes` and `appResourceTimeoutMs` in `mcpServers`. The HTML
limit defaults to 1 MiB and is clamped to 1 byte–4 MiB. The resource deadline
defaults to the smaller of the general MCP timeout and 10 seconds; an explicit
App timeout replaces that deadline and is clamped to 100–120,000 ms. Finite
values are rounded down; nonnumeric or nonfinite values use the defaults.
The SDK request and abort signal use the same deadline, and caller cancellation
still aborts the read. Limit failures identify the relevant setting in the
existing display warning without changing the successful tool result.

SDK initialization and daemon settings read/write preserve both resource-limit
fields, including finite values that the core later rounds and clamps.
These settings travel with discovered tools through metadata enrichment,
qualified names, per-session projections, and reconnect retries. They are part
of the pool fingerprint so sessions with different resource policies cannot
reuse the first session's limits. Existing settings reconciliation detects the
changed configuration. The resource-limit settings themselves add no daemon
route or sandbox capability.

The 4 MiB ceiling provides headroom for bundled applications while leaving room
under the existing 32 MiB transcript/replay limit even with JSON escaping (up to
six bytes per HTML byte). The 120-second ceiling limits optional UI latency.
These are host policy choices, not protocol limits or a guarantee of Amplitude
compatibility. The SDK materializes the response before the size check, so the
limit bounds accepted/retained HTML, not network transfer or peak memory.

A retained App document crosses several budgets tighter than that envelope, in
different units: the WebShell historical-page budget (16 MiB, estimated as
UTF-16 code units times two — a page holding two ceiling-size documents no
longer fits); the daemon's 4 MiB compacted replay window, which one
ceiling-size document fills by construction; the 2 MiB EventBus per-subscriber
live-frame budget; and the 32 MiB restore-page limit measured on the
JSON-serialized stream. Historical-page admission therefore degrades per
document rather than failing per page: when a materialized page exceeds its
budget, the page table drops each MCP App display's `html` whole (replay
mounts the iframe only for non-empty `html` and never re-fetches the resource)
and the turn stays navigable on `fallbackText`; only a page with nothing left
to degrade fails closed. Larger accepted documents increase transcript and
replay payloads. Streaming transfer limits remain outside this change. App-initiated server
tool calls are specified in [MCP App server tool calls](mcp-app-server-tools.md).

For live delivery, an empty subscriber queue admits the original App under the
existing oversized-first-frame rule. Only a nonempty backlog that would overflow
the byte budget retries with whole HTML removed, and only when nonempty text
fallback is available. Direct delivery and the replay ring retain the original
App; the degraded queued copy keeps the same event ID. Successful degradation
does not evict the subscriber or request resync. If fallback cannot fit, normal
eviction applies; frame count limits and forced replay delivery are unchanged.

Compacted replay first removes HTML from older App segments, then evicts older
segments. It removes the newest App's HTML only if the retained replay still
exceeds its budget, preserving that App when evicting old text is sufficient.

The daemon's unauthenticated `/mcp-app-sandbox` route defaults to an uncached
redirect to a dedicated static-only listener bound to `127.0.0.1` on a random
port. Each render receives a fresh `<uuid>.localhost` origin. The listener
serves only the registered Host, GET method and resource path, deletes the
registration before its sole successful response, and provides no daemon API
or WebSocket endpoint. The registration pins the validated host origin and
resource CSP; query parameters cannot replace that policy.

Both iframe layers grant `allow-same-origin`. The App and its proxy share the
per-render origin and can access each other's DOM and origin-scoped storage;
they are one trust boundary. They share no origin with WebShell, the daemon or
another App, so they cannot read WebShell `sessionStorage` or call daemon APIs
as same-origin clients. `Origin-Agent-Cluster: ?1` prevents `document.domain`
from relaxing the per-render origin boundary. The HTTP response enforces `sandbox allow-scripts allow-forms allow-same-origin`
in CSP, so editing iframe attributes cannot remove restrictions on top
navigation, popups and other ungranted capabilities. An unreachable isolated
origin falls back through the daemon connection to a response with opaque
CSP sandboxing (without `allow-same-origin`); see the linked App design.

AppBridge and postMessage deliver HTML, tool input and tool results to the
inner iframe. The proxy validates parent and child origins, applies resource
CSP as an HTTP response header, and forwards messages. The host AppBridge
schema-validates inbound messages; the proxy does not filter payload shape.
A bound daemon session advertises scoped App server-tool calls under the
existing permission policy. See [MCP App server tool calls](mcp-app-server-tools.md)
for the origin lifecycle, capability boundary and validation limits.

## Compatibility and safety

- No configured server is pinned to the modern protocol.
- Configured stdio servers use the single-process legacy flow by default and
  can opt into the extra negotiation process with `versionNegotiation: "auto"`.
- Legacy fallback remains the SDK's byte-compatible v1 sequence.
- Authorization and Qwen Code's MCP permission boundary are unchanged.
- The modern cache is private per client instance; no result is shared across
  workspaces or authorization principals.
- MCP App HTML defaults to a 1 MiB limit, can be configured up to 4 MiB per
  server, and never enters model context.
- App HTML runs in a double-iframe sandbox with `allow-same-origin` on both
  frames. Isolation uses a fresh per-render origin on a dedicated static-only
  loopback listener, one-use registration and `Origin-Agent-Cluster: ?1`.
  The isolated response enforces server-declared resource CSP.
- If the isolation origin is unavailable, WebShell displays the ordinary tool
  text rather than rendering the App.
- Compaction splits by purpose. Terminal (interactive) history keeps
  `type: 'mcp_app'` with empty `html` and the original `fallbackText`, and the
  TUI renders that text instead of mounting an empty sandbox. A recorded
  transcript keeps the App `html` within its configured resource limit so WebShell
  replay can mount the app, and keeps `toolResult` only while its serialized
  form fits the retained-display budget (32 KiB); above it the field is dropped
  rather than truncated. Retained `html` reaches replay `rawOutput` and the
  resumed display only, never model context. A fully compliant resource of
  256 KiB or more crosses the daemon's large-pipe-frame threshold on replay —
  that is the intended cost of rendering Apps from a transcript.
- The host sends `ui/resource-teardown` and waits for it to settle before
  unloading the sandbox iframe.

## Verification

- A 1,048,577-byte valid App must fail under defaults and render with an explicit
  2 MiB allowance, including text and base64 resource encodings.
- An 11-second resource read must fail under defaults and succeed with a
  30-second App deadline; a longer general MCP timeout alone retains the old
  10-second ceiling. Caller cancellation must remain effective.
- Configured limits must accept their exact boundary, reject excess HTML, clamp
  out-of-range numbers, and fall back for nonfinite values. Different policies
  must not share pooled tool snapshots.
- Verify local rendering and recorded replay with a deterministic fixture.
  Real Amplitude validation additionally requires OAuth and an accessible chart;
  fixture success alone does not establish real-service compatibility.

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
- Compacted terminal-history replay of an App result must show fallback text and
  must not mount a sandbox iframe. Replay of a recorded transcript must mount
  the sandbox and render the retained App `html`, and must not carry an
  over-budget `toolResult`.
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
