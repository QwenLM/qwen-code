# Native Messaging 适配完成指南

> ⚠️ 备注：本文档记录的是 2026-01-17 的适配状态，可能与 `docs/status/integration-status.md` 结论冲突。请以最新集成状态为准。

**日期**: 2026-01-17
**状态**: ✅ 适配完成，待测试

---

## ✅ 已完成的工作

### 1. 创建 Native Messaging 通信层

**文件**: `app/chrome-extension/src/background/native-messaging.js`

实现了完整的 Native Messaging 通信功能：
- ✅ 连接管理（自动连接、断线重连）
- ✅ 消息发送和接收
- ✅ 请求-响应模式（Promise-based）
- ✅ 错误处理
- ✅ 状态广播到 UI

### 2. 适配 Service Worker

**文件**: `app/chrome-extension/src/background/service-worker.js`

**修改内容**:
- ✅ 移除 HTTP 通信代码（`BACKEND_URL`, `fetch`, `EventSource`）
- ✅ 添加 `importScripts('native-messaging.js')`
- ✅ 修改 `callBackend()` 使用 Native Messaging
- ✅ 修改 `connectToNativeHost()` 使用 Native Messaging
- ✅ 移除 SSE 轮询（不再需要）
- ✅ 添加 Native Messaging 初始化代码

### 3. 更新 Manifest

**文件**: `app/chrome-extension/public/manifest.json`

**修改内容**:
- ✅ 添加 `nativeMessaging` 权限
- ✅ 移除 `http://127.0.0.1:18765/*` host 权限（不再需要）

### 4. 重新构建

**结果**:
- ✅ Extension 构建成功
- ✅ native-messaging.js 已打包到 dist/extension/background/
- ✅ service-worker.js 已更新

---

## 🚀 部署和测试步骤

### 步骤 1: 确认 Native Server 注册

Native Server 需要在系统中注册为 Native Messaging Host。

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server

# 检查是否已注册
node dist/cli.js doctor

# 如果未注册，执行注册
node dist/cli.js register
```

**预期输出**:
```
✅ Native messaging host registered successfully
✅ Configuration file: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

### 步骤 2: 加载 Extension 到 Chrome

#### 2.1 打开 Chrome Extension 管理页面

```
chrome://extensions/
```

#### 2.2 启用开发者模式

点击右上角的 "Developer mode" 开关

#### 2.3 加载未打包的扩展

1. 点击 "Load unpacked"
2. 选择目录:
   ```
   /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/dist/extension
   ```

#### 2.4 记录 Extension ID

加载后会显示类似的 ID:
```
Extension ID: abcdefghijklmnopqrstuvwxyz123456
```

**重要**: 记下这个 ID，下一步需要用到。

### 步骤 3: 更新 Native Messaging 配置

由于 Extension ID 会改变（重新加载时），需要更新 Native Messaging 配置文件。

#### 3.1 编辑配置文件

```bash
# macOS
vim ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# Linux
vim ~/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# Windows
notepad %APPDATA%\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost.json
```

#### 3.2 更新 allowed_origins

找到 `allowed_origins` 字段，替换为你的 Extension ID:

```json
{
  "name": "com.chromemcp.nativehost",
  "description": "Qwen Code Chrome MCP Bridge",
  "path": "/path/to/native-server/dist/cli.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
```

**注意**:
- 替换 `YOUR_EXTENSION_ID_HERE` 为步骤 2.4 中记录的实际 ID
- 末尾的 `/` 不能省略

### 步骤 4: 重新加载 Extension

回到 `chrome://extensions/`，点击 Extension 的 "刷新" 按钮（或移除后重新加载）。

### 步骤 5: 验证连接

#### 5.1 打开 Service Worker 控制台

1. 在 `chrome://extensions/` 页面
2. 找到你的 Extension
3. 点击 "Inspect views: service worker"

#### 5.2 查看连接日志

在控制台中应该看到：

**成功连接**:
```
[ServiceWorker] Initializing Native Messaging...
[NativeMessaging] Initializing...
[NativeMessaging] Connecting to native host: com.chromemcp.nativehost
[NativeMessaging] Connected successfully
[ServiceWorker] Initialized with Native Messaging support
```

**连接失败**:
```
[NativeMessaging] Disconnected from native host: {Error message}
[NativeMessaging] Reconnecting in XXXms
```

#### 5.3 手动测试连接

在 Service Worker 控制台执行：

```javascript
// 检查连接状态
self.NativeMessaging.getStatus()
// 输出: {connected: true, reconnecting: false, attempts: 0}

// 测试发送消息
self.NativeMessaging.sendMessage({
  type: 'TEST',
  payload: { message: 'Hello from Extension' }
})

// 测试请求-响应
await self.NativeMessaging.sendMessageWithResponse({
  type: 'PING',
  payload: { timestamp: Date.now() }
})
```

