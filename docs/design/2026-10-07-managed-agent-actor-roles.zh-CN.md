# Managed Agent actor 角色与租户隔离验收

[English](2026-10-07-managed-agent-actor-roles.md) | [简体中文](2026-10-07-managed-agent-actor-roles.zh-CN.md)

议题：#13535（R1 actor 角色，R2 隔离验收）。上层：#12380 生产启用。词表来源：#12867 第 10 节（`reader`、`operator`、`owner`；无读权限返回 `404`，有读无操作权限返回 `403`；幂等域包含 actor —— D4 已在操作台账落地这一部分；submitter 族的命令键仍是 `(tenant_id, operation, idempotency_key)`，其 actor 限定跟进为 #13619）。本设计回答 #12867 的开放问题 Q4（角色从哪里来），并定义 surface 注册表及其构建门禁。

核实基点：`main` = `ac497aeed9`（比 issue 点名的 `b585508733` 基线新一个提交；增量是本模块之外的 TUI 改动）。

状态：切片 A（#13543）按今天的准入落地注册表及其门禁，D2/D3 中的 V53
角色存储随切片 B（#13544）落地，两者均已合入。本 PR 是切片 C—— 下文
D4/D7 的强制执行各节描述的是它落地的改动。

## 1. 问题

两个性质不同的缺口：

- **R1 —— 没有角色词表。** 到目前为止合入的每个绑定 Session 操作都只准入其创建者，对其他任何人返回 `404` 或 `403`。`AuthenticatedTenantActor` 只带 `tenantId()` 与 `actorId()`，此外什么都没有。两个产品行为今天被阻塞：同一 Workspace 上的第二个操作者无法回答一个正阻塞 Turn 的审批；绑定 Workspace 的 Session 无法移交，因为没有任何东西能表达「与创建者不同的所有者」。
- **R2 —— 没有系统性验收。** 准入覆盖是逐切片随能力合入累积的。56 条公开与 WebShell 路由的 API 契约测试已经能在「实现了但未列入 OpenAPI 契约」时失败，并对每个契约操作打跨租户探针；而原始切片 A 基线的 22 条内部路由没有东西门禁，没有探针打「低于读者」「有读而无本族权限」的调用方，也没有把路由与它应遵守的准入规则绑定 —— 于是一条路由带着错误的校验落地而全部测试保持绿色，这正是此面仍在快速增长时最要紧的失效模式。

## 2. 现状

身份只有 `(tenantId, actorId)`，由受信过滤器提供（SIGNED 模式的 `SignatureAuthFilter`，OPEN 模式的替代 `TrustedActorHeaderFilter`）；`AuthenticatedActor` 契约不被本设计改变。

今天的授权 = 授权表行 + 创建者记录：

- `managed_workspace_access(tenant_id, workspace_id, actor_id, can_read, can_create)`（V8）—— 唯一的按 actor 授权表，在每一条 Workspace 绑定路由的读路径上。其领域枚举是 runtime-broker 模块的 `WorkspaceAccess`（NONE/READ/CREATE，CREATE 蕴含 READ）。
- `managed_agent_session.creator_actor_key`（V40）加上 `managed_workspace_create_command`（V9，幂等命令记录）—— 「创建者」的两份拷贝。

「仅创建者」是三种机制、三套拒绝词表：

| 族                                                      | 路由                                                                                                                  | 校验                                                                            | 可读的非创建者得到                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| Turn 提交 / 取消 / 改名                                 | 公开 `POST …/events`（提交与取消）、`PATCH …/{id}`；WebShell `turns/submit`、`turns/cancel`（改名没有 WebShell 路由） | `requireSubmitter` → `maySubmitWorkspaceTurn`（创建命令行 + 当前 `can_create`） | **409 `workspace_unavailable`**   |
| 生命周期（close、archive、unarchive、delete）+ cwd 变更 | `POST …/close \| archive \| unarchive`、`DELETE`、`POST …/cwd`，及 WebShell 孪生                                      | `requireWorkspaceCreator`（先 can_read 再创建命令行）                           | 403 `session_operation_forbidden` |
| Action（审批）回答                                      | `POST …/actions/{id}/responses`、WebShell `actions/respond`                                                           | `requireOwner`（creator_actor_key，回退创建命令）                               | 403 `action_forbidden`            |

