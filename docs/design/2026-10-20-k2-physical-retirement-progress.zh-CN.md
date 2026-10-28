# 常驻 Workspace 退役与物理进度保留

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## 状态与交付边界

常驻 Read/Write/Edit 运行环境已由 #14340 实现，已合入的 #14758 说明该路径。
本后续把设计与实现放在一个 PR：私有维护命令、空闲准入、持久封锁、查询和显式
原 Pod 删除。测试证据与原生 ACK 资格验证分开，不可用检查继续待完成。

原 #14765 候选 `5535175e0f1b087a498a2822a092d8d1e85788ee` 保留在历史中。
其 node-source coordinator、inventory 扩展和配套迁移已撤出。#14761 已关闭，
不是依赖。既有私有 Session 退役和恢复保留原语义。

[2026-10-24 范围决定](2026-10-23-csi-evidence-source.zh-CN.md)将完整 CSI 审计移出首版前置条件。本维护契约仍为保留归属的有界 DELETE 尝试；平台托管回收与跨 Workspace 复用另行设计。

## 问题与可信边界

正常 Session 关闭结算工作、撤销逻辑上下文并释放其 Runtime Session。binding
保持 `READY`，存储保持 `RESERVED`，B 复用 A 的原 Pod/PVC 和文件字节。这不授权
Workspace 退役。私有 Session 隔离的 `DRAINED` 回执不能退役没有 isolation key
的共享常驻 binding。

信任管理员、Kubernetes 控制面、宿主机及已完成资格验证的 ACK Disk CSI。存储
限定为 `diskplugin.csi.alibabacloud.com`、`ReadWriteOncePod`、`Filesystem`、
`ext4` 及注册磁盘 serial。保留 tenant、actor、Workspace/runtime generation、
原 Pod/container/mount、PVC/PV 和 namespace 保护检查。本方案不独立证明宿主机
持续受控。lease 到期、节点故障、DELETE 成功和 Pod 缺失从不证明物理停止、CSI
unpublish 或卷可安全复用。

## 最小维护入口

`ResidentWorkspaceRetirementMain` 复用既有无 Web 的维护 Boot 配置。它加载服务
的 DataSource、凭据加密密钥和常驻映射，不启动 listener/Harness/worker，也不
迁移 SQL。命令为 `inspect <request-json>`、`begin <request-json>` 和
`delete-pod <request-json> <resourceVersion>`。

可信管理员已控制维护主机及部署凭据。最多 16 KiB 的严格 JSON 请求指定 tenant、
Workspace、预期 generation、actor 和 retirement ID。actor 是管理员声明的审计
身份，不是认证机制。命令还要求其当前 Workspace `OWNER` grant。不增加 HTTP
API、签名密钥或权限框架。调用者不能选择替代 Pod 或 endpoint。Kubernetes
API/token/CA 设置留在部署配置中，计划不保存凭据。参见[部署指南](../../deploy/k2-resident/README.zh-CN.md)。

## 空闲准入与持久封锁

`begin` 只准入已完成 provision 的空闲 Workspace：全部公开 Session 终结，journal
head 已封存，或已永久删除且 writer 身份/lease 已清除；全部 Runtime Session 为
`RELEASED`，全部工具执行为 `SETTLED`。
执行/释放结果未知时拒绝准入。

首先获取既有 tenant `runtime_placement` guard，再获取 `output_publication`
guard 和与 Session 创建共用的 Workspace 行。使用原 slot/binding、注册/reservation
及子记录检查。要求原 binding coordinator claim 有效。在一个短事务中保存不可变
计划，将 Workspace 从 `ACTIVE` 改为 `DRAINING`，原 binding 封为 `DRAINING`
并设置 drain requested，撤销其旧 coordinator generation。保留 active slot 和
`RESERVED` owner。网络调用不持 SQL 锁。

创建先完成则退役被拒绝；退役先完成则创建被拒绝。同 ID/同请求重放返回原计划。
其他 actor、generation、内容或竞争计划不能覆盖。并发有效维护 claim 可拒绝重复
调用，待其结算后查询/重试同一请求。

| 消费端                   | 实施方式                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Session 创建和解析       | 既有 Workspace `ACTIVE`、身份与 actor 检查；创建共用 tenant guard 和 Workspace 行。                              |
| Runtime 获取、激活和派发 | 既有最终 binding readiness/drain、Session 归属与执行检查，覆盖准备后暂停的请求。                                 |
| Warm/provision           | 在 tenant guard 下核验当前常驻 Workspace 身份及 `ACTIVE`，再返回/创建 binding。                                  |
| 后台恢复                 | 通用 coordinator claim 拒绝已封锁的常驻 binding，Broker 重启后同样拒绝；既有 version/generation 检查拒绝旧写入。 |
| Retention                | `DRAINING` binding 和 active slot 保留原记录族，从不清除 reservation。                                           |

