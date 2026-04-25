# Qwen Code Electron Desktop Architecture

> 目标：在现有 Qwen Code CLI、VS Code Companion、Core 能力之上，新增一个
> Electron 桌面端本地 AI 编码助手工作台。本文是产品、架构与验证设计文档，
> 不包含代码实现。

## 背景与参考

当前仓库已经有三类可复用资产：

- `packages/core`：模型配置、认证、工具注册与执行、权限、会话录制、
  `SessionService`、`ChatRecordingService`、MCP、hooks、subagents、memory 等核心能力。
- `packages/cli`：命令行入口、交互式 UI、非交互 `stream-json`、ACP agent、
  slash command、配置加载、认证入口。
- `packages/vscode-ide-companion` 与 `packages/webui`：VS Code WebView 聊天界面、
  ACP 子进程连接、权限回调、会话更新转换，以及可复用的 React 消息、
  ToolCall、PermissionDrawer、ChatViewer 组件。

参考项目 `~/Documents/cc-haha/desktop` 的核心思想是：桌面壳只负责窗口、
原生能力和本地服务生命周期；复杂业务放进本地 HTTP/WebSocket 服务；服务再
编排 CLI 子进程。外部架构文档
`https://claudecode-haha.relakkesyang.org/desktop/02-architecture.html`
可以访问，和本地实现一致：Tauri 主进程启动 sidecar server，React 前端通过
HTTP/WS 访问 server，server 再管理 CLI 子进程。

Qwen Code 不应照搬这套实现，原因是：

- 本方案必须使用 Electron，不使用 Tauri。
- Electron 主进程本身具备 Node 运行时，不需要 Bun-compiled sidecar 才能跑本地服务。
- Qwen Code 已有 ACP agent 和 `@agentclientprotocol/sdk` 集成；桌面端应复用 ACP，
  而不是像 `cc-haha` 那样再翻译 `stream-json`。
- Qwen Code 已有 `@qwen-code/webui` 共享 UI，桌面端应复用组件和类型转换逻辑，
  而不是从参考项目复制整套 React/store。
- 可以参考现代 AI coding desktop 的工作台思路，但不能复制其他产品的品牌、
  名称、图标或具体视觉设计。

## 产品定位与 MVP 范围

桌面端定位是一个本地 AI 编码助手工作台。用户选择本地项目目录后，可以创建
AI 任务线程，让 AI 阅读代码、解释代码、修改代码、运行命令、查看 diff、
提交 Git 变更，并在一个桌面界面内完成从提需求到审查代码的流程。

P0 MVP 必须覆盖：

| 能力                | UI 位置                       | 验收标准                                               |
| ------------------- | ----------------------------- | ------------------------------------------------------ |
| 项目选择/最近项目   | Welcome、左侧边栏顶部         | 用户能打开本地目录，最近项目保留项目名、路径、分支     |
| 项目与线程列表      | 左侧边栏                      | 每个项目下能展示多个 thread/task，并支持新建/切换      |
| AI 对话线程         | 中间主区域                    | 展示用户消息、AI 计划、执行步骤、文件引用、最终总结    |
| Composer            | 中间底部                      | 支持多行输入、发送、附件入口、`@file`、`/command` 入口 |
| 任务状态            | 顶部栏、线程标题、消息内      | 显示 Idle/Running/Needs Approval/Done/Error            |
| 文件读取追踪        | AI 消息内                     | AI 读过的文件以 chip/list 形式展示                     |
| 文件修改审查        | 右侧 Changes 面板             | 修改后必须显示 changed files 和 diff                   |
| 接受/撤销修改       | 右侧 Changes 面板             | 支持按全部、文件、hunk 接受或撤销                      |
| 集成终端            | 底部抽屉                      | 当前项目/线程作用域内运行命令，输出可复制/发送给 AI    |
| 命令审批            | 对话流或终端上方              | AI 运行命令前暂停，用户可 approve once/session 或 deny |
| Git 状态与提交      | 顶部栏、右侧 Summary/Changes  | 显示分支、modified/staged 数量，可填写 message commit  |
| 设置                | 左下角、顶部菜单、命令面板    | 配置模型/API key/权限/主题/编辑器/终端/Git             |
| Chrome DevTools MCP | 开发/测试模式                 | 可以连接 renderer，检查 DOM/console/network/screenshot |
| E2E                 | `packages/desktop` 或集成测试 | P0 用户流程必须有可重复自动化验证                      |

P1 建议覆盖 Worktree 并行任务、浏览器预览、页面批注、自动化任务、Automation
Inbox、slash commands、文件/图片拖拽、浮动小窗、通知、主题设置、默认编辑器和
GitHub PR review context。P2 再考虑 Skills 工作流、MCP/插件设置页、Web Search、
Memories、IDE 同步和 Computer Use。

第一版视觉优先级不是花哨，而是让用户始终清楚看到：

```text
AI 正在做什么
AI 读了哪些文件
AI 想运行什么命令
AI 改了哪些代码
用户如何接受或撤销
任务最终是否完成
```

## 推荐架构

推荐采用四层结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron Main                                                 │
│ - BrowserWindow / Menu / Tray / App lifecycle                 │
│ - Local DesktopServer host                                    │
│ - Native IPC: dialog, shell, window controls, optional PTY     │
│ - ACP child process lifecycle                                 │
└──────────────┬───────────────────────────────┬───────────────┘
               │ preload IPC                   │ spawn stdio ACP
               ▼                               ▼
┌──────────────────────────────┐     ┌────────────────────────┐
│ Electron Renderer             │     │ qwen --acp child       │
│ React + Zustand + webui        │     │ existing CLI ACP agent │
│ HTTP + WebSocket client        │     │ core/tools/auth/session│
└──────────────┬────────────────┘     └────────────────────────┘
               │ HTTP/WS 127.0.0.1 random port
               ▼
