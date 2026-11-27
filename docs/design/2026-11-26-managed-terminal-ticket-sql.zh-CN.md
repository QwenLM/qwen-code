# Managed 终端 ticket 存入 SQL

[English](2026-11-26-managed-terminal-ticket-sql.md) | [简体中文](2026-11-26-managed-terminal-ticket-sql.zh-CN.md)

状态：实现设计，2026-11-26。现状结论对照 `main` 的 `9450cff30a` 核实。本文是"多个 Java 控制面实例挂在负载均衡后面"的其中一个切片，只改变终端 ticket 的存放位置。终端本身沿用 [Managed Web Terminal 设计](2026-11-10-managed-web-terminal.zh-CN.md)。

## 1. 问题与现状

浏览器无法在 WebSocket 上设置部署要求的认证头，所以 Web 终端分两个请求完成：已认证的 `POST /api/agent/web-shell/v1/sessions/terminal-ticket` 执行完整的终端准入并返回一个一次性 ticket；随后 WebSocket upgrade 把这个 ticket 作为 bearer 子协议提交。

`TerminalTicketStore` 把 ticket 存在进程内的 Map 里，每个 ticket 都携带完整的已准入 `RuntimeBindingRecord`，其中包括 worker 的 lease token。多个控制面实例挂在负载均衡后面时，这两个请求可能落到不同实例上；upgrade 所在的实例从未见过这个 ticket，于是失败。

## 2. 目标与范围

目标：

- 共享同一数据库的任意实例，都能消费另一个实例签发的 ticket。
- 保留现有的全部性质：每个 ticket 只对应一个 Session、一个 terminal 和一个 binding；有效期 30 秒；只能成功消费一次；容量不足时返回带类型的 503，并有每租户份额。
- 不以明文持久化 ticket 或 worker 的 lease token。

不纳入：其余多实例问题（跨实例 SSE、派发租约使用数据库时钟、Harness attachment、Broker Runtime Session）、ticket 与 upgrade 的线上契约、终端准入规则。

## 3. 设计

### 3.1 表

V1 基线新增 `ma_terminal_ticket`，字段为 `ticket_hash`（SHA-256 十六进制，唯一）、`tenant_id`、`session_id`、`terminal_id`、`binding_id`、`binding_generation`、`expires_at` 和 `gmt_create`，并在 `expires_at` 上建索引。按发布前的 schema 策略，直接修改基线，不加 V2 迁移，也不改 schema 版本。

### 3.2 签发

1. 删除已过期的行。
2. 用一条查询同时统计全部存活行和该租户的存活行；总数达到 1024 或该租户达到 256 时，返回 503 `terminal_ticket_capacity`。
3. 插入新行，`expires_at` 取数据库时间加 30 秒。

每条语句各自提交。因此清理语句在过期索引上持有的范围锁，不会在其他签发者插入时仍被持有，避免了"清理和插入在同一事务里"可能引发的 InnoDB 间隙锁死锁。

### 3.3 消费

先按 `ticket_hash` 读出该行，再执行 `DELETE ... WHERE ticket_hash = ? AND expires_at > <数据库当前时间>`，只有恰好删除一行才算消费成功。行从不更新，所以先读出的那一行就是成功删除的那一行。不同实例上的并发消费者在这条删除上竞争，只有一个能成功。

### 3.4 upgrade 时重新读取 binding

ticket 只用 `binding_id` 和 `binding_generation` 标识 binding，不再携带整条记录。消费 ticket 之后，upgrade 通过 `WorkspaceTerminalRelayService.terminalBinding` 重新读取该 Session 的终端 binding，并执行与准入时相同的检查：web terminal 开关、READY、未在 drain、有 lease、终端能力摘要。binding 不再满足条件，或者其 identity 或 generation 与 ticket 不一致时，返回 409。upgrade 不重新执行 Session 和 Workspace 的权限检查，仍以签发 ticket 时的准入为准。

## 4. 设计决策

| 决策                | 选择                                        | 理由                                                                         |
| ------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| ticket 落库形式     | 只存 SHA-256 哈希                           | 读取数据库永远拿不到可用的 ticket。                                          |
| ticket 中的 binding | 只存 identity 和 generation，upgrade 时重读 | lease token 不能持久化；binding 变化后改为直接拒绝，而不是连到过期的 lease。 |
| 时钟                | 数据库时间（`ManagedSchemaTime.SQL_NOW`）   | 实例时钟偏差不会延长或缩短 ticket 的有效期。                                 |
| 容量上限            | 在 SQL 中计数，不串行化                     | 集群级上限；并发签发最多超出"并发请求数"，仍然有界。                         |
| 过期行              | 每次签发时清理                              | 不需要新的调度任务；残留行数受上限约束。                                     |
| 存放位置            | 保留在 `server` 模块中，作为具体类          | 只有一个使用方，不为单一用途引入接口。                                       |

## 5. 风险与约束

- 如上所述，容量在并发下变成软上限；此前在单进程内是精确的，但会随实例数成倍放大。
- ticket 现在可以跨控制面重启，在剩余的 30 秒内继续有效。upgrade 会重新检查 web terminal 开关和 binding，所以关闭终端或替换 binding 的重启仍然会拒绝它。
- 每次签发和 upgrade 都会在共享数据库上多执行几条走索引的语句。

## 6. 验证与验收

- H2：ticket 只能消费一次，包括同一数据库上的第二个 store；只存哈希；过期按数据库时间判断；签发会清理过期行；每租户和总量上限都返回带类型的 503。
- upgrade：binding 已变化、或 binding 不再允许终端时，返回 409；现有的路径、terminal 和 ticket 检查仍分别返回 400、401 和 404。
- 真实 MySQL 8.4（`TerminalTicketStoreMySqlIT`）：同一个 ticket 同时提交给多个实例时只有一次 upgrade 成功；并发签发者在清理过期行时不会死锁。
- schema 契约测试列出新表、它的业务键和时间列。
