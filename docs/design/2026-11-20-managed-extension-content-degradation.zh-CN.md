# Managed 扩展 Content-Only 组件降级

[English](2026-11-20-managed-extension-content-degradation.md) | [简体中文](2026-11-20-managed-extension-content-degradation.zh-CN.md)

状态：提案（issue #17714，triage 认可的方案 2）。日期：2026-11-20。

## 问题陈述

不带 `stage` 依赖构造的 managed 扩展运行时（content-only 形态）在任一包声明
`mcpServers` 或 `hooks` 时拒绝整次 apply：`prepare()` 在编译完所有包之后抛出
`Extension process components are unsupported.`
（`packages/cli/src/serve/managed-extension-runtime.ts:376-383`）。包里本可在该
形态下正常使用的 `skills`、`commands`、`agents`、`context` 被连坐失败，调用方
拿不到按组件的细节。skills+小 hook 的混合包是自然的发布单元；目前唯一的绕法是
fork 包剥掉 hook，或为几个 skills 启用完整进程运行时。

## 现状

- 扩展契约允许七种组件（`ManagedPackageComponent`：`skills, commands, agents,
context, mcp, hooks, settings`）；拒绝是运行时策略门，不是编译限制。
- MCP/Hook contributions 仅由 staging 路径（`managed-extension-manifests.ts`）
  激活，位于 `stage` 之后；无 `stage` 时 prepared catalogs 恒为
  `{ mcpServers: [], hookCatalog: null }`，什么都不 staged。但它们在生产接线中
  并非结构上惰性：生产 `compile` 闭包无条件调用
  `preflightManagedExtensionPackage`（`managed-context-worker.ts:814`），解析
  每个 MCP server 命令与每个 `type: "command"` hook，解析不到即抛
  `Extension executable is unavailable`
  （`managed-extension-preflight.ts:168-188`）；生产 `drain`/`install` 在无
  staged manifest 时抛错（`managed-context-worker.ts:853-855`、`:876-879`）。
  因此惰性仅对无 stage 运行时形态成立，且前提是其接线提供不对惰性组件做
  preflight 的 compile、以及容忍无 staged manifest 的 `drain`/`install`——
  这正是 harness 测试所验证的形态。
- Java 服务器对 `extension-prepare` 是校验转发器：
  `ManagedExtensionProtocol.response()` 只检查 envelope、`state`、`revision`、
  `executionMode`；结果的 `packages` 数组 opaque 透传。Java 从不读 prepare 结果
  的包级字段。
- 持久化的 effective bundle（`managed-extension-config-bundle`）由 TS harness
  （`hosted-extension-session.ts` 的 `prepare()`）构建，作为 opaque 资源提交，
  Java 侧选择性读取（仅 `pin`、`contributionsRef`）。bundle 包条目上唯一的闭键
  门在 core TS parser（`managed-extension-package.ts`，`keys(entry, ['pin',
'assetRoot', 'contributionsRef'], [])`）。
- 会话资源目录的 effective MCP 列表来自 `bundle.mcpServers`（content-only 下为
  空）；按包的归属 map 只是查找表，不是展示列表。因此降级包今天不会在目录里
  产生幻影 MCP 条目。
- 扩展管理 API snapshot（`ManagedExtensionManagementService.snapshot`）以裸 pin
  报告 active `extensions`；没有降级上报表面。
- 本树不存在 content-only 的生产接线或能力 digest：唯一的生产运行时构造
  （`managed-context-worker.ts:686-713`）总是提供 `stage`，
  `ManagedExtensionExecutionProfile` 恰好准入两个 digest（`linux-cgroup`、
  `developer-process-group`）。无 stage 构造存在于测试中，正是 #17714 针对的
  形态。

## 目标与范围边界

目标：

1. content-only 运行时加载并服务每个包中受支持的 contributions，而不是整次
   apply 失败。
2. hooks/MCP 保持完全惰性（fail-closed 不变），其未激活状态按包显式上报，绝不
   静默丢弃。
