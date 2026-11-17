# Managed `/loop` skill 资产

[English](2026-11-14-managed-loop-skill-asset.md) | [简体中文](2026-11-14-managed-loop-skill-asset.zh-CN.md)

状态：已在本改动中实现。解决[固定间隔调度设计](2026-11-10-managed-loop-schedule.md)的开放问题 4，以及[自定步调唤醒设计](2026-11-10-managed-loop-wakeup.md)的共享 skill 触点。两个工具切片均已合入（#16835 `70a487be84`、#17088 `f3dc48c79e`，评审跟进 #17197 `0ffaea08ba` 与 #17235 `9d390e23af`）；两者共同延后的 skill 变体已在本改动中落地。

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

## 提议方案

在**创建准入时服务端注入** managed loop 变体，按 Session 的 tool profile 选择，注入到被冻结与发布的同一合并目录。这是唯一知道 profile、并写入 Harness 资源与 WebShell 目录都读取的不可变快照的点。

### 设计决策

**D1 — 生产者：Java 创建准入。** 在 `AgentSessionAdmissions` 中，caller/definition skills 合并之后、`creationSkills.save` 之前，当 profile 声明至少一个 loop creator（`cron_create` 或 `loop_wakeup`）时，加入 managed loop 变体。注入**纯按 profile 驱动**：部署门不作为条件，因为它们是保留工具声明的操作门（见现状），skill 镜像声明。变体是服务端贡献，不是 caller skill：即使 caller 提供空 `skills` 数组（pinned 到携带 creator profile 的 definition）也必须加入。save 守卫在 effective 目录非空且有 caller 贡献或注入了变体时写行；仅 definition 的目录（无 caller skills、无变体）留在 definition `skillsRef`，使 skill 读取保留 definition-digest 冲突检查；空的 effective 目录绝不写行。变体在请求 digest 计算**之后**注入，不扰动幂等；由于 profile 是同一创建请求的确定性输入，重放注入相同变体、复现相同快照。

**D2 — 可见性随工具门控，按 profile。** 变体 body 由章节块组合，使其只描述 profile 声明的 creator，镜像工具描述原则"声明绝不点名 Session 未声明的工具"（`hosted-workspace-tool-turn.ts:920-931`）。具体：

- 固定间隔 recurring 章节（调用 `cron_create`）仅在 profile 声明 `cron_create` 时包含（files/4、team-lead/2、shell/4）。
- 自定步调 / wakeup 章节（调用 `loop_wakeup`）仅在 profile 声明 `loop_wakeup` 时包含（shell/3、shell/4）。
- loop.md 任务文件模式只为自定步调路径描述：wakeup fire 会解析 `<<loop.md-dynamic>>` 哨兵，而 cron fire 既不展开哨兵、模型也无法打开 Harness 主机上的 home 文件（读取被限制在会话工作目录内），故 cron body 与 union 的 cron 半部不带 loop.md 模式。
- `cron_list` / `cron_delete` 与 `list` / `clear` 子命令在声明并集处恒描述（全部四个携带 creator 的 profile）。
- READ profile 与任何不声明 loop creator 的 profile 不得到变体（空贡献），与现有 READ 空目录规则一致。

两个部署门都不改变 body。变体在 profile 声明 `loop_wakeup` 处描述 wakeup 路径、在声明 `cron_create` 处描述固定间隔路径，与门无关；门在运行时以类型化错误拒绝 create/arming 调用，正如不变的工具声明已然允许。这使 skill 与工具面一致，而非试图从控制面预测运行时操作门（其中之一 loop env 门甚至对 Java 不可见）。

**D3 — skill 来源与单一来源。** 共享 skill 内容住在 bundled `SKILL.md`。TypeScript 生成器 `buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` 从它派生 managed skill（description + body）：一组小的、有文档的措辞替换（durable/expiry/UTC 句）加 profile 条件章节选择。每个顶层章节都必须在允许列表中分类——未知或重命名的章节会使生成器失败，直到被显式消费或忽略——且 Parsing 的间隔语法从源派生，因此新增章节或语法改动不会静默地从 managed body 中丢失。由于两条路径在 body 中深度交织（Parsing、loop.md 模式、Autonomous 模式都引用两个 creator），组合住在 TypeScript，而非 Java 字符串外科手术。三个 JSON sidecar（description + body）生成并提交在 `packages/core/src/managed-runtime/contracts/` 下——union（shell/4）、cron-only（files/4、team-lead/2）、wakeup-only（shell/3）——contracts 模块已把该目录拷贝到 Java classpath（`contracts/pom.xml:53-54`）。TypeScript 一致性测试断言每个提交 sidecar 与生成器输出逐字节相等，并把生成器绑回 bundled 源；任一方向漂移都使测试变红（"从生产者钉消费者"模式）。Java 是纯选择器：按 Session 的 profile 读 sidecar 并注入，不做字符串组合。

