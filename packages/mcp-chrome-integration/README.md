# Chrome MCP Integration

A Chrome extension that connects to a local `qwen serve` daemon (daemon-direct architecture). The side panel chat talks to the daemon over HTTP+SSE via `@qwen-code/webui`, and the extension's browser tools are exposed to the agent as a client-hosted MCP server over the daemon WebSocket. No Native Messaging host.

Revived from PR #1432 on the architecture proposed in issue #5626. See [`docs/05-daemon-direct-architecture.md`](./docs/05-daemon-direct-architecture.md) for the design.

## Layout

- `app/chrome-extension/` — the MV3 extension: side panel (daemon client), background service worker (browser-tools MCP server over the daemon WS), content scripts, and the browser-tool executors.

## Develop

```bash
cd app/chrome-extension
npm run build            # esbuild → dist/extension
npm run dev              # watch mode
```

## Use

1. Start the daemon with the reverse tool channel enabled (still gated while the contract settles):
   ```bash
   QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve
   ```
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `app/chrome-extension/dist/extension`.
3. Open the side panel and chat. The agent can drive the current browser via the browser tools (read page, screenshot, console, navigate, click, fill).

If no daemon is running, the side panel shows a hint to start `qwen serve`.
