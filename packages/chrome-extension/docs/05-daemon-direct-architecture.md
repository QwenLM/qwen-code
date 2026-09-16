# Daemon-Direct Architecture (issue #5626)

Current Chrome extension architecture on the `qwen serve` daemon, without
Native Messaging.

```
Chrome side panel ── iframe/HTTP ────────────────▶ qwen serve Web Shell
Chrome service worker ── CDP frames over /acp ──▶ qwen serve /cdp tunnel
Chrome active tab ◀──── chrome.debugger ──────────┘
External MCP adapter ── stdio MCP + /cdp WS ─────▶ qwen serve
```

## Side panel chat

The side panel probes the daemon and frames the Web Shell after the daemon
advertises `allow_origin`. The Web Shell owns sessions, streaming, permissions,
and reconnect behavior; the extension does not duplicate that React UI.

- `src/daemon/config.ts` — `{ baseUrl, token? }`, default `http://127.0.0.1:4170`,
  overridable via `chrome.storage.local`.
- `src/daemon/discovery.ts` — `GET /health` probe; gate the chat on reachability,
  otherwise show a "run `qwen serve`" hint.
- `public/sidepanel.js` — probes `/health` and `/capabilities`, frames the Web
  Shell, forwards its optional bearer token, and reports browser automation
  readiness without blocking chat.

The extension has no content script or extension-local browser tool catalog.
Page inspection and automation are provided through the CDP tunnel when an
external adapter is configured.

## Browser automation

The service worker registers as `qwen-cdp-bridge` on `/acp`. The daemon's `/cdp`
endpoint translates an external adapter's browser-level CDP connection into
`cdp_*` frames, and the extension forwards page-domain commands to the active
tab through `chrome.debugger`.

`qwen serve --allow-origin chrome-extension://<id>` enables the side panel and
CDP tunnel. Browser tools additionally require a separately installed stdio MCP
adapter:

```bash
QWEN_CDP_MCP_COMMAND=/path/to/cdp-mcp-adapter \
qwen serve --allow-origin chrome-extension://<id>
```

The main Qwen Code package deliberately does not bundle that adapter. Clients
must distinguish `cdp_tunnel_over_ws` from `browser_automation_mcp` in the serve
capability list.

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
