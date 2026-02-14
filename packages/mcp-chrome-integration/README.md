# Chrome MCP Integration

> **版本**: 2.0.0 | **基于**: hangwin/mcp-chrome | **许可**: Apache-2.0

Chrome MCP Integration 是一个强大的浏览器自动化工具，通过 MCP (Model Context Protocol) 为 AI Agent 提供 27 个 Chrome 浏览器操作能力。

---

## 📊 核心特性

- ✅ **27 个专业浏览器工具**：页面导航、元素交互、网络监控、内容提取等
- ✅ **Native Messaging 架构**：Chrome Extension ↔ Native Server ↔ Qwen CLI 三层架构
- ✅ **完整的 Side Panel UI**：React 19 聊天界面，支持流式传输和工具调用可视化
- ✅ **响应体捕获**：使用 Chrome Debugger API 捕获完整的网络响应
- ✅ **人在回路模式**：当自动化失败时，可请求用户协助选择元素
- ✅ **源码可控**：基于 hangwin/mcp-chrome 深度定制，完整源码可修改

---

## 🚀 快速开始

### 系统要求

- **Node.js**: 22 或更高版本
- **Chrome**: 120 或更高版本
- **pnpm**: 最新版本（`npm install -g pnpm`）
- **操作系统**: macOS / Linux（Windows 部分支持）

### 一键安装（推荐）

```bash
cd packages/mcp-chrome-integration

# 运行自动安装脚本
./scripts/install.sh
```

**脚本自动完成**：

- ✅ 检查依赖环境
- ✅ 安装所有依赖
- ✅ 构建所有组件
- ✅ 注册 Native Messaging Host
- ✅ 验证安装状态

安装完成后，按照提示加载 Chrome Extension 即可使用。

### 手动安装

如果自动安装遇到问题，可以手动安装：

```bash
# 1. 安装依赖
pnpm install
cd app/native-server && pnpm install && cd ../..
cd app/chrome-extension && pnpm install && cd ../..

# 2. 构建组件
cd app/native-server && pnpm build && cd ../..
cd app/chrome-extension && pnpm build && cd ../..

# 3. 注册 Native Messaging Host
cd app/native-server
node dist/cli.js register

# 4. 验证安装
node dist/cli.js doctor
```

**加载 Chrome Extension**：

1. 打开 Chrome，访问 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `app/chrome-extension/dist/extension` 目录

---

## 🛠️ 可用工具（27 个）

### 浏览器管理（6 个）

| 工具                   | 功能                                   |
| ---------------------- | -------------------------------------- |
| `get_windows_and_tabs` | 列出所有窗口和标签页                   |
| `chrome_navigate`      | 导航到 URL、刷新、前进/后退            |
| `chrome_switch_tab`    | 切换到指定标签                         |
| `chrome_close_tabs`    | 关闭标签页                             |
| `chrome_read_page`     | 获取页面可访问性树（最重要的工具之一） |
| `chrome_computer`      | 统一的浏览器交互工具                   |

### 页面交互（5 个）

| 工具                               | 功能                                |
| ---------------------------------- | ----------------------------------- |
| `chrome_click_element`             | 点击元素（支持 CSS/XPath/ref/坐标） |
| `chrome_fill_or_select`            | 填充表单元素                        |
| `chrome_keyboard`                  | 模拟键盘输入                        |
| `chrome_request_element_selection` | 请求用户手动选择元素（人在回路）    |
| `chrome_javascript`                | 执行 JavaScript 代码                |

### 网络监控（2 个）

| 工具                     | 功能                                |
| ------------------------ | ----------------------------------- |
| `chrome_network_capture` | 捕获网络请求（含响应体、WebSocket） |
| `chrome_network_request` | 发送带认证的 HTTP 请求              |

### 内容分析（2 个）

| 工具                     | 功能                      |
| ------------------------ | ------------------------- |
| `chrome_get_web_content` | 提取页面内容（HTML/文本） |
| `chrome_console`         | 捕获控制台日志            |