其余已实现的规则形态：绑定读取与全部 list/stream/catalog 路由要求 `can_read`（否则 404）；绑定创建要求 actor + `can_create` + `ACTIVE` Workspace（按失败点返回 401/404/403/409）；artifact 字节读取叠加部署策略门（`403 artifact_content_forbidden`）；Workspace 发现只列出 `can_read` 行（无 actor 返回 401）；legacy（未绑定）Session 与 agent 定义是**租户级**的 —— 租户内任何 actor 今天都可以改它们；内部 store/publication 路由准入 writer HMAC 凭据而非 actor。公开面是 `/v1/agents/**` 加 `/api/agent/web-shell/v1/**`（`PublicSurface`），由十个 Spring controller 实现 —— 第 10 节的矩阵枚举当前的 32 条公开 + 24 条 WebShell + 24 条内部路由（含 L3 两条授权入口，合计 80；这里上次写的是 #13088 之前的 77/21，L3 之前是 78）。

workspace registry/access 行没有任何生产置备路径 —— 今天只有测试与 fixture 入口写它们，部署环境靠带外方式写入；全仓没有 role 列、owner 列，也没有按租户存放 actor 的表。

## 3. 决策

### D1 —— 角色词表

三个角色，有序 NONE < READER < OPERATOR < OWNER，含义沿用 #12867 第 10 节钉下的：

- **READER** —— 可读但不可回答：该 actor 今天能做的全部读取，仅此而已。
- **OPERATOR** —— READER 加「可操作但不可删除」：提交与取消 Turn、改名、变更 cwd、在 Workspace 上创建 Session、回答其 Action（审批）。这修复被阻塞的审批交接。
- **OWNER** —— OPERATOR 加生命周期：close、archive、unarchive、delete。

拒绝契约按 #12867：无读授权 → `404`；有读但操作权限不足 → `403`，按族命名（`session_operation_forbidden`、`action_forbidden`）。submitter 族的 `409 workspace_unavailable` 特例被移除（第 5 节）。

### D2 —— 角色属于 Workspace 绑定

Q4 的答案：一张授权表，按 `(tenant_id, workspace_id, actor_id)` 键 —— 即已经存在、且已在每条绑定路由读路径上的 `managed_workspace_access` 表。不采用网关声明：`AuthenticatedTenantActor` 契约保持 tenant + actor，按 Workspace 的授权塞不进声明集。不采用按 Session 键：那会把行数乘以 sessions × actors，且每次创建都要为一组服务器无法枚举的 actor 做扇出插入；被阻塞的行为恰恰由谁共享 _Workspace 绑定_ 定义。不采用按租户键：那无法表达「A 上是 reader、B 上是 operator」。

具体地，迁移 V53 用一列取代两个布尔：

```sql
ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NULL;
-- 没有 can_read 的行今天不授予任何东西；保留它会经回填拿到 READER
-- （若是 can_create 行则拿到 OPERATOR）。
DELETE FROM managed_workspace_access WHERE can_read = FALSE;
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access
    MODIFY COLUMN role VARCHAR(16) NOT NULL;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK ((role = 'READER' AND CHAR_LENGTH(role) = 6)
        OR (role = 'OPERATOR' AND CHAR_LENGTH(role) = 8)
        OR (role = 'OWNER' AND CHAR_LENGTH(role) = 5));
```

复合语句按仓内迁移先例（V7、V12、V24、V40）拆成每动作一条；`role` 以无默认值到达，像布尔省略时一样响亮失败，先回填每一既有行再设 `NOT NULL`，`CHAR_LENGTH` 钉则抵消 utf8mb4 的 PAD-SPACE 等值把 `'READER '` 存成 `READER`。先删除无可读行再回填，才使这次改动对每一个可达授权行都只是改名。`role` 是唯一存储词表；不双写。`WorkspaceAccess` 枚举变为 `NONE / READER / OPERATOR / OWNER`（READ→READER、CREATE→OPERATOR）；`OWNER` 蕴含 `OPERATOR` 蕴含 `READER`。每个 store 读取点（`canRead`、`findReadable`、`listReadable`、`canCreateSession`、`resolveForCreation`、`authorizePassiveAttachment`、SSE 读授权复查、list 路由的 SQL 过滤）保持当前判定不变，布尔由 `role` 重新推导 —— 这是一次行为不可见的内部改动，由现有测试套件钉住。`NONE` 不可存储（CHECK 排除它）；它保留为「无行」的领域值。

授权置备保持带外，与今天两个布尔的置备方式一致：fixture/部署 SQL 写行；本切片不出现 HTTP 授权管理路由（第 6 节）。

