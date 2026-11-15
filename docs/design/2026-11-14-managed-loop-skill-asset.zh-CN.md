# Managed `/loop` skill 资产

[English](2026-11-14-managed-loop-skill-asset.md) | [简体中文](2026-11-14-managed-loop-skill-asset.zh-CN.md)

状态：提案。解决[固定间隔调度设计](2026-11-10-managed-loop-schedule.md)的开放问题 4，以及[自定步调唤醒设计](2026-11-10-managed-loop-wakeup.md)的共享 skill 触点。两个工具切片均已合入（#16835 `70a487be84`、#17088 `f3dc48c79e`，评审跟进 #17197 `0ffaea08ba` 与 #17235 `9d390e23af`）；两者共同延后的 skill 变体仍未实现。

## 问题陈述

Managed Session 已经能运行 `/loop` 工具面：Hosted profile 以 Managed 描述声明 `cron_create` / `cron_list` / `cron_delete` / `loop_wakeup`，内部 automation 路由创建 H6 定义，scanner 触发它们。但模型没有驱动该工具面的 `/loop` skill。bundled `loop` skill（`packages/core/src/skills/bundled/loop/SKILL.md`）携带**本地**语义——`durable` 默认 session-only、recurring 任务创建后 7 天自动过期——这对 Managed 调度是错误的（恒 durable、运行至取消、无过期）。今天 Hosted skill 目录里根本没有 loop skill（`2026-11-10-managed-loop-wakeup.md:31-32`）。

调度设计（决策 8）说 managed 变体"以 skill 资产经现有 Session Skills 发布承载，`allowedTools` 与 bundled skill 一致；其可见性随工具门控，镜像本地 `BundledSkillLoader` 规则"。勘察表明这句话无法照字面实现；本设计解决它实际如何承载。

## 现状（在 `970e1d6ea2` 核实）

skill 发布有两个生产者、一个消费者；Harness 只是消费者。

- **路径 A — 创建导入。** daemon 枚举工作区技能（含 bundled）（`workspace-skills-status.ts:559`、`skill-manager.ts:321,479-480`）；快照路由（`routes/workspace-skills.ts:1025-1064`）把每项映射为 `{name, description, body, model_invocable?, user_invocable?}`；WebShell 在创建时导入快照（`WorkspaceBindingCreator.tsx:861-905`）；Java 准入并合并（`ManagedAgentService.java:532,560-562,591-594`、`AgentSessionAdmissions.java:236-264`），把目录冻结进 `ma_request_receipt`（`JdbcManagedSessionSkills.java:190-202`）；派发时发布为 `managed-agent-skills` 资源（`QwenHostedHarnessConnector.java:2341-2356`）。
- **路径 B — 存储的 AgentDefinition skills。** pinned definition 的 `skills` 数组（`QwenHostedHarnessConnector.java:2295-2337`）。内置 `qwen-code` agent 无存储行、不携带任何 skill（`AgentSessionPolicies.java:185-196`）。
- **消费者。** `HostedSkillCatalog`（`hosted-skill-catalog.ts`）解析资源字节；effective 目录为 `sessionSkillsRef ?? agentDefinition.skillsRef`（`hosted-harness-session.ts:6354-6355`）。WebShell 目录读取对 READ profile 返空（`ManagedSkillCatalogService.java:25-27`）。

四个事实约束设计：

1. **wire 格式没有 `allowedTools`。** `SKILL_FIELDS` 为 `{name, description, body, base_directory, model_invocable, user_invocable}`（`AgentDefinitionExtensions.java:26`）；消费端接受同样字段外加 `asset_directory`（`hosted-skill-catalog.ts:86-160`）。读 body 时 frontmatter 即被剥离（`skill-manager.ts:742-749`）。本地 `BundledSkillLoader` 门按 frontmatter 的 `allowedTools` 判定（`BundledSkillLoader.ts:55-66`），且只管交互式 slash 命令可见性——无法搬到 managed wire 上。
2. **今天 skill 侧没有任何门。** skill 准入既不咨询 automation 设置、loop env 门，也不咨询 profile（catalog 目录零 `cron` 命中）。唯一的 profile 敏感性是 READ profile 返空目录。
3. **目录创建即冻结。** receipt 按 digest 寻址且不可变；load 拒绝变更或省略的 ref（`hosted-harness-session.ts:6342-6354`）。变体无法热替换进存活 Session；其形态在创建时刻固定。
4. **无任何 managed skill 变体先例。** 任何地方都没有 managed 专属 skill body，也没有其他 bundled skill 的 managed 变体可作模板。最接近的先例是按 profile 组合工具描述（`hosted-workspace-tool-turn.ts:920-981,2716-2742`），但它覆盖工具，不覆盖 skill。

