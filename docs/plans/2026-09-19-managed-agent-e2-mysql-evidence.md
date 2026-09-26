# Managed Agent E2 本地 MySQL 与双 JVM 故障注入证据

状态：本地 Command Slice 通过；E2 整体部分通过

验证日期：2026-09-19（Asia/Shanghai）

关联方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

前置证据：[E1 官方 SDK 契约冻结](./2026-09-19-managed-agent-e1-contract-evidence.md)

## 1. 本轮结论

本轮在本机真实 MySQL 26.7.0/InnoDB 上完成四组门禁：

- 两个独立 JVM 同时结算同一条 `UNKNOWN` Tool execution，只有一个 JVM 成功，另一个稳定得到
  `runtime_broker_resolution_conflict`；
- 两个独立 Spring 事务代理和连接池竞争同一 Command Ledger 幂等键，赢家提交后失败方返回同一条
  ledger；同 key、不同 digest 不覆盖原记录；
- 两个独立 Spring Boot/Tomcat HTTP JVM 通过生产 OpenAI Controller、Mapper、Exception Handler、
  `AgentSessionCommandServiceImpl` 和 MyBatis Command Ledger 访问同一 MySQL；相同请求同时返回 200 和
  同一 Session，异 digest 返回 409，其他 tenant/operator 猜测 Session 返回 404；
- 在 admission 提交前、提交后/dispatch 前、dispatch 后/HTTP 返回前三个确定性窗口暂停 owner JVM 并
  强制退出，再由 survivor JVM 用相同请求恢复；三个窗口最终都只有一条 ledger、Session、binding、
  Turn 和幂等 dispatch 记录。

组合门禁执行 14 个测试，0 failure、0 error、0 skipped。测试使用随机业务 ID；专用临时 schema 和
临时 MySQL 用户在执行后均已删除，并通过 `INFORMATION_SCHEMA` 和 `mysql.user` 复查为 0。

这仍不等于 E2 整体通过。HTTP 双 JVM 使用的是“最小产品 Command Slice”，不是完整
`LspApplication`，也没有经过负载均衡、真实登录鉴权或生产 BFF。Turn、Item、Artifact 和 cursor 的
跨租户猜测尚未做。生产开关必须继续保持关闭。

## 2. SQL 与 HTTP 证据

并发场景的外部结果和最终 SQL 快照为：

| 断言                                    | 结果                                 |
| --------------------------------------- | ------------------------------------ |
| JVM A / JVM B 相同请求                  | `200 / 200`，返回同一 Session ID     |
| 同 key、异 digest                       | `409 agent_api_idempotency_conflict` |
| 其他 tenant / operator 查询             | `404 / 404`                          |
| 最终 ledger / Session / Turn / dispatch | `1 / 1 / 1 / 1`                      |
| 最终 ledger 状态                        | `DISPATCHED`，version `2`            |
| 公共响应泄露内部拓扑                    | 未出现 Harness 或 Runtime endpoint   |

三个进程退出窗口的可见 SQL 状态为：

| kill 点                        | kill 前 ledger | kill 前 Session/Turn/dispatch | survivor 恢复后                                                |
| ------------------------------ | -------------- | ----------------------------- | -------------------------------------------------------------- |
| `BEFORE_COMMIT`                | 0 行           | `0 / 0 / 0`                   | 新 admission；最终 `DISPATCHED`，各 1 行                       |
| `AFTER_COMMIT_BEFORE_DISPATCH` | `ADMITTED` v1  | `1 / 1 / 0`                   | 保留原 Session；最终 `DISPATCHED`，各 1 行                     |
| `AFTER_DISPATCH_BEFORE_RETURN` | `ADMITTED` v1  | `1 / 1 / 1`                   | 保留原 Session；幂等重放后仍各 1 行，ledger 为 `DISPATCHED` v2 |

每次运行都会把所选 SQL 行、HTTP 状态和两侧进程日志写到 Git 忽略目录：

```text
copilot/agent/target/managed-agent-e2/command-concurrency.json
copilot/agent/target/managed-agent-e2/command-recovery.json
copilot/agent/target/managed-agent-e2/*.log
```

SQL 快照不包含数据库凭证、Runtime token、endpoint 或用户真实 Prompt。

