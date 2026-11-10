# 可插拔 Managed Session 对象存储

[English](2026-11-10-managed-object-storage.md) | [简体中文](2026-11-10-managed-object-storage.zh-CN.md)

状态：本地实现已落地；完整 CI、真实 MySQL、真实对象存储与跨 Harness 验收待完成。

## 目标与边界

先交付不可变 Session 大资源，再交付已关闭会话的 journal 冷藏。MySQL 继续负责顺序、writer 围栏、幂等、引用与恢复。对象存储 provider 仅创建、读取和删除不可变正文。Core 与 Harness 保持现有资源和 journal 接口。

本次修改前，journal 正文和有界 Session 资源内联存于 MySQL。Tool Publication 已有对象适配器，但生命周期和配置绑定工具发布，独立恢复工具直接创建 OSS 客户端。

## Provider 契约

在 contracts 中提供不依赖 Spring 或云 SDK 的 `ImmutableObjectStore` 及 factory，支持有界流式条件创建、带检查回调的读删、配置校验、稳定命名空间身份和关闭责任。创建不得覆盖、暴露部分内容或重试结果未知的物理写入。错误区分不存在、已存在、无权限、不可用和写入结果未知。

使用 Java `ServiceLoader` 发现受信任 factory，通过 `object-store.provider` 和 `object-store.provider-options` 在启动时选择一个 provider。未知或重复 provider、无效配置均阻止启动，factory 构造器不分配资源。Server、Broker 和维护工具共用加载器。插件仅依赖同版本 contracts，JAR 及其依赖必须在运行时 classpath 中。不提供热加载、自动下载或在线跨后端迁移。

默认适配器为 OSS。私有、从未启用版本控制的 Bucket 和禁止覆盖要求属于 OSS 适配器，不进入通用契约。自定义 provider 无需 OSS 配置。每个外置对象持久保存稳定 store 身份，命名空间改变时拒绝读取，不能把旧 key 指向无关存储。

[独立插件示例](../../packages/managed-agent-server/examples/object-store/README.zh-CN.md) 提供 factory、SPI 登记、只依赖 contracts 的 POM、可复用契约检查及明确的 classpath/PropertiesLauncher 启动说明。维护入口使用 system properties/环境变量配置，不读取 Boot 应用配置文件。只读 SQL 账本的 inspect 不打开对象客户端。

## Session 资源协议

新资源不超过 64 KiB 内联，更大的正文进入所选后端。通用上限 64 MiB，保留已有更小语义限制：checkpoint 1 MiB、输入 8 MiB、skills 2 MiB、模型请求 32 MiB、native snapshot page 16 MiB。已有 inline 行无需迁移即可继续读取。

在私有 Session store API 增加 `POST /resources:allocate` 和流式 `PUT /resources/{resourceId}/content`。分配时冻结描述和 writer 身份；验证完整上传内容后才发布，返回原有 DurableRef。Harness 不接触 provider 凭证或地址。

通过 `ma_operation` 记录物理 PUT attempt。未知结果只读回原不可变对象对账，不重复 PUT。只有精确长度和 SHA-256 验证通过，资源才能被引用。

短 SQL 事务负责读取授权及租约；对象 IO 和有界依赖预取在事务外执行。提交重验 writer/head/activation 及所有已准备资源描述，再原子写入 journal、引用、receipt 和 head。覆盖历史 checkpoint 依赖、领域记录、skills、工具详情、诊断、快照、CSI 和维护读取器。不兼容 reader profile 在外置写入前拒绝，暂态故障不能成为永久损坏。

协商的 storage reader version 为 6。CSI 通过 `csi-files-retirement/4` 选择不可变资源，旧 profile 保留原 storage floor。工具结果 content/page/manifest 限制仍为 1 MiB/256 KiB/64 KiB，`managed-config_install` 仍为 64 KiB。准备的依赖集限制为 128 MiB、512 个准备步骤。资源描述和 CSI 规范 SQL 镜像保留原外置定位信息，验证后的正文只在临时读取集中保存。

Native snapshot 在最终 manifest 事务之外暂存不可变 page。失败可能留下待对账/GC 的无引用 page 或未发布 manifest claim；最终事务原子发布全部快照引用。公开入口拒绝已有外层 SQL 事务。快照 reader 仍只能看到完整发布的 manifest。关闭外置写入后，仍可复用已外置的 page。

## 保留与 journal 冷藏