### D3 —— Session 记录持有 owner，默认为其创建者

V53 同时新增 `managed_agent_session.owner_actor_key VARBINARY(2048) NULL`，并从 `creator_actor_key` 回填。三个身份事实刻意分开：

- **记录**（Session 行）持有 owner —— 一个 actor，初始即创建者；
- **绑定**（workspace 授权行）持该租户每个 actor 在各 Workspace 上可做什么；
- **角色**是准入路径查询的词表 —— 对 Session 级校验，Session 的 owner 无需持有 OPERATOR 或 OWNER 级 workspace 角色即可对该 Session 行使 OWNER 权利，但须保留可读授权；没有任何可读行的 actor 不可见（`404`）—— 这正是今天先 can_read 再创建者的顺序，今天的创建者行为也被原样保留。

`managed_workspace_create_command` 保持其本职 —— 幂等命令记录，其 `actor_id` 属于幂等域而非授权。V53 之后对它的授权性读取（`requireOwner` / `requireWorkspaceCreator` 中 NULL 创建者回退）并不只覆盖 V40 之前创建的会话：每一次无 actor 的 legacy open-mode 创建今天仍向两列写入 NULL，因此回退在 legacy 臂上保持生效；移交切片必须决定 NULL owner 的含义，而不能假设它不会出现。

owner 的更新路径（移交命令）是建在此列之上的后续切片，跟进为 #13617；本切片给出移交所需的词表与存储，并把每个创建者校验改指 owner（第 7 节）。

### D4 —— 路由重分类

绑定 Session 面上每个已实现路由族的最低角色（已准入调用方行为保留：持 create 授权者映射为 OPERATOR，创建者映射为 owner）：

| 族                                                                    | 今天                                             | 之后                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Session/Turn/Item/task/Action/event 读、JSON+SSE、catalog、transcript | `can_read`（无则 404）                           | READER（无则 404）—— 不变                                            |
| 绑定 Session 创建                                                     | actor + `can_create` + ACTIVE（401/404/403/409） | actor + OPERATOR + ACTIVE —— 调用方不变                              |
| Turn 提交 / 取消 / 改名                                               | 创建者 + 当前 `can_create`，拒绝返回 409         | OPERATOR；拒绝改为 403 `session_operation_forbidden`                 |
| cwd 变更                                                              | 创建者，404/403                                  | OPERATOR，404/403                                                    |
| Action 回答                                                           | 创建者，403 `action_forbidden`                   | OPERATOR，403 `action_forbidden` —— **第二个 operator 现在能回答了** |
| close / archive / unarchive / delete                                  | 创建者，404/403                                  | Session owner，404/403 —— 调用方不变                                 |
| Artifacts（元数据）                                                   | actor + `can_read`                               | actor + READER —— 不变                                               |
| Artifact 内容字节                                                     | actor + 读 + 部署策略                            | actor + READER + 策略 —— 不变                                        |
| Workspace 发现 list/get                                               | actor，按 `can_read` 过滤                        | actor，按角色 ≥ READER 过滤 —— 不变                                  |
| Legacy（未绑定）Session 路由                                          | 租户级                                           | 租户级 —— 不变（第 6 节）                                            |
| Agent 定义                                                            | 租户级                                           | 租户级 —— 不变                                                       |
| 内部 store / tool-publication 路由                                    | writer HMAC，无 actor                            | 不变                                                                 |

所有重读授权的在线行为（SSE 读授权复查、artifact 流中重验、执行期 `authorizePassiveAttachment`）按 `role` 以相同阈值查询，撤销因此保持今天的含义。

在绑定臂上，新工作 —— Turn 提交、改名与 cwd 变更 —— 还要额外担保 Session 的「创建者键」执行事实成立 —— Registry 仍精确支撑该绑定并处于 ACTIVE，且 Workspace 创建命令记录的 actor 保持 OPERATOR 及以上，因为被准入的工作以该 actor 的授权执行（执行授权复查的是同一条 join）。Turn 取消只凭 OPERATOR 角色与可执行形态准入，因为它的投递复用已准入的 attachment、不复查任何授权。每个绑定 Action 回答同样在准入时担保同一组创建者键事实，无论由哪条臂 —— 记录的 owner 还是 Workspace operator —— 准入。这些事实失效时按族给出域名级 `409 workspace_unavailable`，在准入时同步拒绝，而不是让一个注定失败的 Turn 异步落空。cwd 操作的结算同时复查记录的创建者键事实与 V55 持久化的发起者角色 —— 准入之后降级任何一个 actor 都以 `workspace_unavailable` 失败（V55 前的存量行没有发起者键，仍只按创建者键事实结算）；这正是 W2 设计「准入后撤销授权仍阻止变更」在放宽后的准入下应有的形态。

