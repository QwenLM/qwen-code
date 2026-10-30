# 常驻 Workspace 回收与保留数据交接

[English](2026-10-27-resident-workspace-reclamation.md) | [简体中文](2026-10-27-resident-workspace-reclamation.zh-CN.md)

## 状态

这是 [#13395](https://github.com/QwenLM/qwen-code/issues/13395) 合并提交的 S2 设计与 S3 实现。实现基线为 main `0539160f35f983ba4a6d4d369c0ae18941b2fdb2`。本文描述已实现契约；完整平台验收仍待完成。

2026-10-27，定向 Java/Checkstyle、真实 MySQL/进程检查以及隔离 ACK 健康交接在各自记录的范围内通过。原生运行使用实现基线加 31 文件源码清单，其 SHA-256 为 `9edfca3f939c5e19b4cebdacbc13460b9c4b4590c2de2c9113b30d59fa299ee2`，平台为 ACK `1.36.2-aliyun.1` 与 Disk CSI `1.37.3`。同一磁盘完成 A→B→C→D，reserved revision 为 `1/3/5/7`、released revision 为 `2/4/6`，22 次文件工具执行成功并保留前序字节。模型端点使用受控 fixture。该证据仅覆盖上述源码/制品快照与健康流程；rebase 不会自动验收新集成制品。完整 CI、要求的原生故障矩阵与生产最小权限验收仍待完成。

2026-10-27，操作者选择保留文件，并由管理员显式将磁盘交接给同租户的另一个 Workspace。每一轮归属变化都必须遵守此决定。[现有交付边界](2026-10-23-csi-evidence-source.zh-CN.md) 及独立的 CSI LOST 恢复问题 [#12670](https://github.com/QwenLM/qwen-code/issues/12670) 继续有效。

## 问题与基线状态

空闲退役将 Workspace 与原绑定设为 `DRAINING`，保留 active slot 和 `RESERVED` 物理归属。正常 Pod DELETE 保存实际 HTTP 结果或 `UNKNOWN`，两者均不释放资源。目前没有持久化的平台清理回执或原子物理释放。

四处常驻消费者假定 reservation revision 为 `1`，共享的首次 CSI 协议仅允许 revision `0`、`1`、`2`。只释放当前 owner 而不调整这些消费者，无法支持重复交接。CSI owner 也未填充数据所属租户；如果清空 reservation 身份，其他租户的别名就可能取得保留文件。退役查询依赖当前配置映射，替换映射会导致旧操作无法回读。

## 目标与边界

为健康、空闲、身份未变的原常驻运行时提供管理员显式维护，支持持久化回读、原子释放和重复同租户交接。保留原文件、PVC/PV、磁盘、保护对象及历史身份。同一物理卷只配置一个 Workspace。

不增加自动过期、活跃 Session 强制 drain、重新开放已退役 Workspace、同一请求的替代 generation、跨租户复用、擦除数据、Shell/MCP/Hooks、CSI RPC 审计、节点代理或自动 LOST 恢复。不确定的停止结果继续保留围栏。外部基础设施清理本身不改变产品归属。

## 信任与平台完成条件

支持边界信任经过审查的管理员、Kubernetes API 与 kubelet、宿主机和已验收的 ACK Disk CSI。维护进程使用配置的 HTTPS origin、固定 CA、轮换凭证及现有注册/保护校验。请求文件只提供身份，不能提供完成回执或自行声称节点已被隔离。

runtime namespace 与 PVC 由此唯一 Managed provisioner 专用。部署准入/RBAC 必须排除使用该 PVC 的其他 Pod 创建者和外部控制器；维护或交接期间，管理员不得重新挂载、创建物理别名或强制修改存储。现有资源保护本身不约束 Pod 创建的独占性。准备与完成阶段都完整有界地扫描 namespace Pods，拒绝包括 Pending 和终态 Pod 在内的所有非原 Pod 对 PVC 的引用。完整有界地扫描 PV，要求注册 name/UID 是该 CSI driver/volumeHandle 的唯一 PV，拒绝物理别名。产品创建的消费者由 Workspace 和物理归属围栏约束。回执不声称能抵抗违反此前提的后续外部重挂载或 cluster-admin 操作。

正常完成要求同时满足以下观察，且全部关联到原 resource handle：

1. DELETE 前，精确的原 Pod 正在运行，唯一容器的 ID、image ID、零重启、spec digest、Pod UID 与 node UID 均匹配。不得有 owner reference、删除时间或其他 finalizer。原健康节点有非空 boot ID，其 `status.volumesInUse` 包含精确 CSI unique volume；原 PV、driver 和节点恰好对应一个已挂接的 `VolumeAttachment`，并保存其 UID。当前 `kube-node-lease` Lease 必须属于该 Node UID 与名称。
2. 在现有正常 30 秒优雅 DELETE 前，用 JSON Patch 测试 UID 和 resourceVersion，只安装该操作的确定性 Pod finalizer。在 kubelet 与 CSI 正常清理期间保留 Pod 对象。finalizer 只用于保留元数据，本身不证明物理完成。
3. 观察同一个正在删除的 Pod，其自有 finalizer 仍存在，spec 与容器身份未变，原容器明确为 `terminated`，且包含 `finishedAt`。单独的 Pod phase 不够。不得重启或替换容器，也不得有 init container 或 sidecar。
4. 读取相同 Node UID 和 boot ID，要求 `Ready=True`，没有删除或 out-of-service 状态，且 `status.volumesInUse` 与 `status.volumesAttached` 均不再包含原 CSI unique volume。Ready heartbeat 必须晚于基线并覆盖容器终止时间。读取相同 Node Lease UID，Node owner 与 holder 相同，续租发生在终止之后，当前续租在声明的有效期内，且有效期最多 60 秒。旧 Ready condition 或单独的新 Lease 均不够。
5. 完整且有界的 `storage.k8s.io/v1/volumeattachments` 列表不含原 PV 的任何 attachment。拒绝不完整分页、格式错误、身份重复、分页不一致、超限和替代的匹配 attachment。重新校验原注册与保护。上述观察必须同时成立，任何单项都不是释放授权。

unique volume 名称为 `kubernetes.io/csi/<driver>^<volumeHandle>`，使用精确匹配。保守判断 Node 和 Lease 时间；时钟偏差或字段缺失均保留归属。强制删除、强制 detach、节点已关机的声明、云盘状态或用户布尔值均不能代替这些条件。

`deletionTimestamp` 是宽限期截止时间，不是删除开始时间。原容器可以在它之前终止，正常 kubelet 收尾也可以改变它。要求有效的非空删除时间和原容器明确终止的证据，不将 `finishedAt` 与宽限期截止时间比较，也不要求该截止时间始终等于已存回执。新鲜 Node/Lease 观察仍须覆盖终止。参见 Kubernetes [优雅删除实现](https://github.com/kubernetes/kubernetes/blob/v1.36.2/staging/src/k8s.io/apiserver/pkg/registry/rest/delete.go)。

Kubernetes 文档说明了 [Pod 优雅终止](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) 和 [finalizer](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)。kubelet 在容器停止后从期望卷状态中移除终止中的 Pod；attach/detach controller 从期望状态中移除终态 Pod。因此，保留终态 Pod 对象应允许正常卷清理。这一顺序是必须在目标 ACK 版本验证的实现依赖。[非优雅节点关闭](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/) 可能跳过正常卸载而强制 detach；相同节点、相同启动、原容器终止和新鲜状态的组合检查排除该路径。单独的 VolumeAttachment 消失永远不证明卸载。

## 维护协议与持久化状态

扩展现有可信维护入口，不增加公开或 daemon 路由。保留现有 `inspect`、`begin` 和仅删除 Pod 的 `delete-pod`。增加 `prepare-reclamation <request-json> <resourceVersion>` 与 `reclaim <request-json>`。

| 阶段                  | 持久化契约                                                                                                                           | 基础设施动作                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `begin`               | 保存带版本的不可变计划，包含原映射、请求、绑定/generation、handle 身份与 digest。Workspace/绑定变为 `DRAINING`，保留 slot 和 owner。 | 无。                                                          |
| `prepare-reclamation` | 在 I/O 前保存原节点 boot/Lease/attachment 基线及有界条件 finalizer 尝试。                                                            | 为校验过的原 Pod 添加自有 finalizer。                         |
| `delete-pod`          | 保留现有按 Pod UID/resourceVersion 记录的尝试与 `UNKNOWN` 语义。已准备的操作只接受自己的 finalizer。                                 | 每个持久化尝试只发送一次正常 UID/RV 条件 DELETE。             |
| `reclaim`：观察       | 重新校验持有的原身份与空闲状态，保存有界不可变清理回执及 digest，操作进入 `PLATFORM_CLEANED`。                                       | 读取上述同时成立的完成观察。                                  |
| `reclaim`：收尾       | 在 I/O 前保存条件 finalizer 移除意图。原 Pod 消失前保留全部产品归属。                                                                | 用 UID/RV 测试仅移除自己的 finalizer，再回读原 Pod 已不存在。 |
| `reclaim`：提交       | 同一 SQL 事务中将操作设为 `RELEASED`、绑定设为 `RELEASED`、仅清空其 active slot、推进物理 revision 为 `RELEASED`，保留数据所属租户。 | 无。                                                          |

每次修改前先持久化意图，响应有大小上限。丢失、不完整或未记录的响应保持 `UNKNOWN`。相同 Pod UID/resourceVersion 的 DELETE 尝试不得重发。只有 metadata PATCH 可以在新鲜 GET 确认原 UID、修改前 finalizer 集合和相同或更新的 resourceVersion 后有界重试。每次 PATCH 都测试 UID、resourceVersion 和精确的修改前 finalizer 集合；成功写入推进版本，拒绝旧副本。保留每条旧 `UNKNOWN` 和 SQL claim-generation 围栏。这样 PATCH 前崩溃可以恢复，不必等待无关的 Pod 变化。后续观察证明清理完成时，不得把早先 `UNKNOWN` DELETE 改写为成功。

回执独立于临时 HTTP 结果。只要精确的原删除中 Pod 已终止，且物理清理观察已经持久化，该事实可跨进程重启和 finalizer 移除保留。回执持久化前崩溃，需要重新观察；没有已存回执时，不能由 Pod 消失重建回执。持久化后崩溃，只恢复自有 finalizer 清理和最终 SQL 转换。即使已有清理记录，也拒绝同名替代 Pod。

旧 version-1 仅删除计划保持可查询和保守行为，不能追认没有准备步骤就被删除的 Pod。新计划冻结映射，终态查询不依赖当前映射或当前 owner 相等。校验原请求 actor 当前的 OWNER 授权、租户、Workspace 和 generation、不可变计划/回执 digest，以及终态绑定历史。已退役 Workspace 保持 `DRAINING`，不借用公开 Workspace 删除生命周期表示物理释放。

## 原子释放与锁顺序

沿用十秒事务上限与锁顺序：租户 placement guard、租户 publication guard、Workspace/access、原 runtime slot、原绑定、storage alias、物理 owner、退役操作，最后检查 Session/journal/RuntimeSession/execution 空闲。事务内不调用 Kubernetes HTTP。

最终提交时重新核对不可变计划与回执、精确原绑定和 generation、封存的 `DRAINING` 状态、没有 operation claim、原 handle/lease 身份、active slot、注册/保护、持有的 reservation ID/revision/seed 及空闲状态。要求与该回执关联的原 Pod 终态回读。通过专门的事务内 repository primitive 更新绑定，通用 binding CAS 继续禁止 sealed CSI 转换。

物理 CAS 仅为精确原 holder 清空绑定、reservation、注册与 provision seed 引用，保留数据所属租户，推进 revision 而不重置。仅清空精确 active slot，保留 last generation 和原请求身份。退役操作在同一事务中终结。任何身份不符或更新失败都整体回滚。过期发送者或 SQL 响应丢失后只读取终态回执，不能更改后续 holder。

通过 `WORKSPACE_RETIREMENT` 引用保留原绑定，包括终态记录。历史保留受显式维护历史策略约束；本改动不增加自动删除这些记录的行为。其他 Workspace 占用磁盘后，回执和原历史仍必须可读。

## 重复同租户交接

首次 CSI reservation 时填充并保留 `ma_storage_owner.tenant_id`。一旦数据 owner 存在，注册、查询和占用均拒绝其他租户。旧版本已占用行只能在精确原绑定/注册锁下回填，不得从新申请者推断原数据所属租户。

常驻归属使用单调递增的偶数 `RELEASED` 和奇数 `RESERVED` revision：`0 → 1 → 2 → 3 → 4 → 5`。每次执行、关闭、观察和退役均匹配原 handle 的精确 revision。私有 CSI 退役协议保留首次 `0/1/2` 判断，不能因本扩展而获得释放或复用权限。后续轮次只接受 resident profile；溢出或非法 phase/revision 均拒绝。

达到 `RELEASED` 后，管理员将唯一配置映射替换为同租户的另一个 Workspace，并按新配置重启。保留现有 PVC/PV、physical key、注册及文件。新 Workspace 使用新的 ID 和 request key，自己的 generation 从 1 开始，reservation 使用下一个物理 revision。旧 Workspace 和请求保持围栏。该配置动作就是显式数据交接，不因磁盘空闲而隐式分配。并发别名仍在物理 owner 上串行化，只有一个精确申请者能占用。

## 异常路径与回读

| 观察                                                                                            | 必须结果                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 忙碌 Session、活跃 writer、未结算 execution 或 RuntimeSession                                   | 拒绝维护，不增加新围栏，不释放。                 |
| API 不可用、响应丢失、Lease/heartbeat 过期、节点消失、boot ID 改变、分区或 out-of-service taint | 保留原 slot/owner 和关闭的准入，报告回收未完成。 |
| 原 Pod 被强制删除，或保存清理回执前已消失                                                       | 保留归属，不由缺失合成回执。                     |
| Pod/node/PVC/PV/保护/attachment 被替换，或容器身份改变                                          | 保留归属，不接管替代对象。                       |
| 释放事务提交前崩溃                                                                              | 恢复持有原归属的状态并继续回读，不允许部分释放。 |
| 提交后崩溃或响应丢失                                                                            | 返回相同终态回执，后续复用后也如此，不再次修改。 |
| 其他租户或旧 Workspace 尝试占用磁盘                                                             | 拒绝，保留数据租户边界与新 holder。              |

管理员可独立诊断和修复基础设施，但不因此取得异常产品释放权限。未来节点/存储隔离流程必须有独立审查的 API 契约与验收；本改动不提供 override 命令。CSI LOST 恢复和未知工具重放继续不在范围内。

## 受影响组件

扩展常驻退役 store 与维护入口、有界 Kubernetes HTTP client、事务内 binding repository、CSI reservation store、常驻执行/关闭/观察判断、规范 V1 schema 中的 operation state/work domain，以及 runtime retention guard。更新相关 Java、MySQL、进程崩溃测试及双语常驻部署说明。计划不修改 TypeScript、公开 API 或 OpenAPI。

规范 V1 的 work-kind domain 有变化。遵循 server 首次正式发布前的 schema 策略，重建开发 catalog；本改动不提供 V2 migration 或 catalog 升级路径。读取旧 version-1 退役计划属于协议保护，不代表旧 catalog 可以原地升级。独立保留卷中的文件。

## 验证与验收

详细忽略目录 E2E 计划位于 `.qwen/e2e-tests/13395-s2-s3-20261027/`。先以全局 CLI dry-run，若私有维护路径需要 Java/API fallback 则明确记录。环境准备、构建、定向单测及定向真实 MySQL/进程用例共同使用一个 600 秒本地 Java 验证预算；全量 profile 交由 CI，未覆盖检查单独列明。

必须验收至少三轮 reserve/release，在同租户不同 Workspace 间保留文件内容；revision 大于 1 时执行与关闭；拒绝其他租户和旧 Workspace；两个并发申请者；平台身份替换；API 及节点/网络分区时保留归属；重复及丢失响应；回执持久化和 SQL 提交前后崩溃；各释放写入点回滚；映射替换与后续复用后的终态查询。独立复核任务资源清理。

原生 ACK 验收必须记录 Kubernetes/CSI 版本及精确源码/制品身份，证明自有 finalizer 不依赖节点辅助进程即可允许容器终止、Node 卷清理、attachment 移除及最终 Pod 删除。若顺序不成立，完成条件不满足，释放保持不可用，并修改设计；单测 fixture 或 Pod DELETE 成功不能证明验收。健康正常完成与异常拒绝分别验收。在证据实际存在前，必要 CI profile 与完整原生验收保持待完成。

## 待验证的平台问题

将已记录的健康保留 Pod 清理结果扩展到要求的原生故障矩阵，以及任何不同的目标 Kubernetes/CSI 版本。核验生产 namespace/PVC 的独占使用以及不存在其他创建者/控制器；隔离运行已验证其自身的创建者准入边界。检查部署 RBAC 只增加该维护进程需要的 Pod patch/list、Node Lease get 和 PV/VolumeAttachment list 权限；隔离运行使用受信任管理控制面，未验收最小 RBAC。这些是平台验证任务，不能用来放松完成条件。