┌──────────────────────────────────────────────────────────────┐
│ DesktopServer (Node module hosted by Electron Main)           │
│ - REST API: sessions/settings/models/auth/runtime             │
│ - WS API: per-session chat stream and permission routing       │
│ - AcpProcessClient: ClientSideConnection to qwen --acp         │
│ - Session/update normalization for renderer                    │
└──────────────────────────────────────────────────────────────┘
```

MVP 中 `DesktopServer` 作为 Electron main 进程内模块启动，监听
`127.0.0.1:0` 随机端口。这样比 `cc-haha` 少一个 server sidecar 进程，打包和调试
更简单。接口边界仍然按本地 HTTP/WS 设计；如果后续需要更强隔离，可以把
`DesktopServer` 平移到 Electron `utilityProcess`，渲染层和 REST/WS 协议不变。

`qwen --acp` 仍作为独立子进程运行。生产包中通过 Electron 可执行文件加
`ELECTRON_RUN_AS_NODE=1` 启动打包后的 `dist/cli.js`，开发态可以使用系统 Node
或 `tsx` 启动源码。选用 Electron 版本时必须确保内置 Node 满足 Qwen Code 的
`>=20` 运行要求。

## 为什么首选 ACP

`cc-haha` 的 server 通过 `stream-json` 与 CLI 子进程通信，然后自己转换
`content_delta`、`tool_use_complete`、`permission_request` 等事件。Qwen Code
已经有更合适的协议边界：

- `packages/cli/src/acp-integration/acpAgent.ts` 暴露 `newSession`、`loadSession`、
  `unstable_listSessions`、`prompt`、`cancel`、`setSessionMode`、
  `unstable_setSessionModel`、`extMethod(deleteSession/renameSession/getAccountInfo)`。
- `packages/cli/src/acp-integration/session/Session.ts` 直接调用 core 的
  `GeminiChat`、`ToolRegistry`、hooks、permission、cron、session recording。
- `packages/vscode-ide-companion/src/services/acpConnection.ts` 和
  `packages/channels/base/src/AcpBridge.ts` 已证明 ACP 可以作为外部宿主和 CLI
  的边界。
- VS Code 的 `QwenSessionUpdateHandler` 已经处理
  `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、
  `tool_call_update`、`plan`、`available_commands_update`、usage metadata。

因此桌面端应复用 ACP 子进程能力。`stream-json` 只作为 fallback 或 SDK 兼容路径，
不作为桌面主链路。

## 包与目录规划

新增 workspace：

```text
packages/desktop/
├── package.json
├── electron.vite.config.ts
├── src/
│   ├── main/
│   │   ├── main.ts
│   │   ├── windows/MainWindow.ts
│   │   ├── lifecycle/AppLifecycle.ts
│   │   ├── ipc/registerIpc.ts
│   │   ├── native/dialogs.ts
│   │   ├── native/shell.ts
│   │   └── terminal/PtyManager.ts              # scoped terminal, P0
│   ├── preload/
│   │   └── index.ts                            # contextBridge whitelist
│   ├── server/
│   │   ├── index.ts                            # startDesktopServer()
│   │   ├── http/router.ts
│   │   ├── http/auth.ts
│   │   ├── ws/SessionSocketHub.ts
│   │   ├── acp/AcpProcessClient.ts
│   │   ├── acp/AcpEventRouter.ts
│   │   ├── acp/permissionBridge.ts
│   │   ├── services/projectService.ts
│   │   ├── services/sessionService.ts
│   │   ├── services/gitService.ts
│   │   ├── services/reviewService.ts
│   │   ├── services/settingsService.ts
│   │   ├── services/runtimeService.ts
│   │   ├── services/terminalService.ts
│   │   ├── services/artifactService.ts
│   │   └── types.ts
│   └── renderer/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/client.ts
│       ├── api/websocket.ts
│       ├── stores/projectStore.ts
│       ├── stores/chatStore.ts
│       ├── stores/sessionStore.ts
│       ├── stores/reviewStore.ts
│       ├── stores/artifactStore.ts
│       ├── stores/settingsStore.ts
│       ├── stores/modelStore.ts
│       ├── stores/terminalStore.ts
│       ├── stores/uiStore.ts
│       ├── components/layout/
│       └── pages/
└── assets/
```

构建顺序上，`packages/desktop` 应放在 `packages/core`、`packages/cli`、
`packages/webui` 之后。根 `scripts/build.js` 后续增加 desktop build；根
`npm run bundle` 产出的 `dist/cli.js` 和必要 vendor/native 资源作为桌面包资源。

## 应用布局与页面结构

应用采用信息密度较高的开发者工具风格，深色模式优先，避免营销页和装饰性视觉。
主界面是经典工作台布局：

| 区域          | 位置            | 作用                                             |
| ------------- | --------------- | ------------------------------------------------ |
| 顶部栏        | 窗口顶部        | 当前项目、Git 分支、任务模式、运行状态、快捷按钮 |
| 左侧边栏      | 左侧固定栏      | Projects、Threads、Automations、Skills、Settings |
| 中间主区域    | 屏幕中间        | AI 对话线程、计划、执行步骤、审批、用户输入框    |
| 右侧审查面板  | 屏幕右侧可折叠  | Changes、Files、Artifacts、Summary 四个 tab      |
| 底部终端抽屉  | 底部可展开/收起 | 集成终端、命令输出、测试结果                     |
| 弹窗/命令面板 | 全局浮层        | 新建任务、打开项目、搜索、快捷命令、设置         |

顶部栏从左到右显示当前项目名、当前 Git 分支、任务模式、运行状态，以及打开终端、
打开 diff、打开浏览器预览、命令面板和设置入口。MVP 任务模式先实现 Local，
Worktree 作为 P1，Cloud 暂缓。