### D5 —— 版本化 surface 注册表

服务器模块中的一个枚举 —— `api/SurfaceRegistry.java`，每条已实现路由一个常量 —— 字段为：HTTP 方法、路径模板、面（PUBLIC / WEBSHELL / INTERNAL）、能力 id（一个能力的公开/WebShell 孪生共享，例如 `TURN_SUBMIT`）、规则类（`legacy_create`、`legacy_tenant`、`workspace_create`、`reader`、`reader_actor`、`reader_actor_policy`、`operator`、`owner`、`workspace_discovery`、`tenant_scoped`、`internal_writer`）。这一个文件就是 issue R2 要求的枚举：逐路由声明哪类 actor 可读、改、取消、回答或删除。它的版本化方式与 surface 本身一致 —— 注册表变更随其实现的契约版本走（R1 翻转是 v1.34），因此对注册表 `git blame` 就是逐路由的权威历史。

### D6 —— 构建门禁

两个测试类让枚举具有约束力：

1. **对账门禁。** 一个 Spring 测试解析本模块应用里全部 `RequestMappingHandlerMapping`（含按条件注册的内部 controller），并断言它与注册表构成双射：已实现而无注册条目的 handler 让构建失败 —— 新增路由无法静默跳过校验；为已删路由留的腐旧条目同样失败。
2. **验收探针。** 一个参数化测试遍历注册表，按规则类发出标准探针集 —— 错误租户、无 actor、角色恰低一级、恰好足够、跨租户 principal —— 按声明规则断言路由状态码（低于读者 404，低于操作者 403，准入族各自的 2xx 形态）。探针在两个面上共用同一幅 fixture 图（workspace 行、绑定与 legacy 会话、一个待答 Action、一个 artifact、task 记录），复用现有 fixture 模式。

跨面奇偶是结构性的而非愿望性的：共享能力 id 的注册条目必须共享规则类，且探针运行覆盖每个孪生，因此公开路由与其 WebShell 孪生不可能各自漂移。

### D7 —— WebShell 能力广告跟随角色

会话视图里的 `workspaceTurns` 标志镜像 submitter 族的服务端准入本身：按调用方的 OPERATOR 及以上角色与该 Session 的创建者键执行事实计算，不再按创建者身份，composer 的暴露因此与服务端 submit 的答复保持一致。生命周期能力标志在本切片保持按 Session 计算、不看调用方 —— 它只描述该 Session 是否支持 close/archive/delete，不回答当前调用方能不能驱动它们；生命周期标志的 owner 维度广告与移交（#13617）一起延后。D6 的奇偶断言覆盖规则本身，现有 WebShell 覆盖检查广告。

## 4. 交付计划

三个切片：两条并行 lane，然后一条收尾 lane。lane 按文件范围不相交切分，而不是按话题：

| 切片                              | 内容                                                                                                                                                                          | 改动范围                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **A —— 注册表 + 门禁（先行 R2）** | 按今天规则建 `SurfaceRegistry`、对账门禁、验收探针、奇偶断言、本文档的双语路由矩阵                                                                                            | 全部为新文件：`api/SurfaceRegistry.java`、两个测试类；不改生产代码              |
| **B —— 角色存储（R1 存储）**      | V53 迁移与回填、`WorkspaceAccess` 改名、注册表 store 读取改由 `role` 推导、`owner_actor_key` 列与创建时写入、fixture INSERT 更新（约 24 处）、迁移形态测试                    | `store/**`、runtime-broker 枚举、`db/migration`、测试 fixture；不改任何准入判定 |
| **C —— 强制执行（R1）**           | 三个创建者辅助方法改指角色/owner、拒绝码归一、Action 回答向 OPERATOR 开放、按角色的 WebShell 能力广告、注册表规则翻转、探针期望翻转、契约 v1.34 与 OpenAPI 文本、契约测试更新 | `service/**`、`store/**` 校验点、controller、契约、A 的枚举与测试               |

A ∥ B 是安全的：文件不相交（A 纯新增；B 改 store 侧）。C 必须在两者合入后串行，因为它同时改写 A 的注册表条目与 B 的辅助方法 —— 这是唯一真实的阻塞依赖，所以被排序而不是被抢跑。C 推进 #13535（移交命令与 legacy 收紧分别跟进为 #13617 与 #13618）；A 与 B 引用它。

