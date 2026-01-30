# MCP Chrome Integration - 用户安装指南

欢迎使用 MCP Chrome Integration！本指南将帮助你快速安装和配置，5-10分钟即可完成。

**版本**: 1.0
**适用对象**: 最终用户（无需编程经验）
**最后更新**: 2026-01-25

---

## 📋 目录

1. [系统要求](#1-系统要求)
2. [快速安装（推荐）](#2-快速安装推荐)
3. [手动安装](#3-手动安装)
4. [验证安装](#4-验证安装)
5. [开始使用](#5-开始使用)
6. [常见问题](#6-常见问题)
7. [故障排查](#7-故障排查)

---

## 1. 系统要求

### 必需软件

✅ **Node.js 18 或更高版本**
- 检查版本：打开终端，运行 `node -v`
- 如果未安装或版本过低，请访问 [nodejs.org](https://nodejs.org/) 下载安装

✅ **Google Chrome 浏览器**
- 版本 120 或更高（推荐最新版本）
- 检查版本：Chrome 菜单 → 关于 Google Chrome

✅ **pnpm 包管理器**
- 检查是否安装：`pnpm -v`
- 如果未安装：`npm install -g pnpm`

### 操作系统支持

| 操作系统 | 支持状态 | 说明 |
|---------|---------|------|
| macOS | ✅ 完全支持 | 推荐 macOS 11+ |
| Linux | ✅ 完全支持 | Ubuntu 20.04+ 或等效版本 |
| Windows | ⚠️ 部分支持 | 需要修改部分路径配置 |

### 磁盘空间

- 至少 **500 MB** 可用空间（包括依赖）

---

## 2. 快速安装（推荐）

### 步骤 1: 下载项目

如果你已经有项目代码，跳到步骤 2。

```bash
# 克隆项目（如果尚未克隆）
git clone <repository-url>
cd qwen-code/packages/mcp-chrome-integration
```

### 步骤 2: 运行自动安装脚本

打开终端，运行：

```bash
./scripts/install.sh
```

这个脚本会自动完成：
- ✅ 检查 Node.js 和 pnpm 版本
- ✅ 安装所有依赖
- ✅ 构建所有组件
- ✅ 注册 Native Messaging Host
- ✅ 验证安装

**预计时间**: 5-10 分钟（取决于网络速度）

### 步骤 3: 加载 Chrome 扩展

脚本完成后，按照屏幕提示：

1. 打开 Chrome 浏览器
2. 在地址栏输入：`chrome://extensions/`
3. 启用右上角的 **"开发者模式"**
4. 点击 **"加载已解压的扩展程序"**
5. 选择目录：`<项目路径>/app/chrome-extension/dist/extension`

![加载扩展示意图]

### 步骤 4: 配置 Extension ID

1. 在 Chrome 扩展页面，找到刚加载的扩展
2. 复制显示的 **Extension ID**（32个字符，如：`abcdefghijklmnopqrstuvwxyz123456`）
3. 运行配置脚本：

```bash
./scripts/setup-extension.sh
```

按照提示粘贴 Extension ID，脚本会自动更新配置。

### 步骤 5: 验证安装

```bash
./scripts/diagnose.sh
```

如果所有检查项显示 ✅，恭喜！安装成功。

---

## 3. 手动安装

如果自动安装遇到问题，可以按以下步骤手动安装。

### 3.1 安装依赖

```bash
cd /path/to/mcp-chrome-integration

# 安装根依赖
pnpm install

# 安装 shared 包依赖
cd packages/shared
pnpm install
cd ../..

# 安装 native-server 依赖
cd app/native-server
pnpm install
cd ../..

# 安装 chrome-extension 依赖
cd app/chrome-extension
pnpm install
cd ../..
```

### 3.2 构建组件

```bash
# 构建 shared 包
cd packages/shared
pnpm build
cd ../..

# 构建 native-server
cd app/native-server
pnpm build
cd ../..

# 构建 chrome-extension
cd app/chrome-extension
pnpm build
cd ../..
```

### 3.3 注册 Native Messaging Host

```bash
cd app/native-server
node dist/cli.js register
```

**预期输出**:
```
✅ Native messaging host registered successfully
```

### 3.4 验证注册

```bash
node dist/cli.js doctor
```

所有检查项应显示 `[OK]`。

### 3.5 加载 Chrome 扩展

参考 [步骤 3](#步骤-3-加载-chrome-扩展)。

### 3.6 更新 Extension ID

**macOS**:
```bash
# 编辑配置文件
vim ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

**Linux**:
```bash
vim ~/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

更新 `allowed_origins` 字段：
```json
{
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
```

将 `YOUR_EXTENSION_ID_HERE` 替换为你的实际 Extension ID。

---

## 4. 验证安装

### 方法 1: 使用诊断脚本（推荐）

```bash
./scripts/diagnose.sh
```

检查以下项目：
- ✅ Chrome 扩展已安装
- ✅ Native Messaging Host 配置正确
- ✅ 脚本文件可执行
- ✅ Node.js 版本正确
- ✅ HTTP 服务器可访问（如果已启动）

### 方法 2: 手动检查

#### 检查 1: 扩展已加载

1. 打开 `chrome://extensions/`
2. 找到 "MCP Chrome Integration" 或类似名称
3. 确认状态为 **"已启用"**

#### 检查 2: Native Messaging 配置

**macOS**:
```bash
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

应该看到类似内容：
```json
{
  "name": "com.chromemcp.nativehost",
  "description": "Node.js Host for Browser Bridge Extension",
  "path": "/path/to/native-server/dist/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_ID/"]
}
```

#### 检查 3: Service Worker 状态

1. 在 `chrome://extensions/` 找到扩展
2. 点击 **"Inspect views: service worker"**
3. 在控制台中，应该看到类似日志：
   ```
   [ServiceWorker] Initialized with Native Messaging support
   ```

---

## 5. 开始使用

### 5.1 启动 HTTP 服务器（如果需要）

某些功能需要 HTTP 服务器运行：

```bash
cd app/native-server
node dist/start-server.js
```

服务器将在 `http://127.0.0.1:12306` 启动。

### 5.2 配置 Qwen CLI（可选）

如果你使用 Qwen CLI，添加 MCP 配置：

编辑 `~/.qwen/config.json`：

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/mcp-chrome-integration/app/native-server/dist/index.js"
      ]
    }
  }
}
```

验证配置：
```bash
qwen mcp list
```

应该看到 `chrome` 服务器。

### 5.3 测试功能

#### 测试 1: 扩展图标

点击 Chrome 工具栏中的扩展图标，应该能看到 Side Panel 界面。

#### 测试 2: 基本功能

在 Side Panel 中尝试基本操作（取决于实现）。

#### 测试 3: Qwen CLI 集成（如果配置）

```bash
cd /path/to/mcp-chrome-integration/app/chrome-extension
qwen
```

在 Qwen 会话中：
```
> 你有哪些浏览器工具可以使用？
```

应该能看到 20+ 个浏览器相关工具。

---

## 6. 常见问题

### Q1: Extension ID 每次加载都会变？

**原因**: 开发模式下加载的扩展 ID 不固定。

**解决方案 A** (推荐): 使用 `update-extension-id.sh` 脚本
```bash
./scripts/update-extension-id.sh <新的ID>
```

**解决方案 B**: 在 manifest.json 中固定 key（需要重新打包）

### Q2: Service Worker 连接失败？

**症状**: 控制台显示 `Native host has exited`

**检查清单**:
1. ✅ 确认 Extension ID 匹配配置文件
2. ✅ 确认 `run_host.sh` 文件存在且可执行
3. ✅ 确认 Node.js 路径正确
4. ✅ 完全重启 Chrome（⌘+Q / Ctrl+Q）

**详细排查**: 参见 [故障排查](#7-故障排查)

### Q3: MCP 服务器显示 "Disconnected"？

**回答**: 这是**正常状态**！

MCP 服务器是按需启动的，只有在实际使用时才会连接。"Disconnected" 只表示当前没有活动会话。

### Q4: 构建失败？

**常见原因**:
- Node.js 版本过低（需要 18+）
- pnpm 未安装
- 依赖下载失败（网络问题）

**解决步骤**:
1. 检查 Node.js 版本：`node -v`
2. 清理缓存：`pnpm store prune`
3. 重新安装：`rm -rf node_modules && pnpm install`

### Q5: Windows 系统如何安装？

**注意**: Windows 支持有限，需要手动调整路径。

**主要修改**:
1. 脚本中的路径分隔符（`/` → `\`）
2. Native Messaging 配置文件位置：
   ```
   %USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\
   ```
3. 使用 PowerShell 或 Git Bash 运行脚本

### Q6: 如何卸载？

```bash
# 1. 在 Chrome 中移除扩展
#    chrome://extensions/ → 点击"移除"

# 2. 删除 Native Messaging 配置
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# 3. 删除项目文件（可选）
rm -rf /path/to/mcp-chrome-integration
```

---

## 7. 故障排查

### 问题 1: Extension 加载失败

**错误信息**: "Failed to load extension"

**排查步骤**:

1. 检查 manifest.json 语法：
   ```bash
   cd app/chrome-extension/dist/extension
   cat manifest.json | jq .
   ```
   如果报错，重新构建：
   ```bash
   cd app/chrome-extension
   pnpm build
   ```

2. 检查构建产物：
   ```bash
   ls -la app/chrome-extension/dist/extension/
   ```
   应该包含：
   - `manifest.json`
   - `background/service-worker.js`
   - `sidepanel/` 目录

### 问题 2: Native Messaging 无法连接

**错误信息**: "Specified native messaging host not found"

**排查步骤**:

1. 检查配置文件是否存在：
   ```bash
   cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
   ```

2. 验证 Extension ID 匹配：
   - 配置文件中的 `allowed_origins`
   - Chrome 中显示的实际 ID

3. 检查路径和权限：
   ```bash
   # 检查 run_host.sh 是否存在
   ls -la /path/to/native-server/dist/run_host.sh

   # 检查是否可执行
   file /path/to/native-server/dist/run_host.sh
   ```

4. 运行诊断：
   ```bash
   cd app/native-server
   node dist/cli.js doctor
   ```

### 问题 3: HTTP 服务器无法启动

**错误信息**: `EADDRINUSE: address already in use`

**原因**: 端口 12306 已被占用

**解决**:
```bash
# 查找占用端口的进程
lsof -i :12306

# 停止进程
kill <PID>

# 或使用其他端口（需修改配置）
```

### 问题 4: Qwen CLI 无法找到 MCP 服务器

**症状**: `qwen mcp list` 显示空

**排查**:

1. 检查配置文件位置：
   ```bash
   # 查找所有可能的配置文件
   find ~ -name "settings.json" -path "*/.qwen/*" 2>/dev/null
   ```

2. 验证配置语法：
   ```bash
   cat ~/.qwen/settings.json | jq .
   ```

3. 使用项目级配置：
   ```bash
   cd /path/to/mcp-chrome-integration/app/chrome-extension
   qwen mcp list
   ```

### 获取更多帮助

如果以上方法都无法解决问题：

1. **查看详细日志**:
   ```bash
   # Native Host 日志
   tail -f ~/Library/Logs/mcp-chrome-bridge/native_host_wrapper_*.log

   # HTTP 服务器日志
   tail -f /tmp/mcp-server-test.log
   ```

2. **运行完整诊断**:
   ```bash
   ./scripts/diagnose.sh
   ```

3. **查看调试指南**: [DEBUGGING.md](docs/DEBUGGING.md)

4. **提交问题**:
   - 包含诊断输出
   - 操作系统和版本
   - Chrome 版本
   - 错误截图

---

## 🎉 安装成功！

恭喜你完成安装！现在你可以：

✅ 使用 Chrome 扩展的强大功能
✅ 通过 Qwen CLI 调用 20+ 个浏览器工具
✅ 实现高级浏览器自动化

### 下一步推荐

- 📖 阅读 [MCP 使用指南](docs/MCP_USAGE_GUIDE.md) 了解所有可用工具
- 🔧 查看 [开发指南](docs/development.md) 了解定制化开发
- 📚 浏览 [文档索引](docs/README.md) 探索更多功能

---

**祝使用愉快！**

**文档版本**: 1.0
**最后更新**: 2026-01-25
**维护者**: Qwen Code Team
