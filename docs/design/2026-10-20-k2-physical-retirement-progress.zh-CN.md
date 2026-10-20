# 常驻 Workspace 退役与物理进度保留

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## 状态与交付边界

截至 2026-10-20，本方案是简化后 #14758 的纯设计后续，基线为
`c6820459026adf3619c9080b5b73cacc52922998`。常驻 Read/Write/Edit 运行环境已由
#14340 实现。本 PR 保持 Draft，不实现常驻 Workspace 退役命令、准入封锁或物理
清理。[常驻运行环境设计](2026-10-14-k2-resident-workspace.zh-CN.md)继续作为首版契约。

原 #14765 实现
`5535175e0f1b087a498a2822a092d8d1e85788ee` 保留在历史中，但从当前树撤出，
不沿用其 node-source 协议、物理 coordinator、inventory 扩展、配套表或 V14
迁移。安装/冷启动提案 #14761 已关闭，不是前置依赖。主干已有运行环境、私有退役
和恢复实现全部保持。

## 问题与现有行为

常驻 Session 正常关闭会结算工作、撤销逻辑上下文并释放其 Runtime Session。
共享 binding 保持 `READY`，存储保持 `RESERVED`，下一个 Session 可以复用原
Pod、PVC 和文件。关闭成功不授予退役该 Workspace 或删除其 Pod 的权限。

现有私有应用退役的 `DRAINED` 结果属于 Session 隔离配置，固定原 generation-1
owner，其 isolation key 是原 Session。它不能作为常驻 Workspace 的排空回执：
常驻 binding 跨多个顺序 Session，且没有 Session isolation key。直接复用该结果
或只替换名称，会绕过尚不存在的 Workspace 级准入决策。

未来能力需要显式维护请求，先禁止新工作，再记录限定原 Pod 的删除尝试。
物理完成尚未得到证明时，必须保留存储占用。

## 可信边界与支持的平台

沿用常驻运行环境对管理员、Kubernetes 控制面、宿主机及已完成资格验证的 ACK
Disk CSI 的信任。存储仍限定为 `diskplugin.csi.alibabacloud.com`、
`ReadWriteOncePod`、`Filesystem` 和 `ext4`，注册磁盘 serial 必须匹配。
保留 tenant、actor、Workspace 和 runtime generation、原 Pod/container、mount、
PVC/PV 及保护身份检查。

本方案不要求 Go 节点服务、定制 containerd/shim、冷启动安装、source journal 或
独立的宿主机持续受控证明。信任平台仍不意味着 lease 到期、节点故障、DELETE
回复成功或 Pod 缺失能够证明 CSI unpublish 或卷可安全复用。

## 拟议的 Workspace 退役准入

退役是针对一个已持久化 tenant/Workspace 及其当前代际、独立且显式授权的操作。
首个实现只接纳空闲 Workspace：所有公开 Session 必须已完成生命周期，全部
Runtime Session 必须为 `RELEASED`，每个工具执行必须为 `SETTLED`。Session、
writer、执行或释放仍活动或不确定时，拒绝退役。强制取消与中断工作的恢复不属于
本增量。

准入必须锁住 Session 创建使用的同一 Workspace 行。在一个事务中重新核验
actor 权限和全部原归属，持久化不可变、幂等的退役计划，并把 Workspace 从
`ACTIVE` 改为 `DRAINING`，同时封锁原 binding 的新获取与派发。并发 Session
若先获准，退役必须被拒绝；退役若先完成封锁，Session 必须被拒绝。过期注册、
其他 actor 或不匹配代际不能创建或推进计划。

持久化 tenant、Workspace generation、actor/request digest、原 binding 和
runtime generation、存储注册 revision、物理卷身份、namespace/保护身份，以及
原 Pod UID/specification digest；计划不保存凭据。幂等重试返回同一计划，其他
请求不能覆盖。后续修改仍须重新核验授权。

持久封锁必须覆盖 Session 创建与解析、Runtime Session 获取/激活、工具派发、
恢复/provisioning 以及维护重试。须一并审计 registry、常驻准入、执行授权、Broker
和常驻 provisioner。既有 `DRAINING` 状态本身不代表所有消费端已实施这条拟议
流程。实现前须明确完整 SQL 锁顺序，并验证与 Session 关闭和既有恢复之间的关系。

封锁提交后，失败或 lease 到期不能恢复 `ACTIVE`、清除原 slot、创建替代代际或
回退主运行环境/本地运行环境。首个维护增量不提供自动撤销或恢复服务的操作。

## 拟议的删除进度

使用限定已持久化 Workspace 和原 binding 的私有维护入口。普通 Session 关闭和
文件工具不调用它。入口及凭据契约须在实现时评审；本 PR 不开放新 API 或可执行
命令。

