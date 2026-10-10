# K2 原生资源读取的入场与完成记录

[English](2026-10-10-k2-native-resource-read.md) | [简体中文](2026-10-10-k2-native-resource-read.zh-CN.md)

状态：本 owner-read 增量已实现，独立有界候选行为验证完成，包括 writer 到期与
冲突 pin control；原生 review 因配置模型
额度耗尽（HTTP 403）不可用，没有生成审查结论。
当前独立基线 `02d7eabe3b7ca616cd354eb8d1dbec0ef48b28ff`。
历史基线 `f39cf1db9da6489d8d2e0562b15a10214f918da9`。
关联 #12380、#13395 和 Draft PR #13526。整体 K2 尚未完成。

## 问题与现有行为

原私有文件 Runtime 通过 Managed Session HTTP 资源路由恢复资源。路由校验当前
writer，建立通用 retention 租约，读取资源，更新 `last_verified_at`，再删除租约。
租约只保存租户和 Session 的哈希及交付截止时间，没有持久的原 binding、resource、
writer 身份，也没有已完成或未知的 I/O 历史。租约过期和删除不能证明完整的应用 cut。

当前文件 profile 产生 inline 原生资源，不产生 `deferred_v3` publication。
现有 publication 校验还会在已持有 head 的外层事务中调用通用资源 reader。
在那里新增 parent 锁会逆转原生 parent→head 顺序。现有原 CSI deferred-v3 契约
不同于私有文件 profile，必须继续可用。

Hosted cold restore 先改变当前 writer claim，再安装 successor activation。
当前 native receipt 断点恢复已成功完成，claim 到 activation 安装之间未发生资源 GET。
这不撤销当前 writer 已有的 owner 读取能力：兼容的 owner 读取可以先于 activation。
genesis 恢复也先于首次 activation。资源读取不能统一要求已安装原生 writer；
自然恢复与观察器主动发起的兼容性 GET 是独立验证组。

## 目标与范围

本增量为真实私有原生 inline 资源增加专用 owner HTTP 读取边界，在事务外资源
fetch 前记录原入场身份，并保留持久的完成或未知结果。保留首次 activation 和已获
资格的 successor 恢复，不授予新 activation 或 execution 能力。

普通 owner 读取和原 deferred-v3 publication 校验保留现有 reader。通用 publication
read/PUT 回调、unsupported 私有历史 collector、配额过期、物理对象流、绑定 cut
的历史 reader 属于后续增量。本设计不证明这些 writer 已封闭，也不证明聚合
DRAINED、物理 writer 终止、NodeUnpublish、RELEASED、安全复用或公开
Spring/Hosted 选择。阿里云 ACK 已选为后续 Kubernetes 资格化环境。

## Owner 路由与入场

保留现有 HTTP 请求、credential 和响应 schema，只将该路由的 store 入口改为
专用 owner reader。入口拒绝外层事务：SQL owner 不能在持有 head 时开启新原生
parent 事务，SQL 锁也不能覆盖资源 fetch。首先完成现有 scope、credential 和
稳定 resource ID 检查。

非锁定的当前 `csi_guard` 查询将已持久化的私有目标路由到原生分支。它只是路由
提示，不是权限。一旦选中此分支，原身份缺失或冲突即失败，不回退到普通 reader。
当前 CREATE 分配全新 UUID，不能将现有普通 Session 提升为私有 Session。
未来可信 same-ID 关联仍需配合完整 CREATE/read/PUT membership 增加通用屏障；
直接 SQL 转换 profile 不是已证明的当前 CREATE 竞态。

原生入场在现有 JDBC source 上独占短事务，依次取得 placement → retention
tenant → 完整原 slot/binding/Session pin → journal head → 精确资源元数据。
通过 `JdbcCsiFilesRetirementGuard` 重建原请求，要求 READY 入场，并校验实际
Workspace、当前 writer credential、未过期 claim 和精确资源 catalog 身份。
不要求当前 writer 已安装 activation，也不要求当前 writer generation 为 1。
原 Runtime binding 仍为 generation 1。

只准入当前 profile 的 inline 资源存储。历史对象存储私有资源需要另行合格的原
publication read，此新原生边界在对象 I/O 前拒绝它；不转换、不隔离，也不为它
创造新权限。

## 持久记录

