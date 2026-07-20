# @qwen-code/web-shell

Qwen Code Web Shell 是面向浏览器的 daemon 会话终端 UI，可以作为 React
组件嵌入到其他项目中。

## 环境要求

- React：`^18.0.0 || ^19.0.0`
- React DOM：`^18.0.0 || ^19.0.0`
- `@qwen-code/webui`：`>=0.0.1`
- `@qwen-code/sdk`：`>=0.1.8`
- 浏览器环境需要能访问 Qwen Code daemon serve 的 HTTP 接口。

组件包会自动注入自身的 CSS（包括 Tailwind 编译产物），接入方不需要配置
Tailwind 或额外引入全局 CSS。

## Tailwind 与 shadcn/ui

Web Shell 已配置 Tailwind CSS v4 和 shadcn/ui。shadcn 的 token 仅用于新增的
Tailwind/shadcn 组件；现有 CSS Modules 的主题色值保持不变。组件代码在仓库内，
可直接修改。

### 新增 UI 的约定

- 新增通用 UI 或交互组件时，优先使用 shadcn/ui 已提供的组件，再根据 Web Shell
  的需求修改生成到仓库中的源码。已有且稳定的 CSS Modules 组件不要求为了统一而
  重写。
- Tailwind class 使用标准的无前缀写法，例如 `flex gap-2`。发布构建会通过 PostCSS
  将生成的选择器限制在 Web Shell root 和 portal root，并为全局动画、CSS property
  注册增加 Web Shell 前缀，避免与接入方样式冲突。
- shadcn 颜色必须使用 `background`、`primary`、`muted` 等语义 token，不要直接
  引用 Web Shell 原有颜色变量。原有 CSS Modules 继续使用原来的 token，两套色值
  各自维护。
- Dialog、Popover、DropdownMenu、Tooltip 等包含 Portal 的组件，必须将内容挂载到
  Web Shell 的 portal root。新增 shadcn 组件后，应参考现有 `dialog.tsx`，使用
  `useWebShellPortalRoot()` 向 Radix Portal 传入 `container`。这样主题、旧 CSS
  变量以及外部配置的 z-index 才能正确继承。
- 保留组件上的 `data-web-shell-*` 属性和公开 CSS 变量。接入方可能通过这些属性或
  `--web-shell-dialog-backdrop-z-index`、`--web-shell-popover-z-index`、
  `--web-shell-tooltip-z-index` 等变量定制样式和层级。

在 `packages/web-shell` 目录添加后续组件，例如：

```bash
npx shadcn@latest add button
```

生成后需要检查 diff。shadcn CLI 可能更新 `globals.css`、依赖或生成默认 Portal
实现，不应覆盖现有的 CSS scope、语义 token 和 portal root 适配。组件默认仅供
Web Shell 内部使用；没有明确的公共 API 需求时，不要从包入口导出。

Tailwind 会在发布前编译并内联到 npm 包，接入方不需要安装或配置 Tailwind，也不
需要额外引入 `globals.css`。

### 图标约定

- 新增图标统一优先使用 `lucide-react`，不要为已有的常见图标重复编写 SVG。
- 使用具名静态导入，确保 Vite/Rollup 可以按需打包：

```tsx
import { CheckIcon, XIcon } from 'lucide-react';
```

- 不要使用 `import * as Icons` 后按名称动态取图标，这可能把整个图标库打入产物。
- 图标默认使用 `currentColor`，尺寸优先交给 shadcn 组件或 Tailwind class 控制，
  避免在每个调用处重复添加颜色、margin 和 padding。
- 只有 Lucide 没有对应图标或需要产品专属图形时，才新增自定义 SVG。

## 安装

```bash
npm install @qwen-code/web-shell
```

Peer dependencies 需要同时安装：

```bash
npm install react react-dom @qwen-code/webui @qwen-code/sdk
```

## 接入方式

WebShell 提供两种接入形态：

### 1. 独立接入（自带 Provider）

适合只需要嵌入一个终端视图的场景。组件内部自建
`DaemonWorkspaceProvider` + `DaemonSessionProvider`。