变体必须在其间降级的 profile 形状（`WorkspaceToolProfiles.java`、`hosted-workspace-tool-turn.ts:2488-2513`）：

| Profile                        | `cron_create` | `cron_list`/`cron_delete` | `loop_wakeup` |
| ------------------------------ | ------------- | ------------------------- | ------------- |
| `hosted-workspace-shell/3`     | —             | ✓                         | ✓             |
| `hosted-workspace-files/4`     | ✓             | ✓                         | —             |
| `hosted-workspace-team-lead/2` | ✓             | ✓                         | —             |
| `hosted-workspace-shell/4`     | ✓             | ✓                         | ✓             |
| `hosted-workspace-read/1`      | —             | —                         | —             |

工具背后有两个独立部署门：automation 设置 `qwen.managed-agent.automation.enabled`（Java 侧，门控 `cron_create` 与 scanner，`ManagedAutomationService.java:810`）与 loop env 契约 `QWEN_MANAGED_AGENT_LOOP_ENABLED`（Harness 进程 env，门控 wakeup arming，`hosted-loop-session.ts:57-63,354`）。两者都是**操作门，而非声明门**：工具声明纯按 profile 驱动（`declaresCronCreate` / `declaresLoopTool` / `declaresCronTools`，`hosted-workspace-tool-turn.ts:2488-2513`，不咨询任何门），门在运行时以类型化错误拒绝调用，但保留声明。loop 门在准入时也**对 Java 不可见**。

## 目标

- 发布一个 Managed `/loop` skill 变体，其 body 教授与 bundled skill 相同的解析、interval-to-cron 表与子命令，但用 Managed durable/expiry 措辞（恒 durable、运行至取消、无 7 天过期）。
- 变体可见性随 Session profile 声明的工具门控，使 body 绝不把模型引向准入链拒绝的工具。
- 在四个携带 creator 的 profile 与 READ profile 上正确降级，且只有一个工具切片的门启用时仍正确。
- 共享 skill 内容保持单一来源，使本地与 managed body 不会静默漂移。

## 非目标

- 不改工具面、scanner、journal schema 或触发管线（均已合入）。
- 不新增 skill wire 字段；`allowedTools` 仅作源资产属性。
- 不向存活 Session 热替换目录（receipt 不可变）。
- 无 Web Shell 调度 UI；除变体出现在目录外不改创建导入 UX。
- 真实 `/loop` 模型回合 E2E 仍是独立验证工作。

## 提议方案

在**创建准入时服务端注入** managed loop 变体，按 Session 的 tool profile 选择，注入到被冻结与发布的同一合并目录。这是唯一知道 profile、并写入 Harness 资源与 WebShell 目录都读取的不可变快照的点。

### 设计决策

**D1 — 生产者：Java 创建准入。** 在 `AgentSessionAdmissions` 中，caller/definition skills 合并之后、`creationSkills.save` 之前，当 profile 声明至少一个 loop creator（`cron_create` 或 `loop_wakeup`）时，加入 managed loop 变体。注入**纯按 profile 驱动**：部署门不作为条件，因为它们是保留工具声明的操作门（见现状），skill 镜像声明。变体是服务端贡献，不是 caller skill：即使 caller 提供空 `skills` 数组（内置 `qwen-code` 情形）也必须加入，因此 `if (!skills.isEmpty())` 的 save 守卫放宽为"effective 目录非空即 save"。变体在请求 digest 计算**之后**注入，不扰动幂等；由于 profile 是同一创建请求的确定性输入，重放注入相同变体、复现相同快照。

**D2 — 可见性随工具门控，按 profile。** 变体 body 由章节块组合，使其只描述 profile 声明的 creator，镜像工具描述原则"声明绝不点名 Session 未声明的工具"（`hosted-workspace-tool-turn.ts:920-931`）。具体：

- 固定间隔 recurring 章节（调用 `cron_create`）仅在 profile 声明 `cron_create` 时包含（files/4、team-lead/2、shell/4）。
- 自定步调 / wakeup 章节（调用 `loop_wakeup`）仅在 profile 声明 `loop_wakeup` 时包含（shell/3、shell/4）。
- `cron_list` / `cron_delete` 与 `list` / `clear` 子命令在声明并集处恒描述（全部四个携带 creator 的 profile）。
- READ profile 与任何不声明 loop creator 的 profile 不得到变体（空贡献），与现有 READ 空目录规则一致。

两个部署门都不改变 body。变体在 profile 声明 `loop_wakeup` 处描述 wakeup 路径、在声明 `cron_create` 处描述固定间隔路径，与门无关；门在运行时以类型化错误拒绝 create/arming 调用，正如不变的工具声明已然允许。这使 skill 与工具面一致，而非试图从控制面预测运行时操作门（其中之一 loop env 门甚至对 Java 不可见）。