既有关闭/结算权限保持。启用维护前封锁旧 Server/Broker 二进制。不提供自动撤销
或恢复服务。

## 显式删除与不确定结果

`begin` 不删除。显式 `delete-pod` 通过可信 API 核验配置的 namespace/保护和
PVC/PV、原 Pod UID/specification/container 及节点身份/就绪状态。意外
owner/finalizer、删除中或缺失 Pod、身份变化和歧义观察拒绝新 DELETE。

发送前持久化精确正常 DELETE 字节：原 UID 和观察到的 `resourceVersion` 前置条件、
30 秒宽限期及 Background propagation。复用 `ma_operation` coordinator 字段，
sender claim 为 60 秒。先在 SQL 中保存 `UNKNOWN` 尝试，只有本次调用发送。
写结果核验原计划及有效 sender generation。撤权阻止新动作；已发送尝试仍可在其
claim 下记录事实结果。

每个原 UID/resourceVersion 只尝试一次，每个计划最多八次。持久化后发送前崩溃
与回复丢失无法区分。重启和同版本重试只读保留尝试，不重发，即使 Kubernetes
不可用也如此。其他显式尝试要求刚核验的不同版本。计数与封锁跨重启保留。

若 Kubernetes 已接受 DELETE 但回复丢失，Pod 可能已具有 `deletionTimestamp` 或
已缺失。这两种状态下，不同版本也不能授权新 DELETE。同版本重放和 `inspect`
仍只读持久回执；最多八次的上限不绕过原 Pod 核验。

保留实际 HTTP 状态和最多 64 KiB 回复字节。完整回复为 `RETURNED`，包括
200/202/404/409/503；不完整/超大回复和传输失败保持 `UNKNOWN`，不制造回复。
`inspect` 不访问 Kubernetes、不写 SQL，只返回不含凭据的状态/摘要。
Workspace/binding 保持 `DRAINING`，active slot 保留，存储保持 `RESERVED`。
不删除 PVC/PV、Secret 或保护对象。

## 持久化与兼容性

复用 `ma_operation`，新增 `WORKSPACE_RETIREMENT`；复用 `ma_operation_work`，
新增 `POD_DELETE_ATTEMPT`。version-1 不可变计划绑定精确请求、原 binding/runtime
generation、原 resource identity digest 及配置 mapping digest。保留的原 binding
与映射固定注册、物理卷、Pod/specification 和保护身份。后续使用核验计划摘要及
这些原记录。尝试保留精确请求字节、版本、序号、sender generation 和回复/未知
结果。可变进度不进入不可变应用快照。

为新 CHECK 值追加 canonical 共享 schema 迁移，同步更新 Server/Broker 枚举、
初始化及校验。保留已发布迁移和 legacy/部分/外来目录拒绝。新维护迁移不恢复已
撤出的 node-source schema。

## 验证与验收

| 层级                | 必须观察到的结果                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 组件/H2             | owner/身份拒绝、精确重放、忙碌与畸形计划拒绝、持久准入封锁、slot/reservation 保留及有界尝试。                     |
| 独立 MySQL 8.4 连接 | REPEATABLE READ 下创建/退役竞争、重复请求、撤权、旧 sender generation 及原存储保留。                              |
| 独立 JVM            | 保留 SQL 的真实私有 begin/inspect/重放；发送前、发送后和回复保存前崩溃保留未知尝试且不重发。                      |
| 目标 ACK            | 先证明同 Pod/container/binding/PVC/PV 上普通 A→关闭→B 精确字节，再证明显式退役/删除拒绝新工作且保留 reservation。 |

传输测试核验精确请求字节、真实 HTTP 状态/回复、大小上限、超时、token 轮换和
不重定向/重试。记录精确源码提交、环境、身份、结果和不可用检查。H2、MySQL 和
loopback HTTP 不代表原生 CSI 资格。早期已撤出候选报告不验证本实现。独立进程
夹具的范围与真实 ACK 行为分开说明。

## 延后工作

Shell、MCP、Hooks、活动 Session 强制排空、自动替换/恢复服务、节点安装、物理
释放证明、破坏性存储清理及跨 Workspace 卷复用延后。资源保留期间持续产生
Pod/节点/存储费用，退役不确定时同样如此。
[常驻运行环境设计](2026-10-14-k2-resident-workspace.zh-CN.md)继续作为正常 Session 交接契约。
