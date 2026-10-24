# 常驻 Workspace 交付范围与平台托管回收

[English](2026-10-23-csi-evidence-source.md) | [简体中文](2026-10-23-csi-evidence-source.zh-CN.md)

## 状态与范围决定

2026-10-24，运维方同意将完整 CSI 审计移出 [#13395](https://github.com/QwenLM/qwen-code/issues/13395) 首版前置条件。本文件沿用原路径并替代此前 P1 证据来源提案。[已发布的原提案](https://github.com/QwenLM/qwen-code/issues/13395#issuecomment-6363776281) 转为历史记录；原 P1 → P2 → P3 → P4 依赖链由下述交付计划替代。首版不再等待插件提供审计 hook。

已核对的实现基准为 `7ab5a95c61d5785ac66e50144e41ce29a7cf4cd5`。本次撤出尚未提交的证据来源切片，不新增回收服务。平台托管回收、自动释放物理归属和跨 Workspace 卷交接仍是后续工作。范围调整不代表整个 issue 已通过验收。

## 现有实现

[常驻 Workspace 执行](2026-10-14-k2-resident-workspace.zh-CN.md)支持在同一原 Pod/PVC 上运行公开 Read/Write/Edit Session。Session 成功关闭后结算工作、撤销其上下文并释放 Runtime Session；后续 Session 可复用仍满足资格的原运行环境。binding 保持 `READY`，物理存储归属保持 `RESERVED`。

[显式空闲退役](2026-10-20-k2-physical-retirement-progress.zh-CN.md)检查 Session 已终结、journal head 已封存或永久删除且 writer 已清除、Runtime Session 已释放、工具执行已结算，然后持久化封锁 Workspace 和原 binding 为 `DRAINING`，保留 active slot 和原存储 owner。它没有自动 TTL 触发或撤销退役的能力。

现有 `delete-pod` 对核验过的原 Pod 记录并发送有界正常 DELETE 尝试，带 UID/resourceVersion 前置条件、30 秒宽限期和 Background propagation，不等待终止。`RETURNED` 只表示已记录完整 HTTP 响应，包括非 2xx 响应，不表示删除、进程终止或卸载已完成。响应丢失或不完整时保持 `UNKNOWN`。退役持续保留 slot 和 `RESERVED` owner，不重新开放 Workspace 或创建替代 Pod。

## 首版契约

| 范围         | 交付边界                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session 交接 | 同 tenant/Workspace 和 generation、同一健康的原 Pod/PVC；前一 Session 关闭成功且通过现有准入检查后才能交接。                                                                           |
| 显式空闲退役 | 保留现有 `inspect`、`begin` 和有界 `delete-pod`，以及 SQL 持久封锁、重试和 readback 语义。                                                                                             |
| 资源保留     | 保留原 binding、active slot、reservation 和历史。维护入口不删除 PVC/PV、Secret 或保护对象。保留的存储和其他资源仍产生相应费用。                                                        |
| 平台信任     | 信任经过审阅的管理员、Kubernetes、宿主机和合格 ACK Disk CSI。保留 actor grants、原运行环境/mount 身份、registration/protection 校验，以及 RWOP、Filesystem、ext4 和 disk serial 匹配。 |
| 异常处理     | 节点失联、身份替换、超时、强删、Pod 缺失或结果未知均不能授予自动释放或交接许可，保留归属和准入封锁。                                                                                   |
| 部署         | 使用受支持的 CSI 部署和现有常驻配置。本范围不要求 CSI endpoint proxy、write-ahead 审计 hook、节点 recorder、CRI 访问或首次 publication 前的 enrollment gate。                          |

正常 Session 交接只在退役前可用。移除审计前置不增加恢复 authority，也不允许接管缺失或被替换的原 worker。Shell/MCP/Hooks、活动 Session 强制排空、自动替换和跨租户复用继续不在首版范围内。

## 撤出的本地实现

撤出本任务尚未提交的 `CsiEvidenceProtocol`、`CsiEvidenceStore` 及其 fixtures/tests，同时撤出 `CSI_EVIDENCE`/`CSI_EVIDENCE_PAGE` schema 和 operation kind、证据专属 retention 与 inventory 改动。对应 tracked Java/SQL/测试文件精确恢复到已核对基准。撤出文件和测试历史保存在本任务忽略目录快照中；此前测试描述被撤出的源码，不代表本版或平台资格验收。

保留已有 `WORKSPACE_RETIREMENT`、`POD_DELETE_ATTEMPT`、私有 CSI 退役、runtime recovery、retention 和诊断 reader。不增加无消费者的 feature flag、来源配置或 ingress。最终交付只改变文档与计划，运行时代码和 schema 保持已核对基准。

## 后续平台托管回收

下一份设计把正常容器终止和卷清理交给受支持的 ACK/Kubernetes 生命周期机制，完整 CSI RPC 历史不再是必选实现方式。在实现释放前，设计必须明确：

1. 原 Workspace、runtime generation、Pod/node、注册卷和当前 reservation 的精确资格与不可变身份关联。
2. 健康正常退出的受支持平台完成契约、权威观察，以及重启或响应丢失后的持久 readback。Pod phase、Pod 缺失、DELETE 返回、VolumeAttachment 消失和单一云盘状态均不能单独构成释放条件。
3. 节点失联、强删、超时和未知结果的独立异常路径。只有经过审阅的平台完成或节点/存储隔离流程满足新契约后才可解除归属；运维清理本身不修改产品归属。
4. 在同一数据库事务中重新验证新契约和当前 generation，再推进 retirement、binding、active slot 和物理 owner。旧 sender 和重复请求不能释放新 owner。
5. 数据保留/重置策略、跨 Workspace 和跨租户复用限制，以及崩溃、丢响应、身份替换和节点/网络分区验收。

以上是设计要求，不是已实现的判断条件或当前释放许可。本次没有资格化任何具体节点/存储隔离 API 或 ACK 完成信号。节点恢复和 CSI LOST 处理仍单独设计；未知工具副作用不能在替代运行环境中重放。

## 交付与验证

| 阶段         | 工作与完成条件                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| S1：首版收口 | 在精确验收源码和受支持部署上验证保留的 Session 交接与有界空闲退役，明确记录未完成的生产/安全资格项；不要求完整 CSI 审计。 |
| S2：回收设计 | 评审上述平台完成、异常隔离、数据策略和事务契约，选定受支持的平台 API，定义成功、拒绝和故障用例。                          |
| S3：回收实现 | 只实现通过评审的 S2 契约，再验收原子释放和重复复用；通过这些检查前不存在 S3 释放许可。                                    |
| 独立恢复     | 定义 CSI LOST 恢复和运维流程，不重新开放未知写入或绕过原 owner。                                                          |

本次调整验证 Server 的 tracked Java/SQL/测试与基准一致、撤出源码和 evidence kind 不再有生产引用、双语内容一致，以及 Markdown 格式和相对引用。没有新增运行时行为，本次文档变更不需要新的 CLI、Maven 或 MySQL 测试作为证据。此前证据来源测试快照保留为历史。

后续 S1/S2/S3 验收继续区分源码实现、定向测试、CI、原生 ACK 资格与生产就绪。此前在 `c61044fae46cfeed70b882140730c0caaa944524` 上的 ACK 测试覆盖同 Pod/PVC 文件交接和有界退役，不能验证新的源码版本或物理回收。下一项交付决定是 S2 的完成/隔离契约，不再是插件审计能力是否可用。

## 参考

- [常驻部署](../../deploy/k2-resident/README.zh-CN.md)与[有界空闲退役](2026-10-20-k2-physical-retirement-progress.zh-CN.md)。
- [Kubernetes 删除语义](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/)：强制删除不等待进程终止。
- [Kubernetes 节点关机](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)：节点异常与强制 detach 需要特殊处理；设置 out-of-service taint 前需确认节点已经关机或断电。
