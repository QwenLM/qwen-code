# Web Shell 侧栏：让会话行看得出后台任务

[English](web-shell-sidebar-background-work-indicator.md) | [简体中文](web-shell-sidebar-background-work-indicator.zh-CN.md)

状态：已实现并在本地完成验证（浏览器级证据见下）。

## 问题

正在跑后台任务的会话，在左侧栏里看起来不忙。已复现并实测两种形态：

- **回合已结束、后台任务仍在跑。** 行里只有一个小琥珀色圆点（CSS 里 6px）。这一
  形态下右侧忙标记与 `runningSession` 行高亮都被刻意关掉，整行观感几乎等同空闲
  行。
- **回合进行中且后台任务在跑。** 行里完全没有任何东西提到后台任务：状态圆点受
  prompt 门控，琥珀点被绿色的运行中圆点取代。

## 现状

数据链路本身是对的，已针对真实 daemon（0.28.0，本机与远端）端到端实测：

- `Session.hasRunningBackgroundTasks()` 由后台任务、shell、workflow、monitor 四个
  注册表推导；active-work 快照把它带给 daemon。
- `GET /workspaces/:workspace/sessions/live-state` 与会话目录都会发布
  `hasRunningBackgroundTasks`。
- 三个处于「回合已结束 + 后台 shell」形态的真实顶层会话，都渲染了
  `data-web-shell-session-background-running`，计算样式为 `visibility: visible`、
  `color: rgb(236, 201, 75)`、尺寸 5×5 px。

所以这是表达缺口，不是上报缺口。`WebShellSidebar.tsx` 里行内先算
`backgroundRunning = !hasActivePrompt && hasRunningBackgroundTasks`，随后只在
`running && !backgroundRunning` 时渲染忙标记。

## 目标与范围

目标：

1. 唯一活动就是后台任务的行，必须一眼看出在忙。
2. 回合进行中的行，仍要能说出它有后台任务。

不在本次范围（记为后续，不静默丢弃）：

- 会话已不再 live（被关闭、被回收，或 daemon 重启后）而 detached 后台 shell 仍在
  跑。shell 注册表是纯内存的，因此客户端根本拿不到
  `hasRunningBackgroundTasks`。证据：远端某会话的 shell pid 已存活约 26 小时，
  但它不在 live-state 里，目录行也没有后台字段。
- 侧栏行与其详情浮层之外的其他界面。

## 方案

复用既有的右侧忙标记，不新增指示器：

- 渲染条件改为 `running || backgroundTasks`，把 bg-only 行的忙标记放回来。
  `backgroundTasks` 是不受 prompt 门控的事实；只靠 `running` 不够，因为 monitor
  不占任何 active-work 类别，会把行判成 idle。
- 只要有后台任务在跑，就用与状态圆点相同的琥珀色（`--warning-color`）着色，
  通过 `.sessionLoadingBackground` 实现。
- 后台任务在跑且没有回合时，标签用 `background.running`；否则保留既有的
  `sidebar.running` / `sidebar.activeWork` 标签，并在其 `title` 后追加后台文案。
- `SessionDetailsTooltip` 中，回合与后台任务并存时状态文案组合为
  `sidebar.running · background.running`。

状态圆点的优先级不变：回合在跑为绿色，仅后台任务为琥珀色，其他活跃工作为蓝色。

## 设计决策与理由

- **不新增图标或徽标。** 行内本来就有忙标记；放宽它的条件并着色，是同时满足两个
  目标的最小改动，也保持 meta 槽的标记词汇不变。
- **保留受 prompt 门控的圆点。** 既有端到端契约钉住「回合在跑时琥珀点缺席」以及
  「该形态下行内忙标记的可访问名是 `Running`」。两者都仍然成立。
- **颜色绝不是唯一载体。** 标记的 `aria-label`/`title` 与详情状态都用文字说出后台
  任务，因此不依赖识别颜色也能获知该状态。
- **bg-only 行露出操作按钮时让忙标记让位。** 这种行不是 `.runningSession`，悬停
  行内任意位置都会露出操作浮层；把
  `.sessionRow:hover:not(.runningSession) .sessionLoading` 并入既有的标记隐藏
  规则，spinner 就不会压在按钮下面。

## 约束与风险

- 琥珀着色依赖 `--warning-color`，后台状态圆点已在用；回退值 `#d29922` 与之一致。
- 不新增 i18n 键：`background.running`、`sidebar.running`、`sidebar.activeWork`
  在各语言中均已存在。
- 组合文案用两侧带空格的间隔号（`·`）连接，与详情浮层、容量对话框已有的分隔符
  一致。
- 触屏布局不受影响：新增的隐藏规则位于 `@media (hover: hover)` 内，触屏块依旧不
  隐藏任何标记。
- 忙标记与分支 / worktree 图标共用 meta 槽的尾位，因此 bg-only 行现在显示 spinner
  而不是该图标 —— 这与回合在跑的行本来就在做的取舍相同。

## 验证

单元测试（`packages/web-shell`）：

- `client/components/sidebar/WebShellSidebar.collapse-persist.test.tsx` —— 85
  通过，含扩展后的状态矩阵与新增的 `activeWorkState: 'idle'` 仅后台用例。
- `client/components/sidebar/SessionDetailsTooltip.test.tsx` —— 19 通过。
- `client/components/sidebar/WebShellSidebar.css.test.ts` 与
  `client/visual-capture-contracts.test.ts` —— 16 通过。
- 改动文件的 `npm run typecheck`、ESLint、Prettier 均干净。

既有端到端契约（`npx playwright test`，mock daemon）：
`client/e2e/web-shell.background-turn.spec.ts` 与
`client/e2e/web-shell.composer-usage.spec.ts` —— 8 通过，含「keeps the background
task sidebar indicator visible on hover and prioritizes the prompt spinner」。

变异见证（每个都打在被验树上、跑完即还原）：把门控回退成
`running && !backgroundRunning`、去掉 `|| backgroundTasks` 这一支、去掉琥珀
类名、去掉组合 `title`、回退浮层文案组合 —— 五个全部被杀（5/5）。

浏览器（从本 worktree 起 dev server 代理到真实 daemon，真实会话，不拦截响应）：

| 形态        | 忙标记                                                                                                              | 左侧圆点                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 回合 + 后台 | `aria-label="Running"`、`title="Running · Background tasks running"`、`border-top-color: rgb(236, 201, 75)`、旋转中 | `data-web-shell-session-running`            |
| 仅后台      | `aria-label="Background tasks running"`、同琥珀色、旋转中                                                           | `data-web-shell-session-background-running` |

悬停 bg-only 行：忙标记 opacity `0`，操作按钮 opacity `1`。回合 + 后台行的详情
浮层读到 `Running · Background tasks running`。无页面错误。

## 验收标准

1. bg-only 行显示右侧忙标记，琥珀色，标签为 `background.running`。
2. 回合进行中且有后台任务的行显示琥珀标记，可访问名为 `Running`，`title` 为组合
   文案。
3. 两种状态并存时详情浮层同时说出两者。
4. 圆点优先级、触屏布局、既有悬停契约均不变。
5. 上述每条断言在对应变异下都会失败。

## 待决问题 / 后续

- 非 live 会话上仍在跑的 detached 后台 shell 依旧无标记；修它需要 daemon 侧的
  判活来源（status 文件加 pid 校验）以及有界的扫描成本。单独跟踪。
- 琥珀标记是否最终要带任务计数。会话摘要目前没有计数字段，这需要协议新增字段。
