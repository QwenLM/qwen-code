# OpenTUI 代理管理器

[English](2026-10-30-opentui-agent-manager-details.md) | [简体中文](2026-10-30-opentui-agent-manager-details.zh-CN.md)

## 状态与问题

修订后的 global Ink 基线已真实通过热/冷详情及完整代理目录图不变检查。随后未改动的 OpenTUI 管理器在 `hot-created-agent-actions` 失败：Enter 后真实 frame 仍是仅显示名称和描述的 Subagents 列表。原失败保留。原生只读实现现已与手动 wizard 一同在当前依赖基础上的未提交功能改动中完成本地验证。PascalCase 文件名修正后，六个 CLI 整文件单测共 111P，正常 build、typecheck、lint、bundle 均通过。Node+Ink、Bun+Ink、strict Bun+OpenTUI 各通过四个公开 case：两项 Permissions、Source 获取，以及包含热/冷管理详情的手动创建。三个 profile 共执行 12 次、四个唯一 case，观察到 18 次自然会话退出，模型请求为零。这是提交前本地候选证据，不是合入 main 或安装验收。

公开命令 `/agents manage` 打开 `subagent_list`。Ink 支持选择代理、选择 View Agent、读取配置，并经操作页和列表返回。修改前 OpenTUI 把管理器结果缩减为名称与描述，仅处理 Escape。此前手动创建 E2E 特意对 Ink 检查详情、对 OpenTUI 只检查列表描述，因此其成功不代表详情对齐。修订后的 case 现要求两种渲染器都显示详情。

## 预期行为

保留 `config.getSubagentManager().listSubagents({ force: true })` 返回的完整公开 `SubagentConfig`。沿用管理器的 project/user/builtin/extension 优先级，不另写查找逻辑或按显示名称重新加载。提供可选择的代理列表、操作页与可滚动详情页。project/user 文件代理还提供既有 Edit 与 Delete 动作；builtin、extension、session 代理只显示 View/Back。

详情沿用 Ink 的现有值：File Path、Tools、可选 Model 与 Color、Description、System Prompt。复用翻译键、终端安全文本处理和原生选择/滚动组件。显示必须显式读取选项 label，选中值继续表示身份。缺少 tools 字段时按 Ink 显示 `*`；空数组保留实际行为，不发明序列化语义。

Enter 仅选择当前页面的选项。Escape 按详情 → 操作 → 列表 → 输入框返回，并保留已选代理。每页拥有自己的按键处理，切页或卸载后的过期回调不得继续操作。加载与错误状态不得伪装成成功空列表。查看路径保持只读；更新、编辑器启动与删除必须显式选择动作并固定 project/user 身份。管理动作不请求模型。

## 所有者与消费者

| 所有者       | 实际消费者与职责                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 命令     | `ui/commands/agentsCommand.ts` 返回 `subagent_list`，不新增命令或选项。                                                                   |
| 对话框挂载   | `ui/opentui/opentui-dialog-mount.tsx` 传入所选运行时既有 Config 与关闭回调。                                                              |
| 管理面板     | `ui/opentui/dialogs-misc.tsx` 当前拥有列表。现将原导出转到 `SubagentListDialog.tsx`，由新组件拥有完整选中对象、导航、加载及按键生命周期。 |
| 公开管理器   | `packages/core/src/subagents/subagent-manager.ts` 拥有磁盘刷新、安全模式过滤及层级/名称优先级，保持不变。详情读取其完整返回对象。         |
| 原生基础组件 | 既有 DialogFrame/DialogSelect/scrollbox 处理布局与选择；调用方提供稳定选项和显式安全标签，不重写共享 hook。                               |
| 参考 UI      | Ink 的 `components/subagents/manage/AgentsManagerDialog.tsx`、`ActionSelectionStep.tsx`、`AgentViewerStep.tsx` 定义既有只读路径。         |
| 验收驱动     | 既有交互 scenario 拥有临时工作区/HOME/runtime、会话重启、快照与零模型观察；仅 Root 执行 producer。                                        |

## 文件与边界

生产改动仅在 CLI：一个提取的管理组件及既有重新导出。同目录行为测试使用真实共享选择组件，小范围 E2E 差异保留原公开创建流程。面板按真实内容宽度用 wrappedRows 预算标题和实际绘制的页脚，并加上边框、padding 与 body margin 的五行。chrome 无法放入时，沿用既有 compact 模式隐藏标题/页脚并保留可滚动 body。挂载和 Config 接线已存在。不改 Core，不实现生成，不重构整个管理器，不切默认、不移除 Ink。

## 验证与验收

复用公开手动创建流程，包括写入前取消及精确 Markdown；随后要求两种渲染器满足现有 Ink 详情与导航观察。创建完成后记录完整 project/user 代理目录图，要求每次热/冷管理器遍历后完全一致。保存零模型请求与自然退出结果。新增单测覆盖真实原生显示标签、选择/返回栈、页面所有权切换、空/错误状态及异步列表未完成时卸载。这些检查现已在本地候选上通过，包括热/冷名称、描述与 system prompt 观察、操作页/列表返回导航，以及完整创建后代理目录图相同。组件单测另覆盖真实共享选项标签、可选详情字段、加载/错误状态、页面与 runtime 所有权、卸载和基本滚动调用；它们不代表原生长滚动或可选字段 E2E。手动字段 Ctrl+C 有单测，本次原生 manual case 未执行该操作。所有旧失败仍保留在原运行范围。

## 待确认事项