3. 降级状态确定性地通过 exact re-prepare 漂移校验与重启恢复。

范围外：

- 在 content-only 中执行 hooks/MCP（triage 否决的方案 1：会抹掉两种 profile 的
  边界）。
- 第三个能力 digest/执行模式与 content-only 生产接线（#17424 跟踪）。
  `executionMode` 枚举不变。
- `config_install` 记录、`config.bound` 事件 payload、contributions manifest 的
  形状变更——所有闭键集保持不动。
- 会话资源目录（对 effective MCP 已经是诚实的；无需改动）。

## 方案

### TS 运行时与契约

- `ManagedExtensionPreparedPackage` 与 `ManagedExtensionPackageView` 增加可选
  `degradedComponents?: readonly ('mcp' | 'hooks')[]`。为空时省略该字段；存在时
  按规范顺序 `['mcp', 'hooks']` 依存在性过滤，无重复。
- `prepare()` 删除整包 throw。`preparedView()` 按包推导该字段：无 `stage` 时，
  `contributions.mcpServers` 非空的包降级 `mcp`，`contributions.hooks` 非空的包
  降级 `hooks`。持久化 receipt 保留完整编译产物不变，因此 exact re-prepare 的
  逐包比对（`Prepared extension package drifted.`）与 catalog 比对保持绿；推导
  是 `stage` 存在性 + contributions 的纯函数，重启与 re-prepare 复现完全相同的
  视图。
- bundle parser 接受 `degradedComponents` 作为包视图可选键，校验取值（`{mcp,
hooks}` 内无重复成员），并归一化为规范顺序。
- harness `prepare()` 把该字段从每个 prepared 包拷贝进发布的 bundle 包视图。
- 工具 profile 准入门判断的是实际将被服务的内容：无 `stage` 时，两个 prepare
  调用点（新鲜与 exact re-prepare）都校验去掉惰性 `mcpServers`/`hooks` 后的
  视图，使混合包在所有准入扩展配置的 profile 上都能 prepare 并上报降级——
  包括 `hosted-workspace-mcp/1`（唯一能携带扩展配置的非 shell profile）。带
  `stage` 时门禁仍看完整 contributions。漂移比对仍用完整编译产物，
  `preparedView()` 仍是上报列表的唯一生产者。

### Java 上报

- `ManagedExtensionManagementService.snapshot` 增加 additive 的
  `degradedComponents` 对象：以 `extensionId` 为键、包的降级列表为值，仅从
  **active** bundle 读取。至少一个 active 包降级时该字段才出现。`extensions` 与
  `requestedExtensions` 保持裸 pin 形状；现有消费方不受破坏。
- 新读取点按仓库风格防御式校验并与 TS parser 对齐：字段必须是 `{mcp, hooks}`
  内无重复字符串的数组（显式 `null` 判 corrupt，与 parser 一致），上报列表归一
  为规范顺序 `['mcp', 'hooks']`，使 API 边界无论提交顺序如何都确定；畸形已提交
  bundle 判 `corrupt()`。
- 已发布 OpenAPI 契约声明该字段：`ManagedExtensionManagementSnapshot` 增加可选
  `degradedComponents` 对象（`maxProperties: 32`，值为 `mcp`/`hooks` 数组、
  `maxItems: 2`、`uniqueItems: true`），使该 schema 的 `additionalProperties:
false` 对每个服务 snapshot 的公开与 WebShell 扩展管理操作保持诚实。WebShell
  类型从仓库根重新生成
  （`npm run generate:managed-agent-api --workspace=packages/web-shell`），并新增
  提交降级 active bundle 的契约用例，使 `ManagedAgentApiContractTest` 对降级响应
  做 schema 校验——缺少该 schema 属性时门禁必红。契约 `info.version` 按仓库
  契约版本守卫要求推进（`1.123.0` → `1.124.0`）。
- `ManagedExtensionProtocol.response()` 不变：它本就透传包级字段，TS harness 在
  接收时校验 pins。
