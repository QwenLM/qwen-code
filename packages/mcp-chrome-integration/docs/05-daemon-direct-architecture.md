# Daemon-Direct Architecture (issue #5626)

Revival of the Chrome extension on the `qwen serve` daemon, dropping Native
Messaging. This doc is the concrete implementation spec for the two phases.

```
┌─ Chrome extension (pure web client) ──────────────┐
│  Side panel (React, @qwen-code/webui)             │
│    DaemonSessionProvider ── chat over HTTP+SSE ───┼──┐
│  Service worker                                   │  │
│    browser-tools MCP server (over WS) ────────────┼─┐│
│  Content scripts (DOM / a11y / network capture)   │ ││
└───────────────────────────────────────────────────┘ ││
                                                       ▼▼
                        qwen serve daemon (localhost:4170, loopback auth-free)
```

## Phase 1 — chat (no daemon changes)

The side panel is a daemon client. `@qwen-code/webui`'s `DaemonSessionProvider`
({ baseUrl, token? }) handles connect / session-create / SSE / reconnect /
heartbeat. Loopback ⇒ `token` omitted, `workspaceCwd` omitted (daemon uses its
bound workspace).

- `src/daemon/config.ts` — `{ baseUrl, token? }`, default `http://127.0.0.1:4170`,
  overridable via `chrome.storage.local`.
- `src/daemon/discovery.ts` — `GET /health` probe; gate the chat on reachability,
  otherwise show a "run `qwen serve`" hint.
- Side panel renders transcript/streaming/permissions from the webui daemon hooks,
  reusing the existing presentational components + `ChromePlatformProvider`.

The native-messaging transport (`background/native-connection.ts`,
`native-message-handler.ts`, `native-messaging.ts` wiring) is dropped; the
browser-tool executors, catalog, router, network tools, and content scripts are
kept for Phase 2.

## Phase 2 — browser tools (reverse channel; touches the daemon contract)

A browser extension cannot be a listening MCP server. The agent runs inside the
daemon and must reach tools that execute in the extension. The mechanism already
exists in the codebase for **SDK-embedded MCP servers**, but only over the SDK's
subprocess `Query` control plane — NOT over the daemon's WS. Phase 2 makes the
daemon WS carry the same `mcp_message` frames.

### Existing template (reuse the pattern, not the wire)

- `core/src/tools/sdk-control-client-transport.ts` — `SdkControlClientTransport`:
  the agent's MCP **client** side. Routes JSON-RPC via a
  `sendMcpMessage(serverName, msg) => Promise<msg>` callback instead of stdio.
  Selected when `isSdkMcpServerConfig(config)` (see `mcp-client.ts:1663`),
  threaded through `createTransport(..., sendSdkMcpMessage)`.
- `sdk-typescript/src/daemon-mcp/SdkControlServerTransport.ts` — the **server**
  side: an MCP `Server` connected to a transport whose `send()` → `sendToQuery()`
  and inbound `handleMessage()` → `onmessage`.

Data flow to reproduce over the daemon WS:
```
agent MCP client → SdkControlClientTransport.send
  → daemon: sendMcpMessage('chrome-tools', jsonrpc)
  → WS frame {type:'mcp_message', server:'chrome-tools', payload: jsonrpc, id}
  → extension: MCP Server.handleMessage(jsonrpc) → tool executor (chrome.*)
  → extension: WS frame {type:'mcp_message', id, payload: jsonrpc-result}
  → daemon: resolve sendMcpMessage promise → agent gets the tool result
```

### Daemon side (new — `packages/cli/src/serve`, public-contract surface)

1. WS message types on the serve transport: `mcp_register` (client advertises a
   server name + tool catalog), `mcp_message` (bidirectional JSON-RPC with an
   `id` for request/response correlation), `mcp_unregister`.
2. On `mcp_register`, register a runtime **SDK-type** MCP server for the session
   (reuse `addRuntimeMcpServer` + `isSdkMcpServerConfig`), wiring its
   `sendSdkMcpMessage` callback to push `mcp_message` frames down this client's WS
   and await the correlated response.
3. Tear down on WS close / `mcp_unregister`.
4. Gate behind a capability flag (`caps.features` += `client_mcp_over_ws`) until
   the contract is settled — this is the open question raised in #5626.

### Extension side (reuses existing executors)

- `src/background/browser-tools-server.ts` (new): build an MCP `Server`
  (`@modelcontextprotocol/sdk`) whose `tools/list` = the kept `tool-catalog.ts`
  and `tools/call` dispatches via the existing `tool-router.ts` →
  `browser-tool-executors.ts` / `browser-network-tools.ts`, formatting with
  `mcp-tool-result.ts`. Connect it to a transport that sends/receives
  `mcp_message` over the DaemonClient WS; register on connect.
- MVP catalog (~6 tools, read-first): `chrome_read_page`, `chrome_screenshot`,
  `chrome_console`, `chrome_navigate`, `chrome_click_element`, `chrome_fill_or_select`.
  Write/navigate tools gated behind per-tool consent (security: browser origin
  defaults to read-only).

## Daemon lifecycle (issue #5626 Q3)

The extension can't spawn a process. Options, lightest-first:
1. Manual `qwen serve` + `/health` discovery (Phase 1 default, zero install).
2. Opt-in OS service registration so a daemon is always up — reuse the per-OS
   path logic in `native-host/scripts/` (it already writes the NativeMessagingHosts
   manifest per platform), emitting a unit instead:
   - macOS `~/Library/LaunchAgents/*.plist`, Linux `~/.config/systemd/user/*.service`,
     Windows scheduled task — each running `qwen serve` on loopback with
     `--allow-origin chrome-extension://<id>` (+ token).

No native messaging host in either case.
