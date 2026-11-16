# 常驻 Workspace 交付范围与平台托管回收

[English](2026-10-23-csi-evidence-source.md) | [简体中文](2026-10-23-csi-evidence-source.zh-CN.md)

## 状态与范围决定

2026-10-24，运维方同意将完整 CSI 审计移出 [#13395](https://github.com/QwenLM/qwen-code/issues/13395) 首版前置条件。本文件沿用原路径并替代此前 P1 证据来源提案。[已发布的原提案](https://github.com/QwenLM/qwen-code/issues/13395#issuecomment-6363776281) 转为历史记录；原 P1 → P2 → P3 → P4 依赖链由下述交付计划替代。首版不再等待插件提供审计 hook。

审计撤出时，未发布切片已恢复到其历史基准 `7ab5a95c61d5785ac66e50144e41ce29a7cf4cd5`。后续原生 S1 验收单独固定为 main `2c0c9fa8dc4a8ea5ec688060549e0ff0aed717b4`。最初的范围调整只改文档；2026-10-25 运维方要求在同一 PR 中实现下述两项 S1 修复。这些修复和后续同步主干均不会将原生验收结论扩展到已测版本之外。本工作不新增回收服务。平台托管回收、自动释放物理归属和跨 Workspace 卷交接仍是后续工作。范围调整不代表整个 issue 已通过验收。

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

保留已有 `WORKSPACE_RETIREMENT`、`POD_DELETE_ATTEMPT`、私有 CSI 退役、runtime recovery、retention 和诊断 reader。不增加无消费者的 feature flag、来源配置或证据 ingress。撤出本身只改变文档与计划；后续下述 S1 修复修改运行时准入，不改变 schema。归档的撤出比较指向此前历史基准，不代表当前主干验收。

## 本 PR 的 S1 修复

两个独立 resident 容器均挂载到 `/workspace` 不代表共享存储。内存和 SQL 放置围栏仅在双方请求均选择精确的 resident capability、Workspace isolation 和 `kubernetes-workspace` provisioner 时，忽略共同规范路径。相同 tenant/Workspace 或存储身份仍阻止新放置，涉及非 resident 请求的路径维持原规则。注册物理归属、原 slot 校验和退役准入继续作为权威；不同存储 alias 不授予占用中物理卷的使用许可。

SQL resident 判定与内存请求判定的实际边界一致。请求构造器要求 Workspace isolation 的 isolation key 为 null；独立的 `storage_id IS NULL` 阻塞分支又阻止缺少 managed context 的行使用路径豁免。这两项不变式均不能绕过相同存储或相同 Workspace 的阻塞分支。

保存的 `hosted-workspace-files/1` profile 同时允许普通和 resident Workspace，因此构建模型 catalog 前必须先解析已保存的 capability。没有显式 profile、也没有 Shell/MCP/Hook/publication 依赖的旧文件 Turn 遵循同一规则。已知非 resident profile（包括 Shell、MCP、文件搜索和只读 profile）保持原声明路径，不进行这次查询。新增内部 `POST /internal/runtime-broker/v1/runtimes:capabilities` 经由已有 Harness Session 的 admission resolver 解析并仅返回 scope。请求体精确为 `protocolVersion`、`requestId`、`harnessSessionId`；响应增加 `scope`，其中包含 `tenantId`、`workspaceId`、`workspaceGeneration`、`isolationClass`、`capabilityDigest`。它使用已有 Broker 鉴权和 lifecycle-authority 校验，不创建 binding、Pod、Runtime Session 或 storage reservation，不返回 worker 凭证或 endpoint。该路由以保存的 Harness Session 解析出的 Workspace 为范围，不接受调用方指定 Workspace，也不回退 primary runtime。

Hosted client 共享并发解析请求，保留成功校验的 capability，失败时清除该次请求，使后续调用可以重试。它使用 warm/acquire 相同的 scope parser 校验。Broker 提供新路由时，catalog 构建只等待 metadata 读取，物理 warmup 仍并行进行，纯文本推理不等待 Pod Ready。旧 Broker 返回 HTTP 404 时，文件 Turn 改为等待已经发出的原 warm 请求，使用该请求校验后的 capability，不再次发送 warm。此兼容路径可能等待物理就绪。鉴权、传输、HTTP 503 或 scope 失败均不降级为普通工具；warm scope 缺失或属于其他范围时也被拒绝。

resident 运行时词表仅包含 `read_file`、`write_file`、`edit`；模型返回不支持的调用（含客户端主动 Skill）时，在 acquire、prepare 和 dispatch 前持久化为可纠正的整批拒绝。已有公开 Plan 模式保留 Harness 本地处理的 `exit_plan_mode` 控制：计划活跃时声明 Read 和计划退出，持久批准后恢复 Write/Edit，计划退出不 dispatch 到 worker。

对旧 Harness 或直接调用 Broker 的客户端，有效但不支持的 resident payload 在 dispatch 前拒绝。仅当原 identity、version 和 `PREPARED` 状态仍匹配时，使用已有原子 `settlePrepared` 写入 `not_started`、空 `responseParts`、显式 `capture: null` 和 `resident_tool_unsupported` 错误。dispatch generation 保持零，不调用 worker。发生 claim 竞争或已有 `UNKNOWN` 时，Broker 返回已保存记录，不改变其结果。worker HTTP 错误和未知副作用不能转成未开始执行的本地证明。

回归覆盖各保留故障/退役状态下独立 resident 存储共用 mount path、仓库重启及真实 MySQL，并保留相同 Workspace/存储和非 resident 路径拒绝。工具检查覆盖只读且有鉴权的能力解析、并发查询及失败后重试、旧路由 HTTP 404 时合法或异范围 warm scope、非 404 失败拒绝、普通 profile 无 metadata 请求即可声明、resident catalog 与伪造调用、dispatch 前结算、重复请求及已 dispatch/unknown 工作保留。原审批、媒体和故障消费者须保持原行为；故障 driver 将能力路由归为 Harness scope，同时保留 Runtime 身份及不重放断言。真实进程 Hosted 文件交接仍为独立必需检查。本地检查与 CI 不替代修复版本上的新一轮原生 ACK 验收。

## 后续平台托管回收

[S2/S3 回收设计](2026-10-27-resident-workspace-reclamation.zh-CN.md) 规定拟议的完成条件、原子释放与保留数据交接契约。其实现与平台验收独立于下文的历史 S1 证据跟踪。

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

在 `2c0c9fa8dc4a8ea5ec688060549e0ff0aed717b4` 上的原生 S1 验收发现一项放置阻塞：某个常驻 binding 进入 `DRAINING` 后，同租户的新 Workspace 即使拥有不同的注册磁盘和存储身份，也可能因 `runtime_placement_recovery_required` 失败。放置围栏还会匹配共同的 `/workspace` 规范路径。已有的独立 binding 仍能继续使用，但这不能证明独立冷启动不受影响。在 [#13395](https://github.com/QwenLM/qwen-code/issues/13395) 中保留该失败；独立测试租户上的验收不能冲销它。S1 需要先解决并验证这一边界，才能通过验收。

同一轮原生测试还发现第二项公开工具边界阻塞：实际模型 catalog 声明了 `web_fetch`，原 resident worker 却返回 HTTP 409 拒绝。没有注入响应故障，已 dispatch 的调用仍停在 SQL `UNKNOWN`，后续 Session 被 `workspace_busy` 拒绝。携带真实鉴权的探测确认同一原 worker 精确拒绝不支持的工具，前后 Read 均成功，但这不能证明公开 catalog 正确。S1 验收前需要让声明能力与 resident 准入一致，并验证已知不支持的调用不会卡住 Workspace。MCP catalog 和缺少 Hook catalog 的观察不代表有副作用的 MCP 或 Hook 执行通过验收。

最初的文档调整检查归档撤出比较、无遗留生产引用、双语一致性与 Markdown 引用。S1 运行时修复需要独立的定向 Java/真实 MySQL 与 Hosted 进程证据、TypeScript build/typecheck 和受影响消费者测试，以及适用的完整 CI 门禁。保留精确的历史 S1 源码 pin；此前文档检查和撤出证据来源测试均不能验证新的运行时增量。

后续 S1/S2/S3 验收继续区分源码实现、定向测试、CI、原生 ACK 资格与生产就绪。此前在 `c61044fae46cfeed70b882140730c0caaa944524` 上的 ACK 测试覆盖同 Pod/PVC 文件交接和有界退役，不能验证新的源码版本或物理回收。先解决 S1 验收阻塞，再推进 S2 的完成/隔离契约；插件审计能力是否可用不再是前提。

## 参考

- [常驻部署](../../deploy/k2-resident/README.zh-CN.md)与[有界空闲退役](2026-10-20-k2-physical-retirement-progress.zh-CN.md)。
- [Kubernetes 删除语义](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/)：强制删除不等待进程终止。
- [Kubernetes 节点关机](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)：节点异常与强制 detach 需要特殊处理；设置 out-of-service taint 前需确认节点已经关机或断电。