左侧边栏分成四块：

```text
Projects
- project-a
- project-b

Threads
- 修复登录报错
- 解释项目结构
- 添加单元测试

Automations
- 每天检查 CI 报错
- 每周生成代码变更摘要

Bottom
- Skills
- Settings
- User Account
```

Projects 和 Threads 必须支持搜索、折叠和上下文菜单。MVP 右键/更多菜单至少包括：
重命名线程、归档线程、删除线程、在文件管理器中打开项目、刷新 Git 状态。

中间主区域的每条 AI 消息应能展示：

- 可折叠 Plan；
- step list，例如 1/4、2/4；
- 读取文件 chip，例如 `src/App.tsx`；
- 修改文件卡片；
- 命令执行摘要；
- 错误卡片；
- 最终 Summary，列出改了什么、如何验证。

Composer 形态：

```text
[ Attach ] [ @file ] [ /command ] [ text input .......... ] [ Send ]
```

右侧审查面板是核心体验，包含：

| Tab       | 内容                                                                        |
| --------- | --------------------------------------------------------------------------- |
| Changes   | changed files、diff viewer、accept/revert file、accept/revert hunk、comment |
| Files     | 项目文件树、搜索、复制路径、打开文件、让 AI 解释文件                        |
| Artifacts | Markdown、HTML、JSON、测试报告、图片等非代码产物预览                        |
| Summary   | 当前任务完成内容、验证方式、建议下一步                                      |

底部终端抽屉作用域为当前项目或当前线程。MVP 至少支持单终端、命令输出、复制输出、
中止命令、发送输出给 AI；P1 支持 dev/test/git 多终端 tab 和命令历史。

页面和组件清单：

```text
pages/
- WelcomePage           首次启动、登录/API Key、打开项目
- WorkspacePage         主工作台
- SettingsPage          设置
- AutomationsPage       自动化任务，P1
- SkillsPage            技能/工作流，P2

components/
- AppTopBar
- ProjectSidebar
- ThreadList
- ChatThread
- MessageBubble
- Composer
- ApprovalDialog
- ReviewPanel
- DiffViewer
- FileTree
- ArtifactViewer
- TerminalDrawer
- SettingsModal
- CommandPalette
```

核心 UI 数据结构建议：

```ts
type Project = {
  id: string;
  name: string;
  path: string;
  gitBranch?: string;
  lastOpenedAt: number;
};

type Thread = {
  id: string;
  projectId: string;
  title: string;
  mode: 'local' | 'worktree' | 'cloud';
  status: 'idle' | 'running' | 'waiting_approval' | 'done' | 'error';
  createdAt: number;
  updatedAt: number;
};

type Message = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
  metadata?: {
    files?: string[];
    commands?: string[];
    artifacts?: string[];
  };
};

type FileChange = {
  id: string;
  threadId: string;
  filePath: string;
  status: 'added' | 'modified' | 'deleted';
  diff: string;
  accepted: boolean;
};

type CommandRun = {
  id: string;
  threadId: string;
  command: string;
  cwd: string;
  status: 'pending_approval' | 'running' | 'success' | 'failed' | 'denied';
  output: string;
  createdAt: number;
};
```

## 任务模式与核心用户流程

任务模式：

| 模式     | MVP | 说明                                                              |
| -------- | --- | ----------------------------------------------------------------- |
| Local    | 是  | AI 直接在当前项目目录读取和修改文件，所有命令和文件访问受审批控制 |
| Worktree | P1  | 每个任务创建独立 Git worktree，避免多个任务互相污染               |
| Cloud    | 否  | 远程容器或云开发环境，MVP 暂缓                                    |

新建线程弹窗需要包含 task input、mode、permission policy：

```text
New Task

Task:
[ 帮我修复登录页 bug，并保持改动最小 ]

Mode:
(*) Local
( ) Worktree
( ) Cloud

Permissions:
(*) Ask before running commands
( ) Auto-run safe commands
( ) Read-only

[ Create Task ]
```

核心用户流程必须被 E2E 覆盖：

1. 首次使用：打开 app，配置 API key 或登录，选择本地项目目录，扫描项目基本信息，
   显示项目概览，创建第一个 AI task。
2. 修复 bug：用户新建 task，AI 读取相关文件，给出计划，请求运行测试，用户批准，
   AI 修改代码，右侧 Changes 显示 diff，用户添加 inline comment，AI 继续修改，
   用户接受修改并 commit。
3. 解释项目结构：用户输入请求，AI 读取 `package.json`、入口文件、路由文件，
   中间对话输出结构说明，右侧 Summary 显示关键文件列表。
4. 运行测试并修复失败项：AI 请求执行测试，终端显示失败输出，AI 读取日志并修改，
   再次请求运行测试，测试通过后生成总结。

## Electron Main

主进程职责保持薄：

- 创建主窗口，管理 macOS/Windows/Linux 菜单、关闭、重启、深色模式。
- 启动 `DesktopServer`，获得 `serverUrl` 与一次性随机 `serverToken`。
- 通过 preload 暴露 `getServerInfo()`，renderer 再通过 HTTP/WS 连接本地服务。
- 注册安全 IPC：选择目录、打开文件、在系统文件管理器中显示、窗口控制、可选 PTY。
- 管理 `qwen --acp` 子进程生命周期：app 退出时关闭 ACP、清理 pending permission。
- CSP 限制 renderer 只连接 `self`、`http://127.0.0.1:*`、`ws://127.0.0.1:*`。

Preload 只暴露白名单：

```ts
window.qwenDesktop = {
  getServerInfo(): Promise<{ url: string; token: string }>,
  selectDirectory(): Promise<string | null>,
  openPath(path: string): Promise<void>,
  showItemInFolder(path: string): Promise<void>,
  window: { minimize(); maximize(); close(); isMaximized() },
  terminal?: { spawn(); write(); resize(); kill() },
}
```