**D4 — 冻结、重放安全、容量受限。** 注入的变体搭乘现有不可变 receipt 与 digest；无新资源 kind、无 schema 版本 bump。loop body 约 6–10 KiB，远低于 512 KiB 单 body / 2 MiB 目录上限（`AgentDefinitionExtensions.java:42-81`）。注入对 profile 确定，保持幂等键下的重放。

**D5 — 命名与归属。** 变体保持 skill 名 `loop`，使 `/loop` 调用与 `allowedTools` 源属性不变；只有 body 措辞与 profile 条件章节不同。Web Shell 从 daemon 快照原样导入 bundled `loop` skill，故默认创建路径的 caller 目录已含一个 `loop` 项。因此 `mergeInto` **替换 bundled 的 caller 导入**而非拒绝请求——拒绝会使所有携带 loop 的 profile 上的 Web Shell 创建都 409。替换按来源限定：只有 body 等于提交的 bundled-body 参考的条目才是服务端可替换的。**用户自定义的** caller `loop`（其它任何 body）与 **definition 作者自带的** `loop` 都予以保留——服务端既不替换它们、也不注入竞争项（目录须保持名字唯一）。这些行为均由准入测试钉住（bundled 导入被服务端变体替换；用户自定义或 definition 自带的 `loop` body 在无 creator 与携带 creator 的 profile 上都存活）。

注入按协商的 Session Skills 能力门控（`sessionSkillsSupported`，循其他能力标志经 `SessionCreationCommand` 传入）：不通告 `session-skills/2` 的 Harness 得不到服务端行，使失败留在创建期而非派发期。save 守卫即 D1 所述：仅 caller 贡献或注入变体才写行（绝不写仅 definition 的目录、绝不写空目录），故注入的行携带 definition 的 skills 加 `loop`，绝不在消费端遮蔽 definition 目录。子会话目录在保存前重选：唯一的非空子 profile 是 READ（snapshot 子会话），服务端注入的 loop 变体被丢弃（它点名 READ 未声明的 creator），definition 自带的 loop 原样继承。服务端变体的来源取自父会话快照在注入时记录的标记，而非 body 文本，故 sidecar 重生成后旧版本写的变体仍被丢弃；definition 例外取自父会话 pinned definition（是否自带 `loop`）。用户自定义的 caller loop 绝不删除。空的解析结果不写行，而非写一个此后每次快照读取都会拒绝的空行。

### 涉及文件

- `packages/core/src/managed-runtime/contracts/` — 三个生成的 managed loop JSON sidecar（description + body；union / cron-only / wakeup-only）加一份逐字 bundled-body 参考（用于识别 Web Shell 导入），拷贝到 Java。
- `packages/core/src/skills/bundled/loop/managed-loop-skill.ts` — `buildManagedLoopSkill(profile, bundledBody, frontmatterDescription)` 生成器（措辞替换 + 章节选择）；同址一致性测试把生成 sidecar 绑回 `SKILL.md` 并在每个 profile 间钉住共享 steward 段（不改 `SKILL.md` 本身）。`regenerate-managed-loop-assets.ts` 是提交的再生成入口。
- `packages/managed-agent-server/persistence/.../ManagedLoopSkill.java` — 纯 profile-到-sidecar 选择器（带缓存）、`mergeInto`（仅覆盖 bundled + 能力门 + 容量跳过时丢弃 bundled 导入）与子会话 `childCatalog`（按 definition 来源重选）；读 classpath sidecar，不做字符串组合。
- `packages/managed-agent-server/persistence/.../AgentSessionAdmissions.java` — 合并 pinned definition 的 skills（携带于 `AgentPin`，在 `resolveAgentPin` 解析一次）、调用 `mergeInto`（复用其已校验目录）、仅在 effective 目录非空且有 caller 贡献或注入了变体时写行，并在保存子会话目录前按父 definition 来源重选继承的 loop（空的解析结果不写行）。
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
- **caller 导入的本地 `loop`。** Web Shell 原样提交 bundled `loop`，故服务端变体替换它（D5）；测试钉住替换。仅替换 bundled 导入：用户自定义的 caller `loop` 在任何 profile 上保留（它是用户的内容，即便点名该 profile 缺失的工具）；无 creator 的 profile 上仅丢弃 bundled 导入，故服务端发布的 body 不会点名未声明的工具。
- **目录容量。** 变体放不进 published 256 条 / 2 MiB 上限时跳过注入（而非拒绝）；bundled caller 导入保持丢弃，使创建在容量内成功而非被拒绝。测试钉住 256 条时的跳过，以及准入接受所得目录（去掉变体后本身已超容的目录仍被拒绝）。
- **snapshot 子会话。** snapshot 子会话为只读；服务端注入的 loop 变体在 save 前被丢弃（它点名 READ 缺失的 creator），definition 自带的 loop 原样继承。来源是父会话快照在注入时记录的标记（当前 sidecar body 作兜底），而非仅凭 body 文本，故 sidecar 重生成后旧版本写的变体仍被丢弃。用户自定义的 caller loop（无服务端注入）是用户的内容，绝不按名删除。definition 例外取自父会话 pinned definition。

## 验证计划

