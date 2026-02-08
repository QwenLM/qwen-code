# 本地调试指南

## 📋 调试流程概览

由于项目处于集成阶段，我们分两种调试场景：

### 场景 1: 调试 Native Server（独立测试）

- ✅ 可以立即使用
- 测试 MCP 工具是否正常工作
- 验证与 Qwen CLI 的连接

### 场景 2: 调试完整集成（Native Server + Extension）

- ⚠️ 需要完成 Extension 通信层适配
- 端到端测试完整流程

---

## 🚀 场景 1: 调试 Native Server

### 步骤 1: 构建 Native Server

```bash
cd packages/mcp-chrome-integration

# 1. 构建 shared 包
cd packages/shared
pnpm install
pnpm build
cd ../..

# 2. 构建 native-server
cd app/native-server
pnpm install
pnpm build
cd ../..
```

### 步骤 2: 注册 Native Messaging Host

```bash
cd app/native-server

# 注册
node dist/cli.js register

# 验证注册
node dist/cli.js doctor
```

**预期输出**:

```
✅ Native messaging host registered successfully
✅ Configuration file created at:
   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.mcp_chrome_bridge.json
```

### 步骤 3: 启动 Native Server（开发模式）

**方式 A: 独立启动（用于测试）**

```bash
cd app/native-server

# 直接启动 (会监听 stdio 和 HTTP)
node dist/index.js
```

**预期输出**:

```
[MCP Server] Starting...
[Fastify] Server listening on http://127.0.0.1:12306
[MCP] Tools registered: 20+
```

**方式 B: 通过 Qwen CLI 启动（推荐）**

1. 配置 Qwen CLI:

```bash
# 创建或编辑配置文件
vim ~/.qwen/config.json
```

2. 添加 MCP Server 配置:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/index.js"
      ]
    }
  }
}
```

3. 测试连接:

```bash
# 查看 MCP 服务列表
qwen mcp list

# 查看 chrome 服务的工具列表
qwen mcp get chrome
```

### 步骤 4: 测试 MCP 工具（无需 Extension）

**注意**: 大部分浏览器工具需要 Extension 配合，但可以测试服务器是否正常响应。

```bash
# 测试获取窗口和标签页列表（需要 Extension）
qwen mcp call chrome get_windows_and_tabs

# 如果 Extension 未连接，会返回错误提示
```

### 步骤 5: 查看 Native Server 日志

**日志输出位置**:

- **stdout**: Native Server 的控制台输出
- **stderr**: 错误信息

**常用调试技巧**:

```bash
# 启动时输出详细日志
DEBUG=* node dist/index.js

# 或使用 Node.js 调试器
node --inspect dist/index.js

# 然后在 Chrome 中打开: chrome://inspect
```

---

## 🌐 场景 2: 调试 Extension + Native Server 集成

### 前置条件

⚠️ **重要**: 由于 Extension 通信层尚未完全适配，以下步骤需要先完成 Extension 的 Native Messaging 适配（参考 `docs/status/implementation-summary.md`）。

### 步骤 1: 构建 Extension

```bash
cd packages/mcp-chrome-integration/app/chrome-extension

# 安装依赖
pnpm install

# 构建 Extension
pnpm build

# 或使用开发模式（自动重新构建）
pnpm dev
```

**构建产物位置**:

```
app/chrome-extension/dist/extension/
├── manifest.json
├── background/
│   └── service-worker.js
├── sidepanel/
│   └── sidepanel.html
└── content/
    └── content-script.js
