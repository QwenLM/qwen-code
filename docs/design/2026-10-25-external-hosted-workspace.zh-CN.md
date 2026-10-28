# 外部 Hosted Workspace 运行时（第二阶段）

[English](2026-10-25-external-hosted-workspace.md) | [简体中文](2026-10-25-external-hosted-workspace.zh-CN.md)

状态：**A / step 3a / B0 / B1 / B2 已为精确的公开 external-files 档案实现；指定的文件/default 审批/安全关闭 E2E 已通过。#15512 尚未完成。** §14 记录当前里程碑及剩余门禁。接续[阶段一](2026-10-23-external-runtime-provider.zh-CN.md)（`external-scratch`，已认可的契约）和此前的 Aone 操作方适配器演练；该演练不是本里程碑的证据。本阶段不削弱阶段一的任何性质：在首次远程调用前持久化确定的逻辑 handle、丢响应后禁止替换、不提供 release-to-kill、Broker 独立 attest、provider 按 `provisionRequestId` 幂等。

**阅读顺序：**A 修订与 §§12–13 保留各切片当时的范围，不再表示当前一律拒绝准入。§§1–11 保留第二阶段的完整目标与提案；有差异时以 §§12–14 的已实现契约为准。尤其是新 boot 文档、nonce/marker 变更及 shell/capture 提案，不代表已经交付。

## 修订：有界切片 A（2026-10-27）

本独立增量使用 main 已有的外部存储登记，不依赖 #15654，也不复制其 registry/provisioner。`POST /internal/managed-workspaces/v1/workspace:materialize-external` 为已有 `REGISTERED`、`EXTERNAL` 别名建立元数据。其闭合、16 KiB 上限的 JSON 请求体仅接受 `registeredAliasId`、`displayName`、`ownerActorId`、`idempotencyKey` 及可选且仅用于追踪的 `requestId`。`registeredAliasId` 就是登记的 `tenantWorkspaceId`，不是路径或登记回执 ID。

现有精确 loopback 监听地址、本地/对端地址校验与 Broker bearer 凭证认证操作方委派授权的权限。经过验证的 `ownerActorId` 是**被授权人**，不是已认证调用者，也不是租户成员身份凭证。操作方必须选择正确的租户和被授权人；经验证的租户头限定登记查询、Workspace、授权和回执键的范围。公共签名及可信 actor 过滤器保持不变。仅提供租户头不能调用此路由。

新事务获取租户 placement-domain 锁，核对已存登记与 owner 的租户、别名身份/键、完整 provider/physical 身份、revision 和 mount root，并拒绝已有 Workspace、Runtime binding、holder 或 maintenance。登记 JSON 仍是权威：aliasPath 使用现有登记值规则验证，并不检测任意带外数据库篡改。操作仅原子创建 `ma_workspace`（`workspaceId = storageId = tenantWorkspaceId`、generation 1、`ACTIVE`、`ROOT`、固定 `WorkspaceExecutionProfile.CONFIG_REF`/`POLICY_REF`、不设默认）、一条 `OWNER` 授权和已完成的 `EXTERNAL_WORKSPACE` 回执。存储及其 `UNVERIFIED` owner 不变。不执行中心文件系统、存储分配、provider HTTP 或 worker 操作。

完全相同的重试返回原回执，即便授权已撤销、名称已改或 Workspace 已移除；不会恢复授权、名称或 active 状态。回执仅记录创建结果，不代表实时状态或执行权限。同一租户/幂等键下变更别名、显示名或被授权人会冲突。在仅有 A 的检查点，被授权人可读取发现结果，但 EXTERNAL 存储的 `canCreateSession` 和 WebShell `canSelectDirectory` 均为 false，批量 readable grant 也一致。当时空输入和带 prompt 的 Session 创建被现有 storage-kind 护栏拒绝。A 不激活 resolver、transport、execution 或工具档案；§14 为精确的 files 档案取代了这一准入限制。

独立回执 namespace 要求扩展现有枚举与 V1 CHECK。遵循发布前 fresh-catalog 策略：源码可以独立回退，但**不**承诺旧二进制能打开变更后的 catalog。任务/开发 catalog 应重建；不增加 V2 migration，不提升 schema version。

A 的验证包括 operator/tenant/闭合请求测试、精确回执重放与不复活测试、已存元组和忙碌 owner 拒绝、诚实的公共/WebShell 发现结果和真实 Session-service 拒绝，以及 MySQL 同键/异键并发测试。这些测试不是外部 Hosted 执行能力的证据。在该检查点，完整工具、drain/ACK 安全、恢复及公共 worker E2E 均留待后续增量；此后的有界进展见 §14。下文较早的执行提案必须先与已发布 boot/publication 契约对齐再实现；A 不实现也不认可第二套线上协议。

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