新增 migration 创建 `qwen_csi_resource_read`，不修改已发布 Flyway migration，
不回填权限。每次入场生成全新 UUID，也用作临时 `qwen_output_read_lease` 的 ID。
从锁定数据库保存以下值，不采信调用者提供的 origin JSON：

- Tenant、Workspace、Session、原 request key、binding ID、Runtime generation
  和入场 binding version。
- 当前 writer ID/generation、credential 哈希、journal revision、activation
  ID/epoch。资格恢复期间 activation 可以为空或属于先前安装，记录实际状态。
- 精确 resource ID、kind、schema version、byte length、digest 和 storage kind。
- 状态 `OPEN`、`RETURNED` 或 `UNKNOWN`、数据库开始/结束时间及有界 outcome
  code。不保存明文 writer credential 或异常正文。

两个 row 在读取 inline bytes 前一并提交。OPEN 表示已入场但未持久结束。
RETURNED 表示服务端 JDBC 资源 fetch 已返回，并已完成正常 result-set/connection
清理；不表示校验成功、HTTP 交付、PVC writer 停止或 CSI unpublish。UNKNOWN
表示 fetch/完成不确定。租约过期、新读取、writer takeover 或重试成功，都不能
关闭更早的 OPEN/UNKNOWN row。本增量没有清除这些记录的调度器。

## Fetch、完成和元数据

在入场事务之外 fetch。将 fetched row 与入场资源身份比较，并通过现有 inline
digest/length 校验核实真实 bytes。返回但损坏或缺失的资源，其 fetch 已知结束、
outcome 失败。JDBC 正常返回前发生异常则保留 UNKNOWN；进程崩溃或持久化失败
可能保留 OPEN，两者均不是排空证明。

原生 fetch 必须传播 result-set、statement 和 connection 清理失败。Spring 通用
JDBC 清理 helper 可能吞掉 SQL close 失败，其 query 正常返回不足以记录 RETURNED。
这个边界采用显式事务外 JDBC 资源生命周期，并将物理 JDBC close 故障与租约 row
删除故障分别测试。

完成阶段在独立事务中先取同一原 parent，再取子锁，并校验已持久入场的不可变
origin。继续 DRAINING parent 前还须校验原 retirement seal、registration 与物理
holder 关联；仅有 binding flag 不足以合格。允许原 READY 或已封闭的 DRAINING
binding 继续，不接受替换 binding。
仅记录旧 I/O 已结束时，不要求入场 writer 仍拥有 head。成功 bytes 交付和
`last_verified_at` 更新还要求锁定 head 上当前匹配的 writer grant、scope、
未变资源身份及未过期交付租约。先验证 bytes，再更新时间，避免给尚未读取的
对象打校验时间戳。

在该合格事务内保存 RETURNED/失败 outcome，并只删除本次临时租约。若原 parent
或完成事务不可用，保留 OPEN/UNKNOWN 和原异常，不另开无资格清理事务。
UNKNOWN 保留租约，等待后续合格策略处理。完成异常不能转成成功响应。
封闭 DRAINING 后的新 read 被拒绝，已入场 read 可以结束。后续退役 inspector
需要自己绑定 cut 的历史能力，不能重新打开 owner 入场。

本 membership 在服务端资源 fetch 和校验结束，先于 ResponseEntity 序列化及
网络交付。响应缓冲/交付不写 CSI workspace，不属于此 cut。inline JDBC 记账
不能证明物理对象流、SDK 重试和不确定 close 的生命周期已封闭。

## 组件与所有权

| 组件                                        | 变更与消费者                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Managed Session resource controller         | Session-owner 路由调用专用 fresh-boundary reader，HTTP schema 保持不变。                                          |
| Managed Session store                       | 原入场、事务外 inline fetch、持久 origin 完成及合格校验元数据。现有通用 publication reader 仍单独列入 inventory。 |
| 新 Flyway migration                         | 空的原生读取历史及按原 binding/Session/state 的查询索引，不制造旧 provenance。                                    |
| HTTP Managed Session client、Hosted restore | 现有 credential/ref 校验及首次/cold restore 消费者，不新增公开开关。                                              |
| 未来完整 inventory/cut                      | 须纳入每个原生 read row，包括 OPEN/UNKNOWN 和完成历史，并在同一原 parent 下重新核对 membership。本增量不实现。    |

