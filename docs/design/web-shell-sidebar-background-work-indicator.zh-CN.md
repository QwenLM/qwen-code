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

- ~~会话已不再 live（被关闭、被回收，或 daemon 重启后）而 detached 后台 shell
  仍在跑。~~ 已由下文 detached 后台 shell 扩展纳入范围（#17819）。
- 重新评定 Session Overview 面板卡片的等级。「仅后台」会话在那里仍读作 `idle`，
  从而保持面板的排序与显示状态不变；它的两个破坏性卡片动作另行加闸（见下），
  因为只靠该等级会把它们放出来。
- 一条**先前就存在**的分歧：本客户端未连接的会话里正在跑**回合**时，侧栏行仍
  提供 Delete，而 Session Overview 卡片拒绝——因为卡片一向要求 `idle` 等级。
  本次让两者在「后台工作」上取得一致；回合那一档的对齐是另一个策略决定。
- 裁定 `unknown` 与 `unsupported` 等级对归档/删除意味着什么。共享判据回答的是
  「是否已知有工作在跑」；侧任务归档闸门还额外对这两个等级 fail closed，该差异是
  刻意的，并写在判据的注释里。

## 方案

复用既有的右侧忙标记，不新增指示器：

- 用一个共享判据 `hasLiveWork`（位于 `client/session-catalog/`）回答「关掉这个
  会话会不会中断它正在做的工作」：回合、其他活跃工作，**或**后台任务。行内忙标记
  按它渲染，于是 bg-only 行拿回了标记 —— 包括 monitor 形态：它不占任何 active-work
  类别，会把行判成 idle。
- 同一判据替换动作侧其余全部副本：侧栏的归档与删除资格判断、standalone 归档
  处理器、recent 行的归档闸门、删除弹窗的拒绝判据、Session Overview 的卡片动作，
  以及 Activity 归档确认（它此前把同一个析取写了两遍）。一行既然说自己在忙，就不该
  同时给出会结束这份工作的操作；任何两个入口都不该互相矛盾。
- 删除规则本身以 `sessionBlocksDelete` 放在该判据旁边，它接收调用方自己的
  「当前」判定而不是从 id 推导：侧栏比的是带工作区限定的 identity，且允许
  recent/standalone 适配器覆盖，而弹窗比的是 session id。侧栏行、侧栏资格判断
  与删除弹窗都调用它，这条规则只有一个家。Session Overview 的卡片闸门是第四条删除路径，且刻意更严——
  它还要求 `idle` 等级，并对每张卡片（而不只是当前会话）阻断活跃工作——因此保留
  自己的表达式；上方「不在本次范围」列表里那条**先前就存在**的分歧，记录了回合
  这一档同样的不对称。
- 侧栏与删除弹窗**都**对任何有后台工作的行拒绝删除，而不只是本客户端所连接的那个：
  删除路由没有 idle 闸门，确认后就会杀掉该行宣称在做的工作，而 Session Overview
  卡片早已拒绝同一会话。空闲的当前会话仍可删除（#12619）。在弹窗里点击被拒绝的行
  会在提示区说出原因——该状态下危险按钮是禁用的，点击行是拒绝唯一能触达用户的地方
  ——且只有当前会话那条文案才说「当前会话」。该提示跟随活状态而不是那次点击：
  它说出当下阻断该行的那条规则，行恢复可删后即消失；删除进行中、或仍然存在的错误与删除
  结果占着这个位置时它保持安静——弹窗别处不再渲染那些文本，拒绝不能把它们挤掉。
  加载错误与删除结果各占独立的槽：共用一个槽时，列表恢复会把用户还没读到的失败
  信息清掉。
- 随之收口三处「快照过期」漏洞。选择模式保存的是勾选那一刻的会话副本，因此它的
  刷新契约现在也带上后台标志 —— 否则批量归档会按勾选时的旧值判断。删除弹窗在
  **构造请求时**重新评估闸门，而不只在点击时。并且它会把勾选后才变忙的行从选择
  中剔除，让勾选框与用户读到的计数与实际发送的内容一致 —— 被拦下的行手动取消
  不掉，留着勾选就会悄悄漏掉一个弹窗声称已包含的会话。
- 只要有后台任务在跑，就用与状态圆点相同的琥珀色（`--warning-color`）给标记着色，
  通过 `.sessionLoadingBackground` 实现。
