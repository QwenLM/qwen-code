# 连接问题调试指南

## 问题症状

- SidePanel 显示: `[SidePanel] Sending message: {type: 'CONNECT'}`
- 没有收到响应，无法连接

## 调试步骤

### 步骤 1: 检查 Service Worker 状态

1. 打开 Chrome: `chrome://extensions/`
2. 找到 "Qwen CLI Chrome Extension"
3. **关键**: 点击 **"Inspect views: service worker"**
   - 如果没有这个链接，说明 Service Worker 崩溃了，点击右边的刷新按钮重新加载 Extension

### 步骤 2: 查看 Service Worker 控制台

在 Service Worker 控制台中，应该看到这些初始化日志：

**✅ 正常情况**:

```
[ServiceWorker] Initializing Native Messaging...
[NativeMessaging] Initializing...
[NativeMessaging] Connecting to native host: com.chromemcp.nativehost
[NativeMessaging] Connected successfully
[ServiceWorker] Initialized with Native Messaging support
```

**❌ 异常情况 1**: Service Worker 崩溃

```
Uncaught Error: ...
```

→ 检查 extension/background/ 目录下文件是否完整

**❌ 异常情况 2**: Native Messaging 连接失败

```
[NativeMessaging] Disconnected from native host: ...
```

→ 检查 Native Host 注册

**❌ 异常情况 3**: 没有任何日志
→ Service Worker 没有启动，需要刷新 Extension

### 步骤 3: 检查 Extension 文件

```bash
# 检查必要文件是否存在
ls -la /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/dist/extension/background/

# 应该看到:
# native-messaging.js (约 8KB)
# service-worker.js (约 70KB)
```

### 步骤 4: 检查 Native Host 注册

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server

# 运行诊断
node dist/cli.js doctor

# 应该看到所有 [OK]
```

### 步骤 5: 检查 Extension ID 配置

```bash
# 查看当前配置的 Extension ID
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json | grep allowed_origins

# 对比实际的 Extension ID
# 在 chrome://extensions/ 页面查看 Extension ID
```

如果不匹配，运行：

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration
./scripts/update-extension-id.sh <实际的Extension ID>
```

### 步骤 6: 完整重启流程

如果上述步骤都检查过了还是不行，尝试完整重启：

```bash
# 1. 卸载 Extension
# 在 chrome://extensions/ 点击 "Remove"

# 2. 重新构建
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension
pnpm build

# 3. 重新加载
# 在 chrome://extensions/ 点击 "Load unpacked"
# 选择 dist/extension 目录

# 4. 获取新的 Extension ID
# 在 chrome://extensions/ 复制 ID

# 5. 更新配置
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration
./scripts/update-extension-id.sh <新的Extension ID>

# 6. 刷新 Extension
# 在 chrome://extensions/ 点击刷新按钮
```

---

## 常见错误及解决方案

### 错误 1: "Failed to load extension"

**原因**: manifest.json 损坏或语法错误

**解决**:

```bash
cd app/chrome-extension
cat dist/extension/manifest.json | jq .
# 如果报错，重新构建
pnpm build
```

### 错误 2: "Could not load background script 'background/service-worker.js'"

**原因**: service-worker.js 语法错误

**解决**:

```bash
cd app/chrome-extension
node -c dist/extension/background/service-worker.js
# 如果有语法错误，检查源文件
```

### 错误 3: "native-messaging.js:XX Uncaught ReferenceError"

**原因**: native-messaging.js 未正确加载

**解决**:

```bash
# 检查文件是否存在
ls -la dist/extension/background/native-messaging.js

# 如果不存在，重新构建
pnpm build
```

### 错误 4: "Specified native messaging host not found"

**原因**: Extension ID 与配置不匹配

**解决**:

```bash
# 1. 获取实际 Extension ID
# 在 chrome://extensions/ 复制

# 2. 更新配置
./scripts/update-extension-id.sh <Extension ID>

# 3. 刷新 Extension
```

### 错误 5: "Native host has exited"

**原因**: Native Server 未注册或路径错误

**解决**:

```bash
cd app/native-server
node dist/cli.js register
node dist/cli.js doctor
```

---

## 测试 Service Worker 连接

在 Service Worker 控制台执行以下命令：

```javascript
// 1. 检查 NativeMessaging 是否可用
typeof self.NativeMessaging;
// 应该返回: "object"

// 2. 检查连接状态
self.NativeMessaging.getStatus();
// 应该返回: {connected: true, reconnecting: false, attempts: 0}

// 3. 测试发送消息
await self.NativeMessaging.sendMessageWithResponse({
  type: 'PING',
  payload: { test: 123 },
});

// 4. 检查 connectToNativeHost 函数
typeof connectToNativeHost;
// 应该返回: "function"

// 5. 手动触发连接
await connectToNativeHost();
```

---

## 下一步

完成上述检查后，请提供：

1. Service Worker 控制台的完整输出（截图或复制文本）
2. `node dist/cli.js doctor` 的输出
3. Extension ID 和配置文件中的 allowed_origins
4. 任何错误消息

这样我可以帮你精确定位问题。
