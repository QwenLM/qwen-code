# 重试 main CI 中的暂态 Maven 下载故障

[English](2026-10-18-main-ci-maven-transfer-failures.md) |
[简体中文](2026-10-18-main-ci-maven-transfer-failures.zh-CN.md)

## 问题与范围

Issue #14426 描述了暂态 Maven 构件下载故障被送入代码修复队列的问题。
main CI 监听工作流检查 runner annotation，但失败的 shell 步骤通常只有
`Process completed with exit code 1.`。Maven 的故障原因记录在日志中。

本次仅为 main 监听工作流增加 Maven 下载故障证据，保留共享的 runner
annotation 特征和 PR autofix 工作流。不为构建命令增加 Maven 重试，也不改变
测试失败的去重方式。

## 设计决策

先保留现有 annotation 检查。未识别出 runner 故障时，通过
`gh run view --repo "$REPO" --job "$job_id" --log-failed` 获取该 job 的失败
步骤日志，再由一个小型 Node helper 检查。

存在逐步骤日志时，gh 通过制表符分隔的前缀标明 job 和步骤；否则会以
`UNKNOWN STEP` 输出整份 job 日志，包括成功步骤和清理步骤。成功步骤可能
包含已经恢复的网络错误，之后另一个步骤才失败，因此 helper 必须确认日志
归属。它接受任意日志时间戳前的 BOM，并去除原始或经 gh 转义的 ANSI 字符。

helper 要求同时满足：

- Jobs API 中每个失败步骤都有对应日志。缺失、重复或无法表示的失败步骤名称
  都不构成证据。特别是 gh 即使遗漏某个步骤日志，也可能成功退出。
- 对于 `UNKNOWN STEP`，所有未跳过的步骤都必须具有有效的 API 执行时间。
  时间只有秒级精度，因此区间必须包含完成时间所在的整秒。任何可能属于失败
  步骤的日志行都必须只有一个候选归属；有歧义的边界行直接拒绝，不能丢弃。
  确定在失败步骤时间之外的输出可以忽略。拒绝混合使用明确和未知步骤归属。
- 每个步骤均以 runner 的非零进程退出标记结束。
- 最后一次 Maven `BUILD FAILURE` 后只有下载错误、耗时信息和已知 Maven
  帮助文本。下载错误必须在同一条诊断中同时包含 `Could not transfer artifact`
  和 HTTP 502/503/504、连接或读取超时，或连接重置。
- 失败步骤中任何位置出现其他 Maven 错误诊断，或非退出码的 runner/action
  错误 annotation，都会使其不符合条件，即使后续 Maven 调用最终遇到下载故障。

警告、任意超时、认证或资源不存在错误，以及后续编译或测试失败，均不符合
条件。无法识别的 Maven 输出继续进入普通 issue 路径，不猜测它是暂态故障。

时间回退有意保留限制：真实 GitHub 日志中的失败步骤末尾输出与后续清理经常
发生在同一秒。在没有明确步骤归属时，这些场景仍然报告 issue。统计退出标记、
按日志 group 分割或将 BOM 当作步骤边界都无法消除归属歧义；允许继续的 shell
失败与失败的 JavaScript action，其退出标记数和失败步骤数不一定对应。

## 路由与约束

保留全部运行级规则：仅重试 attempt 1，失败 job 集合必须非空，且每个计入的
job 都须确认属于基础设施故障。gate reporter 的衍生失败继续排除，而 reporter
自身 runner 死亡仍然计入。重跑派发失败时仍创建 issue；重跑后再次失败则以
attempt 2 回到正常上报路径。

元数据、annotation 和日志仅作为数据处理。新增 helper 不访问网络、不写入；
新增 gh 调用使用 analyzer 已有的只读 token。issue 创建仍由独立的特权 job
完成。额外日志读取只发生在首次运行中、没有匹配基础设施 annotation 的失败
job 上。

## 验证与验收

- 使用模拟 GitHub 响应执行实际工作流步骤，检查重跑和 issue 路由，包括重跑
  派发失败后的回退。
- 使用本地回环 HTTP 镜像和空构件缓存制造真实 Maven 503，并以真实 javac
  编译错误作为非基础设施故障对照。
- 覆盖暂态下载变体、混合 job 和步骤、已恢复的错误、缺失或未知日志、读取失败、
  reporter 处理及后续 attempt。
- 回放保存的 GitHub 日志格式，覆盖 BOM、时间归属明确的整份 job 日志、同秒
  边界、允许继续的失败、action 错误、缺失元数据及清理。历史日志作为反例；
  整份 job 日志正例使用真实 Maven 输出，并明确采用合成的步骤时间。
- 在 macOS 和 Docker Linux 中运行相关工作流元测试及 helper 测试。
  Linux harness 执行未经改写的 Bash 工作流脚本。
- 执行仓库构建、打包、类型检查，以及改动文件的 lint 和格式检查。

验收要求已确认步骤归属的真实 Maven 503 选择一次基础设施重跑，同时编译失败、
歧义证据和重复失败继续上报。harness 模拟 GitHub 元数据和写操作，不派发线上 Actions，也不
创建远程 issue。对于不符合已识别终局格式的跨平台 Maven 输出，有意保留普通
故障分类。