### 数据管理（4 个）

| 工具                     | 功能         |
| ------------------------ | ------------ |
| `chrome_history`         | 搜索浏览历史 |
| `chrome_bookmark_search` | 搜索书签     |
| `chrome_bookmark_add`    | 添加书签     |
| `chrome_bookmark_delete` | 删除书签     |

### 截图与录制（2 个）

| 工具                  | 功能                         |
| --------------------- | ---------------------------- |
| `chrome_screenshot`   | 页面截图（全页/元素/自定义） |
| `chrome_gif_recorder` | 录制操作为 GIF 动画          |

### 性能分析（3 个）

| 工具                          | 功能           |
| ----------------------------- | -------------- |
| `performance_start_trace`     | 开始性能追踪   |
| `performance_stop_trace`      | 停止并保存追踪 |
| `performance_analyze_insight` | 分析性能数据   |

### 文件与对话框（3 个）

| 工具                     | 功能                   |
| ------------------------ | ---------------------- |
| `chrome_upload_file`     | 上传文件到表单         |
| `chrome_handle_dialog`   | 处理 JavaScript 对话框 |
| `chrome_handle_download` | 等待并处理下载         |

**完整工具文档**: 查看 [docs/02-features-and-architecture.md](docs/02-features-and-architecture.md)

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────┐
│              Chrome Browser                          │
│  ┌───────────────────────────────────────────────┐  │
│  │ Chrome Extension (Manifest V3)                │  │
│  │  - Side Panel (React 19 Chat UI)             │  │
│  │  - Service Worker (工具执行)                  │  │
│  │  - Content Scripts (页面操作)                 │  │
│  └─────────────────┬─────────────────────────────┘  │
└────────────────────┼────────────────────────────────┘
                     │
              Native Messaging (stdio)
                     │
┌────────────────────▼────────────────────────────────┐
│           Native Server (Node.js)                    │
│  - MCP Server (27 个 chrome_* 工具)                 │
│  - Native Messaging Handler                          │
│  - Fastify HTTP Server (可选)                        │
└────────────────────┬────────────────────────────────┘
                     │
              MCP Protocol (stdio)
                     │
┌────────────────────▼────────────────────────────────┐
│              Qwen CLI                                │
│  - AI Agent 执行                                     │
│  - 工具调用编排                                      │
└─────────────────────────────────────────────────────┘
```

**架构优势**：

- ✅ 3 层架构（vs 旧版 5 层，简化 40%）
- ✅ Native Messaging 通信（vs HTTP，更快更稳定）
- ✅ 27 个工具（vs 旧版 10 个，增强 170%）

---

## 🔧 配置 Qwen CLI（可选）

如果你使用 Qwen CLI，添加 MCP Server 配置：

```bash
cd app/chrome-extension
qwen mcp add chrome node /path/to/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js
```

**验证配置**：

```bash
qwen mcp list
# 应该看到: chrome: ... (27 tools)
```

**测试使用**：

```bash
qwen
> 你有哪些浏览器工具可以使用？
> 帮我列出当前打开的所有标签页
> 截图当前页面
```

---

## 📁 项目结构

```
packages/mcp-chrome-integration/
├── README.md                      # 本文档
├── package.json                   # 项目配置
│
├── app/
│   ├── chrome-extension/          # Chrome Extension
│   │   ├── public/
│   │   │   └── manifest.json      # Manifest V3 配置
│   │   ├── src/
│   │   │   ├── background/        # Service Worker（工具路由）
│   │   │   ├── content/           # Content Scripts（页面操作）
│   │   │   ├── sidepanel/         # React 19 Chat UI
│   │   │   └── platform/          # Chrome 适配层
│   │   └── dist/extension/        # 构建输出（加载此目录）
│   │
│   └── native-server/             # Native Messaging Host + MCP Server
│       ├── src/
│       │   ├── cli.ts             # 注册/诊断工具
│       │   ├── native-messaging-host.ts  # Native Messaging 入口
│       │   ├── mcp/               # MCP Server 实现
│       │   └── shared/            # 工具定义（27 个工具）
│       └── dist/
│           ├── cli.js             # 可执行 CLI
│           ├── index.js           # Native Host 入口
│           ├── run_host.sh        # Shell 包装器
│           └── mcp/
│               └── mcp-server-stdio.js  # MCP Server
│
├── scripts/                       # 用户安装脚本
│   ├── install.sh                 # 一键安装
│   ├── setup-extension.sh         # Extension 加载助手
│   ├── update-extension-id.sh     # 更新 Extension ID
│   └── diagnose.sh                # 系统诊断
│
└── docs/                          # 文档
    ├── 01-installation-guide.md   # 安装指南
    ├── 02-features-and-architecture.md  # 功能与架构
    ├── 03-design-and-implementation.md  # 设计对比与实现
    └── 04-test-cases.md           # 测试用例
