# Chat Panel 收敛计划（说人话版）

> 关联 issue：QwenLM/qwen-code#5883 ｜ 分支：`feat/chat-panel`

## 一句话

把现在**三套各自维护**的聊天面板，收敛成**一份共享代码**，三端都用它。

## 为什么要做

我们有三个地方都画了"聊天对话流 + 输入框"：

1. **web-shell**（`@qwen-code/web-shell`）—— 最新重构过、样式最好、功能最全，**当基准**。
2. **VSCode 插件 webview**（`vscode-ide-companion`）—— 走 ACP 协议。
3. **桌面 App**（`@craft-agent/ui`）—— 走 ACP，还和上游 openwork 双向同步。

三套长得像、却各写各的。结果就是：**改一个 bug 要改三遍**，而且三端慢慢长歪、体验不一致。

目标：**只维护一份面板**，另外两端对齐过来。

## 怎么做（核心思路）

抽一个独立包 **`@qwen-code/chat-panel`**，它只管"怎么画"，不管"数据从哪来"：

- 面板是**纯 props 驱动**的：你给它一个 `Message[]`（统一的消息数组），它就负责渲染。
- 每个端写一个**薄薄的 adapter**，把自己的数据（daemon transcript / ACP 流 / craft 消息）翻译成这个统一的 `Message[]`，喂给面板。
- 面板里所有"宿主特有"的东西（翻译、markdown 渲染器、主题、特殊面板）都通过**注入口（seam）**接进来——包自己不写死，谁用谁注入。

一句话：**面板负责画，宿主负责喂数据 + 注入自己的渲染器。**

```
        ┌─────────────────────────────┐
        │   @qwen-code/chat-panel      │  ← 只此一份，负责"画"
        │   <ChatPanel messages=[...]/> │
        └──────────────┬──────────────┘
        喂 Message[] + 注入 seam
   ┌──────────┬────────┴────────┬──────────────┐
 web-shell   VSCode webview   桌面 App(overlay)
 (daemon)    (ACP)            (ACP + 双向同步)
```

### 为什么是「切片」，不是直接复用整个 web-shell

很自然会问：web-shell 最全，干脆让大家直接用它不就行了？精神上对——但「复用整个 web-shell app」行不通，原因有三：

1. **web-shell 焊死在 daemon 传输上**：它的 `App` / `useMessages` / `useConnection` 都假设有 daemon 后端，而 VSCode 和桌面都走 ACP、没有 daemon。直接复用就得在它们里面再起 daemon 或写 ACP→daemon 转接层——这层我们**明确不做**（复用的是「展示面板」，不是数据层）。
2. **web-shell 装的远不止面板**：还带 session 管理、导航、连接、dialog、状态栏整套壳；各端只想要会话流那块，壳各有各的。
3. **桌面同步红线**：桌面和上游 openwork 双向同步，把 `@qwen-code/web-shell`（带 daemon 依赖的重包）拉进同步树会直接污染 openwork。

所以 `@qwen-code/chat-panel` = **「web-shell 的面板，去掉 daemon 耦合后的可复用切片」**。「大家复用 web-shell」落地成：web-shell 原地用组件（它就是源头），VSCode/桌面把这个切片拉过去 + 各写薄 adapter 把自己的数据映射成 web-shell 同款的 `Message[]`。契约就是 web-shell 现有形状，没另起炉灶。

## 包里现在有啥（WS1 之后）

`packages/chat-panel/src/`：

- **统一契约** `adapters/`：`Message` 判别联合（11 种）+ `ToolCall` / `TodoItem` / `PermissionRequest`。大概长这样：

  ```ts
  type Message =
    | { id; role: 'user'; content; images? }
    | { id; role: 'assistant'; content; isStreaming?; usage? }
    | { id; role: 'tool_group'; tools: ToolCall[] }
    | { id; role: 'plan'; todos: TodoItem[] }
    | { id; role: 'system'; content; variant: 'info' | 'error' | 'warning' }
    | ...; // user_shell / thinking / btw / insight_* 共 11 种
  ```

- **三个注入口（seam）**：`i18n`（翻译函数 `t`）/ `markdown`（渲染器 + 图片白名单）/ `customization`（工具头徽章、紧凑思考、整轮折叠、以及 `renderSystemMessage`——`/stats` `/mcp` 这类面板留宿主，由它注入）。全部经一个 `ChatPanelProviders` 一次性注入。
- **组件**：`MessageList`（顶层列表）、`MessageItem`（按 role 分发）、11 个消息渲染器、`ToolGroup` 子树（diff / 子 agent / 并行 agent）、`StreamingStatus`（流式 + 计时）。
- **`<ChatPanel>`**：把上面这些 + `composerSlot`（宿主自己的输入框）组装好的成品。
- **构建**：`bun run build` → `dist/index.js`（CSS 自动注入，不用单独引样式）+ `.d.ts`；**包内零 daemon 依赖**（lint 卡死）。

