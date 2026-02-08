# Qwen Code Chrome Integration (MCP-Chrome)

基于 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) 的源码级集成方案，将现有的 HTTP 通信架构升级为 Native Messaging 架构。

## 📋 概述

> 旧版 `chrome-extension` 已归档到 `archive/chrome-extension`，当前主线为 `mcp-chrome-integration`。

这个项目将 hangwin/mcp-chrome 的 Native Server 与现有的 React 19 Extension 集成，实现：

- **简化架构**: 从 5 层通信降至 3 层 (40% 简化)
- **增强功能**: 从 10 个工具增至 20+ 个工具 (100% 增强)
- **性能提升**: Native Messaging 比 HTTP 更快更稳定
- **源码可控**: 完整保留所有源代码，便于定制

## 🏗️ 架构对比

### 旧架构 (5 层)

```
Chrome Extension (React 19)
  ↓ HTTP (127.0.0.1:18765)
Native Host (Node.js HTTP Bridge)
  ↓ ACP (JSON-RPC over stdio)
Browser MCP Server
  ↓ MCP Protocol
Qwen CLI
```

### 新架构 (3 层)

```
Chrome Extension (React 19)
  ↓ Native Messaging Protocol (stdio)
Native Server (Fastify + MCP SDK)
  ↓ MCP Protocol (StreamableHttp/stdio)
Qwen CLI
```

## 🆚 功能对比

| 维度          | 旧版 (chrome-extension) | 新版 (mcp-chrome-integration) |
| ------------- | ----------------------- | ----------------------------- |
| 架构层数      | 5 层                    | 3 层                          |
| 工具数量      | 10 个                   | 20+ 个                        |
| 通信方式      | HTTP + SSE              | Native Messaging              |
| 维护方式      | 内部维护                | 基于社区 + 源码可控           |
| Response Body | ✅ 支持                 | ✅ 支持                       |
| 页面操作      | ✅ 基础支持             | ✅ 增强支持                   |
| AI 语义搜索   | ❌                      | ✅ 支持                       |
| 书签管理      | ❌                      | ✅ 支持                       |
| 浏览历史      | ❌                      | ✅ 支持                       |
| 性能          | 一般                    | 更快                          |

详细对比见: [docs/status/implementation-plan.md](docs/status/implementation-plan.md)

## 🚀 快速开始

> 说明：本目录已并入顶层 monorepo 管理，请在仓库根目录用 npm 安装/执行脚本，不要再单独初始化子工作区。

### 1. 安装依赖

在仓库根目录一次性安装（会覆盖到 chrome-integration 相关包）：

```bash
npm install
```

### 2. 构建项目

```bash
# 构建所有组件（在仓库根目录运行）
npm run build --workspace=@qwen-code/mcp-chrome-integration

# 或者分步构建
npm run build --workspace=mcp-chrome-bridge            # 构建 native-server
npm run build --workspace=@qwen-code/chrome-bridge     # 构建 Chrome Extension
```

### 3. 注册 Native Messaging

```bash
# 注册 Native Messaging Host
npm run install:native --workspace=@qwen-code/mcp-chrome-integration

# 验证注册
npm run doctor --workspace=@qwen-code/mcp-chrome-integration
```

### 4. 加载 Chrome Extension

1. 打开 Chrome: `chrome://extensions/`
2. 启用 "开发者模式"
3. 点击 "加载已解压的扩展程序"
4. 选择 `packages/mcp-chrome-integration/app/chrome-extension/dist/extension`

### 5. 配置 Qwen CLI

在 Qwen CLI 配置文件中添加 MCP Server:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

## 🛠️ 可用工具（27个）

### 浏览器管理（6个工具）

- `get_windows_and_tabs` - 列出所有窗口和标签
- `chrome_navigate` - 导航到 URL、刷新页面、前进/后退
- `chrome_switch_tab` - 切换到指定标签
- `chrome_close_tabs` - 关闭一个或多个标签
- `chrome_read_page` - 获取页面可访问性树（元素结构）
- `chrome_computer` - 统一的浏览器交互工具（鼠标、键盘、截图）

### 页面交互（5个工具）