每次删除尝试前，通过可信 Kubernetes API 复核固定的 namespace/保护身份、
PVC/PV、注册及原 Pod 身份。UID/specification 改变、意外 owner/finalizer、Pod
已进入删除或平台观察不明确时拒绝。资源缺失或节点不可用必须保留封锁与 reservation。
本操作不删除 PVC/PV、Secret 或 namespace 保护。

发送前持久化精确的正常 Pod DELETE 请求，包含原 UID 和观察到的
`resourceVersion` 前置条件、30 秒宽限期及 Background propagation。每次尝试只有
一个持久 sender claim。全部网络调用位于 SQL 事务外；后续每次写入重新核验原计划
及 claim generation。有界保留实际 HTTP 状态和回复字节，传输失败不能制造回复。

同一个 `resourceVersion` 最多尝试一次。持久化后、发送前崩溃，与回复丢失无法区分，
必须保持 `UNKNOWN`；恢复不能重新发送该请求。只有经过验证、版本不同的新观察才能
授权显式下一次尝试，最多八次。进程重启不能重置计数或封锁。

概念进度区分计划/封锁已保存、尝试已记录、观察到删除，以及 Pod 缺失。这些只是
观察，不是物理完成状态机。HTTP 200/202/404 或后续 GET 查不到原 Pod，都不授予
`STOPPED`、`UNPUBLISHED` 或 `RELEASED` 权限。binding 继续封锁，保留原 active
slot，存储保持 `RESERVED`。物理停止、CSI unpublish、最终释放和卷复用需要另外
经过资格验证的设计。

## 持久化与兼容性

从已发布 canonical schema 和既有 Workspace/operation 台账出发，优先采用独立
版本的常驻维护记录，不重新解释私有 Session 隔离退役 inventory。具体 operation
和 work kind、键约束和 payload 限额须随实现明确；当前 canonical CHECK 约束
不接纳任意新增 kind。必要 schema 改动须遵循当前共享 schema 策略，并同步更新
所有校验器和消费端。

不恢复原 node-source 表、关联 source 的 inventory 或 V14 配套迁移。本设计 PR
不修改数据库或协议，主干已有快照、schema 校验与私有退役语义保持完整。可变维护
进度不能使不可变的历史应用快照失效，也不能放宽其完整性检查。

## 故障与验收要求

| 场景                             | 未来必须观察到的结果                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| 普通 A→关闭→B 交接               | 维护前，B 在同一原 Pod/PVC 读取 A 的精确文件字节；普通关闭保留 `READY`/`RESERVED`。 |
| 空闲退役与创建竞争               | Workspace 锁只允许一个结果；活动 Session 拒绝退役，封锁提交后拒绝全部后续 Session。 |
| 旧上下文或过期维护调用者         | 重新激活、获取与派发均拒绝；其他 actor、代际或 claim 不能推进进度。                 |
| 进程崩溃或 DELETE 回复丢失       | 封锁、计划、计数和未知尝试持久保留；同版本不重复发送，不创建替代 Pod。              |
| Pod 替换/删除中/缺失，或存储变化 | 不发送新的不安全 DELETE；状态保留原身份和 reservation，不宣称物理完成。             |
| 200/202/404/409、超时或节点丢失  | 保留实际回复或未知结果，绝不释放存储或授权其他 owner。                              |

未来验证须区分组件/H2、独立连接的真实 MySQL、独立应用/Broker 进程及目标 ACK
结果。测试完整竞争和崩溃边界，包括持久化后发送前、发送后回复前，以及回复后保存前。
通过生产准入路径验证畸形计划、保留字节、过期凭据、claim generation 和归属漂移，
不制造旧的 source 关联 `DRAINED` 来代替验证。

本次修订运行文档格式、双语/引用检查，以及相对 #14758 的完整代码树对比。
不运行新的 Node/Maven 运行环境测试、MySQL、独立进程或 ACK 退役验收。
全部拟议运行环境验收继续待完成。旧 #14765 夹具与测试报告仍只绑定已撤出的候选，
不验证本设计的实现。

## 实现门槛与延后工作

实现前，评审 Workspace 维护权限与凭据入口、完整消费端/锁顺序审计、canonical
持久化契约及 ACK 资格验证计划。先实现并验证空闲准入/封锁，再增加网络删除。
每个阶段的证据都绑定其精确源码提交。

Shell、MCP、Hooks、活动 Session 强制排空、自动替换或恢复服务、节点安装、
物理释放证明、破坏性存储清理和跨 Workspace 卷复用继续延后。资源保留期间持续
产生常驻 Pod、节点和存储费用，退役不确定时同样如此。
