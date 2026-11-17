# Managed Runtime Worker 路由单一来源

[English](2026-11-10-managed-runtime-route-single-source.md) | [简体中文](2026-11-10-managed-runtime-route-single-source.zh-CN.md)

## 状态

提案。实现与验证在同一个 PR 内随本文档落地。

## 问题

Managed Runtime worker 的 HTTP 请求先经过外层 raw 门
（`ownedManagedRuntimeRouteGate`）才到达 Express。门的允许列表与 Express 挂载
来自**两套平行的条件组合**：

- `managed-runtime-attestation-worker.ts` 用内联三元树构建门列表（约 8 个布尔
  条件：boot 版本、capture publisher、remote publishers、workspace 能力、
  measured digest、managed extensions、CSI boot、SSH runtime、外部
  publication）。
- `managed-context-worker.ts` 的 `registerManagedContextRoutes` 在内部重新推导
  重叠的条件（publisher 解析、`requiresActivation`、`resident`、
  `foregroundOnly`、extension 配置）来决定挂载什么。

2026-09 的 attestation 事故（路由注册进了 Express，但外层门维护的另一份路径
列表漏更新，导致静默 404）已通过共享冻结路由常量与跨语言 fixture 修复。但
**激活逻辑**仍然是两份。今天可见的漂移化石：

- 门的 boot v2 minimal 分支里有一个 `boot.managedExtensions` 条件，永远不可能
  为真（有 extensions 必走 full 分支）。
- resident 能力 digest + extensions 时，门允许 `PUBLICATION_INSTALL_ROUTE`，
  而挂载侧从不注册它（`remotePublisher` 要求 `!resident`）。方向无害（Express
  回 404），但两棵树确实不一致。

要防的故障类：在新条件下挂载了路由、门的树却没更新——静默 404 破坏功能，
与原始事故完全同类。

## 现状

逐行读码核实的各路由组及其激活条件（HEAD）：

| 路由组                          | 挂载条件（context worker）                                                                           | 门条件（worker）                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| attest v3 + context             | 总是（boot v2）                                                                                      | 总在 `MANAGED_CONTEXT_WORKER_ROUTES` 中                                            |
| activation、provider            | 总是                                                                                                 | 总是                                                                               |
| MCP ×2、hook、shell、monitor    | 非 `foregroundOnly` 时挂真实路由；否则挂 501 拒绝桩（任何形式下都已挂载）                            | 总是                                                                               |
| Tool v2（`OWNED…` 去掉 attest） | 总是                                                                                                 | 总是                                                                               |
| Tool v4                         | registrar 内部提前返回，除非 digest = `MEASURED_WORKSPACE_CAPABILITY_DIGEST`                         | 仅当 digest = MEASURED 时加入                                                      |
| Tool v3 / tool-result           | `publisher` 为真                                                                                     | full 分支加入（对所有可达输入等价）                                                |
| Extension ×4                    | `extensionConfiguration && mcp && hooks && extensionProcesses`（可达 boot 上等价于 extensions 存在） | 仅当 `managedExtensions` 时加入                                                    |
| CSI attest/drain/ack            | `csiBoot`                                                                                            | 仅当 `csiBoot` 时加入                                                              |
| SSH 路由                        | `sshRuntime`（worker 层）                                                                            | 仅当 `sshRuntime` 时加入                                                           |
| Shell publisher                 | `remotePublishers`                                                                                   | 仅当 `remotePublishers` 时加入                                                     |
| Publication install             | `!(publication ?? capturePublisher) && requiresActivation && !resident`                              | `!capturePublisher && !publication && (isWorkspaceToolCapability \|\| extensions)` |
| Boot v1 表面                    | attest v2 + tool 路由 + provider                                                                     | `OWNED_MANAGED_RUNTIME_ROUTES + PROVIDER`                                          |

今天的不变量：对所有可达配置 **gate ⊇ mounts**。唯一分歧是
resident+extensions 下的 publication-install（门为超集）。

## 目标

1. 一个纯函数推导独占 worker 的路由表面。门消费其路由列表；挂载侧消费其
   标志。不再有第二棵条件树。
2. 对所有可达 boot 配置保持行为不变，仅有一处下文记录的收紧。
3. conformance 测试在配置矩阵上钉死 **mounts ⊆ gate** 与 **gate = plan**，
   让未来漂移在 CI 失败而不是在生产失败。
4. 删除 minimal 分支的死条件。

## 非目标 / 范围边界

- CSI file worker（`managed-csi-file-worker.ts`）保留其同函数内、仅按版本
  组合的门；它是独立进程类型，单一挂载函数，没有平行树。
- 外部 publication server 的门已消费注册同模块导出的
  `EXTERNAL_PUBLICATION_ROUTES`；不动。
- 不改协议、fixture 或 `packages/core`。Boot v1 表面不变。
- 叶子 registrar 可保留单谓词身份守卫（如 v4 registrar 的 measured-digest
  检查）。单一来源拥有的是**组合**，不是每一行守卫；守卫与 plan 标志使用
  同一批常量。

## 方案

### 共享 helper：`resolveManagedShellPublisherMode`

放在 `managed-workspace-activation.ts`（而非新模块），以保持导入图无环：
plan 模块导入 context worker 的路由组合，context worker 从 activation 导入
helper。

- 输入：`capabilityDigest`、`managedExtensions` 是否存在，以及有效 capture
  标志与 `remotePublishers` 两个布尔。
