# 外部 Hosted Workspace 运行时（第二阶段）

[English](2026-10-25-external-hosted-workspace.md) | [简体中文](2026-10-25-external-hosted-workspace.zh-CN.md)

状态：**step 3a（供给前置层）已实现，产品能力仍未实现**。接续阶段一 `docs/design/2026-10-23-external-runtime-provider.md`（external-scratch，已认可的契约）和已实测完成的 Aone 适配器链路。本阶段不削弱阶段一的任何性质：在首次远程调用前持久化确定的逻辑 handle、丢响应后禁止替换、不提供 release‑to‑kill、Broker 独立 attest、provider 按 `provisionRequestId` 幂等。

## 1. 本阶段存在的原因

阶段一能分配并 attest 一台 session 隔离的 worker，但**没有真正的工具消费者**：未绑定 Workspace 的 Session 没有 Hosted 工具档案，模型拿不到任何工具声明，worker 只能等到 provider TTL 到期而被回收。本阶段的目标：

- 绑定外部 Workspace 的 Hosted Session（provision 在厂商沙箱平台上）获得全套文件工具（`read_file/write_file/edit/glob`）和前台 shell（`run_shell_command/monitor`），可见性、审批与持久化语义与 local‑process 路径一致。
- Broker 进程丢失或 adapter 进程丢失后，存储归属与 session 绑定语义完全保住；出现歧义时保留归属、绝不悄悄换 worker 或换存储密钥。