Renderer 禁用 Node integration，启用 context isolation。禁止 renderer 直接访问
`fs`、`child_process`、任意 IPC channel。

## DesktopServer

`DesktopServer` 是 Electron main 内部启动的 Node HTTP/WS 服务，绑定
`127.0.0.1` 随机端口。所有 REST 请求要求：

- `Authorization: Bearer <serverToken>`
- `Origin` 必须为 app 允许来源或为空
- WebSocket 使用 `ws://127.0.0.1:{port}/ws/{sessionId}?token=...`

核心模块：

| 模块               | 职责                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AcpProcessClient` | spawn `qwen --acp --channel=Desktop`，建立 `ClientSideConnection`，封装 initialize/auth/session/prompt/cancel/mode/model/extMethod |
| `AcpEventRouter`   | 将 ACP `sessionUpdate` 按 sessionId 分发到 `SessionSocketHub`，复用 VS Code 的更新转换逻辑                                         |
| `permissionBridge` | 将 ACP `requestPermission` / ask-user-question 转为 WS 请求，等待 renderer 回包，超时默认 cancel                                   |
| `SessionSocketHub` | 管理每个 session 的 WS 客户端、心跳、重连、pending 消息、广播                                                                      |
| `sessionService`   | 对 `SessionService` 和 ACP session API 做薄封装，提供列表、历史、创建、恢复、重命名、删除                                          |
| `projectService`   | 管理最近项目、项目元数据、Git 分支、当前 workspace 范围校验                                                                        |
| `gitService`       | 读取 status/diff、stage/unstage/revert、commit，禁止默认 push/force push                                                           |
| `reviewService`    | 将 Git diff 转为右侧 Changes 面板数据，支持 file/hunk accept、revert、comment                                                      |
| `settingsService`  | 读写 `~/.qwen/settings.json`，复用 `Storage`、Coding Plan 常量、modelProviders 结构                                                |
| `runtimeService`   | 当前 session 的 model、approval mode、auth/account info、available commands/skills                                                 |
| `terminalService`  | 管理 scoped terminal，限制 cwd 到当前项目，输出流推送到 renderer，支持中止和输出摘要                                               |
| `artifactService`  | 管理 AI 生成的 Markdown/HTML/JSON/测试报告等产物，提供右侧 Artifacts 预览数据                                                      |

REST API MVP：

| Method    | Path                               | 说明                                                     |
| --------- | ---------------------------------- | -------------------------------------------------------- |
| `GET`     | `/health`                          | 本地服务健康检查                                         |
| `GET`     | `/api/runtime`                     | CLI 路径、版本、平台、当前 auth/account 摘要             |
| `GET`     | `/api/projects`                    | 最近项目列表，含 name/path/gitBranch/lastOpenedAt        |
| `POST`    | `/api/projects/open`               | 选择或注册本地项目目录，刷新 Git 元数据                  |
| `GET`     | `/api/sessions?cwd=&cursor=&size=` | 使用 core `SessionService` 或 ACP list 列出会话          |
| `POST`    | `/api/sessions`                    | 创建新 ACP session，body: `{ cwd }`                      |
| `POST`    | `/api/sessions/:id/load`           | 恢复历史 session，调用 ACP `loadSession`                 |
| `GET`     | `/api/sessions/:id/messages`       | 从 Qwen JSONL 重建历史消息，供 UI 首屏渲染               |
| `PATCH`   | `/api/sessions/:id`                | rename，优先 ACP `extMethod('renameSession')`            |
| `DELETE`  | `/api/sessions/:id`                | delete，优先 ACP `extMethod('deleteSession')`            |
| `GET`     | `/api/sessions/:id/slash-commands` | 返回缓存的 `available_commands_update`                   |
| `GET`     | `/api/sessions/:id/summary`        | 当前任务摘要、验证结果、下一步建议                       |
| `GET`     | `/api/sessions/:id/artifacts`      | 当前任务产生的 artifacts 列表与预览元数据                |
| `GET`     | `/api/models`                      | 当前模型和可用模型，来自 ACP `NewSessionResponse.models` |
| `PUT`     | `/api/sessions/:id/model`          | 调用 ACP `unstable_setSessionModel`                      |
| `GET/PUT` | `/api/sessions/:id/mode`           | 读取/设置 approval mode                                  |
| `GET`     | `/api/projects/:id/git/status`     | 当前分支、modified/staged/untracked 数量                 |
| `GET`     | `/api/projects/:id/git/diff`       | changed files 与 unified diff/hunk 数据                  |
| `POST`    | `/api/projects/:id/git/revert`     | 按 all/file/hunk 撤销未提交改动                          |
| `POST`    | `/api/projects/:id/git/stage`      | 按 all/file/hunk stage，作为 accept 的实现基础           |
| `POST`    | `/api/projects/:id/git/commit`     | 使用用户确认的 commit message 创建提交                   |
| `POST`    | `/api/terminals`                   | 创建当前项目/线程作用域的 terminal                       |
| `POST`    | `/api/terminals/:id/write`         | 写入终端 stdin                                           |
| `POST`    | `/api/terminals/:id/kill`          | 中止终端当前进程或关闭 terminal                          |
| `GET/PUT` | `/api/settings/user`               | 读写桌面设置和 `~/.qwen/settings.json`                   |
| `POST`    | `/api/auth/:method`                | 调用 ACP `authenticate` 或写入 API key 后重连            |

WS 协议 MVP：

```ts
type ClientMessage =
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[] }
  | { type: 'permission_response'; requestId: string; optionId: string }
  | {
      type: 'ask_user_question_response';
      requestId: string;
      optionId: string;
      answers?: Record<string, string>;
    }
  | {
      type: 'set_permission_mode';
      mode: 'plan' | 'default' | 'auto-edit' | 'yolo';
    }
  | { type: 'set_model'; modelId: string }
  | {
      type: 'git_review_comment';
      filePath: string;
      line?: number;
      body: string;
    }
  | {
      type: 'terminal_output_to_prompt';
      terminalId: string;
      range?: OutputRange;
    }
  | { type: 'stop_generation' }
  | { type: 'ping' };

