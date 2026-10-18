# Hosted MCP 故障门禁 FG12b：存储故障

[English](2026-10-18-mcp-store-fault-gates-b.md) | [简体中文](2026-10-18-mcp-store-fault-gates-b.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的 `mcp_configuration` 与 `mcp_operation` 两个域补故障门禁。本切片在真实 MySQL 事务的 store 边界拒绝写，覆盖记录状态机的每一步：配置的 `intent`；配置与原始操作各自的 `dispatch_started`；响应资源发布之后的 settled 提交；以及 `releasing`、`drained` 与 `released`。

进程崩溃归 FG12c/d，事件流断流归 FG12e/f。本切片不引入进程故障，也不在产品代码里加故障分支。

## 现状

- 记录是 `ma_extension_record` 里的 extension record（`mcp_configuration` / `mcp_operation`），由 Harness 通过 managed session store 提交。状态序列是 `intent` → `dispatch_started` → `settled`，以及 `releasing` → `drained` → `released`。
- FG12a/c/d 提供打包 Harness、durable worker、stdio fixture、MySQL、Broker 代理与 lifecycle v2。本切片复用该 rig，只加存储故障注入器，不另搭一套。
- 具体表列与 JSON 路径在实现时核实；下面的账本以 issue 的验收为准。

## 门禁账本

| Case                              | 拒绝点                             | 期望                                                                                 |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `store-reject-intent`             | 配置的 `intent` 提交               | 线上零 `mcp-configure` 控制，fixture 零副作用                                        |
| `store-reject-configure-dispatch` | 配置的 `dispatch_started` 提交     | 零控制、零副作用；没有第二条记录 revision                                            |
| `store-reject-operation-dispatch` | 原始操作的 `dispatch_started` 提交 | 零 `mcp-invoke` 控制、零副作用                                                       |
| `store-reject-settled`            | 响应资源发布之后的 settled 提交    | 一次查询结算原操作；没有第二次 read/get；副作用计数保持 1                            |
| `store-reject-releasing`          | `releasing` 提交                   | 下一次 detach 用原 id 继续 `${configurationId}:release`；没有第二次 configure/invoke |
| `store-reject-drained`            | `drained` 提交                     | Broker owner 与 storage holder 都保留；不伪造 drain 回执                             |
| `store-reject-released`           | `released` 提交                    | 记录保持 `drained`；重载后下一次 detach 只重发 owner release                         |
| `store-reject-reload-revisions`   | 上述任一拒绝后重载                 | 没有重复的记录 revision                                                              |

## 决策

1. **在 MySQL 边界注入，不在产品代码里加故障分支。** test-only `BEFORE INSERT/UPDATE` trigger 读取测试自有的 fault row，命中 phase 时 `SIGNAL 45000`。这样走真实事务回滚；若记录 JSON 路径太脆，回退到 test `@TestConfiguration` 的 store wrapper。
2. **settled 提交失败走一次查询，不重发。** 代理 wire 是见证：原 id 上一条 `mcp-status`，没有第二次 `mcp-invoke`。
3. **`dispatch_started` 之前的失败必须零控制、零副作用。** wire 与 fixture 副作用日志都断言。
4. **owner 与 storage 的保留从对应行读取**，不由 503 推断。
5. **新增 `HostedMcpStoreFaultGatesIT` 类**隔离 trigger 生命周期；FG12a/c/d 类不动；六处 fork 账目在同一 diff 重钉。
6. **teardown 删除 trigger 与 fault row。** 删除失败为 best-effort，不得掩盖用例自身失败。

## 夹具设计

- 复用 FG12c boot。新增测试自有的 fault row 命名 phase；trigger 读取它并 signal。trigger 在 schema migration 之后、session open 之前安装。
- 测试驱动 baseline configure、一次原始操作、close 与 reload；JDBC 读记录；代理 wire 计数；fixture 日志计数副作用。
- 证据落在 `target/fg12-cases/fg12b/<tenant>/`；workflow 已上传 `target/fg12-cases/`。

## 预算

新增类要在同一 diff 重钉六处 fork 账目：类 `@Timeout`、`hostedForkHealthySeconds`、CI fork 字面钉点、本地 `hosted-mcp-gates` 家族 profile、workflow 注释与 artifact 根。本地实测，保留 2× 余量。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 干净。
- 类在 JDK 21 + MySQL 8.x 上绿；每格先自证拒绝生效（trigger 已触发），再断言期望。
- 至少一条变异见证红：让被拒绝的写成功（或移除 store 守卫），跑红后还原复绿。
- `hosted-process-ci.test.js` 绿且预算按实测重钉；双语文档同构。

## 待决问题

- 当前代码是否真的在 settled 提交之前发布响应资源？钉 `store-reject-settled` 前先核实。
- 各 phase 对应的表列 / JSON 路径；trigger 与 store wrapper 的取舍。
- `released` 失败后，下一次 detach 是只重发 owner release，还是也会重复 `${configurationId}:release` 查询？断言前先核实。
