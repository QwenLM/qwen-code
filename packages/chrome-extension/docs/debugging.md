# Debugging Guide for Qwen CLI Chrome Extension

This document outlines the debugging process for the Qwen CLI Chrome Extension.

## Debugging Setup

The extension provides several debugging options to help troubleshoot issues.

### Development Mode

To start the extension in development mode with debugging enabled:

```bash
npm run dev
```

This will:

- Launch Chrome with the extension loaded
- Open DevTools automatically
- You can open any target page manually for debugging

### Native Host Logging

The native host logs are stored at:

- **macOS/Linux**: `$HOME/.qwen/chrome-bridge/qwen-bridge-host.log`（若主目录不可写则回落 `/tmp/qwen-bridge-host.log`）
- **Windows**: `%USERPROFILE%\.qwen\chrome-bridge\qwen-bridge-host.log`（若不可写则回落 `%TEMP%\qwen-bridge-host.log`）

To monitor the logs in real-time:

```bash
npm run logs
```

Or directly:

```bash
tail -f "$HOME/.qwen/chrome-bridge/qwen-bridge-host.log"
```

### Chrome Extension Debugging

1. Open Chrome Extensions page (`chrome://extensions/`)
2. Enable "Developer mode"
3. Find the Qwen CLI Chrome Extension extension
4. Click "Inspect views" on the service worker to open DevTools for background scripts
5. Use the popup/panel's DevTools for UI debugging

## Common Debugging Scenarios

### Connection Issues

If the extension can't connect to the native host:

1. Verify Node.js is installed: `node --version`
2. Check the native host installation: `./native-host/scripts/smart-install.sh`
3. Check logs: `$HOME/.qwen/chrome-bridge/qwen-bridge-host.log`
4. Verify extension ID matches the one in native host manifest

### Qwen CLI Communication Issues

If the extension can't communicate with Qwen CLI:

1. Verify Qwen CLI is installed: `qwen --version`
2. Check that Qwen CLI is running when the extension tries to connect
3. Check the extension's console logs for error messages
4. Verify the MCP server configuration

### MCP/Bridge 处于 Disconnected 且无法自动拉起 host.js

症状：

- `qwen --debug mcp list` 显示 `chrome-browser ... Disconnected`。
- `/tmp/cbmcp.log` 中只有初始化和 `notifications/cancelled`，无工具列表。
- 有时看到 `Request timed out`，或在 host.js 日志里报 `listen EPERM`.

原因：

- MCP 本身走 stdio，不占端口；真正监听 18765 的是 `native-host/host.js`。在某些受限环境里，qwen 通过 spawn 启动 host.js 时被 OS 拒绝监听端口（`listen EPERM: operation not permitted 127.0.0.1:18765`），健康检查 10 次失败后超时，CLI 发送 `notifications/cancelled`，最终显示 Disconnected。
- 也可能是客户端未按 Content-Length framing 发送初始化，导致握手超时（已在 server 侧兼容裸 JSON）。

失败链路流程（spawn 模式）：

```
qwen mcp list (stdio)
    │
    ├─ 调用 scripts/cbmcp-wrapper.sh → 启动 browser-mcp-server.js
    │    │
    │    ├─ ensureBridgeReady()
    │    │    ├─ /healthz 预检 → 失败（桥未启动）
    │    │    └─ spawn host.js（需要绑定 127.0.0.1:BRIDGE_PORT）
    │    │         └─ 监听端口若被 OS 拒绝 → listen EPERM → host 退出
    │    │
    │    └─ 健康检查重试 10 次均失败 → bridgeAvailable=false
    │
    ├─ MCP 初始化握手：若 framing 解析失败或桥不可用 → 等待超时
    └─ Qwen 端发送 notifications/cancelled（Request timed out）→ 显示 Disconnected
```

手动桥 + 禁止 spawn（可绕过监听限制）：

```
手动：BRIDGE_PORT=18765 node native-host/host.js   # 需先验证 /healthz 可通
    │
qwen 端：BRIDGE_PORT=18765 BROWSER_MCP_NO_SPAWN=1 qwen --debug mcp list
    │
    ├─ ensureBridgeReady() 只做 /healthz 检查，不尝试 spawn
    └─ 桥健康 → MCP 握手完成 → Connected
```

排查步骤：

1. 查看 `/tmp/cbmcp.log`（由 `scripts/cbmcp-wrapper.sh` 写入），关键错误包括：
   - `[ERROR] HTTP API server error: listen EPERM: operation not permitted 127.0.0.1:18765`
   - `notifications/cancelled ... Request timed out`
2. 确认 bridge 是否已经在跑：`curl http://127.0.0.1:18765/healthz`。
3. 若 curl 不通，尝试更换端口：`BRIDGE_PORT=20080 node native-host/host.js`，并用同样端口 curl。

解决/规避：

1. 手动常驻 bridge（不依赖 spawn）：
   ```bash
   cd packages/chrome-extension/native-host
   BRIDGE_PORT=18765 node host.js   # 如端口受限，换高位端口
   ```
2. 让 browser-mcp 复用已有 bridge、禁止 spawn：
   ```bash
   cd packages/chrome-extension
   BRIDGE_PORT=18765 BROWSER_MCP_NO_SPAWN=1 qwen --debug mcp list
   ```
   看到 `✓ chrome-browser ... Connected` 即正常。
3. 如需要恢复自动 spawn，去掉 `BROWSER_MCP_NO_SPAWN`，但前提是运行环境允许子进程监听端口。
4. 如果在任何端口都出现 `listen EPERM`，需换到允许监听的环境/容器，或将 bridge 部署到可访问的机器，再调整 `BRIDGE_BASE/BRIDGE_PORT` 指向该地址。

### Content Script Issues

If content scripts aren't working properly:

1. Check the content script logs in the page's DevTools console
2. Verify the content script is properly injected
3. Check for CSP restrictions on the target page

## Debugging Scripts

The following scripts are available for debugging:

- `npm run dev`: Full development environment with Chrome auto-launch
- `npm run logs`: Tail the native host log file
- `npm run clean`: Clean all build artifacts and logs
- `npm run dev:chrome`: Start Chrome with extension loaded and DevTools open

## Troubleshooting Tips

### Check Extension Status

Check the extension's status in the extension popup or through the API.

### Verify Permissions

Ensure all required permissions are granted in the extension settings.

### Network Requests

Monitor network requests to ensure proper communication between components.

### Console Messages

Watch console messages in both the extension's background script and content scripts.
