# K2 第一版：常驻 Workspace 文件运行环境

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## 状态与范围

截至 2026-10-20，PR #14340 已在主干实现常驻 Workspace 文件运行环境，继续作为
公开文件执行和逻辑 Session 交接的首版交付路径。PR #14758 现改为说明这条既有
路径及其验收要求，撤出原节点证据增量。主干已有的私有 CSI 实现保持不变。

每个配置的租户/Workspace 独占一个原始常驻 Pod 和固定 CSI PVC。公开
Read/Write/Edit 配置允许一个未完成 Session 和一个活动工具上下文。关闭时
结算其工作并撤销上下文，保留 binding 和物理存储 reservation；下一个 Session
使用同一原运行环境和文件。

## 问题与现有实现

常驻集成必须结算一个 Session，同时保留共享 binding 和 worker。仅保留 Pod
不能防止重叠 Session 或旧权限再次使用。

主干已有 CSI 注册、受保护的存储 reservation、Workspace 范围固定 PVC
provisioner、boot-3 managed-context worker、文件工具、持久 Runtime Session 和
逻辑上下文释放。常驻路径把这些既有组件接入公开 Workspace 准入和关闭，无需
累计分支中的私有原生历史或退役实现。

## 可信边界与平台契约

本次交付信任管理员、Kubernetes 控制面、宿主机和已完成资格验证的 CSI 驱动。
通过既有授权、持久归属和原运行环境检查，保护准入、执行与逻辑交接不受租户请求
越权影响。本方案不独立证明宿主机持续受控，也不为已失陷的宿主机授予资格。
Kubernetes 对象观察和工件哈希不能提供这项更强的证明。

支持的存储契约限定为 ACK Disk CSI（`diskplugin.csi.alibabacloud.com`）、
`ReadWriteOncePod`、`Filesystem` 和 `ext4`。注册的磁盘 serial 必须与 worker
实际挂载设备一致。PVC/PV 身份及其绑定、namespace 和已安装的保护 policy/binding
继续钉住并校验。其他驱动或访问模式需要独立设计和验收，当前路径不代表通用 CSI 支持。

既有 actor、Workspace generation、lease、mount 和物理卷 alias 检查全部保留。
信任平台不允许按租约到期转移归属。RWOP 准入和 Pod 缺失都不是物理停止或卷释放证据。

## 配置与归属

管理员显式映射租户、Workspace、generation、CSI 注册、命名空间保护、不可变
worker 镜像、命令及可选产物。重复 Workspace、存储 alias 或物理卷分配均被拒绝。
公开调用者不能选择 Pod、PVC、worker endpoint 或运行环境身份；只有 CSI 注册
不会启用执行。

映射要求 Workspace 隔离和 files 配置，不能同时使用本地 mount 映射、本地 Workspace 创建根、子 Session
共享或本地重启/恢复模式。Shell、MCP、Hooks、后台执行及 Session 内原地 cwd
变更不可用；可在创建下一个 Session 时选择 cwd。

请求使用空 isolation key 和常驻 capability digest，Harness/Runtime Session ID
仍是真实不同 ID。它采用主干普通 CSI managed-context boot，而非私有 CSI files
配置。适配层把原请求和 Broker 持久化的 provision seed 一起传给既有 provider；
无 seed 入口不能重新构造凭据。

CSI reservation 保留原 binding、runtime generation 和物理 owner。逻辑释放只
改变 Runtime Session 归属，保留 `binding_id`、`runtime_generation`、
`csi_phase = RESERVED` 和原 reservation 身份。过期、RPC 失败或 Pod 缺失不能把
存储转移给另一个 Workspace 或租户。

本次文档修订不新增数据库迁移或 schema 扩展。运行环境继续使用主干已发布的
canonical 目录和毫秒时间戳。已有的 legacy、部分或外来目录拒绝行为保持，
不重写旧持久证据。

## 准入与执行

