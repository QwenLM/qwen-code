# Managed SQL 毫秒时间戳

[English](2026-10-14-managed-sql-millisecond-timestamps.md) | [简体中文](2026-10-14-managed-sql-millisecond-timestamps.zh-CN.md)

## 状态与问题

已在本地实施并验证。用户选择所有 Managed 业务时间戳列使用 BIGINT UNSIGNED Unix epoch 毫秒，并接受丢弃不足一毫秒的精度。变更前，新库权威 baseline 混用 BIGINT 毫秒和 DATETIME(6)，创建/修改列使用 created_at/updated_at。

## 范围

在当前 schema、SQL、字段投影、映射、测试 fixture 和恢复导入导出读取中，将已有 created_at 改为 gmt_create、updated_at 改为 gmt_modified。所有持久化业务时间戳列，包括租约、截止、保留、调度 slot 和重试时间，统一为 BIGINT UNSIGNED epoch 毫秒。其余运行时间字段保留名称。序列、版本、计数和时长不属于时间戳。按用户明确选择，mount_birth_time 保留文件系统身份指纹原始字符串；降为毫秒会改变物理目录身份校验。

权威资源是新库 baseline，不是已有库原地升级。不修改用户数据库，不隐式转换旧结构。真实 MySQL 结构验证应拒绝有符号时间列。主键/外键、身份作用域、JSONL 记录字节、领取代次和排序条件保持原有定义。公开 API JSON 属性保留 created_at/updated_at 和既有单位（包括以秒表示的公开 Turn 时间戳）。动态 SQL 恢复导出使用新的物理字段名和数值。

## 实施

Spring JDBC 参数边界将时间对象绑定为 epoch 毫秒。既有普通 JDBC Session writer 路径显式绑定数字，包括 head 更新和 CSI journal 插入；恢复和 CSI 命令行入口使用 Managed JDBC 适配器。原 DATETIME 读取点在需要时将可空整数明确转换为现有 Java 时间表示；原始行导出保留整数毫秒。Runtime Broker 的共享 Instant 绑定和读取使用 BIGINT。数据库时间仍是租约权威时钟，归一化到毫秒。短于一毫秒的时长不能生成持久化的亚毫秒租约。

持久化 DATETIME 运算和比较改为整数毫秒，移除存储字段的 FROM_UNIXTIME/UNIX_TIMESTAMP 包装。保留 NULL 和零值语义、截止/领取比较、分页同值排序，以及拒绝/幂等更新的行为。保留游标应绑定数值时间。保持此前查询整理中纯协调时间戳的特殊语义。

读取 Connector/J 的可空无符号时间列时显式指定 Long，不强转默认返回的 BigInteger。完成的 GC 账本将 available_at 设为一个低于 2^53 的「永不到期」哨兵，认领查询的区间扫描因此直接跳过它们，不会扫过全部已完成历史；其 SUCCEEDED 状态同样会排除它们。早于 epoch 的保留截止时间不会产生候选，恢复游标也遵守该规则。

真实 MySQL catalog 对照 baseline 校验 BIGINT、UNSIGNED 和可空性。H2 用于快速契约反馈，不能证明无符号约束生效。

合并后的 V1/V2 schema 保留新合入的 CSI authority 字段与约束。全部 28 组共享完整行投影包含声明的字段；针对 V2 迁移前结构的测试，仅在迁移前剔除尚未存在的两个 Session 字段。私有变更门禁、原 holder 证据和 activation 检查保持完整。

## 验证

先由独立 test engineer 确认实施前基线。检查权威类型/命名、无符号拒绝、非负 epoch 值、可空时间、精确毫秒往返、2038 年后的值、Java 有符号范围处理、持久化租约到期、过期领取拒绝、分页同值、恢复/CSI 导入导出和 JSONL 不变性。微秒级漂移断言调整为一毫秒漂移，保留相同恢复检查。

运行仓库 build/typecheck/bundle 和 Java 定向测试，随后执行适当包验证。再以专属 MySQL 8.4 数据库验证 schema、恢复、保留、发布和查询计划。对累积完整 diff 做连续两轮自审，并进行独立代码审查。单独记录跳过/未测验收项。

## 验证结果

整合当前主分支 V1/V2 baseline 后，SDK 测试运行 247 个用例，零失败/错误，九个条件跳过。Broker 全量及修正/最终定向类报告得到 953 个不重复有效用例，零失败/错误，两个跳过；最后受影响路径复验 87 个用例。Server 全量在最后 upsert 修正前通过 2755 个用例，之后 135 个最终受影响路径用例通过，得到 2756 个不重复有效用例，零失败/错误，七个跳过。有效数量通过替换类报告计算，不累加重复运行。最终 Broker/Server Checkstyle 和 SpotBugs 通过。仓库 build、typecheck、bundle 和修改的 E2E 脚本格式/lint 通过。

最终 MySQL 8.4.11 验证通过 76 个 Broker 用例、20 个 Server consolidated fixture 用例和 262 个 Server 集成用例，全部零失败/错误/跳过。这些最终原生运行使用最新源代码与已安装的 Broker 产物，包含生命周期/fence/注册 upsert 修正。元数据确认 77 个无符号业务时间戳列，没有持久化 DATETIME/TIMESTAMP 列。原生检查覆盖 Connector/J 可空/2050 年无符号读取、GC 完成及拒绝重新领取、恢复/CSI 导出、查询计划、连接/JVM 时区、进程崩溃后的 JSONL 重放，以及真实事务隔离下的 CSI 变更/快照门禁。

实际 JDBC/私有 CLI probe 通过 CSI ACK inspect 并保持不可变证据、CSI Session 创建及保留原毫秒时间的精确重放，以及 Runtime SQL 解析直到必需的 Kubernetes API 配置门禁。真实 macOS 上 WorkspaceRecoveryMain 命中既有的仅 Linux 门禁，其 Linux CLI 端到端路径未运行。到期条件保留未来的读取租约并回收过期租约。未运行真实 Kubernetes/CSI/OSS、完整 Hosted/Harness 脚本和独立 Broker fault-gate profile。SDK 跳过项需要 Windows 或真实 daemon/Hosted endpoint；Broker 两个跳过项需要真实 worker 基础设施；Server 七个全量跳过项单独记录。未迁移任何已有数据库。

独立审查及反向审计在修复后没有剩余确认问题。最后两轮自审覆盖累积 diff、新文件、CLI/无符号/E2E 接线和 upsert 重放行为。最终 Java/源码清单和已安装产物对照验收快照核验。仅使用任务专属临时数据库/用户及专用测试 MySQL 服务。

## 验收

- 每个持久化业务时间戳列均为 BIGINT UNSIGNED epoch 毫秒；baseline 没有 DATETIME/TIMESTAMP 列。
- 当前 SQL 读取和写入不使用旧创建/修改列名。
- 真实 MySQL 验证无符号类型，并拒绝负时间戳。
- 毫秒精度下租约 fencing、NULL 处理、游标排序和恢复保证正确。
- 公开 DTO/API 时间字段名、单位和不可变 JSONL 字节保持各自契约。
