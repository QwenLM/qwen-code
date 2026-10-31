# 从原始 journal 对账停车的 Turn 取消

[English](2026-10-20-managed-cancel-evidence.md) | [简体中文](2026-10-20-managed-cancel-evidence.zh-CN.md)

## 问题与现状

本实现承接 #14166 与 #12380 下的 #14700。该改动在原始 Turn 因无法观察到的执行而失败时，把 CANCEL 保留为 `recovery_blocked` / `cancel_unconfirmed`，并刻意让该 operation 留在对账扫描之外。公共 CANCEL 的承诺仍强于任务取消：完成意味着 Turn 已达到 `cancelled`，而不只是接受停止请求。

Hosted cancel handler 先中断活动 Turn，再追加 `requestCancel`，后者以 `hosted-cancel:<promptId>` 为键，内容摘要为 prompt ID 的 SHA-256。因此，该请求事务不足以证明取消成功，即使 journal 已关闭，其缺失也不能证明取消没有生效。Session authority 用 `turn.settled` 事件记录最终结果，其 `eventId = turn:<promptId>`，且 `payload.turnId` 为 prompt ID。外层事务是 `settleTurn`；command ID 为 recorder UUID，因此无法按 prompt 派生的 command hash 查找。

## 改动与决策

`CancelEvidence` 加入现有的 acceptance-evidence 注册表，`CANCEL` 加入停车 operation 扫描。它在对应租户和 Session 范围内解析原 operation 的不可变 Turn 目标，校验目标身份的 hash，再读取该 Session 的 managed journal。它从不加载、连接、调用、取消或重新执行 Harness 或 Runtime。

读取器从 managed Session head 固定 journal revision 上界，向后逐页读取 `settleTurn` 事务，每次只读一个事务。它校验事务的编码、长度和 SHA-256，并匹配终态事件的 subtype、event ID、prompt ID、租户、Workspace 和 Session。原 Turn 只提供身份；当前 status、epoch 和失败码不参与裁决。其他 prompt 的结果或携带不同 scope 的事件，均不是本 operation 的证据。

| 原始 prompt 的持久证据                                  | 裁决及 operation 结果                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `turn.settled` 且 `outcome = cancelled`                 | 已提交：完成为 `harness_confirmed`、`confirmed`，并生成 receipt。          |
| `turn.settled` 且 `outcome = completed` 或 `error`      | 未提交：以 `turn_already_settled` 失败，保持 `java_durable` 和 `blocked`。 |
| 没有匹配的终态事件、outcome 不受支持，或历史不可读/损坏 | 未知：保留 `cancel_unconfirmed`，等待现有的五分钟重查。                    |

单独的 `requestCancel` 记录仍属于未知。对于 `ACTIVE`、`SEALED`、`DELETING` 和 `DELETED` head，历史缺失均仍属于未知。压缩绝不把缺失变成否定证明；仍被保留的正向终态证据依然有效。CANCEL 命令原本就按 Turn 合并，因此在同一 Turn 失败前停车的所有取消都可以从其唯一的权威终态事件得到裁决。Java 记录终态失败后才提交的取消保留 #14700 的确定性迟到命令结果，绝不重新分类。

结算复用现有的停车 operation 条件更新，不能改写扫描后已经结算的 operation；服务重启不需要内存状态。Java Turn 已公开的恢复失败保持不变；本次对账把随后可以证明的取消结果补到原命令 operation 上。它不宣称其他待定 Runtime 执行已经变得可知，也不授权清理或存储释放。

## 文件与范围

实现新增 `CancelEvidence`，扩展 managed store 现有的 acceptance-unknown 种类集合，并通过现有 Turn-command H2/InnoDB 套件验证读取与结算。Public 和 WebShell 契约说明补充该证据路径；不改路由、字段、schema migration、投递机制或客户端行为。英文、中文设计与生成的契约注释保持同步。

本 PR 是基于当前 `main` 的增量读取器，#14700 是必需的合入前置。该单独评审的改动提供停车生产者；本 PR 仅提供证据读取器及扫描接线。SQL 测试直接构造作为依赖契约的持久停车 CANCEL 形态，不把生产者复制进本 PR。读取器对 #14700 产生的行或兼容的既有数据生效。通用 journal 压缩、记录不同的取消命令身份、物理 Runtime 准入，以及改写已经公开的 Turn 历史，均不在本次范围内。

## 验证与验收

E2E 计划位于 `.qwen/e2e-tests/managed-cancel-evidence.md`。先检查全局安装的 CLI，但该 CLI 不暴露 Java operation reconciler，因此采用确定性的 Java/SQL 测试脚本替代，覆盖真实命令准入、停车行、journal 字节、证据读取及持久结算。同一组测试在 H2 和一次性 MySQL 8.4 InnoDB 数据库上运行。

验收要求：匹配的取消结果恰好结算原 operation 一次；completed/error 结果诚实地令其失败；未知、损坏、外域和被压缩移除的证据保持停车；合并的取消分别结算且不产生第二次副作用；迟到取消及其他 operation 种类保留原有行为。Java 模块验证、公共契约门禁、生成 WebShell 契约校验及相关 Hosted 恢复检查，必须与完整部署验收分开报告。

## 风险与开放问题

recorder UUID 要求扫描原 Session 的结算事务。内存以一个现有 journal 事务为界，但扫描工作量随保留的 Turn 历史增长。未来可通过持久事件索引优化查找成本，同时保持身份校验。被压缩移除的终态事件目前不能从 snapshot 证据恢复，因此仍保持停车；绝不把缺失猜成最终结果。本切片没有未决协议决策。生产环境崩溃/强杀验收仍是独立的必需验证结果，不能由 SQL fixture 推断。
