# Hosted MCP 故障门禁 FG12b：存储故障

[English](2026-10-18-mcp-store-fault-gates-b.md) | [简体中文](2026-10-18-mcp-store-fault-gates-b.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的 `mcp_configuration` 与 `mcp_operation` 两个域补故障门禁。本切片在 managed session store 的真实事务边界拒绝写，覆盖记录状态机的每一步：配置的 `intent`；配置与原始操作各自的 `dispatch_started`；响应资源发布之后的 settled 提交；以及 `releasing`、`drained` 与 `released`。

进程崩溃归 FG12c/d。事件流归 FG12e/f；FG12e 并入 FG12f，因此本切片不覆盖流。

## 现状

- extension record 实际在 **`ma_session_record`**（`record_kind = 'DOMAIN'`；legacy 名 `qwen_managed_session_extension_record`），不是 `ma_extension_record`。记录正文经 `record_resource_id` 存在 `ma_resource`；`run.execution` 在该 JSON 里。行上的 `runtime_state` 把 `intent` 与 `dispatch_started` 都投影成 `provisioning`；`releasing` / `drained` / `released` 不是列。
- Harness 通过 HTTP managed session store 提交；Broker 的 `@Transactional` store 写这一行。写被拒时 Harness 看到的是 5xx，HTTP 客户端还会重试 5xx。
- FG12a/c/d 提供打包 Harness、durable worker、stdio fixture、MySQL、Broker 代理与 lifecycle v2。FG12d 是同一个类里的一个 case，不是第二套 rig。

## 门禁账本

| Case                              | 拒绝点                                               | 期望                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store-reject-intent`             | 配置的 `intent` 提交                                 | 线上零 `mcp-configure` 控制，fixture 零副作用                                                                                                                                                       |
| `store-reject-configure-dispatch` | 配置的 `dispatch_started` 提交（owner acquire 之后） | 零控制、零副作用；拒绝前已 acquire 的 owner 记为保留到下一次 detach                                                                                                                                 |
| `store-reject-operation-dispatch` | 原始操作的 `dispatch_started` 提交                   | 零 `mcp-invoke` 控制、零副作用；owner 记为保留到下一次 detach                                                                                                                                       |
| `store-reject-settled`            | 响应资源发布之后的 settled 提交                      | failed commit 回滚暂存的 response/catalog 行；测试先从 durable 状态 dispose/reopen authority（保持原 operation/runtime pins）再驱动后续 turn/close；恰好一次查询；没有第二次 read/get；副作用计数 1 |
| `store-reject-releasing`          | release 派发之前的 `releasing` 提交                  | 下一次 detach 用同一 id **首次派发** `${configurationId}:release`；没有第二次 configure/invoke                                                                                                      |
| `store-reject-drained`            | `drained` 提交                                       | Broker owner 与 storage holder 都保留；不伪造 drain 回执                                                                                                                                            |
| `store-reject-released`           | owner release 之后的 `released` 提交                 | 记录保持 `drained`；下一次 detach 重发 owner release；断言其幂等；该格在 MySQL 8.x 上为绿，钉住这一顺序                                                                                             |
| `store-reject-reload-chain`       | 上述任一拒绝后重试并重载                             | 每个 id 只有一条逻辑记录链；没有重复的 configuration 记录；重试 revision 不是被拒状态的重复                                                                                                         |

## 决策

1. **用测试 store wrapper 在真实事务内注入。** 在 Broker 事务 store 外包一层 `@TestConfiguration` wrapper，按 phase 抛错。MySQL trigger 被否决：行上无法识别 phase。
2. **同一 phase 的所有重试都失败。** HTTP 客户端会重试 5xx；wrapper 保持失败直到测试清除 phase，用例记录尝试次数。
3. **settled 失败要驱动，不会自愈。** 失败从 `install()`/`accept()` 抛出；测试必须驱动一次后续 turn 或 close；代理 wire 必须只有原 id 上一条 `mcp-status`，没有第二次 invoke。persistent 500 会耗尽 HTTP 提交重试并触发 `ManagedSessionAuthority` 的 write-failure latch；之后的命令都抛 `ManagedSessionWritesStoppedError`。测试必须先按原 operation/runtime pins 从 durable session store dispose/reopen authority，再驱动恢复 turn 或 lifecycle reconciliation。
4. **内存暂存不等于持久发布。** `HttpManagedSessionResourceStore.publish()` 只在内存暂存字节；`commitResources()` 把字节嵌入事务，服务端在同一事务里插入 `ma_resource` 行。settled 提交失败会回滚新 response/catalog 行；只有更早提交的资源（intent 时的 arguments）保留。
5. **owner/storage 的保留从对应行读取**，不由 5xx 推断。
6. **新增 `HostedMcpStoreFaultGatesIT` 类**隔离 wrapper；FG12a/c/d 类不动；预算账目与 roster/per-ceiling 元测试在同一 diff 重钉。
7. **`store-reject-released` 钉住当前顺序，且在 MySQL 8.x 上为绿。** `markReleased` 在 `broker.release()` 之后提交；该提交被拒时记录保持 `drained`、owner 已释放，下一次 detach 恰好重发一次同一 release。该格断言这一形态；跳过重发或重发两次的回归都会使其变红。

## 夹具设计

- 复用 FG12c boot；测试 `@TestConfiguration` 提供故障 store wrapper。Harness 看到 5xx（普通 wrapper 异常是 500 `internal_error`；契约拒绝是 409）；JDBC 读记录与 owner/storage 行；代理 wire 计数；fixture 日志计数副作用。persistent 拒绝后，测试从 durable session store 重新打开被停的 authority。
- wrapper 在 teardown 清除 phase；清除失败为 best-effort，不得掩盖用例自身失败。
- 证据落在 `target/fg12-cases/fg12b/<tenant>/`；workflow 已上传 `target/fg12-cases/`。

## 预算

新增类要在同一 diff 重钉共享 fork 账目：逐 case `@Timeout` 上限、`hostedForkHealthySeconds`、CI fork 字面钉点、pom CI fork 与本地 `hosted-mcp-gates` 家族 profile、workflow 注释，以及 `hostedTestClasses` roster / per-ceiling `it(...)`。artifact 根已覆盖 `fg12b`。本地实测并保留 2× 余量；当前共享值从 `hosted-process-ci.test.js` 与 `pom.xml` 读取，不抄进本文档。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 干净。
- 类在 JDK 21 + MySQL 8.x 上绿；每格先自证拒绝生效（wrapper 已触发、尝试次数已记录），再断言期望。
- 至少一条变异见证红：让被拒绝的写成功，跑红后还原复绿。
- `hosted-process-ci.test.js` 绿且预算按实测重钉；双语文档同构。

## 待决问题

- wrapper 只存在于测试 Spring，还是 Broker 需要提供受支持的故障接缝？wrapper 仅测试用，不写产品故障代码。
- `store-reject-released` 的 main 红行为与 owner-release 重试幂等性，必须在承诺该格前核实。
- settled 格与后续 release-retry 格都必须核实从 durable 状态按原 pins 重新打开 authority。
