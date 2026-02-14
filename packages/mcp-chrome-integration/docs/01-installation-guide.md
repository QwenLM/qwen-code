# Chrome MCP Integration - 安装指南

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本指南将帮助你在 5-10 分钟内完成 Chrome MCP Integration 的完整安装。

---

## 📋 系统要求

### 必需软件

✅ **Node.js 22+**

```bash
# 检查版本
node -v

# 如果未安装或版本过低，访问 https://nodejs.org/ 下载
```

✅ **Google Chrome 120+**

```bash
# 检查版本：Chrome 菜单 → 关于 Google Chrome
```

✅ **pnpm 包管理器**

```bash
# 检查是否安装
pnpm -v

# 如果未安装
npm install -g pnpm
```

### 操作系统支持

| 操作系统 | 支持状态    | 说明                     |
| -------- | ----------- | ------------------------ |
| macOS    | ✅ 完全支持 | 推荐 macOS 11+           |
| Linux    | ✅ 完全支持 | Ubuntu 20.04+ 或等效版本 |
| Windows  | ⚠️ 部分支持 | 需要修改路径配置         |

---

## 🚀 快速安装（推荐）

### 步骤 1: 运行自动安装脚本

```bash
cd /path/to/mcp-chrome-integration
./scripts/install.sh
```

**脚本自动完成**：

- ✅ 检查 Node.js 和 pnpm 版本
- ✅ 安装所有依赖（根目录 + native-server + chrome-extension）
- ✅ 构建所有组件
- ✅ 注册 Native Messaging Host
- ✅ 验证安装状态

**预计时间**: 5-10 分钟（取决于网络速度）

---

### 步骤 2: 加载 Chrome Extension

脚本完成后，按照以下步骤加载扩展：

1. 打开 Chrome 浏览器
2. 访问：`chrome://extensions/`
3. 启用右上角的 **"开发者模式"** 开关
4. 点击 **"加载已解压的扩展程序"**
5. 选择目录：

   ```
   /path/to/mcp-chrome-integration/app/chrome-extension/dist/extension
   ```

6. **复制 Extension ID**（显示在扩展卡片上，类似 `abcdefghijklmnopqrstuvwxyz123456`）

---

### 步骤 3: 配置 Extension ID

运行配置脚本并粘贴你的 Extension ID：

```bash
./scripts/update-extension-id.sh YOUR_EXTENSION_ID
```

**示例**：

```bash
./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456
```

脚本会自动更新 Native Messaging 配置文件中的 `allowed_origins`。

---

### 步骤 4: 验证安装

```bash
./scripts/diagnose.sh
```

**预期输出**：

```
✅ Chrome Extension 已安装
✅ Extension ID 已配置
✅ Native Messaging Host 已注册
✅ Native Server 文件存在且可执行
✅ Node.js 版本正确 (v22.x.x)
```

如果所有检查项显示 ✅，恭喜！安装成功。

---

## 🔧 手动安装（备选方案）

如果自动安装遇到问题，按以下步骤手动安装。

### 1. 安装依赖

```bash
cd /path/to/mcp-chrome-integration

# 安装根依赖
pnpm install

# 安装 native-server 依赖
cd app/native-server
pnpm install
cd ../..

# 安装 chrome-extension 依赖
cd app/chrome-extension
pnpm install
cd ../..
```

---

### 2. 构建组件

```bash
# 构建 native-server
cd app/native-server
pnpm build
cd ../..

# 构建 chrome-extension
cd app/chrome-extension
pnpm build
cd ../..
```

**验证构建产物**：

```bash
# 检查 native-server
ls app/native-server/dist/
# 应该看到: cli.js, index.js, mcp/, run_host.sh

# 检查 chrome-extension
ls app/chrome-extension/dist/extension/
# 应该看到: manifest.json, background/, sidepanel/
```

---

### 3. 注册 Native Messaging Host

```bash
cd app/native-server
node dist/cli.js register
```

**预期输出**：

```
✅ Native messaging host registered successfully
   Config file: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

**验证注册**：

```bash
node dist/cli.js doctor
```

所有检查项应显示 `[OK]`。

---

### 4. 加载 Chrome Extension

参考 [步骤 2](#步骤-2-加载-chrome-extension)。

---

### 5. 手动更新 Extension ID

**macOS**：

```bash
vim ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

**Linux**：