当前档案通过 `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace`、`workspaceFilesEnabled=true` 及 §14 的闭合配置/协商门禁选择。Shell 必须保持关闭。上表描述更完整的目标，不是当前准入工具集；`external-scratch` 仍拒绝 Workspace 特性。

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

原提案以容器模式拒绝 boot-v2 为前提，提议新增 `ManagedRuntimeWorkerBoot` v2 容器准入并进行**存储侧校验**。这不是已实现的 boot 契约（见 §12）：

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

前台 shell 与 `monitor` 仍是目标，不是 §14 文件里程碑的能力。后台 shell（`is_background`）留作后续阶段，有它自己的证据制度。

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

本节记录 B0–B2 之前的历史 step-3a 检查点。当时以 Broker/适配器前置层的形式新增
`external-workspace` provisioner kind，尚不是用户可触达的产品能力；下述准入限制已由 §14 取代：

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
  绝不与请求或 provider 回包比对。查询使用登记主键（与写入路径的 alias key 一致），
  按 owner 主键联表，只接受 `REGISTERED` 行；`RETIRING`/`RETIRED` 按无登记处理。
  revision 上限为 2^53-1，确保线上两侧精确表示。`storageRef` 是注册身份元组的
  canonical-JSON SHA-256；revision 变化使既有 handle 不可采纳，绝不悄悄重绑。
  查询未能完整读取时可重试（`runtime_external_unavailable`），Broker 保留放置的
  可采纳性；已读完但记录自身不一致时永久拒绝。
- **boot 文档不变。** Broker 铸造已上线的 `managed-context/1` 文档，并追加已被 worker
  准入的 `storage` 成员（`kind/physicalKey/aliasPath/mountRoot/registrationRevision`），
  在 `session` 隔离与 Workspace capability digest 下由现有 worker 接受。因此本片
  **不改 CLI/worker**，也不取代 `2026-10-25-external-container-publication.md`：
  `storage` 扩展与 adapter 写出的 `registration.json` 描述符语义保持不变，worker 仍以
  `0700` 创建缺失的 mount root。
- **可选存储证据。** provider 可在 `RUNNING` 上返回
  `storage: {storageRef, mountRoot, continuity}`：`confirms` 采纳，`unknown` 保留归属
  但失去就绪证据，`denies` 永久拒绝，缺省证据保持阶段一语义（本片不授权任何写入）。

step 3a **不做**：Hosted 工具档案与 EXTERNAL 执行准入（§5）、前台 shell publication
消费（§7）、`stopDrained`（§8）与关闭门禁。在该检查点，`supportsDrainedStop()` 为
`false`，放在该 profile 上的 Session 无法关闭，配置拒绝两种 external kind 的所有
managed Workspace 特性。当时 provisioner **可配置，但放不下任何 Session，且每次放置
都 fail-closed**：preflight 明确报告此前置限制，只有组件与契约测试驱动放置。这不是 §14
的当前行为。

**历史 step-3a 结论：**当时 #15512 未完成，文件执行、前台 shell、审批、capture 与
可验证的 close/drain 均未实现。此后文件工具、default 审批和指定的安全关闭 E2E 已落地
（§14），但完整目标验收与部署就绪判断仍未通过。

相对 §6 的已知偏离（留给后续片）：不新建 `managed-runtime-boot/2` 文档、不反转
mount root 归属、不返回 `rootDevice`/`rootInode` receipt。这些属于 worker 契约变更，
而 `storage` 契约已经是公开的 adapter 面；仓库内没有生产者并不等于外部没有消费者。

## 13. B0 修订：惰性的同源原生 drain

本节记录仅有 B0 的检查点：当时提供 drain 原语，不提供 Hosted 准入或完整关闭编排。下述惰性边界是历史记录；B1/B2 在 §14 接通该原语。以下 B0 决定取代 §§3、6、8 中关于独立 ingress 和 drain 证明的提议；§12 保留此前 step 3a 的范围记录。

