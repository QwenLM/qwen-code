# @qwen-code/chrome-bridge

A Chrome extension that brings Qwen Code into the browser as a thin client of a
local [`qwen serve`](../../docs/users/qwen-serve.md) daemon — no Native
Messaging host to install.

It does two things:

- **Side panel** — handles daemon discovery and pairing, then frames the
  daemon's Web Shell (chat + tools).
- **Service worker** — hosts Qwen's browser MCP tools and executes them through
  `chrome.debugger`. Tool calls travel over the daemon's reverse MCP WebSocket.

## Build

```bash
npm run build        # -> dist/extension (static assets + bundled service worker)
```

Then load it: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ pick `dist/extension`.

## Run

The extension cannot spawn a local process, so start the daemon separately:

```bash
qwen serve
```

The official extension id is pinned by `qwen serve`, so no browser-related
environment variables or `--allow-origin` flag are required. Custom or forked
extension builds must still pass their own origin explicitly:

```bash
qwen serve --allow-origin chrome-extension://<custom-extension-id>
```

Paste the pairing code printed by `qwen serve`. The credential remains in
Chrome storage across extension reloads, but a restarted daemon requires a new
pairing code because the daemon keeps trust state in memory. Once pairing
succeeds, the panel opens the chat UI and browser tools register immediately.
If Chrome storage is cleared while the daemon is still running, restart the
daemon to generate fresh pairing material.

The first-use exchange sends only an HMAC challenge proof; the pairing code and
derived credential secret never cross HTTP. The extension verifies the daemon's
proof before storing that credential, then uses a separate challenge-response
before sending it over `/acp`. Pairing endpoints intentionally precede bearer
authentication so an unknown process never receives a stored bearer token. The
pairing code is time-limited and failed attempts are bounded.

## Browser Automation Tools

Browser debugging tools are implemented in and bundled with this Chrome
extension. The main `@qwen-code/qwen-code` npm package does not contain an
external Chrome DevTools MCP server. The first-release catalog covers page
snapshot/navigation/input, screenshots, JavaScript evaluation, console output,
and network request/response inspection.

Tools act on the active tab. `evaluate_script` and `send_request` execute in the
page context and can access that page's authenticated session, so use a dedicated
browser profile or tab for untrusted sites and keep normal tool approval enabled.

An explicitly configured `QWEN_CDP_MCP_COMMAND` remains a deprecated
compatibility path targeted for removal in PR2. When present, the extension does
not register its native tool catalog and instead keeps the CDP tunnel available
to that adapter.

Relevant `/capabilities` tags:

- `allow_origin` means the extension may frame and call the daemon.
- `cdp_tunnel_over_ws` means the daemon exposes the reverse CDP tunnel.
- `client_mcp_over_ws` means extension-hosted tools can register over `/acp`.
- `browser_automation_mcp` means the legacy external adapter is configured.

## Onboarding states

The side panel probes `GET /health` and `GET /capabilities` and shows one of:

| State                | Meaning                                  | Shown                            |
| -------------------- | ---------------------------------------- | -------------------------------- |
| `down`               | no daemon reachable                      | "Start qwen serve" + command     |
| `needs-upgrade`      | daemon lacks secure extension pairing    | Qwen Code update command         |
| `needs-restart`      | Chrome lost the active daemon credential | daemon restart guidance          |
| `needs-allow-origin` | daemon up but `--allow-origin` not set   | "Allow this extension" + command |
| `needs-pairing`      | daemon reachable, credential not trusted | pairing-code form                |
| `ready`              | daemon reachable and paired              | the Web Shell (chat)             |

## Packaging for the Chrome Web Store

```bash
npm run package      # -> chrome-extension.zip (manifest at the zip root)
```

Upload the zip to the Chrome Web Store Developer Dashboard. The `debugger`
permission will draw manual review; explain that it is used only after a paired
local Qwen Code daemon requests a browser debugging action. Host permissions
are limited to the loopback daemon.

Release the matching Qwen Code CLI before publishing the extension update. The
pairing handshake intentionally does not downgrade for older daemons; the side
panel detects them and shows an update command instead of sending browser tools
to an unauthenticated local process.
