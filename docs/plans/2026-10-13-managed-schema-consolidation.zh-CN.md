# Managed schema 32 实施与切换

[English](2026-10-13-managed-schema-consolidation.md) | [简体中文](2026-10-13-managed-schema-consolidation.zh-CN.md)

## 范围与交付物

新服务仅从 `runtime-broker/src/main/resources/db/managed-schema/V1__managed_schema.sql` 初始化32张业务表。Server Flyway 与 Broker 使用同一份来源。历史 SQL/Java 迁移仅作为文档归档，移出运行时 classpath。不复制或升级旧数据；旧库、外来或损坏的目录在写入前明确拒绝。DataAgent 表不在本次范围内。

对应设计保存完整63项职责映射。封闭的 Java operation/receipt/owner 类型与 SQL CHECK、唯一约束、外键及索引和基线一起版本化。领域适配保持既有 HTTP 身份和响应字段；快照分页返回绑定作用域及不可变版本的签名游标，有效期30分钟。

## 构建与本地验证

使用 Java21 和项目锁定的 pnpm。执行 `corepack pnpm install --frozen-lockfile`，prepare 会构建整个工作区，再执行 `npm run typecheck`。先构建并安装 Runtime Broker，再构建 Server；后者消费前者的 schema 类、资源和共享契约测试 jar。同一 checkout 的 Maven 工作需串行，不能并发 clean 共用 target。

在 `packages/sdk-java/runtime-broker` 执行 `mvn clean verify install`，在 `packages/sdk-java/managed-agent-server` 执行 `mvn clean verify`。检查最终应用 jar：Broker 依赖中应只有 canonical V1，不能包含旧 `db/migration` 资源或类，以及独立的 `schema.sql`。

真实 MySQL 8.4 测试使用 `mysql-integration` profile，连接任务专用实例上的独立空库。部分用例通过此地址再创建随机库，其他用例直接初始化传入的库。每次 suite 使用唯一数据库，结束后仅删除该库及用例创建的子库。不能把系统 mysql 目录当作应用测试数据库，也不能使用应用数据库。JVM 时区变体在同一真实数据库上运行，并使用数据库原生时间的租约谓词。

验证包括日志各写入边界的回滚与重放、旧 writer/claim generation、字节精确身份与创建模式冲突、快照一致性视图/游标签名/旧正文保护/事件保留边界、原对象 UNKNOWN 对账且不再次 PUT、继承的 child ACL 与关闭欠账、物理存储 alias 排他与逐 execution CSI ACK、schedule 定义和扫描竞争，以及历史数据扩大10倍时的执行计划。H2 明确跳过需 MySQL 才能证明的隔离和锁测试。

## Linux 维护任务重启验收

LOCAL 工具和 child Git 执行必须在 Linux 上开启 `QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true`，并在准入前按 native mount 登记每个逻辑存储别名。同一 mount 的别名共享物理 owner；未映射的别名不能领取执行权限。重启时保留登记 marker 及原生 device/inode/birth-time 身份。

使用持久化的任务独立目录和全新32表数据库。运行 Linux 原生测试，包括非法字节 Git 路径和实际进程树终止。重启前保存原 maintenance generation、executionId、物理 holder/mount 身份及原生 machine/boot 身份。证明同一 boot、缺失或过期执行证明无法完成结算；仅租约过期时仍保留 holder。

执行主机重启期间数据库必须保持持久化，可以使用外部 MySQL8.4；临时 SSH 隧道须在重启后重建。容器或 JVM 重启不能代替原生 boot 身份改变。实际重启后重新连接，读取原记录，验证同一机器、不同 boot 及未改变的登记 mount，然后对精确 generation/execution 运行离线维护恢复 CLI。回读 STOPPED 证明、原 holder 释放及后续合法 placement。重复结算须幂等，其余 alias 仍不能同时占有同一物理存储。

## 独立环境启用