## 3. 故障注入发现并修复的生产问题

### 3.1 Repeatable Read 旧快照

原 `AgentApiCommandLedgerRepository.findOrCreate` 使用数据库默认 Repeatable Read。失败方先建立“无记录”
快照，赢家提交后，失败方虽然命中唯一键冲突，却仍在旧快照内看不到赢家，最终泄漏
`DuplicateKeyException`。

修复将 Command Service 的五个事务入口和 `findOrCreate` 显式设为 Read Committed。Repository 会加入
外层事务，因此服务层也必须显式设置隔离级别。H2 不能覆盖这类 MySQL 快照语义，真实 MySQL 门禁必须
保留。

### 3.2 after-commit 回调中的非持久 ledger 更新

故障窗口还复现了第二个问题：Spring `afterCommit` 回调执行时，原事务资源仍绑定在线程上。在回调中
直接 dispatch 并更新 ledger，不能保证 ledger 状态在独立事务中提交；外部 dispatch 已发生时，ledger
可能仍停留在 `ADMITTED`。

修复增加独立的 `AgentApiCommandDispatchCoordinator` Bean，以 `REQUIRES_NEW + READ_COMMITTED` 执行
dispatch 和 `ADMITTED -> DISPATCHED` CAS。`AgentSessionCommandServiceImpl` 的 after-commit 回调只调用
该代理 Bean。`AFTER_DISPATCH_BEFORE_RETURN` 现在明确证明：外部副作用已持久、ledger 仍为
`ADMITTED` 时杀进程，survivor 可依靠相同 Turn ID 幂等重放并把 ledger 推进到 `DISPATCHED`。

该语义是“至少一次派发 + 下游幂等”，不是对任意外部 Tool 的天然 exactly-once 承诺。真实 Tool 仍必须
以 `executionCallId` 去重。

## 4. 可重复执行

先在专用测试 schema 中允许脚本创建正式 ledger/runtime 表和 E2 辅助表，再以环境变量注入专用账号；
脚本只校验变量是否存在，不打印凭证：

```bash
export MANAGED_RUNTIME_MYSQL_TEST_SCHEMA_ACK=dedicated-test-schema
export MANAGED_RUNTIME_MYSQL_JDBC_URL='jdbc:mysql://127.0.0.1:3306/<dedicated-schema>'
export MANAGED_RUNTIME_MYSQL_USERNAME='<dedicated-user>'
export MANAGED_RUNTIME_MYSQL_PASSWORD='<hidden>'
bash scripts/run-managed-agent-mysql-gates.sh
```

门禁固定执行：

```text
ManagedRuntimeRepositoryIntegrationTest                         8 tests
AgentApiCommandLedgerRepositoryIntegrationTest                 4 tests
AgentSessionCommandConcurrencyIT                               1 test
AgentSessionCommandRecoveryIT                                  1 test
```

本轮结果：

```text
Tests run: 14, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
ephemeral_schema_remaining=0
ephemeral_user_remaining=0
```

## 5. 完整产品启动边界

本轮也尝试从当前机器构建并启动完整 `LspApplication`。离线构建缺少缓存的内部
`com.aliyun.dataworks:language-*` 依赖，默认 Maven Central 又无法解析内部 parent
`com.aliyun.dataworks:dataworks-parent:0.30.1`；本机没有可用的内部 Maven `settings.xml`。因此完整产品
JVM 没有在本机启动。这是环境前置条件缺失，不应被描述为完整产品已验收，也不能用最小 Command Slice
替代。

## 6. E2 剩余验收

- 提供内部 Maven settings 和依赖后，启动两个完整产品 `LspApplication` JVM，经同一负载均衡入口重复
  上述同/异 digest 与三个 crash window；
- 用两个真实 tenant/operator 猜测 Session、Turn、Item、Artifact 和绑定了查询条件的 cursor，确认全部
  fail-closed；
- 保存负载均衡入口的请求/响应、两个完整 JVM 日志、SQL 前后快照和鉴权审计信息；
- 验证完整产品进程退出后调度器接管、SSE 与后台 Turn 生命周期不依赖原 HTTP owner。

以上项目全部完成后，E2 才能从“部分通过”改为“通过”。