```

### 步骤 2: 加载 Extension 到 Chrome

1. **打开 Chrome 扩展管理页面**:

   ```
   chrome://extensions/
   ```

2. **启用开发者模式**:
   - 点击右上角的 "开发者模式" 开关

3. **加载扩展**:
   - 点击 "加载已解压的扩展程序"
   - 选择目录: `packages/mcp-chrome-integration/app/chrome-extension/dist/extension`

4. **记录 Extension ID**:
   - 加载后会显示类似 `abcdefghijklmnopqrstuvwxyz123456` 的 ID
   - 记下这个 ID（下一步需要）

### 步骤 3: 更新 Native Messaging 配置

**问题**: Extension ID 每次重新加载都会改变（除非发布）

**解决方案**: 更新 Native Messaging 配置文件

```bash
# 编辑配置文件 (macOS)
vim ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.qwen.mcp_chrome_bridge.json
```

**更新 `allowed_origins` 字段**:

```json
{
  "name": "com.qwen.mcp_chrome_bridge",
  "description": "Qwen Code Chrome MCP Bridge",
  "path": "/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/cli.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

**提示**: 替换 `YOUR_EXTENSION_ID_HERE` 为你在步骤 2 中记录的 Extension ID。

### 步骤 4: 调试 Extension

#### 4.1 打开 Service Worker 控制台

1. 在 `chrome://extensions/` 页面
2. 找到你的扩展
3. 点击 "Inspect views: service worker"

**这里可以看到**:

- Service Worker 的控制台日志
- Network 请求（如果有）
- 错误信息

#### 4.2 打开 Side Panel

1. 点击 Chrome 工具栏中的扩展图标
2. 或点击扩展卡片上的 "side panel"

**这里可以看到**:

- React UI
- 用户交互

#### 4.3 查看 Native Messaging 连接状态

在 Service Worker 控制台中执行:

```javascript
// 检查 nativePort 是否连接
console.log('Native port:', nativePort);

// 检查最后的错误
console.log('Last error:', chrome.runtime.lastError);
```

### 步骤 5: 端到端测试

#### 5.1 测试 Native Messaging 连接

在 Service Worker 控制台:

```javascript
// 发送测试消息
chrome.runtime.sendMessage({ type: 'CONNECT' }, (response) => {
  console.log('Connection response:', response);
});
```

#### 5.2 测试浏览器工具

打开任意网页，然后在 Side Panel 中：

1. 输入测试命令（如果 UI 已适配）
2. 或在 Service Worker 控制台直接调用:

```javascript
// 测试截图工具
chrome.runtime.sendMessage(
  {
    type: 'CAPTURE_SCREENSHOT',
  },
  (response) => {
    console.log('Screenshot response:', response);
  },
);

// 测试读取页面内容
chrome.runtime.sendMessage(
  {
    type: 'EXTRACT_PAGE_DATA',
  },
  (response) => {
    console.log('Page data:', response);
  },
);
```

#### 5.3 通过 Qwen CLI 测试完整流程

确保 Native Server 正在运行，然后:

```bash
# 调用浏览器工具（需要 Extension 连接）
qwen mcp call chrome chrome_screenshot --fullPage

# 读取当前页面内容
qwen mcp call chrome chrome_read_page
```

---

## 🔍 常见问题排查

### 问题 1: Native Messaging 连接失败

**症状**:

```
Error: Native host has exited
```

**排查步骤**:

1. **检查注册状态**:

```bash
cd app/native-server
node dist/cli.js doctor
```

2. **检查配置文件**:

```bash
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.qwen.mcp_chrome_bridge.json
```

确认：

- `path` 指向正确的 `cli.js` 文件
- `allowed_origins` 包含正确的 Extension ID
- 文件权限正确 (chmod 644)

3. **检查 CLI 脚本可执行**:

```bash
chmod +x app/native-server/dist/cli.js
node app/native-server/dist/cli.js --version
```

### 问题 2: Extension 无法加载

**症状**:

```
Failed to load extension
```

**排查步骤**:

1. **检查构建产物**:

```bash
ls -la app/chrome-extension/dist/extension/
```

确认存在:

- `manifest.json`
- `background/service-worker.js`
- `sidepanel/sidepanel.html`

2. **检查 manifest.json 语法**:

```bash
cat app/chrome-extension/dist/extension/manifest.json | jq .
```

3. **查看 Extension 错误**:
   - 在 `chrome://extensions/` 点击 "错误" 按钮

### 问题 3: Service Worker 反复重启

**症状**:
Service Worker 每隔几秒就重启

**原因**:
Chrome 会自动终止空闲的 Service Worker

**解决方案**:
在 Service Worker 中保持活动:

```javascript
// 定期发送 keepalive 消息
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'KEEPALIVE' });
}, 20000);
```

或使用 hangwin 的 `keepalive-manager.ts`（已包含在 native-server 中）。

### 问题 4: Extension ID 改变

**症状**:
重新加载 Extension 后 ID 改变，Native Messaging 无法连接

**解决方案**:

**方式 A: 每次更新配置（开发阶段）**

```bash
# 获取新的 Extension ID
EXTENSION_ID=$(ls ~/Library/Application\ Support/Google/Chrome/Default/Extensions/ | head -1)

# 更新 Native Messaging 配置
# (手动编辑或使用脚本)
```

**方式 B: 固定 Extension ID（推荐）**

在 `manifest.json` 中添加:

```json
{
  "key": "YOUR_PUBLIC_KEY_HERE"
}
```

生成 key:

```bash
# 使用 Chrome 打包工具生成 .pem 文件
# 然后从 .pem 提取 public key
```

---

## 📊 调试检查清单

### Native Server 调试

- [ ] `pnpm build:shared` 成功
- [ ] `pnpm build:native` 成功
- [ ] `node dist/cli.js register` 成功
- [ ] `node dist/cli.js doctor` 显示正常
- [ ] `node dist/index.js` 启动无错误
- [ ] Qwen CLI 能够连接到 chrome 服务

### Extension 调试

- [ ] `pnpm build:extension` 成功
- [ ] Extension 加载到 Chrome 无错误
- [ ] Service Worker 控制台无错误
- [ ] `nativePort` 连接成功（检查控制台）
- [ ] Side Panel 正常显示
- [ ] Extension 能够接收和发送消息

### 端到端调试

- [ ] Extension 连接到 Native Server
- [ ] Native Server 连接到 Qwen CLI
- [ ] 浏览器工具调用成功
- [ ] 消息能够在各组件间正确传递

---

## 🛠️ 推荐的开发工具流程

### 终端 1: Native Server

```bash
cd packages/mcp-chrome-integration/app/native-server
node --inspect dist/index.js
```

### 终端 2: Extension 构建监听

```bash
cd packages/mcp-chrome-integration/app/chrome-extension
pnpm dev
```

### 终端 3: Qwen CLI

```bash
qwen mcp list
qwen mcp call chrome chrome_screenshot
```

### Chrome 标签页

1. `chrome://extensions/` - Extension 管理
2. Service Worker 控制台 - 查看后台日志
3. Side Panel - UI 调试
4. `chrome://inspect` - Node.js 调试器

---

## 📝 调试日志示例

### 正常的 Native Server 启动日志

```
[2026-01-16 23:00:00] Starting MCP Chrome Bridge...
[2026-01-16 23:00:00] Fastify server listening on http://127.0.0.1:12306
[2026-01-16 23:00:00] MCP tools registered: 23 tools
[2026-01-16 23:00:01] Waiting for connections...
```

### 正常的 Extension 连接日志

```
[Background] Service Worker activated
[Background] Connecting to native host: com.qwen.mcp_chrome_bridge
[Background] Native host connected
[Background] Server status: running, port: 12306
```

---

**最后更新**: 2026-01-16
**下一步**: 完成 Extension Native Messaging 适配后重新测试
