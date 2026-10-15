# K2 第一版：Workspace 常驻工具运行环境

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## 状态与范围

用户于 2026-10-14 批准这一首版范围。常驻分支已实现，本地检查和独立 worker
协议、Java 数据及 Spring 配置验证均通过；普通公开 Hosted 切换已在 H2 和明示
测试放置下通过本地验证。最新 ACK 实验使用 `53f24ba09`，两个公开 Session
及正常关闭均已完成。独立检查确认关闭重放、旧输入拒绝，以及 Pod/container/
PV/PVC 身份不变、零重启（25/25 项通过）。文件操作及保留内容由固定模型的
结果守卫间接支持；公开投影没有逐条工具结果，ACK 归属行也未直接检查，
完整 ACK 切换验收因此仍未完成。所有实验资源均已正常清理，没有丢弃失败
Session 状态。本设计替代此前 K2
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

canonical catalog 保留已发布 V1/V2 和主干 V3 Session 列表索引迁移。尚未发布的
K2 退役扩展顺延为 V4，SQL 内容不变。Broker 初始化和 Flyway 都在应用后续扩展
前验证精确 V1/V2/V3 目录形状，保留原数据和迁移历史行，再验证完整 V4 目录。
部分修改或未知目录仍不可用。

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

本轮 ACK 保留了 46 条连续的公开响应。两个 Session 均到达 `closed`；同键
关闭重放返回原操作和回执，向已关闭的第一个 Session 输入实际返回
`409 workspace_unavailable`。固定模型仅在收到三条工具消息后输出完成标记，
并校验第二个 Session 首次读取中包含第一个 Session 的唯一内容。这些守卫
提供间接证据，不等于捕获了六条工具实际结果或逐字节比对了保留文件。剩余
云上验收需要采集这些结果，以及原 binding/generation 和物理 reservation 行。
普通清理不资格化物理退役或卷复用；MySQL 并发、重启恢复和 shipping review
仍分别验证。

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
