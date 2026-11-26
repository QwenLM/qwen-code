# Managed Agent Server SQL 热路径优化

[English](2026-11-19-managed-agent-server-sql-hot-paths.md) | [简体中文](2026-11-19-managed-agent-server-sql-hot-paths.zh-CN.md)

- 状态：已实施，并通过聚焦测试与专用 MySQL 基准验证；完整 CI 验收待定。
- 日期：2026-11-19
- 范围：仅 `packages/managed-agent-server`（persistence、control-plane 调用点、contracts、共享 schema、verification）。

## 问题

对 managed agent server 的 72 处 SQL（JOIN、UNION、递归 CTE、窗口函数、GC ledger）盘点发现，热路径存在全表扫描与逐项补查。在确定性的 100,000 行历史上，活跃 run 计数、阻塞 run 发现和子结果 relay 发现超过 5 秒语句预算；最新 turn、最新 environment 与生命周期窗口读取随无关历史线性增长；GC 收集器每轮都从历史起点重新扫描。

## 目标与非目标

目标：

- 在大历史规模下限制热读路径的扫描量与往返次数。
- 把可重复的后台工作从「每次由历史重推导」改为状态转换 ledger 加固定轮次补偿。
- 精确保留租户/actor/workspace 鉴权、事务边界、锁顺序、租约/fence 守卫、幂等性与恢复语义。
- 保持 H2 与 MySQL 行为一致；只使用参数化 SQL。

非目标（明确不采纳）：

- 不改公共 API，不引入异步缓存。
- Runtime retention 不拆成两个读已提交快照：存在不取 binding 锁的 execution 插入路径，拆分未被证明安全。
- 不盲目预取工具详情正文、不放大分页上限；保留 8 MiB 读取预算。
- 配额采用合并聚合，不使用 TTL 缓存。

## 方案总览

### 1. 查询形态修正（A01、A02、A04、A05、A12、补充项）

- Action 回执结算一次投影读取全部结算字段，消除逐项两次补查；条件更新保持幂等。
- 扩展单包查询直接定向查找目标；在同一只读 repeatable-read 事务内先读取至多 257 个不同 extension id，保留目录上限。
- native snapshot 首候选移除多余 `GROUP BY`；build 闭包聚合不变。
- 生命周期窗口补充 canonical `session_scope_key` 批量谓词；活跃优先的窗口顺序不变。
- workspace artifact 首屏由一次完整过滤查询生成 watermark，替代重复的三表 `MAX` 扫描；续页边界不变。
- 补充项：Session 列表窄投影、worktree 复用已读行、alias/request/MCP 查找使用 canonical 键、8 处零计数探测改存在判断、配额在正常与拒绝路径均合并为两次聚合。

### 2. 谓词与索引支撑（A06、A10、A15）

- 事件类型复合索引支撑最新 turn/最新 environment/控制事件读取；latest-turn 回连限定同一 session 流，按事件序号取最新。
- 递归权限 CTE 把身份函数移到 CTE 侧，使父链与 actor 反查索引可用；保留 sentinel 身份编码、多字节与尾空格语义、先鉴权后分页的顺序。
- Runtime 恢复发现使用生成列候选标志加窄索引；version/state/provider 证明、全局二进制游标与排他 operation 不变。

### 3. 队列与 UNION 发现（A08、A09）

- ready 队列用 `EXISTS` 消除行倍增，在关闭事务内撤回 queued 消息，并先对 channel 绑定去重；保留公平排序、活跃/恢复排斥、已领取与迟到回执、固定轮次补偿。
- 子 relay 发现保持单 SQL 快照：每个 UNION 臂在派生表包装内应用完整过滤、排序并取 N 行；外层保留原全局排序与 limit。优先级、顺序与变化 limit 语义不变。该包装同时避免 H2 在重复执行间保留首个分支的 limit。

### 4. Ledger 状态机（A07、A11）

- Automation 在与记录投影相同的事务内维护 run 终态镜像；精确活跃计数变为一条 SQL，阻塞候选用 keyset 分页替代 OFFSET。`firing` 始终计为活跃、缺镜像仍计为活跃，root 锁与 fence 保留。
- 退休在同一事务内幂等入队 GC 债务；capture 按 32 条批量；GC 补偿跑固定轮次。禁用 GC 也记债；绝不重置已有 claim、代际与终态。

### 5. Journal pack 对象 I/O（A13）

- 对象存储 I/O 移出 SQL 事务。put 闭合标志记录「单次物理对象创建已完成」的证明；未知 PUT 永久保留债务，而不是报告虚假的 GC 完成。每个 UUID 只 PUT 一次。短确认事务替代长时间持有 I/O 的事务，Session GC 等待全部 pack 债务，引用删除精确命中 `resource_key`。

### 6. 批量重建（A14）

- Activity 诊断重建按 32 个 revision 批量聚合资源字节：65 项从 65 次 `SUM` 查询降为 3 次。保留链完整性与 8 MiB 读取预算；工具详情正文仍按预算延后。

## Schema 变更

按模块政策（首个正式 Managed Agent release 之前有效），共享 V1 基线原地编辑；开发 catalog 重建而非升级。

