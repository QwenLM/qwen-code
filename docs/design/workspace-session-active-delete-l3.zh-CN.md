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

### 为什么不能先 close 再执行 L2 delete

可靠 close 结算 SessionEnd 后永久停止原 Runtime；CLOSED/ARCHIVED 的 L2 删除
明确不运行 Hook。组合两步无法在 End 之后、停机之前，用原 Runtime 结算
SessionDelete。启动替代 worker 补跑 Delete 又会违反禁止重放的边界。L3 复用
可靠 close 的停机机制和 L2 的原子退役事务，在永久 draining 前结算两个所需
事件。单个 delete operation 在恢复期间持续保持 DELETING，不先公开完成一个
CLOSE，再尝试无关的 L2 operation。effects receipt 让接管者跳过已提交 Hook
结果，不把 Harness 消失或 HTTP 应答当成完成证明。

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

placement guard 先于 retention、Session 和 journal 锁。仅检查 journal head
或尚不存在的围栏行不能排除并发插入围栏；writer 变更和普通执行授权必须共用
准入的锁顺序。工具结果 receipt 在原结果、publication 租户和 journal 锁之前
获取 placement guard，receipt 重放也遵循此顺序，避免嵌套 journal commit
反向获取 placement 锁。离线 storage 迁移（包括 ABORTED operation 重放）与同租户
其他 Session 的清理授权使用相同的 placement 先于 retention 顺序；不放宽迁移
要求 writer 已停止且不新增派发的前提。普通 journal 事务在尚无不确定提交响应前收到明确的
`workspace_lifecycle_admission_closed` 回滚拒绝时，不会使缓存 Session 永久停写；
后续结算仍须有效的当前 lifecycle authority。若此前已有不确定响应，仍保留
写失败围栏。L3 之前的 Store 已经通过 Session 锁 helper 获取 publication
租户锁；新增的是 placement guard 和普通授权请求，其增量竞争和请求开销需要
测量。围栏查询和变更使用既有哈希主键，同时保留原身份检查，避免锁定读取扫描
其他租户的围栏；键编码与 Broker 共用，不新增索引。
这保护所有 hosted attachment 的持久会话准入，包括没有本地 lifecycle
状态的 attachment，不代表所有会话都支持 L3 删除。明确的 Store 生命周期围栏
拒绝返回 409；意外 Store、传输或 writer 权限故障返回 503，均不放行执行。
已接纳 Turn 的认证取消是本地 abort，不要求普通 Store 授权；本地生命周期围栏
仍禁止取消生命周期操作。protocol-zero close 保留限定的例外。
普通 attachment mutation 在 Store 授权或 writer 续租前核验 client 身份；
legacy close 控制路由保留明确的缺失 client 例外。生命周期 claim 使用数据库
毫秒时钟，其不可重试 409 穿过 Broker 边界后保持不变。DELETE 若在并发 CLOSE
完成前被分类，仍按加锁后的 Session 状态重新分类，保留 CLOSED/ARCHIVED 的 L2 删除。

先结算此前操作，通用取消不得包含本 operation 的生命周期 occurrence。
稳定 occurrence ID 由 Session、operation、事件派生，复用 H2 的 catalog、plan、
dispatch intent 和结果。SessionEnd 的全部子执行提交结果后才开始 SessionDelete，
包括异步 Hook；只有 plan marker 结算不足。冷加载只恢复
保存状态，不创建用户 Turn 或 startup Hook。复用可核验的原 Runtime，不用替代
代际重放副作用。仅从未创建 Runtime 且授权有效时允许首次初始化。
Plan 身份使用固定的紧凑 JSON 字节，不受应用 JSON 格式化配置影响。
恢复遇到在途、失败或已取消的本地 Session 路由时直接拒绝，
不等待普通 acquire，也不传播其结果。

接管者的 lifecycle load 只有在规范化 Store descriptor 与原 grant 完全一致、
且 Store 接受原 writer 上的当前 claim 后，才可复用已存在且空闲的 files attachment。
应答返回原 client 身份，不重新打开 Session 或重放 Hook。busy、外来身份或 claim
拒绝均保留原 attachment 与此前权限。返回本地生命周期围栏前核验 client 身份，
仍保留明确的 legacy close 例外。原从未派发执行的取消可穿过 drain 围栏结算持久
取消结果，不调用 worker；新派发仍被拒绝。事务中的 typed claim 拒绝保留原 409
code，并回滚全部 journal mutation。确认 lifecycle detach 后仅删除请求前捕获的
attachment 与 prompt 状态；晚到应答不得清除替代 attachment 的心跳或 prompt 水位。

