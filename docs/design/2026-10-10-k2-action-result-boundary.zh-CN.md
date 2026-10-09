# K2 旧 action 与 result 写入边界

[English](2026-10-10-k2-action-result-boundary.md) | [简体中文](2026-10-10-k2-action-result-boundary.zh-CN.md)

状态：实现完成并通过有界独立本地验证；维护者审查与完整 K2 验收仍开放。基线：
`1cae4cd16d9475dc8f3d6052d77a12187c34ea5a`。关联 #12380、#13395 和
Draft PR #13526。本轮接续旧 Managed Agent 写入保护，不表示完整 K2 退役验收。

## 问题与基线行为

公开事件保护未覆盖 result 的独立事务。已完成原生 CSI 资格校验的 journal
提交仍会创建旧投影任务。回填更新 journal 检查点，并在事务回滚后另行写入
错误。领取和失败回调在未检查父 Session 的情况下修改 result 租约、次数和状态。
投影在核对真实持久目标之前已取得 retention 读租约。Action 响应准入及完成
也有独立写入边界。

调用方可构造的 `Claim.Source` 及 `source_json` 不能授权 `result_id` 指向的
数据库行。持久 tenant、workspace、Session 和 digest 才是目标身份。历史私有
派生行须保持原样，等待完整原生清单逐项纳入；标记 unsupported 仍是应用写入。

## 目标与范围

- 禁止旧 action/result 写入私有 CSI Session，包括普通 profile 保留原 pin
  的情况；阻止已持久私有目标通过旧投影路径进行 I/O。
- 保留原生 receipt、outcome、resource 和 journal 的原事务。
- 保留没有公开 Managed Agent Session 的普通 journal、普通 action 的 actor
  与重放语义，以及 result 的 policy、租约过期和错误处理行为。
- 保留不可变历史私有行；不通过迁移删除、终态化、清除租约、补建权限或推进代际。

生成的 `csi_guard = TRUE` 仅用于排除，不赋予原生 placement、成员、续写或
drain 权限。本轮不认证普通 profile/空 pin 与原 CSI 历史冲突的行。Retention
退役、collector、application cut 清单、物理 writer 终止、精确 CSI
NodeUnpublish、原子 RELEASED 和安全复用仍是后续工作。公开 Spring/Hosted CSI
选择继续关闭。阿里云 ACK 是测试环境，不是 runtime 依赖。

## 拟议变更

| 组件                        | 边界                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 包内共享 Session guard      | 提取既有精确 TRUE 锁定读、十秒查询超时和 MySQL/MariaDB 索引提示。显式旧写入继续使用 `csi_managed_mutation_unavailable`。不增加公开能力或晚取得 placement。 |
| 原 journal 提交             | 仅在已资格校验的 `csiOriginal` 为空时调用旧 result capture。保持原生 journal 校验和持久化不变。                                                            |
| Result capture              | 保持普通 source 校验及去重；非空插入前跳过当前 TRUE 目标。空批次仍不做工作。                                                                               |
| Result 回填                 | LIMIT 前过滤私有目标；无锁发现候选，当前读探测父行，再锁定精确 head 并复核当前 scope、state 和检查点后写入。                                               |
| Result 领取                 | 每种既有 state 在 LIMIT 前过滤；排序有界无锁候选，探测真实 scope，锁定单个精确 result 并复核当前 state、到期时间和 source 后领取。                         |
| Result fail/complete        | 探测前识别持久目标；资格判定后校验不可变列、持久 Source 和调用方 Source。保留 state/generation 条件。真实私有行不写入，包括伪装普通 scope 的 Claim。       |
| Result projector            | 在 readLease 或对象 I/O 前、错误转 fail 的 catch 外核对持久 result。后续各次写入独立复核。缺失/私有目标不投影；普通 source 冲突在 I/O 前拒绝。             |
| Action apply/admit/complete | 在实际 `action.changed` 应用、准入及结算的写入前保护。原生提交无条件调用的非 action 回调仍不做工作。准入保留既有 placement 在探测前。                      |
| Action deliverable          | 在既有 LIMIT 前排除私有 operation，保留普通积压任务的进展。                                                                                                |

无需修改 schema、route、controller、原生 grant、action schema 或 source
转换器。小型共享 SQL helper 在三个 store 有实际调用，不是通用权限解析器。

## 身份与锁顺序

Result/回填发现使用不存在 TRUE 父行的 `NOT EXISTS`，不要求存在 FALSE 父行。
既有普通 journal-only fixture 和生产路径可以没有公开 Session。快照发现不能
作为写入权限。

回填采用候选发现 → 当前 TRUE 探测 → 精确 head FOR UPDATE → 当前检查点复核。
领取/失败采用持久目标发现 → 当前探测 → 精确 result FOR UPDATE → 当前身份及
状态复核。不能先锁 head/result，再等待原生 parent→head writer 持有的父行。