- **同一个已保存 origin，既有路由。** external boot 将既有 publication 对象和 executor 注册到 worker 主应用，并将其路由加入 owned-route 门禁。原独立 publication listener 和 ready 通告保持兼容；两个 listener 共享退役与 channel 状态。Express 注册时转义 `publication:*` 路径中的字面量冒号，避免将其视为参数而匹配另一种操作；线上路径不变。Broker 使用持久化的 `RuntimeLease.endpoint` 独立 attest context，随后向 `/internal/managed-runtime/v2/publication:stop-drained` 发起 POST，请求体严格为 `{"protocolVersion":2,"channel":"all"}`。不引入第二个 endpoint，也不推算端口。
- **I/O 前校验原始身份。** provisioner 复用基类校验，检查已保存 request、seed、凭据和 canonical storage-bound handle，核对当前注册元组与已保留 endpoint，并要求 `external-workspace`、managed context、session 隔离和精确的 Workspace capability digest。原始信息缺失或冲突不产生 receipt；adapter 重启后使用完整的已保存身份，不分配资源，也不调用 provider observe。传输层在 attest 前拒绝重定向和被替换的解析 origin。stop 发送 Bearer、lease ID/epoch、`X-Qwen-Managed-Storage-Revision`、`X-Qwen-Managed-Runtime-Incarnation`、JSON 和 `Cache-Control: no-store`；boot 头的值在 attest 前固定。publication 不返回 response-incarnation 头，stop 也不要求该头。stop 信封限 64 KiB，超时或取消会关闭活动 HTTP 请求。
- **有限证据，不读取证明内容。** 仅接受 HTTP 200、JSON/no-store 和精确的 `{protocolVersion:2,state:'drained',proof,receipts:[]}`。严格解析拒绝重复键、尾随 token、畸形 UTF-8 和非整数数值 token。proof 恰有 `resourceId/kind/schemaVersion/byteLength/digest`：符合生产者形状的 UUID、`external-publication`、整数 `1`、不超过 64 MiB 的正整数长度，以及原始小写 64 个十六进制字符的 SHA-256 摘要。unknown、undrained、非空 channel/receipt 或畸形回包不产生 receipt。Broker 在 attest 后信任经过认证的 worker 声明；它**不**读取或计算私有 proof 字节的哈希，不声称 attest 与 stop 原子执行，也不抵抗被攻陷的可信 ingress 后方的恶意克隆。同源路由必须到达原 worker。
- **退役不等于进程退出。** 成功 drain 会封闭 managed writer 准入并退役执行资源；HTTP 进程可以继续存活。原生 receipt 使用既有 binding/generation/provision-request/handle/time 五字段构造器，`stoppedAt` 为 Broker 观察时间，不携带 extension mode 或 scope。binding state 与 operation claim 的授权由 Broker 调用链负责，provisioner 不重复建立这些判据；原语要求 drain 请求和经过校验的原始身份。
- **B0 单独检查点尚未激活（已由 §14 取代）。** 当时按 binding 的 `supportsDrainedStop(binding)` 可以识别有效原始绑定，但无参 `supportsDrainedStop()` 为 false，SQL 支撑的 `WorkspaceExecutionStore.canStopDrained` 门禁拒绝 EXTERNAL。ACK 重放、先持久化 receipt 再释放 owner 的编排，以及 EXTERNAL 执行归属均属后续工作。当时没有启用任何公开工具、Hosted profile 或准入开关，`release` 为空操作，#15512 未完成。

聚焦机制检查覆盖：listener 共享状态与字面量路由；原始请求头以及没有 response-incarnation 回显时的成功；身份/注册拒绝；严格畸形解析与回包上限；重定向 sink 不收到请求；活动连接的取消/超时；以及从已保存身份重启且不分配资源。这些 B0 检查本身不能证明公开 Hosted 执行、SQL owner 释放或真实 provider 的端到端关闭。§14 补充指定的 public-files 证据，不代表真实 provider 或完整目标验收。

## 14. 公开 external-files 里程碑：A / B0 / B1 / B2

### 已实现边界

A 建立元数据/授权；step 3a 提供已登记的放置；B0 提供原 worker 原生 drain；B1 接通生命周期关闭与 SQL 归属；B2 开启公开文件工具/default 审批。精确档案为 `hosted-workspace-external-files/1`，仅含 `read_file`、`write_file`、`edit` 和 `glob`。门禁通过后，公开发现与 Session 创建现在允许该档案，不再一律拒绝 EXTERNAL 放置。

准入要求选择 `external-workspace` kind、`workspaceFilesEnabled=true`、启用 Harness/session store/Broker、有效的外部 provider 配置、session 隔离且不开 create-warm，以及协商得到的特性 token `hosted-workspace-external-files/1`、生命周期协议 `1` 和 Workspace close 支持。登记、provider 与根绑定仍须匹配。配置满足条件不等于协商就绪或 worker 证明。指定 E2E 使用 `default` 审批，不认证所有审批模式。

