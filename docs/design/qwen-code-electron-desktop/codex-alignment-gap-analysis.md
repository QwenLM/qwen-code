# Qwen Code Desktop and Codex Desktop Gap Analysis

> 目标：基于真实启动的 Qwen Code Electron 开发版，以及现有 Codex Desktop
> 参考体验，梳理 Qwen Code Desktop 在信息架构、交互流程和视觉完成度上的差距，
> 作为后续优化方向。

## Observation Scope

本次观察覆盖日期为 2026-04-25。

Qwen Code Desktop 使用仓库开发版启动：

```bash
npm run build --workspace=packages/desktop
npm run start --workspace=packages/desktop
```

进程确认来自当前仓库：

```text
/Users/dragon/Documents/qwen-code/node_modules/electron/dist/Electron.app
cwd/app-path=/Users/dragon/Documents/qwen-code/packages/desktop
renderer=file:///Users/dragon/Documents/qwen-code/packages/desktop/dist/renderer/index.html
```

通过 Computer Use 实际操作了 Qwen Code Desktop 的以下路径：

- Chat：未选中 session、选中历史 session、查看用户/助手消息。
- Changes：查看 modified/untracked 文件、hunk 操作、commit 输入区。
- Settings：查看 Auth & Model、Session、Runtime 信息。
- Terminal：在内置终端执行无害命令 `pwd`，确认工作目录和输出反馈。

Codex Desktop 侧，Computer Use 对 `com.openai.codex` 返回安全限制，无法直接读取
或点击 Codex 窗口。因此本文没有伪造“Computer Use 已操作 Codex”的证据。Codex
参照来自当前 Codex 桌面体验的可见特征，以及同目录参考截图
`docs/design/qwen-code-electron-desktop/home.jpg`。后续若要做更严格的像素级对比，
需要由人手动提供 Codex 截图或允许另一种安全的观察方式。

## Alignment Goal

Qwen Code Desktop 不应复制 Codex 的品牌、图标、文案和精确视觉样式，但应该对齐
Codex 的产品成熟度：

- 用户一眼知道自己在哪个项目、哪个线程、什么权限、什么模型、什么 Git 状态。
- 对话是主舞台，文件、diff、终端、提交是围绕对话展开的工具，而不是抢占主舞台。
- 修改代码后，用户能顺滑地看到、打开、审查、接受、撤销、提交。
- 高风险动作不会以“巨大主按钮”的形式暴露，必须有明确语义和确认。
- UI 像一个长期使用的开发者工作台，而不是把后端状态和调试信息直接摆出来。

## Executive Summary

当前 Qwen Code Desktop 已经具备工作台雏形：项目/线程列表、聊天区、Changes
面板、设置页和内置终端都能跑通。但是它更像“开发期调试台”，离 Codex 的成熟桌面
体验主要差在四件事：

1. 信息架构还没有形成稳定的主次关系。Qwen 把 Chat、Changes、Settings、Terminal
   都平铺在主界面里，Codex 则让对话成为中心，把工具能力收纳为侧栏、底栏、按钮和
   inline cards。
2. 线程和项目列表缺少治理。Qwen 直接暴露长 prompt、完整路径和内部 session
   信息，Codex 更强调短标题、项目分组、相对时间、搜索和最近上下文。
3. Composer 还没有成为任务控制中心。Codex 的输入框同时承载附件、权限模式、模型、
   发送状态和本地上下文；Qwen 目前只有 textarea、Stop、Send。
4. 代码审查流程语义不够清楚。Qwen 的 `Accept` 实际更像 stage/accept hunk，
   `Revert All` 等高风险动作过于显眼；Codex 把变更摘要、文件卡、提交入口和撤销
   动作更自然地嵌入任务流。

## Gap Matrix

