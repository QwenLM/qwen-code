# Managed SQL 历史与 authority 驻留窗口

[English](2026-10-29-managed-sql-authority-window.md) | [简体中文](2026-10-29-managed-sql-authority-window.zh-CN.md)

## 状态与交付边界

从 Draft [#15696](https://github.com/QwenLM/qwen-code/pull/15696) 独立提取到 main。本次交付调整 managed-local 的 H2 与 Hosted 的 MySQL 所承载的 Managed 执行。最终集成验收仍待完成。实现、聚焦测试、CI 资格与发布是不同的证据状态。

daemon Legacy 的持久化、恢复、回放、rewind、通知去重、Goal 恢复和工具执行保持现有行为。共享接口可为 Managed 异步历史作必要适配，但 Legacy 保留原执行分支。执行引擎与存储后端是独立维度：JSONL 也可以承载 Managed 会话。

独立 activation/inbox 快照流式处理、文件调度器终态驻留优化及额外解析器依赖不在本 PR 内。保留本地 Managed 适配器与共享接口的兼容性，以及 Hosted 校验所需的文件 scratch；这不代表独立 JSONL 已完成内存资格验收。

## 问题与目标

Managed Session authority 及其调用方常驻已完成的事件、身份、回执、命令、checkpoint 和领域修订。恢复时加载完整 journal 与 checkpoint 数组，又把增长转移到临时内存。只限制活跃尾部无法保留旧重试答案，也无法约束恢复内存。

使 authority 内存与活跃状态、固定缓存和有界 I/O 成正比。保留完整 canonical 历史、旧 key 精确重试/冲突答案及原回执。冷恢复允许扫描历史；固定恢复时长、有界磁盘增长与完整进程 RSS 属于独立资格项。

## Canonical 存储与派生查询

Java/JDBC 管理 H2/MySQL canonical journal。Core 使用经过认证的 HTTP 契约，不持有 SQL 凭据。历史路由保持持久化 Workspace/Session 归属，保留租户凭据、writer generation 与 read-grant 校验。

版本化历史事实保存身份、来源 revision/sequence、定位与 digest。canonical 提交与新事实在同一事务写入。既有行按有界批次补建，只推进连续覆盖。只有完整捕获的前缀可以证明不存在；不可用、覆盖不完整或损坏均拒绝。

按 generation 隔离的历史 state/fact 包含 bucket 条数。将选中事实与 canonical 事务、event/marker 摘要、范围、序列及物理 parent 核对。比较交换修复只重建派生状态，不修改 canonical 历史或重置更新的一代。清理保持有界且范围明确；派生表不能成为 CSI authority carrier，也不能驱动跨租户扫描。

同步修改未正式发布的 V1 schema baseline 及初始化、projection、inventory 和校验契约。不增加 V2 migration，不自动删除 catalog，也不执行 Flyway repair。组合 inventory 包含 41 张 managed 表、844 列，其中包括 main 的紧凑续约元数据。

## 固定视图与流式恢复

异步读取前捕获租户、Workspace、Session、journal revision、提交序列和 digest。流式读取经过校验的事务及选中快照页，不拼接完整逻辑 journal。保留 marker 链、torn-tail 处理、资源校验和最终 ownership fence。

紧凑 activation 续约只更新既有 activation 事务的租约元数据，不推进 journal revision 或提交序列。当前完整 HTTP 扫描和快照检查只叠加经过校验、属于同一 active 身份的元数据。显式字节前缀读取保持原 activation 状态。即使流式读取时已经构建了恢复中的 authority，最终恢复也必须采用扫描返回的已校验摘要。

未知追加结果在既有结算协议确认 landed 或 absent 前保持不可读。历史查询未命中不能结算不确定写入。已提交事务的派生视图失败时，保留有界 overlay 和原回执，后续写入等待修复。

## 常驻 authority 与 Managed 调用方

最近事件尾部最多 1,024 条/8 MiB，历史缓存最多 2,048 项/4 MiB。保留活跃输入、Action、activation/checkpoint 及生命周期引用。已完成身份通过不可变历史视图查询，不放入无界常驻 Map。

Managed 恢复、审批、模型/Plan 选择、工具、Hook once/occurrence/ordinal/definition pin、child/team continuation、通知和清理使用异步点查或有界迭代。消息/分支投影与完整终态/domain 历史是不同视图，终态记录不能成为消息 parent。模型材料保持为选定分支和当前上下文，不静默截断 canonical 历史。

共享 recorder、ACP 和 Goal 适配器为 Managed 执行选择这些路径。Legacy 通知准入保留原内存身份 Set 与严格持久化路径，不依赖 Managed 冷历史查询。Legacy Goal 重建与取消恢复保持原 transcript reader 和算法。定向回归验证这些边界，不代表所有 Legacy 平台路径都已验收。

## Checkpoint 与 CSI proof

保留既有分页 checkpoint 线上格式及字节/页数资格上限。authorization 提供紧凑当前状态和惰性、不可变的历史 tool/binding 查询，校验身份、ordinal、回执和 pin。较新 head 不能改变旧的捕获视图。

通过私有磁盘事实约束 checkpoint 和 CSI proof 索引，同时保留来源校验、精确终态镜像、连续历史覆盖和清理归属。scratch 丢失可从捕获的 canonical root 重建，canonical 损坏则拒绝恢复。JDBC 与保存后的 application 回放均校验 main 的紧凑 activation 租约元数据。不削弱授权、行数、字节或资源上限。

managed-local H2 保持既有同步持久化与 JVM 临时 buffer 缓存上限。heap、direct-buffer、external memory、RSS、context/checkpoint 和 network-buffer 结果分别保留实际测量范围。

## 兼容与范围外事项

保留 journal 格式、canonical 事务/资源、replay floor、Node 下限与本地 writer-lease ownership。不自动发布快照、不压缩预览数据库、不降低历史保留，也不关闭整个 #13184。不包含 daemon Legacy 功能或存储优化。

文件 scratch 是派生状态，不替代 canonical authority。磁盘用量、重建成本、清理耗时和写放大仍是明确成本。额外独立 JSONL 优化及文件 activation/inbox 终态工作保留在原 Draft，后续再提取。

## 验证与验收

执行受影响的 TypeScript 构建/类型检查及定向 Managed/Legacy 回归，保留准确测试身份、源码输入、失败与跳过。仅在原来源边界内复用未变证据。导入代码中的流式紧凑租约恢复不匹配已有失败回归，需在本分支验证修正后的行为。

共享本地 Java 验证配额仍在 564.787/600 秒主动关闭；剩余 35.213 秒不得使用，也不能因拆 PR 重置。不允许运行本地 Maven、javac、Checkstyle、SpotBugs 或相关准备。最终 head 的 CI 负责完整 Java profiles、MySQL/MariaDB、真实 HTTP 恢复、固定堆 10k/100k H2/MySQL 历史、checkpoint/context 资格、Hosted/CSI/Automation/Monitor 故障与支持平台。

旧 head 的 fast、单元、smoke 和空上下文规模成功不能作为本分支完整验收。所有旧代码失败、setup 失败、跳过/未运行断言及待验 gate（包括报告归属、Workflow 终态镜像和时间相关失败）继续保留，直到有效证据逐项闭合准确范围。
