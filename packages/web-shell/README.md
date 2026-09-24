# @qwen-code/web-shell

Qwen Code Web Shell 是面向浏览器的 daemon 会话终端 UI，可以作为 React
组件嵌入到其他项目中。

## 开发网页预览

独立 Web Shell 的右侧面板提供「网页预览」。先通过终端启动开发服务器，
再打开面板并输入当前浏览器可访问的 HTTP/HTTPS 地址。预览支持热更新、
刷新、390px 手机宽度与桌面宽度切换，以及外部打开。

面板内切换标签会保留页面运行状态。URL 和宽度模式按工作区与会话保存；
重新打开整个面板、切换会话或刷新 Web Shell 后会从保存的入口 URL 加载。
预览中的跨域页面导航不会同步到地址栏，刷新也会返回入口 URL。
关闭预览不会停止开发服务器。

Artifact 发布的网页链接会在对应轮次留下产物卡片；开启网页预览后，
点击卡片「打开」可在右栏查看。普通 `record_artifact` 链接显示详情，
可从详情外部打开。关闭页签不删除卡片，之后仍能从历史消息重新打开。手动输入的地址只保存为面板状态，不会新增对话记录。
实时链接始终显示当前内容。

需要保留当时的网页时，使用 `Artifact` 发布自包含 HTML：每次发布会额外
保存一份独立的历史版本，包含内联样式、脚本、数据和内嵌资源。原消息的
卡片打开当次保存的内容，关闭面板、刷新或重启 daemon 后仍可回看和交互，
不依赖源文件、最新发布地址或开发服务器。重新打开会从交付时的初始状态
开始，不保存用户在预览中的临时操作状态。

历史版本文件保存在所属运行目录的 `artifacts/snapshots/` 中；原发布 URL
仍更新为最新版。记录沿用会话产物的保留策略（默认最多 200 条，超过后
可能淘汰旧记录），并非无限存档。淘汰、删除记录、回退历史或删除会话时，
会释放该会话的快照引用；分支会话仍在使用的内容会保留，最后一个引用
释放后才回收文件。持久化失败时不会提前删除历史文件。旧版没有引用信息
的快照，以及落盘前崩溃或清理失败留下的文件会保守保留。仅开启会话记录的受管 ACP 会话保存快照，普通 CLI 发布
不额外写入历史文件。删除运行目录、移动会话而未复制快照，
或修改快照文件后会提示不可用，不会退回最新版。普通实时链接和过去未保存
内容的记录不能自动还原；任意开发网站也不会自动打包成离线网页。

嵌入式接入方通过 `rightPanel={{ items: ['review', 'sideTask', 'webPreview'] }}`
开启入口。宿主 CSP 需要允许预览来源的 `frame-src`，同时用
`frame-ancestors` 限制宿主页面只能被受信任的宿主嵌入，不能允许开发页面
反过来嵌入宿主。预览容器会限制直接子页面跳转，但开发应用自己的后代
iframe 仍需宿主的防嵌入策略保护。

地址必须使用主机名或 IPv4，不能包含登录凭据，也不能指向 Web Shell 或
daemon 自身。页面的防嵌入策略可能要求使用外部打开。远程开发目前需要
浏览器可访问的地址或已有端口转发；预览不会自动把浏览器的 `localhost`
转成远程 daemon 地址，也不会转发 daemon 凭据。

## 环境要求

- React：`^18.0.0 || ^19.0.0`
- React DOM：`^18.0.0 || ^19.0.0`
- `@qwen-code/sdk`：`>=0.1.8`
- 浏览器环境需要能访问 Qwen Code daemon serve 的 HTTP 接口。

组件包会自动注入自身的 CSS（包括 Tailwind 编译产物），接入方不需要配置
Tailwind 或额外引入全局 CSS。

### Browser Support Matrix

- Chrome / Edge 111+
- Firefox 128+
- Safari / iOS 16.4+
- Android System WebView 111+

最低版本覆盖 Tailwind v4 的生成 CSS；JavaScript 构建目标单独设置为 ES2021。
独立页面在不支持的浏览器显示升级提示，嵌入式组件由宿主保证该支持约定。
此矩阵不是所有最低版本真机均已验证的声明。

独立生产页面在 HTTPS 或可信 loopback origin 下注册 service worker。
仅带内容哈希的构建资源使用 worker 缓存；manifest、公开图标、API、令牌和
事件流不缓存。HTML 连接失败时显示 503 重试页，不支持离线会话。
安装入口由浏览器决定，不保证自动弹出安装提示。

## 浏览器任务通知

通过 `qwen serve` 打开的独立 Web Shell 可在 **Settings → UI → 浏览器任务通知**
管理提醒。内置 `main.tsx` 显式设置默认开启；用户已保存的关闭选择优先。仅在用户点击后申请浏览器授权；偏好保存在当前浏览器站点，
不写入 daemon 或 workspace 设置，同源标签页之间同步。

