# 统一 Managed Shell 工具配置

[English](2026-10-23-managed-shell-profile.md) | [简体中文](2026-10-23-managed-shell-profile.zh-CN.md)

## 问题与范围

Managed Agent 尚未上线。维护 `hosted-workspace-shell/1` 与
`hosted-workspace-shell/2` 增加了不必要的兼容边界：`/2` 增加 `glob`，但生命周期、MCP
管理和其他会话能力识别的是 `/1`。因此，issue #15078 中存在能够执行工具、却无法使用现有生命周期协议的 Shell profile。

统一使用 `hosted-workspace-shell/1`，包含现有工具与 `glob`。文件工具、MCP、只读子会话和
team-lead profile 保持当前范围。profile 合并本身不新增组合式取消并关闭操作；配套生命周期默认启用与有限交接期详见[生命周期设计](2026-10-23-managed-shell-lifecycle.zh-CN.md)，资源结算要求继续保留。

## 拟议变更

Hosted Harness 仅提供一个 Shell profile 和一份 Shell 工具清单。配置判定、工具声明、审批策略选择、Plan
准入和 Workspace 恢复使用同一标识。`glob` 沿用现有有界 Workspace 搜索执行和只读审批规则。

Java 控制面在公开 Shell 和审批策略选择准入中仅识别该 Shell 标识。为创建 Session 编译定义时，
即便部署配置仍允许其他 Shell 标识，也拒绝这些非统一标识。现有生命周期 v2、MCP
及原 Runtime 清理流程继续适用于统一后的 profile。公开 API 字段与生命周期线协议不变。

从允许的 Shell profile 中删除 `/2`，不保留别名或迁移路径。用户已确认这些配置尚未上线。
现有开发测试数据改为选择 `/1`；被移除的 profile 值继续按不支持处理。已保存会话定义仍固定其选定的
profile，加载时任意更换配置仍会被拒绝。

## 受影响组件

- CLI 工具配置定义、工具声明与配置准入调用方。
- Java 公开 Shell 分类与持久化审批策略选择校验。
- 针对配置、工具、Hosted 会话、恢复及 Java 调用方的测试。
- 两种语言的当前配置文档；历史验证报告保留当时提交实际测试的标识。

## 验证与验收

统一后的 Shell profile 必须在普通 Workspace 执行路径上提供 `read_file`、`write_file`、`edit`、
`run_shell_command`、`monitor` 与 `glob`。原生 `glob` 必须保留参数校验、结果边界和目录约束，并在
default 与 auto-edit 策略下按只读操作预批准。仅前台执行的传输方式保留现有限制。

创建、加载与 Workspace 恢复必须拒绝被移除的 Shell profile。文件工具配置与只读子会话配置必须保留原有工具清单。
公开 Shell 选择、实时审批与 Plan 准入必须使用统一标识。

当 `/1` 启用了生命周期 v2 时，统一后的 profile 必须继续执行现有效果、资源准备与资源结算阶段。
存在活跃 Turn 时，关闭仍以 `turn_active` 拒绝。执行或输出结果未知时，仍必须阻止退役。
单测通过不能证明 Linux 进程故障或部署验收已经完成。

执行针对性的 CLI 与 Java 调用方检查、根目录构建与类型检查，以及
`.qwen/e2e-tests/managed-shell-profile.md` 中记录的 Hosted 执行探测。无法执行的检查与成功结果分别记录。

## 发布与待决问题

启用前一并部署匹配的控制面、Harness 与 Runtime 产物。由于原有标识新增了 `glob`，旧 Runtime
的能力标识本身不能证明它能够执行该工具。本次不引入生产数据迁移或兼容别名。

本次合并没有待决产品问题。配套生命周期启用见链接设计，真实进程验收仍须单独记录。