完成保持既有 retention 顺序：真实 result 发现 → retention tenant → 当前
TRUE 探测 → journal head → publication → 公开 Session → result。私有拒绝
回滚该事务可能做过的 tenant upsert。完成流程内部失败结算复用已资格校验的
锁定行，不在取得子锁后重新取得父锁或权限域。更新仍绑定锁定的持久身份及领取代际。
Complete 通常拥有自己的事务。若在已有 Spring 事务中调用，私有拒绝会将参与的
事务标记为 rollback-only；外层所有者须回滚，不能提交其他写入。

回填拥有 scheduler 的短事务：入口在任何发现、锁或写入前拒绝已有 Spring
事务。保留默认 REQUIRED，不使用 REQUIRES_NEW 挂起仍持有 head 的外层所有者。
回填 catch 在回滚后开启新事务，先探测再锁 head，并核对失败 scope/检查点仍
符合条件才写 `invalid_journal`。私有拒绝不是无效 journal；旧 catch 不能覆盖
另一 worker 已推进的检查点。

Projector 预检仅是短事务，对象 I/O 不跨数据库事务。它拒绝已持久的私有目标；
不认证普通孤立 journal 在预检后被并发私有 CREATE 替换的竞态，也不持有终身
读取准入屏障。读租约准入竞态须由后续 retention/读取回调及完整 application cut
证明收口。

## 验证与验收

实现前由只读 test-engineer 检查全局 `qwen` CLI 的可达边界，再用已构建 Java/JDBC
fallback 复现。使用真实私有 CREATE 和当前 Flyway schema。明确标记人为构造的
历史 legacy 任务为 fixture，而非原生成员权限。记录原进程退出码、原表快照及
source/product hash。

本轮验收要求：

1. 具体基线 claim/fail/backfill/action 写入；修复后私有目标完整表无写观察及
   混合普通对照。
2. 私有 PENDING/RETRYABLE/LEASED 积压不能占满有界筛选；已有终态/READY 历史
   也保持原样。
3. 伪造调用方/持久 Source scope 不能写私有 result 或启动其读租约/GET；普通
   source 冲突也不做 I/O 或写入。
   私有 complete 还须回滚原本将新增的 retention tenant 行；普通 retired/lapsed
   分支在结算前校验锁定 Source。
4. 普通 journal-only 回填、前页 digest 错误的持久检查点、租约过期、policy
   变化、缺失 publication/turn 和旧代际保持既有结果；普通 action 响应及重放可用。
   外层已有事务的回填在任何写入前拒绝。
5. 配置 result hook 的原生 receipt 提交及重放保留原持久 receipt/history/resource
   精确值，不创建旧 result。原生非 action 回调可用，实际私有 action 回调拒绝。
6. 专属 MySQL RC、历史 result 已可见时的预热 RR 当前父行争用、parent→head/result 锁顺序观察和普通
   并发领取单赢家。仅 H2/mock 不足以证明这些性质。
7. 相关 Java 测试、Checkstyle/SpotBugs、仓库 build/typecheck/bundle、连续两次
   干净自审及最终候选独立只读审查。原生 review 不可用时单独说明，不制造批准。

独立观察证据封存，仅清理明确拥有的 fixture 资源。各结果绑定精确观察候选及
产物；重新打包后的字节不能沿用旧云上验收。更新同一个 Draft PR 并附独立 E2E
报告，完整 K2 目标保持 active。

### 已观察的本地结果

候选通过仓库 build/typecheck/bundle 和完整 Managed Agent 验证：131 个 suite，
1645 通过、1 跳过，零 failure/error，Checkstyle/SpotBugs 无问题。独立
test-engineer 观察了专属 MySQL RC/RR 四次测试及打包 JDBC 十一组；私有回调
保持完整 57 表不变，普通对照只推进预期表。

独立的真实原生 read-file turn 配置了实际 JDBC result hook。旧基线新增一个
旧 result，候选不新增。两者原 receipt 和原 wire 精确重放均为 HTTP 200，
各有两次 provider 请求；候选 receipt 边界仅推进原 journal/resource/ref/head，
重放时完整 57 表不变。不通过 result fixture 或伪造 `csiOriginal` 补建原生权限。

先前 fixture、序列化及隔离副本 setup 失败保留原非零退出码。成功观察器补齐
复制的 CLI 产物、实际 package 依赖查找及独立 fixture helper 类，登记实际加载
来源，但不是 hermetic 依赖构建。合成 Kubernetes/attestation、MockMvc、固定 SSE
和 Darwin mount 接缝仍明确保留。这些结果不证明终身读取屏障、新目标 Linux/云上
运行、物理释放或完整 K2 验收。

## 影响文件

生产目录 `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/`：
`ManagedAgentStore`、共享旧写入 guard、`ManagedSessionStore`、
`ManagedToolResultStore`、`ManagedToolResultProjector` 和 `ManagedActionStore`。
针对性测试覆盖这些 store 与普通 publication/action 集成。双语设计及 ignored
E2E 计划记录范围和独立证据。

## 后续未决工作

完整原生成员清单必须纳入被冻结的旧 result/action 历史。关闭这些 writer 不能
单独证明不可变 application cut 或聚合 DRAINED。Retention 读取准入/回调及
退役/collector 写入须在各自事务资格校验；随后完成物理停止/unpublish、
release/复用、Linux/云上及安全/可移植性验收，才能完成 K2。