页面在后台或窗口失焦时，当前聊天及 Split View 中仍挂载的聊天在回合结束或失败后
可以发送系统通知。取消回合、初次加载历史和前台已处理的回合保持静默。通知显示会话标题（最多 60 个 Unicode 码点）、回合状态，以及带“提问 / 回复”标签的本轮提问（最多 80 个码点）和回复（最多 120 个码点）纯文本摘录。
标题显示 QwenCode · 会话名，尚未生成时使用本轮问题首行，两者均缺失时显示 QwenCode；业务文案不额外添加地址。通知携带 Qwen Code 图标，实际显示位置由浏览器和操作系统决定，不能替换 macOS 上 Chrome 自身的标志。摘要直接截取文本，不额外调用模型；提问或回复缺失时省略对应行，两者均缺失时只显示状态。失败时可显示本轮提问，不展示错误详情或部分回复。系统可能进一步截短通知正文。
通知内容可能显示在系统通知中心或锁屏上，遵循系统的预览设置；点击通知尝试聚焦原窗口并在主聊天中打开对应会话，退出设置页或分屏；已在目标会话时不会重新加载。

需要支持 Notifications API 的桌面浏览器以及 HTTPS 或可信的 localhost 环境。
支持 Web Locks 且存储可用时，同源标签页协调去重；否则退化为页面内去重及相同 tag
的通知替换。关闭网页、页面冻结或离开未挂载的聊天后不保证提醒。嵌入式组件不自动
启用此能力；Channel 推送不在首版范围内。

`WebShellWithProviders`（及别名 `StandaloneWebShell`）支持通过 `browserNotifications` 接入通知并配置名称和图标：

```tsx
<WebShellWithProviders
  baseUrl="https://daemon.example.com"
  sidebar
  browserNotifications={{
    defaultEnabled: true,
    appName: 'DataAgent',
    iconUrl: 'https://cdn.example.com/assets/dataagent.png',
  }}
/>
```

传入 `{}` 时使用默认 `QwenCode` 名称和随包图标；名称和图标均可单独省略，空白值也回退默认。标题显示“应用名称 · 会话标题”。图片 URL 由浏览器直接加载，可使用 HTTPS CDN 地址；加载失败不保证自动回退到默认图标。

`defaultEnabled` 默认 `false`；设为 `true` 时仅对没有保存通知偏好的浏览器站点默认开启。用户明确开启或关闭的选择优先，刷新后也保留；挂载后修改默认值不会覆盖当前选择。不传 `browserNotifications` 时保持嵌入入口原有行为，不接入通知。即使默认开启，也不会自动申请权限，用户仍需在 Settings → UI 中允许浏览器通知。修改品牌值不会重新加载当前会话。通知点击只导航所属实例，并遵守其当前锁定工作区。

低层 `WebShell` 的 daemon providers 由宿主管理，不支持这个配置属性；qwen serve 内置页面继续使用默认品牌。本配置仅影响通知，不改变侧边栏品牌、Chrome 来源地址或浏览器标志。

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
  `--web-shell-tooltip-z-index` 等变量定制样式和层级。宿主自己的标题栏覆盖在
  shell 之上但并不裁剪它时，必须通过 `--web-shell-popover-safe-top` 声明顶部
  安全区，向上展开的浮层（输入历史、@ 引用）才能避开它；显式声明 `0px` 表示
  没有顶部安全区，不会被默认值覆盖。

在 `packages/web-shell` 目录添加后续组件，例如：

```bash
npx shadcn@latest add button
```

生成后需要检查 diff。shadcn CLI 可能更新 `globals.css`、依赖或生成默认 Portal
实现，不应覆盖现有的 CSS scope、语义 token 和 portal root 适配。组件默认仅供
Web Shell 内部使用；没有明确的公共 API 需求时，不要从包入口导出。

Tailwind 会在发布前编译并内联到 npm 包，接入方不需要安装或配置 Tailwind，也不
需要额外引入 `globals.css`。

## 可选 Shadow DOM 隔离

宿主页面存在 `*`、`h2`、`button` 等全局规则时，可以按场景开启 Shadow DOM：

```tsx
import customShadowStyles from './web-shell-shadow.css?inline';

<WebShellWithProviders
  shadowDom={{
    plugins: true,
    portals: true,
    styles: customShadowStyles,
  }}
/>;
```

- `plugins` 隔离所有插件管理页面主体，包括统一的 Plugins 页面，以及
  `/extensions`、`/mcp`、`/skills` 等兼容入口打开的页面。
- `portals` 统一隔离 Web Shell 的所有弹窗层，包括 Dialog、Drawer、Popover、
  DropdownMenu、Select 和 Tooltip；插件页面发起的弹窗也由这个开关管理。