```tsx
import { WebShellWithProviders } from '@qwen-code/web-shell';

export function QwenCodePanel() {
  return (
    <WebShellWithProviders
      baseUrl="http://127.0.0.1:4170"
      token="your-bearer-token"
      sessionId="838e1811-9f84-4848-9915-d9a7f01ff5c6"
      onSessionIdChange={(sessionId) => {
        console.log('current session:', sessionId);
      }}
      onSessionCreated={async (sessionId) => {
        await registerSession(sessionId);
      }}
      theme="dark"
      language="zh-CN"
    />
  );
}
```

### 2. 共享 Provider 接入（纯消费者）

适合同一个 React 应用中多个视图共享同一个 daemon session 的场景（如
chat + terminal）。宿主自行提供 Provider，WebShell 只消费 hooks。

```tsx
import {
  DaemonWorkspaceProvider,
  DaemonSessionProvider,
} from '@qwen-code/webui/daemon-react-sdk';
import { WebShell } from '@qwen-code/web-shell';

export function App() {
  return (
    <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170" token="...">
      <DaemonSessionProvider sessionId="...">
        <ChatPanel />
        <WebShell theme="dark" language="zh-CN" />
      </DaemonSessionProvider>
    </DaemonWorkspaceProvider>
  );
}
```

> **注意**：不要在已有 `DaemonSessionProvider` 下使用
> `WebShellWithProviders`，否则会创建嵌套的重复 Provider。

### 3. 只读 ChatRecord JSONL

`WebShellTranscript` 只接收已经投影完成的 blocks，不连接 daemon，也不提供 composer、
审批或 session mutation。浏览器宿主可以逐行解析 JSONL，再通过 SDK 的 opt-in facade
投影：

```tsx
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { WebShellTranscript } from '@qwen-code/web-shell';

const records = jsonl
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as unknown);
const projection = projectChatRecordsToDaemonTranscript(records);

<WebShellTranscript
  blocks={projection.blocks}
  theme="dark"
  language="zh-CN"
  style={{ height: 640 }}
/>;
```

宿主应显示 `projection.diagnostics`，并在 `complete=false` 或 `truncated=true` 时提示
历史可能不完整。组件需要一个可用高度；自定义 renderer 的副作用仍由宿主负责。

## Props

### WebShellWithProviders

包含 `WebShell` 的所有 Props，加上 Provider 配置：

| 属性                 | 类型      | 说明                                                                                 |
| -------------------- | --------- | ------------------------------------------------------------------------------------ |
| `baseUrl`            | `string`  | daemon API 地址，未传时使用 `window.location.origin`                                 |
| `token`              | `string`  | daemon API Bearer token                                                              |
| `sessionId`          | `string`  | 要连接的 session id；未传或 `undefined` 时保持空页面                                 |
| `workspaceId`        | `string`  | 已注册工作区 id，主要用于定位已有 session；不会注册或锁定工作区                      |
| `workspaceCwd`       | `string`  | 已注册工作区路径，语义同 `workspaceId`；不会注册或锁定工作区，且优先于 `workspaceId` |
| `lockWorkspaceCwd`   | `string`  | 锁定到指定工作区路径；未注册时自动持久注册，并隐藏其他工作区及添加、移除和选择入口   |
| `restartSseOnPrompt` | `boolean` | 每次 prompt 被 daemon 接收后重建 SSE；默认关闭                                       |

### WebShell

| 属性                | 类型                                                                                    | 说明                                                                             |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `onSessionIdChange` | `(sessionId: string \| undefined, workspaceId?: string, workspaceCwd?: string) => void` | 当前 session 或工作区变化时触发                                                  |
| `onSessionCreated`  | `(sessionId: string) => Promise<void> \| void`                                          | 新 session 创建后触发；完成前会阻塞 session 初始化和 prompt 提交，最长等待 30 秒 |
| `theme`             | `'dark' \| 'light'`                                                                     | UI 主题，默认 `dark`                                                             |
| `onThemeChange`     | `(theme: WebShellTheme) => void`                                                        | `/theme` 命令切换主题后触发                                                      |
| `language`          | `'en' \| 'zh-CN' \| 'zh' \| 'zh-cn'`                                                    | UI 语言                                                                          |
| `onLanguageChange`  | `(language: WebShellLanguage) => void`                                                  | `/language ui` 切换 UI 语言后触发                                                |
| `onSlashCommand`    | `(command: WebShellSlashCommand) => boolean \| void`                                    | 斜杠命令进入默认处理前触发；返回 `true` 时由宿主接管并跳过默认行为               |