本期显式不做：公网浏览、MCP、目录导入、子 Workspace、快照、迁移，以及完全动态按申请分配存储（按需分配存储属于 [阶段一的 Workspace 扩展要求](2026-10-23-external-runtime-provider.md#required-hosted-workspace-extension) 第 7 条；本文的 §7 是前台 shell 的 publication）。

## 2. 与 external-scratch 的关系

| 维度                    | external-scratch（阶段一，已上线） | external-workspace（本设计，阶段二）                                      |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| 模型可见工具            | 无                                 | 完整 Hosted Workspace v1 档案                                             |
| worker boot             | boot‑v1（容器）                    | boot‑v2（容器内新准入，§6）                                               |
| worker 终止             | provider TTL                       | `stopDrained` 证明或 TTL；释放前走存储归属护栏（§8）                      |
| 存储身份                | 无（只有 scratch cwd）             | 注册、有 revision、加护栏（§4）                                           |
| provisioner handle 家族 | `external` v1                      | `external-workspace` v1（不同 kind，绝不允许重解释）                      |
| Provider HTTP 补充      | `provision`, `observe`             | 追加 `storage:provision`、`storage:observe`、publication/capture（§5/§7） |
| Workspace 状态机        | —                                  | 与 LOCAL/SSH_LOCAL 同状态机，ownership 新增 `EXTERNAL` kind               |

部署侧通过 `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace` 显式开启，且相应 Workspace files/shell 同时被配置打开。阶段一的 scratch 档案与 `validateExternalRuntime` 校验保持不变。

## 3. 身份与持久化契约（延续阶段一）

传输层完全复用：鉴权 HTTPS、POST、禁止重定向、64 KiB 请求/响应上限、`Cache-Control: no-store`、`protocolVersion: 1`、错误消息做脱敏。增加的几条：

- **worker API 的 ingress** 跑在一个额外被转发的端口上（worker 的 publication 服务，§7）；它是 worker/控制面边界内的转发入口，不是公网 ingress；通道使用 bearer + lease/domain 头校验，绝不与 attest 端口的身份面共用。
- **durable 注册操作**必须先于任何 Workspace 绑定的创建，且和 provision 一样：第一次 HTTP 前先发持久逻辑 handle、按请求 ID 去重、拒绝冲突的后续回复。
- 摘要继续用 canonical‑JSON sha256（token‑free）。registration 不允许同时启动 worker。

## 4. 外部存储注册（session 真正绑定的"Workspace"）

远程 Workspace 是存储，不是 sandbox。注册由操作方控制面发起（不是用户代码）：

1. 操作方通过公共注册 REST（loopback 限制）向 Managed Agent 注册两组元组：
   - `ExternalStorageIdentity = {providerId, physicalKey, registrationRevision}` —— provider 侧分配、不可变、单 tenant 单存储实例的唯一标识；**不是 sandbox ID**（sandbox TTL 到期即消失）。
   - `StorageAlias = {tenantWorkspaceId, aliasPath, mountRoot}` —— 用户侧的 Workspace 身份，以及 worker 内的绝对挂载根（路径必须 canonical、非根、属主可写、`0700`）。
2. 服务器在 `WorkspaceStorageGuard` / `WorkspaceExecutionStore` 里新记录 ownership kind `EXTERNAL`，定义与 LOCAL/SSH_LOCAL 相同约束：
   - 同样的 SQL writer/generation 护栏；
   - 跨外部注册的 tenant 存储别名唯一性（跨 tenant 的别名冲突 = 硬冲突 409，绝不接管）；
   - 元组绑定按单 tenant 严格遵守——sandbox 的 physical key 注册给 tenant A 后不能被换绑给 tenant B，除非操作方签了独立的 re‑registration 事件。
3. adapter 收到 `storage:provision` 用来告诉新 worker 准备好的存储树位置（alias 的 mount 根），`storage:observe` 用于运行状态与连续性探测（v1 原样返回阶段一的状态集，另加一个带 `continuity: "confirms"|"denies"|"unknown"` 的 `storage` 证据对象——这是 Broker 在允许写入前用到的成本低廉的连续性 witness；线上 schema 与状态映射见下）。

用一句话概括：durable 注册在重启后仍然存在；sandbox 轮换（新 sandbox 拿到同一 alias+physicalKey）只会映射到一台新 worker，**不会**重新开启新的 workspace 谱系。

**`storage:observe` 线上 schema（本 profile）。** 请求完全沿用阶段一 observe（`protocolVersion: 1`、`provisionRequestId`、`identity`、`handle`，64 KiB 上下限、禁重定向、`Cache-Control: no-store`）。响应保留阶段一的 `state`/`endpoint` 字段（`endpoint` 只在 `RUNNING` 时出现），只新增一个承载存储证据的 `storage` 对象：

```json
{
  "protocolVersion": 1,
  "state": "RUNNING",
  "endpoint": "https://worker.example/",
  "storage": {
    "storageRef": "sha256-of-canonical-storage-identity",
    "mountRoot": "/workspace/storage",
    "continuity": "confirms"
  }
}
```

**已实现形态（step 3a）。** 上面三个成员就是 step 3a 校验的全部集合，且是闭合集合：`storageRef`、`mountRoot`、`continuity`，三者必填，不接受其它成员。`mountNonce` 属于本设计的更宽集合，但现在无法校验 —— 持久注册记录没有 nonce 字段，worker 上报的 nonce 会是一条无法验证的声明。因此带 `mountNonce` 的回包会被**明确拒绝**（`external_storage_registration_mismatch`），而不是收下后忽略该成员；把 nonce 纳入记录属于 step 3b，因为注册 REST/写路径是阶段一已发布的面。`storageRef` 是注册身份元组 `{providerId, physicalKey, registrationRevision}` 的 canonical‑JSON SHA‑256（成员按名排序、revision 为 JSON 整数、小写十六进制），不含额外的包装成员。

`state` 就是阶段一 observe 的成员，只取四个值——`RUNNING`、`STARTING`、`UNKNOWN`、`GONE`——本 profile 应答在 `protocolVersion: 1` 上，不允许出现第二套状态词汇；其他任何取值都按阶段一的做法阻断采用。`storage` 只承载存储侧证据，自身不携带状态：它只在 `RUNNING` 时出现，而缺少它的 `RUNNING` 等于没有证据，不能授权写入。本文别处对本 profile 使用的 `READY` 是 Broker 本地判定（定义见下），绝不是线上取值。

| `state`    | 阶段一含义                                                   | 本 profile 需要的证据                                                                                              | 允许的动作                                                                |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `RUNNING`  | worker 的 HTTP(S) origin 有应答；采用仍需 Broker 独立 attest | 存在 `storage` 证据：注册的存储树已在 `storage.mountRoot` 落地、marker 与注册记录一致、publication 就绪 probe 通过 | 只有在 `continuity: "confirms"` 时才能写入；也是唯一允许报 `READY` 的状态 |
| `STARTING` | 已分配但尚未对外服务                                         | 没有 `storage` 证据；provision 已接受，存储树或 publication 面尚未就绪                                             | 不写入、不替换；重试 `storage:observe`                                    |
| `UNKNOWN`  | 不确定：超时、应答歧义或不可解析                             | 什么都无法确立                                                                                                     | 保留归属、不写入、不替换；重试                                            |
| `GONE`     | 不存在；阻断采用且绝不触发替换                               | worker 与其 sandbox 已消失                                                                                         | 绝不采用、绝不替换；存储归属与其护栏继续存在（§8）                        |

`READY` 是 Broker 本地判定：`state == "RUNNING"` 且 `continuity: "confirms"`，且 publication 就绪。它只用于允许写入和对外宣告 Hosted 工具档案，不能替代独立 attest，也不会由其他状态报出。`continuity: "denies"` 在任何状态下（包括 `RUNNING`）都禁止写入，也绝不构成替换授权。

## 5. guard/store/resolver 的归属扩展

- `WorkspaceStorageGuard` 新增 `EXTERNAL` kind，containment 校验永远比照**注册过的 worker 侧挂载根**执行，从不走中心 `Files` 调用本地路径；所有文件操作都在 worker 内完成 containment。
- `WorkspaceExecutionStore` 新增 `EXTERNAL` kind，授权路径做既有的 SQL 护栏；guard 的 storage version 只在 registration/retirement 变更时推进。
- `WorkspaceRuntimeResolver` 只有在被绑定的 alias 解析到**完整**的 `ExternalStorageIdentity` 元组（`providerId`、`physicalKey`、`registrationRevision` 三项全中）时，才把该 alias 绑定到新 kind 的 provider；三个成员一律取自 durable 注册记录，不取自 alias 文本，也不取自请求载荷。`registrationRevision` 是各实例各自计数的，所以 `(providerId, registrationRevision)` 在存储实例之间并不唯一：只按这两项匹配，会让另一把 physical key 冒领原本绑定在前一把上的 session。任一项不匹配即与 §4 同级的硬冲突（409，绝不接管）——不做部分匹配，也不回退到只看 alias。

以上三处都是量较小的表盘式拓展；对远端 worker 的可达性检查只发生在 `provision/activate/verify` 边界，不做对每笔文件操作。

## 6. Worker 准入：容器内 boot‑v2（CLI 变更）

今天容器模式会拒绝 boot‑v2。本阶段在 CLI 增加 `managed-runtime-boot/2` 的容器准入（一份新的闭合文档，不是既有 boot‑v2 键集的扩展），并配置**存储侧的偏执校验**：

- 本阶段引入一份**新的闭合 boot 文档** `managed-runtime-boot/2`，而不是往既有的 `ManagedContextBoot` boot‑v2 键集里加字段。那份文档由精确键列表校验解析（`readClosed` 会拒绝排序后键列表不等于预期十六项的文档），往里加成员会让所有已发布的 boot‑v2 文档、以及包着它们的 CSI v3–v6 信封全部解析失败。新文档有自己的版本号和自己的闭合键列表，既有 boot‑v2 解析完全不变 —— 这才是"对已发布 worker 惰性"的含义。
- 新文档携带一个 **provider 中立**的存储成员 `externalStorage: {kind: "external", storageRef, mountNonce, aliasPath, mountRoot}`，其中 `aliasPath` 与 `mountRoot` 是这个对象内部的成员，不是新文档的第二个顶层 mount 根。成员名为 `externalStorage` 而非 `storage`：已发布的 `ManagedCsiBoot.storage` 已经承载 `physicalKey`、`registrationRevision`、`driver` 等 provider 专属字段，同名会让同一个信封家族里出现两套不兼容的定义。`storageRef` 是注册 `ExternalStorageIdentity` 的 canonical‑JSON sha256（沿用 §3 摘要规则），`mountNonce` 是控制面下发的不透明值 —— 因此**本文件**既不出现 `physicalKey` 也不出现 provider ID，阶段一"不要把 provider 专属字段塞进闭合 boot 文档"的规则对它成立；CSI 文档自带的 provider 字段不受影响。revision 漂移已包含在 `storageRef` 里，重新注册只会改变 worker 唯一能看到的那一个存储标识。
- 绑定证明（不变式：绝不挂载与被 Broker 绑定的那份存储不同的存储树），worker 必须在对外服务前逐项通过：
  1. 路径属性：绝对、规范化、落在允许的根之下、`0700`、属主可写。
  2. 由控制面落地而非由 worker 创建：控制面创建 mount 根，并把绑定 marker 写到**containment 根之外的、仅控制面可写的兄弟路径** `<aliasPath>/../.qwen-storage/<alias>.json`（`0600`，属主为 worker uid，组/其他不可写），绝不放在 session 的文件工具与 shell 能够触达的树里。§5 的 containment 以 mount 根为界，因此该 marker 无法被 `write_file`/`edit`/`run_shell_command` 写入或删除：租户负载拥有的是那棵树，不是它的父目录。worker 永不创建 mount 根，原先"已存在或能被它创建"的捷径因此被替换：目录不存在或是空目录一律拒绝，不做补齐。
  3. marker 比对：marker 里的 `storageRef` 与 `mountNonce` 必须等于 boot 断言，而该断言随既有的闭合、带 token 签名信封下发。旧 boot 文档被重放到后来重新落地的存储树时，会在新签发的 `mountNonce` 上失败；别人的目录或空目录则根本拿不出 marker。
  4. 回执：worker 记录 mount 根的 device 与 inode，随 publication 端点一起回传 `{storageRef, mountNonce, mountRoot, rootDevice, rootInode}`。这组坐标只是佐证；marker 才是绑定证明。
  5. 无兜底：任何一项失败都在 publication 服务启动之前、任何工具调用被服务之前闭合拒绝，绝不退化成落本地目录，也绝不退化成未落地的 alias 路径。若是**轮换后**的 worker 上 marker 缺失或对不上，本次 boot 直接拒绝并要求控制面重新落地 marker；这既不是下面那种需要操作方介入的重新注册冲突，也不会把 alias 永久锁死。
- Broker 在报 `READY` 或允许写入前，会从注册记录里重读 `storageRef`/`mountNonce`（nonce 是控制面落地存储树时签发的），与 boot 回执及 `storage:observe` 两处对齐；回执里的 `rootDevice`/`rootInode` 随绑定一起落库，供之后的重新 attest 或 `storage:observe` 证明仍是同一次落地。与**注册记录**不一致时需要操作方重新注册，属硬冲突，绝不换一个根重试，也绝不替换 worker；轮换后仅 marker 不一致的情况走上面的重新落地路径。
- Worker 同时跑 **publication 服务**（`/internal/managed-runtime/v2/publication:*`，见§7）并把这个面写进就绪回执；`observe` 在向 Broker 报 `READY` 前会先打 publication 就绪 probe。
- `isolationClass: session` 已锁定一台 worker 一个 session；任何一个新 alias 都只会在这台 worker 上激活存储 context。

worker 是闭合 boot 路径里的可信代码：这些校验用来拒绝缺失、他人或空的根目录，而不是把被攻陷的 worker 变成诚实的——worker 身份仍由阶段一的 attest 负责。

拒绝原因对未认证调用者不回显物理路径，与 boot‑v1 语义一致。

## 7. 前台 shell 的 publication 与 capture

前台 shell 在远端的最大缺口是**证据可核查**——一次 close 之后必须能说明谁看到过什么，以及这次 close 会不会留下无法追溯的副作用：

- worker 额外暴露一个受限的 publication 面：`publication:begin` 按每次执行携带被 capture 的输入 identity 开启 channel；stdout/stderr/pty 各带逐序列持久 receipt；通道字节上限与本地 shell 相同，原始输出只落在自己的 `0700` publication 目录（secret/自然语言过滤是后续话题，与本地行为的对齐不在本条范围内）。
- Broker 与本地读取完全一样的形状走 `publication:read`；未知 channel 或过期 lease 直接 closed 错误，绝不退化成"没 capture"。
- `stopDrained`（§8）会把每个 channel 最终 receipt 写入结尾区；close 只有在所有 channel drain 到 end‑of‑stream 时才允许结束。

本期只支持前台 shell；后台 shell（`is_background`）留作下一步，有它自己的证据制度。

## 8. 精确 worker 的 `stopDrained` 与存储归属护栏

任何"自闭合/自恢复"策略都需要证明**原 worker 不再写入**：

- Broker 用 lease/domain/revision 头去 worker 问 `publication:stop-drained?channel=all`，回答限定三种：
  - `drained` —— 通过 worker 自身 per‑channel receipts 做只读面行为校验；Broker 才能关闭 storage 并退役 binding；
  - `undrained(channel seq)` —— close 必须保持推迟，本次仅许可只读；
  - `unknown` —— 禁止关闭，也禁止替换；sandbox TTL 可以回收 CPU，但 storage 归属护栏保持不变。
- sandbox 过期/GONE **不是** drain 证明；worker 崩溃**不是** drain 证明；本 profile 继续沿用阶段一规则，`release` 仍是无操作（真正的 kill 授权只属于 storage 的 owner‑fenced stop 路径）。

远程监督进程会把每个任务生命周期的 receipt 写到 worker 的私有 publication 目录中（所有敏感都不写入任何 release 载荷），因此 adapter 重启也能靠**重读 receipts**来重新断言 drain 状态，而不是靠信任崩溃事实。

## 9. 操作方适配器（Aone，私有库）步进

`scripts/qwen-runtime-provider/` 的变更：

1. 完全复现已实测过的机制：durable create‑only journal、writer lock、boot 上传、run‑up 等待、无 mode 上传、单次 launch、request‑ID 去重、attest probe。阶段一的 provision/observe 语义一字不改。
2. `storage:provision` / `storage:observe` 实现：第一版要求**操作方预注册 physical key**（申请即建存储池只留到第二阶段后期）。
3. 启动 worker 时使用 `managed-runtime-boot/2` 文档；在向 Broker 报 `READY` 前先做一次 publication ingress probe。
4. TTL 处理扩增：adapter 的 observe 顺带返回 `remaining_seconds`；central 在 sandbox 到期之前先做一次 stopDrained，用来做证据整理和归属闸门判断。

这些 API 不需要上游感知 Aone 的任何元数据；认证/令牌/线上形状与阶段一一致。

## 10. 验证矩阵

| 层面                 | 必备证据                                                                                                                                                  | 证明路径                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 存储注册单元         | alias/tenant/revision 冲突注册被拒绝；预 commit 落库；续注册保持身份                                                                                      | 新增 guard/store/resolver 单测    |
| worker 准入单元      | `managed-runtime-boot/2` 被接受，且已发布 boot‑v2 文档仍能解析；containment 根之外的 marker 无法通过工具调用写入或删除；marker 缺失、伪造或对不上均被拒绝 | CLI container 单测                |
| publication/capture  | begin/read/receipt 语义；字节上限；过期 lease 拒绝                                                                                                        | worker 单测                       |
| stopDrained          | drained/undrained/unknown 与 close gating                                                                                                                 | worker+Broker IT                  |
| Broker + 真实 worker | Aone 上全流程：注册 → 摆放 → attest → write/read/edit/shell 前台 → drain 后 close                                                                         | 扩充阶段一的 full-tier fault 套件 |
| 公开 Hosted E2E      | Session 工作流中模型可见工具；approval 卡片可据捕获输入重建；restartBroker + restartAdapter 保持 storage 谱系                                             | 完整 Public Hosted 验收           |

## 11. 提议推进顺序

1. guard/store/resolver 扩展和注册 REST（仅引入兼容 API，默认不接线启用）。
2. CLI `managed-runtime-boot/2` 容器准入与 publication 服务（暂无消费者，且既有 boot‑v2 解析不变 —— 在此意义上惰性）。
3. provisioner 档案 `external-workspace` 和 `storage:*` 端点（灰色开启，部署方显式勾选）。
4. stopDrained + close gating；之后用显式开关才启用 Hosted 工具列表。
5. full-tier 公共 Hosted E2E；此时才在文档里写"该档案可生产**文件/命令**功能"。

每一步都可以独立回退。阶段一的契约与其 fault‑gate 证据是基础——本设计只在其上补充能力：**不改变状态机的核心断言**，只做受控的能力扩展。

## 12. 已实现的 step 3a：供给前置层

step 3 的第一片以 Broker/适配器前置层的形式落地，而不是产品能力。它新增
`external-workspace` provisioner kind，但用户侧还无法触达：

- **kind 与传输。** `ExternalWorkspaceProvisioner` 继承已上线的 `external-scratch`
  provisioner：放置、持久 handle、按 `provisionRequestId` 幂等、启动恢复、attest 与
  release 为空操作，全部复用同一段代码而不是复制。`ExternalRuntimeKinds` 把该家族
  命名一次；配置校验、provisioner 工厂、preflight broker 检查与重试/恢复分类都用它，
  新 kind 不会静默落入"零校验"或"永久恢复阻塞"的分支。
- **存储身份只来自持久注册。** `ExternalStorageRegistry` 是 `ma_storage`/
  `ma_storage_owner` 的只读视图；provisioner 每次准入都按 `(tenant, alias)` 解析，
  并以永久错误码拒绝（`external_storage_registration_not_found`、
  `external_storage_registration_mismatch`、`external_storage_continuity_denied`）。
  provider 身份、physical key、revision、alias 路径与 mount root 一律与注册记录比对，
  绝不与请求或 provider 回包比对。查询使用注册记录的主键（与写入路径插入的 alias key 相同），
  按 owner 行的主键关联该行，且只接受 `REGISTERED` 状态；`RETIRING` 或 `RETIRED`
  均视为未注册。revision 不得超过 2^53-1，这是协议两端均能精确表示的最大整数。
  `storageRef` 是注册身份元组（providerId、physicalKey、registrationRevision）的 canonical-JSON SHA-256；
  revision 变化会让既有 handle 不可采纳，而不是悄悄重绑。无法完整读取查询结果时，返回可重试的
  `runtime_external_unavailable`，使 Broker 保持该 placement 可采纳；已经读出的行若自身信息
  不一致，则永久拒绝。
- **boot 文档不变。** Broker 铸造已上线的 `managed-context/1` 文档，并追加已被 worker
  准入的 `storage` 成员（`kind/physicalKey/aliasPath/mountRoot/registrationRevision`），
  在 `session` 隔离与 Workspace capability digest 下由现有 worker 接受。因此本片
  **不改 CLI/worker**，也不取代 `2026-10-25-external-container-publication.md`：
  `storage` 扩展与 adapter 写出的 `registration.json` 描述符语义保持不变，worker 仍以
  `0700` 创建缺失的 mount root。
- **可选存储证据。** provider 可在 `RUNNING` 上返回
  `storage: {storageRef, mountRoot, continuity}`：`confirms` 采纳，`unknown` 保留归属
  但失去就绪证据，`denies` 永久拒绝，缺省证据保持阶段一语义（本片不授权任何写入）。

本片**不做**：Hosted 工具档案与 EXTERNAL 执行准入（§5）、前台 shell publication 消费
（§7）、`stopDrained`（§8）与关闭门禁。因此 `supportsDrainedStop()` 保持 `false`，
放在该 profile 上的 Session 无法关闭；配置校验对两种 external kind 仍要求所有 managed
Workspace 特性关闭。于是本 provisioner 是**可配置，但暂时放不下任何 Session，且每次放置
都 fail-closed**：它通过配置显式开启，preflight 会给出一条前置警告说明这一点，只有组件
测试与契约测试会驱动一次放置。

**#15512 并未完成。** 文件工具执行（`read_file`/`write_file`/`edit`/`glob`）、前台
shell、审批、capture 以及可验证的 close/drain 仍未实现；在这些落地并验证之前，该
profile 不可用于 Hosted 工具。

相对 §6 的已知偏离（留给后续片）：不新建 `managed-runtime-boot/2` 文档、不反转
mount root 归属、不返回 `rootDevice`/`rootInode` receipt。这些属于 worker 契约变更，
而 `storage` 契约已经是公开的 adapter 面；仓库内没有生产者并不等于外部没有消费者。