**D3 — skill 来源与单一来源。** 共享 skill 内容住在 bundled `SKILL.md`。TypeScript 生成器 `buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` 从它派生 managed skill（description + body）：一组小的、有文档的措辞替换（durable/expiry/UTC 句）加 profile 条件章节选择。由于两条路径在 body 中深度交织（Parsing、loop.md 模式、Autonomous 模式都引用两个 creator），组合住在 TypeScript，而非 Java 字符串外科手术。三个 JSON sidecar（description + body）生成并提交在 `packages/core/src/managed-runtime/contracts/` 下——union（shell/4）、cron-only（files/4、team-lead/2）、wakeup-only（shell/3）——contracts 模块已把该目录拷贝到 Java classpath（`contracts/pom.xml:53-54`）。TypeScript 一致性测试断言每个提交 sidecar 与生成器输出逐字节相等，并把生成器绑回 bundled 源；任一方向漂移都使测试变红（"从生产者钉消费者"模式）。Java 是纯选择器：按 Session 的 profile 读 sidecar 并注入，不做字符串组合。

**D4 — 冻结、重放安全、容量受限。** 注入的变体搭乘现有不可变 receipt 与 digest；无新资源 kind、无 schema 版本 bump。loop body 约 6–10 KiB，远低于 512 KiB 单 body / 2 MiB 目录上限（`AgentDefinitionExtensions.java:42-81`）。注入对 profile 确定，保持幂等键下的重放。

**D5 — 命名。** 变体保持 skill 名 `loop`，使 `/loop` 调用与 `allowedTools` 源属性不变；只有 body 措辞与 profile 条件章节不同。服务端变体是权威的：Web Shell 从 daemon 快照原样导入 bundled `loop` skill，故默认创建路径的 caller 目录已含一个 `loop` 项。因此 `mergeInto` **替换**任何已有 `loop` 项而非拒绝请求——拒绝会使所有携带 loop 的 profile 上的 Web Shell 创建都 409。覆盖由准入测试钉住（caller 导入的本地 `loop` body 被服务端变体替换，而非被拒）。

注入按协商的 Session Skills 能力门控（`sessionSkillsSupported`，循其他能力标志经 `SessionCreationCommand` 传入）：不通告 `session-skills/2` 的 Harness 得不到服务端行，使失败留在创建期而非派发期。save 守卫在 effective 目录（definition skills + caller skills + 注入变体，剥离后）非空时写行；pinned definition 的存储 skills 只要有 pinned definition 就合并，故注入的行携带 definition 的 skills 加 `loop`，绝不在消费端遮蔽 definition 目录。

### 涉及文件

- `packages/core/src/managed-runtime/contracts/` — 三个生成的 managed loop JSON sidecar（description + body；union / cron-only / wakeup-only），拷贝到 Java。
- `packages/core/src/skills/bundled/loop/managed-loop-skill.ts` — `buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` 生成器（措辞替换 + 章节选择）；同址一致性测试把生成 sidecar 绑回 `SKILL.md` 并在每个 profile 间钉住共享 steward 段（不改 `SKILL.md` 本身）。`regenerate-managed-loop-assets.ts` 是提交的再生成入口。
- `packages/managed-agent-server/persistence/.../ManagedLoopSkill.java` — 纯 profile-到-sidecar 选择器、`mergeInto`（覆盖 + 能力门 + 容量跳过）与子会话 `reselectForProfile`；读 classpath sidecar，不做字符串组合。
- `packages/managed-agent-server/persistence/.../AgentSessionAdmissions.java` — 合并 pinned definition 的 skills、调用 `mergeInto`、在 effective 目录非空时写行，并在保存子会话目录前按子 profile 重选继承的 loop 项。
- `packages/managed-agent-server/contracts/.../SessionCreationCommand.java` 与 `control-plane/.../ManagedAgentService.java` — 从协商的 Harness 传入 `sessionSkillsSupported` 能力标志。
- `packages/managed-agent-server/contracts/pom.xml` — 把生成 sidecar 拷贝到 Java classpath。
- `packages/managed-agent-server/Dockerfile` — 把生成 sidecar COPY 进镜像构建；scripts 测试把 COPY 集钉回 contracts pom includes，缺资产拷贝即红。
- 验证：跨每个 profile 的选择器单测（含 null 与无 creator）、目录容量跳过、只读子会话重选；以及准入测试——空 caller 注入、caller 导入 `loop` 的覆盖、pinned-definition-带-skills 的不遮蔽、门关闭行为、重放确定性、无 creator 的剥离——在 H2 与真实 MySQL 8.4 上。

## 约束

- wire 格式承载不了 `allowedTools`；门控必须住在生产者。
- 目录创建后不可变；降级在创建时固定。
- loop env 门是 Harness 进程级、对 Java 不可见；skill 跟随 profile 的工具声明，而非门。
- 核心基础设施（控制面准入、contracts、core 资产）——属 maintainer 领域，遵循 `AGENTS.md` 的两级门。