- 本地 harness 管理 snapshot（`GET /session/:id/extensions/management`）刻意不
  变：Java 侧 snapshot 是部署方视角的上报表面。本地表面是否对齐留待 content-only
  接线工作（#17424）按需决定。

## 设计决策与理由

- **D1 — 视图期推导，不进 receipt。** 把降级存进 receipt 会分裂 receipt 格式与
  漂移比对；从 `stage` 存在性 + 未改动的 contributions 推导，使三条路径（新鲜
  prepare、exact re-prepare、重启加载）产出同一视图，receipt 格式零变更。
- **D2 — 按包可选字段、规范顺序、为空省略。** 加法且向后兼容：旧运行时不发射，
  新 parser 接受缺省，Java bundle 读取方本就容忍条目额外字段。规范顺序使
  `JSON.stringify` 比对确定。
- **D3 — 在扩展管理 API 上 additive 上报。** 它是部署方视角的扩展配置表面；以
  `extensionId` 为键的 map 精确报告哪些包的哪些组件未激活，同时不改变消费方
  今天解析的 pin 数组。资源目录无需改动（其 effective MCP 列表已排除惰性
  contributions），记录/事件闭键集保持不动。
- **D4 — `settings` 不是降级组件。** settings 是 env-var 声明，在 compile/
  preflight 期解析；其唯一运行时消费方是 MCP stdio env 与 command-hook env，
  随降级组件一起惰性。它们继续作为数据加载；不设单独标记。
- **D5 — 不新增能力 digest 或模式。** content-only 生产接线属 #17424 范围；本
  变更让运行时契约在现有形态内优雅降级，使后续接线落地无需协议分叉。
- **D6 — 准入前降级，而非准入后。** 工具 profile 门禁的存在意义是拒绝会话
  profile 无法监督的进程执行。content-only 中没有任何执行，若仍判断惰性组件
  就会在 `hosted-workspace-mcp/1` 上重演整包失败——恰是准入的非 shell 群体。
  因此两个 prepare 调用点校验被服务内容视图（去掉惰性组件），staged 运行时
  保持严格门禁；上报列表仍仅在 `preparedView()` 推导。

## 约束

- bundle inline 容量 64 KiB
  （`managedSessionInlineResourceBytes('managed-extension-config-bundle')`）。
  实测各形状（32 包全部降级 `["mcp","hooks"]`、96 条 MCP 选择、16 条 base
  pin、最宽身份）：不含 `settingsRevision` 且带 32 条 effective pin 时
  65107 字节 ≤ 65536（余量 429 字节）；全选项合成最坏情况再给每个包 pin 加
  `settingsRevision`，达 66259 字节 > 65536——发布期容量守卫对该角落 fail-closed
  拒绝，属既有机制（同形状不含降级时为 65075 字节，在上限内）。content-only
  可达最坏情况的 effective MCP 列表恒为空，实测 57812 字节，在上限内。两个
  边界均由字节测试钉住；#17424 接线落地前须重测。
- prepare 结果 8 MiB 上限不受影响。
- `ManagedExtensionProtocol` 中 prepare 操作（请求方向）的闭键集不变。

## 风险

- 字节预算：不含 `settingsRevision` 的 worst case 余量薄（429 字节）；全选项
  合成最坏情况（每个包 pin 带 `settingsRevision`）超出 inline 上限，由发布期
  容量守卫 fail-closed 拒绝；content-only 可达形状在上限内。未来任何 bundle
  新字段必须重跑字节边界测试。
- 版本偏斜：旧 TS harness 解析新 bundle 会拒绝未知包视图键——恢复也不例外，
  因为 `prepareRuntime` 先经同一个闭合 bundle parser 加载基线，再投影 pins。
  真实缓解是 harness 与运行时同在一个 CLI 二进制发布，会话的已提交 bundle
  只会被相同或更新的 harness 重新解析；回滚的二进制无法恢复降级 bundle。
  Java 读取方容忍该字段。将此记为 #17424 接线的迁移注记（降级 bundle 不支持
  跨版本降级恢复）。
