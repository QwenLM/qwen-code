# 外部 Hosted Workspace 运行时（第二阶段）

状态：**设计提案，未实现**。接续阶段一 `docs/design/2026-10-23-external-runtime-provider.md`（external-scratch，已认可的契约）和已实测完成的 Aone 适配器链路。本阶段不削弱阶段一的任何性质：第一次在首次远程调用前持久化逻辑 handle、丢响应后禁止替换、不提供 release‑to‑kill、Broker 独立 attest、provider 按 `provisionRequestId` 幂等。

## 1. 本阶段存在的原因

阶段一能分配并 attest 一台 session 隔离的 worker，但**没有真正的工具消费者**：未绑定 Workspace 的 Session 没有 Hosted 工具档案，模型拿不到任何工具声明，worker 只能等到 provider TTL 到期而被回收。本阶段的目标：

- 绑定外部 Workspace 的 Hosted Session（provision 在厂商沙箱平台上）获得全套文件工具（`read_file/write_file/edit/glob`）和前台 shell（`run_shell_command/monitor`），可见性、审批与持久化语义与 local‑process 路径一致。
- Broker 进程丢失或 adapter 进程丢失后，存储归属与 session 绑定语义完全保住；出现歧义时保留归属、绝不悄悄换 worker 或换存储密钥。

本期显式不做：公网浏览、MCP、目录导入、子 Workspace、快照、迁移，以及完全动态按申请分配存储（§7 说明）。

## 2. 与 external-scratch 的关系

| 维度                    | external-scratch（阶段一，已上线） | external-workspace（本设计，阶段二）                                      |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| 模型可见工具            | 无                                 | 完整 Hosted Workspace v1 档案                                             |
| worker boot             | boot‑v1（容器）                    | boot‑v2（容器内新准入，§6）                                               |
| worker 终止             | provider TTL                       | `stopDrained` 证明或 TTL；释放前走存储归属氬（§8）                        |
| 存储身份                | 无（只有 scratch cwd）             | 注册、有 revision、加护栏（§4）                                           |
| provisioner handle 家族 | `external` v1                      | `external-workspace` v1（不同 kind，绝不允许重解释）                      |
| Provider HTTP 补充      | `provision`, `observe`             | 追加 `storage:provision`、`storage:observe`、publication/capture（§5/§7） |
| Workspace 状态机        | —                                  | 与 LOCAL/SSH_LOCAL 同状态机，ownership 新增 `EXTERNAL` kind               |

部署侧通过 `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace` 显式开启，且相应 Workspace files/shell 同时被配置打开。阶段一的 scratch 档案与 `validateExternalRuntime` 校验保持不变。

## 3. 身份与持久化契约（延续阶段一）

传输层完全复用：鉴权 HTTPS、POST、禁止重定向、64 KiB 请求/响应上限、`Cache-Control: no-store`、`protocolVersion: 1`、错误消息做脱敏。增加的几条：

- worker 为 **API 使用的公网 ingress** 使用一个额外被转发的端口（worker 的 publication 服务，§7）；通道使用 bearer + lease/domain 头校验，不与 attest 端口身份面共用。
- **durable 注册操作**必须先于任何 Workspace 绑定 创建，且和 provision 一样：第一次 HTTP 前先发持久逻辑 handle、按请求 ID 去重、拒绝冲突的后续回复。
- 摘要继续用 canonical‑JSON sha256（token‑free）。registration 不允许同时启动 worker。

## 4. 外部存储注册（session 真正绑定的"Workspace"）

远程 Workspace 是存储，不是 sandbox。注册由操作方控制面发起（不是用户代码）：

1. 操作方通过公共注册 REST（loopback 限制）向 Managed Agent 注册两组元组：
   - `ExternalStorageIdentity = {providerId, physicalKey, registrationRevision}` —— provider 侧分配、不可变、单 tenant 单存储实例的唯一标识；**不是 sandbox ID**（sandbox TTL 到期即消失）。
   - `StorageAlias = {tenantWorkspaceId, aliasPath, mountRoot}` —— 用户侧的 Workspace 身份，以及 worker 内的绝对挂载根（路径必须 canonical、非根、属主可写、`0700`）。
