# Qwen Code Desktop Codex Alignment Implementation Plan

> 目标：把 `codex-alignment-gap-analysis.md` 中的差异结论转成可执行的桌面端优化路线。
> 本文关注工作拆分、依赖顺序、验收标准和测试覆盖，不替代具体 PR 的技术设计。

## Product North Star

Qwen Code Desktop 的主体验应从“功能并列的调试工作台”转向“对话驱动的本地编码
代理工作台”。用户打开项目后，默认路径应该是：

```text
Open project -> type request -> agent works -> review changed files -> commit or continue
```

这个路径里，Conversation 是主舞台；Review、Terminal、Settings、Project browser
都是辅助面板。界面应该持续回答五个问题：

- 当前任务在哪个项目和分支上运行？
- 当前 agent 用什么模型和权限？
- agent 正在做什么、等我做什么？
- 它读了哪些文件、改了哪些文件？
- 我如何继续、审查、撤销或提交？

## Non-Goals

- 不复制 Codex 品牌、图标、文案和精确视觉样式。
- 不在第一轮引入完整插件市场、自动化调度、worktree 并行任务或浏览器预览。
- 不把所有 CLI 能力一次性做成设置页。
- 不把高风险 Git/文件操作做成无确认的一键动作。

## Milestone Plan

### M1: Workbench Skeleton and Navigation

目标：先让整体产品形态从 dashboard 变成 coding agent workspace。

主要改动：

- 重构 `WorkspacePage` 的布局模型：conversation 默认常驻，review 和 terminal
  成为可折叠辅助区域。
- 重构 `ProjectSidebar`：增加 app-level entries，压缩 project/thread rows，隐藏完整
  path，增加相对时间和 overflow menu 的预留位。
- 重构 `TopBar`：分离 title、workspace status 和 action cluster。
- 引入 icon button 组件和 tooltip 基础组件。
- 为当前 layout 增加稳定 `data-testid`，用于 CDP/E2E 验证。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/ProjectSidebar.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/styles.css`

验收标准：

- 1240x820 默认窗口下，conversation 面板是视觉主区域。
- 左侧线程列表不再展示完整长 prompt 和重复 path。
- Topbar 没有被截断到难以理解的 `Conn...`、`zth/feat-d...` 状态。
- Settings 不再作为和 Chat/Changes 同级的主工作 tab。

### M2: Composer and Session Creation

目标：用户打开项目后可以直接输入请求，不必先理解 session 状态。

主要改动：

- 未选中 session 但已选中 project 时，composer 可输入。
- 首次 send 时自动创建 session，并把输入作为首条 prompt。
- Composer 底部控制条加入 permission mode、model selector、project/branch context、
  attach button 和 send/stop。
- Send disabled 时展示明确原因。
- 保留 keyboard path：`Enter` 发送、`Shift+Enter` 换行。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/stores/chatStore.ts`
- `packages/desktop/src/renderer/stores/sessionStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.ts`

验收标准：

- 打开项目后不选线程，输入并发送消息会创建新线程。
- Composer 能在同一处看到权限、模型、项目和分支。
- 没有项目时 composer 仍禁用，但明确提示 “Open a project to start”。
- 发送中 send 变 stop，完成后恢复 send。

### M3: Message System and Agent Activity

目标：让对话区呈现任务进展，而不只是 user/assistant 文本框。

主要改动：

- 隐藏 ACP/session UUID 等内部诊断信息。
- 建立 message primitives：user message、assistant message、tool call、command
  approval、file card、diff summary、error/retry。
