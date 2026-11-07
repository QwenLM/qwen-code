# Managed 子 Agent 任务面板

[English](2026-10-12-managed-child-task-panel.md) | [简体中文](2026-10-12-managed-child-task-panel.zh-CN.md)

## 问题与当前状态

#13823 和 #13877 合入后，Managed Session 已提供任务列表、详情、事件读取及持久取消接口。Web Shell 尚无对应 Provider 方法和任务界面。取消 operation 完成只能证明停止请求已记录，不能证明任务实际结束。子 Agent 最终文本尚未关联到任务的公开产物。

## 行为与范围

首版只展示 `child_agent` 任务，提供其当前状态、事件历史和取消请求。不创建任务、不发送任务输入、不读取子会话全文，也不发布最终结果。已有公开产物引用可通过现有的有界产物读取器查看；缺少引用时显示明确的空状态。

Provider 支持读取且 `capabilities.tasks` 明确为 true 时，在 Session 标题旁显示会话任务按钮（在下文的后续变更之前为子 Agent 任务按钮）。已保存的取消仍待确认而能力撤销时，提供名称不同的恢复任务取消确认入口，所有新取消操作均禁用。页面容器宽度至少 1100px 时使用 360px 右栏，较窄时复用共享 Dialog 和 Web Shell portal。打开和关闭面板保留草稿、对话及历史分页。列表显示短任务 ID、状态和创建时间；详情显示完整 ID、时间、耗时、可用的 Runtime 状态、事件及产物。返回列表恢复分页和滚动位置。

服务端不支持类型过滤。每次读取一页 50 条原始任务，保留不透明游标和服务端顺序，并呈现其中的条目（首版只呈现子 Agent，因此过滤后为空但存在后续页时，不能认定整个 Session 没有子任务；自下文的后续变更起呈现所有条目）。上一页、下一页浏览原始分页。不全量扫描，也不展示总数。

任务面板文案使用独立双语字典。只读 transcript 构建通过现有 Vite 文案边界将其替换为空 stub，使导出对话保留原有包体积预算，无需携带任务面板文案。

### 全部任务类型（#13746 的后续）

面板现在列出 Session 投影的每个任务，并按 kind 标注：子 Agent、工作流、后台 Shell、监视、自动化运行、channel 投递；本客户端不认识的 kind 使用通用的「任务」标签。面板标题改为「会话任务」（Session tasks）。

- **取消跟随服务端。** 取消控件与取消钩子不再检查 kind。当且仅当任务视图在 `actionCapabilities` 中公布 `cancel` 时才提供取消，这与服务端准入复查的规则相同。哪些 kind、哪些状态公布它由契约决定（`TaskActionCapability`），所以某个 kind 获得取消路径后不需要改客户端。
- **读取接受所有 kind。** 任务读取不再拒绝 kind 不是 `child_agent` 的任务；恢复路径仍校验 Session 与任务身份。
- **各 kind 显示什么。** 详情视图在任务 ID 上方显示 kind。后台 Shell 与 Monitor 的输出事件与输出产物，经现有的时间线与产物读取器显示。channel 投递在服务端把投递投影为任务之后（#13746 F3）没有 runtime state；在此之前该标签只是不会用到。

## Provider 与同步

Managed Provider 增加可选的 `tasks.list`、`tasks.get`、`tasks.listEvents`、`tasks.cancel.submit` 和 `tasks.cancel.query`，summary 携带可选 `capabilities.tasks`。类型直接引用生成的 WebShell 任务、事件和 command operation schema。Java 读取复用 `/api/agent/web-shell/v1` 下的 `/tasks/query`、`/tasks/get` 和 `/tasks/events/query` POST 接口；变更复用 `/tasks/cancel` 与 `/operations/query`。不新增 endpoint、表、契约能力字段或 Session 事件。Daemon 不提供任务操作组。Java 仅在宿主提供包含租户和账号身份的明确 `productScope` 时暴露取消能力。

任务读取和取消恢复分别由 Session 层两个 hook 管理。面板及浏览器标签页可见时，以完成后再调度的串行 3 秒轮询刷新当前原始分页、所选任务及事件页。关闭面板暂停普通读取；重新打开或恢复可见时刷新。事件从保留起点读取，按不透明 cursor 去重，不覆盖任务快照。未知事件类型只推进游标，不渲染。`cursor_expired` 时提示历史缺失并从保留起点重新读取。事件页有 `hasMore` 时等待用户加载更多，再恢复尾部跟踪。切换 Session、Provider 或账号时中止请求、清空读取缓存；请求归属检查防止迟到响应修改其他选择。

后台轮询保留缓存内容和可用操作，不每三秒重新播报加载状态；首次读取及主动刷新、翻页显示加载。时间戳跟随面板语言，详情标签和值分列显示。

任务的 `cancel` action 表示任务支持操作，不代表调用者权限。前端不推断 Workspace 角色，也不用 `workspaceTurns` 鉴权。服务端 `403 task_forbidden` 展示为权限不足。本地取消不锁定发送、不取消父会话，也不处理审批。

## 取消与恢复

采用行内二次确认，说明停止需要时间，已有结果保留。发送前在 `sessionStorage` 保存原始 Session、任务和幂等键，记录按 Provider 身份、Session 和任务隔离。首次保存失败则不发送。受理后补存 operation ID。

返回 Session 时自动查询已知 operation，即使任务能力已撤销。只有意图、没有 operation ID 时，由用户点击后使用原请求和原键重放。查询按 1/2/3 秒等待，之后每 3 秒，每轮确认预算 30 秒。超时、查询失败、丢失响应或 `recovery_blocked` 都保留待确认状态和继续确认入口。不生成新键，不自动重发阻塞 operation，也不将放弃显示成取消。

pending/running 命令显示正在提交取消；命令 completed 但任务非终态时显示停止请求已送达、等待任务结束。只有权威任务状态才能显示已取消、已完成或失败。自然完成竞争保留真实结果。operation 明确失败时清理恢复意图、展示原因并刷新任务；新尝试必须由用户重新提交。命令完成后，只有读到任务终态才清理记录。任务终态本身不能确认未知命令。普通任务读取与已完成取消的恢复继续跟踪实际结局，等待时间不会将已确认受理转换为失败。

清理已受理取消前，先将其校验后的任务快照同步到列表和所选详情。迟到的非终态读取不能覆盖已知终态。观察到任务终态后清理已失效的 admission 竞争或操作不可用提示；其他明确命令失败及未知 operation 的恢复状态继续保留。

同一任务禁用本地重复取消。其他任务和其他标签页由服务端 admission 裁决；`session_operation_active` 展示竞争冲突。查询权限错误和 operation 缺失保留不确定状态。身份变化时中止请求，忽略迟到响应。

## 验证与交付

通过一个前端 PR 交付本完整双语设计及受版本控制的双语 E2E 计划。复用共享 Button、Badge、Dialog 和产物内容 UI，保留 React 18/19 ref 与 portal 主题隔离，覆盖键盘操作、焦点恢复和状态播报。

验证混合类型原始分页、过滤空页；事件、过期与产物缺失；待启动及执行中取消、Runtime draining 和自然完成竞争；丢失 202、原键重放、刷新、超时、权限撤销和存储不可用；旧服务端、Daemon、只读宿主、迟到响应和双标签页竞争。证明草稿和历史保留，命令完成不能提前显示任务已取消。运行受影响的 client、Provider、hook、组件测试，Java 任务及取消回归，真实 Java + Hosted 子任务场景，build、typecheck 和两轮干净自审。如实记录平台与真实模型验证限制。最终结果发布单独跟进。没有未决产品选择或迁移。
