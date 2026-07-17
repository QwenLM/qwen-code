# Daemon-Direct Architecture (issue #5626)

Revival of the Chrome extension on the `qwen serve` daemon, dropping Native
Messaging and external browser-tool servers from the default path.

```
┌─ Chrome extension (pure web client) ──────────────┐
│  Side panel                                       │
│    daemon discovery + framed Web Shell ───────────┼──┐
│  Service worker                                   │  │
│    browser-tools MCP server (over WS) ────────────┼─┐│
│    chrome.debugger CDP tools + event capture ──────┼─┘│
└───────────────────────────────────────────────────┘ ││
                                                       ▼▼
                        qwen serve daemon (localhost:4170, loopback auth-free)
```

## Chat and pairing

The side panel is a daemon client. `@qwen-code/webui`'s `DaemonSessionProvider`
({ baseUrl, token? }) handles connect / session-create / SSE / reconnect /
heartbeat. Loopback ⇒ `token` omitted, `workspaceCwd` omitted (daemon uses its
bound workspace).

- `src/daemon/config.ts` stores the loopback base URL, optional daemon bearer,
  and the paired extension credential in `chrome.storage.local`.
- `src/daemon/discovery.ts` probes daemon health and verifies a pairing
  challenge before the panel or service worker trusts that daemon.
- The side panel frames the daemon Web Shell after discovery and pairing.
- Pairing state is process-local in PR1, so restarting `qwen serve` requires a
  fresh terminal code. First-use mutual HMAC proof keeps both the code and the
  derived credential secret off the wire; later discovery also uses an HMAC
  challenge so stored credentials are not sent to an unknown process.

The native-messaging transport is not part of this path.

## Browser tools — extension-hosted reverse MCP

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

### Daemon side (`packages/cli/src/serve`, public-contract surface)

1. WS message types on the serve transport: `mcp_register` (client advertises a
   server name; tools are discovered through MCP), `mcp_message` (bidirectional
   JSON-RPC with an `id` for request/response correlation), `mcp_unregister`.
2. On `mcp_register`, register a runtime **SDK-type** MCP server for the session
   (reuse `addRuntimeMcpServer` + `isSdkMcpServerConfig`), wiring its
   `sendSdkMcpMessage` callback to push `mcp_message` frames down this client's WS
   and await the correlated response.
3. Tear down on WS close / `mcp_unregister`.
4. Advertise `client_mcp_over_ws`; paired extension clients work by default.
   Operators can disable the channel with `QWEN_SERVE_CLIENT_MCP_OVER_WS=0` or
   explicitly set it to `1` to permit legacy unpaired reverse MCP clients.

### Extension side

- `src/background/browser-mcp/server.ts` implements the small MCP JSON-RPC
  surface needed by the daemon transport without bundling another server.
- `src/background/browser-mcp/browser-tools.ts` owns the tool catalog and the
  bounded Console/Network recorders.
- `src/background/browser-mcp/debugger-session.ts` owns the active tab debugger
  attachment and CDP command/event lifecycle.

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