global 基线的源码身份仍为 unknown。原生 E2E 当前断言所建代理的名称、描述、system prompt，以及只读导航和目录图合同；未断言所有可选字段或长滚动。bundle 入口摘要仅标识该入口。独立的有限身份快照覆盖 1,378 个生成文件，不代表完整依赖图或所有传递 runtime 输入。引导生成、其他平台、已安装产物及最终合入 main 的验收仍不在本证明范围。此前只读验证不证明新增修改行为。

## 窄终端回归

已发布功能候选的官方 CI 在未修改的原生布局检查失败：终端 11 列、区域 12 行时，代理列表 frame 实测为 26 行。本地未修改的原生脚本复现相同结果。此前正常宽度公开场景的通过保留其原范围，不覆盖该几何条件。新的导航 footer 换为多行，但旧 chrome 预算只计一行。最小修正令绘制和测量使用同一个 footer，保留原文、只读导航、compact 回退与 body 上限。三个聚焦组件用例覆盖窄列表、操作和详情页；合并候选已通过六个组件整文件共 114 项测试、正常 build、typecheck 和 lint。最终原生运行通过全部 132 项窄/矮检查、滚动/resize 与真实 session picker resize 检查。管理器操作/详情页只有组件覆盖，不冒单独原生几何实测。新合并候选的公开 runtime 与已安装验收仍单独处理。官方与本地原失败均保留。

页脚修正后的首次原生运行通过全部 132 项窄/矮 frame 检查，随后在旧的无标签通用就绪条件 physical scrollHeight ≥ 40 超时；该次运行未建立首先失败的具体 dialog。新的可选择管理器仅挂载可见选项窗口，与原先全量行项目符号 body 不同，因此该条件及直接 physical scrollTo 已不再检验实际合同。既有原生脚本保留 Skills/Diff 的物理 40 行检查；管理器改用 39 次真实 Arrow Down 输入到达并可见选中末项，再要求原有每次 resize 后该选择仍可见。就绪失败会保留 dialog、宽度、scrollHeight 和 frame，不增加 100-pass 上限。owned Git diff fixture 一次检查真实新增行及末尾标记。修订后的脚本随后通过，并在包含当前 main 的合并源码树再次通过最终运行。原失败及 React act 警告均保留；此窄原生证明不代表所有完整应用 viewport 或最终合入 main 的验收。

## 编辑、删除与规范颜色

已安装 Ink 修改基线已到达真实动作菜单、取消删除与工具更新。fixture 改为合法小写颜色后，工具更新保持精确类型化元数据/正文及 user store；选择 Green 后却写入 `color: Green`，不属于既有 Core 小写枚举。finally 快照保留了真实字节。编辑器、确认删除与冷启动步骤未到达，因此该运行仍为失败。未修改的原生候选则独立在动作菜单失败，仅显示 View Agent 与 Back，原 store 未变。这些观测不调用私有 Core，即复现持久化缺陷与缺少动作。

CLI 实施增加编辑选项（Open in editor、Edit tools、Edit color）及确认删除。工具使用真实 registry display name 与既有类别；All 提交 `[]`，由 Core 序列化省略该字段。颜色菜单保持显示名，各写入者提交含 `auto` 的 `COLOR_OPTIONS.id`，不持久化 hex 绘制值或大写显示名。共享显示查找兼容规范 id 与历史名称。Ink 创建/管理及原生手动创建一同修正；仅查看旧文件不会重写它。

全部写入经既有公开 manager 方法，固定所选完整对象的名称及精确 project/user 级别。同步单飞 token 阻止重复提交，既有 `assertCanCommit` 验证 runtime/page 所有权与挂载状态。提交后列表刷新失败会明确报错，不自动重复操作。pending 期间禁用控件。取消删除保持两 store 不变；完整问题无法放入已付内容区时忽略确认。既有 Core 删除 guard 位于异步扫描前，不能保证该边界之后取消会回滚。builtin、extension、session 仍只有 View/Back。

编辑器使用既有配置命令解析，继承终端 I/O 打开真实所选文件，暂停原生绘制并在 `finally` 恢复，含启动、非零及 signal 错误。不使用 Ink stdin hook 或临时 composer buffer。单飞交接拒绝同 read Enter burst，重开管理器 force-load 磁盘。公开场景使用 owned 配置 vim，验证精确 real file/argv，保存全部授权 store 差异，在热重开要求规范 `green`，仅删除 project 目标，并在重启后验证同名 user 回退未变。原手动创建整案现在要求规范 `blue` Markdown 和真实重载颜色字段。当前批次已通过八个 CLI 整文件共 146 项测试、正常完整 build、最终 typecheck、原生布局/resize 脚本及 bundle，最终 lint 也已通过。Node+Ink、Bun+Ink 与 strict Bun+OpenTUI 各针对同一本地源码 bundle 通过五项公开 case：共 15 次执行、五个唯一 case、24 次自然会话退出及零模型请求。独立保存结果审查已确认三个 profile 及 58 个有限输入 pins。原收集、mock 启动、type 与 lint 失败均保留。这些源码 bundle 结果不借用独立 Source Ctrl+C 验收或此前 standalone 检查，不代表安装后的修改行为、其他平台或最终合入 main 的验收。

Windows `.cmd`/`.bat` 编辑器需要 shell 时，仅双引号不能阻止 `%VAR%` 与 delayed-expansion `!VAR!` 替换。调用者现对 shell 参数中的 `%`、`!` 和双引号 fail closed，在暂停 renderer 或 spawn 前显示受控错误，不回退到另一个文件。普通空格路径仍逐参数加引号。单测只检查该分支，不代表 Windows 实际编辑器已验证。依据 [Microsoft cmd 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)。