- `styles` 会追加到每个启用的 ShadowRoot，供 render props 等业务自定义内容继续
  使用 class 样式。内联样式和通过 Web Shell `style` 设置的 CSS 变量不需要迁移。
- `--web-shell-portal-root-z-index` 控制 Shadow portal host 的整体层级，默认
  `1000`。需要与宿主自己的全局浮层协调时，可以通过 Web Shell `style` 覆盖。
- `shadowDom={true}` 是同时开启 `plugins` 和 `portals` 的简写。

默认不开启，现有 Light DOM 接入行为不变。两个场景相互独立，例如
`{ plugins: true, portals: false }` 会隔离插件页面主体，但所有弹窗仍挂载到原来的
Light DOM portal root。

Shadow 内部仍由原 React 树通过 portal 渲染，不会创建第二个 React root；props、
context、事件、ref 和状态语义保持不变。开启后，宿主普通选择器不会匹配 Shadow
内部节点，但宿主也无法再用普通选择器直接覆盖这些节点，所需定制样式应通过
`shadowDom.styles` 传入。

Web Shell 会在挂载 Shadow 内容前安装样式，并在浏览器支持时让多个 ShadowRoot
复用已经解析的 constructable stylesheet，以避免页面首次进入时的无样式闪烁和
重复解析 CSS。

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
npm install react react-dom @qwen-code/sdk
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
      sessionContext={{ kind: 'standalone' }}
      onSessionIdChange={(sessionId, _workspaceId, _workspaceCwd, context) => {
        console.log('current session:', sessionId, context);
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
  WebShell,
  useWorkspace,
} from '@qwen-code/web-shell';

function SessionViews() {
  const workspace = useWorkspace();
  if (!workspace.capabilities) {
    if (workspace.status === 'error') {
      return (
        <button
          onClick={() => void workspace.refreshCapabilities?.().catch(() => {})}
        >
          Try again
        </button>
      );
    }
    return <p role="status">Loading workspace…</p>;
  }
  return (
    <DaemonSessionProvider sessionId="...">
      <ChatPanel />
      <WebShell theme="dark" language="zh-CN" />
    </DaemonSessionProvider>
  );
}

export function App() {
  return (
    <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170" token="...">
      <SessionViews />
    </DaemonWorkspaceProvider>
  );
}
```

恢复已有会话时，直接组合 Provider 的宿主需要像示例一样，等待首次 capabilities
成功后再挂载 `DaemonSessionProvider`，并在它上方提供发现失败的重试入口。
否则主工作区稍后确定时，会话上下文变化可能触发重复恢复。后续刷新失败会保留已知
capabilities，此时应保持会话挂载。该等待只用于首次发现，不应屏蔽真正的工作区切换。

> **注意**：不要在已有 `DaemonSessionProvider` 下使用
> `WebShellWithProviders`，否则会创建嵌套的重复 Provider。

### 3. 只读 ChatRecord JSONL

`WebShellTranscript` 只接收已经投影完成的 blocks，不连接 daemon，也不提供 composer、
审批或 session mutation。浏览器宿主可以逐行解析 JSONL，再通过 SDK 的 opt-in facade
投影：

> 只渲染 transcript 的宿主请从 `@qwen-code/web-shell/transcript` 子路径导入。包根会连带
> `App`、daemon providers 和编辑器/终端相关代码，不要依赖 tree shaking 把它们摇掉。

```tsx
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { WebShellTranscript } from '@qwen-code/web-shell/transcript';

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

## 拖入文件的默认行为

通过 `fileDropAction` 指定拖入文件时的默认去向，适用于 `WebShell` 和
`WebShellWithProviders`：

```tsx
<WebShellWithProviders fileDropAction="upload" fileUploadDirectory="uploads" />
<WebShellWithProviders fileDropAction="attach" />
```

- `upload`：直接上传到工作区，并插入 `@文件` 引用。
- `attach`：直接添加为当前消息的附件。
- 不传：仅当上传和附件都可用时显示选择弹窗。

只有一种方式可用时直接使用它，即使配置的默认去向是另一种；两种都不可用时
不接收拖入文件。`fileUploadEnabled={false}` 只关闭工作区上传，不再关闭附件
拖入或添加附件入口。上传仍受 daemon 能力、工作区信任及目标路径检查约束。
修改默认去向或可用方式时，会关闭已经打开的选择弹窗；需要重新拖入文件。

## 消息操作

- 已完成的 assistant 消息支持复制；具备持久化 checkpoint 时还支持分支。
- 终态 turn error 支持复制显示的错误文本。重试入口保持独立，错误轮次不支持分支。

## Props

### WebShellWithProviders

包含 `WebShell` 的所有 Props，加上 Provider 配置：

| 属性                   | 类型                                  | 说明                                                                                                                                           |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `urlNavigation`        | `WebShellUrlNavigationOptions`        | 可选 URL 管理，含 `basePath`；默认关闭。详见 [URL 导航](#url-导航可选)。                                                                       |
| `browserNotifications` | `WebShellBrowserNotificationsOptions` | 可选接入通知；`appName` 默认 QwenCode，`iconUrl` 默认内联 PNG（支持 CDN），`defaultEnabled` 默认 false；已保存偏好优先；不传时停用，不重建会话 |
| `baseUrl`              | `string`                              | daemon API 地址，未传时使用 `window.location.origin`                                                                                           |
| `token`                | `string`                              | daemon API Bearer token                                                                                                                        |
| `sessionId`            | `string`                              | 要连接的 session id；未传或 `undefined` 时保持空页面                                                                                           |
| `workspaceId`          | `string`                              | 已注册工作区 id，主要用于定位已有 session；不会注册或锁定工作区                                                                                |
| `workspaceCwd`         | `string`                              | 已注册工作区路径，语义同 `workspaceId`；不会注册或锁定工作区，且优先于 `workspaceId`                                                           |
| `sessionContext`       | `DaemonProductSessionContext`         | 显式产品上下文；standalone 或 Live 上下文不能同时传 `workspaceId`、`workspaceCwd` 或 `lockWorkspaceCwd`                                        |
| `lockWorkspaceCwd`     | `string`                              | 锁定到指定工作区路径；未注册时自动持久注册，并隐藏其他工作区及添加、移除和选择入口                                                             |
| `restartSseOnPrompt`   | `boolean`                             | 每次 prompt 被 daemon 接收后重建存活 SSE 流；流断开时提交 prompt 总会立即重建（与此开关无关）；默认关闭                                        |
| `settings`             | `WebShellSettingsOptions`             | 可选。控制原生 `/settings` 页面的呈现；见 [原生设置呈现](#原生设置呈现)。                                                                      |
| `modelManagement`      | `WebShellModelManagementOptions`      | 可选。控制 WebShell 内模型新增/删除交互，默认均允许；见 [模型增删交互](#模型增删交互)。                                                        |

### Workspace 会话创建超时

Workspace 创建由 SDK 分别约束能力查询和创建请求，WebShell 另设 75 秒的
兜底总超时，覆盖常见的单次能力预检与创建两个默认 30 秒请求，并留出 15 秒余量。冷缓存或缓存过期时，
能力查询 20 秒、创建请求 15 秒可以在约 35 秒后成功，无需调整配置。
此规则也适用于已有会话时创建新会话；SDK standalone 创建保持原有超时行为。
并发能力刷新可能取代原预检并延长请求链；即使每个请求都未超过自身截止时间，
创建动作仍可能先触及 75 秒上限。

| 配置／机制                  | 默认值     | 作用与边界                                                           |
| --------------------------- | ---------- | -------------------------------------------------------------------- |
| WebShell workspace 创建动作 | `75000` ms | 兜底限制不响应 SDK 取消信号的传输；超时后成功返回的会话会被 detach。 |
| `onSessionCreated` 回调     | `30000` ms | 创建完成后才开始计时的独立宿主回调限制；没有公开的超时配置属性。     |

WebShell Provider 不透传 SDK 的
[`fetchTimeoutMs`](../../docs/developers/daemon/13-sdk-daemon-client.md#configuration)，
能力预检和创建请求使用 SDK 默认请求预算；提高 daemon 的初始化超时不会提高这两类请求的 SDK 超时。
load/resume 使用独立预算；服务端优先级、客户端覆盖顺序、能力缓存前提和缺失时的回退值见
[restore 超时契约](../../docs/design/2026-08-07-safe-session-restore-timeout.md#timeout-contract)，
SDK 和 WebShell 的 restore 余量见
[serve 协议文档](../../docs/developers/qwen-serve-protocol.md#capabilities)。

SDK `query()` 的 `timeout.controlRequest` 等参数属于
子进程接口，不控制 daemon HTTP 请求。兜底超时限制 WebShell 的等待时间，不保证
底层传输立即取消；迟到结果仍按原有机制清理。其他动作、会话清理和回调仍使用各自的超时。

daemon 参数的完整含义和配置方式见
[daemon 配置文档](../../docs/developers/daemon/17-configuration.md)。

### WebShell

| 属性                       | 类型                                                                                                                                  | 说明                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSessionIdChange`        | `(sessionId: string \| undefined, workspaceId?: string, workspaceCwd?: string, sessionContext?: DaemonProductSessionContext) => void` | 当前 session、工作区或显式产品上下文变化时触发；standalone 和 Live 通过第四个参数上报                                                          |
| `onSessionCreated`         | `(sessionId: string) => Promise<void> \| void`                                                                                        | 新 session 创建后触发；完成前会阻塞 session 初始化和 prompt 提交，最长等待 30 秒                                                               |
| `theme`                    | `'dark' \| 'light'`                                                                                                                   | UI 主题，默认 `dark`                                                                                                                           |
| `onThemeChange`            | `(theme: WebShellTheme) => void`                                                                                                      | `/theme` 命令切换主题后触发                                                                                                                    |
| `onThemeResolved`          | `(theme: WebShellTheme) => void`                                                                                                      | 未提供 `theme` 且 shell 从 daemon 设置解析出主题时触发；仅供宿主同步文档外观，不应持久化为宿主偏好                                             |
| `language`                 | `'en' \| 'zh-CN' \| 'zh' \| 'zh-cn'`                                                                                                  | UI 语言                                                                                                                                        |
| `onLanguageChange`         | `(language: WebShellLanguage) => void`                                                                                                | `/language ui` 切换 UI 语言后触发                                                                                                              |
| `onLanguageResolved`       | `(language: WebShellLanguage) => void`                                                                                                | 未提供 `language` 时，有效 UI 语言在未成为宿主偏好时触发，包括设置解析、乐观切换与回滚；仅供同步文档外观                                       |
| `brand`                    | `WebShellBrand`                                                                                                                       | 产品品牌（名称与 Logo，`logo` 为 React 节点）；提供时整体取代 daemon 解析出的品牌，见下方「品牌（白标）」                                      |
| `onBrandResolved`          | `(brand: WebShellResolvedBrand) => void`                                                                                              | 品牌解析完成后触发，载荷只含 `name` 与 `logoDataUri`（不含 `logo` 节点），供宿主应用到自己的文档；shell 自身从不写 `document.title` 或 favicon |
| `onSlashCommand`           | `(command: WebShellSlashCommand) => boolean \| void`                                                                                  | 斜杠命令进入默认处理前触发；返回 `true` 时由宿主接管并跳过默认行为                                                                             |
| `onSessionArtifactsChange` | `(change: WebShellSessionArtifactsChange) => void`                                                                                    | Session Artifact 初始恢复或变化后返回当前完整快照与 turn 投影                                                                                  |
| `onAssistantTurnSettled`   | `(event: WebShellAssistantTurnSettledEvent) => void`                                                                                  | daemon 权威终态提交后触发；多个 provider 可能重复上报，宿主按 `(sessionId, promptId)` 去重                                                     |
| `settings`                 | `WebShellSettingsOptions`                                                                                                             | 可选。控制原生 `/settings` 页面的呈现；见 [原生设置呈现](#原生设置呈现)。                                                                      |
| `modelManagement`          | `WebShellModelManagementOptions`                                                                                                      | 可选。控制 WebShell 内模型新增/删除交互，默认均允许；见 [模型增删交互](#模型增删交互)。                                                        |

移动访问二维码入口由 `header.showMobileAccess?: boolean` 控制，默认隐藏，适用于主聊天和分屏页头。独立入口 `main.tsx` 显式设为 `true`，保留本地 Qwen Code 用户的入口。

宿主可以通过 `onContextUsageOpen?: (sessionId: string) => void` 接管上下文
详情的打开操作：

```tsx
<WebShell onContextUsageOpen={(sessionId) => openContextDetails(sessionId)} />
```

此参数也适用于 `WebShellWithProviders`。提供回调后，composer hover 弹层的
「查看明细」及页头上下文详情入口会将来源会话 ID 交给宿主，不再打开内置右侧
面板或自动读取详情；分屏传入对应分屏的会话 ID。不提供回调则保留默认行为。
直接点击上下文圆环生成 `/context` 快照、压缩操作和已保存面板的恢复不受影响。

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

回调在主聊天和分屏聊天中都会触发，也可以在 daemon 断连时处理纯宿主操作。
命令名后必须是空白或输入结束，因此 `/usr/local/bin/tool` 等绝对路径不会触发
回调。如果回调抛出异常，Web Shell 会报告错误并继续执行默认命令流程。

宿主需要同步 Session 产物时，可以监听完整快照：

```tsx
<WebShell
  onSessionArtifactsChange={({
    reason,
    sessionId,
    sequence,
    artifacts,
    artifactsByTurn,
  }) => {
    replaceSessionArtifacts({
      reason,
      sessionId,
      sequence,
      artifacts,
      artifactsByTurn,
    });
  }}
/>
```

`restore` 表示进入新 Session 后的首次恢复，可携带空快照；`change` 表示实时
Artifact 变化、同 Session 重连对账发现的差异，或 transcript 补齐后的 turn
归属变化。每次都返回完整 `artifacts` 和 `artifactsByTurn`，不提供增量。新 Artifact
可能先于 turn 归属交付，归属稍后补齐时会再交付一份完整快照。回调会等待 transcript
load/catch-up 结束；同 Session 短暂断线保留去重基线并主动对账，因此宿主应接受重复
交付，但不需要从 SSE 时序推断遗漏。`sequence` 在每个新 Session 从 1 开始。宿主回调
抛错不会影响 WebShell 内置 Artifact 面板与轮末渲染。

嵌入宿主只展示普通任务会话时，可以隐藏 Sidebar 的“任务 / 频道”来源切换：

```tsx
<WebShellWithProviders sidebar={{ showSessionSourceSwitch: false }} />
```

隐藏后，Sidebar 的会话目录固定查询 `sourceType: "default"`；独立 WebShell 和未配置
该选项的宿主仍默认展示来源切换。

### 品牌（白标）

独立部署（`qwen serve` 打开的 Web Shell）用 `settings.json` 换名换 Logo，嵌入宿主用
`brand` 属性覆盖：

```json
{
  "ui": {
    "brand": {
      "name": "QiuQiu Code",
      "logoPath": "~/.qwen/brand/logo.svg"
    }
  }
}
```

daemon 把该 SVG 读成 `data:image/svg+xml` URI，通过 `GET /brand` 下发。客户端始终以
`<img>` 渲染它，绝不作为 markup 注入：作为图片加载的 SVG 不能执行脚本，注入的可以，而
daemon 不净化它读到的文件。该配置只从 User / System / SystemDefaults 三层读取，工作区的
`.qwen/settings.json` 无法改写品牌 —— 那份文件通常来自打开 shell 的人并未撰写的仓库。

品牌名会替换 Sidebar 品牌行、Sidebar 底部版本 tooltip、欢迎页标题、About 面板的版本行
标签，以及独立部署下的 `document.title`；Logo 会替换 Sidebar 标记与 favicon。它不会替换
正文文案：本地化字符串里仍有若干处提到 Qwen Code，auth provider 标签也仍是 `Qwen OAuth`
（那是身份提供方的名字，不是产品名）。

嵌入宿主传 `brand` 时整体接管名称与 Logo。`logo` 可以是任意 React 节点，因为宿主拥有自己
的文档与 CSP；宿主也拥有标签页标题和 favicon，shell 只在 standalone 入口写 `document`，
嵌入时通过 `onBrandResolved` 把名称与 Logo URI 交回宿主自行处理。该回调只在品牌确定后、
以及这两个值之一发生变化时触发，因此宿主可以直接传内联对象和内联函数，不会每次渲染都重放。
名称为空字符串等同于未设置，回退到内置名称。

优先级从高到低：`sidebar.branding.render`（整行替换，仍受支持）→ `brand` 属性 → daemon
解析值 → 内置默认。

```tsx
<WebShellWithProviders
  brand={{ name: 'QiuQiu Code', logo: <MyLogo /> }}
  onBrandResolved={(brand) => {
    document.title = `${brand.name || 'Qwen Code'} — My Host`;
  }}
/>
```

`Live` 会话分组默认不向嵌入宿主展示；此前版本会默认展示，依赖该分组的宿主升级时
需要显式开启：

```tsx
<WebShellWithProviders sidebar={{ showLive: true }} />
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

## 原生设置呈现

嵌入方宿主可以在保留原生表单和模型选择器的前提下，隐藏单个原生设置项：

```tsx
<WebShellWithProviders
  settings={{
    excludeItems: ['setting:fast-model', 'setting:vision-model'],
  }}
/>
```

也可以只开放少量条目，未列出的设置（包括上游新增设置）默认隐藏：

```tsx
<WebShellWithProviders
  settings={{
    includeItems: ['setting:language', 'builtin:chat-width'],
  }}
/>
```

`WebShellSettingsOptions.includeItems` 与 `excludeItems` 接受 `WebShellSettingItemId` 值。可导入 `WEB_SHELL_SETTING_ITEM_IDS` 获取受支持的只读列表。这些 ID 是经过整理的别名，而不是 daemon 的配置路径：`setting:language` 对应语言控件，`setting:fast-model` 对应快速模型选择器。即使内部 schema 路径变化，别名也保持稳定。未知的运行时 ID 不匹配任何条目；配置白名单后，尚无公开别名的字段也会隐藏。

前端内置块有自己的 ID：`builtin:chat-width`、`builtin:browser-notifications`、`builtin:live-setup`、`builtin:local-control`、`builtin:connections` 和 `builtin:model-management`。`builtin:connections` 区块仅在 standalone 构建中渲染，而 standalone 入口不接收 `settings` 呈现配置，因此该 ID 目前对嵌入方没有作用。模型管理块与普通 Model 字段独立过滤；仅排除普通 Model 字段时，模型列表与选择仍然可用；配置白名单时需包含 `builtin:model-management` 才会显示该块。浏览器通知与聊天宽度相互独立。既有的能力和隐藏限制仍然适用，白名单不能强制显示不可用的控件，也不会改变排序。

- 未传 `includeItems` 时保持现有展示逻辑，仅应用 `excludeItems`；新增的上游设置默认仍然可见。
- `includeItems: []` 隐藏全部原生设置条目；它与未传入白名单不同。
- 同时传入两个列表时，排除优先：仅展示白名单中且未被排除的条目。
- 不传 `settings`、传入 `{}` 或仅传 `excludeItems: []` 时，保持默认呈现。

过滤在工作区与用户两个作用域中都生效。被排空的分类会消失，分类导航回退到可用分类；全部隐藏则显示现有空状态。从设置面板打开的选择器会在来源条目不再可见时关闭，包括动态修改白名单的情况。

**呈现限制不是访问控制。** 白名单与排除列表只影响原生设置页展示，不启用或关闭底层功能，不改写已保存的配置，也不限制 daemon 写入、斜杠命令、其他入口的模型管理或直接文件访问。该选项不提供作用域策略、字段覆盖或条目级深链。

设计与验证范围见 [English](../../docs/design/web-shell-settings-allowlists.md) / [简体中文](../../docs/design/web-shell-settings-allowlists.zh-CN.md)。

## 模型增删交互

宿主可以保留模型列表和切换，同时关闭 WebShell 内的新增与删除入口：

```tsx
<WebShellWithProviders
  modelManagement={{ allowAdd: false, allowDelete: false }}
/>
```

公共类型 `WebShellModelManagementOptions` 的两个字段独立控制，省略均为 `true`。
`allowAdd: false` 隐藏新增按钮和 `/auth` 建议，并在主窗口、欢迎页、分屏和侧任务中拦截手动输入的 `/auth` 及其别名 `/connect`、`/login`。输入框提交时，拦截位于宿主 `onSlashCommand` 回调之后、隐藏命令转发之前，宿主回调返回 `true` 即可接管；消息编辑、重试和侧任务初始发送不调用该回调。命令快照就绪后，daemon 命令按解析身份判断，同名项目/用户命令可保留；App 本地 `/auth` 路由仍是配置弹框入口。快照未就绪时，输入框保守拒绝配置命令名称；侧任务保留这类初始提示词等待加载，五秒后提示等待状态，信息到达后重新检查。添加模型弹框无法打开或保存。
`allowDelete: false` 隐藏模型删除按钮并阻止删除动作。模型列表、当前标识、选择、`/model`、参数编辑及会话 `/delete` 保持原行为。

动态收紧策略会关闭相关弹框或确认，之后的浏览器队列发送读取最新策略。已交给 SDK/daemon 的请求不能由 props 撤销。恢复允许不会重新打开旧弹框。

这仅用于界面防误操作，不是安全权限。daemon API、CLI、配置文件写入和外部模型下发不受影响；`settings.excludeItems` 的呈现策略仍独立生效。

## Markdown 图表接入

`WebShell` 已内置 `markdown-chart` renderer 和 ECharts 运行时。宿主只需将
[`markdown-chart` skill](https://github.com/datafe/markdown-chart/tree/main/skills/markdown-chart)
安装到 Qwen Code 的项目级或用户级 skills 目录；例如项目级安装结果为：

```text
.qwen/skills/markdown-chart/SKILL.md
```

安装 skill 后按原方式使用 WebShell，不需要额外安装或导入 ECharts，也不需要传入
图表配置：

```tsx
<WebShellWithProviders baseUrl="http://127.0.0.1:4170" />
```

skill 默认输出 `data.kind="inline"` 的 canonical `markdown-chart` block。
WebShell 负责严格 JSON 校验、流式渲染、ECharts 生命周期以及 Chart/Data
切换；已经闭合的图表会立即渲染，只有末尾尚未闭合的 fence 显示 loading。

只有需要支持 skill 输出 `data.kind="ref"` 时，宿主才需要提供受控的
`resolveDataRef`：

```tsx
import {
  createMarkdownChartRegistry,
  WebShellWithProviders,
} from '@qwen-code/web-shell';

const chartRegistry = createMarkdownChartRegistry({
  resolveDataRef: async (ref, context) =>
    loadControlledChartDataset(ref, context),
});
const markdown = { chart: { registry: chartRegistry } };

<WebShellWithProviders baseUrl="http://127.0.0.1:4170" markdown={markdown} />;
```

`resolveDataRef` 是 ref 数据的唯一读取入口；WebShell 不会自行读取 URL 或本地
路径。默认只接受规范化的 `artifact://` 和 `session-file://` ref，将 ref
规范化后交给 resolver，并在 30 秒后终止等待。`markdown` 及其中的 `chart`
对象应在图表挂载期间保持引用稳定。
Chart/Data 控件、无数据提示和错误提示默认跟随 WebShell 语言；需要覆盖个别
文案时可在稳定的 `chart` 对象上提供 `labels`。
协议和数据格式见
[`markdown-chart`](https://github.com/datafe/markdown-chart)。

## 架构说明

```text
@qwen-code/sdk/daemon         ← 协议层（SSE, REST, normalizer）
@qwen-code/web-shell          ← React adapter（Provider, hooks, store）+ 终端 UI 组件
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
| `/skills`        | 本地实现 + ACP 透传 | 无参数或 `detail`/`details` 打开 skills 弹窗；其他参数转换为直接 skill 命令（`/skills review` → `/review`）。           |
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
| `/tasks`         | 本地实现            | 打开环境信息面板并刷新后台任务。                                                                                        |
| `/btw`           | 本地实现 + ACP 透传 | daemon 支持侧边任务时新建侧边任务；否则发送一个不影响主对话的侧边问题。                                                 |
| `/fork`          | 本地实现 + ACP 透传 | 启动共享当前上下文的后台智能体。                                                                                        |
| `/insight`       | ACP 透传            | 查看 insight 相关信息。                                                                                                 |

## 当前会话内容搜索

`conversationSearchThreshold` 控制搜索入口的消息数阈值，默认 `10`。
当前会话的用户和助手消息数严格超过阈值时显示入口（默认第 11 条起），
搜索图标位于左侧会话时间轴下方，采用适配窄栏的小尺寸；时间轴刻度隐藏时同步隐藏搜索入口。
`WebShell` 和 `WebShellWithProviders` 均支持此 prop，例如
`<WebShellWithProviders conversationSearchThreshold={20} {...connectionProps} />`。

弹框搜索用户和助手正文（包括代码），点击摘要可定位并高亮对应消息。
支持 turn navigation 的 daemon 会分页搜索持久化历史，不受当前可见区域限制；
旧 daemon 只能搜索已加载消息，弹框会明确提示。搜索结果最多展示 200 条，
超过时可缩小关键词范围。搜索不修改草稿或中断正在进行的回复。

### 宿主定位持久化消息

宿主先通过 `WebShellWithProviders` 的 `sessionId` 和 workspace props 打开目标会话，再调用公开 API：

```tsx
import { useRef } from 'react';
import { WebShellWithProviders, type WebShellApi } from '@qwen-code/web-shell';

const shellRef = useRef<WebShellApi>(null);
// 将 shellRef 传给 <WebShellWithProviders shellRef={shellRef} {...connectionProps} />。
// 会话/历史就绪后，在宿主的结果点击处理函数里调用：
const result = await shellRef.current?.navigateToMessage({
  sessionId: selectedSessionId,
  recordId: selectedPersistedRecordId,
  signal: abortController.signal,
});
```

公开类型为 `WebShellMessageNavigationRequest`、`WebShellMessageNavigationResult`。
`recordId` 是持久化用户/助手转录记录 ID，不是渲染消息 ID 或摘要。
接口分页加载尚未渲染的历史、激活目标并在随后渲染中滚动高亮，不修改草稿；
搜索图标隐藏时也可调用。很旧的目标需要线性扫描历史，找到记录即停止。

结果 `status` 为 `located`、`not_found`、`not_ready`、`session_mismatch`、`unsupported`、
`cancelled` 或 `error`；`located` 不代表滚动动画已结束。未就绪时宿主须等待会话/视图就绪后再调用。聊天被面板或全页视图覆盖时返回 `not_ready`，宿主应先恢复聊天视图。
新请求、会话/工作目录变化、卸载或 AbortSignal 取消会使旧请求失效。
现有跨会话搜索接口仅返回会话和摘要，不提供 `recordId`；宿主搜索需补齐记录 ID 后才可精确定位。

## URL 导航（可选）

`WebShellWithProviders` 支持 `urlNavigation={{ basePath: '/agentic-code' }}`。
独立入口默认启用同一实现，并推断既有部署基础路径（默认根路径）。嵌入组件默认不启用，原有受控
`sessionId`、`workspaceId`、`workspaceCwd` 和 `sessionContext` 接入保持兼容。
启用后，显式初始会话目标 props 优先于 URL，后续目标 props 变化 replace 地址；
宿主必须停止自行写 history，避免双重控制。`lockWorkspaceCwd` 仍是宿主约束。

基础路径下支持 `/session/<id>`、`/plugins`、`/channels`、`/scheduled-tasks`、
`/goals` 和 `/settings`。会话保留原有 `workspace` / `context` 协议，页面仅定位
页面，设置不持久化分类或作用域。无关参数（包括宿主的实例参数）和 fragment 保留。
主动导航新增历史，重复点击不新增；浏览器前进后退恢复页面和会话。页面来源保存在
history.state，直接打开或复制到新标签页的页面没有来源时返回空白聊天，不创建会话。

宿主部署必须把基础路径和上述深层路径的文档请求返回宿主 HTML，并保留 API 路由。
`basePath` 只配置客户端，不创建服务端 rewrite。Qwen daemon 自带五个页面的文档
GET/HEAD 入口，JSON 请求、子路径和写请求仍走原有鉴权/API。
详见[导航协议设计](../../docs/design/web-shell-url-navigation.zh-CN.md)。