type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | {
      type: 'message_delta';
      role: 'assistant' | 'thinking' | 'user';
      text: string;
    }
  | { type: 'tool_call'; data: ToolCallUpdateData }
  | { type: 'plan'; entries: PlanEntry[] }
  | {
      type: 'permission_request';
      requestId: string;
      request: RequestPermissionRequest;
    }
  | {
      type: 'ask_user_question';
      requestId: string;
      request: AskUserQuestionRequest;
    }
  | { type: 'usage'; data: UsageStatsPayload }
  | { type: 'mode_changed'; mode: string }
  | {
      type: 'available_commands';
      commands: AvailableCommand[];
      skills: string[];
    }
  | { type: 'file_reference'; filePath: string; reason?: string }
  | {
      type: 'file_change';
      filePath: string;
      status: 'added' | 'modified' | 'deleted';
    }
  | {
      type: 'git_status';
      branch: string | null;
      modified: number;
      staged: number;
      untracked: number;
    }
  | {
      type: 'terminal_output';
      terminalId: string;
      text: string;
      stream: 'stdout' | 'stderr';
    }
  | {
      type: 'terminal_exit';
      terminalId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: 'message_complete'; stopReason?: string }
  | { type: 'error'; message: string; code: string; retryable?: boolean }
  | { type: 'pong' };
```

## 会话生命周期

1. Renderer 启动后调用 `getServerInfo()`，配置 API base URL 和 token。
2. `projectStore.fetchProjects()` 从 `/api/projects` 拉取最近项目和 Git 元数据。
3. 用户选择项目目录后，`POST /api/projects/open` 注册项目，刷新 branch/status。
4. `sessionStore.fetchSessions()` 按项目从 `/api/sessions?cwd=` 拉取历史线程。
5. 用户新建线程时选择 mode/permissions；MVP mode 为 Local，调用 ACP
   `newSession({ cwd })`。
6. Server 缓存 session 的 models、modes、commands、skills，并打开 WS。
7. 用户发送消息，WS handler 调用 `acp.prompt({ sessionId, prompt })`。
8. ACP agent 在 CLI 子进程内复用 core：配置、认证、模型、工具、权限、hooks、录制。
9. `sessionUpdate` 流式回到 server，server 归一化后推给 renderer。
10. 工具需要权限时，ACP `requestPermission` 被 server 转为 WS 请求；renderer 展示
    `@qwen-code/webui` 的 `PermissionDrawer`，响应后 server resolve ACP promise。
11. AI 修改文件后，renderer 刷新 `/api/projects/:id/git/diff`，右侧 Changes 面板
    展示 changed files、diff 和 accept/revert/comment 操作。
12. 用户审查完成后，可以 stage/accept 改动并通过 `/api/projects/:id/git/commit`
    创建提交；push 和 PR 不属于 P0 默认操作。
13. 生成结束后，server 发送 `message_complete`，renderer 刷新 usage、session
    summary、Git status 和 session 列表。
14. App 退出时 main 关闭 WS、停止 server、终止 ACP 子进程和 scoped terminals。

并发约束：

- 同一个 session 只允许一个 active prompt；后续消息可排队或提示当前正在生成。
- 不同 session 可以共享同一个 ACP 子进程；如果发现单进程互相影响，再演进为
  per-workspace ACP process pool。
- permission request 必须有超时，默认选择 cancel，避免窗口关闭后 ACP 永久挂起。

## 配置与认证复用

桌面端不维护独立配置格式。用户设置仍写入：

- 全局：`~/.qwen/settings.json`
- 项目：`<workspace>/.qwen/settings.json`
- runtime output：沿用 `Storage.getRuntimeBaseDir()` 与 `QWEN_RUNTIME_DIR`

复用策略：

- 认证真实执行仍通过 `qwen --acp` 的 `authenticate()` 与 `Config.refreshAuth()`。
- API key / Coding Plan 表单复用 VS Code `settingsWriter.ts` 的逻辑，但应抽成
  非 VS Code 依赖的共享模块，避免复制两份 JSON 写入规则。
- 模型列表来自 `Config.getAllConfiguredModels()` 经 ACP 返回，桌面不自己推断 provider。
- approval mode 使用 Qwen 的 `plan/default/auto-edit/yolo`，不引入
  `cc-haha` 的 `bypassPermissions` 命名。
- 权限持久化仍走 core `PermissionManager` 与 settings 中的 `permissions.allow/ask/deny`。

Settings 页面采用左侧分类 + 右侧表单布局。MVP 分类：

| 分类          | MVP 设置项                                                     |
| ------------- | -------------------------------------------------------------- |
| General       | 默认项目目录、默认打开方式、多行输入快捷键、长任务防止睡眠     |
| Model         | API provider、model、API key、reasoning effort、temperature    |
| Permissions   | 文件访问范围、命令运行策略、网络访问、高危命令确认、审批白名单 |
| Git           | 默认 branch 命名规则、是否允许 push、commit message 生成规则   |
| Terminal      | 默认 shell、环境变量、输出最大行数、命令超时                   |
| Appearance    | Light/Dark/System、UI font、code font、font size、accent color |
| Notifications | 任务完成、需要审批、自动化任务结果、后台运行通知               |

Browser、Integrations、Memories、Advanced 可以先放入口或占位，真实能力进入 P1/P2。

## 渲染进程与状态管理

Renderer 使用 React + Vite + Zustand。主界面必须是工作台，而不是只有聊天窗口。
UI 不复刻 VS Code WebView，但复用 `@qwen-code/webui` 中适合桌面端的消息、
工具、权限和输入组件：

- 消息：`UserMessage`、`AssistantMessage`、`ThinkingMessage`、`WaitingMessage`
- 工具：shared ToolCall components、`ToolCallContainer`、`AgentToolCall`
- 权限：`PermissionDrawer`、`AskUserQuestionDialog`
- 输入：`InputForm`、`CompletionMenu`、`SessionSelector`
- 历史只读视图：`ChatViewer`

推荐 stores：

| Store           | 状态                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `projectStore`  | recent projects、activeProjectId、git branch/status、open/refresh/remove project          |
| `sessionStore`  | thread list、activeSessionId、mode、status、create/load/archive/delete/rename             |
| `chatStore`     | per-thread messages、plan、steps、file refs、tool calls、permission、usage、commands      |
| `reviewStore`   | changed files、selected file、diff hunks、accept/revert/comment、commit draft             |
| `artifactStore` | generated artifacts、preview selection、test reports、summary data                        |
| `modelStore`    | current model、available models、per-session model override                               |
| `settingsStore` | auth/account、approval mode、theme、editor、terminal shell、Git options、desktop settings |
| `uiStore`       | sidebar collapsed、right panel tab、terminal drawer、command palette、dialogs             |
| `terminalStore` | scoped terminal tabs、command output、running state、history、output selection            |

数据流：

```text
Component → Zustand action → REST/WS → DesktopServer → ACP → core/CLI
          ← Zustand reducer ← WS event ← DesktopServer ← ACP sessionUpdate
