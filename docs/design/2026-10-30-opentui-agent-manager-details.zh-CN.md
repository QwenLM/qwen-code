# OpenTUI 代理管理器只读详情

[English](2026-10-30-opentui-agent-manager-details.md) | [简体中文](2026-10-30-opentui-agent-manager-details.zh-CN.md)

## 状态与问题

修订后的 global Ink 基线已真实通过热/冷详情及完整代理目录图不变检查。随后未改动的 OpenTUI 管理器在 `hot-created-agent-actions` 失败：Enter 后真实 frame 仍是仅显示名称和描述的 Subagents 列表。原失败保留。原生只读实现现已与手动 wizard 一同在当前依赖基础上的未提交功能改动中完成本地验证。PascalCase 文件名修正后，六个 CLI 整文件单测共 111P，正常 build、typecheck、lint、bundle 均通过。Node+Ink、Bun+Ink、strict Bun+OpenTUI 各通过四个公开 case：两项 Permissions、Source 获取，以及包含热/冷管理详情的手动创建。三个 profile 共执行 12 次、四个唯一 case，观察到 18 次自然会话退出，模型请求为零。这是提交前本地候选证据，不是合入 main 或安装验收。

公开命令 `/agents manage` 打开 `subagent_list`。Ink 支持选择代理、选择 View Agent、读取配置，并经操作页和列表返回。修改前 OpenTUI 把管理器结果缩减为名称与描述，仅处理 Escape。此前手动创建 E2E 特意对 Ink 检查详情、对 OpenTUI 只检查列表描述，因此其成功不代表详情对齐。修订后的 case 现要求两种渲染器都显示详情。

## 预期行为

保留 `config.getSubagentManager().listSubagents({ force: true })` 返回的完整公开 `SubagentConfig`。沿用管理器的 project/user/builtin/extension 优先级，不另写查找逻辑或按显示名称重新加载。提供可选择的代理列表、仅含 View Agent 与 Back 的只读操作页，以及可滚动详情页。不展示尚未实现的 Edit 或 Delete 操作。

详情沿用 Ink 的现有值：File Path、Tools、可选 Model 与 Color、Description、System Prompt。复用翻译键、终端安全文本处理和原生选择/滚动组件。显示必须显式读取选项 label，选中值继续表示身份。缺少 tools 字段时按 Ink 显示 `*`；空数组保留实际行为，不发明序列化语义。

Enter 仅选择当前页面的选项。Escape 按详情 → 操作 → 列表 → 输入框返回，并保留已选代理。每页拥有自己的按键处理，切页或卸载后的过期回调不得继续操作。加载与错误状态不得伪装成成功空列表。此路径只读，不保存、不启动编辑器、不更新、不删除、不请求模型，也不通过重新加载产生写入。

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

生产改动仅在 CLI：一个提取的管理组件及既有重新导出。同目录行为测试使用真实共享选择组件，小范围 E2E 差异保留原公开创建流程。面板在区域预算中为页脚保留一行，既有短终端布局测试相应计入该行。挂载和 Config 接线已存在。不改 Core，不实现编辑/删除/生成，不重构整个管理器，不切默认、不移除 Ink。

## 验证与验收

复用公开手动创建流程，包括写入前取消及精确 Markdown；随后要求两种渲染器满足现有 Ink 详情与导航观察。创建完成后记录完整 project/user 代理目录图，要求每次热/冷管理器遍历后完全一致。保存零模型请求与自然退出结果。新增单测覆盖真实原生显示标签、选择/返回栈、页面所有权切换、空/错误状态及异步列表未完成时卸载。这些检查现已在本地候选上通过，包括热/冷名称、描述与 system prompt 观察、操作页/列表返回导航，以及完整创建后代理目录图相同。组件单测另覆盖真实共享选项标签、可选详情字段、加载/错误状态、页面与 runtime 所有权、卸载和基本滚动调用；它们不代表原生长滚动或可选字段 E2E。手动字段 Ctrl+C 有单测，本次原生 manual case 未执行该操作。所有旧失败仍保留在原运行范围。

## 待确认事项

global 基线的源码身份仍为 unknown。原生 E2E 当前断言所建代理的名称、描述、system prompt，以及只读导航和目录图合同；未断言所有可选字段或长滚动。bundle 入口摘要仅标识该入口。独立的有限身份快照覆盖 1,378 个生成文件，不代表完整依赖图或所有传递 runtime 输入。引导生成、编辑/删除、其他平台、已安装产物及最终合入 main 的验收仍不在本证明范围。