1. 从验证过的工作树构建固定 Server/Broker 制品，创建全新 MySQL8.4/InnoDB 空库。两个组件配置到同一新库和共同基线，验收端点绑定 loopback 或受控测试网关。
2. 在接入正式流量前启动新环境，核验 Flyway version1、恰好32张业务表、目录约束和创建/提交/读取/重放/删除闭环。重启进程后确认原身份和终态保留，并以固定10倍工作负载验证 worker 领取、GC 及恢复查询。
3. 在旧环境网关关闭新请求准入，使用旧二进制及旧 schema 结算在途工作。保留旧库和历史读取端点。旧 Session 继续使用旧端点，新 Session 使用新端点；不能将新二进制连接到旧库。
4. 所有验收门禁逐项记录通过后，才允许新请求。记录制品版本、配置身份及新 Session 对应的数据库/环境。
5. 新环境产生数据后，回滚仍须保留新库；必要时关闭其新请求，并保留兼容服务处理已有 Session。旧环境只处理自己的数据或明确在旧环境新建的 Session，不能把新环境身份路由到旧库。

## 证据状态

设计与代码属于本地实施交付物。`.qwen/e2e-tests/managed-schema-32.md` 记录实际运行的测试及环境。正式生产切换是独立的运维结果，需要回读证据；本地通过或服务启动成功不等于生产验收。

## 2026-10-13 首轮实施验收（审查修复前）

独立工作树基于 `18f80f56666a347a2b67b2ef98099cc58356b253`。最终 Server 制品 SHA256 为 `302067c0186f61fabfc75a7541f032108d4ff4910a407a8b29d9d02b956dc5c0`，canonical DDL SHA256 为 `02066024bee41f8ce1efc7b93ccc893d3c5a3782b878af4f1c0c569e271034ce`。最终 jar 仅内嵌该基线，不包含旧迁移类、资源或独立 schema。中英文清单均覆盖全部63项旧职责，基线恰好创建32张业务表。

Server 全量单测2372项：0失败、0错误，5项按环境跳过。最后一项静态检查修正为复用快照密钥的 SecureRandom；其26项快照/writer 回归通过，1项H2隔离测试跳过，完整构建、Checkstyle 和 SpotBugs 通过。最终真实 MySQL8.4.11 运行67项：0失败、0错误、0跳过，包括23项公共API、11项CSI占用/结算、16项Session/快照、17项查询负载。另有真实 MySQL 门禁覆盖日志原子性、业务投影、发布/GC、CSI checkpoint、恢复/迁移、别名权限及1千到1万条历史数据的索引查询。Runtime Broker 全量828项通过，2项按环境跳过；最终20项基础测试和真实8.4目录校验验证最后仅涉及schema的owner索引。Node build/typecheck/bundle、CLI123项和Web146项契约通过。

原生 Ubuntu24.04.4 验收使用 Java21.0.12.1、Node22.23.1、Git2.54.0、MySQL8.4.11。最终制品通过原有两项多Broker/存储夹具，保留25秒屏障、30秒HTTP预算，6项原有Linux Git用例全部通过。独立SQL/进程清理回读为32张业务表、0项残留执行/绑定/owner，无存活夹具worker。增加Git调用前元数据检查后，Mac原外部文件保护用例重复100次也全部通过。

最终制品第一轮重启中，根文件系统的原生设备号从66311变为66309。恢复正确拒绝改变的登记身份，并保留原holder及证明。这是拒绝恢复的负例，不能据此声称支持任意设备重枚举。未修改证明字段、登记身份或生产guard来放行。

登记mount不变的正例使用全新数据库，以及绑定原先未使用的 `/dev/loop100` 的持久化原生ext4镜像；真实主机重启后，在同一规范路径重新挂载同一backing文件。外部验收设置在重挂前校验backing inode/birth/size和文件系统UUID；这些UUID检查属于验收环境，并非产品身份模型。原生设备1892、inode12、birth time和marker保持不变。原生boot从 `57707316-7298-4b8a-a504-0096dc9fc0aa` 变为 `44480971-65a7-4c71-b980-fc2532dfcd93`。原execution `d56043f9-67cb-4519-af64-2929ea204c81` 在不改变不可变身份的情况下结算为STOPPED；generation仅从1推进到2，旧释放无法清除继任holder，继任holder随后释放。两次重复离线结算返回同一原STOPPED身份，没有继续推进generation。SQL回读保留具名OPERATION_WORK证明资源引用。LOCAL部署须在重启后保持登记的原生device/inode/birth/marker身份，并在启用执行前配置持久化mount。

