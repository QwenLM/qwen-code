# Qwen Chrome Bridge Native Host (MCP-ready)

Bridge service + browser MCP server for the Qwen Chrome Extension. Provides an HTTP bridge on `127.0.0.1:18765` and the `chrome-browser` MCP tools (`read_page`, `capture_screenshot`, `get_network_logs`, `get_console_logs`, `fill_form`, `input_text`). The MCP entry auto-starts the bridge host; no manual `node host.js` needed.

## Requirements

- Node.js 18+ recommended (14+ minimum per engines)
- Qwen Chrome Extension installed/loaded

## Development (TypeScript)

- `npm run dev` watches/compiles TypeScript to `dist/` (used by the shim entries `host.js` and `src/*.js`), handy to keep running alongside `npm run dev` in `packages/chrome-extension`.
- `npm run build` cleans and emits production-ready JS + `.d.ts` to `dist/` (also invoked by the Chrome extension `npm run build`).

## Install & add to Qwen as MCP

From repo root:

```bash
cd packages/chrome-extension/native-host
npm install -g .          # or: npm pack && npm install -g qwen-cli-bridge-host-*.tgz

# 按照 Qwen CLI 文档（基于 settings.json 的 mcpServers）
# stdio 传输，命令为本包的可执行文件
qwen mcp add --transport stdio chrome-browser "chrome-browser-mcp"

# 验证
qwen mcp list
```

- `chrome-browser-mcp` (别名 `browser-bridge-mcp`) 是本包提供的可执行文件（stdio MCP）。被加载时会健康检查并拉起 `host.js`；host 提供 `/api` 和 `/events` 给扩展访问。

## 后台常驻（可选）

如果希望在添加 MCP 后立即有 18765 端口、无需等待 Qwen 首次加载 MCP，可直接将 host 跑成后台：

```bash
cd packages/chrome-extension/native-host
./scripts/run-daemon.sh   # 启动 host.js，监听 127.0.0.1:18765，日志写 ~/.qwen/chrome-bridge/qwen-bridge-host.log
# 停止：kill $(cat ~/.qwen/chrome-bridge/qwen-bridge-host.pid)
```

## Manual run (optional)

- Run only the HTTP bridge host: `npm run start` (listens on `127.0.0.1:18765`).
- Run only the MCP server (will spawn host if needed): `npm run mcp`.

## Logs

Host log: `~/.qwen/chrome-bridge/qwen-bridge-host.log` (fallback `/tmp/qwen-bridge-host.log`).

## Notes

- The bridge assumes the Chrome extension is loaded and allowed to fetch `http://127.0.0.1:18765/*`.
- If you change the port, set `BRIDGE_BASE`/`BRIDGE_URL` env vars before launching `chrome-browser-mcp`.
