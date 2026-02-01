# Qwen Chrome Bridge Native Host (Proxy)

Bridge service for the legacy Qwen Chrome Extension. Provides an HTTP bridge on `127.0.0.1:18765` and proxies ACP messages to Qwen CLI.

Browser tooling is no longer exposed here. Use the MCP server from `packages/mcp-chrome-integration` (e.g. `chrome-mcp`) for read page, network logs, console logs, screenshots, etc.

## Requirements

- Node.js 18+ recommended (14+ minimum per engines)
- Qwen Chrome Extension installed/loaded

## Development (TypeScript)

- `npm run dev` watches/compiles TypeScript to `dist/` (used by the shim entries `host.js` and `src/*.js`), handy to keep running alongside `npm run dev` in `packages/chrome-extension`.
- `npm run build` cleans and emits production-ready JS + `.d.ts` to `dist/` (also invoked by the Chrome extension `npm run build`).

## Run

- `npm run start` (listens on `127.0.0.1:18765`).

## Background (optional)

If you want the bridge to stay up without waiting for Qwen to spawn it:

```bash
cd packages/chrome-extension/native-host
./scripts/run-daemon.sh
# stop: kill $(cat ~/.qwen/chrome-bridge/qwen-bridge-host.pid)
```

## Logs

Host log: `~/.qwen/chrome-bridge/qwen-bridge-host.log` (fallback `/tmp/qwen-bridge-host.log`).

## Notes

- The bridge assumes the Chrome extension is loaded and allowed to fetch `http://127.0.0.1:18765/*`.
