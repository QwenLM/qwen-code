# Chrome Qwen Bridge 架构设计文档

## 1. 项目概述

### 1.1 背景与需求

基于与 Kimi 的技术讨论，我们需要实现一个 Chrome 插件，能够：
- 将浏览器中的数据（DOM、网络请求、Console日志等）透传给 Qwen CLI
- 让 Qwen CLI 能够利用 AI 能力分析网页内容
- 支持 MCP（Model Context Protocol）服务器集成
- 实现浏览器与本地 CLI 的双向通信

### 1.2 技术约束

根据浏览器安全模型的限制：
- **浏览器无法直接启动本地进程**：Chrome 插件运行在沙箱环境中
- **无法直接调用 Node.js API**：插件无法访问文件系统或执行系统命令
- **跨域限制**：需要遵守 CORS 策略

### 1.3 解决方案选择

经过评估，我们选择了 **Native Messaging** 方案：

| 方案 | 优点 | 缺点 | 选择理由 |
|------|------|------|----------|
| Native Messaging | - Chrome 官方推荐<br>- 无需开放端口<br>- 安全性高<br>- 可自动启动进程 | - 需要首次手动安装<br>- 平台相关配置 | ✅ 官方标准，安全可靠 |
| HTTP Server | - 安装简单<br>- 跨平台统一 | - 需要占用端口<br>- 无法自动启动<br>- CORS 问题 | ❌ 用户体验较差 |
| 文件轮询 | - 实现简单 | - 性能差<br>- 实时性差<br>- 不适合生产 | ❌ 仅适合调试 |

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         Chrome Browser                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    Chrome Extension                     │ │
│  │                                                         │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │ │
│  │  │Content Script│  │Service Worker│  │   Popup UI   │ │ │
│  │  │              │◄─►│              │◄─►│              │ │ │
│  │  │ - DOM提取   │  │ - 消息路由   │  │ - 用户交互  │ │ │
│  │  │ - 事件监听  │  │ - 连接管理   │  │ - 状态显示  │ │ │
│  │  │ - JS执行    │  │ - 请求处理   │  │ - 配置管理  │ │ │
│  │  └─────────────┘  └──────┬───────┘  └──────────────┘ │ │
│  │                           │                            │ │
│  └───────────────────────────┼────────────────────────────┘ │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                               │
                    Native Messaging API
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                      Native Host (Node.js)                     │
│                                                                │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │  Message Handler │  │Process Manager│  │  HTTP Client   │ │
│  │                  │◄─►│              │◄─►│                │ │
│  │  - JSON-RPC      │  │ - spawn()    │  │ - REST API     │ │
│  │  - 协议转换      │  │ - 生命周期   │  │ - WebSocket    │ │
│  │  - 错误处理      │  │ - 日志管理   │  │ - 状态同步    │ │
│  └──────────────────┘  └──────┬───────┘  └────────┬───────┘ │
│                                │                    │         │
└────────────────────────────────┼────────────────────┼─────────┘
                                 │                    │
                                 ▼                    ▼
┌───────────────────────────────────────────────────────────────┐
│                           Qwen CLI                             │
│                                                                │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │   CLI Process    │  │  MCP Manager │  │   AI Engine    │ │
│  │                  │◄─►│              │◄─►│                │ │
│  │  - 命令解析      │  │ - 服务注册   │  │ - 内容分析    │ │
│  │  - HTTP Server   │  │ - 协议适配   │  │ - 智能处理    │ │
│  │  - WebSocket     │  │ - 工具调用   │  │ - 结果返回    │ │
│  └──────────────────┘  └──────────────┘  └────────────────┘ │
│                                                                │
│                          MCP Servers                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ chrome-devtools-mcp │ playwright-mcp │ custom-mcp ...   │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 组件职责

#### 2.2.1 Chrome Extension 层

**Content Script (`content-script.js`)**
- 注入到每个网页中运行
- 提取 DOM 结构、文本内容
- 监听 Console 日志
- 执行页面内 JavaScript
- 捕获用户选择的文本

**Service Worker (`service-worker.js`)**
- 管理 Native Messaging 连接
- 路由消息between组件
- 管理扩展生命周期
- 处理网络请求监控（通过 Debugger API）

**Popup UI (`popup.html/js/css`)**
- 提供用户界面
- 显示连接状态
- 触发各种操作
- 管理配置选项

#### 2.2.2 Native Host 层

**Message Handler**
- 实现 Native Messaging 协议
- 4字节长度前缀 + JSON 消息
- 双向消息队列管理
- 错误处理与重试机制

**Process Manager**
- 使用 `child_process.spawn()` 启动 Qwen CLI
- 管理进程生命周期
- 监控进程输出
- 优雅关闭处理

**HTTP Client**
- 与 Qwen CLI HTTP 服务通信
- 支持 REST API 调用
- WebSocket 连接管理（预留）

#### 2.2.3 Qwen CLI 层

- 接收并处理来自插件的请求
- 管理 MCP 服务器
- 调用 AI 模型分析内容
- 返回处理结果

## 3. 数据流设计

### 3.1 消息流向

```
用户操作 → Popup UI → Service Worker → Native Host → Qwen CLI → AI/MCP
                                                            ↓
用户界面 ← Popup UI ← Service Worker ← Native Host ← 响应结果
```