选项保持闭合：不支持 shell、`monitor`、capture、skills、hooks/extensions、MCP、child agents/workspaces/snapshots、plan mode、rewind 或输入附件。本地 mounts/import、SSH 与 verified/operator/trusted-local-reboot recovery 开关必须保持关闭。这不是完整 Hosted 工具档案。见[配置](../../packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/config/ManagedAgentProperties.java)、[准入](../../packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedWorkspaceRegistry.java)与[闭合 Harness 选项](../../packages/cli/src/serve/hosted-workspace-profiles.ts)。

### 关闭与归属

生命周期协议 `1` 可以合法持久化 `storeSynthesized=true`、空 `effects`：在此无 hooks 档案下，store 根据空闲 journal 和经过验证的已提交 `definitionRef` 构造 receipt。这**不是** Harness wire-settle 回包，也**不是**原生 drain 证明。关闭链另行 detach Harness、确认没有 live journal writer，再经 B0 停写原 binding/generation/handle，之后才释放物理归属。

SQL 物理 holder 跨工具完成与 Runtime member/mount 释放继续保留，不是每次工具调用的锁。member execution claim 可以释放/重取，但不能因此释放该 holder。只有原 generation 的 stopped-release 校验及持久化 drain receipt 才允许清除其 runtime holder 字段。存储元数据与授权继续保留。退役无需终止 worker 进程，provider `release` 仍为空操作。见[生命周期编排](../../packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/SessionLifecycleCoordinator.java)、[journal receipt](../../packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/persistence/WorkspaceLifecycleStore.java)与[SQL 归属](../../packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/runtimebroker/JdbcExternalWorkspaceOwnership.java)。

### 已观察验收与来源

remote191 上指定的[公开 files/close E2E](../../packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ExternalPublicFilesE2E.java)完整执行，**1 项测试、0 失败、0 错误、0 跳过**，包括最终 summary 与 cleanup。链路使用真实 Spring 公共 API、独立 MySQL 8.4.13、构建后的 Hosted Harness、external Runtime worker、文件系统与 journal；allocator 和 OpenAI 模型是本地受控夹具，**不是云 provider 或真实模型验收**。

已观察：鉴权/幂等登记与物化、仅 owner 可发现、四个真实工具按 write → read → edit → glob 执行、两次 Action 审批、五次模型请求与一次分配、decoy 根未改动、终态公共事件、Items/工具详情及同 Session 历史资源校验。关闭达到 Session `CLOSED` / binding `RELEASED`，清除 holder runtime 字段，保留元数据/授权/历史且无 live writer。原生 drain receipt 持久化，main/legacy stop 端点一致；鉴权后的 late write 返回 `409` 且未创建文件；晚到公共输入和幂等关闭均未新增副作用或分配。原 worker 一直存活到 cleanup。

保留证据包中的 47 个 runtime 源码哈希均匹配检查点 `dd5c2d2fb2e2665dd593b27fffa50e2cf4dc510d`，执行前后 artifact manifest 一致；复制的 Core commit 元数据另行披露。这以源码/产物来源证明指定场景，**不代表检查点所有测试或最新完整 CI 均已认证**。此前失败尝试继续保留，不会被本次通过抹去。

### 验收检查点之后的改动

以上验收包是检查点 `dd5c2d2fb2e2665dd593b27fffa50e2cf4dc510d` 的历史证据；#15685 以 `0f7b8c006d77527a3a4555caf8d8ec41e998ffca` 合入。后续修复将 Agent pin 校验移到 Workspace 解析之前，并允许合法认领的 LOST binding 在停止证明提交前保持该状态。此后的评审修复还调整了登记记录的错误处理与执行资格检查。这些改动**不在上述已记录的端到端运行内**。聚焦回归测试是单独的证据，不代表在最新 head 重跑过公开 files/close 验收。

### 剩余目标与门禁

**C 仍未完成：**前台 `run_shell_command`、`monitor`、publication/capture 及其关闭语义均未完成。`monitor` 在最初 §1 目标中，仍是目标，不能悄悄删除。真正的 `LOST` 恢复、Broker/adapter 进程重启恢复、真实并发归属/恢复场景及真实 provider 验收，仍是未完成工作，不能由本次运行宣布完成或验证通过。完整 CI/fault 套件、人工评审及验收/部署门禁仍待通过。UI 验证仍待完成；本文不声称查看器或截图已成功。本次只完成用户影响与目标差距的文档对照，不关闭 #15512 或第二阶段完整目标。