| Area               | Codex Reference                                                                     | Qwen Current                                                                 | Direction                                                                          | Priority |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Sidebar navigation | New conversation, Search, Plugins, Automation, grouped projects, settings at bottom | New Thread, Settings, Projects, Threads; no search/plugins/automation        | Build a persistent app rail and compact project/thread browser                     | P0       |
| Thread rows        | Short titles, relative time, grouped under project                                  | Raw long prompts, repeated full paths, no time metadata                      | Normalize titles, hide paths by default, add time and overflow menu                | P0       |
| Top bar            | Thread title, project, overflow, run/IDE/submit/diff/file icons, update affordance  | Title, truncated status pills, Chat/Changes/Settings tabs, Refresh Git       | Split title, status, and action clusters; use icon buttons with tooltips           | P0       |
| Main canvas        | Conversation-first, readable messages, code blocks, file cards, change summaries    | Boxed user/assistant cards, internal UUID/status visible, sparse actions     | Build rich message primitives and hide protocol details                            | P0       |
| Composer           | Floating task control: attach, permission, model, mic/send, local mode/branch       | Large textarea with Stop/Send; disabled without selected session             | Always-composable project prompt; lazy-create thread on send                       | P0       |
| Changes            | Inline changed-file summary plus review controls                                    | Whole-page tab with raw diff, Accept/Revert buttons, terminal squeezed below | Move review into right drawer and inline summaries; clarify stage/revert semantics | P0       |
| Terminal           | Available as a tool/drawer, not always dominant                                     | Always consumes bottom space; useful output and Send to AI exist             | Make terminal collapsible and context-aware                                        | P1       |
| Settings           | Separate product settings, key controls surfaced in composer/status                 | Settings tab mixes auth, session and runtime diagnostics                     | Reorganize into Account, Model, Permissions, Tools, Advanced                       | P0       |
| Visual system      | Polished dark app shell, translucent sidebar, clear icon language                   | Heavy boxed dashboard style, mixed gradients, limited iconography            | Reduce borders, improve spacing/type scale, introduce icon system                  | P0       |
| Safety semantics   | Destructive actions are secondary/hidden/confirmed                                  | Revert All is prominent near Accept All                                      | Confirm destructive review actions and move them out of primary path               | P0       |

## Detailed Findings

### 1. App Shell and Sidebar

Codex 的左侧栏首先是 app 级导航：新对话、搜索、插件、自动化，然后才是项目和线程。
这让用户能理解“我在一个 AI coding workspace 里”，而不是只看到某个项目的内部
列表。底部设置入口固定，升级/更新等状态也有明确位置。

Qwen 当前左侧栏是：

- brand lockup: `Qwen Code DESKTOP`
- `New Thread` 和 `Settings`
- 当前 workspace path
- Projects 列表
- Threads 列表

主要问题是 Threads 列表直接展示原始 prompt，比如很长的 markdown command 文本，
每行还重复完整项目路径。列表可用，但信息噪声很高，滚动后很难定位。项目和线程也
没有搜索、分组、相对时间、上下文菜单、归档或删除入口。

优化方向：

- 左侧栏改为 app rail + project/thread browser 的结构。
- 固定入口：New Conversation、Search、Plugins、Automations，底部 Settings。
- 线程行只显示短标题、相对时间和可选状态，不重复完整路径。
- 长 prompt 必须生成标题；失败时使用 `(session)` 或首句截断，而不是完整命令正文。
- 项目行显示项目名、branch、dirty indicator；完整 path 放 tooltip/details。
- 增加线程搜索和项目内过滤。

### 2. Top Bar and Status Model

Codex 顶部栏把“当前任务身份”和“可执行动作”分开。左侧是线程标题、项目名和更多
菜单，右侧是运行、IDE/编辑器、提交、终端、文件、diff 等图标按钮。底部/输入区附近
再显示本地模式、branch、模型和权限。

Qwen 当前顶部栏同时承担标题、连接状态、branch、dirty count、视图 tabs 和 Refresh
Git。结果是 `Conn...`、`zth/feat-d...`、`5 modified · 0 staged · ...` 这些 pill
被截断，Chat/Changes/Settings tabs 又占据了最醒目的操作区。Refresh Git 是文字按钮，
和真正的任务动作优先级相近。

优化方向：

- 左侧：线程标题、项目名、更多菜单。
- 中间或右侧：compact 状态 pill，只显示 Running/Ready/Needs Approval/Error。
- 右侧：Run/Stop、IDE、Commit/Submit、Terminal、Files、Diff、Settings 等 icon
  buttons，全部带 tooltip。
- Git dirty count 应和 diff/submit 入口绑定，不单独占一个大 pill。
- Refresh Git 降级为 icon 或 changes drawer 内的 secondary action。
- Chat/Changes/Settings 不应作为全局 tabs 平铺；Changes 更适合作为右侧 drawer，
  Settings 更适合作为独立页面/弹层。

### 3. Conversation and Message Rendering

Codex 的对话区是主舞台：assistant prose、代码块、文件卡、变更摘要和操作按钮都在
同一阅读流里。用户看到的不只是“模型回了什么”，而是任务如何推进、哪些文件被改变、
下一步可以做什么。

Qwen 当前 Chat 已能加载历史 session，并展示 user/assistant card。但存在几个明显
问题：

- 内部 UUID 如 `Connected to 2a236d36-...` 直接显示在对话中。
- role label 和卡片边框偏工程调试风格，不像最终产品消息。
- 缺少 message action row，如 copy、thumbs up/down、open files、retry、branch
  action、timestamp。
