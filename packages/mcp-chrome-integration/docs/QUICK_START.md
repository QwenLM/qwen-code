# 快速开始指南

## 当前状态

✅ Native Server 已构建并注册
✅ Chrome Extension 已构建并适配 Native Messaging
✅ MCP Server 已配置（27 个工具可用）

⏳ **待完成**: 加载 Extension 到 Chrome 并配置 Extension ID

---

## 🚀 三步完成部署

### 步骤 1: 加载 Extension 到 Chrome

1. 打开 Chrome 浏览器
2. 访问: `chrome://extensions/`
3. 启用右上角的 **"开发者模式"** 开关
4. 点击 **"加载已解压的扩展程序"**
5. 选择目录:
   ```
   /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/dist/extension
   ```
6. Extension 加载成功后，**复制显示的 Extension ID**（类似 `abcdefghijklmnopqrstuvwxyz123456`）

### 步骤 2: 更新 Extension ID 到 Native Messaging 配置

在终端执行:

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration

# 替换 YOUR_EXTENSION_ID 为步骤 1 中复制的 ID
./scripts/update-extension-id.sh YOUR_EXTENSION_ID
```

**示例**:

```bash
./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456
```

### 步骤 3: 验证连接

1. 回到 `chrome://extensions/` 页面
2. 找到 "Qwen CLI Chrome Extension"
3. 点击 **"Inspect views: service worker"** 打开 Service Worker 控制台
4. 查看日志，应该看到:

**✅ 成功连接**:

```
[ServiceWorker] Initializing Native Messaging...
[NativeMessaging] Initializing...
[NativeMessaging] Connecting to native host: com.chromemcp.nativehost
[NativeMessaging] Connected successfully
[ServiceWorker] Initialized with Native Messaging support
```

**❌ 连接失败**:

```
[NativeMessaging] Disconnected from native host: ...
```

如果看到这个，检查:

- Extension ID 是否正确配置（重新运行步骤 2）
- Native Server 是否已注册: `cd app/native-server && node dist/cli.js doctor`

---

## 🧪 测试工具

### 在 Service Worker 控制台测试

```javascript
// 1. 检查连接状态
self.NativeMessaging.getStatus();
// 应该返回: {connected: true, reconnecting: false, attempts: 0}

// 2. 测试截图工具
await callBackend({
  type: 'CALL_TOOL',
  toolName: 'chrome_screenshot',
  params: { fullPage: false },
});

// 3. 测试读取页面
await callBackend({
  type: 'CALL_TOOL',
  toolName: 'chrome_read_page',
  params: {},
});
```

### 在 Qwen CLI 测试

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

qwen

# 在 Qwen 会话中:
> /mcp list
# 应该看到 chrome 服务器有 27 个工具

> 帮我列出当前打开的所有 Chrome 标签页
> 帮我截图当前页面
> 帮我点击页面上的"更多"按钮
```

---

## 📊 架构概览

**旧架构** (packages/chrome-extension):

```
Chrome Extension (React 19)
  ↓ HTTP (127.0.0.1:18765)
Native Host (HTTP Bridge)
  ↓ ACP
MCP Server
  ↓ MCP
Qwen CLI
```

**新架构** (packages/mcp-chrome-integration):

```
Chrome Extension (React 19)
  ↓ Native Messaging (stdio)
Native Server (hangwin - Fastify + MCP SDK)
  ↓ MCP Protocol (stdio)
Qwen CLI
```

**改进**:

- ✅ 层数: 5 → 3（简化 40%）
- ✅ 工具数: 10 → 27（增强 170%）
- ✅ 通信: HTTP → Native Messaging（更快更稳定）
- ✅ 代码: 完全源码可定制

---

## 🔍 故障排查

### 问题 1: Extension 无法加载

**症状**: Chrome 显示 "Manifest file is invalid"

**解决**:

```bash
cd app/chrome-extension
pnpm build

# 检查 manifest.json 语法
cat dist/extension/manifest.json | jq .
```

### 问题 2: Native Messaging 连接失败

**症状**: Service Worker Console 显示 "Native host has exited"

**解决**:

```bash
# 检查 Native Server 注册状态
cd app/native-server
node dist/cli.js doctor

# 如果失败，重新注册
node dist/cli.js register
```

### 问题 3: Extension ID 不匹配

**症状**: Console 显示 "Specified native messaging host not found"

**解决**:

```bash
# 1. 在 chrome://extensions/ 查看当前 Extension ID
# 2. 更新配置
./scripts/update-extension-id.sh <你的Extension ID>
# 3. 刷新 Extension
```

### 问题 4: MCP Server 未连接

**症状**: `qwen mcp list` 显示 "Disconnected"

**解决**:

```bash
cd app/chrome-extension

# 检查配置
cat .qwen/settings.json

# 应该是:
# {
#   "mcpServers": {
#     "chrome": {
#       "command": "node",
#       "args": ["/path/to/mcp-server-stdio.js"]
#     }
#   }
# }

# 如果路径错误，重新添加
qwen mcp remove chrome
qwen mcp add chrome node /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js
```

---

## 📁 关键文件位置

| 文件/目录                                                                                        | 说明                                      |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `app/chrome-extension/dist/extension/`                                                           | Extension 构建输出（加载此目录到 Chrome） |
| `app/native-server/dist/cli.js`                                                                  | Native Messaging 管理工具                 |
| `app/native-server/dist/mcp/mcp-server-stdio.js`                                                 | MCP Server for Qwen CLI                   |
| `app/native-server/dist/index.js`                                                                | Native Messaging Host（由 Chrome 调用）   |
| `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json` | Native Messaging 配置清单                 |
| `app/chrome-extension/.qwen/settings.json`                                                       | Qwen CLI MCP 配置                         |

---

## ✅ 完成检查清单

- [ ] Extension 加载到 Chrome 成功
- [ ] Extension ID 已复制
- [ ] Extension ID 已更新到 Native Messaging 配置
- [ ] Service Worker Console 显示 "Connected successfully"
- [ ] `self.NativeMessaging.getStatus()` 返回 connected: true
- [ ] 能够调用 `chrome_screenshot` 工具
- [ ] `qwen mcp list` 显示 chrome 服务器 Ready (27 tools)
- [ ] Qwen CLI 能够成功调用浏览器工具

---

**🎯 下一步**: 按照上述三个步骤完成部署，然后测试工具功能！

如有问题，查看详细文档: `docs/NATIVE_MESSAGING_ADAPTATION_COMPLETE.md`
