# ACP 重试一致性证据保留

[English](2026-11-16-acp-retry-parity-evidence.md) | [简体中文](2026-11-16-acp-retry-parity-evidence.zh-CN.md)

## 问题与状态

一次 Linux Node 22 CI 在重复重试场景中因不同 arm 的共享循环 round 计数不一致而失败。JUnit 保留了断言，却没有保留区分真实执行分歧与诊断输出不完整所需的 arm debug 字节、requests 和 updates。
随后本地 Node 24 定向运行的测试及外层生命周期均通过：current/shared/kernel 计数分别为 0/0、3/0 和 3/3，观测到的 debug 字节在终止前及退出后完全相同。另一次完整文件运行的内层 25 项测试通过，但外层清理为 NQ，不是整条流程通过。两种观测都不复现、解释或抹去 CI 失败；此前过宽 meta 集合超时及平台 date 工具失败继续保留为失败记录。
与 `main` 的 `b5698f6b07c32dec2d587dc16d8658ec0abac9cd` 集成时保留其关闭前日志稳定读取（上游 #17365）。Observer 仍在 kill 前及父进程退出后保存快照，但断言计数来自上游的稳定读取，退出后快照不覆盖计数。上述本地结果属于此前候选；本集成候选须独立完成构建、测试及 CI。
测试侧 observer 已在本地执行；CI 接线及远端同次运行证据仍是独立验证门槛。本改动保留证据，不是重试或运行时修复。

## 范围与所有权

仅改动既有 ACP parity 集成测试、共享测试侧 debug 枚举及定向 helper 测试、no-AK CI 接线、直接受影响的 workflow meta-test 及本互链双语设计。Core、round 相等断言、公开 request/update 断言及产品启动和关闭策略不变。
`ACP_PARITY_DUMP` 已存在。CI 在单个命令上设置 `RUNNER_TEMP` 下按 run ID、attempt 和 shard 隔离的非凭据路径，不扩大清空凭据的 step 环境。
夹具 debug 文件属于各 arm 的隔离 runtime；证据属于当前 CI job，位于夹具工作区及 runtime 之外。不上传 runner 全局 HOME、全局 debug 目录或环境 dump。

## 测试侧记录

启用既有 dump 选项时，在原 kill 之前和原退出等待之后，立即将夹具所有普通 debug 文件（排除 `latest` 别名）复制为 base64 原始字节快照。
保存既有完整 per-arm 结果，包含 requests、updates、stop reasons 和两种 round 计数，不以 request 数量代替 round 身份。
使用 scenario/arm-PID 目录及独占 `wx` 写入，防止另一测试 attempt 静默覆盖旧 receipt。保留既有顶层三臂 dump，它原本就在 round 断言之前写入。
Observer 与文本读取共用普通文件枚举；文本读取保留原顺序及空文本语义。debug 目录缺失或 debug 文件枚举为空会添加 observer error。外层仅观测 finally 即使在请求、稳定读取、原清理或 home 隔离断言抛错时也写 result/status。正常业务结果仍在原清理和 home 断言之后收集；异常路径结果标记 partial，不能取得完整证据资格。Observer 失败不能替换原异常。缺 receipt/status、partial 结果或 observer-error 非空表示证据 NQ，不是产品通过或已定位的产品失败。

## CI 接线与清理

no-AK 测试命令创建所属证据目录，仅该命令接收 `ACP_PARITY_DUMP`。分片、预算、重试策略、路由、checkout 和零凭据防护不变。
no-AK gate 失败时，固定版本的 artifact action 仅上传 `a-retry-that-fails-again/` 及其 current/shared/kernel 三个结果 JSON 路径。Artifact 名含 run ID、attempt 和 shard，保留七天。
上传为辅助行为，匹配为空时警告：更早的 setup 失败或其他场景失败不能看起来像目标证据完整。上传失败不改变原测试失败。Meta-test 将精确四条上传路径与真实源码场景及其 slug 变换绑定，不加通配符或扩大 HOME 上传。
上传后始终只清理显式构造的证据目录，并继续既有隔离 HOME 清理。不新增取消运行时的 artifact 覆盖保证。

## 解释边界

Debug 写入为 best effort，没有公开 drain promise。ACP 信号关闭及 stdin EOF 最终都会强制退出进程；更换传输关闭方式不是已证明的无损日志方案。
快照跨文件非原子，stderr 仅覆盖各边界已接收字节；新增父进程同步 I/O 可能扰动调度。仅有 pre/post 变化无法区分迟到 append 与迟到执行，快照不变也不建立通用 flush 保证。
Kernel bus marker 仅匹配同一快照的 session round ID，并保留重复项。保留每个 attempt 及外层清理状态，本地带观测通过不能替代 Linux CI 证据。

## 验收与后续

运行受影响的集成类型检查、定向 helper 测试及原定向场景，不修改断言或重试次数。证据取得资格需 PID 目录 receipt 完整、status 完整且 observer errors 为空。在所属临时源码变异中，改名目标场景须使 meta 合同失败；强制原 home 隔离断言失败后仍须得到 result/status 且状态为 partial；在快照前删除夹具 debug 文件须记录 observer errors。随后精确恢复源码。三项所属源码变异均已实际观察并精确恢复：场景改名使上传合同失败；强制 home 隔离失败仍保存 partial result/status；缺失 debug 文件时业务用例通过，但三个分臂均记录 observer errors，证据仍不具资格。
直接 no-AK meta-test 须运行完整文件，并据真实源码读点回归每个消费已改 job 的合同，包含 hosted-process gate 消费者及适当的邻接兼容检查。按实际消费字段而非路径字符串 grep 选择；未受影响的完整 workflow 套件仍由正常 Linux CI 覆盖。保留原断言、重试及期限不变。随后检查 workflow 格式、actionlint 和引用，固定精确上传路径、失败条件、action 版本、唯一名称、保留期限及清理顺序。
新 CI 尝试若发生目标失败，应检查该次实际 receipt；通过或缺证据都不能反向解释原失败。对外分享前需审阅夹具证据的适用受众。
只有证据区分真实执行分歧与诊断不完整后，才能进一步判断原 CI 根因。不暗示 Core 修复、凭据访问、自动重试、审查批准或整体迁移通过。