```

---

## 🛠️ 常用脚本

### 用户脚本（scripts/）

| 脚本                     | 用途                | 示例                                    |
| ------------------------ | ------------------- | --------------------------------------- |
| `install.sh`             | 一键安装所有组件    | `./scripts/install.sh`                  |
| `setup-extension.sh`     | 加载 Extension 助手 | `./scripts/setup-extension.sh`          |
| `update-extension-id.sh` | 更新 Extension ID   | `./scripts/update-extension-id.sh <ID>` |
| `diagnose.sh`            | 诊断安装问题        | `./scripts/diagnose.sh`                 |

### 开发脚本（npm scripts）

| 命令                                    | 用途                   |
| --------------------------------------- | ---------------------- |
| `cd app/chrome-extension && pnpm dev`   | Extension 开发模式     |
| `cd app/native-server && pnpm dev`      | Native Server 开发模式 |
| `cd app/chrome-extension && pnpm build` | 构建 Extension         |
| `cd app/native-server && pnpm build`    | 构建 Native Server     |

---

## ⚠️ 常见问题

### Q1: Extension ID 每次加载都会变？

**原因**: 开发模式下 Extension ID 不固定。

**临时方案**（开发用）:

```bash
./scripts/update-extension-id.sh <新的Extension ID>
```

**永久方案**（生产用）- 使用固定密钥打包:

```bash
# 使用项目中的 .extension-key.pem 打包
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --pack-extension=$(pwd)/app/chrome-extension/dist/extension \
  --pack-extension-key=$(pwd)/app/chrome-extension/.extension-key.pem

# 生成 extension.crx，Extension ID 固定
# 拖拽 .crx 文件到 Chrome 即可加载
```

**详细说明**: 查看 [docs/01-installation-guide.md](docs/01-installation-guide.md) § Q1

### Q2: Service Worker 连接失败？

**排查步骤**:

1. 检查 Extension ID 是否匹配配置文件
2. 运行诊断脚本：`./scripts/diagnose.sh`
3. 完全重启 Chrome（⌘+Q / Ctrl+Q）

### Q3: 构建失败？

**解决**:

```bash
# 检查 Node.js 版本
node -v  # 需要 22+