- Assistant 消息底部增加 actions：copy、feedback、retry、open changed files。
- 文件引用统一渲染成 chips/cards，支持 open/reveal/copy path。
- Agent 正在运行时显示 compact activity row，而不是只靠 topbar READY/idle。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/ChatThread.tsx`
- `packages/desktop/src/renderer/components/layout/formatters.ts`
- `packages/desktop/src/renderer/stores/chatStore.ts`
- `packages/desktop/src/renderer/api/websocket.ts`

验收标准：

- 历史 session 不再在聊天中显示 `Connected to <uuid>`。
- 有工具调用或权限请求时，用户能在消息流中看到清晰 card。
- 代码变更完成后，conversation 中出现 changed-files summary。
- Copy/retry/open actions 有可访问名称和 hover/focus 状态。

### M4: Review Drawer and Commit Flow

目标：把 Changes 从“整页 diff 工具”改为任务上下文里的审查抽屉。

主要改动：

- `ReviewPanel` 改成右侧 drawer，可打开/关闭，不替换 conversation。
- Drawer 内保留 Files、Diff、Summary、Commit 局部 tab。
- Conversation changed-files summary 点击后打开 drawer。
- 统一术语：Stage、Unstage、Discard、Commit；避免 `Accept` 和 `Revert` 混用。
- `Discard All`、`Discard File` 等高风险动作移到 overflow，并要求确认。
- Commit disabled 时解释原因。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/ReviewPanel.tsx`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`
- `packages/desktop/src/renderer/api/client.ts`

验收标准：

- 用户可以边看 conversation 边打开 review drawer。
- 点击 changed-files summary 能定位到对应文件。
- 没有 staged changes 时 commit 区解释为什么不能提交。
- 任意 discard all/file/hunk 动作都有确认，不会一键误删本地改动。

### M5: Terminal Drawer

目标：保留终端能力，但不要让它长期占用主视图高度。

主要改动：

- Terminal 默认折叠为底部 status strip，需要时展开。
- 输出块展示 command、exit code、duration、cwd。
- Send to AI 改为 attach/send to composer 的模式，避免意外触发新任务。
- Copy、Clear、Kill、Attach 使用 icon buttons；Kill/clear 有更弱视觉权重。
- Terminal 展开状态按 project/session 记忆。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/TerminalDrawer.tsx`
- `packages/desktop/src/renderer/stores/terminalStore.ts`
- `packages/desktop/src/renderer/components/layout/WorkspacePage.tsx`

验收标准：

- 没有终端输出时主界面不浪费大块空白。
- 执行 `pwd` 后能看到 cwd、exit code 和输出。
- 输出可附加到 composer，用户确认后再发送。
- 运行中命令有明确 stop/kill 状态。

### M6: Settings Information Architecture

目标：把设置页从 runtime debug 面板整理成用户可理解的产品设置。

主要改动：

- Settings 独立为页面或 modal，不作为 workbench 主 tab。
- 一级分组：Account、Model Providers、Permissions、Tools & MCP、Terminal、
  Appearance、Advanced。
- Runtime/server/Node/ACP/health 进入 Advanced Diagnostics。
- API key/OAuth 状态可读：missing、configured、invalid、saved。
- 常用模型和权限控制同步显示在 composer/topbar。

建议文件范围：

- `packages/desktop/src/renderer/components/layout/SettingsPage.tsx`
- `packages/desktop/src/renderer/stores/settingsStore.ts`
- `packages/desktop/src/renderer/stores/modelStore.ts`
- `packages/desktop/src/renderer/components/layout/TopBar.tsx`

验收标准：

- 默认 Settings 首页不直接显示 server URL、Node version、ACP status。
- 用户能在 2 次点击内找到模型/API key/权限设置。
- Advanced Diagnostics 仍保留完整工程诊断信息。

## Cross-Cutting Design System Work

这些改动应该贯穿 M1-M6，而不是最后补：

- 建立 `IconButton`、`SegmentedControl`、`Pill`、`Tooltip`、`Drawer`、`InlineCard`
  等基础组件。
- 引入或确定图标方案。若可新增依赖，建议使用 `lucide-react`；若暂不新增依赖，
  先封装本地 minimal icon set，避免每处手写 SVG。
- 统一 type scale：sidebar row、topbar、message body、code/diff、small label。
- 降低全局重边框和大面积渐变；保留 Qwen 品牌色作为 accent，而不是背景主色。
- 所有 icon-only controls 必须有 `aria-label` 和 tooltip。
- 所有 destructive controls 使用 danger token，并避免放在 primary action 位置。