宿主只做两件事：把自己的数据映射成 `Message[]`、把自己的 `t` / markdown 渲染器注进去。

## 路线图（一步步）

每步都在 feature flag 后面合入，能随时回滚；每步都要现有测试全绿才算过。

| 阶段     | 干啥                                                                                                                       | 状态      |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------- |
| **WS0**  | 打地基：把 web-shell 面板和 daemon 解耦，建空包 + 注入口骨架                                                               | ✅ 已合   |
| **WS1**  | **搬家**：把整条会话流（所有消息渲染 + 列表 + 工具组 + 流式指示器）搬进包，建好 i18n / markdown / customization 三个注入口 | ✅ 刚提交 |
| **WS2**  | web-shell **真正改用** `<ChatPanel>`（现在只是从包里 import，还没换成统一入口）；像素级对齐验证                            | ⏭️ 下一步 |
| **WS-C** | **输入框收敛**：盘点三端输入框差异，定"共用一个 / 各用各的（composerSlot）"。输入框暂时留在各端，没搬                      | 待定      |
| **WS3**  | VSCode 接上：写 ACP → `Message[]` 的 adapter，flag 后并排挂上去试                                                          | 待定      |
| **WS4**  | VSCode adapter 补全 → 默认开、删旧渲染                                                                                     | 待定      |
| **WS5**  | 桌面 App 接上（overlay 挂载 + 同步安全：绝不污染上游 openwork）                                                            | 待定      |
| **WS6**  | 富渲染对齐（mermaid / latex / pdf / 表格 …）→ 桌面默认开、删旧路径                                                         | 待定      |

> 关键路径：WS0 → WS1 → WS2 → WS3 → WS4 → WS5 → WS6。VSCode 先上是为了在桌面（最贵、不可逆的同步风险）之前，用第二个端把"统一契约"压测一遍。

## 几个已经拍板的决定

- **不搞 ACP→daemon 的转接层**：我们复用的是"展示面板"，不是 daemon 数据层。各端把自己已有的数据映射成 `Message[]` 就行。
- **输入框（ChatEditor）暂不搬**：它和 web-shell 的补全 / 语音 / mentions 耦合太深，留给 WS-C 专门盘点；`<ChatPanel>` 先用 `composerSlot` 把宿主的输入框插进来。
- **逃生口先行**：统一契约里留了 `hostData?`（每条消息的不透明宿主通道）+ 渲染 seam，避免桌面/VSCode 的特性被"压平"丢掉。
- **桌面同步安全是红线**：桌面和上游 openwork 双向同步，任何 qwen 专属文件/依赖**绝不能**漏进同步——靠 `.qwen.*` overlay + 双向 diff 卡口兜底。

## 现在到哪了

- WS0、WS1 都已落地、全绿（web-shell 类型检查 0 错、测试 466/471，5 个是环境缺构建产物的已知项）。
- 包能独立构建出 `dist`（带自注入 CSS），且**完全不依赖 daemon**。
- 已提交（分支 `feat/chat-panel`，尚未 push）：`33cd35d9` WS1 搬家、`5124e6de` 本路线图。

### 下一步 WS2 具体要做啥

现在 web-shell 只是"从包里 import 这些组件"，还没换成统一入口。WS2 就是把 `App.tsx` 里**各自摆放的** `MessageList` + `StreamingStatus` + `ChatEditor`，换成**一个** `<ChatPanel>`：

1. `App.tsx` 渲染 `<ChatPanel messages={...} composerSlot={<ChatEditor/>} .../>`，把现有的 daemon 数据继续喂进 `messages`、把 seam 值注进去。
2. session / 导航 / shell 这些不动（它们本来就不归面板管）。
3. 验收：跑通现有全部测试 + 抽包前后**像素对比**干净，确认没画歪。

这一步把"web-shell 自己也走统一面板"坐实，之后 VSCode / 桌面照着同一个 `<ChatPanel>` 接就行。

## 想看更细的

完整的 17-agent 定稿计划（含对抗式审查、每个决策门、风险缓解）在团队设计文档里；这份 README 是给"想三分钟看懂在干嘛"的人看的。