创建锁住真实 Workspace 行，在插入前检查未完成 Session 和未释放 Runtime
Session。ACTIVE、CLOSING、DELETING 或未结算旧工作阻止另一个 Session；幂等创建
返回原准入。子 Session 不能共享常驻运行环境。

解析与派发核对租户、Workspace generation、存储、当前 Session 状态和 actor
授权，以及原 binding 和完整 lease。Broker 准入及派发把持久逻辑 Session 屏障
应用于常驻 Workspace 配置，在插入重叠 owner 前拒绝第二个上下文。

获取为实际 Runtime Session 安装上下文，在存储 claim 后激活。worker 同时只允许
一个常驻上下文，释放后永久拒绝重新激活。已失活旧上下文不会占用下一个 Session
的工作目录。文件工具集及 provider manifest 均限定 Read/Write/Edit。任何失败均
不回退主运行环境或本地目录。

## 关闭、重启和失败行为

既有生命周期结算 Hosted journal 并解除 writer。常驻关闭只遍历精确共享 binding
中属于原 Harness Session 的 Runtime Session，结算并释放，再核实没有原活动上下文
或执行。它不排空 binding、删除 Pod/PVC、卸载卷或清空物理 owner。

清理只接受已持久且 binding、generation、Scope、Harness owner 全部匹配的
Runtime Session。缺失常驻 owner 不能新建清理 tombstone。原生命周期 claim 传至
释放准入；完成后重放不再次释放 worker。主干旧 Session 隔离 tombstone 路径不变。

释放不确定时，Session 保持未完成、存储保持占用，阻止新准入。在空闲边界正常
重启应用/Broker 后，从保留的数据库加载原运行环境身份并使用原 worker。
这不代表恢复被中断的 Turn 或已过期的 Harness writer，本交接也不授权重放未解决的执行。

worker 或 Pod 替换、容器重启、mount 变化、资源缺失或恢复有歧义时，Workspace
保持不可用。reservation 继续占用；lease 到期不授权创建替代 generation、其他 Pod
或转移卷。运维检查也不会解除该占用。自动替换和物理归属转移需要另行设计。

## Kubernetes 准入与部署

原 Kubernetes API 可以注入 DNS 配置，包括 ACK NodeLocal DNSCache。provisioner
只接纳有界 `nameservers`、`searches`，以及仅包含 name 和可选字符串 value 的
封闭 `options` 条目。Kubernetes 验证 DNS 地址和域名。完整准入后 Pod spec
（包括 DNS）进入持久 digest，后续变化拒绝恢复或 reconcile。没有放开其他未知
Pod 字段，worker endpoint 仍使用原 Pod 字面 IP。

使用既有注册 operator 和离线保护 renderer，然后钉住实际 namespace/policy/
binding 身份。镜像须包含 Node 22+ 和构建后的 CLI。worker 使用 UID/GID 1000、
只读根文件系统、不增加 capability、不挂 service-account token、固定 PVC 和临时
emptyDir，restartPolicy 为 Never。应用须连通原 Kubernetes API 和 worker endpoint。
[配置指南](../../deploy/k2-resident/README.zh-CN.md)包含模板和既有 operator 调用。
安装本特性不需要特权节点 collector。

## 分层改动与拆分边界

应用和嵌入 Broker 仍位于 `packages/managed-agent-server`。PR #14340 提供显式配置、
常驻适配层/profile 和归属检查；接通公开创建、解析和逻辑关闭；把已解析 capability
传入 Hosted；在现有 CLI worker 中实施独占、可撤销的文件上下文。

本次修订相对主干只改文档。既有公开 Session API、工具参数、worker 协议、配置和
schema 继续作为实现契约。常驻路径不需要 Go 模块、定制 containerd/shim、节点
collector 或冷启动安装。