- 返回 `{ resident, requiresActivation, remotePublisher, publisher,
installRoute }`，由 `requiresActivation`（workspace 能力 ∨ resident ∨
  extensions）、`resident` 与有效 capture 标志（`publication ||
capturePublisher`）推导。

### 新模块：`managed-runtime-worker-routes.ts`

- `ManagedRuntimeWorkerRouteInput`：boot 版本（1|2）、`capabilityDigest`、
  `managedExtensions` 是否存在、`csi` 是否存在、可选 SSH 路由，以及
  `capturePublisher`、`remotePublishers`、`publication` 三个布尔。
- `resolveManagedRuntimeWorkerRoutePlan(input)`：返回
  `{ routes, toolV4, toolResult, publicationInstall }`。
  - Boot v1：`OWNED_MANAGED_RUNTIME_ROUTES + MANAGED_RUNTIME_PROVIDER_ROUTE`。
  - Boot v2：`MANAGED_CONTEXT_WORKER_ROUTES` 加上按现状清单表激活的路由组，
    tool-result 与 publication-install 由共享 publisher 模式驱动。full/minimal
    分支划分消失：组合 = 无条件基座 + 谓词驱动的组。
  - 额外布尔暴露 publisher 模式推导出的选择，供断言使用；挂载点直接消费
    共享 publisher 模式。

### Worker（`managed-runtime-attestation-worker.ts`）

boot 解析完成后计算一次 plan，把 `plan.routes` 交给门。内联三元树与死条件
删除。

### Context worker（`managed-context-worker.ts`）

`registerManagedContextRoutes` 消费 `resolveManagedShellPublisherMode` 来决定
remote publisher、有效 publisher 与 install 路由注册，不再自行推导。v4
registrar 保留无条件调用点与其内部 measured-digest 叶子守卫；plan 用同一
常量选择同一批路由，因此不新增调用点参数。extension、foreground 拒绝桩与
常开挂载保留其与行为对象绑定的条件——现状清单已证明它们在可达 boot 上与
plan 等价。

### 记录在案的收紧

resident digest + extensions 且无 capture/publication 时，门不再允许
`PUBLICATION_INSTALL_ROUTE`（它从未被挂载）。响应从 Express 404 变为门 404
——都是 404，没有功能上的客户端。这是唯一可观察的表面变化；conformance
矩阵钉住它。

## 设计决策与理由

- **plan 是数据，不是注册框架。** 路由仍是冻结常量；plan 只做选择。不做
  逐路由 handler 注册表重写——那会触碰每个 registrar 却换不来额外安全性。
- **publisher 模式共享而非复制。** 它是两侧真正各自重算的唯一推导；提取它
  就消除了最后的语义分叉。
- **被测不变量取 mounts ⊆ gate**，第二断言取 gate = plan。不要求严格的
  mounts = gate：与行为对象绑定的条件（extension runtime 对象）可能拒绝挂载
  而 plan 允许；门超集方向安全，且是今天的现状。
- **不依赖内部状态的行为学 oracle：** 门的 404 是空 body；任何穿过门的响应
  都可区分（Express 404 带 HTML，handler 带 JSON）。对启动的 worker 逐路由
  探测即可分类，无需导出内部状态。

## 受影响文件

- 新增：`packages/cli/src/serve/managed-runtime-worker-routes.ts`、
  `packages/cli/src/serve/managed-runtime-worker-routes.test.ts`。
- 修改：`packages/cli/src/serve/managed-runtime-attestation-worker.ts`、
  `packages/cli/src/serve/managed-context-worker.ts`、
  `packages/cli/src/serve/managed-workspace-activation.ts`。
- 文档：本双语文档；测试计划在 `.qwen/e2e-tests/`。

## 风险

- plan 输入必须忠实捕获 `publication` 是否存在（worker 在挂载前已知）；
  布尔传错会静默移动 install 路由。缓解：矩阵覆盖 publication × capture ×
  digest 组合。
- `registerManagedContextRoutes` 的独立调用方（测试）必须继续可用：
  publisher 模式 helper 的默认推导复现今天的行为。
- 门收紧可能破坏钉住 resident+extensions install 路径 Express-404 body 形状
  的测试；跑完整 managed serve 测试集。

## 验证计划

1. 聚焦单测：plan 矩阵（digest × extensions × capture × remotePublishers ×
   publication × CSI × SSH × boot 版本）、publisher 模式真值表。
2. 行为 conformance：按可达配置在进程内启动 worker（临时 mount root，沿用
   `managed-runtime-bootstrap.process.test.ts` 的 harness 模式），探测路由
   全集，断言穿门集合 = plan、挂载集合 ⊆ plan。
3. 既有套件：`managed-tool-result-admission`、
   `managed-runtime-bootstrap.process`、`managed-runtime-tool-v4-routes`、
   context-worker 与 CSI worker 测试。
4. `npm run build && npm run typecheck`、lint、Prettier。

## 验收标准

- worker 的门调用处不再有任何路由组合条件；plan 是唯一推导。
- 对所有可达配置，plan 输出与改动前的门列表一致，唯一例外是记录在案的
  resident+extensions install 收紧。
- conformance 矩阵绿；死条件删除；全部既有聚焦套件通过；build/typecheck/lint
  干净。

## 开放问题

- 无阻塞项。未来 boot 版本新增路由组时，plan 输入加一个字段、矩阵加一行
  ——conformance 测试就是常设守卫。
