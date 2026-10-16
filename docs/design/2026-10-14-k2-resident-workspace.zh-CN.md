# K2 第一版：Workspace 常驻工具运行环境

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## 状态与范围

用户于 2026-10-14 批准这一首版范围。常驻分支已实现，本地检查和独立 worker
协议、Java 数据及 Spring 配置验证均通过。2026-10-16 的 ACK 验收采用 runtime
`53f24ba09` 和单独封存的实验辅助代码（含 `a4a51655c` 的归属 reader），补齐全部
四项直接证据：六条实际文件工具调用与回复、六份原应用同 DataSource 归属快照、并发准入，以及正常
应用 JVM 重启后第二个 Session 实际成功。独立检查 52/52 通过，另有 26/26 项
数据复核通过。两个 Session 均正常关闭，切换期间原 worker、绑定身份及物理
reservation 保留。所有新增实验资源均正常清理并查询确认不存在。另一次安装尝试
的首轮 Turn 失败，其关闭阻塞和获批丢弃合成状态的记录单独保留，不能作为恢复证据。
Shipping review 仍未给出 verdict，PR 保持 Draft。本设计替代此前 K2
完成计划中本版的自动退役和卷复用要求。原设计及证据保留为后续工作，不能作为
本版验收证据。

每个租户/Workspace 独占一个常驻工具运行环境、一个原始 Pod 和一个固定 CSI PVC。
第一版支持公开 files 工具配置，同一 Workspace 只允许一个未完成 Session。
Session 结束时结算其工作并撤销工具上下文，保留运行环境绑定和物理存储占用。
下一个 Session 使用同一运行环境和文件。

## 调整前的实现

Broker 已区分运行环境绑定和 Runtime Session。普通 Runtime Session 释放不会
释放绑定。managed-context worker 已能安装和关闭独立上下文。CSI provisioner
已有 Workspace 范围、空 isolation key 的分支，使用固定 PVC 和 boot 版本 3，
钉住原始 Pod、Secret、节点、容器、镜像和挂载身份。

调整前，公开 Workspace 执行解析本地目录并采用 Session 隔离，存储 holder 释放会
清空绑定；公开关闭会排空绑定并要求 worker 停止。Workspace 范围的 Broker
准入也会跳过逻辑 Session 屏障。本次添加了明确的常驻分支，仅关闭 Pod 删除
不足以安全切换 Session。

## 配置与永久归属

管理员显式提供常驻 Workspace 映射和 Kubernetes 连接配置。每条映射固定租户、
Workspace、代数、CSI 注册信息、命名空间保护、镜像摘要、worker 命令和产物身份。
配置拒绝重复 Workspace、存储别名或物理卷分配。公开 API 不能传入 Pod、PVC、
运行环境身份或 worker 端点。未配置的 CSI 存储保持不可用。

原 Kubernetes API 及其准入控制器可以提供 DNS 配置，包括 ACK NodeLocal
DNSCache 自动注入。provisioner 只接受 `nameservers`、`searches` 和 `options`
三个 DNS 字段，限制字符串列表长度，并对包含名称及可选字符串值的 option
对象执行字段闭集检查。DNS 地址与域名仍由 Kubernetes 校验。这不增加对
未知 Pod 字段的通用支持。完整的准入后 Pod spec（包括 DNS）仍写入现有持久化
摘要；后续 DNS 变化会拒绝恢复或 reconcile。解析器地址属于基础设施配置，
不能由调用方用作运行环境身份；worker 端点仍使用原 Pod 的 IP 字面量。
参见 [ACK 注入约定](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/configure-nodelocal-dnscache)。

选中的请求采用 Workspace 隔离、空 isolation key、`resident-workspace-files/1` 能力
摘要和固定 storage ID。Session ID 始终是独立的真实 ID。共享 request key 不写入
`ma_session.runtime_request_key`：该列属于旧私有 CSI 退役路径，并受其生成字段
guard 约束。