## 风险

- **body 组合复杂度。** 两条路径在 body 中深度交织（Parsing、loop.md 模式、Autonomous 模式），故按 profile 组合很精细。缓解：组合住在 TypeScript 生成器（D3），Java 只选择；一致性测试把每个生成 body 逐字节钉回 bundled 源，删掉某 creator 章节的变异使其变红。
- **单一来源漂移。** 两个提交 body（本地 + managed）可能分叉。缓解：D3 的一致性测试从 bundled 源派生 managed 资产。
- **幂等交互。** 在请求 digest 之后注入不得改变重放结果。缓解：重放测试断言相同快照。
- **caller 导入的本地 `loop`。** Web Shell 原样提交 bundled `loop`，故服务端变体替换它（D5）；测试钉住替换。无 creator 的 profile 上 caller 的 `loop` 被丢弃，故不会发布点名未声明工具的 body。
- **目录容量。** caller 目录已贴 published 256 条 / 2 MiB 上限时跳过注入（而非拒绝）；单测钉住 256 条时的跳过。
- **snapshot 子会话。** 准入到不同 profile 的子会话（snapshot 子会话为只读）在 save 前按自身 profile 重选 loop 项，故只读子会话不会继承点名其缺失工具的 body。

## 验证计划

- 准入矩阵：shell/3、files/4、team-lead/2、shell/4 各收到一个变体，其 body 恰好点名该 profile 声明的 creator；READ 与无 creator profile 不得到（caller 导入的 `loop` 被剥离）。
- 空 caller-skills：pinned 到携带 creator profile 且无 caller skills 的 definition 仍收到变体。（内置 `qwen-code` agent 解析为 shell/1 或 files/1，正确地不得到。）
- 门无关性：Session Skills 能力关闭时不写服务端行，保持创建期行为。
- 重放：重驱动的创建注入相同变体、复现相同 receipt digest。
- 一致性：TS 测试断言每个 profile 的 sidecar 等于生成器输出，并钉住共享 steward 段、home-only loop.md 路径、无不可展开 cron 哨兵、UTC 措辞；漂移任一的变异使其变红。
- 镜像：scripts 测试把 Dockerfile COPY 集钉回 contracts pom includes，缺资产拷贝即红。
- Skill E2E（延后到独立 E2E 工作）：`/loop 5m …` 创建定义并立即跑 prompt；`/loop list` 显示；`/loop clear` 退役。

## 验收标准

- 携带 creator 的 profile 上的 Managed Session，其发布目录中有 `loop` skill，body 用 Managed durable/expiry/UTC 措辞、只点名该 profile 声明的 creator、不教不可展开的 cron 哨兵、只声明 home `~/.qwen/loop.md` 文件。
- pinned 到携带 creator profile 且无 caller skills 的 definition 收到变体；内置 `qwen-code` agent（shell/1 / files/1）不得到。
- READ profile 与无 creator profile 不发布 loop skill，只读 snapshot 子会话不继承。
- 重放的创建产生相同目录快照。
- managed sidecar 无法在不使一致性测试变红的情况下偏离 bundled 源。
- 无新 wire 字段、资源 kind 或 journal 变更。

## 开放问题

设计期间已解决（留档）：

- **组合位置。** TypeScript 生成器为每个 profile 形状派生一个提交 sidecar（union / cron-only / wakeup-only，含 description + body），Java 按 profile 选择；一致性测试把资产绑回 bundled 源。在发现两条路径于 body 中深度交织、使 Java 字符串外科手术脆弱后，从纯 Java 组合 refine 而来。已定：TypeScript 生成 + Java 选择。
- **门关闭粒度。** 部署门是保留工具声明的操作门（`hosted-workspace-tool-turn.ts:2488-2513` 不咨询门），故 body 按 profile 驱动、与门无关；门在运行时拒绝调用。已定：门不影响 body。
- **与 caller 导入的本地 `loop` 共存。** Web Shell 从 daemon 快照原样导入 bundled `loop`，拒绝重名会使所有携带 loop 的 profile 创建 409。服务端变体为权威，替换任何同名项；无 creator profile 上丢弃 caller 的 `loop`。已定：替换 + 文档化（在发现默认路径 409 后从最初的拒绝提案 refine）。
- **cron 触发机制。** Managed cron 触发不展开 loop 哨兵（仅自定步调 wakeup 触发展开），故 cron 路径教自然语言 prompt 由模型每次触发自行执行（自己读 home `~/.qwen/loop.md`）；仅 wakeup 路径用哨兵。已定：自然语言 cron prompt（不改生产触发路径）。

实现阶段无遗留开放问题。