- 没有 inline changed files summary；代码修改被迫切到 Changes tab 才能看。
- 没有明确的 tool call timeline、command approval card、file read chips。

优化方向：

- 隐藏 ACP/session UUID，只在 diagnostics 中可见。
- 建立消息组件系统：user message、assistant message、thinking/plan、tool call、
  command approval、file card、diff summary、error/retry。
- Assistant 消息下方增加 action row：copy、feedback、open changed files、retry。
- 文件引用以 cards/chips 出现，支持 Open、Reveal、Copy path。
- 变更摘要作为 conversation inline block 出现，例如 “2 files changed +85 -4”。

### 4. Composer as Control Center

Codex 的 composer 是用户控制任务的核心：输入框、附件、权限模式、模型、语音/发送、
本地模式和 branch 信息都聚合在底部。用户不需要离开输入区就知道“这个请求会以什么
权限、什么模型、在哪个项目/分支运行”。

Qwen 当前 composer 是普通 textarea + Stop/Send。未选中 session 时 textarea disabled；
这会让用户进入项目后还必须先理解“线程选择”才能开始。选中 session 后也没有权限模式、
模型、附件、slash command、`@file` 或上下文 chips。

优化方向：

- 在已选项目但未选 session 时，composer 也应可输入；点击 Send 时 lazy-create
  thread。
- Composer 底部控制条至少包含：附件、权限模式、模型选择、context/project、branch、
  Send/Stop。
- 支持 `@file`、`/command`、拖拽文件、粘贴图片。
- 权限模式用清晰文案和颜色表达，例如 Read Only / Ask Before Run / Full Access。
- Send disabled 时要给出原因，例如 “Select a project first” 或 “Add a message”。

### 5. Changes, Review, and Commit Flow

Codex 把代码变更作为任务结果的一部分呈现：对话中有 changed-files summary，顶部有
diff count，文件卡可以打开，提交入口在右上或任务末尾自然出现。用户从“看到总结”到
“审查文件”再到“提交”是连续的。

Qwen 当前 Changes tab 功能很完整，但交互像一个独立 diff 工具：

- Changes 占据整个 workbench，聊天被完全替换。
- Raw diff 大块展开，阅读压力较大。
- `Revert All` 和 `Accept All` 同时作为显眼按钮，容易误触。
- `Accept` 语义不清；如果实际是 stage，应使用 Stage/Unstage，若是接受 AI patch，
  需区分 accept-to-worktree 和 stage-to-index。
- Commit button disabled 时没有解释。
- Terminal 仍固定在底部，挤压 diff 审查高度。

优化方向：

- 改成右侧 Review drawer：Files、Diff、Summary、Commit 四个局部 tab。
- Conversation 中保留 changed-files summary，点击打开 drawer。
- 高风险 `Revert All` 移到 overflow menu，并加二次确认。
- 明确术语：Stage File/Hunk、Unstage、Discard Changes、Apply Patch、Commit。
- Commit 区说明 disabled 原因，比如 “Stage at least one file to commit”。
- 文件级 controls 使用 icon + tooltip，减少文字按钮密度。

### 6. Terminal

Qwen 的内置终端已经有价值：可以在项目目录运行命令、复制输出、发送给 AI。本次执行
`pwd` 后，输出正确显示为 `/Users/dragon/Documents/qwen-code`，说明项目作用域是对的。

差距主要在布局和任务流：

- Terminal 永远占据底部空间，即使没有输出。
- Chat/Changes/Settings 每个视图都要和 Terminal 抢高度。
- Copy Output、Send to AI、Clear、Kill 都是文字按钮，视觉重量偏大。
- Terminal output 还没有进入 conversation timeline，用户需要自己理解两块区域的关系。

优化方向：

- Terminal 改为可折叠 drawer；默认只显示一行 handle/status。
- 运行中显示 command chip、exit code、duration。
- 输出块可以一键 attach/send back to composer，而不是直接发送到 AI 后立即触发任务。
- Copy/Clear/Kill/Send to AI 使用 icon buttons，危险动作有确认或更弱视觉权重。
- Terminal 打开状态按项目/线程记忆。

### 7. Settings and Diagnostics

Qwen Settings 当前有 Auth & Model、Session、Runtime 三块。对开发者诊断有帮助，但
对普通用户过于内部化：server URL、Node version、ACP Not started、health ms 都在
主设置页直接出现。

Codex 更接近产品设置：关键控制在主任务流中可见，完整设置页承担账户、模型、权限、
插件、自动化、外观等管理职责。

优化方向：