## 5. 迁移与兼容

- V53 沿用既有单版本纪律（迁移前停掉旧版本服务器；不用 `outOfOrder`）。
- 契约 v1.34 记录：角色词表、submitter 族与 Action 族的 OPERATOR 准入、基于 owner 的生命周期、submitter 族拒绝语义 409 `workspace_unavailable` → 403 `session_operation_forbidden` 的变化、以及按角色的能力广告。
- 客户端可观察的变化：可读但低于 OPERATOR 的 submitter（提交、取消、改名）在同一请求上的拒绝从 409 `workspace_unavailable` 归一为 403 `session_operation_forbidden`，而已过角色检查的 OPERATOR 在形态或创建者键事实失效处仍遇该族的域名级 409；Action 回答对非创建者的 OPERATOR 由拒绝变为成功；Turn 提交、改名与 cwd 变更在 Session 的创建者键执行事实成立期间对非创建者的 OPERATOR 开放，取消则只凭角色与形态对他们开放。其余对调用方保持不变。
- 写 `can_read`/`can_create` 的测试 fixture 在切片 B 改写 `role`；曾考虑生成列方案，为保持单一事实源与 H2/MySQL 简单对齐而放弃。

## 6. 范围边界

与 issue 一致，外加其中点名的显式延后：

- Legacy（未绑定）Session 本切片保持租户级。收紧它们（自 V40 起它们也记录创建者）跟进为 #13618；把 R1 扩到 legacy 会让本切片的爆炸半径翻倍，却修不好任何一个被点名的产品阻塞。
- 没有移交命令：`owner_actor_key` 与其触发的角色校验在此落地；移交操作（幂等命令、仅 owner 准入、审计事件）是独立切片，跟进为 #13617。注意 owner 列驱动的是哪些族：生命周期与 Action 回答以它为键，submit、cancel、rename、cwd 变更与执行本身仍以创建命令 actor 为键（执行授权的 join 点名的是创建命令 actor），因此移交切片还必须决定传输是重指创建命令、还是重键执行授权 —— 或接受新 owner 邻着一个不可用 Session 的状态。
- submitter 族命令幂等键不含 actor 项：操作台账自 D4 起按 actor 限定键，但 `managed_agent_command` 本切片保持 `(tenant_id, operation, idempotency_key)` 域 —— 按 actor 限定它（同时不破坏并发插入所依赖的唯一索引去重形态）跟进为 #13619。
- 没有 HTTP 授权管理路由（`actor_manager` 置备）：workspace 授权今天经带外置备到达，本切片用 `role` 列扩展同一通道。若部署方需要 HTTP 管理的授权，那是独立的控制面切片，并自带过期语义 —— 授权行随 workspace 绑定生死，从不随某个 Session。
- 不改变 `AuthenticatedTenantActor` 的供给方式，不给 SIGNED 模式加声明，不动 `java_durable` 准入，不含容量上限，不含 F 阶段故障门禁。

## 7. 验证计划

- 切片 A：对账门禁的证伪臂由提交的 `SurfaceRegistryGateNegativeTest` 永久钉住（一条已挂载但未注册的路由，以及一条已注册但无 handler 的路由）；方法无关映射的臂由 `SurfaceRegistryGateUnconstrainedTest` 补齐；探针按规则类在公开 + WebShell 两面钉住今天的状态码。
- 切片 B：迁移形态测试在既有 fixture 之上应用 V53，断言回填（can_create → OPERATOR，仅 can_read → READER，owner := creator）与硬化后的 CHECK（带填充的角色值被拒绝）。现有测试期望只在指名被改名的 `WorkspaceAccess` 常量处变化；行为不可见的证明是 `WorkspaceAccessTest` 钉住的 `canRead()`/`canCreate()` 真值表保全，而不是文件原样未动。
- 切片 C：更新后的探针与契约测试钉住新矩阵；定向测试：第二个 OPERATOR 在两个面上回答待答审批，OPERATOR 提交/取消/改名/改 cwd，owner 生命周期不变，可读陌生人保持 404，角色撤销按原窗口翻转 SSE 准入；MySQL 奇偶走 failsafe profile（`mysql-integration`、`hosted-harness-mysql`，视 fixture 允许）。
- 跨面奇偶断言两次：结构性（注册表 能力→规则类）与行为性（孪生探针）。

## 8. 验收标准