### 3.2 消息格式

#### Chrome Extension ↔ Native Host

```typescript
interface Message {
  id: number;           // 请求ID，用于匹配响应
  type: string;         // 消息类型
  action?: string;      // 具体动作
  data?: any;          // 携带数据
  error?: string;      // 错误信息
}
```

示例消息：
```json
{
  "id": 1,
  "type": "qwen_request",
  "action": "analyze_page",
  "data": {
    "url": "https://example.com",
    "content": "...",
    "metadata": {}
  }
}
```

#### Native Host ↔ Qwen CLI

使用 HTTP POST 请求：
```json
{
  "action": "analyze",
  "data": {
    "type": "webpage",
    "content": "...",
    "prompt": "分析这个网页的主要内容"
  }
}
```

### 3.3 状态管理

```typescript
enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RUNNING = 'running',
  ERROR = 'error'
}
```

## 4. 安全设计

### 4.1 权限控制

**Chrome Extension 权限**：
```json
{
  "permissions": [
    "nativeMessaging",    // Native Host 通信
    "activeTab",          // 当前标签页访问
    "storage",           // 配置存储
    "debugger"           // 网络请求监控
  ],
  "host_permissions": [
    "<all_urls>"         // 所有网站（可根据需要限制）
  ]
}
```

### 4.2 安全措施

1. **Native Messaging 安全**
   - 只允许特定扩展 ID 访问
   - Manifest 文件明确指定路径
   - 系统级权限保护

2. **数据安全**
   - 所有通信都在本地进行
   - 不存储敏感信息
   - 内容大小限制（防止内存溢出）

3. **进程安全**
   - 子进程权限继承用户权限
   - 无法执行系统级操作
   - 自动清理僵尸进程

## 5. 性能优化

### 5.1 数据传输优化

- **内容截断**：限制提取内容大小（50KB文本，30KB Markdown）
- **懒加载**：只在需要时提取数据
- **缓存机制**：缓存 Console 日志（最多100条）

### 5.2 进程管理优化

- **连接池**：复用 Native Messaging 连接
- **超时控制**：30秒请求超时
- **批量处理**：合并多个小请求

## 6. 错误处理

### 6.1 错误类型

| 错误类型 | 处理策略 | 用户提示 |
|---------|---------|---------|
| Native Host 未安装 | 引导安装 | "请先安装 Native Host" |
| Qwen CLI 未安装 | 继续运行，功能受限 | "Qwen CLI 未安装，部分功能不可用" |
| 连接断开 | 自动重连（3次） | "连接断开，正在重连..." |
| 请求超时 | 返回超时错误 | "请求超时，请重试" |
| 进程崩溃 | 清理并重启 | "Qwen CLI 异常退出" |

### 6.2 日志记录

- **Chrome Extension**：使用 `console.log`，可在扩展背景页查看
- **Native Host**：写入文件
  - macOS/Linux: `/tmp/qwen-bridge-host.log`
  - Windows: `%TEMP%\qwen-bridge-host.log`

## 7. 扩展性设计

### 7.1 MCP 服务器扩展

支持动态添加 MCP 服务器：
```javascript
// 配置新的 MCP 服务器
const mcpServers = [
  'chrome-devtools-mcp',
  'playwright-mcp',
  'custom-mcp'  // 自定义服务器
];
```

### 7.2 动作扩展

易于添加新的处理动作：
```javascript
const actions = {
  'analyze_page': analyzePageHandler,
  'process_text': processTextHandler,
  'custom_action': customHandler  // 自定义动作
};
```

### 7.3 通信协议扩展

预留 WebSocket 支持：
```javascript
// 未来可以升级为 WebSocket
if (config.useWebSocket) {
  return new WebSocketConnection(url);
} else {
  return new HTTPConnection(url);
}
```

## 8. 部署架构

### 8.1 开发环境

```
开发者机器
├── Chrome (Developer Mode)
├── Node.js 环境
├── Qwen CLI (本地安装)
└── MCP 服务器（可选）
```

### 8.2 用户环境

```
用户机器
├── Chrome 浏览器
├── Chrome Extension (从商店或本地加载)
├── Native Host (一次性安装)
├── Node.js 运行时
└── Qwen CLI (用户安装)
```

## 9. 技术栈

- **前端**：原生 JavaScript (ES6+)
- **UI**：HTML5 + CSS3 (渐变设计)
- **后端**：Node.js (Native Host)
- **通信**：Native Messaging + HTTP
- **进程管理**：child_process
- **协议**：JSON-RPC 风格

## 10. 未来展望

### 10.1 短期优化
- 添加 TypeScript 支持
- 实现 WebSocket 实时通信
- 优化 UI/UX 设计
- 添加单元测试

### 10.2 长期规划
- 支持更多浏览器（Firefox、Edge）
- 开发配套的 VS Code 插件
- 实现云端同步功能
- 支持批量网页处理

## 附录：关键决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 通信方式 | Native Messaging | Chrome 官方推荐，安全可靠 |
| 进程管理 | child_process.spawn | 灵活控制，支持流式输出 |
| UI 框架 | 原生 JavaScript | 减少依赖，快速加载 |
| 消息格式 | JSON | 通用性好，易于调试 |
| MCP 集成 | HTTP Transport | 简单可靠，易于实现 |