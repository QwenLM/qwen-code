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

When browser automation is configured, the panel also checks `/workspace/mcp`.
It warns when the adapter has not connected or when an existing user-defined
`chrome-devtools` server takes precedence over the extension tunnel.

## Onboarding states

The side panel probes `GET /health` and `GET /capabilities` and shows one of:

| State                   | Meaning                                 | Shown                            |
| ----------------------- | --------------------------------------- | -------------------------------- |
| `down`                  | no daemon reachable                     | "Start qwen serve" + command     |
| `needs-allow-origin`    | daemon up but `--allow-origin` not set  | "Allow this extension" + command |
| `chat-only`             | Web Shell ready, CDP tunnel disabled    | chat + bridge warning            |
| `tunnel-only`           | CDP tunnel ready, adapter missing       | chat + adapter warning           |
| `automation-configured` | adapter configured; status unavailable  | the Web Shell                    |
| `automation-pending`    | adapter not connected                   | chat + connection warning        |
| `automation-shadowed`   | an existing MCP config takes precedence | chat + migration warning         |
| `automation-connected`  | extension-backed MCP connected          | the Web Shell                    |

## Automated real-Chrome acceptance

With Chrome running and the unpacked extension loaded, the acceptance runner
starts an isolated daemon and fixture page, exercises DOM snapshots, console
messages, network requests, button clicks, link navigation, restores the
original page, restarts the daemon, and verifies reconnection:

```bash
QWEN_CDP_MCP_COMMAND=/path/to/cdp-mcp-adapter \
  npm -w packages/chrome-extension run test:e2e:chrome
```

The command exits successfully only after printing `DEGRADED-MODE: PASS`,
`FULL-CDP-SMOKE: PASS`, and `REAL-CHROME-E2E: PASS`. It does not read or modify
the user's Qwen settings.

## Packaging for the Chrome Web Store

```bash
npm run package      # -> chrome-extension.zip (manifest at the zip root)
```

Run the complete release check from the repository root. It builds the main npm
payload, runs the extension tests and typecheck, packages the zip, and scans both
generated payloads for external Chrome DevTools MCP source signatures:

```bash
npm run test:chrome-extension:release
```

The generated manifest version follows this package's version. Upload the zip
to a GitHub prerelease for alpha side-loading, or to the Chrome Web Store
Developer Dashboard for managed distribution. The `debugger` permission will
draw manual review and must be justified in the store listing.