本设计没有公开生命周期路由、通用权限 resolver、可选死开关、collector 删除或
release 状态转换。

## 实现增量

Owner 路由调用 `readOwnerResource`，内部 publication 校验保留 `readResource`。
V64 新增空的原生读取历史，已发布 migration 保持不变。两个短事务使用同一现有
DataSource，事务 timeout 为 10 秒。入场只读元数据，不读 inline bytes。Fetch
在 SQL 事务外显式管理 JDBC 资源生命周期；每次完成先锁定并比对完整持久入场，
再改变状态。RETURNED 包括已知交付或校验失败，保存结束时间；OPEN 与 UNKNOWN
不声称结束时间，重试不更新任何旧记录。

`JdbcCsiFilesRetirementGuard.requireReadCompletion` 校验已有原 retirement seal、
registration 和物理 holder 关联，不要求已安装 activation。只有 binding flag
不足以继续 DRAINING parent；这也不授予 worker finalize、drain 或 release 权限。
历史索引覆盖原 binding/generation/state，保留每次已入场读取。

## 验证与验收

按 `/feat-dev` 顺序执行，由独立只读 test-engineer 验证。首先尝试全局 `qwen`
基线，记录实际可达性；此私有 Java-only HTTP 边界采用有界 Java/JDBC fallback。
实现前观察真实私有 CREATE→Main→Hosted→Store/SQL→Worker 的 resource GET、
持久租约、完成后消失及缺失原完成历史。旧原生运行只能复用 harness 源码，
不能算作新证据。

历史 `f39cf1db9` 的独立基线到达一个真实原生窗口：10 次成功 resource GET、一次错误
credential 的 403、10 次临时租约插入/删除。实际发现的全部 57 张表、726 列均
没有原生 read-end 历史。每次成功 GET 仅改变对应资源的校验时间戳，拒绝的 GET
不改变这些表。全局 `qwen` discovery 成功但没有私有 Java 入口，因此这些观察
使用实际构建的 Main/Hosted/Store/Worker 和专属 MySQL fallback。coordinator
退出码为 1：observer 的 hold control 比较了字符串引用，未能触发；保留该失败。
此运行尚未证明冷恢复、持有读取跨过期、close 故障和隔离级别争用。实现验收前
先修正 observer 并重跑对应组；这份局部基线不代表完整测试计划通过或 K2 验收。

后续基线保持生产 reader 不变，只修正 ignored observer 的 control-string 比较。
一个原生窗口完成 22 项检查，所有实际命令退出 0；held-fetch marker 显示持久
租约已存在且没有活跃 SQL 事务。专属释放前、中、后的租约数为 0→1→0，GET
返回 200 且原 bytes 精确一致。旧失败运行仍是失败。这补齐基本 GET/held-fetch
观察，不代表自然过期、JDBC close 故障、冷恢复、原 parent 隔离级别争用或提案
reader 验收；这些未执行组和整体 K2 仍待完成。

`02d7eabe3` 的全新独立基线覆盖自然冷恢复和 28 次成功 GET、28 次临时租约
插入/删除。全值审计覆盖 61 张表、801 列，仅对应资源的校验时间戳改变。两个
successor 安装前兼容 GET 使用真实 acquire 的 writer，在响应传回 Hosted 前
暂时持有；它们由 observer 发起，自然安装前 GET 仍为零。另一个故障窗口证明
三个真实 JDBC cleanup 故障仍返回 200 且无持久历史，RC/RR 原 placement parent
锁未阻止旧 GET，真实 operation claim 和 retirement seal 后仍能新开 GET。
这些证明基线缺口，不代表候选验收。此前失败窗口仍保持失败；自然过期和 reader
已预热的 RR snapshot 仍需候选验证。

精确候选 diff `1b47c745a085d34ff9bba5eba72b322eb8ece3df51fe67d3c6de49739ea8036c`
与 Java/Node 产品及依赖已独立封存。G1/G2/G5/G6 完成 51 项检查：35 次精确
bytes GET 200、五次故障 GET 500、一次错误 owner 403。最终持久 membership
为 35 RETURNED、四 UNKNOWN、一 OPEN，保留五个租约。真实 MySQL
READ COMMITTED 和已预热 REPEATABLE READ 在子写入前等待原 parent。
自然冷恢复与两个显式 successor 安装前兼容 GET 通过，自然安装前 GET 为零。

