# @qwen-code/chrome-bridge

A Chrome extension that brings Qwen Code into the browser as a thin client of a
local [`qwen serve`](../../docs/users/qwen-serve.md) daemon — no Native
Messaging host to install.

It does two things:

- **Side panel** — frames the daemon's Web Shell (chat + tools), the same UI the
  daemon serves to the browser. The panel has no UI of its own.
- **Service worker** — a CDP-tunnel pipe. It connects to the daemon's `/acp`
  WebSocket and bridges `cdp_*` frames into `chrome.debugger`, so the agent can
  drive the real browser (read page, screenshot, click, …) via
  chrome-devtools-mcp over the tunnel.

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

## Onboarding states

The side panel probes `GET /health` and `GET /capabilities` and shows one of:

| State                | Meaning                                | Shown                            |
| -------------------- | -------------------------------------- | -------------------------------- |
| `down`               | no daemon reachable                    | "Start qwen serve" + command     |
| `needs-allow-origin` | daemon up but `--allow-origin` not set | "Allow this extension" + command |
| `ready`              | daemon up and framing permitted        | the Web Shell (chat)             |

## Packaging for the Chrome Web Store

```bash
npm run package      # -> chrome-extension.zip (manifest at the zip root)
```

Upload the zip to the Chrome Web Store Developer Dashboard. Note that the
`debugger` and `<all_urls>` permissions will draw manual review — justify them
in the store listing.