- [ ] 每条已实现的公开、WebShell 与内部路由都出现在 `SurfaceRegistry` 中；已实现路由缺注册条目 —— 或为已删路由留的腐旧条目 —— 使构建失败（R2）。
- [ ] 逐规则类探针矩阵在两个面上通过，含 404-低于读者 / 403-低于操作者的契约（R2，#12867 语义）。
- [ ] Workspace 上的第二个 OPERATOR 能在公开路由与 WebShell 路由上回答一条待答审批（R1 被阻塞行为之一）。
- [ ] `owner_actor_key` 存在，新绑定与 legacy 创建都默认写入创建者，并驱动原先每个创建者校验（移交词表就绪；命令本身为后续）：本 PR 后生命周期与回答以它为键，submit/cancel/rename/cwd 与执行仍以创建命令 actor 为键，移交重键形态由 #13617 决定（R1 被阻塞行为之二的存储半）。
- [ ] 契约 v1.34 记录角色、拒绝归一与能力广告规则；OpenAPI changelog 点名它们。
- [ ] managed-agent-server 全套测试在 H2 上绿；runner 提供 MySQL 时 `mysql-integration` profile 绿。

## 9. 评审待定项

1. 生命周期保持仅 Session owner；workspace 上的 OWNER 授权是否也应对该 workspace 下每个 Session 准入生命周期（管理模型）？本设计保持今天的调用方集合；将来翻转只是每个辅助方法一行加探针期望。
2. Legacy Session 收紧 —— 与移交命令一起排期，还是等产品诉求？
3. 若部署方要求 HTTP 授权管理，`actor_manager` 是否随三份拷贝（会话记录、授权行、命令行）一起过期，还是第四份租户级记录？在置备出范围的约束下刻意留开。

## 10. Surface 路由矩阵（切片 A 注册表，双语摘要）

与 L3 整合后的 `api/SurfaceRegistry.java` 携带 80 条路由常量：十个
controller 的 32 公开 + 24 WebShell + 24 internal handler 方法（含
L3 两条授权入口）。（第 2 节上一版正文里的 21 internal 已过时：
#13088 新增 `receipts/verify`，L3 又加两条授权入口；门禁从扫描推导
一切，计数只是信息，不是被断言的常量。）

规则类按已实现的准入命名。切片 C 之后（契约 v1.34）：`WORKSPACE_CREATE`（2）、
`READER`（24）、`READER_ACTOR`（6）、`READER_ACTOR_POLICY`（1）、`OPERATOR`
—— submitter 族加 cwd 变更与 Action respond（8）、`OWNER`
—— 仅 lifecycle 族（8）、`WORKSPACE_DISCOVERY`（4）、`TENANT_SCOPED`
（3）、`INTERNAL_WRITER`（22）。设计列出的 `legacy_create` 与
`legacy_tenant` 两个名字保留在类的文档里，作为 legacy 分支的名字：
每条路由恰有一个规则类，按分离规则取的是绑定 Session 的类。下表的规则类列是
切片 C 之后的矩阵；被它替换的切片前取值保存在 D4 表的「今天」列。