最终jar已运行在 独立 Linux 验收主机的 loopback `127.0.0.1:18084`，连接 MySQL33384 上任务专用的全新数据库，健康状态UP。真实HTTP创建/提交/读取/幂等重放/seal/删除闭环通过；SQL回读为32张业务表加Flyway history version1、原journal revision1/writer generation1，以及永久删除墓碑。Server进程10562停止后重启为12123，同一Session及已完成删除操作保持不变。这项服务验收关闭Harness/Broker dispatch；真实原生工具/worker行为由上述原有独立夹具覆盖。未配置模型凭据或正式流量网关，未迁移或修改旧应用数据库。生产关闭准入、路由和切换仍是独立运维步骤；回滚时保留本新库及Session记录。

完整命令、失败及回读输出保存在本地 `.qwen/e2e-tests/managed-schema-32.md` 和独立test-engineer报告。验收制品、部署脚本及 `native-volume/fixture` 原生卷夹具保留在该主机的任务专用验收目录。本次仅配置任务专用MySQL33384和这些验收资源。

## 2026-10-13 审查修复

四项确认问题均已修复：对象已写入但 SQL 回执丢失时，可查询原不可变对象恢复，不发送第二次 PUT；活跃或空闲 Session 的过期快照和被替换的消息正文可以回收，同时遵守引用、读取/构建租约及恢复保护；投递和渠道查询在十倍终态历史下保持有界索引扫描；actor 回执作用域支持完整合法的 2048 UTF-8 字节。schedule 定义现与私有日志、资源引用及 head 原子投影。基线仍恰好 32 张业务表，中英文清单均覆盖全部 63 项旧职责。DDL SHA256 为 `64ed9772e461658f28ad22a0f936aafcb02b036aa60784c558bd4c6ae0143c8f`。

本轮为本地代码及验收结果。上述 Linux 部署和重启使用修复前制品，保留为历史证据；本轮没有替换该服务或改变它的数据库。更新后的新库 baseline 不用于升级该既有验收数据库。

独立复现脚本及另外 15 项真实 MySQL 保护/事务用例通过。Server 的 114 项 MySQL 8.4.11 回归和 5 项 MySQL/子 JVM PUT 故障用例通过，均无失败或跳过。最后 24 项回归重新覆盖全部 21 项 MySQL 快照用例，且原小消息查询预算保持不变。Broker verify 通过 828 项单测（2 项按环境跳过）、真实 MySQL 目录校验及静态分析。Node build/typecheck/bundle 通过。PUT 故障存储为受控文件/内存适配器，本轮不声称真实 OSS 验收。完整日志及最终制品检查记录于 `.qwen/e2e-tests/managed-schema-32.md` 和独立报告 `.qwen/pr-reviews/managed-schema32-review/fix-verification.md`。

最终 Server 全量单测 2391 项，0 失败、0 错误、6 项按环境跳过。移除一处末尾空行后 Checkstyle 与 SpotBugs 均通过；重新打包后的全部 549 个生产 class 摘要与全量测试产物完全一致。最终本地 Server 制品 SHA256 为 `f98551840d147cf2fde7ca7535e7e3df055a15abc870c622e35e66924445478e`；回读确认内嵌上述共享 DDL，且不含旧应用迁移。独立工程师在最终源码上的 15 项 MySQL 保护/事务用例再次全部通过。

## 同步当前主线后的发布验证

