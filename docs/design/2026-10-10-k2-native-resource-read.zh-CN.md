# K2 原生资源读取的入场与完成记录

[English](2026-10-10-k2-native-resource-read.md) | [简体中文](2026-10-10-k2-native-resource-read.zh-CN.md)

状态：提案；调查完成，实现和独立验证待完成。基线
`f39cf1db9da6489d8d2e0562b15a10214f918da9`。
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
genesis 恢复也先于首次 activation。因此，资源读取不能统一要求已安装原生 writer。

## 目标与范围

本增量为真实私有原生 inline 资源增加专用 owner HTTP 读取边界，在事务外资源
fetch 前记录原入场身份，并保留持久的完成或未知结果。保留首次 activation 和已获
资格的 successor 恢复，不授予新 activation 或 execution 能力。

普通 owner 读取和原 deferred-v3 publication 校验保留现有 reader。通用 publication
read/PUT 回调、unsupported 私有历史 collector、配额过期、物理对象流、绑定 cut
的历史 reader 属于后续增量。本设计不证明这些 writer 已封闭，也不证明聚合
DRAINED、物理 writer 终止、NodeUnpublish、RELEASED、安全复用或公开
Spring/Hosted 选择。阿里云 ACK 仍是可选的 Kubernetes 测试环境。

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
origin。允许原 READY 或已封闭的 DRAINING binding 继续，不接受替换 binding。
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

## 验证与验收

按 `/feat-dev` 顺序执行，由独立只读 test-engineer 验证。首先尝试全局 `qwen`
基线，记录实际可达性；此私有 Java-only HTTP 边界采用有界 Java/JDBC fallback。
实现前观察真实私有 CREATE→Main→Hosted→Store/SQL→Worker 的 resource GET、
持久租约、完成后消失及缺失原完成历史。旧原生运行只能复用 harness 源码，
不能算作新证据。

该 commit 的独立基线到达一个真实原生窗口：10 次成功 resource GET、一次错误
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

验收要求真实原生 owner HTTP 读取及精确资源 bytes、首次 activation、successor
安装前恢复、旧/过期 credential、封闭后拒绝新 read、封闭后完成已入场 read、
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