- 准入矩阵：携带 creator 的 definition 收到一个变体，其 body 恰好点名该 profile 声明的 creator（在 files/4 上实测，它是可定义选择的 profile；选择器与一致性测试覆盖 shell/3、team-lead/2、shell/4）。READ 与无 creator profile 不得到服务端变体：仅逐字 bundled `loop` 导入被替换（携带 creator）或丢弃（无 creator）；用户自写的 `loop` 被保留。
- 空 caller-skills：pinned 到携带 creator profile 且无 caller skills 的 definition 仍收到变体。（内置 `qwen-code` agent 解析为 shell/1 或 files/1，正确地不得到。）
- 门无关性：Session Skills 能力关闭时不写服务端行，保持创建期行为。
- 重放：重驱动的创建注入相同变体、复现相同 receipt digest。
- 一致性：TS 测试断言每个 profile 的 sidecar 等于生成器输出，并钉住共享 steward 段、home-only loop.md 路径、无不可展开 cron 哨兵、UTC 措辞；漂移任一的变异使其变红。
- 镜像：scripts 测试把 Dockerfile COPY 集钉回 contracts pom includes，缺资产拷贝即红。
- Skill E2E（`npm run test:e2e:managed-loop-skill`，全栈 runner 的 `--loop-skill` 模式）：Session 以一个调用方 `loop` 导入创建，其正文是逐字 bundled 参考，使准入的替换路径像真实创建一样执行。见证是双向的：导入的标记 description 必须消失（服务端用变体替换了它），而第二个非 loop 探针 skill 的标记必须保留（调用方 skills 到达了准入），从而该臂能区分「替换确实执行」与「调用方 skills 从未到达」。携带 creator 的 `files/4` definition 在准入时收到 cron 变体，模型第一流式回合的 Skill 工具结果承载该正文，`cron_list` 回显创建的 prompt，`cron_delete` 退役自动化存储铸造的 id 且删除结果声明退役。该臂作为完整 tier `hosted-failover-e2e` CI job 的一个步骤运行；观察实际触发仍不在范围内。

## 验收标准

- 携带 creator 的 profile 上的 Managed Session，其发布目录中有 `loop` skill，body 用 Managed durable/expiry/UTC 措辞、只点名该 profile 声明的 creator、不教不可展开的 cron 哨兵、只点名 wakeup fire 读取的 `$QWEN_HOME/loop.md` 文件。
- pinned 到携带 creator profile 且无 caller skills 的 definition 收到变体；内置 `qwen-code` agent（shell/1 / files/1）不得到。
- READ profile 与无 creator profile 不发布服务端 loop 变体，只读 snapshot 子会话不继承——包括旧版本写的变体，按快照的服务端来源标记（而非 body 文本）丢弃；definition 自带的 `loop` 项在任何 profile 上保留并原样继承给子会话，用户自写的 caller loop 绝不删除。
- 重放的创建产生相同目录快照。
- managed sidecar 无法在不使一致性测试变红的情况下偏离 bundled 源。
- 无新 wire 字段、资源 kind 或 journal 变更；服务端 loop 来源标记存于内部创建快照（快照版本号 bump），不在发布的 skill wire 格式中。

## 开放问题

设计期间已解决（留档）：

- **组合位置。** TypeScript 生成器为每个 profile 形状派生一个提交 sidecar（union / cron-only / wakeup-only，含 description + body），Java 按 profile 选择；一致性测试把资产绑回 bundled 源。在发现两条路径于 body 中深度交织、使 Java 字符串外科手术脆弱后，从纯 Java 组合 refine 而来。已定：TypeScript 生成 + Java 选择。
- **门关闭粒度。** 部署门是保留工具声明的操作门（`hosted-workspace-tool-turn.ts:2488-2513` 不咨询门），故 body 按 profile 驱动、与门无关；门在运行时拒绝调用。已定：门不影响 body。
- **与 caller 导入的本地 `loop` 共存。** Web Shell 从 daemon 快照原样导入 bundled `loop`，拒绝重名会使所有携带 loop 的 profile 创建 409。服务端变体仅替换 bundled 导入（body 等于提交的 bundled-body 参考），并沿用其调用标记；无 creator profile 上丢弃 bundled 导入。用户自定义的 caller `loop` 或 definition 自带的 `loop` 予以保留并抑制服务端变体——这是合并目录重名规则的例外。已定：仅替换 bundled 导入 + 文档化（在发现默认路径 409 后从最初的拒绝提案 refine，再限定到 bundled 导入，使用户自定义 loop 不被静默覆盖或删除）。
- **cron 触发机制。** Managed cron 触发不展开 loop 哨兵（仅自定步调 wakeup 触发展开），且模型无法打开 Harness 主机的 home 文件（读取被限制在会话工作目录内），故 cron body 不带 loop.md 任务文件模式、也不带任何哨兵；cron 自主循环是自然语言 steward 指令，由模型每次触发自行执行。仅 wakeup 路径用哨兵与 loop.md 文件模式。已定：cron 不带 loop.md 模式（不改生产触发路径）。

实现阶段无遗留开放问题。