- 只在标记是唯一载体时给它命名。bg-only 形态下状态圆点已经承载
  `background.running`，因此标记不命名、也不带 `title`；回合进行中时它保留既有的
  `sidebar.running` / `sidebar.activeWork` 名字，并新增一个组合两种状态的 `title`。
  live 启动中的行会把圆点换成它自己的 spinner，此时标记要把名字接回来，而不是让
  这一格无人命名。
- `SessionDetailsTooltip` 中，只要有后台任务在跑，就给「等待审批」「等待回答」
  「回合进行中」「completed-unread」四支追加 ` · background.running`；override
  标签（`statusLabel`，如语音启动提示）出于同样的「隐藏后台仍须命名」理由也带该后缀。「仅后台」支
  （`!hasActivePrompt && hasRunningBackgroundTasks`）已经命名过，保持原样。
  completed-unread 支与行圆点同序：优先于 running/active-work/unknown 支，
  「仅后台」支优先于它；等待态的优先级不变（#18070）。

状态圆点优先级与该链一致（#18070）：live 启动 Spinner 顶替圆点；仅后台圆点
（`!hasActivePrompt && hasRunningBackgroundTasks`）优先于 unread 圆点；
unread 圆点优先于 running 与 active-work 圆点（回合进行中时门控关闭仅后台圆
点）。配色：回合在跑或其他活跃工作均为绿色（#18072 将 active-work 从蓝色改为复
用运行绿色，使蓝色仅保留给完成未读会话），仅后台任务为琥珀色，完成未读为蓝色。

## Detached 后台 shell（#17819）

上文第一条「不在本次范围」后来单独成了一项扩展。所属 CLI 进程死亡的会话可能
留下 `running` 状态的 shell sidecar —— 注册表只在优雅退出时收口它们，因此硬杀会
同时孤儿化进程与上报。这种行没有任何内存态信号，而删除它看起来像无害的清理，
实际上 shell 还在跑（#17819）。

daemon 在构建目录时尽力而为地解析该信号：

- 会话列表探查当前页持久化行的
  `<projectTempDir>/background-shells/<sessionId>/shell-*.status` sidecar
  （serve 层的 `detached-work-liveness.ts`）。对于 `running`、`cancelled` 或带进程
  令牌的 `failed` 记录，Linux PID 命名空间和启动令牌匹配且进程仍存活，才返回运行中。确认退出或
  同一命名空间内 PID 已归属其他进程时清除该状态。缺少身份的旧文件、不可读或损坏的
  记录，以及不支持的探查均返回 `unknown`。
- 结果以 `detachedBackgroundWork` 落在会话摘要上：`'running'`、`'unknown'`，
  或缺省（无 sidecar，或所有 running 声明均被证伪）。重新打开会话后，列表用
  live 条目的创建时间排除本次运行期间启动的 shell。旧 shell 还在运行时，
  `hasRunningBackgroundTasks` 仍可能变化，因此客户端保留 detached 观测，
  由目录刷新更新该状态。
- 探查结果缓存 45 秒（含「无信号」结果）。每次请求最多检查 100 个未缓存会话，
  每个会话最多读取 128 个目录条目，每个文件最多 16 KiB。打开的目录包含非 live
  行或带 detached 观测的 live 行时，每 60 秒协调刷新一次，即使 live 目录版本没有变化。

客户端对两个等级区别对待，沿用既有 `unknown` 策略：

- `running` 作为第三项并入 `hasLiveWork` 与 `sessionBlocksDelete`。它不是本端
  运行时的工作，因此在任何行上都会拦删除 —— 这恰是「删除看起来像清理」的行形态
  —— 同时禁用归档。行内按
  `data-web-shell-session-background-running="detached"` 渲染琥珀背景标记。
- `unknown` 渲染空心、灰调、不脉动的圆点
  （`data-web-shell-session-background-unknown`，tooltip 为
  `background.detachedUnknown`），不阻断任何操作 —— 它是提示，不是「已知有工作」
  ，与 `unknown` active-work 等级同理。删除弹窗里该行仍可勾选。选中项包含未知行时，
  提示区显示 `delete.mayStillBeRunning`，删除进度与错误等状态优先展示。

## 设计决策与理由

- **不新增图标或徽标。** 行内本来就有忙标记；放宽它的条件并着色，是同时满足两个
  目标的最小改动，也保持 meta 槽的标记词汇不变。