新增外置写入和 GC 分别默认关闭。退休 Session 与放弃发布分别编排回收，均使用现有操作账本。删除前确认无引用、发布者已隔离、读租约和恢复保护允许，持久化删除意图，事务外删除，再确认完成。24 小时宽限期只在发布者已隔离且引用、读租约、恢复保护检查通过后开始；对象不存在或租约过期不能结算未知 PUT。关闭新写入不关闭读取、对账和回收。

journal 冷藏单独默认关闭。候选是 CLOSED/ARCHIVED、SEALED、恢复正常、activation 已释放的会话，冷却七天且 journal 正文至少 32 MiB。排除活跃执行、生命周期或恢复操作、读租约、CSI 归属和删除流程。

保留 journal 行、顺序、摘要、receipt、引用与 `compacted_through_revision`。持久保存 HOT/EVICTING/COLD/HYDRATING 状态、任务 epoch 和以 SQL 为准的 pack 清单。版本化长度分帧保存原始事务字节；gzip pack 未压缩正文最多 64 MiB，不拆分事务。校验对象、逐事务摘要和解压上限。

上传并验证完整 pack 后，才发布清单并分批清空 SQL 正文。业务读取前先完整热化；所有正文 reader 持有 HOT 租约，持锁代码不访问对象存储。任务 epoch 拒绝过期冷藏 worker。超过请求预算返回可重试的 `managed_session_journal_rehydrating`。CSI 转换和 Workspace image 创建先热化并保持保护。热化后冗余 pack 保留 24 小时，再按引用安全回收。

前台热化使用 20 秒协作式预算，后台每次热化尝试为 60 秒；网络调用另受 provider 自身超时限制。已回填 revision 和最终正文/摘要链验证游标都持久保存，重试从断点继续。Core 在原请求预算内重试热化响应；Web Shell 保持请求加载状态，直到成功或取消。CSI 全库历史检查在成功 SQL 快照打开前取得其他会话的 HOT 租约，也扫描保留 pack 中的引用。

`qwen.managed-agent.object-store` 下的 `resource-writes-enabled`、`gc-enabled`、`journal-cold-storage-enabled` 和 `journal-eviction-enabled` 相互独立，均默认关闭，`deletion-grace` 默认 `24h`。只打包模式开启冷藏但关闭腾空。未知 PUT 不会因超时或对象不存在而被视为可安全回收。永久退休 journal 只有完成 SQL journal 清理后才释放 pack 引用。

## 验证与上线

验证插件独立编译和发现、Server 与维护工具无 OSS 配置运行；有界流、并发不可变创建、未知写入、授权变化与删除失败；混合存储提交和跨 Harness 恢复；每个冷藏/热化崩溃窗口、并发读取/删除、过期 worker 和精确字节恢复。

使用定向 Java 检查、真实 MySQL 并发用例、受影响 TypeScript 测试/build/typecheck 和显式开启的真实 provider 验收。Mock 与 H2 不能证明真实后端通过。遵守模块共享十分钟本地 Java 验证预算，记录剩余 CI 与真实服务缺口。

修改 V1 baseline 和校验器，不新增 V2 migration 或递增数据库 schema 版本。部署所有兼容 reader 后才启用外置写入，资源验收先于 journal 冷藏，清空正文前先完成只打包验证。回滚关闭新写入和冷藏，继续使用兼容 reader 与恢复；旧二进制不能读取已外置数据。

本地验证：同步 main 及其锁文件后，根目录 build、typecheck 和 bundle 通过；所选 Core/CLI/Web Shell 用例共 416 个通过（242/121/53）。此前插件、资源、冷藏、压缩幂等重放和 native snapshot 的 49 个定向 Java 用例在多次运行中取得通过证据。最后一次定向 reactor 运行有一个失败；修正后的快照回归经直接编译后单独通过。更早的 API/surface、Tool Publication 和锁清单检查在其对应源码状态上通过。这些结果不代表最终完整 Maven 验证成功。

验收仍未完成，共享本地 Java 验证预算已耗尽。恢复读取的 guard 及已发布资源兼容、关闭写入后复用外置快照、发布者隔离后开始 GC 宽限期、CSI ACK 只读 SQL 检查以及同步 main 后的 schema 清单计数的最终修改尚未编译或执行。CI 必须验证最终源码、Checkstyle/SpotBugs、MySQL 并发、独立打包插件、真实 OSS 故障和跨 Harness 恢复，再完成规定的自审和上线验收。PR 验证报告应保留失败记录，并明确区分定向测试与真实后端资格验证。
