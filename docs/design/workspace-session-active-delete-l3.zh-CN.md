# ACTIVE Workspace 会话的可靠删除（L3）

[English](workspace-session-active-delete-l3.md) | [简体中文](workspace-session-active-delete-l3.zh-CN.md)

## 1. 状态与范围

已在 `codex/workspace-session-l3` 本地实现，2026-10-03，Linux 实体验收仍待完成。本文实现
[#13164](https://github.com/QwenLM/qwen-code/issues/13164) 的 L3，基于 main 已合入的
可靠 close #13135、L1/L2 #13194、O4 退役 #13084 和 H2 Hooks #13129。
通过既有公开和 WebShell 路由接纳空闲的 `hosted-workspace-files/1` 会话删除。
Shell/MCP profile、按钮、物理擦除、新角色和放弃 unknown 副作用不在范围内。

| 操作                   | 生命周期 Hook                | 结果                         |
| ---------------------- | ---------------------------- | ---------------------------- |
| ACTIVE close           | SessionEnd                   | CLOSED，保留数据             |
| ACTIVE delete          | SessionEnd，再 SessionDelete | 可靠停机，原子退役与 DELETED |
| CLOSED/ARCHIVED delete | 不运行，也不补跑 Hook        | 既有 L2 元数据删除           |
| Detach                 | 不运行                       | 清理 attachment              |

mutation 仍要求当前可读的创建者。已接纳、运行中、取消中或等待审批的 Turn
返回 `409 turn_active`。幂等、actor 隔离和墓碑可见性沿用 L2。
运行一次指复用已提交结果，不重新派发可能已开始的尝试，不承诺最终一定完成。

## 2. 协议与证据

新增私有 `POST /session/:id/lifecycle`，携带 Session scope、operationId、
kind（`close` 或 `delete`）和 claimGeneration。它只结算所需 Hook，返回已提交
H2 记录的引用；Java 接受这些副作用前保留 attachment、writer 和 owner。
Java 核对权威 Session Store 记录，HTTP 成功本身不是证明。

operation 保存生命周期协议版本和中间 effects receipt。回执将 Session 和操作
身份绑定到所需事件的 occurrence、plan、已提交结果引用，或经过核验的无 Hook
证据。公开 receipt_id 仍仅在最终完成时生成。

该回执不能替代 worker 停机证明。最终完成检查永久围栏、writer 排他、全部原
Runtime 资源及匹配 binding/generation/handle 的停机证明。RELEASED 本身不足；
历史 binding 缺少可核验的 stop 或 never-started 证据时阻塞。

公开路由和 202 operation 响应不变。对支持的 ACTIVE files 会话独立宣告
session_delete/sessionDelete，不联动 archive/unarchive。capability 表示支持，
不表示授权或空闲状态。聚合 session_lifecycle 保持原值。

## 3. 执行与恢复

准入一起保存 CLOSING/DELETING 和持久 LIFECYCLE_ONLY 围栏，禁止普通 warm、
acquire、工具执行、输入和其他控制 mutation。仅当前 operation 与有效 claim
可以在原 Workspace scope 获取生命周期 writer 和执行权限。该权限仍要求
私有认证和当前执行授权。使用既有锁层级消除授权与执行准入之间的竞态。

先结算此前操作，通用取消不得包含本 operation 的生命周期 occurrence。
稳定 occurrence ID 由 Session、operation、事件派生，复用 H2 的 catalog、plan、
dispatch intent 和结果。SessionEnd 的全部子执行提交结果后才开始 SessionDelete，
包括异步 Hook；只有 plan marker 结算不足。冷加载只恢复
保存状态，不创建用户 Turn 或 startup Hook。复用可核验的原 Runtime，不用替代
代际重放副作用。仅从未创建 Runtime 且授权有效时允许首次初始化。

每次新副作用派发前核对当前 ACL、挂载和身份。撤销后仍可查询、结算已派发工作；
未派发 Hook 保持 recovery_blocked，直至恢复权限。unknown 保留所有权，不能
变成取消或完成证明。沿用 H2 可能无限期阻塞的限制，独立由 #13133 跟踪。

plan 和子执行派发前均预检权限，并在 journal 提交事务中重新检查。明确的事务
授权拒绝不消耗 journal sequence，writer authority 可继续重试。应答丢失，或
不确定请求后再收到拒绝，仍保留写入失败围栏。

核对并保存 effects receipt 后，围栏单向升级到 DRAINING。不运行 Hook 地 detach，
释放 owner、seal writer，再使用可靠 close 的 drain/stop 协议。接管者在 effects
receipt 已保存时跳过 Hook，否则从相同 H2 occurrence 恢复进度。Harness 404、
租约过期或 worker 消失均不能证明完成。

最终完成要求有效 delivery claim、effects receipt、永久围栏、无有效 writer 或
未结算执行，以及可核验的原停机证明。CLOSE 提交 CLOSED；DELETE 原子提交 O4
退役、DELETED、operation 完成与终止事件。共享文件及其他会话的 holder 保留。

从未初始化的会话按 writer 顺序取得 tenant-retention、公开 Session 和 journal
head 排他，证明无已完成 bootstrap、有效 writer、journal 或 Hook 派发记录，
再保存 never-initialized 无 Hook 证据。有 header 时核对原 definition/catalog。
两种情况都必须在永久围栏之后检查完整 Runtime binding 集合。

## 4. 兼容与启用

新增迁移，保留 V32。升级前已接纳的操作沿用原协议与证据，不产生新 Hook 身份。
仍存活的 protocol-zero close attachment 仅在持久 close claim 有效时保留原 DELETE
和原 Hook control 路径。普通执行继续被围栏阻止；此例外不能授权 L3 或 MCP 执行。
启用 L3 准入前升级全部 coordinator 和 Harness。缺少新协议能力时拒绝准入，
不回退到旧 DELETE。存在未完成 L3 操作时不回滚到旧 coordinator。
L2 CLOSED/ARCHIVED 删除继续独立于 Harness 可用性。

实施顺序：协议与围栏；限定权限和回执；close 语义；ACTIVE delete 准入与
capability；恢复验证。同步 canonical OpenAPI 和相关中英文设计。

## 5. 验证与验收

覆盖两个 HTTP 入口、重放与 actor 隔离、全部活跃 Turn 状态、空会话、无 catalog
与空 Hook plan。断言 close End=1/Delete=0、ACTIVE delete End=1/Delete=1、
detach/L2 Hook=0。在 dispatch、结果提交、receipt、detach、stop 和墓碑边界
注入应答丢失与崩溃。第二服务接管不能重复副作用，旧 claim 不能推进。

覆盖两个 Hook 之间撤销 ACL/挂载及恢复、unknown、身份无法核验、历史缺失停机
证明和普通执行准入竞态。真实 MySQL 验证事务回滚与并发。真实 Linux 验证
Harness/worker、host/boot/PID 身份、共享文件和邻居 holder 保留。
模拟与物理验证分别报告。

执行 build、typecheck、bundle、定向 TS/Java 测试及 E2E 计划，再完成两轮干净
自审和独立评审。结果和环境限制记录在
`.qwen/e2e-tests/workspace-session-active-delete-l3.md`。