- **保留受 prompt 门控的圆点。** 既有端到端契约钉住「回合在跑时琥珀点缺席」以及
  「该形态下行内忙标记的可访问名是 `Running`」。两者都仍然成立。
- **颜色绝不是唯一载体。** 状态圆点的名字、回合进行中时标记的名字、以及详情状态，
  都用文字说出后台任务，因此不依赖识别颜色也能获知该状态。
- **一行只播报一次，不是两次。** 该行是 `role="button"`，其可访问名由子节点拼接
  而成，所以给圆点和标记取同一个名字，会让每个 bg-only 行把同一串文案念两遍。
- **`title` 只放在能补充信息的地方。** 悬停标记会把它隐藏，且在带操作按钮的行上
  露出的浮层会盖住它，因此原生 tooltip 不是可靠载体。组合 `title` 在回合进行中的
  形态保留为次级描述；两种状态真正可达的载体是详情浮层。
- **闸门要跟着「宣称在忙」走。** 只放宽行内视觉，会留下一行说着「在忙」却仍提供
  归档 —— 归档会在 daemon 侧关闭该 live 会话并杀掉后台工作。另有两处问法相近的
  **轮询节奏**聚合量刻意不动：它们只在没有 live-state 的 daemon 上决定目录轮询走
  快档还是空闲档，而那条通路的覆盖与它们无关。
- **bg-only 行露出操作按钮时让忙标记让位。** 这种行不是 `.runningSession`，悬停
  行内任意位置都会露出操作浮层；把
  `.sessionRow:hover:not(.runningSession) .sessionLoading` 并入既有的标记隐藏
  规则，spinner 就不会压在按钮下面。
- **尽力而为，绝不报错。** detached 解析器跑在会话列表响应路径里，因此探查的
  一切失败都降级为 `unknown` 或「无 detached 工作」，而不是让请求失败。
- **注册时记录操作系统的进程身份。** 前台转后台时，进程可能早于注册表写入的
  `startTime` 很久就已启动。后续写入继续使用最初记录的 Linux 进程启动令牌与 PID
  命名空间。注册表先写 `cancelled` 再请求取消，因此这些记录仍需探查进程。
- **`unknown` 依旧不阻断。** 把它并进判据，会让所有在没有启动时间来源的平台
  （macOS、Windows）上探查过的行都无法删除 —— 那些失败是环境性的，不是工作
  存在的证据。
- **合并保持 live 优先。** 本 daemon 拥有的 live 会话，其后台状态来自注册表；
  把 sidecar 信号叠加其上会重复上报，还可能比会话自身的状态活得更久。

## 约束与风险

- 琥珀着色依赖 `--warning-color`，后台状态圆点已在用；回退值 `#d29922` 与之一致。
- 标记复用 `background.running`、`sidebar.running`、`sidebar.activeWork`，三者
  在各语言中均已存在。新增一个键 `sidebar.deleteRunningDisabled`：现有两条拒绝
  删除的文案都写死「当前会话」，而行内闸门也会拒绝其他会话。该键已在各语言补齐。
- 组合文案用两侧带空格的间隔号（`·`）连接，与详情浮层、容量对话框已有的分隔符
  一致。
- 触屏布局不受影响：新增的隐藏规则位于 `@media (hover: hover)` 内，触屏块依旧不
  隐藏任何标记。
- 忙标记与分支 / worktree 图标共用 meta 槽的尾位，因此 bg-only 行现在显示 spinner
  而不是该图标 —— 这与回合在跑的行本来就在做的取舍相同。
- detached 扩展新增三个键：`background.detachedUnknown`（空心圆点的
  tooltip）、`delete.mayStillBeRunning`（删除弹窗的提示）与
  `delete.detachedRunningDisabled`（拦截删除的拒绝文案），四个词典（英文、
  简体中文、繁体中文、俄语）均已翻译。

## 验证

单元测试（`packages/web-shell`）：

- 整个 `client/session-catalog/`、`client/components/dialogs/`、
  `client/components/sidebar/` 三个目录，加
  `client/visual-capture-contracts.test.ts` —— 79 个文件、1761 通过。跑整目录而不是
  只跑改过的文件，才能抓到被放宽的闸门可能撞坏的旧契约。
- 改动文件的 `npm run typecheck`、ESLint、Prettier 均干净。