# 清理并重新安装
rm -rf node_modules app/*/node_modules
pnpm install
```

### Q4: 如何卸载？

```bash
# 1. 在 Chrome 中移除扩展
# 2. 删除 Native Messaging 配置
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
# 3. 删除项目文件（可选）
```

**完整故障排查**: 查看 [docs/01-installation-guide.md](docs/01-installation-guide.md)

---

## 📚 文档

| 文档                                                   | 内容                                      |
| ------------------------------------------------------ | ----------------------------------------- |
| [安装指南](docs/01-installation-guide.md)              | 详细安装步骤、Extension ID 配置、故障排查 |
| [功能与架构](docs/02-features-and-architecture.md)     | 27 个工具详细参考、架构说明、最佳实践     |
| [设计对比与实现](docs/03-design-and-implementation.md) | 与 mcp-chrome 的差异、实现原理、代码示例  |
| [测试用例](docs/04-test-cases.md)                      | 35 个完整测试用例、4 个工作流场景         |

---

## 🆚 与开源 mcp-chrome 的关系

**本项目 = hangwin/mcp-chrome 核心 + 深度增强**

**保留**：

- ✅ 27 个 chrome\_\* 工具定义
- ✅ Native Messaging 架构
- ✅ MCP Protocol 实现

**增强**：

- ✅ **完整的 Side Panel Chat UI**（React 19）
- ✅ **ACP 协议集成**（与 Qwen CLI 直接通信）
- ✅ **流式传输支持**（实时看到 AI 响应）
- ✅ **工具调用可视化**（显示工具执行过程）
- ✅ **用户友好的安装脚本**
- ✅ **完善的诊断工具**

**详细对比**: 查看 [docs/03-design-and-implementation.md](docs/03-design-and-implementation.md)

---

## 🔧 技术栈

- **Extension**: React 19 + TypeScript + Tailwind CSS + esbuild
- **Native Server**: Node.js 22+ + Fastify + @modelcontextprotocol/sdk
- **通信**: Chrome Native Messaging Protocol (stdio)
- **MCP Transport**: stdio / StreamableHttp
- **包管理**: pnpm

---

## 🎯 典型使用场景

### 场景 1: 智能表单填充

```
用户: 帮我登录这个网站，用户名是 admin，密码是 password123

AI 自动执行:
1. chrome_read_page - 分析表单结构
2. chrome_fill_or_select - 填充用户名
3. chrome_fill_or_select - 填充密码
4. chrome_click_element - 点击登录按钮
```

### 场景 2: 网页数据提取

```
用户: 帮我分析这篇文章的主要内容

AI 自动执行:
1. chrome_get_web_content - 提取页面内容
2. chrome_network_capture - 检查 API 请求
3. chrome_console - 检查是否有错误
```

### 场景 3: 自动化测试录制

```
用户: 帮我录制一个登录流程的 GIF

AI 自动执行:
1. chrome_gif_recorder action="auto_start"
2. chrome_navigate - 访问登录页
3. chrome_fill_or_select - 填写表单
4. chrome_click_element - 提交表单
5. chrome_gif_recorder action="stop"
```

**更多测试场景**: 查看 [docs/04-test-cases.md](docs/04-test-cases.md)

---

## 🐛 故障排查

### 快速诊断

```bash
# 运行完整诊断
./scripts/diagnose.sh
```

**检查内容**:

- ✅ Chrome Extension 是否已加载
- ✅ Extension ID 是否匹配配置
- ✅ Native Messaging Host 是否已注册
- ✅ Native Server 文件是否存在
- ✅ Node.js 版本是否正确

### 查看日志

```bash
# Native Host 日志（macOS）
tail -f ~/Library/Logs/mcp-chrome-bridge/native_host_wrapper_*.log

# Service Worker 日志
# 在 chrome://extensions/ 点击 "Inspect views: service worker"
```

---

## 📈 项目状态

- ✅ **架构**: Native Messaging 完全实现
- ✅ **Extension**: React 19 Side Panel + Service Worker + Content Scripts
- ✅ **Native Server**: 27 个工具完整实现
- ✅ **文档**: 4 份完整文档 + 35 个测试用例
- ✅ **脚本**: 4 个用户脚本 + 完整安装流程

---

## 🔗 相关资源

- [hangwin/mcp-chrome GitHub](https://github.com/hangwin/mcp-chrome)
- [Model Context Protocol 规范](https://modelcontextprotocol.io/)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Chrome Native Messaging](https://developer.chrome.com/docs/apps/nativeMessaging/)

---

## 📮 反馈与贡献

如有问题或建议：

1. 查看 [文档](docs/)
2. 运行 [诊断脚本](scripts/diagnose.sh)
3. 提交 Issue 或内部讨论

---

**版本**: 2.0.0
**最后更新**: 2026-02-09
**基于**: hangwin/mcp-chrome (源码集成)
**许可**: Apache-2.0
**维护者**: Qwen Code Team
