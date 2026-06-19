# Phase 3：Web Cockpit 可用性闭环研发计划

## 阶段目标

将 `packages/web` 从“能看、能连、能展示”的 Web Cockpit 原型推进到“用户可以稳定完成一次完整任务”的可用状态。

用户打开 Web 页面后，应能完成以下闭环：

1. 自动连接正确 workspace daemon。
2. 在首页输入消息并发送。
3. 查看模型响应、工具调用和任务状态。
4. 浏览当前 workspace 文件。
5. 查看会话历史并恢复会话。
6. 遇到 daemon 未启动、workspace mismatch、session bridge 失败等问题时，页面给出明确引导。

## 当前基础

已完成：

- `packages/web` Vite React 应用骨架。
- 复用 `@qwen-code/web-shell` 的 Chat 能力。
- 接入 daemon providers / hooks。
- 初版页面：
  - 首页 / Chat
  - 会话
  - 文件
  - MCP
  - 工具
  - 技能
  - 记忆
  - 设置
- 浅色 Qoder / Codex 风格视觉改造。
- 右侧任务流程 rail 的基础展示。

## Phase 3.1：开发启动体验优化

### 目标

解决 `web` 和 `daemon` 独立启动导致的连错 daemon、workspace mismatch、输入框不可用等问题。

### 研发内容

- 增加一条命令启动当前 workspace daemon 和 Web dev server。
- Web dev server 自动注入正确的 `QWEN_DAEMON_URL`。
- 避免默认误连 `127.0.0.1:4170` 上其他 workspace 的 daemon。

建议命令：

```bash
npm run dev:web
```

### 可能涉及文件

- `package.json`
- `scripts/daemon-dev.js` 或新增 `scripts/web-dev.js`
- `packages/web/vite.config.ts`

### 验收标准

- 从 repo 根目录执行一条命令即可访问 Web 页面。
- 页面默认连接当前 workspace daemon。
- 首页输入框默认可用。

## Phase 3.2：Daemon 连接状态和错误引导

### 目标

当 daemon 不可用或 session 初始化失败时，页面不要只显示 `加载中...`，而是给出清晰错误和修复建议。

### 需要覆盖的场景

- daemon 未启动。
- daemon 端口不可访问。
- daemon 绑定 workspace 与当前页面请求 workspace 不一致。
- `/session` 返回 500。
- `AcpSessionBridge initialize timed out`。
- token 缺失或鉴权失败。

### 研发内容

- 在 Chat 首页增加连接错误状态。
- 顶部状态 pill 可点击查看连接详情。
- 显示 daemon URL、workspace cwd、session id、最近错误和建议修复命令。

### 可能涉及文件

- `packages/web/src/layout/WebAppShell.tsx`
- `packages/web/src/features/chat/ChatPane.tsx`
- `packages/web/src/styles.css`
- 可新增 `packages/web/src/features/diagnostics/ConnectionDiagnostics.tsx`

### 验收标准

- daemon 未启动时，页面有明确错误提示。
- workspace mismatch 时，页面能显示 bound workspace 和 requested workspace。
- 用户能根据页面提示启动正确服务。

## Phase 3.3：会话管理增强

### 目标

让“会话”页成为真正可用的 session 工作台。

### 研发内容

- 当前会话高亮。
- 展示最近更新时间、模型、workspace、状态。
- 支持从会话列表恢复会话。
- 支持新建、重命名、关闭 / 释放会话。
- URL 同步为 `/session/:sessionId`。

### 可能涉及文件

- `packages/web/src/features/sessions/SessionsPanel.tsx`
- `packages/web/src/App.tsx`
- `packages/web/src/providers/DaemonProviders.tsx`

### 验收标准

- 用户可以从会话页恢复历史会话。
- 刷新 `/session/:sessionId` 后可以继续加载对应会话。
- 当前会话在列表中明确标识。

## Phase 3.4：文件浏览和预览增强

### 目标

把 Files 面板升级为可辅助 Chat 的 workspace 文件浏览器。

### 研发内容

- 目录层级导航。
- 面包屑。
- 文件类型标识。
- 搜索 / glob 快捷入口。
- 大文件保护提示。
- 支持常见文件预览：文本、Markdown、JSON、图片、HTML / PDF iframe。
- 提供“复制路径”或“引用到输入框”操作。

### 可能涉及文件

- `packages/web/src/features/files/FilesPanel.tsx`
- `packages/web/src/features/chat/ChatPane.tsx`
- `packages/web/src/styles.css`

### 验收标准

- 能稳定浏览当前 workspace 文件。
- 能预览常见文本和图片。
- 能把文件路径用于 Chat 输入。

## Phase 3.5：右侧任务流程 Rail 数据化

### 目标

将当前静态 `任务流程` rail 改为展示真实 session 和任务上下文。

### 第一阶段展示内容