2. 服务器在 `WorkspaceStorageGuard` / `WorkspaceExecutionStore` 里新记录 ownership kind `EXTERNAL`，定义与 LOCAL/SSH_LOCAL 相同约束：
   - 同样的 SQL writer/generation 护栏；
   - tenant 别名唯一性的进入冲突处理（跨 tenant 冲突 = 409，而非接管）；
   - 元组绑定按单 tenant 严格遵守——sandbox 的 physical key 注册给 tenant A 后不能被换绑给 tenant B，除非操作方签了独立的 re‑registration 事件。
3. adapter 收到 `storage:provision` 用来告诉新 worker 准备好的存储树位置（alias 的 mount 根），`storage:observe` 用于运行状态与连续性探测（v2 返回 `READY/STARTING/UNKNOWN/GONE` 加 `continuity: "confirms"|"denies"|"unknown"`——这是 Broker 在允许写入前用到的成本低廉的连续性 witness）。

用一句话概括：durable 注册在重启后仍然存在；sandbox 轮换（新 sandbox 拿到同一 alias+physicalKey）只会映射到一台新 worker，**不会**重新开启新的 workspace 谱系。

## 5. guard/store/resolver 的归属扩展

- `WorkspaceStorageGuard` 新增 `EXTERNAL` kind，containment 校验永远比照**注册过的 worker 侧挂载根**执行，从不走中心 `Files` 调用本地路径；所有文件操作都在 worker 内完成 containment。
- `WorkspaceExecutionStore` 新增 `EXTERNAL` kind，授权路径做既有的 SQL 护栏；guard 的 storage version 只在 registration/retirement 变更时推进。
- `WorkspaceRuntimeResolver` 在 workspace 身份同时匹配 `providerId` 和 `registrationRevision` 时，才把外部 alias 绑定到新 kind 的 provider——避免运维差一句配置把一个 session 静默改绑。

以上三处都是量较小的表盘式拓展；对远端 worker 的可达性检查只发生在 `provision/activate/verify` 边界，不做对每笔文件操作。

## 6. Worker 准入：容器内 boot‑v2（CLI 变更）

今天容器模式会拒绝 boot‑v2。本阶段在 CLI 增加 `ManagedRuntimeWorkerBoot` v2 的容器准入，并配置**存储侧的最小信任**：

- boot 文档新增 `storage: {kind: "external", physicalKey, aliasPath, mountRoot, registrationRevision}`。worker 在启动时校验该组：mount root 已存在或能被它创建、属主可写、绝对路径、规范化、且落在允许的根之下。Boot 里 physicalKey/registration 与服务侧不一致直接关闭拒绝（不等于 broker 绑定的 key 绝不挂载）。
- Worker 同时跑 **publication 服务**（`/internal/managed-runtime/v2/publication:*`，见§7）并把这个面写进就绪回执；`observe` 在向 Broker 报 `READY` 前会先打 publication 就绪 probe。
- `isolationClass: session` 已锁定一台 worker 一个 session；任何一个新 alias 都只会在这台这台 worker 激活存储 context。

拒绝原因对未认证调用者不回显物理路径，与 boot‑v1 语义一致。

## 7. 前台 shell 的 publication 与 capture

前台 shell 在远端的最大缺口是**证据可核查**——一次 close 结束后你必须说明哪些内容是被喝过、被认可、被消灭的：

- worker 额外暴露一个受限的 publication 面：每次执行携带被 capture 的输入 identity，`publication:begin` 能开启一个 channel；stdout/stderr/pty 顺序**_持久落账_**；通道大小上限与本地 shell 一致，原始输出只落 worker 的`0700` publication 目录（内容脱敏是后续话题，超出本提案）。
- Broker 与本地读取完全一样的形状走 `publication:read`；未知 channel 或过期 lease 直接 closed 错误，绝不退化成"没 capture"。
- `stopDrained`（§8）会把每个 channel 最终 receipt 写入结尾区；close 只有在所有 channel drain 到 end‑of‑stream 时才允许结束。