常驻适配层把原请求和 Broker 持久化的 provision seed 一并转发给选中的 CSI
provider。无 seed 的入口保持不可用，不能重新构造或替换原凭据。

现有 CSI reservation 钉住共享绑定和代数。真实 Runtime Session 行拥有逻辑
上下文；Session 释放把该行改为 RELEASED，不写物理 owner，保留
`binding_id`、`runtime_generation`、
`csi_phase = RESERVED` 和原 reservation 身份。过期、RPC 失败或 Pod 丢失均
不能让其他 Workspace 或租户接管占用。

当前主干 schema 使用 `gmt_create` / `gmt_modified`，持久化时间采用无符号
BIGINT Unix epoch 毫秒。K2 的完整 typed inventory、terminal 期望像和 operation
显式投影都使用相同的物理 schema；cut 协议中的时间仍是 canonical ISO 字符串，
且必须精确表示毫秒。旧时间目录和旧冻结像均拒绝准入，不在准入时重命名列或
重写已保存证据。

Session 初始行、审批模式固化和创建事件共用同一个已捕获的准入时间。
审批更新仍显式写入 `gmt_modified`，使用该次 CREATE 的时间，不再读取第二个
时钟。这样保留严格的初始创建事实及后续整行比较，无需两个时钟恰好落在同一毫秒。

在这套新 canonical baseline 内，Broker 初始化和 Flyway 只识别精确 V1/V2/V3
目录形状，再应用 additive K2 V4 扩展，保留匹配的数据和迁移历史行，最后验证
完整 V4 目录。这不提供早期 DATETIME 或 legacy 目录的升级路径。部署本修订时
使用全新数据库，保留旧二进制及数据库供历史访问。

## Session 准入与工具

创建时锁住真实 `ma_workspace` 行，在插入前检查当前未完成 Session 和未结算
Runtime Session。ACTIVE、CLOSING、DELETING 或旧工作未结算均阻止第二个
Session。幂等创建返回原准入结果。第一版的子 Session 不能共享此运行环境。
仍要求公开 files 配置和现有 actor 授权。

解析和派发复核当前租户/Workspace/代数/存储、Session 状态、授权、原绑定和
完整 lease。此 Workspace 范围配置的 Broker 准入检查持久化逻辑 Session 屏障。
获取时为真实 Runtime Session 安装上下文，存储 claim 后才能激活。worker 只
允许一个活动常驻上下文。释放上下文永久关闭其准入，重放旧激活不能重新打开。
失败不能回退到主运行环境或本地目录。

## 关闭、重启与失败语义

现有 Session 生命周期结算 Hosted 日志并解除其 writer。常驻关闭只遍历精确
共享绑定中属于原 Harness Session 的 Runtime Session，使用现有释放协议结算
并关闭它们，验证没有原活动上下文；不调用绑定排空、Pod 删除或物理存储释放。

原始清理只有在已持久化 Runtime Session 的绑定、代数、Scope 和 Harness 归属
全部匹配时才接受常驻绑定；原 owner 缺失时不能新建清理 tombstone。原生命周期
claim 传给释放准入，已完成清理的重放不会再次调用 worker 释放。旧 Session
隔离的 tombstone 路径保留。

释放结果未知时 Session 保持未完成，存储保持占用，新 Session 继续被阻止。
Broker 重启恢复原持久化运行环境身份。worker 或 Pod 被替换、资源缺失、挂载
变化、容器重启或恢复不确定均让 Workspace 保持不可用。本版不自动替换或转移
归属。

## 各层改动

应用与内嵌 Broker 现在同属 `packages/managed-agent-server`，保留既有 Java
包名和 classpath 资源名。常驻新增代码沿用这一布局；构建只需先安装 Java SDK，
不再依赖独立 Broker 产物，也不增加旧目录兼容层。

- Managed server 配置：显式常驻映射和 Kubernetes 参数。
- 创建及执行 store：单 Session 准入，以及保留永久物理 reservation 的精确
  Runtime Session 归属检查。