```bash
vim ~/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

更新 `allowed_origins` 字段：

```json
{
  "name": "com.chromemcp.nativehost",
  "description": "Node.js Host for Browser Bridge Extension",
  "path": "/path/to/native-server/dist/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

将 `YOUR_EXTENSION_ID_HERE` 替换为实际 ID，并确保路径正确。

---

## ✅ 验证连接

### 方法 1: 检查 Service Worker

1. 在 `chrome://extensions/` 找到扩展
2. 点击 **"Inspect views: service worker"**
3. 在控制台中，应该看到：

**✅ 成功连接**：

```
[ServiceWorker] Initializing Native Messaging...
[NativeMessaging] Connecting to native host: com.chromemcp.nativehost
[NativeMessaging] Connected successfully
[ServiceWorker] Initialized with Native Messaging support
```

**❌ 连接失败**：

```
[NativeMessaging] Disconnected from native host: Native host has exited
```

如果连接失败，检查：

- Extension ID 是否匹配配置文件
- run_host.sh 是否可执行：`chmod +x app/native-server/dist/run_host.sh`
- Node.js 路径是否正确

---

### 方法 2: 测试工具调用

在 Service Worker 控制台中执行：

```javascript
// 检查连接状态
self.NativeMessaging.getStatus();
// 应该返回: {connected: true, reconnecting: false, attempts: 0}

// 测试截图工具
await callBackend({
  type: 'CALL_TOOL',
  toolName: 'chrome_screenshot',
  params: { fullPage: false },
});
```

---

## 🧪 配置 Qwen CLI（可选）

如果你使用 Qwen CLI，配置 MCP Server：

```bash
cd app/chrome-extension
qwen mcp add chrome node /path/to/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js
```

**验证配置**：

```bash
qwen mcp list
# 应该看到:
# chrome: node /path/to/mcp-server-stdio.js (stdio) - Disconnected
```

**注意**："Disconnected" 是正常状态，MCP Server 按需启动。

**测试使用**：

```bash
qwen
> 你有哪些浏览器工具可以使用？
> 帮我列出当前打开的所有 Chrome 标签页
```

应该能看到 27 个 chrome\_\* 工具并成功调用。

---

## ⚠️ 常见问题

### Q1: Extension ID 每次加载都会变？

**原因**: 开发模式下加载的扩展 ID 不固定。

---

**解决方案 A - 临时方案**（推荐用于开发）：使用脚本更新

每次重新加载 Extension 后，运行：

```bash
./scripts/update-extension-id.sh <新的Extension ID>
```

脚本会自动更新 Native Messaging 配置文件中的 `allowed_origins`。

---

**解决方案 B - 永久方案**（推荐用于生产）：使用固定密钥打包

项目已包含密钥文件：`app/chrome-extension/.extension-key.pem`

**步骤 1: 打包 Extension**

使用 Chrome 命令行打包（会使用固定密钥）：

**macOS**:

```bash
# 进入项目根目录
cd /path/to/mcp-chrome-integration

# 使用 Chrome 打包
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --pack-extension=$(pwd)/app/chrome-extension/dist/extension \
  --pack-extension-key=$(pwd)/app/chrome-extension/.extension-key.pem
```

**Linux**:

```bash
google-chrome \
  --pack-extension=$(pwd)/app/chrome-extension/dist/extension \
  --pack-extension-key=$(pwd)/app/chrome-extension/.extension-key.pem
```

**Windows**:

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --pack-extension=%CD%\app\chrome-extension\dist\extension `
  --pack-extension-key=%CD%\app\chrome-extension\.extension-key.pem
```

**步骤 2: 生成产物**

打包成功后，会在 `app/chrome-extension/dist/` 目录生成：

- `extension.crx` - 打包后的扩展文件（Extension ID 固定）
- `extension.pem` - 私钥文件（如果是首次打包）

**步骤 3: 加载打包后的 Extension**

1. 打开 Chrome：`chrome://extensions/`
2. **拖拽** `extension.crx` 文件到 Chrome 窗口
3. 或者：启用"开发者模式"，点击"加载已解压的扩展程序"，选择 `dist/extension` 目录

**步骤 4: 验证 Extension ID**

打包后的 Extension ID 是固定的，基于 `.extension-key.pem` 生成。

每次重新构建后，只要使用相同的 `.pem` 文件打包，Extension ID 就不会变。

**步骤 5: 更新 Native Messaging 配置（仅需一次）**

```bash
# 首次使用固定 ID 后，配置一次即可
./scripts/update-extension-id.sh <固定的Extension ID>
```

之后无论重新构建多少次，只要使用相同密钥打包，ID 都不会变，无需再次配置。

---

**方案对比**：

| 方案                   | 适用场景           | 优点               | 缺点                       |
| ---------------------- | ------------------ | ------------------ | -------------------------- |
| **方案 A**<br>脚本更新 | 开发调试           | 简单快速           | 每次重新加载都需要运行脚本 |
| **方案 B**<br>固定密钥 | 生产部署、团队协作 | 一次配置，永久有效 | 需要额外的打包步骤         |

---

**注意事项**：

1. **密钥安全**：`.extension-key.pem` 文件非常重要，丢失后无法恢复相同的 Extension ID
2. **首次打包**：如果项目中没有 `.pem` 文件，Chrome 会自动生成
3. **团队协作**：团队成员应使用相同的 `.pem` 文件，确保 Extension ID 一致
4. **Chrome Web Store**：发布到商店后，Extension ID 由 Google 管理，无需手动处理

---

### Q2: Service Worker 连接失败？

**症状**: 控制台显示 `Native host has exited`

**检查清单**：

1. ✅ Extension ID 匹配配置文件
2. ✅ `run_host.sh` 存在且可执行
3. ✅ Node.js 路径正确（检查 run_host.sh 中的 node 路径）
4. ✅ 完全重启 Chrome（⌘+Q / Ctrl+Q）

**详细排查**：

```bash
# 检查配置文件
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# 手动测试 Native Host
cd app/native-server
echo '{"type":"ping"}' | node dist/index.js
# 应该返回 pong 响应
```

---

### Q3: 构建失败？

**常见原因**：

- Node.js 版本过低（需要 22+）
- pnpm 未安装
- 依赖下载失败（网络问题）

**解决步骤**：

```bash
# 1. 检查 Node.js 版本
node -v

# 2. 清理缓存
pnpm store prune

# 3. 重新安装
rm -rf node_modules app/*/node_modules
pnpm install
```

---

### Q4: Windows 系统如何安装？

**注意**: Windows 支持有限，需要手动调整。

**主要修改**：

1. 脚本路径分隔符（`/` → `\`）
2. Native Messaging 配置文件位置：
   ```
   %USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\
   ```
3. 使用 PowerShell 或 Git Bash 运行脚本
4. 修改 run_host.sh 为 run_host.bat（Windows batch 脚本）

---

### Q5: 如何卸载？

```bash
# 1. 在 Chrome 中移除扩展
#    chrome://extensions/ → 点击"移除"

# 2. 删除 Native Messaging 配置
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# 3. 删除项目文件（可选）
rm -rf /path/to/mcp-chrome-integration
```

---

## 🔍 故障排查

### 问题 1: Extension 加载失败

**错误**: "Failed to load extension"

**排查**：

```bash
# 检查 manifest.json 语法
cd app/chrome-extension/dist/extension
cat manifest.json | jq .

# 如果报错，重新构建
cd ../..
pnpm build
```

---

### 问题 2: Native Messaging 无法连接

**错误**: "Specified native messaging host not found"

**排查**：

```bash
# 1. 检查配置文件是否存在
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# 2. 验证 Extension ID 匹配
# 配置文件中的 allowed_origins 应包含当前 Extension ID

# 3. 检查路径和权限
ls -la app/native-server/dist/run_host.sh
file app/native-server/dist/run_host.sh

# 4. 运行诊断
cd app/native-server
node dist/cli.js doctor
```

---

### 问题 3: Qwen CLI 无法找到 MCP Server

**症状**: `qwen mcp list` 显示空

**排查**：

```bash
# 1. 检查配置文件位置
find ~ -name "settings.json" -path "*/.qwen/*" 2>/dev/null

# 2. 验证配置语法
cat ~/.qwen/settings.json | jq .

# 3. 使用项目级配置
cd app/chrome-extension
qwen mcp list
```

---

### 获取更多帮助

**查看日志**：

```bash
# Native Host 日志（macOS）
tail -f ~/Library/Logs/mcp-chrome-bridge/native_host_wrapper_*.log

# Chrome Extension 日志
# 在 chrome://extensions/ 点击 "Inspect views: service worker"
```

**运行完整诊断**：

```bash
./scripts/diagnose.sh
```

**提交问题时包含**：

- 诊断输出
- 操作系统和版本
- Chrome 版本
- 错误截图

---

## 🎉 安装成功！

恭喜你完成安装！现在你可以：

✅ 使用 Chrome Extension 的 Side Panel 与 AI 交互
✅ 通过 Qwen CLI 调用 27 个浏览器工具
✅ 实现高级浏览器自动化

### 下一步推荐

- 📖 阅读 [功能与架构文档](02-features-and-architecture.md) 了解所有能力
- 🧪 查看 [测试用例文档](04-test-cases.md) 了解典型使用场景
- 🔧 浏览 [设计对比文档](03-design-and-implementation.md) 了解实现细节

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team