宿主可以监听命令，也可以返回 `true` 接管对应操作：

```tsx
<WebShell
  onSlashCommand={({ command, args, input }) => {
    if (command !== 'deploy') return;
    openDeployDialog({ environment: args, source: input });
    return true;
  }}
/>
```

锁定工作区时，可以自定义 Sidebar 文件夹行的内容：

```tsx
<WebShellWithProviders
  lockWorkspaceCwd="/path/to/workspace"
  sidebar={{
    lockedWorkspace: {
      render: (workspace, { expanded }) => (
        <span>
          {expanded ? '📂' : '📁'} {workspace.cwd}
        </span>
      ),
    },
  }}
/>
```

自定义内容仍使用内置的展开、收起行为，`expanded` 会随状态更新；文件夹行右侧的内置操作不会渲染。
未提供 `lockWorkspaceCwd` 时，该 renderer 不会执行。

## 可选图表 Renderer

`WebShell` 支持宿主通过 `customization.markdown.renderCodeBlock` 接管特定
fenced code block 的渲染。图表类场景可以注册内置的
`echarts-fulldata` renderer：

```tsx
import { createEchartsFullDataRenderer } from '@qwen-code/web-shell';

<WebShellWithProviders
  markdown={{
    renderCodeBlock: createEchartsFullDataRenderer({
      loadEcharts: () => window.echarts,
      resolveDataRef: async (ref, meta) =>
        loadControlledChartDataset(ref, meta),
    }),
  }}
/>;
```

renderer 会把 `echarts-fulldata` code block 替换为图表卡片，并内置图表/数据
icon 切换；ECharts runtime 由宿主通过 `loadEcharts` 提供。若启用
`data.kind="ref"` envelope，数据只能通过宿主提供的 `resolveDataRef` 解析，
renderer 不会自己读取 URL 或本地路径。

如果需要让模型主动输出 `echarts-fulldata` block，宿主应在自己的 skills 来源中
提供对应 skill，并且只在确认当前 Web Shell 宿主已经注册 renderer 时启用。
`@qwen-code/web-shell` 不内置或自动加载这个 skill；可从
`packages/web-shell/docs/examples/qwencode-viz/SKILL.md` 复制模板到宿主的
`.qwen/skills/qwencode-viz/SKILL.md`，或通过宿主自己的 skill 注入机制提供等价
说明。

`echarts-fulldata` 的 block body 可以是旧版纯 JSON ECharts option，也可以是
`{ "version": 1, "data": ..., "option": ... }` envelope。新版 inline envelope
使用 `data.dimensions: string[]` 和 `data.source` array-of-arrays；renderer 会先
normalize 成原生 ECharts option，并注入 `option.dataset`，再渲染图表和数据视图。
新版 ref envelope 必须使用受控 `artifact://` 或 `session-file://` ref，并提供
`data.format`（`csv` 或 `json`）和 `data.dimensions`，这些元信息会传给宿主的
`resolveDataRef(ref, meta)`。
宿主应使用 `JSON.parse` 解析，不能用 `eval`、`new Function` 或 script injection
执行模型生成内容。

## 架构说明

```text
@qwen-code/sdk/daemon         ← 协议层（SSE, REST, normalizer）
@qwen-code/webui/daemon-react-sdk  ← React adapter（Provider, hooks, store）
@qwen-code/web-shell          ← 终端 UI 组件
```

- `WebShell` 必须在 `DaemonWorkspaceProvider` 和 `DaemonSessionProvider` 之下使用。
- `WebShellWithProviders` 是内置 Provider 的便捷 wrapper。
- 同一个 React 树共享一个 `DaemonSessionProvider` 时只开一条 SSE。

## 已支持的斜杠命令

下面列出当前 web-shell 已支持的命令。支持方式分为两类：

- **本地实现**：web-shell 前端直接打开弹窗、调用 daemon REST API，或切换本地状态。
- **ACP 透传**：web-shell 将命令发送给 daemon，由 daemon/ACP 执行。