- Resolver、provisioner 和 transport：选中配置的 Workspace/PVC，并在共享
  运行环境安装真实 Session 上下文。
- Broker：持久化 Workspace Session 准入与只关闭逻辑 Session 的遍历。
- Worker：常驻上下文激活互斥及旧上下文的永久准入撤销。

## 验证与验收

测试必须证明两个连续 Session 共享同一请求、绑定、Pod/PVC 身份及保留文件；
第一个关闭后不能执行或重新激活。并发创建、过时代数/授权/上下文、未完成工作、
释放未知、其他租户/Workspace 或原运行环境变化均须拒绝。关闭不得触发绑定
释放、Pod/PVC DELETE 或 CSI unpublish。现有本地 Workspace 和私有 CSI
退役的 guard 保持有效。

允许的本地数据、H2 和 worker 协议测试只证明各自明确的层，不能证明真实
Linux CSI 挂载或 ACK 部署。此前拒绝的 native 验收操作不借架构调整重新尝试。
完成声明前需要构建、类型检查、聚焦测试、独立验证和两轮干净完整 diff 自审。
部署及云上验收与本地实现验证分开记录。

以下 ACK 观察属于部署的 runtime 提交 `53f24ba090d3`。后续合并主干
`4a80f0a6adb8` 改变了数据库 baseline，须单独通过本地构建、schema 和公开
handoff 回归验证；此前云端观察不授予这次后续合并的 ACK 验收资格。

这次后续合并的本地验证通过完整 Node build、typecheck、bundle，104 项
HTTP store、964 项 CLI consumer、84 项 Broker 和 619 项 Server 聚焦测试；
其中两项既有 MySQL 专项按条件跳过。Checkstyle、SpotBugs、ESLint 和格式检查
均通过。额外八项普通 claim 回归分别控制状态与代际拒绝，避免混淆两个条件。

独立源编译的 1010 个生产类均与冻结产物逐字节一致。15 项常驻 H2 测试与两个
普通公开交接均通过，零跳过。每条公开流程保留六对真实工具调用/回复，A 末读
与 B 首读字节精确相同，并保存四/五份同 DataSource 归属快照。应用重建创建全新
Spring、Broker、DataSource 和 repository 实例，原 worker 保持存活，仅启动一次、
物理释放为零。实际 metadata 显示 34 张应用表加 Flyway 历史，无旧影子表，时间、
租约和 deadline 列为 BIGINT。这只属于同 JVM 的普通 H2 验证；独立观察器缺少
初始化器及 schema 大小写错误已保留，仅修正其自有输入后重复相同两个测试。

成功的 ACK 尝试保留了 62 条连续响应。A 实际执行 Write/Edit/Read，应用 JVM
重启后 B 实际执行 Read/Edit/Read。六对真实调用与回复全部采集，包含明确的
Write/Edit 成功回复；B 首次读取的字节与 A 最后读取完全相同。两个 Session
均到达 `closed`，同键关闭重放返回原操作；重启前后旧 A 输入均返回
`409 workspace_unavailable`。两个不同幂等键并发创建，实际为一个 202 和一个
`409 workspace_busy`；再并发重放两次赢家键，均返回同一 Session。这只证明
本次两批请求的实际结果，不扩大为任意并发场景的证明。

六份原应用同 DataSource 的只读快照各采集固定八表。原 binding 身份、runtime
generation、seed、lease 和 handle 的导出投影保持相等；slot、storage 和 owner
的完整导出行始终相等，CSI 为 `RESERVED`、revision 为 1。两个原 Runtime Session
在各自 Turn 完成后已 `RELEASED`，关闭后继续保持。binding 保持 `READY`；B
使用时 attestation/operation generation、record version 和健康时间正常推进，
不能声称整个 binding 行没有变化。