- 当前 daemon 状态。
- 当前 session id。
- 当前模型。
- 当前 cwd。
- 当前 active todos。
- 当前 pending permissions。
- 当前生成文件 / artifacts 的占位信息。

### 暂不做

- 不新增完整任务系统。
- 不做复杂 timeline。
- 不做自动 artifact 索引。

### 可能涉及文件

- `packages/web/src/layout/WebAppShell.tsx`
- 可新增 `packages/web/src/layout/TaskRail.tsx`

### 验收标准

- Chat 过程中右侧 rail 能显示当前任务状态。
- 有 pending permission 时能明确提示。
- 无任务时保持轻量空状态。

## Phase 3.6：设置 / 工具 / MCP / 技能管理可操作化

### 目标

将管理页面从只读展示推进到可执行常用操作。

### P0

- Settings 页面查看当前配置。
- Tools 页面查看工具状态。
- MCP 页面查看 server 状态。
- Skills 页面支持运行 skill 或复制 skill 名称。

### P1

- Tools 开关可操作。
- MCP server 详情。
- Skill 搜索和分类。
- Memory 编辑保存体验优化。

### P2

- MCP OAuth / reconnect 操作。
- Skills marketplace 类体验。
- 多 scope settings 编辑。

### 可能涉及文件

- `packages/web/src/features/settings/SettingsPanel.tsx`
- `packages/web/src/features/tools/ToolsPanel.tsx`
- `packages/web/src/features/mcp/McpPanel.tsx`
- `packages/web/src/features/skills/SkillsPanel.tsx`
- `packages/web/src/features/memory/MemoryPanel.tsx`

### 验收标准

- 每个管理页都有明确 loading / error / empty / data 状态。
- 常用操作能成功调用 daemon action。
- 操作失败有明确错误提示。

## Phase 3.7：基础路由和 URL 状态

### 目标

让 Web 页面支持刷新恢复和 URL 分享。

### 建议路径

```text
/                   -> 首页
/session/:sessionId -> 指定会话
/sessions           -> 会话列表
/files              -> 文件
/files?path=xxx     -> 指定文件预览
/mcp                -> MCP
/tools              -> 工具
/skills             -> 技能
/memory             -> 记忆
/settings           -> 设置
```

### 研发策略

先不引入大型 router，可使用轻量 URL 解析和 `window.history.pushState`。

### 可能涉及文件

- `packages/web/src/App.tsx`
- `packages/web/src/layout/views.ts`

### 验收标准

- 刷新页面后仍停留在当前 view。
- 打开 `/session/:sessionId` 可以恢复会话。
- 打开 `/files?path=package.json` 可以直接预览文件。

## Phase 3.8：验证体系补齐

### 自动化检查

主入口：

```bash
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run validate:web
```

拆分排障：

```bash
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run build --workspace=packages/web
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run typecheck --workspace=packages/web
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run test --workspace=packages/web
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run lint --workspace=packages/web
```

运行中 Web / daemon proxy smoke：

```bash
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run dev:web
PATH="/Users/jifeng/.nvm/versions/node/v24.14.0/bin:$PATH" npm run smoke:web
```

### 浏览器验证

使用 Chrome DevTools MCP 或人工访问验证真实浏览器交互：

1. 首页输入框可输入。
2. 可以发送一条消息。
3. 会话页能看到当前 session。
4. 文件页能预览 `package.json`。
5. 刷新 `/session/:sessionId` 可恢复。
6. `/mcp`、`/tools`、`/skills`、`/memory`、`/settings` 不出现空白页。
7. daemon 关闭后页面有明确错误。
8. 重启 daemon 后页面可恢复连接。

## 推荐开发顺序

### Sprint 1：稳定打开和输入

- 增加 `dev:web` 启动脚本。
- Web 默认使用正确 daemon URL。
- 增加 daemon/session 错误引导。
- 验证输入框始终可用。

### Sprint 2：会话闭环

- URL 支持 `/session/:sessionId`。
- 会话列表恢复 session。
- 当前 session 高亮。
- 新建 / 重命名 / 释放会话。

### Sprint 3：文件和 Chat 联动

- 文件树优化。
- 文件预览增强。
- 文件路径引用到 Chat。
- 右侧 rail 显示当前 cwd / session / todos。

### Sprint 4：管理面板可操作化

- Settings 操作。
- Tools 操作。
- MCP 状态和 reconnect。
- Skills 搜索和运行。

## 明确非目标

下一阶段暂不做：

- 完整 Automations。
- 内置 Browser Pane。
- 复杂多 workspace orchestrator。
- 替换 `web-shell` 内部 Chat 实现。
- 引入大型 UI 框架。
- desktop 级 native integration。

## 下一步建议

优先实施：

```text
Phase 3.1 + Phase 3.2
```

即先解决：

1. 一条命令启动 Web + 当前 workspace daemon。
2. 页面遇到 daemon/session 错误时有明确提示。
3. 避免再次出现“页面能打开但输入框不能输入”的情况。