```

首屏建议是 Welcome + Workspace 的组合：首次没有项目时展示登录/API key、Open
Project、最近项目；有项目后进入 WorkspacePage。WorkspacePage 必须包含顶部栏、
左侧 Projects/Threads、中心 ChatThread、右侧 ReviewPanel、底部 TerminalDrawer。

## 命令执行与终端

Agent 的 shell/file/tool 执行不由 Electron 实现，继续由 core 工具系统执行：

- ShellTool/Edit/Write/Read/WebFetch/MCP 等工具保持现状。
- Desktop 只负责展示 tool_call、diff、输出、权限确认。
- 这样 CLI、VS Code、Desktop 的安全语义一致。

P0 需要内置 scoped terminal，但它是用户终端，不是 agent 工具系统的替代：

- 使用仓库已有 optional dependency `@lydell/node-pty`。
- Electron main 暴露 `terminal:spawn/write/resize/kill` IPC。
- 终端 cwd 默认当前 session workspace。
- 终端支持展开/收起、复制输出、清空显示、中止命令、把选中输出发送给 AI。
- MVP 支持单 terminal；P1 支持 dev server、test、git 多 terminal tab。
- AI 要运行命令时仍走 ACP/core permission flow，并在对话中展示审批卡片；
  终端抽屉显示命令输出和测试结果，但不能绕过命令审批。
- 高风险命令如 `rm -rf`、`sudo`、删除大量文件、force push、网络安装依赖等必须
  高亮风险，并要求用户明确确认。

## 与 cc-haha 的差异化适配

| cc-haha 设计                     | Qwen Desktop 适配                                                   |
| -------------------------------- | ------------------------------------------------------------------- |
| Tauri/Rust 主进程                | Electron main，Node 原生能力更强                                    |
| Bun compiled server sidecar      | MVP 不需要 server sidecar，main 内启动 Node DesktopServer           |
| Server spawn 每个 session 的 CLI | 默认一个 ACP 子进程管理多个 Qwen sessions                           |
| stream-json 翻译成 WS 事件       | 复用 ACP `sessionUpdate` 和 requestPermission                       |
| `~/.claude` 会话解析             | 复用 `~/.qwen`、`Storage`、`SessionService`、`ChatRecordingService` |
| 独立 React 组件体系              | 复用 `@qwen-code/webui` 和 VS Code 的事件转换经验                   |
| Tauri commands 做 native bridge  | Electron preload + typed IPC 白名单                                 |

## 安全模型

- 本地 server 只绑定 `127.0.0.1`，使用随机端口和随机 token。
- REST 必须校验 bearer token；WS token 放 query 并在握手时校验。
- Renderer 无 Node integration，preload 只暴露白名单 API。
- 禁止任意命令 IPC；用户命令执行只能通过 Qwen 工具系统或可选 terminal。
- 权限请求必须显示 tool name、kind、input、diff/command/path，并支持 deny。
- 默认 AI 只能访问当前项目目录。跨目录文件读取/修改必须被权限层拦截或显式审批。
- 默认命令策略是 Ask every time。Read-only 和 Auto-approve safe commands 作为
  新建线程与设置页可选权限模式。
- 文件修改必须通过右侧 diff 审查面板可见，用户可以接受或撤销；不得把修改结果
  只藏在聊天消息里。
- 网络访问由设置控制，MVP 默认保守；远程 URL 访问、安装依赖、push 等动作必须
  进入审批流程。
- App 退出、窗口关闭、WS 断开时，pending permission 默认 cancel。
- 外部链接用 `shell.openExternal`，需要 URL scheme allowlist。
- 打包时 CSP 禁止远程 script，允许本地 server connect-src。
- Chrome DevTools Protocol 只在显式开发/测试模式启用，默认生产关闭。启用时
  只能绑定 `127.0.0.1`，端口来自 `QWEN_DESKTOP_CDP_PORT` 或专用测试脚本，
  不允许监听公网地址。

## E2E 与 Chrome DevTools MCP 方案

桌面端必须把 E2E 当作 MVP 验收的一部分，而不是只依赖单元测试和 smoke test。
方案分三层：

1. **协议层 E2E**：启动 `DesktopServer` + fake ACP agent，覆盖 REST/WS 协议、
   token 校验、session 创建、消息发送、permission request/response、model/mode
   切换。此层运行快，适合放在 `packages/desktop` 的 vitest 测试中。
2. **真实 Electron E2E**：使用 Playwright Electron 启动 `packages/desktop`，
   注入临时 HOME/QWEN_RUNTIME_DIR/workspace 和 fake ACP CLI，断言首屏不是黑屏、
   `Connected` 状态出现、选择目录、新建会话、发送消息、停止生成、权限弹层响应、
   settings 保存、模型/模式选择。测试应收集 screenshot、console errors、failed
   requests 和主进程日志，失败时写入 `.qwen/e2e-tests/electron-desktop/`。
3. **打包后 E2E / smoke**：先 `npm run build && npm run bundle`，再
   `npm run package:dir --workspace=packages/desktop`。启动打包目录中的 app，验证
   renderer、preload、bundled CLI、`ELECTRON_RUN_AS_NODE=1` ACP 子进程都能工作。

为了让 Codex、Ralph 或人工调试工具能看到真实 Electron renderer，桌面端要提供
Chrome DevTools MCP 可访问入口：

- Electron main 在 `app.whenReady()` 之前读取 `QWEN_DESKTOP_CDP_PORT`。存在时调用
  `app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')` 和
  `app.commandLine.appendSwitch('remote-debugging-port', port)`。