- 降级包的 hook 静默不运行是预期语义；显式上报是对运维意外的缓解。

## 验证计划

- 单元（TS）：core parser 接受/校验/归一化（非法值表以不展开的数组行传参）、
  字节预算测试与全选项/可达字节边界测试；运行时测试覆盖降级推导、混合包成功、
  惰性 catalogs、exact re-prepare 与重启确定性、带 `stage` 时无降级、
  `hosted-workspace-mcp/1` 准入前验收用例（移除准入视图必须抛 profile 错误）、
  staged 运行时门禁保持严格；harness 测试验证发布 bundle 携带该字段；
  harness 级集成测试用无 stage 运行时在首个 Hosted 回合通过 skill 工具加载
  skills+hook 混合包。
- 单元（Java）：`ManagedExtensionManagementServiceTest` —— snapshot 对 active
  降级 bundle 上报 map、其余情况省略、保持 pin 形状、归一规范顺序、畸形降级
  字段（含显式 `null`）判 corrupt、降级上报来自 active 祖先 bundle 而非
  requested/pending bundle（双 bundle 用例）。
- 契约门禁（Java）：`ManagedAgentApiContractTest`（含降级 active bundle 用例）、
  `SurfaceRegistryGateTest`、`SurfaceAdmissionAcceptanceTest`、
  `ManagedSurfaceCaptureTest`，加 CI 同款双 execution Checkstyle。
- 构建/类型检查：`npm run build && npm run typecheck`；按包跑聚焦 vitest；改动
  Java 模块跑聚焦 Maven 测试。
- 本契约变更不需要完整 managed-server E2E（runtime jar + MySQL）；harness 级
  supertest 集成已用无 stage 运行时覆盖真实 HTTP apply 路径。

## 验收标准

1. content-only prepare 混合 skills+hook 包在所有准入扩展配置的 profile 上
   成功，包括 `hosted-workspace-mcp/1`；skills、commands、agents、context
   正常服务；prepare 结果与已提交 bundle 上报
   `degradedComponents: ["hooks"]`（声明 MCP 时再加 `"mcp"`）。
2. 对无 stage 运行时形态（compile 不对惰性组件 preflight、容忍性
   `drain`/`install`），hooks/MCP 保持惰性：catalogs 为空、`install` no-op、
   无进程 spawn。生产 content-only 接线必须保持该不变量（#17424）。
3. exact re-prepare 与重启恢复返回完全相同的视图；漂移校验保持绿。
4. 带 `stage` 时不发射 `degradedComponents`，行为不变。
5. 扩展 API snapshot 对 active 降级配置展示 `degradedComponents` map，其余情况
   省略；pin 数组形状不变。
6. 字节测试钉住文档化形状：不含 `settingsRevision` 的 worst case ≤ 64 KiB，
   全选项合成最坏情况由发布期容量守卫 fail-closed 拒绝，content-only 可达
   最坏情况在上限内。
7. 已提交 bundle 中畸形降级字段（含显式 `null`）被 Java 读取点判 corrupt 拒绝；
   上报列表为规范顺序。
8. 已发布 OpenAPI schema 声明该可选字段，`info.version` 推进过 base，WebShell
   类型已重新生成，降级 active bundle 契约用例对 snapshot 响应做 schema 校验
   （缺少 schema 属性时门禁必红）。

## 开放问题

无阻塞项。content-only 生产能力接线仍由 #17424 跟踪，本变更明确了其两条
要求：接线的 compile 必须跳过 `preflightManagedExtensionPackage` 中的 MCP/hook
可执行性检查（staged 路径保留），其 `drain`/`install` 必须容忍无 staged
manifest。其验收标准：用真实生产 compile 闭包（非 stub）驱动无 stage 运行时 +
hook 命令不在 PATH 的混合包，必须 prepare 成功并上报 `["hooks"]`；今天会抛
`Extension executable is unavailable`。