PR #14758 原先位于 `1656cf02` 的节点证据候选保留在提交历史中，从当前树中撤出。
安装/冷启动提案 #14761 与物理退役提案 #14765 原本堆叠在该候选上，两者代码及
Draft 状态保持不变，但简化后的 #14758 不再提供它们所需的节点证据前置能力。
它们合入前需要独立重新设计依赖，不属于首版依赖。主干已经合入的私有
boot/历史/finalization、恢复及应用退役实现全部保留。

## 验证与验收

本次纯文档修订要求格式、相对引用和双语一致性检查，并确认最终差量相对主干没有
生产代码、workflow 或 schema 变化。运行环境改动需要独立完成 Node
build/typecheck/bundle、worker/Hosted 定向测试及适用的 Java/数据库检查。
旧候选结果不作为本次修订或实际部署的验收证据。

既有 `ResidentWorkspacesTest` 覆盖准入、同键重放、物理 alias 拒绝、close 屏障、
逻辑释放及不确定交接；`ResidentWorkspaceProvisionerTest` 覆盖原 seed 转发与
scope 选择。复用这些覆盖，不重复新增相同测试。其 H2 与受控 peer 夹具不能证明
MySQL 竞争或真实 CSI mount。

| 场景                                  | 必须观察到的验收结果                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A 写入/编辑/读取、关闭，再由 B 读取   | 最终文件字节一致，Pod/container、binding generation、PVC/PV 和 reservation 身份一致；binding 保持 READY，存储保持 RESERVED。 |
| 并发创建与重试                        | 不同键只能准入一个未完成 Session；同键返回原准入，包括独立 MySQL 连接之间的竞争。                                            |
| 关闭后的旧权限                        | 原上下文不能重新激活或派发，包括在持久 close 屏障前暂停的请求。                                                              |
| 空闲控制平面重启                      | 新的应用/Broker 进程使用保留数据库与原 worker，不创建替代 Pod 或存储 owner。                                                 |
| 释放响应丢失或 UNKNOWN 执行           | Session 保持未完成，reservation 保持占用，B 被拒绝；不重放结果不确定的工具副作用。                                           |
| Pod 缺失/替换、容器重启或存储身份改变 | 执行和交接被拒绝，不清除 reservation 或转移卷。                                                                              |

后续每次验收记录精确源码提交、环境、身份 tuple 和观察结果。组件/H2、真实
MySQL、独立进程和目标 ACK 结果分别记录。首个部署里程碑是在原 Pod 上完成
A→关闭→B 的文件交接。本次文档修订不执行 MySQL、独立进程或 ACK 验收，
这些资格验证继续标为待完成。

普通公开联调夹具使用真实 Spring HTTP、H2、Hosted、journal writer 和 worker/
provider 进程。测试专用 provider 明示普通 boot-2 放置，所有公开构造器保留生产
CSI provider 和 JDBC 检查。应用重建重新创建 Spring、Broker、DataSource 和
repository 实例，同时保留原 worker。它验证同 JVM 重建，不证明进程崩溃恢复或
CSI mount。限定范围的证据 reader 使用原 DataSource，对敏感值取摘要，不写生命
周期状态或开放公开 SQL endpoint。

较早 ACK 验收仍绑定 runtime `53f24ba09` 及其原辅助程序，只作背景，不授予此新
拆分资格。新云端部署、MySQL 并发/恢复、外部模型、进程崩溃和数据库 HA 各自验证。
不可用检查和跳过项必须明确报告。发布声明前须独立验证、连续两轮干净完整差量
自审，以及维护者架构评审。

## 延后工作与运行费用

自动物理退役、特权 collector、物理停止/CSI 卸载证明、合格历史退役凭据、跨
Workspace 安全卷复用、多写和丢失 Pod 自动恢复延后。Session 关闭后仍持续产生
Pod/节点/存储费用；在另行授权的维护计划可安全删除前，管理员须保留这些资源。
普通维护清理不证明物理释放或安全复用。