### 步骤 6: 测试浏览器工具

#### 6.1 打开一个测试页面

```
https://example.com
```

#### 6.2 测试截图工具

在 Service Worker 控制台：

```javascript
// 调用截图工具
const result = await callBackend({
  type: 'CALL_TOOL',
  toolName: 'chrome_screenshot',
  params: { fullPage: false }
})

console.log('Screenshot result:', result)
```

#### 6.3 测试页面读取

```javascript
// 读取页面内容
const result = await callBackend({
  type: 'CALL_TOOL',
  toolName: 'chrome_read_page',
  params: {}
})

console.log('Page content:', result)
```

---

## 🔍 故障排查

### 问题 1: "Native host has exited"

**原因**: Native Messaging Host 未注册或配置错误

**解决方案**:
```bash
cd app/native-server
node dist/cli.js doctor
# 如果检查失败，重新注册
node dist/cli.js register
```

### 问题 2: "Specified native messaging host not found"

**原因**: Extension ID 与配置文件中的 `allowed_origins` 不匹配

**解决方案**:
1. 在 `chrome://extensions/` 查看当前 Extension ID
2. 更新 Native Messaging 配置文件中的 `allowed_origins`
3. 重新加载 Extension

### 问题 3: 连接后立即断开

**原因**: Native Server 启动失败或崩溃

**解决方案**:

查看 Native Server 日志：
```bash
# 查看系统日志（macOS）
log show --predicate 'process == "node"' --last 5m | grep mcp-chrome-bridge

# 或手动启动 Native Server 查看错误
cd app/native-server
node dist/index.js
```

### 问题 4: Extension 无法加载

**错误**: "Manifest file is invalid"

**解决方案**:

检查 manifest.json 语法：
```bash
cat dist/extension/manifest.json | jq .
```

### 问题 5: Service Worker 无法启动

**查看错误**: 在 `chrome://extensions/` 点击 "Errors" 按钮

**常见问题**:
- `importScripts` 路径错误 → 确认 native-messaging.js 在 background/ 目录
- 语法错误 → 检查 service-worker.js 语法

---

## 📊 架构对比

### 旧架构（HTTP）

```
Extension UI
  ↓ HTTP (127.0.0.1:18765)
HTTP Bridge
  ↓ ACP
MCP Server
  ↓ MCP
Qwen CLI
```

### 新架构（Native Messaging）

```
Extension UI
  ↓ Native Messaging (stdio)
Native Server (hangwin)
  ↓ MCP (stdio)
Qwen CLI
```

**优势**:
- ✅ 更简单（3层 vs 5层）
- ✅ 更快（直接通信）
- ✅ 更稳定（无 HTTP 端口占用）
- ✅ 更多工具（27个 vs 10个）

---

## 📝 后续步骤

### 1. 固定 Extension ID（可选）

为了避免每次重新加载都要更新配置，可以固定 Extension ID：

**方法 1**: 发布到 Chrome Web Store（推荐）

**方法 2**: 使用固定的密钥

在 manifest.json 中添加：
```json
{
  "key": "YOUR_PUBLIC_KEY_HERE"
}
```

### 2. 测试所有浏览器工具

测试清单：
- [ ] `chrome_screenshot` - 截图
- [ ] `chrome_read_page` - 读取页面
- [ ] `chrome_click_element` - 点击元素
- [ ] `chrome_fill_or_select` - 填充表单
- [ ] `chrome_navigate` - 导航
- [ ] `get_windows_and_tabs` - 获取标签页
- [ ] `chrome_console` - 控制台日志
- [ ] `chrome_network_capture` - 网络捕获

### 3. 与 Qwen CLI 集成测试

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

qwen

# 测试工具调用
> 帮我列出当前打开的所有 Chrome 标签页
> 帮我截图当前页面
> 帮我点击页面上的"更多"按钮
```

---

## ✅ 验证清单

### 构建验证
- [x] Extension 构建成功
- [x] native-messaging.js 打包完成
- [x] manifest.json 包含 nativeMessaging 权限

### 配置验证
- [ ] Native Server 已注册
- [ ] `doctor` 命令检查通过
- [ ] Extension ID 已更新到配置文件

### 连接验证
- [ ] Extension 加载无错误
- [ ] Service Worker Console 显示连接成功
- [ ] `NativeMessaging.getStatus()` 返回 connected: true

### 功能验证
- [ ] 能够发送测试消息
- [ ] 浏览器工具调用成功
- [ ] Qwen CLI 能够使用 Chrome 工具

---

**创建时间**: 2026-01-17
**状态**: 适配完成，等待测试
**下一步**: 按照本指南进行部署和测试
