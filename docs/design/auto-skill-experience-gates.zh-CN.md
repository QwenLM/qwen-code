# AutoSkill 经验信号门控

[English](auto-skill-experience-gates.md) | [简体中文](auto-skill-experience-gates.zh-CN.md)

## 问题与范围

Issue #9062 仍未解决：AutoSkill 评审目前只依赖完成 20 次工具调用。
只读探索会消耗一次评审，而短调试会话和用户纠正可能没有评审机会。
AutoSkill 仍默认关闭；确认流程、managed skill 写入限制和内存压力检查保持不变。
本设计替换触发条件，不改变评审 agent 或 shell 进程生命周期。

## 设计

评审有两条路径：至少 5 次已接受的完成调用，加上同工具失败后恢复或已接受的
中途 steer；或者至少 20 次已接受的完成调用，加上实质性工作。不新增设置。

客户端按调用 ID 暂存小型完成记录，直到对应工具结果被聊天历史接受。
接受判定复用现有的请求所属 history-push 快照，覆盖首个流事件、正常提交和
finally 路径。直接 `addHistory` 也消费匹配记录。重新提交的结果不能重复计数。
被拒绝的输入不会推进评审窗口。skill 文件修改保护仍在本地执行完成时更新，
即使 PostToolUse hook 随后拒绝该结果也保留保护；被拒绝的结果仍不计入经验。

执行状态排除被拒绝、未执行和已取消的调用。shell 成功恢复要求已有的结构化
`ShellResultDisplay` 为 completed 且退出码为 0，绝不解析输出文本。
shell 失败使用执行状态和错误类型；即使前端标为成功，结构化的 cancelled
结果也会被排除。不需要更改 shell 进程拆除逻辑。

同一批结果中，同工具同时失败和成功，不会因结果排序制造重试弧。
后续该工具有成功调用且没有失败的批次才能闭合待恢复失败。
不同工具之间不推断恢复关系。

实质工作包括内置 write/edit/notebook/shell/code-mode 工具、注册的 mutator
种类以及委托 agent 的工作。未标注只读的 MCP 工具也计入（`Kind.Other`
表示副作用未知）。这是保守兜底，并不证明文件改变：shell 读取和委托读取
仍可能调度评审。read/search/fetch 和纯控制流工具不会仅凭调用量获得资格。

信号与待接受完成记录不依赖历史索引，可跨压缩保留。派发时仅重置已消费的
计数与信号，尚待接受的完成记录仍供后续使用。会话切换和 `/clear` 清除全部
评审状态。已有评审运行时保留新窗口，因为其历史快照不包含派发后的工作。
评审仍在既有回合边界检查，不在每次工具结果后检查。已派发评审若后续失败，
保持既有行为：不重新尝试已消费窗口。

## 影响层次

- `packages/core/src/memory/experience-signals.ts`：结果分类、实质工作判定、批次累积。
- `packages/core/src/memory/manager.ts`：必填经验信号及门控。
- `packages/core/src/core/client.ts`：已接受结果计数、steer 和重置。
- headless CLI、TUI 和 ACP 完成路径：提供已有结构化响应，覆盖全部生产调用者。
  ACP 使用原始聊天流，因此也转发已接受的结果批次。基线 ACP 不调度 AutoSkill
  评审；本改动保留这一启用范围，不新增 ACP 功能。
- 同目录测试和既有 skill-review 集成测试：门控、结果、接线和生命周期回归。

## 验证与验收

运行定向单测、仓库 build/typecheck，并用构建后的真实 CLI 连接可控的
OpenAI-compatible provider，执行真实工具。以 provider 收到的 extractor
请求计数，不依赖日志推断。先以全局 `qwen` 建立基线，并使用已有认证尝试
真实模型 smoke。测试工件放在 `.qwen/e2e-tests/issue-9062.md`（git-ignored）。

验收：21 次只读调用不派发评审；同工具恢复在 4 次调用不派发、5 次派发一次；
不同工具成功不闭合重试；20 次 shell 执行保留兜底；禁用和手工 skill 保护
保持；新窗口不复用旧信号。单测覆盖拒绝、重复结果、混合并行批次、结构化
未知 shell 状态、接受/拒绝 steer、压缩及会话重置。不引入新的 shell
进程取消语义。

## 风险与开放问题

确定性信号只是启发式，不是可复用经验的语义证明。未标注只读的 MCP 工具和
agent 委托有意优先避免漏掉实质工作。待接受结果占用内存直到接受或会话重置。
不加入持久化、分类器、可配置阈值、新 UI 或 Auto Memory 提取频率改动。
本实现没有待定产品决策；平台验证限制必须单独报告，不能用单测通过代替。