发布分支已接入截至 `58c59136ca` 的主线改动，包括生命周期 v2 资源结算、Workflow 子会话、按日志提交顺序投递的成员命令、Team 审批和日志事件传输。这些路径共用同一套 32 表 baseline，没有增加业务表。Flyway 工作树检查和开放 PR 检查已识别共享的 `db/managed-schema` baseline，并检测注册位置之间的版本冲突。

同步后 Server `verify` 通过 2,474 项，0 失败、0 错误，7 项按环境跳过；Broker `verify` 通过 839 项，0 失败、0 错误，2 项按环境跳过。两个模块的 Checkstyle 与 SpotBugs 均通过。独立原生 MySQL 8.4.11 测试通过 83 项且无跳过，覆盖日志原子性、业务及投递负载、完整 actor 作用域、快照以及生命周期 v2 并发领取和 writer 接管。五组 schema/status/CI 检查脚本的全部 97 项通过；并行构建时两项 Git 夹具 hook 超过 10 秒限制，单独复跑后 22 项开放 PR 检查全部通过。锁定依赖安装、Node build、typecheck 和 CLI bundle 也通过。这些结果对应同步后的本地源码；上述历史 Linux 重启和部署证据不能作为当前 head 的 Linux 验收。

同步后的本地 Server 制品 SHA256 为 `d5d8862175849b1eab661b408e2050b158d58b856daf540325e3a081fd6c5956`。DDL 摘要仍为 `64ed9772e461658f28ad22a0f936aafcb02b036aa60784c558bd4c6ae0143c8f`。发布分支不会接入正式流量，也不会升级任何已有数据库。

独立工程师还实际执行两项 Hosted 成员命令/Harness 用例：2 项通过，无跳过，数据库恰好 32 张业务表。成员完成任务板读写交接；强制终止正在等待命令的成员 Harness 后重启，writer generation 推进，结果交接完成并进入 consumed。83 项 MySQL 及两项 Harness 用例采用截至 `d28bc60d73` 的编译产物，早于最后三条主线提交；当前源码另外通过完整 Server 检查、69 项输出契约及 40 项 CLI batch 回归。未对当前 head 重做 Linux 重启。

## 2026-10-14 CI 与连接池后续修复

分支已同步主线至 `49b3a75641`。本轮修复快照一致性视图/row mapper 的连接池嵌套依赖，将渠道对账 claim 身份经 live Harness 传入私有日志 command，为 Flyway 配置加引号，从 Docker 应用制品选择中排除维护 CLI classifier，并将现役 CI 夹具/检查接入 canonical 表和迁移位置。MariaDB 索引生成列的审批 scope 使用 RTRIM，避免依赖 CHAR 补空格模式；macOS 原生启动在 SQL 验证前被 AMFI 阻止，因此修改后的 MariaDB 验收仍待 CI。

Server 全量单测通过 2,502 项（0 失败/错误，7 项按环境跳过）；最后 105 项连接池/查询预算/异步验证用例全部通过且无跳过，Checkstyle、SpotBugs 通过。Broker 通过 839 项单测（2 项按环境跳过）及 69 项真实 MySQL 8.4.11 用例。Server MySQL profile 通过 497 项；两个夹具仍从已归档的默认 Flyway 位置初始化，产生 7 项错误。改为 canonical V1 并保留两个 guard domain 的竞争屏障后，这 7 项锁/生命周期用例全部通过。独立真实 MySQL/Druid 探针验证单连接池的 HTTP/直接快照读取及构建、同一一致性视图内实际过期、视图释放后的提交续租，以及构建中退役时拒绝发布。浏览器 H2 夹具的启动、默认工作区可见性及隐藏项 ACL 也独立通过。

身份修复后，6 项真实 MySQL Hosted 渠道故障/进程崩溃门禁全部通过。完整 Hosted macOS 尝试不能作为验收：该平台上的原生 Workspace/物理身份门禁失败或跳过，当前 head 仍需 Linux CI。它不替代上述历史 Linux 重启证据。本轮没有部署服务或改动现有应用数据库。