- 新增或保留一个开发脚本，例如
  `QWEN_DESKTOP_CDP_PORT=9222 npm run start --workspace=packages/desktop`。脚本启动后，
  chrome-devtools-mcp 连接 `http://127.0.0.1:9222`，选择 `Qwen Code` renderer page。
- E2E harness 启动 app 后读取 CDP endpoint，至少验证：
  - page URL 是 `file://.../packages/desktop/dist/renderer/index.html` 或 dev-server URL；
  - DOM 中存在 `Qwen Code`、`Connected`、`Runtime`、`Settings`；
  - console 没有 uncaught exception；
  - network 没有 renderer asset 404；
  - screenshot 不是纯黑或空白。
- Chrome DevTools MCP 用于可视检查和调试，不替代可重复的 Playwright/Vitest E2E。
  如果 MCP 能看到问题，必须把复现步骤固化为自动化 E2E 或在
  `.qwen/e2e-tests/electron-desktop/` 记录不能自动化的原因。

## 实施阶段

### Phase 0: E2E Harness 与可观测性

- 新增/完善 desktop E2E harness，支持 fake ACP、临时 HOME/QWEN_RUNTIME_DIR、
  临时 workspace、截图、console/network 诊断。
- 开发/测试模式支持 `QWEN_DESKTOP_CDP_PORT`，chrome-devtools-mcp 能连接 renderer
  并检查首屏、console、network。
- 建立 “首屏不是黑屏” E2E：启动 app，断言 `Qwen Code`、`Open Project`、
  `Settings`、空项目状态可见。

### Phase 1: 桌面壳、本地服务与 Welcome

- 新增/整理 `packages/desktop` workspace。
- Electron main/preload/renderer 骨架。
- Main 启动 `DesktopServer`，renderer 获取 server URL。
- `/health`、token 校验、窗口菜单、选择目录。
- WelcomePage：API key/login 入口、Open Project、最近项目空状态。
- E2E：首次启动、服务 connected、选择临时项目目录、最近项目持久化。

### Phase 2: Workspace 三栏布局与项目/线程模型

- AppTopBar、ProjectSidebar、ThreadList、ChatThread、ReviewPanel、
  TerminalDrawer、CommandPalette 骨架。
- Project store 和 Thread store；左侧 Projects/Threads 支持搜索、折叠、上下文菜单。
- 顶部栏显示项目名、Git branch、mode、status、terminal/diff/settings 快捷按钮。
- E2E：打开项目后进入 WorkspacePage，创建 Local thread，切换线程，刷新 Git 状态。

### Phase 3: ACP 会话链路与 AI 对话

- 实现 `AcpProcessClient`，spawn `qwen --acp --channel=Desktop`。
- 实现 session create/load/list/prompt/cancel/mode/model。
- 实现 WS per-session 通道和 `QwenSessionUpdateHandler` 风格的事件转换。
- ChatThread 展示用户消息、AI 消息、Plan、steps、file refs、tool calls、usage。
- E2E：fake ACP 返回计划、文件引用、assistant delta、tool update、final summary。

### Phase 4: 权限、命令审批与终端抽屉

- 接入 permission request 和 ask-user-question。
- ApprovalDialog 支持 Approve once、Approve for this thread、Deny。
- TerminalDrawer 支持 scoped terminal、命令输出、复制、清空、中止、发送给 AI。
- 高风险命令高亮并二次确认；终端不能绕过 agent 命令审批。
- E2E：命令审批 pending/running/denied/success；终端输出可见并可发送给 AI。

### Phase 5: Diff Review、文件树、Artifacts 与 Commit

- gitService/reviewService 支持 status、diff、accept/revert all/file/hunk、comment。
- Right panel tabs：Changes、Files、Artifacts、Summary。
- DiffViewer 支持文件树、hunk 展示、inline comment、Open in Editor。
- Commit UI：commit message 输入、stage/commit、失败提示；push/PR 留到 P1。
- E2E：fake file change 后 Changes 显示 diff；accept/revert/commit 流程可验证。

### Phase 6: 设置、认证、模型与打包

- 抽取 VS Code settings writer 的通用部分。
- SettingsPage/SettingsModal 覆盖 General、Model、Permissions、Git、Terminal、
  Appearance、Notifications。