- 设置入口固定在左下角和 topbar icon，不作为主 workbench tab。
- 一级分组建议：Account、Model Providers、Permissions、Tools & MCP、Terminal、
  Appearance、Advanced。
- Runtime、server URL、ACP 状态放入 Advanced/Diagnostics。
- API key 字段需要明确状态：configured / missing / invalid / saved。
- OAuth 和 API key 是两条登录路径，文案上应避免让用户以为两者都必须配置。

### 8. Visual System

Codex 的视觉特征是深色、低噪声、层级清楚、icon 语义强，sidebar 有轻微材质感，
主阅读区有足够留白。Qwen 当前也使用深色，但更像后台 dashboard：

- 边框和卡片过多，几乎每块区域都被框起来。
- 绿色/蓝色渐变背景和按钮让主次关系有些混。
- 大量文字按钮导致界面显得重。
- 消息、diff、terminal、settings 都用相似卡片语言，缺少场景差异。
- 顶部和底部区域的空间分配不够稳定，容易显得拥挤。

优化方向：

- 保留 Qwen 品牌色，但降低大面积渐变和重边框。
- 建立 token：background、surface、surface-raised、border-subtle、accent、
  danger、warning、success、text-primary、text-muted。
- 引入统一 icon set，常用动作优先用 icon button + tooltip。
- 对话区减少框线，使用排版和 spacing 建层级。
- Diff/terminal/settings 使用更密集的工具界面风格，但不要压过 conversation。

## Recommended Product Shape

目标布局建议：

```text
┌──────────────────────────────────────────────────────────────┐
│ title / project / branch                  action icon cluster │
├───────────────┬──────────────────────────────┬───────────────┤
│ app nav       │ conversation                 │ review drawer  │
│ projects      │ messages                     │ files/diff     │
│ threads       │ inline changes/tool cards    │ commit         │
│ settings      │ composer                     │               │
├───────────────┴──────────────────────────────┴───────────────┤
│ collapsed terminal / status line                              │
└──────────────────────────────────────────────────────────────┘
```

关键原则：

- Conversation 永远是默认主视图。
- Changes 是可打开/关闭的审查上下文，不替换 conversation。
- Settings 是管理页面，不参与任务工作台 tabs。
- Terminal 是工具 drawer，不长期占据空白高度。
- Composer 是权限、模型、上下文和发送的控制中心。

## Implementation Roadmap

### P0: Make It Feel Like a Coding Agent Workspace

1. 重做 app shell：左侧增加 New Conversation、Search、Plugins、Automations、Settings
   的固定入口，项目/线程列表改为 compact rows。
2. 重做 composer：未选 session 也可输入，send 时 lazy-create session；加入权限模式、
   模型、附件、project/branch 状态。
3. 重做 chat messages：隐藏内部 UUID，增加 markdown/code/file cards/tool cards 和
   message action row。
4. 重做 changes 入口：从主 tab 改为右侧 review drawer，并在 conversation 中显示
   changed-files summary。
5. 整理 destructive actions：Discard/Revert 类动作放 overflow，并统一二次确认。
6. 重构 settings 信息架构：Runtime 进入 Advanced/Diagnostics。

### P1: Make It Efficient for Daily Use

1. Sidebar 搜索、线程归档/重命名/删除、项目最近访问排序。
2. Command palette：新建线程、打开项目、搜索文件、打开设置、切换模型。
3. Terminal drawer：折叠、命令历史、输出 attach 到 composer。
4. Topbar action cluster：IDE、files、diff、terminal、submit、run/stop。
5. Keyboard shortcuts：new conversation、search、toggle terminal、toggle review、
   focus composer。

### P2: Match Advanced Codex-Like Capabilities

1. Plugins/Skills 管理页。
2. Automations 管理页和任务 inbox。
3. Worktree/parallel task 支持。
4. Browser preview 和页面批注。
5. GitHub PR/review context。

## Verification Criteria

后续每次 UI 对齐迭代都应通过真实 Electron 验证，而不是只看 React 组件：

- 从仓库启动开发版，确认 renderer URL 来自 `packages/desktop/dist/renderer` 或 dev
  server。
- 用 CDP/Computer Use 覆盖：打开项目、创建线程、发送消息、查看 approval、查看
  changed-files summary、打开 review drawer、运行终端命令、打开 settings。
- 桌面宽度 1240px 下无横向滚动，composer、review drawer、terminal 不互相遮挡。
- 未选 session 时 composer 仍能创建新任务。
- 高风险 discard/revert action 必须出现确认。
- Settings 首页不直接暴露 server URL、Node version、ACP UUID 等诊断细节。