正常重启在新的子 JVM 中重新打开同一文件 H2 数据库，PID 从 20 变为 277，
incarnation ID 不同。app 容器和原 worker 的 UID、容器及镜像身份保留，Kubernetes
重启数为零；原 PV/PVC 和盘 handle 始终不变，B 在这个保留的 worker 上实际执行。
确定性测试模型与文件 H2 不资格化外部模型、MySQL 并发、崩溃恢复或生产数据库
高可用。节点始终不可调度；安装器仅通过正常 Binding API 放置本实验的精确 app
和原 provisioner 创建的 worker。普通维护清理不资格化物理退役或跨 Workspace
卷复用。

证据采集仍仅放在实验夹具中。模型夹具只保存选中 run 的实际工具调用
和回复，限制文本结果大小，并精确比对读取字节。测试专用 reader 从原应用的
DataSource 导出限定范围、一致的归属快照，不开放公开 SQL 路由，也不写生命周期
状态。准入测试采用独立 DataSource 和 store。应用重建测试必须保留原放置、
重新创建应用及 Broker 实例；保留旧 Broker 对象不能证明恢复。模型夹具的三项
单元测试覆盖有界采集、精确读取字节、身份拒绝及不可变重试，使用的是合成回复。

2026-10-16 的独立本地验证通过了 15 项 H2 store 测试和两个普通公开交接用例，
零跳过。两个公开用例各保留了六条实际工具回复，第二个 Session 的首次读取与
第一个 Session 留下的文件字节完全相同。原交接保存四份归属快照，应用重建保存
五份。原 slot、storage 和 CSI reservation 完整行始终一致；两次逻辑关闭均不改变
完整 binding；重建前后八张被采集表完全相同，同时 Spring、Broker、DataSource
和 repository 实例均重新创建。原 placement 和 worker 保持存活，只启动一次，
没有物理释放。Runtime Session 在每个 Turn 完成后已释放，公开关闭保留该状态。
这只验证同 JVM、内存 H2 和普通 boot-2 放置下的应用重建；上文单独的 ACK
验收补齐文件数据库重开、新应用 JVM 和 CSI 证据，不扩大本地夹具的资格。

Session 锁顺序 canary 的精确源码边界包含常驻 store 的 Session 锁和 CSI inventory
的 Turn 读取。只有方法体顶层的 final 局部变量直接构造调用者类内直接声明的
private static final 嵌套类型，且没有重赋值、遮蔽或逃逸时，才解析它的成员调用。
这些调用仍生成正常审计边，反向锁顺序仍失败；未知 receiver、别名和有歧义的
重载保持无法解析。

普通公开生命周期联调在 macOS 使用真实 Spring HTTP、H2、Hosted Harness、日志
writer 和 worker/provider 进程。Broker 的包私有构造器接受明确的测试放置 provider；
所有公开构造器保留生产 CSI provisioner 和 JDBC 检查。夹具采用 boot 2、普通目录
及明示的合成放置 handle，不模拟 CSI boot 3，也不验证 Pod、挂载或物理释放。
第二个 Session 必须在编辑前先读到第一个 Session 的唯一文件字节；两个 Session
都通过公开 API 关闭，封存日志并释放各自原 Runtime Session，同时保留共享绑定
及完整物理归属行。

预热和获取的 HTTP 响应包含原始已解析 Scope 的隔离级别，也覆盖常驻配置。
Hosted 将其与能力摘要一并校验，不从配置名推测隔离方式，也不在字段缺失时
代入默认值。

## 延后工作

自动 Pod/PVC 退役、特权节点证据 collector、物理停止和卸载证明、历史退役
凭据、跨 Workspace 卷复用、多写 Session、Session 内原地 cwd 变更、Shell/MCP/Hook 配置和 Pod 丢失
后的自动恢复不属于第一版。管理员保留常驻资源及其持续费用，直到另外授权的
维护方案可以安全退役它们。

创建新 Session 时可以选择目录。第一版不展示或接受常驻 Session 的原地 cwd 变更。