独立故障/seal 观察覆盖 G3/G5/G6，包括保留原异常及 suppressed 完成异常、
rollback 保留 OPEN。首次故障窗口因 observer 未记录 Spring-resolved 异常链
而失败。第二窗口观察到 75 项 predicate，aggregate 仍退出 1：40 秒 HTTP
client 先于真实 120 秒交付截止时间超时。服务端随后提交 RETURNED/expired、
准备 409，并遇到 broken pipe；没有向该客户端交付 409。全新窄 G4 窗口使用
180 秒 client 截止时间，完成 31 项检查，实际在自然交付过期后收到 409。
真实原 seal 前入场的两个 read 均保留 OPEN 与自己的租约；一个在封闭后返回
精确 bytes，另一个保存 RETURNED/expired 并只删除自己的租约。封闭后的新
read 返回 409 且所有表不变。没有通过 SQL 改写截止时间。

原始全值审计覆盖全部 62 张表、827 列，无意外变更或 source/product drift；
专属进程、端口、数据库均已清理。Synthetic Kubernetes/attestation、透明 HTTP
adapter、确定性 SSE、Darwin mount mapping 仍是显式 harness seam。JDBC
close 故障是实际 driver close 返回后由 adapter 注入的 SQLException。
结果只资格化本地 owner-read 行为，不证明物理 CSI 退役或对象流清理。

Build/typecheck/bundle、11 项 Broker 针对性测试、203 项 Agent 针对性测试
及最终 Java packaging/static checks 通过。更广 Agent 运行有 1,848 项测试、
零 failure/error、一个 skip，排除了既有 APFS 非法文件名 case；命令仍因一个
空行 Checkstyle 错误退出 1，之后已删除并重新验证。最初失败的完整运行及错误
wildcard 选中可选 MySQL integration tests 的运行继续保留为失败。最终文档
记录这些观察，已测试的 production 和 migration bytes 不变。

Owner credential 绑定 Session scope，cold writer recovery 合法沿用相同值。
当前 writer grant 到期必须拒绝读取；successor recovery 不是 credential rotation。
独立自然到期 GET 与显式 adversarial original-pin conflict control 在全新封存窗口
完成 21 项检查，两者均返回 409 且全部 62 表不变。Pin fixture 准备和精确恢复
独立审计，恢复后的正向 GET 返回 200。该到期窗口没有启动 successor。
单测任意无效 credential 不是真实 writer 到期或被替换观察。

最终 production 与 migration bytes 匹配独立测试产品。最终 test 变更仅准确
重命名 invalid-credential 断言，rename 后全部 14 项 native-read unit case 再次
通过。配对文档补充这些验证结果与 native-review 不可用结果。

验收要求真实原生 owner HTTP 读取及精确资源 bytes、首次 activation、自然冷恢复、
successor 安装前兼容读取、无效 credential 与过期 writer grant、封闭后拒绝新 read、封闭后完成已入场 read、
JDBC fetch 延迟超过交付期限、不确定 fetch/完成及独立重试历史。使用专属 MySQL
READ COMMITTED 和已预热 REPEATABLE READ，观察原 parent→head 等待；
H2 fixture 不能证明这些锁。保留实际发现的全部表/列及原始值，逐 key 列明允许
的 read history、临时租约和校验时间变更。断言无关资源、原 journal、execution、
receipt、result、grant、Worker 文件历史不变。

保留普通 HTTP resource/grant/publication 回归对照，区分历史组件 fixture 与自然
产生的原生权限。运行针对性 Java 测试、build/typecheck/bundle、适用 Java verify、
两轮连续干净自审及针对精确候选的独立审查。保留失败观察，独立清理仅拥有的资源。
在同一 Draft PR 发布精确 candidate/product 绑定和独立 E2E 报告。整体 K2 验收和
maintainer 架构审查继续开放。

## 后续依赖

完成通用 read/PUT/error/collector/quota writer 封闭，在对象 DELETE 前冻结
unsupported 私有历史，并接入不可变应用 cut，才能将此表解释为排空资格。
即使所有租约过期，已有 OPEN/UNKNOWN 记录也必须阻断后续 cut。持久 worker
finalize、原物理 stop/unpublish、原子 release/reuse、全新目标 Linux/云上及
security/portability 验证仍在后面；CI 成功或本地 fixture 不能替代它们。