- 实现 Coding Plan / OpenAI-compatible provider 配置 UI。
- 打包包含 `dist/cli.js`、vendor ripgrep、native optional deps。
- 生产态使用 `ELECTRON_RUN_AS_NODE=1` 启动 CLI ACP 子进程。
- E2E/smoke：settings 保存后刷新仍保留；打包产物能加载 renderer 并启动 bundled CLI ACP。

### P1/P2 后续阶段

- P1：Worktree 并行任务、浏览器预览、页面批注、自动化任务、slash commands、
  拖拽文件/图片、浮动小窗、通知、主题/编辑器增强、GitHub PR review context。
- P2：Skills 工作流、MCP/插件系统、Web Search、Memories、IDE 同步、Computer Use。

## 测试计划

单元测试：

- `AcpProcessClient`：mock `ClientSideConnection`，覆盖 initialize/new/load/prompt/cancel。
- `AcpEventRouter`：覆盖 message/tool/plan/usage/available_commands 映射。
- `permissionBridge`：覆盖 allow/deny/timeout/window closed。
- `settingsService`：使用临时 `QWEN_RUNTIME_DIR` / HOME，验证 settings JSON 写入。
- renderer stores：连接、发送、streaming、tool update、permission 状态。

集成测试：

- 启动 DesktopServer + fake ACP agent，验证 REST/WS 协议。
- 启动真实 `qwen --acp`，用临时 workspace 创建 session，发送简单 prompt。
- 验证 session JSONL 可被 core `SessionService` 读取。

E2E：

- `packages/desktop` 增加 Electron E2E harness。优先使用 Playwright Electron；
  如果仓库不引入额外 Playwright 依赖，则用 Electron 的 CDP endpoint 配合
  chrome-devtools-mcp/DevTools Protocol 做可视与 DOM 断言，但最终仍要沉淀成可重复
  的自动化测试。
- 每个用户可见行为切片必须先写 E2E 场景，至少覆盖：
  - 首次使用：启动 app 后首屏不是黑屏，配置 API key/login 入口可见，选择临时
    项目目录后进入 Workspace；
  - 修复 bug：新建 Local thread，发送“修复登录页点击无反应”，fake ACP 返回计划、
    文件读取、命令审批、文件修改，右侧 Changes 显示 diff，用户 comment 后继续修改，
    最后 accept 并 commit；
  - 解释项目结构：fake ACP 读取 `package.json`、入口文件、路由文件，中心消息和
    Summary tab 显示关键文件列表；
  - 运行测试并修复失败项：命令审批 `npm test`，终端显示失败输出，AI 修改文件，
    再次请求测试，最终 Summary 标记测试通过；
  - 权限与安全：permission request 和 ask-user-question 能从 renderer 响应到 fake ACP，
    denied/timeout 都有清晰 UI 状态；
  - 设置：settings/auth/model/mode/terminal/theme 保存后刷新仍保留；
  - 取消生成：会调用 ACP cancel 并更新 UI；
  - 打包目录启动后 renderer asset、preload、bundled CLI ACP 都可用。
- E2E 运行时必须收集失败诊断：Electron main stderr/stdout、renderer console、
  failed network requests、截图、CDP page list、DesktopServer URL/token 状态摘要。
- chrome-devtools-mcp 调试路径必须纳入验收：使用固定本地 CDP 端口启动 app，
  通过 MCP 连接 renderer，确认页面 URL、DOM、console/network 状态。发现黑屏或
  asset 404 时先修复 Vite base/path，再重跑 E2E。

验收命令后续应接入：

```bash
npm run build
npm run typecheck
npm test --workspace=packages/desktop
npm run test:e2e --workspace=packages/desktop
npm run package:dir --workspace=packages/desktop
npm run smoke:package --workspace=packages/desktop
npm run smoke:package --workspace=packages/desktop -- --launch
```

## 风险与应对

| 风险                              | 应对                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| Electron 内置 Node 版本不满足 CLI | 固定 Electron 版本时校验 Node >=20；CI 加 smoke test                      |
| packaged app 无法启动 CLI JS      | 生产态使用 `ELECTRON_RUN_AS_NODE=1`；明确资源路径；打包 smoke test        |
| ACP 单进程多 session 互相影响     | 先复用现有 ACP；若发现阻塞，升级为 per-workspace process pool             |
| VS Code settings writer 被复制    | 抽成 core/desktop 共用的 settings writer 模块                             |
| 本地 server 被其他本地进程调用    | 127.0.0.1 + random token + origin 校验                                    |
| native deps 打包遗漏              | 列出 `@lydell/node-pty`、ripgrep、clipboard 等资源清单；打包后 smoke test |
| renderer 与 ACP 事件类型漂移      | 复用/抽取 `QwenSessionUpdateHandler` 测试夹具                             |
| MVP 退化成聊天壳                  | 每个切片必须保留工作台布局和右侧审查/底部终端可见验收                     |
| hunk 级 accept/revert 误伤代码    | 优先使用 Git/index 或结构化 patch API；E2E 覆盖 file/hunk 操作            |
| 终端绕过命令审批                  | 用户 terminal 和 agent command permission 分离；AI 命令仍走 ACP 审批      |

## 开放问题

- 桌面端是否需要第一版就支持多窗口，还是先单窗口多 tab？
  - 单窗口多 tab
- 是否把 `AcpProcessClient` 抽成 `packages/acp-client`，供 VS Code、channels、desktop 共用？
  - 不需要，先放 desktop 内部
- Desktop settings UI 是只覆盖认证/模型/权限，还是完整暴露 `settings.json`？
  - MVP 覆盖 General、Model、Permissions、Git、Terminal、Appearance、Notifications；
    不直接暴露完整 JSON 编辑器
- 是否在 MVP 中内置 terminal，还是先专注 chat/workspace？
  - MVP 需要 scoped terminal drawer，但它是用户终端，不绕过 agent 命令审批
- 是否需要独立桌面命令 `qwen desktop` 启动 Electron？
  - 不需要