既有端到端契约（`npx playwright test`，mock daemon）：
`client/e2e/web-shell.background-turn.spec.ts` 与
`client/e2e/web-shell.composer-usage.spec.ts` —— 8 通过，含「keeps the background
task sidebar indicator visible on hover and prioritizes the prompt spinner」。

变异见证（每个都是对被验树的一行改动，对着已提交的测试跑，跑完即还原）——
十二个全部被杀，且各自死在负责它的那条断言上：去掉 `hasLiveWork` 里的后台项
（分别由判据自己的测试与侧栏套件裁定）；把删除弹窗恢复成它自己的两项判据；
在圆点已命名时仍给标记命名；判断命名载体时忽略 live 启动中的替换；
去掉「等待审批」支的后缀；去掉「等待回答」支的后缀；
在 bg-only 行保留冗余 `title`；把琥珀 token 换成 muted 色；整条删除琥珀规则；
无条件组合后缀；去掉琥珀类名。

浏览器（从本 worktree 起 dev server 代理到真实 daemon，真实会话，不拦截响应）：

| 形态        | 忙标记                                                                                                              | 左侧圆点                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 回合 + 后台 | `aria-label="Running"`、`title="Running · Background tasks running"`、`border-top-color: rgb(236, 201, 75)`、旋转中 | `data-web-shell-session-running`            |
| 仅后台      | 不命名、无 `title`（名字由圆点承载一次）、同琥珀色、旋转中                                                          | `data-web-shell-session-background-running` |

悬停 bg-only 行：忙标记 opacity `0`，操作按钮 opacity `1`。回合 + 后台行的详情
浮层读到 `Running · Background tasks running`；等待审批或等待回答时，同一浮层
也会说出后台任务。bg-only 行的归档为禁用。无页面错误。

## 验收标准

1. bg-only 行显示右侧琥珀忙标记，且整行只播报 `background.running` 一次。
2. 回合进行中且有后台任务的行显示琥珀标记，可访问名为 `Running`，`title` 为组合
   文案。
3. 两种状态并存时详情浮层都同时说出两者，包括在等待审批或等待回答之后、以及
   override 标签（如语音启动提示）之下，且不重排等待态的优先级；unread 支优先于
   running/active-work/unknown，且位于「仅后台」支之下。
4. 有后台工作的会话，在项目行（无论是否为本客户端所连接的那个）、recent 行、
   Session Overview 卡片上都不提供归档与删除，删除弹窗亦然。空闲的当前会话仍
   可删除。批量归档要跟随勾选之后标志的变化；勾选后才变忙的行要被取消勾选、
   不再计入计数，并从请求中剔除。
5. 圆点优先级与 hover 链一致（启动 Spinner 优先于全部；仅后台琥珀优先于
   unread；unread 优先于 running/active-work；进行中的回合会关掉仅后台圆点，
   active work 与 running 共用绿色（#18072），蓝色保留给已完成-unread）；
   触屏布局与既有 hover 契约维持不变。
6. 每条被钉住的断言在对应变异下都会失败：tooltip 矩阵（含逐支后缀出现计数与
   unread 优先于 running 行）覆盖组合 hover 链；行侧见证以控制相钉住
   running→idle 晋升、background 优先于 unread 的槽位、unread 优先于
   active-work 的槽位（配仅 active 对照行）、以及已完成会话重新运行时 tracker
   清除 unread 身份。行上 running 圆点的 `!completedUnread` 守卫是面向 effect
   前渲染瞬态的防御性守卫，unread 优先于 running 这一环在 hover 侧由 tooltip
   矩阵钉住。
7. 仅持久化、detached shell 可验证存活的行，显示琥珀背景标记，并在侧栏行与
   删除弹窗中拒绝删除、拒绝归档，与内存态信号置位时完全一致。
8. 仅持久化、detached shell 无法验证的行，显示空心 unknown 标记，处处保留
   删除。删除弹窗在选中项有未知行时显示提示。等级清除或最后一条未知行取消勾选后，
   提示消失。
9. 重新打开会话后，旧 shell 的运行标记和删除保护继续生效。启动并结束新后台任务
   也会保留这份保护。
10. detached shell 退出后，保持 Web Shell 打开，探查缓存过期后的下一次慢速目录
    刷新会移除运行标记。会话空闲时可以删除。

## 待决问题 / 后续

- 琥珀标记是否最终要带任务计数。会话摘要目前没有计数字段，这需要协议新增字段。