新生命周期 Hook 离开 intent 前，凭已保存的原 binding 与 generation 恢复 Broker
owner。存活的 Harness attachment 不能据此推断重启的 Broker 仍持有原 owner。
原身份核验失败时保留可重试的 child intent，不进行派发；派发前再次核验当前权限。
已有 unknown 结果继续阻塞，不重放副作用。

每次新副作用派发前核对当前 ACL、挂载和身份。撤销后仍可查询、结算已派发工作；
未派发 Hook 保持 recovery_blocked，直至恢复权限。unknown 保留所有权，不能
变成取消或完成证明。沿用 H2 可能无限期阻塞的限制，独立由 #13133 跟踪。

plan 和子执行派发前均预检权限，并在 journal 提交事务中重新检查。明确的事务
授权拒绝不消耗 journal sequence，writer authority 可继续重试。应答丢失，或
不确定请求后再收到拒绝，仍保留写入失败围栏。
围栏核验每次 Hook revision，包括同一提交中的连续 revision：intent 转为可能
已启动的结果须重新授权；not_started_proven 与原已派发工作结果的结算仍可提交。
生命周期结算不得改变已记录的 Runtime 身份。

核对并保存 effects receipt 后，围栏单向升级到 DRAINING。不运行 Hook 地 detach，
释放 owner、seal writer，再使用可靠 close 的 drain/stop 协议。接管者在 effects
receipt 已保存时跳过 Hook，否则从相同 H2 occurrence 恢复进度。Harness 404、
租约过期或 worker 消失均不能证明完成。
明确且同 boot 的 detach 404 停止 SDK attachment 心跳；拒绝和不确定应答仍保留。
receipt 恢复通过既有主键查找精确 occurrence 与 resource，保留原身份和字节校验，
不扫描其他租户，也不遍历历史候选资源。

receipt 恢复可能完全跳过 Harness lifecycle 请求。因此，即使存活 attachment
没有本地 lifecycle 状态，detach 也必须向 Session Store 核验 operation 权限。
Store 授权检查当前 claim、原 writer、已保存的 effects 与 DRAINING 围栏；
claim 被拒绝时保留 attachment 及其原权限。没有缓存 attachment 的接管者凭
当前 claim 直接访问原 Session ID，不为恢复 client ID 加载 Runtime 或派发 Hook。
缺少 authority 时仍要求原 client ID，提供错误 client ID 也会被拒绝。普通 detach
仍须通过普通执行授权。清理授权仅接受原 writer 身份、token 与 generation，
包括已过期或已封存的 writer，且不续租；Hook 派发仍要求 ACTIVE 且未过期的 writer。

通过该清理授权后，停止 activation 续租并封存原 writer，不追加 activation release
记录。过期或已封存的 writer 无权追加；已开始的续租仍受 Store 围栏和 writer seal
约束。历史 activation 可能仍显示 active，不能作为正常释放的证据。完成依据仍为
永久围栏、effects receipt、writer 封存与原 Runtime 停机证明。普通与 legacy close
仍在封存前记录 activation release。

最终完成要求有效 delivery claim、effects receipt、永久围栏、无有效 writer 或
未结算执行，以及可核验的原停机证明。CLOSE 提交 CLOSED；DELETE 原子提交 O4
退役、DELETED、operation 完成与终止事件。共享文件及其他会话的 holder 保留。

从未初始化的会话按 writer 顺序取得 tenant-retention、公开 Session 和 journal
head 排他，证明无已完成 bootstrap、有效 writer、journal 或 Hook 派发记录，
再保存 never-initialized 无 Hook 证据。有 header 时核对原 definition/catalog。
两种情况都必须在永久围栏之后检查完整 Runtime binding 集合。

