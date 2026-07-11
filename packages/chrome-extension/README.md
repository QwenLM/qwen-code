# @qwen-code/chrome-bridge

A Chrome extension that brings Qwen Code into the browser as a thin client of a
local [`qwen serve`](../../docs/users/qwen-serve.md) daemon — no Native
Messaging host to install.

It does two things:

- **Side panel** — frames the daemon's Web Shell (chat + tools), the same UI the
  daemon serves to the browser. The panel has no UI of its own.
- **Service worker** — a CDP-tunnel pipe. It connects to the daemon's `/acp`
  WebSocket and bridges `cdp_*` frames into `chrome.debugger`, so the agent can
  drive the real browser when an external CDP MCP adapter is configured.
- **Readiness warning** — the framed Web Shell stays usable for chat while a
  small status message distinguishes a disabled CDP tunnel from a missing
  browser automation adapter.

## Build

```bash
npm run build        # -> dist/extension (static assets + bundled service worker)
```

Then load it: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ pick `dist/extension`.

## Run

The extension is a client; the daemon does the work and must be started
separately (an extension cannot spawn a local process). Open the side panel and
it will tell you exactly what to run — it generates the command with this
extension's own id:

```bash
qwen serve --allow-origin chrome-extension://<this-extension-id>
```

`--allow-origin chrome-extension://<id>` is required: it lets the daemon's Web
Shell be framed by the extension (the `frame-ancestors` CSP) and accepts the
extension's requests. The side panel reads the id at runtime via
`chrome.runtime.id`, so you never have to look it up.

Once the daemon is reachable and permits framing, the side panel swaps the
welcome screen for the chat UI automatically.

## Browser Automation Tools

The command above only makes the side panel and Web Shell available. Browser
automation tools such as console/network inspection, screenshots, and page
clicking require an explicit external MCP adapter command:

```bash
QWEN_CDP_MCP_COMMAND=/path/to/cdp-mcp-adapter \
qwen serve --allow-origin chrome-extension://<this-extension-id>
```

No browser automation adapter is bundled with the main `@qwen-code/qwen-code`
package. When `QWEN_CDP_MCP_COMMAND` is unset, the extension can still open the
Web Shell, but the daemon will not register browser automation MCP tools.
Clients can distinguish the states through `/capabilities`:

- `allow_origin` means the extension may frame and call the daemon.
- `cdp_tunnel_over_ws` means the daemon exposes the reverse CDP tunnel.
- `browser_automation_mcp` means the external adapter command is configured and
  browser automation MCP tools can be registered when the CDP bridge connects.

## Onboarding states

The side panel probes `GET /health` and `GET /capabilities` and shows one of:

| State                   | Meaning                                | Shown                            |
| ----------------------- | -------------------------------------- | -------------------------------- |
| `down`                  | no daemon reachable                    | "Start qwen serve" + command     |
| `needs-allow-origin`    | daemon up but `--allow-origin` not set | "Allow this extension" + command |
| `chat-only`             | Web Shell ready, CDP tunnel disabled   | chat + bridge warning            |
| `tunnel-only`           | CDP tunnel ready, adapter missing      | chat + adapter warning           |
| `automation-configured` | browser automation adapter configured  | the Web Shell                    |

## Packaging for the Chrome Web Store

```bash
npm run package      # -> chrome-extension.zip (manifest at the zip root)
```

The generated manifest version follows this package's version. Upload the zip
to a GitHub prerelease for alpha side-loading, or to the Chrome Web Store
Developer Dashboard for managed distribution. The `debugger` permission will
draw manual review and must be justified in the store listing.