| 路由                                                                                                                             | 面       | 能力                      | 规则类（切片 C 后） |
| -------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- | ------------------- |
| `POST /v1/agents/sessions`                                                                                                       | PUBLIC   | SESSION_CREATE            | WORKSPACE_CREATE    |
| `GET /v1/agents/sessions`                                                                                                        | PUBLIC   | SESSION_LIST              | READER              |
| `GET /v1/agents/sessions/{sessionId}`                                                                                            | PUBLIC   | SESSION_GET               | READER              |
| `PATCH /v1/agents/sessions/{sessionId}`                                                                                          | PUBLIC   | SESSION_RENAME            | OPERATOR            |
| `POST /v1/agents/sessions/{sessionId}/close`                                                                                     | PUBLIC   | SESSION_CLOSE             | OWNER               |
| `POST /v1/agents/sessions/{sessionId}/archive`                                                                                   | PUBLIC   | SESSION_ARCHIVE           | OWNER               |
| `POST /v1/agents/sessions/{sessionId}/unarchive`                                                                                 | PUBLIC   | SESSION_UNARCHIVE         | OWNER               |
| `DELETE /v1/agents/sessions/{sessionId}`                                                                                         | PUBLIC   | SESSION_DELETE            | OWNER               |
| `GET /v1/agents/sessions/{sessionId}/operations/{operationId}`                                                                   | PUBLIC   | SESSION_OPERATION_GET     | READER              |
| `POST /v1/agents/sessions/{sessionId}/cwd`                                                                                       | PUBLIC   | SESSION_CWD_CHANGE        | OPERATOR            |
| `POST /v1/agents/sessions/{sessionId}/events`                                                                                    | PUBLIC   | TURN_SUBMIT, TURN_CANCEL  | OPERATOR            |
| `GET /v1/agents/sessions/{sessionId}/events`                                                                                     | PUBLIC   | TAIL_EVENTS               | READER              |
| `GET /v1/agents/sessions/{sessionId}/items`                                                                                      | PUBLIC   | ITEM_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/turns`                                                                                      | PUBLIC   | TURN_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/turns/{turnId}`                                                                             | PUBLIC   | TURN_GET                  | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks`                                                                                      | PUBLIC   | TASK_LIST                 | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks/{taskId}`                                                                             | PUBLIC   | TASK_GET                  | READER              |
| `GET /v1/agents/sessions/{sessionId}/tasks/{taskId}/events`                                                                      | PUBLIC   | TASK_EVENT_LIST           | READER              |
| `GET /v1/agents/sessions/{sessionId}/actions`                                                                                    | PUBLIC   | ACTION_LIST               | READER              |
| `GET /v1/agents/sessions/{sessionId}/actions/{actionId}`                                                                         | PUBLIC   | ACTION_GET                | READER              |
| `POST /v1/agents/sessions/{sessionId}/actions/{actionId}/responses`                                                              | PUBLIC   | ACTION_RESPOND            | OPERATOR            |
| `GET /v1/agents/sessions/{sessionId}/items/{itemId}/tool-result`                                                                 | PUBLIC   | TOOL_RESULT_GET           | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts`                                                                                  | PUBLIC   | ARTIFACT_LIST             | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}`                                                                     | PUBLIC   | ARTIFACT_GET              | READER_ACTOR        |
| `GET /v1/agents/sessions/{sessionId}/artifacts/{artifactId}/content`                                                             | PUBLIC   | ARTIFACT_CONTENT          | READER_ACTOR_POLICY |
| `GET /v1/agents/sessions/{sessionId}/hook-catalog`                                                                               | PUBLIC   | HOOK_CATALOG              | READER              |
| `GET /v1/agents/sessions/{sessionId}/mcp-catalog`                                                                                | PUBLIC   | MCP_CATALOG               | READER              |
| `GET /v1/agents/workspaces`                                                                                                      | PUBLIC   | WORKSPACE_LIST            | WORKSPACE_DISCOVERY |
| `GET /v1/agents/workspaces/{workspaceId}`                                                                                        | PUBLIC   | WORKSPACE_GET             | WORKSPACE_DISCOVERY |
| `POST /v1/agents`                                                                                                                | PUBLIC   | AGENT_DEFINITION_CREATE   | TENANT_SCOPED       |
| `GET /v1/agents/{agentId}`                                                                                                       | PUBLIC   | AGENT_DEFINITION_GET      | TENANT_SCOPED       |
| `POST /v1/agents/{agentId}`                                                                                                      | PUBLIC   | AGENT_DEFINITION_UPDATE   | TENANT_SCOPED       |
| `POST /api/agent/web-shell/v1/tasks/query`                                                                                       | WEBSHELL | TASK_LIST                 | READER              |
| `POST /api/agent/web-shell/v1/tasks/get`                                                                                         | WEBSHELL | TASK_GET                  | READER              |
| `POST /api/agent/web-shell/v1/tasks/events/query`                                                                                | WEBSHELL | TASK_EVENT_LIST           | READER              |
| `POST /api/agent/web-shell/v1/sessions/query`                                                                                    | WEBSHELL | SESSION_LIST              | READER              |
| `POST /api/agent/web-shell/v1/sessions/get`                                                                                      | WEBSHELL | SESSION_GET               | READER              |
| `POST /api/agent/web-shell/v1/transcript/query`                                                                                  | WEBSHELL | TRANSCRIPT_QUERY          | READER              |
| `POST /api/agent/web-shell/v1/events/stream`                                                                                     | WEBSHELL | TAIL_EVENTS               | READER              |
| `POST /api/agent/web-shell/v1/sessions/create`                                                                                   | WEBSHELL | SESSION_CREATE            | WORKSPACE_CREATE    |
| `POST /api/agent/web-shell/v1/turns/submit`                                                                                      | WEBSHELL | TURN_SUBMIT               | OPERATOR            |
| `POST /api/agent/web-shell/v1/turns/cancel`                                                                                      | WEBSHELL | TURN_CANCEL               | OPERATOR            |
| `POST /api/agent/web-shell/v1/sessions/close`                                                                                    | WEBSHELL | SESSION_CLOSE             | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/archive`                                                                                  | WEBSHELL | SESSION_ARCHIVE           | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/delete`                                                                                   | WEBSHELL | SESSION_DELETE            | OWNER               |
| `POST /api/agent/web-shell/v1/sessions/unarchive`                                                                                | WEBSHELL | SESSION_UNARCHIVE         | OWNER               |
| `POST /api/agent/web-shell/v1/operations/query`                                                                                  | WEBSHELL | SESSION_OPERATION_GET     | READER              |
| `POST /api/agent/web-shell/v1/sessions/cwd/change`                                                                               | WEBSHELL | SESSION_CWD_CHANGE        | OPERATOR            |
| `POST /api/agent/web-shell/v1/actions/query`                                                                                     | WEBSHELL | ACTION_LIST               | READER              |
| `POST /api/agent/web-shell/v1/actions/get`                                                                                       | WEBSHELL | ACTION_GET                | READER              |
| `POST /api/agent/web-shell/v1/actions/respond`                                                                                   | WEBSHELL | ACTION_RESPOND            | OPERATOR            |
| `POST /api/agent/web-shell/v1/tool-results/get`                                                                                  | WEBSHELL | TOOL_RESULT_GET           | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/get`                                                                                     | WEBSHELL | ARTIFACT_GET              | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/artifacts/query`                                                                                   | WEBSHELL | ARTIFACT_LIST             | READER_ACTOR        |
| `POST /api/agent/web-shell/v1/workspaces/query`                                                                                  | WEBSHELL | WORKSPACE_LIST            | WORKSPACE_DISCOVERY |
| `POST /api/agent/web-shell/v1/workspaces/get`                                                                                    | WEBSHELL | WORKSPACE_GET             | WORKSPACE_DISCOVERY |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:acquire`                                                   | INTERNAL | STORE_WRITER_ACQUIRE      | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:renew`                                                     | INTERNAL | STORE_WRITER_RENEW        | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/writers:seal`                                                      | INTERNAL | STORE_WRITER_SEAL         | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/recovery:block`                                                    | INTERNAL | STORE_RECOVERY_BLOCK      | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/transactions:commit`                                               | INTERNAL | STORE_TRANSACTION_COMMIT  | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/restore`                                                            | INTERNAL | STORE_RESTORE             | INTERNAL_WRITER     |
| `POST /internal/managed-session-store/v1/sessions/{sessionId}/tool-results:publish`                                              | INTERNAL | STORE_TOOL_RESULT_PUBLISH | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions`                                                       | INTERNAL | STORE_TRANSACTION_LIST    | INTERNAL_WRITER     |
| `GET /internal/managed-session-store/v1/sessions/{sessionId}/resources/{resourceId}`                                             | INTERNAL | STORE_RESOURCE_GET        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/grants`                                                        | INTERNAL | PUB_GRANT                 | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/segments/{streamId}/{ordinal}`    | INTERNAL | PUB_SEGMENT               | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/resources/{kind}/{slot}`          | INTERNAL | PUB_RESOURCE              | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/streams/{streamId}/seal`          | INTERNAL | PUB_STREAM_SEAL           | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/streams/{streamId}/prefix`        | INTERNAL | PUB_STREAM_PREFIX         | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/finish`                           | INTERNAL | PUB_FINISH                | INTERNAL_WRITER     |
| `GET /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/operations/{operationId}`          | INTERNAL | PUB_OPERATION_GET         | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/operations/{operationId}/recover` | INTERNAL | PUB_OPERATION_RECOVER     | INTERNAL_WRITER     |
| `GET /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/finished`                          | INTERNAL | PUB_FINISHED              | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/admissions/prepare`               | INTERNAL | PUB_ADMISSION_PREPARE     | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/receipts/verify`                                               | INTERNAL | PUB_RECEIPT_VERIFY        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/receipts/commit`                  | INTERNAL | PUB_RECEIPT_COMMIT        | INTERNAL_WRITER     |
| `POST /internal/managed-tool-publications/v1/sessions/{sessionId}/publications/{publicationId}/range`                            | INTERNAL | PUB_RANGE                 | INTERNAL_WRITER     |