- `chrome_click_element` - 点击元素（支持 CSS/XPath/坐标）
- `chrome_fill_or_select` - 填充表单元素
- `chrome_keyboard` - 模拟键盘输入
- `chrome_request_element_selection` - 请求用户手动选择元素（人在回路）
- `chrome_javascript` - 执行 JavaScript 代码并返回结果

### 网络监控（2个工具）

- `chrome_network_capture` - 统一的网络捕获工具（支持 response body、WebSocket）
- `chrome_network_request` - 发送带浏览器上下文的 HTTP 请求

### 内容分析（2个工具）

- `chrome_get_web_content` - 提取页面内容（HTML/文本）
- `chrome_console` - 捕获控制台输出（支持快照和缓冲模式）

### 数据管理（4个工具）

- `chrome_history` - 搜索浏览历史
- `chrome_bookmark_search` - 搜索书签
- `chrome_bookmark_add` - 添加书签
- `chrome_bookmark_delete` - 删除书签

### 截图与录制（2个工具）

- `chrome_screenshot` - 高级截图（全页/元素/自定义尺寸）
- `chrome_gif_recorder` - 录制浏览器活动为 GIF 动画

### 性能分析（3个工具）

- `performance_start_trace` - 开始性能追踪
- `performance_stop_trace` - 停止性能追踪并保存
- `performance_analyze_insight` - 分析性能追踪结果

### 文件与对话框（3个工具）

- `chrome_upload_file` - 上传文件到表单
- `chrome_handle_dialog` - 处理 JavaScript 对话框（alert/confirm/prompt）
- `chrome_handle_download` - 等待并处理下载

> **注意**: 部分高级工具（如 `search_tabs_content`、`chrome_inject_script`、`chrome_userscript` 等）可能在源码中被注释，需要时可以启用。详见 [工具参考文档](docs/design/tools-reference.md)。

## 🛠️ 开发

### 开发模式

```bash
# 启动所有组件的开发模式
npm run dev --workspace=@qwen-code/mcp-chrome-integration

# 或者分别启动
npm run dev --workspace=@qwen-code/chrome-bridge   # 启动 Extension 开发模式
npm run dev --workspace=mcp-chrome-bridge          # 启动 Native Server 开发模式
```

### 卸载 Native Messaging

```bash
npm run uninstall:native --workspace=@qwen-code/mcp-chrome-integration
```

## 📁 项目结构

```
packages/mcp-chrome-integration/
├── README.md                          # 本文档
├── package.json                       # 局部脚本定义（由顶层 workspace 管理依赖）
│
├── packages/
│   └── shared/                        # 共享类型库 (来自 hangwin)
│       ├── src/
│       │   ├── types.ts               # Native Message 类型
│       │   ├── tools.ts               # MCP 工具定义 (20+ 工具)
│       │   └── ...
│       └── package.json
│
├── app/
│   ├── chrome-extension/              # Chrome Extension (React 19)
│   │   ├── public/
│   │   │   └── manifest.json          # Manifest V3
│   │   ├── src/
│   │   │   ├── background/            # Service Worker (适配 Native Messaging)
│   │   │   ├── content/               # Content Script
│   │   │   └── sidepanel/             # React UI
│   │   ├── config/                    # esbuild 配置
│   │   └── package.json
│   │
│   └── native-server/                 # Native Server (来自 hangwin)
│       ├── src/
│       │   ├── cli.ts                 # CLI 入口
│       │   ├── native-messaging-host.ts
│       │   ├── server/                # Fastify 服务器
│       │   ├── mcp/                   # MCP 协议实现
│       │   └── ...
│       └── package.json
│
├── scripts/
│   ├── install.sh                     # 安装脚本
│   ├── build-all.sh                   # 构建脚本
│   └── dev.sh                         # 开发脚本
│
└── docs/
    ├── implementation-plan.md         # 实施方案
    ├── architecture.md                # 架构文档
    └── guides/customization.md         # 定制指南
```

## 🔄 从旧版迁移

### 工具映射表