| 命令             | 支持方式            | 说明                                                                                                                    |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/help`          | 本地实现            | 打开帮助弹窗，支持键盘浏览命令和快捷键。                                                                                |
| `/theme`         | 本地实现            | 打开主题选择弹窗；支持 `/theme light`、`/theme dark`。                                                                  |
| `/settings`      | 本地实现            | 打开设置面板，管理工作区与用户级（`~/.qwen/settings.json`）配置；两个作用域均可编辑并写回对应的 settings.json。         |
| `/language`      | 本地实现 + ACP 透传 | `/language ui <lang>` 会切换 web-shell UI 语言并同步给 daemon；其他语言能力由 daemon 执行。包含 `ui`、`output` 子命令。 |
| `/model`         | 本地实现 + 部分透传 | 无参数打开模型弹窗；普通参数直接切换模型；`/model --fast <model>` 透传给 daemon。                                       |
| `/plan`          | 本地实现            | 切换到 `plan` approval mode，并可继续发送后续 prompt。                                                                  |
| `/approval-mode` | 本地实现            | 打开审批模式弹窗或直接切换审批模式。                                                                                    |
| `/mode`          | 本地实现            | web-shell 本地别名，用于切换审批模式。                                                                                  |
| `/mcp`           | 本地实现            | 打开 MCP 管理弹窗。                                                                                                     |
| `/skills`        | 本地实现 + ACP 透传 | 无参数打开 skills 弹窗；带参数时透传给 daemon 执行。                                                                    |
| `/tools`         | 本地实现            | 打开 tools 弹窗，列表展示工具名称、启用状态和 `description`。                                                           |
| `/memory`        | 本地实现            | 打开 memory 弹窗，支持 `show`、`refresh`、`add user`、`add project` 等分支。                                            |
| `/agents`        | 本地实现            | 打开 agents 弹窗，支持 `manage`、`create user`、`create project` 等分支。                                               |
| `/copy`          | 本地实现            | 复制最后一条 assistant 输出；支持 `code`、语言名、LaTeX、inline LaTeX 等选择器。                                        |
| `/release`       | 本地实现            | 释放 live session 连接，不删除历史会话记录。                                                                            |
| `/clear`         | 本地实现            | 清空当前 web-shell transcript store。                                                                                   |
| `/new`           | 本地实现            | 创建新的 daemon session。                                                                                               |
| `/reset`         | 本地实现            | 与 `/new` 一样创建新的 daemon session。                                                                                 |
| `/rename <name>` | 本地实现            | 修改当前 daemon session 的展示名称。                                                                                    |
| `/resume`        | 本地实现            | 无参数打开恢复会话弹窗；带 session id 时直接加载。                                                                      |
| `/status`        | ACP 透传            | daemon 支持，包含 `paths` 子命令。                                                                                      |
| `/auth`          | ACP 透传            | 连接 LLM provider。                                                                                                     |
| `/bug`           | ACP 透传            | 提交错误报告。                                                                                                          |
| `/compress`      | ACP 透传            | 通过摘要替换来压缩上下文。                                                                                              |
| `/context`       | ACP 透传            | 显示上下文窗口使用情况，包含 `detail` 子命令。                                                                          |
| `/diff`          | ACP 透传            | 显示工作区相对 `HEAD` 的变更统计。                                                                                      |
| `/docs`          | ACP 透传            | 打开 Qwen Code 文档。                                                                                                   |
| `/doctor`        | ACP 透传            | 执行安装与环境诊断，包含 `memory` 子命令。                                                                              |
| `/export`        | ACP 透传            | 导出当前会话记录，包含 `html`、`md`、`json`、`jsonl` 子命令。                                                           |
| `/goal`          | ACP 透传            | 设置目标，并持续工作直到条件满足。                                                                                      |
| `/init`          | ACP 透传            | 分析项目并创建定制的 `QWEN.md`。                                                                                        |
| `/stats`         | ACP 透传            | 显示统计信息，包含 `model`、`tools` 子命令。                                                                            |
| `/summary`       | ACP 透传            | 生成当前会话摘要。                                                                                                      |
| `/tasks`         | ACP 透传            | 列出后台任务。                                                                                                          |
| `/insight`       | ACP 透传            | 查看 insight 相关信息。                                                                                                 |