准入扫描并解析完整 journal，证明不存在已接纳但未结算的 Turn。成本随保留历史
增长，事务期间持锁；尚未证明准入延迟存在固定上界。当前产品仅将 compaction
watermark 初始化为零，没有推进它的生产路径。既有冷恢复也不支持非零 watermark；
L3 返回 `workspace_lifecycle_journal_unverified`。未来 compaction 必须
提供持久 idle-state 证据后，L3 才能接纳这些会话；本 PR 不实现压缩后的恢复。

## 4. 兼容与启用

在已有 V35 工具配置、V36–V39 journal/查询、V40 创建者、V41–V44 CSI/派发、V45 H3 任务 journal、V46 W2 目录切换及 V47 H5 channel route/delivery 以及 V48–V50 W1c storage 迁移/索引/身份迁移之后新增 V51 生命周期迁移，
保留这些迁移和 V32。未合入的生命周期迁移从 V48 顺延为 V51，SQL 内容不变。
主线 `/2` 搜索画像与 L3 共存，但生命周期准入仍仅接受 `hosted-workspace-files/1`。
H5 channel 契约和持久化不启用 channel 执行或生命周期 effects。
W2 目录/revision 操作字段与生命周期协议字段同时保留。
W2 只读探测及结算独立于生命周期 Hook effects、drain 和 detach；Session 行上的准入围栏串行接纳两类操作。
Runtime 解析在实际返回的 scope 中保留生命周期 claim。
W2 准入与提交均先取得 placement 锁,在同租户/Harness 任何 Runtime Session 尚非确认 RELEASED 时拒绝 `session_context_busy`。
Hook owner 可在 Turn 完成后继续保留;其不可变原上下文必须继续供 L3 effects 与释放使用。
邻居 holder 不受影响,不替换 Runtime、不重装上下文;存在性读取增加扫描成本,不保证固定延迟。
本次整合保留 H3 后台 Shell/Monitor 行为，不增加 CSI、Shell 或 MCP profile 生命周期支持。
共享 Harness 仅在 detach 授权成功后关闭 Monitor 唤醒调度器；拒绝 detach 时，存活 Session 及其调度器保持可用。
同步 closing/busy 围栏仍阻止授权等待期间的新唤醒。
G3 代际恢复同样覆盖生命周期结算与 detach。发现新 Harness 代际的调用会清除旧客户端及 attachment，
仍返回代际错误；既有交付重试以相同 operation 与当前 claim 重新协商。
发现错误的调用内不再次派发，不启用普通恢复或 cancellation takeover，不替换原 Runtime，也不清除 unknown 结果。
新 Harness boot 不是原 Runtime 的停机证据；effects receipt、writer seal 与原 handle 的停机证明仍为必需。
升级前已接纳的操作沿用原协议与证据，不产生新 Hook 身份。
生命周期迁移前读取 operation 时，缺少协议列表示历史 protocol-zero；已有 protocol-one 值原样保留。
此投影兼容不授予执行权限，也不绕过 schema 升级。
仍存活的 protocol-zero close attachment 仅在持久 close claim 有效时保留原 DELETE
和原 Hook control 路径。普通执行继续被围栏阻止；此例外不能授权 L3 或 MCP 执行。
旧 claim 的有效性统一比较数据库 epoch 毫秒，不受 JVM、JDBC 与数据库会话时区影响。
先升级全部 Spring coordinator/Store，再升级 Hosted Harness；没有独立的 L3 启用开关。
新 Harness 对接缺少普通执行授权路由的旧 Store 时，会拒绝全部托管 Turn，
包括私有 Session；缺少授权路由不能当作执行许可。
先升级 Store 的混合版本阶段，普通 Turn 仍可用，但 ACTIVE Workspace close 和
delete 暂不可用，直到 Harness 宣告新生命周期能力。部署计划须包含这一暂时的
close 不可用窗口。缺少新协议能力时拒绝准入，不回退到旧 DELETE。
存在未完成 L3 操作时不回滚到旧 coordinator。
L2 CLOSED/ARCHIVED 删除继续独立于 Harness 可用性。

读取生命周期或普通 writer 状态前，先执行已配置的 Store writer 凭证校验。
生命周期加载原样传递签发的凭证及传输策略。cleanup 仍须使用原 writer 和当前
claim；过期或 SEALED 的 cleanup grant 不绕过凭证校验。凭证策略变更可能使恢复
持续阻塞，不能因此创建替代 writer 或 Runtime。

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