| 旧版工具                     | 新版工具                             | 说明           |
| ---------------------------- | ------------------------------------ | -------------- |
| `browser_read_page`          | `chrome_read_page`                   | API 类似       |
| `browser_capture_screenshot` | `chrome_screenshot`                  | 功能更强       |
| `browser_get_network_logs`   | `chrome_network_debugger_start/stop` | 两步操作       |
| `browser_get_console_logs`   | `chrome_console`                     | API 类似       |
| `browser_click`              | `chrome_click_element`               | 支持更多选择器 |
| `browser_fill_form`          | `chrome_fill_or_select`              | API 类似       |
| `browser_run_js`             | `chrome_inject_script`               | 注入脚本       |

详细迁移指南见: [docs/status/implementation-plan.md](docs/status/implementation-plan.md)

## 📚 文档

- [实施方案](docs/status/implementation-plan.md) - 完整的集成实施方案
- [架构文档](docs/design/03-architecture.md) - 架构设计和技术选型
- [定制指南](docs/guides/customization.md) - 如何定制和扩展

## 🔗 相关资源

- [hangwin/mcp-chrome GitHub](https://github.com/hangwin/mcp-chrome)
- [完整文档](https://github.com/hangwin/mcp-chrome/blob/main/README.md)
- [工具 API 参考](https://github.com/hangwin/mcp-chrome/blob/main/docs/TOOLS.md)
- [架构设计](https://github.com/hangwin/mcp-chrome/blob/main/docs/ARCHITECTURE.md)

## 🐛 故障排查

### Extension 无法连接 Native Host

1. 检查 Native Messaging 注册状态:

```bash
npm run doctor --workspace=@qwen-code/mcp-chrome-integration
```

2. 检查 Extension Console 错误:

- 打开 `chrome://extensions/`
- 找到扩展，点击 "Inspect views: service worker"
- 查看 console 中的 `chrome.runtime.lastError`

3. 验证 Native Messaging 配置文件:

```bash
# macOS
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

### Native Server 无法启动

1. 检查构建产物:

```bash
ls -la app/native-server/dist/
```

2. 手动测试启动:

```bash
cd app/native-server
node dist/cli.js doctor
```

3. 查看日志:

```bash
# 检查 native-server 日志输出
```

### Qwen CLI 无法连接

1. 验证 MCP 配置:

```bash
# 检查配置文件
cat ~/.qwen/config.json
```

2. 测试连接:

```bash
# 使用 Qwen CLI 测试工具调用
qwen mcp list
```

## ⚠️ 注意事项

### Extension ID 变化

每次重新加载未打包的扩展，Extension ID 都会改变。解决方案：

1. 首次加载后记录 Extension ID
2. 更新 Native Messaging 配置清单中的 `allowed_origins`
3. 或使用开发者账号发布私有扩展 (固定 ID)

### Native Messaging 权限

macOS/Linux 需要确保文件权限：

```bash
# CLI 脚本可执行
chmod +x app/native-server/dist/cli.js

# 配置清单可读
chmod 644 ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

### 系统要求

- **Chrome 版本**: 建议 Chrome 120+
- **Node.js 版本**: 需要 Node.js 22+
- **操作系统**: macOS / Linux / Windows

## 🔧 技术栈

- **Extension UI**: React 19 + Tailwind CSS
- **Extension 构建**: esbuild
- **Native Server**: Node.js + Fastify + MCP SDK
- **通信协议**: Chrome Native Messaging (stdio)
- **MCP Transport**: StreamableHttp / stdio
- **包管理**: 顶层 npm workspace

## 📈 预期收益

- **架构简化**: 5 层 → 3 层 (40% 简化)
- **工具增强**: 10 个 → 20+ 个 (100% 增强)
- **性能提升**: Native Messaging 更快更稳定
- **代码质量**: 使用成熟的 hangwin 实现
- **易维护**: monorepo 结构清晰
- **可定制**: 完整源码可修改

## 🎯 下一步

1. 完成安装和构建
2. 测试 Native Messaging 连接
3. 验证所有工具功能
4. 配置 Qwen CLI 集成
5. 享受更强大的浏览器自动化能力！

## 📮 反馈

如有问题或建议：

1. 查看 [实施方案](docs/status/implementation-plan.md)
2. 查看 [hangwin/mcp-chrome Issues](https://github.com/hangwin/mcp-chrome/issues)
3. 项目内部讨论

---

**版本**: 2.0.0
**基于**: hangwin/mcp-chrome (源码集成)
**许可**: Apache-2.0