Node build/typecheck/bundle、相关 ESLint/yamllint 通过；两组 CI 检查脚本的 80 项用例全部通过。独立渠道测试通过 20/20 项。Node 26 下两次完整 Harness 文件执行各复现一次未改动的 wake-park 拒绝 code 断言失败，该用例单独执行通过。改用 CI 的 Node 22.22.3 运行同一完整文件，460 项全部通过，无跳过，原断言保持不变。保留 Node 26 失败作为运行时差异证据；本轮不声称修复了这个独立行为。

最终本地 Server 制品 SHA256 为 `ec2111953876a0aa70893e87187640f1fca4dd2441e41cdf7aebb55f466f7b26`；canonical DDL SHA256 为 `983915936568d67eeb34e11f84b68d8d89bec58d11b802439435a3a53f00ce1a`。读回确认恰好 32 张业务表、没有旧运行时迁移，且制品中的 556 个生产 class 文件均与已测试 class 一致。推送后的 GitHub CI 与这些本地结果分开记录。

推送前，另一位贡献者将主线至 `8515d82f80` 合入 PR，生成 `740f8e8c5d`。保留该合并，仅在其上重放本轮修复。整合后的 Server 全量验证通过 2,506 项（0 失败/错误，7 项按环境跳过），包含新增的 cold child 与 procfs 竞争契约，Checkstyle、SpotBugs 通过。整合前后的已测试 CLI 源码/测试字节完全一致。整合后本地 Server 制品 SHA256 为 `38c79e949cc74370ff2fa4531fd54c00ffdd7b2287cc1c47b2fa2b102b660a26`，canonical DDL digest 不变。

独立只读探针在任务专用 MySQL 上发现系统库准入漏洞：Connector/J 9.7.0 的 TABLE/VIEW 筛选隐藏了 mysql 库的全部表。Server 和 Broker 现共用检查，在元数据枚举、DDL 或 Flyway 前拒绝系统库及未选择的应用库。Broker 的 20 项 schema 单测和 70 项真实 MySQL 用例通过；Server 的 9 项准入/Flyway/连接池用例及静态检查通过。该检查阶段 Server SHA256 为 `01be4715ac1c792bfb53a2f8d2d570e927c5fde1e05130426ec86e08caa4e96a`，DDL 不变。只清理隔离任务实例 mysql 库中由测试创建的 32 张表，核实保留全部 38 张系统表身份；未改动应用数据库。

独立制品探针随后验证四个系统库的 8 次 Broker/Server 调用全部拒绝，写语句尝试和 Flyway 调用均为零，前后表目录完全一致。后续合入主线至 `6212189f1f`，包含 MQ2c 公开事件消费者。其原生产查询在 32 表库中独立复现失败，同时 7 项旧表夹具失败。适配后的消费者使用 canonical 表、独立的可空 wake 水位，以及摘要索引和原始身份核对。整合后 Server 验证通过 2,561 项（7 项按环境跳过）；最后补充 Control/退役作用域检查后，61 项重点用例和 10 项真实 MySQL 消费者用例通过。Broker 的 70 项原生用例、Node build/typecheck/bundle、128 项 core envelope 和 4 项 CLI 审批用例通过。修正 CI 指出的两处生成器空格后，全仓库 Prettier 通过。

独立真实 MySQL 探针对最终制品验证：16 个并发 wake 领取者只有一个成功，公开 tail/floor/投影/调度字段不变，真实消息物化及输出撤回/重建保留 wake 水位，实体作用域、字节精确身份和摘要碰撞原值校验正确。历史 head 从 1,000 增至 10,000 时，单行读取始终使用主键常量查询；205 个请求身份分成 200 和 5 两批主键范围查询。这属于 SQL 侧验收，未测试真实 MQ 服务或当前 head 的 Linux 重启。最终 Server SHA256 为 `467d6b34877bdb047949e1cdbc4857e8f20f1753515c4c777fdc8321c97ce9b0`，共享 DDL SHA256 为 `9800309ca17f5b0c65cb11c29d349385f2c0a23a77d43f098f2d0d4c46368e2b`；恰好 32 张业务表，568 个生产 class 均与已测试源码树对应。