## Data and API Requirements

现有 UI 有些问题来自数据形态不够产品化。建议补齐这些字段或前端派生逻辑：

| Need                        | Source                                        | Notes                                             |
| --------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Thread display title        | session summary or derived first user message | 长 prompt 需要生成短标题，失败时 fallback 到首句  |
| Thread updated time         | session summary                               | 用于 sidebar relative time 和排序                 |
| Project display name        | project path basename                         | 完整 path 仅放 details/tooltip                    |
| Project dirty summary       | git service                                   | 绑定 diff/submit 入口                             |
| Permission mode             | session/model/settings state                  | Composer 必须常驻展示                             |
| Active model                | model store/session state                     | Composer 和 settings 双向同步                     |
| Changed files summary       | review/git service                            | Conversation inline summary 和 review drawer 共用 |
| Terminal last command state | terminal store                                | 用于 collapsed terminal strip                     |

## Testing Plan

### Unit and Component Tests

- Sidebar row formatting：长 prompt 截断、path 隐藏、relative time 显示。
- Composer state machine：no project、project/no session、sending、running、error。
- Review terminology：stage/unstage/discard/commit disabled reason。
- Settings grouping：diagnostics 默认不出现在首页。

运行方式保持包内执行：

```bash
cd packages/desktop
npx vitest run src/renderer/components/layout/WorkspacePage.test.tsx
```

### Electron E2E

扩展 `packages/desktop/scripts/e2e-cdp-smoke.mjs`，至少覆盖：

- 启动 app 后确认 conversation 是主视图。
- 打开项目后未选 session，composer 可输入并 lazy-create session。
- fake ACP 返回 changed-files summary 后，点击打开 review drawer。
- 执行终端命令，展开/折叠 terminal drawer。
- 打开 Settings，确认 diagnostics 在 Advanced 下。
- 触发 discard all，确认出现确认 UI，取消后本地文件未变化。

### Visual Regression Checklist

人工或截图检查至少覆盖：

- 1240x820 默认桌面窗口。
- 960x640 最小窗口。
- 长线程标题、长路径、长分支名。
- 无项目、空项目、有脏 Git 状态、有运行中任务。
- 深色主题下 focus ring、hover、disabled、danger 状态。

## Suggested PR Breakdown

1. `desktop: introduce workbench primitives`
   - 增加基础组件和 CSS tokens，不改主要行为。
2. `desktop: restructure sidebar and topbar`
   - app rail、compact rows、action cluster。
3. `desktop: make composer create sessions`
   - lazy-create session、composer controls、disabled reasons。
4. `desktop: add rich message cards`
   - hide internal UUID、tool/file/diff summary cards。
5. `desktop: convert changes to review drawer`
   - right drawer、terminology、discard confirmations。
6. `desktop: collapse terminal into drawer`
   - status strip、attach output to composer。
7. `desktop: reorganize settings`
   - product settings IA、advanced diagnostics。
8. `desktop: expand CDP smoke for aligned workflow`
   - real Electron assertions for the new product path。

每个 PR 都应包含对应的 focused tests；涉及 renderer 布局的 PR 必须跑真实 Electron
路径，不只跑 unit tests。

## Open Questions

- Qwen 是否要保留与 Codex 相似的左侧 app-level entries：Plugins、Automations？
  如果 P0 不实现功能，建议先放 disabled/empty state 还是完全隐藏？
- `Accept` 当前真实语义是什么：stage 到 index、接受 AI patch，还是标记 review
  accepted？需要先统一数据模型和文案。
- Composer 中权限模式的默认值应跟 CLI approval mode 完全一致，还是为桌面端做更
  产品化的三档映射？
- 是否允许新增 `lucide-react` 依赖？如果不允许，需要定义本地图标维护策略。
- Settings 是否采用 full page、modal，还是左侧二级导航页？从当前规模看 full page
  最稳。