- `ma_journal_pack`：`is_put_closed` 标志、生成列 `active_from_revision`（RETIRED 时为 NULL，使清理债务不阻塞替代 pack）、唯一键改为 `(session_scope_key, active_from_revision)`、新增 put 闭合 CHECK。
- `ma_public_event`：`idx_ma_event_type_sequence (tenant_id, session_id, stream_kind, stream_id, event_type, sequence_id, turn_id)`。
- `ma_session_record`：`idx_ma_record_identity (session_scope_key, domain, record_id)`，匹配 close-debt join 的全部等值条件；加锁记录读取仍走唯一键 `(session_scope_key, record_key)`。键长 2560 字节 < InnoDB 3072 字节上限。
- `ma_workspace`：`idx_ma_workspace_parent (tenant_id, parent_workspace_id, workspace_kind)`。
- `ma_workspace_access`：`idx_ma_workspace_access_actor (tenant_id, actor_id, workspace_id)`。
- `ma_runtime_binding`：生成列 `is_recovery_candidate` 加 `idx_ma_runtime_recovery_candidate (is_recovery_candidate, binding_id)`；布尔 CHECK 扩展。
- `ma_schedule_occurrence`：`is_run_terminal` 镜像标志、`idx_ma_occurrence_outcome` 扩展 `(is_run_terminal, gmt_create, occurrence_key)`、新增 `idx_ma_occurrence_run (tenant_id, run_id)`、新增布尔 CHECK。

## 保留的不变量

- 租户/actor/workspace 鉴权先于 LIMIT 与分页执行，包括 lookahead 行；无跨请求鉴权缓存。
- root/head/row 锁顺序、writer 与 claim 代际、租约 fence、repeatable-read 快照规则不变；fresh-committed 检查不搬回旧快照。
- 结算与退休保持幂等；引用与恢复保护不变。
- H2/MySQL 一致性：嵌套 CASE 替代持久化 IN 捕获、派生包装解决重复 UNION 分支 limit、VARBINARY 身份使用绑定参数或二进制字面量。

## 风险与权衡

- 写放大：终态镜像与 GC 入队增加写事务工作量；这是有界后台读取的既定成本。
- 实测退化：100k 空结果 UNION 发现 p50 从 70.452 ms 退化到 100.968 ms（空集上的分支 top-N 加索引回查）。稀疏队列与权限第一页仍随 domain 行数线性增长。
- 基准局限：共享开发机、热缓存、单连接、合成 JDBC 读取；p95 采用 15 样本 nearest-rank。这些不是生产容量数字。

## 验证

- 单测：29 组共 887 项——883 通过、4 项 H2 引擎专属跳过，且每项均有 MySQL 套件覆盖。
- MySQL 8.4.11：12 组共 123 项全部通过，含 4 个引擎专属锁/恢复场景、scanner 并发、固定轮次 ledger 修复，以及基于真实 Core/CLI 构建产物的原生媒体保留验证。
- 构建：Java reactor 编译、Core/CLI 构建、Checkstyle 全部通过。
- 基准：可选启用的 harness（`ManagedSqlPerformanceMySqlIT`）在 1,000/10,000/100,000 行确定性历史上运行生产读路径，至少 15 个测量样本，5 秒单语句与逻辑调用预算，按线程的 `COUNT_STAR`/`SUM_ROWS_EXAMINED` 增量与 performance_schema 历史交叉校验，计时后采集 EXPLAIN ANALYZE。启用方式：`-Dsqlperf.enabled=true -Dsqlperf.variant=baseline|optimized -Dsqlperf.group=core|discovery|all -Dsqlperf.sizes=1000,10000,100000 -Dsqlperf.samples=15 -Dsqlperf.output=<新文件名>.json`，另加指向专用 catalog 的常规 `mysql.url`/`mysql.user`/`mysql.password` 属性；要求 `useServerPrepStmts=false`。失败即构建失败；报告绝不覆盖先前运行。
- 结果一致性：69 个场景通过（39 core + 30 discovery）；59 份可用基线结果指纹完全一致；10 个基线超时场景对照独立计算的期望值核验；表行数相等。

100k 档 p50 摘要（ms）：

| 场景                          | 基线          | 优化后                        |
| ----------------------------- | ------------- | ----------------------------- |
| 活跃 run 计数（混合历史）     | >5000（超时） | 0.447（1 SQL，6 行 examined） |
| 阻塞 run 发现（混合）         | >5000（超时） | 0.973（2 SQL，7 行 examined） |
| 每 session 最新 turn          | 139.935       | 0.682                         |
| 每 session 最新 environment   | 145.639       | 0.612                         |
| 生命周期窗口                  | 36.417        | 0.844                         |
| 子 relay UNION（混合）        | >5000（超时） | 98.865                        |
| 子 relay UNION（稀疏 normal） | >5000（超时） | 135.570                       |
| 子 relay UNION（仅债务）      | >5000（超时） | 147.721                       |
| 子 relay UNION（空结果）      | 70.452        | 100.968（退化）               |
| ready 队列（多条 queued）     | 127.989       | 9.045                         |
| 权限第一页                    | 55.451        | 41.692                        |
| 权限下一页                    | 11.717        | 1.049                         |

10k 档混合 UNION 从 3035.787 ms 降至 12.116 ms。事件索引把计划算子输入从扫描 200,015 行降到 4 行（turn）/10 行（environment）。保留了仅分支限流的中间版本（100k UNION 784–837 ms）作为证据：最终 UNION 数字来自 record 身份索引，而非仅靠改写。

## 验收标准

- 每个测量场景结果一致（指纹或独立期望值），且表行数相等。
- 100k 档热路径计数、阻塞发现、最新 turn/environment 与生命周期读取至多 2 条 SQL、个位数 examined 行。
- 鉴权、租约/fence、幂等与恢复套件在两个引擎上通过；PUT 未证明完成前 GC 绝不报告完成。
- 不访问生产数据库；只使用参数化 SQL；构建与 Checkstyle 通过。

## 后续工作

- 完整 CI、SpotBugs/完整 verify、集成 profile 与在线写吞吐/容量测量未在本轮执行。
- 空结果 UNION 退化可在真实负载证明其影响后，考虑空集短路。
- UNION 的 due-work 臂仍扫描 domain 行加排序；权限第一页与稀疏队列仍随 domain 行数线性增长。进一步收窄需要负载证据。
