# Qwen Code Web GUI - PRD (面向前端研发版)

## 1. 需求背景与目标

### 背景
Qwen Code 目前仅支持终端（CLI）交互方式，用户需要在命令行中与 AI 进行对话。参考 [kimi-cli PR #775](https://github.com/MoonshotAI/kimi-cli/pull/775) 的实现，希望为 Qwen Code 添加一个 Web GUI 界面，让用户可以通过浏览器与 AI 进行交互。

### 目标
1. 实现 `/web` 斜杠命令，启动本地 Web 服务
2. 提供完整的 Chat UI 界面，支持与 CLI 相同的功能
3. 复用现有 CLI 的 Session 存储机制，确保数据一致性
4. 复用 `@qwen-code/webui` 组件库，保持 UI 风格统一

---

## 2. 功能结构与范围

```
Web GUI
├── 核心功能
│   ├── /web 命令启动
│   │   ├── 启动本地 HTTP 服务器
│   │   ├── 自动打开浏览器
│   │   └── 支持端口/host 配置
│   └── Session 管理
│       ├── Session 列表展示
│       ├── Session 搜索
│       ├── 创建新 Session
│       ├── 切换 Session
│       └── Session 状态显示（运行中/空闲）
│
├── 聊天界面
│   ├── 消息列表
│   │   ├── 用户消息
│   │   ├── Assistant 消息（Markdown + 代码块）
│   │   ├── Thinking 过程展示（可折叠）
│   │   └── Tool 调用展示
│   │       ├── Read/Write/Edit 文件操作
│   │       ├── Glob/Grep 搜索操作
│   │       ├── Shell 命令执行
│   │       ├── Web 搜索/抓取
│   │       └── 其他工具调用
│   ├── 输入区域
│   │   ├── 文本输入框
│   │   ├── 附件/上下文按钮
│   │   ├── 模型选择器
│   │   ├── Thinking 模式开关
│   │   └── 发送/停止按钮
│   └── 上下文指示
│       └── Context 使用率显示
│
├── 设置功能
│   ├── 主题切换（亮色/暗色）
│   ├── 模型配置
│   └── 其他设置项
│
└── 权限与审批
    ├── Tool 执行权限请求
    └── Shell 命令审批
```

---

## 3. 功能设计 & 交互设计

### 3.1 `/web` 命令启动

**功能描述：**
用户在 CLI 中输入 `/web` 命令后，系统在本地启动一个 HTTP 服务器，并自动在默认浏览器中打开 Web GUI 界面。

**命令格式：**
```bash
/web                    # 默认启动 http://127.0.0.1:5494
/web --port 8080        # 指定端口
/web --host 0.0.0.0     # 允许局域网访问
/web --no-open          # 不自动打开浏览器
```

**交互流程：**
1. 用户在 CLI 中输入 `/web`
2. CLI 检查端口是否可用，如被占用则自动尝试下一个端口
3. 启动 HTTP 服务器 + WebSocket 服务
4. 在终端显示启动信息（URL、端口等）
5. 自动打开浏览器（除非指定 `--no-open`）
6. CLI 保持运行，作为 Web GUI 的后端服务

**接口需求：**
- 需要新增 `/web` 命令处理逻辑
- 需要新增 HTTP 服务器模块
- 需要新增 WebSocket 服务模块

---

### 3.2 左侧边栏 - Session 管理

**功能描述：**
左侧边栏显示 Session 列表，支持搜索、新建和切换 Session。

**UI 布局：**
```
┌─────────────────────┐
│ [品牌标识] Qwen Code │
├─────────────────────┤
│ SESSIONS    [🔄] [+] │
├─────────────────────┤
│ [🔍 Search sessions] │
├─────────────────────┤
│ ▸ Today              │
│   • Session 1   4m   │
│   • Session 2   1h   │
│ ▸ Yesterday          │
│   • Session 3   1d   │
├─────────────────────┤
│ [🌙/☀️] [⚙️]         │
└─────────────────────┘
```

**交互说明：**
1. **品牌标识**：显示 "Qwen Code" + 版本号
2. **刷新按钮 [🔄]**：重新加载 Session 列表
3. **新建按钮 [+]**：创建新 Session 并自动切换
4. **搜索框**：实时过滤 Session（按标题匹配）
5. **Session 列表**：
   - 按日期分组（Today / Yesterday / This Week / Older）
   - 显示 Session 标题 + 相对时间
   - 当前 Session 高亮显示
   - 运行中的 Session 显示状态指示器
6. **底部工具栏**：
   - 主题切换按钮
   - 设置按钮

**接口需求：**
- `GET /api/sessions` - 获取 Session 列表
- `POST /api/sessions` - 创建新 Session
- `GET /api/sessions/:id` - 获取单个 Session 详情

**复用组件：**
- `SessionSelector` 组件（需要适配为边栏形式）
- `groupSessionsByDate` 工具函数

---

### 3.3 主内容区 - 聊天界面

**功能描述：**
主内容区显示当前 Session 的聊天记录，支持实时消息流。

**UI 布局：**
```
┌─────────────────────────────────────────┐
│ [Session Title]  (session-id)  12% ctx │
├─────────────────────────────────────────┤
│                                         │
│  ┌─ User ─────────────────────────────┐ │
│  │ 你的问题内容...                     │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ● Thinking ▸                           │
│                                         │
│  ● Used Glob (web/**/*) ✓               │
│  ● Used Grep (kimi web) ✓               │
│                                         │
│  ┌─ Assistant ────────────────────────┐ │
│  │ AI 的回复内容...                    │ │
│  │ ```typescript                       │ │
│  │ const example = "code";             │ │
│  │ ```                                 │ │
│  └────────────────────────────────────┘ │
│                                         │
├─────────────────────────────────────────┤
│ [📎] [Edit Mode ▾] │ 12% │ [/] [@] [→] │
│ ┌─────────────────────────────────────┐ │
│ │ Ask Qwen Code...                    │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**顶部标题栏：**
- Session 标题（可编辑）
- Session ID（短格式）
- Context 使用率指示器（百分比 + 进度条）

**消息列表：**
1. **用户消息**：
   - 显示用户输入内容
   - 支持文件上下文附件显示
   - 时间戳显示

2. **Thinking 消息**：
   - 可折叠/展开
   - 显示 AI 思考过程
   - 橙色指示器

3. **Tool 调用消息**：
   - 显示工具名称和参数
   - 显示执行状态（进行中/成功/失败）
   - 可折叠详细输出
   - 支持的工具类型：
     - Read/Write/Edit 文件
     - Glob/Grep 搜索
     - Shell 命令
     - Web Fetch/Search
     - Think/Plan

4. **Assistant 消息**：
   - Markdown 渲染
   - 代码块高亮
   - 文件路径可点击

**接口需求：**
- `WebSocket /ws/sessions/:id` - 实时消息流
- `GET /api/sessions/:id/messages` - 获取历史消息
- `POST /api/sessions/:id/messages` - 发送新消息

**复用组件：**
- `ChatViewer` - 聊天视图
- `UserMessage` - 用户消息
- `AssistantMessage` - AI 消息
- `ThinkingMessage` - 思考消息
- `*ToolCall` 组件族 - 工具调用展示

---

### 3.4 输入区域

**功能描述：**
底部输入区域，支持消息输入、模式切换和发送。

**UI 元素：**
1. **附件按钮 [📎]**：选择文件作为上下文
2. **Edit Mode 选择器**：
   - Code (默认)
   - Auto
   - Plan
3. **Context 使用率**：简洁显示当前使用百分比
4. **命令菜单按钮 [/]**：打开斜杠命令菜单
5. **上下文附加按钮 [@]**：选择代码/文件作为上下文
6. **发送/停止按钮 [→/■]**：
   - 空闲时显示发送按钮
   - 生成中显示停止按钮

**交互说明：**
- Enter 发送消息
- Shift + Enter 换行
- Escape 停止生成
- `/` 触发命令补全

**接口需求：**
- `POST /api/sessions/:id/cancel` - 取消当前生成

**复用组件：**
- `InputForm` - 输入表单
- `CompletionMenu` - 命令补全菜单
- `ContextIndicator` - 上下文指示器

---

### 3.5 权限审批

**功能描述：**
当 AI 需要执行敏感操作时（如 Shell 命令），弹出权限审批对话框。

**UI 布局：**
```
┌────────────────────────────────────┐
│ Permission Request                  │
├────────────────────────────────────┤
│ Qwen Code wants to run:            │
│ ┌────────────────────────────────┐ │
│ │ npm install express            │ │
│ └────────────────────────────────┘ │
│                                    │
│ ○ Allow once                       │
│ ○ Allow for this session          │
│ ○ Always allow                     │
│                                    │
│     [Deny]           [Allow]       │
└────────────────────────────────────┘
```

**交互说明：**
- 显示待执行的命令/操作
- 提供权限范围选项
- Deny 拒绝执行
- Allow 允许执行

**接口需求：**
- `WebSocket` 消息：`permission_request` / `permission_response`

**复用组件：**
- `PermissionDrawer` - 权限抽屉组件

---

### 3.6 设置面板

**功能描述：**
设置面板用于配置 Web GUI 的各项参数。

**设置项：**
1. **外观**：
   - 主题（Light / Dark / System）
2. **模型**：
   - 默认模型选择
   - API Key 配置（如需要）
3. **行为**：
   - Thinking 模式默认开关
   - 自动滚动设置

**(!!待确认) 设置项是否需要与 CLI 设置同步？**

---

## 4. 技术架构

### 4.1 包结构

```
packages/
├── web-app/                    # 新增：Web 应用包
│   ├── package.json
│   ├── src/
│   │   ├── server/             # HTTP + WebSocket 服务
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   │   ├── sessions.ts
│   │   │   │   └── config.ts
│   │   │   └── websocket/
│   │   │       └── handler.ts
│   │   ├── client/             # React 前端应用
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── ChatArea.tsx
│   │   │   │   └── Settings.tsx
│   │   │   └── hooks/
│   │   └── shared/             # 前后端共享类型
│   │       └── types.ts
│   └── vite.config.ts
├── cli/                        # 现有 CLI 包
│   └── src/ui/commands/
│       └── webCommand.ts       # 新增：/web 命令
├── core/                       # 现有 Core 包
└── webui/                      # 现有 WebUI 组件库
```

### 4.2 技术选型

| 层级 | 技术选择 | 说明 |
|------|---------|------|
| 前端框架 | React 18+ | 复用 webui 组件 |
| 前端构建 | Vite | 快速开发和构建 |
| UI 组件 | @qwen-code/webui | 复用现有组件库 |
| 样式方案 | Tailwind CSS | 与 webui 保持一致 |
| 后端框架 | Express / Fastify | Node.js HTTP 服务 |
| 实时通信 | WebSocket (ws) | 消息流和状态同步 |
| 进程通信 | Core API | 复用 @qwen-code/core |

### 4.3 数据流

```
┌─────────────┐     HTTP/WS      ┌──────────────┐
│   Browser   │ ◄──────────────► │  Web Server  │
│  (React UI) │                  │  (Express)   │
└─────────────┘                  └──────┬───────┘
                                        │
                                        │ 调用
                                        ▼
                                 ┌──────────────┐
                                 │  Qwen Core   │
                                 │  (Session)   │
                                 └──────┬───────┘
                                        │
                                        │ 读写
                                        ▼
                                 ┌──────────────┐
                                 │ ~/.qwen/     │
                                 │ sessions/    │
                                 └──────────────┘
```

---

## 5. 待定与存疑点（For Discussion）

### 5.1 【Session 状态同步】多客户端同时访问同一 Session 的处理
**来源**：架构设计
**讨论点**：
- 如果用户在 CLI 和 Web 同时操作同一个 Session，如何处理冲突？
- 是否需要实现乐观锁或消息广播机制？
**备注**：kimi-cli 似乎通过 WebSocket 广播解决

### 5.2 【文件上传】Web 端文件上下文的实现方式
**来源**：截图分析
**讨论点**：
- Web 端是否支持直接上传文件作为上下文？
- 还是只能引用服务器本地文件？
**备注**：如支持上传，需要考虑文件大小限制和临时存储

### 5.3 【安全性】Web 服务的访问控制
**来源**：安全考虑
**讨论点**：
- 默认绑定 127.0.0.1 是否足够？
- 如果 --host 0.0.0.0，是否需要认证机制？
- 是否需要 CORS 配置？

### 5.4 【模型选择】Web 端模型配置与 CLI 的关系
**来源**：截图（底部显示 kimi-k2-5）
**讨论点**：
- Web 端是否可以独立选择模型？
- 还是强制使用 CLI 配置的模型？

### 5.5 【工作目录】Web 端的工作目录设定
**来源**：功能设计
**讨论点**：
- Web 端创建的 Session 使用什么工作目录？
- 是否允许用户选择/切换工作目录？
**备注**：kimi-cli 支持在创建 Session 时指定 work_dir

---

## 6. 参考资料

- [kimi-cli PR #775](https://github.com/MoonshotAI/kimi-cli/pull/775) - Web UI 实现参考
- [kimi-cli web 文档](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/reference/kimi-web.md)
- 现有 `@qwen-code/webui` 组件库
- 现有 CLI 命令系统实现