本期只支持前台 shell；后台 shell（`is_background`）留作下一步，有它自己的证据制度。

## 8. 精确 worker 的 `stopDrained` 与存储归属护栏

任何"自闭合/自恢复"策略都需要证明**原 worker 不再写入**：

- Broker 用 lease/domain/revision 头去 worker 问 `publication:stop-drained?channel=all`，回答限定三种：
  - `drained` —— 通过 worker 自身 per‑channel receipts 做只读面行为校验；Broker 此可关闭 storage 并无损退役 binding；
  - `undrained(channel seq)` —— close 必须保持推迟，本次仅许可只读；
  - `unknown` —— 禁止关闭，也禁止替换；sandbox TTL 可以回收 CPU，但 storage 归属护栏保持不变。
- sandbox 过期/GONE **不是** drain 证明；worker 崩溃**不是** drain 证明；本 profile 继续沿用阶段一规则，`release` 仍是无操作（true kill 决定权只属于 storage 的 owner‑fenced stop）。

远程监督进程会把每个任务生命周期的 receipt 写到 worker 的私有 publication 目录中（所有敏感都不写入任何 release 载荷），因此 adapter 重启也能靠**重读 receipts**来重新断言 drain 状态，而不是靠信任崩溃事实。

## 9. 操作方适配器（Aone，私有库）步进

`scripts/qwen-runtime-provider/` 的变更：

1. 完全复现已实测过的机制：durable create‑only journal、writer lock、boot 上传、run‑up 等待、无 mode 上传、单次 launch、request‑ID 去重、attest probe。阶段一的 provision/observe 语义一字不改。
2. `storage:provision` / `storage:observe` 实现：第一版要求**操作方预注册 physical key**（申请即建存储池只留到第二阶段后期）。
3. 启动 worker 时使用 boot‑v2 的说明书；在向 Broker 报 `READY` 前先做一次 publication ingress probe。
4. TTL 处理扩增：adapter 的 observe 顺带返回 `remaining_seconds`；central 在 sandbox 到期之前先做一次 stopDrained，用来做证据整理和归属闸门判断。

这些 API 不需要上游感知 Aone 的任何元数据；认证/书写面与阶段一一致。

## 10. 验证矩阵

| 层面                 | 必备证据                                                                                     | 证明路径                       |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| 存储注册单元         | 注册/租户/别/recision 冲突拒绝；预 commit 落库；重放身份                                     | 新增 guard/store/resolver 单测 |
| worker 准入单元      | boot‑v2 合法接受、key 不匹配拒绝；mount root containment                                     | CLI container 单测             |
| publication/capture  | begin/read/receipt 序列；大小上限；过期 lease                                                | worker 单测                    |
| stopDrained          | drained/undrained/unknown 与 close gating                                                    | worker+Broker IT               |
| Broker + 真实 worker | Aone 上全流程：注册→摆放→attest→write/read/edit/shell 前台→close                             |                                | 扩充阶段一的 full-tier fault 套件 |
| 公开 Hosted E2E      | Session 模型可见工具；approval 卡片能依据有据重建；Broker 与 adapter 双重启都保 storage 谱系 | 完整 Public Hosted 验收        |

## 11. 提议推进顺序

1. guard/store/resolver 扩展和注册 REST（仅引入兼容 API，默认不接线启用）。
2. CLI boot‑v2 容器准入和 publication 服务（没有消费者，默认无效）。
3. provisioner 档案 `external-workspace` 和 `storage:*` 端点（灰色开启，部署方显式勾选）。
4. stopDrained + close gating；之后用显式开关才启用 Hosted 工具列表。
5. full-tier 公共 Hosted E2E；此时才在文档里写"该档案可生产**文件/命令**功能"。

每一步都可以独立回退。阶段一的契约与其 fault‑gate 证据是基础——本设计只在其上补充能力：**不改变状态机的核心断言**，只做受控的能力扩展。
