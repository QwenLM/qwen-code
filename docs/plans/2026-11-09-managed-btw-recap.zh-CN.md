# Managed BTW 与 recap 实施计划

[English](2026-11-09-managed-btw-recap.md) | [简体中文](2026-11-09-managed-btw-recap.zh-CN.md)

状态：五个增量均已完成本地实现，相关验证通过，集成验收待完成。日期：2026-11-09。审查基线：`56ea1bc3fbb794bd42e62c532c7962164e7f3786`；本地实现基线：`d32faa247dfed4e0612d6a52cdf3f467ca38e934`。[设计文档](../design/2026-11-09-managed-btw-recap.zh-CN.md)规定行为与协议契约。用户已选择首版仅支持显式 Session `model_config`。

## 1. 交付顺序与完成标准

按五个增量交付：持久接纳与冻结读取 → 隔离 Harness 执行 → 公共接口/provider 接通 → BTW UI → recap UI 与集成验收。完整链路可用前保持生成关闭。增量是便于审查的实现边界，不代表创建或合并 PR 的授权。

保留原产品决策：私有持久 BTW 使用最近 20 组成功问答；recap 支持手动及可选自动；自动默认关闭、离开五分钟、首次三个完成用户回合、此后新增两个；支持 ACTIVE 冷会话。排除模型目录/默认模型 Session 和消息删除。没有待定产品决策。

每个增量必须包含真实消费者及相关验证。DTO、mock 测试、H2 通过或 UI 可用，都不能单独证明持久执行。无法获得的集成证据标记为待验证，不勾选验收完成。

## 2. 存储与执行增量

### 增量 1 — 持久接纳与冻结读取

- 新增 `ma_side_query`、`SIDE_QUERY` receipt namespace/resource ownership、范围索引及活跃槽位。复用 request receipt 实现同键重放、冲突检测、缓存结果映射和持久自动版本去重，遵守现有锁顺序并用 SQL 保证竞态安全。
- 增加小型对话投影，从验证后的 native journal 派生完成真实用户回合数和内容边界/版本。独立的主输入边界在主输入接纳时事务化推进，包含队列输入，幂等重放不推进。旧数据补齐不获取 writer，证据不可用时明确返回不可用。
- 增加 query 授权的前缀/resource 读取及输入发布。复用 120 秒不续租保留租约、固定来源 digest 和资源分块编码。只抽取与现有恢复共用的纯模型投影，不另写一套历史实现，不创建 live authority。
- 建立成功完整回合集合，验证压缩覆盖范围；证明不足时回退原始成功记录。BTW 私有历史也固定。读取冻结前缀和发布输入时允许主 journal 继续追加。
- 暂存块上传时绑定 query/claim，仅在 preparing 且资格仍有效时原子发布完整输入闭包与 `inputReady`。实现终态/暂存清理、side-query input kind 回收、生命周期 fencing 和永久退役清理。同时更新共享 V1、schema 清单/枚举、锁清单、collector 白名单及 schema 测试。

完成证据：同键和多标签竞态只有一个接纳身份；私有读取不能越出 actor/Session/cutoff；被压缩的失败/当前输入不会进入上下文；主任务追加期间分块输入仍可完成；终态后活跃 Session 的输入 bytes 确实被回收。SQL/GC 竞态必须有 MySQL 证据，不能只有 H2。

### 增量 2 — 隔离 Harness 执行

- 私有 Hosted 协议和 Java SDK 增加 `side-query/1`、实例级 submit/status/cancel，以及 claim 绑定的模型/输入访问。pool 新增选择入口，禁止分配 Session placement 或调用 Runtime Broker。
- 从不可变显式配置构建专用模型执行器。复用 provider adapter/parser，不复用宿主设置、Session 初始化、Hook runner 或主 Turn 状态。用相同 model ID、不同配置的两个并发 Session 验证 endpoint/key 路由正确。
- 完整载入并验证最终有界请求与附件，再以 `inputReady`/claim 条件 CAS 为 `running`，与取消串行化，之后不再读取资源。单次尝试、关闭 provider/应用重试及模型 fallback，总期限五分钟，每个 Harness 四个执行槽位，recap 上限 300 output tokens。保留正常/部分/失败的完成原因和安全 usage；只有完整可见回答可进入 BTW 历史或 recap 缓存。
- 实现独立 abort、带 fence 的快照发布和孤儿 reconciliation。owner 丢失或不确定时转 interrupted，不自动重新分发。实际 provider promise 结束前保留执行计数；pool 保留成员时考虑 claim，drain 考虑异步工作。

完成证据：真实 Java→SDK→Hosted 进程链可从冷 Session 执行，且 writer generation、placement、Runtime 数量和主模型指标不变。在分发/CAS/输出边界断连或终止进程；重复内部提交、迟到结果、忽略 abort 的 provider、202 后 drain 都不能重复执行或复活终态。

## 3. API 与产品增量

### 增量 3 — 公共接口与 provider 接通

- 实现设计规定的 Public REST 和 WebShell POST，包括 actor 范围的 context、list/get、create/cancel 及私有 SSE。增加可选 `provider.sideQueries`，接通具体 Java client/provider、Session capability 和能力对齐 fixture。
- 同步更新 OpenAPI、route mapping、`SurfaceRegistry`、契约测试和生成的 WebShell 类型。通过仓库脚本生成类型，不手改生成文件。Public 使用 snake_case，WebShell/provider 使用 camelCase。
- 事务化实现回执、自动去重及手动缓存/订阅。重放前以及每次读取/推送前重新校验可见性。覆盖过期内容版本、actor 改变、权限撤销及同键不同请求。
- 完整文本快照最多每秒持久一次，终态立即提交。每条 SSE 立即读取当前 SQL 状态并每秒检查新 revision，避免 GET 与订阅之间的完成丢失；客户端拒绝过期 revision。私有问题、答案、错误正文和 token 事件均不发送到共享 Session 事件流。

完成证据：契约门禁通过；真实 provider 调用覆盖每个已声明方法；其他 actor/tenant 无法列出、读取、订阅或取消 query；重连与重复提交始终对应同一持久逻辑 query。

### 增量 4 — BTW 侧栏与连续追问

- 在主提交 busy/队列处理前识别 `/btw`，并提供独立侧栏按钮。无参 `/btw` 重开保存的历史。复用已有 WebShell UI primitives 及 portal/ref 规范。
- 展示当前用户私有的持久历史、来源完成边界、流式文本、独立停止和显式重试。只有正常完成回答进入最近 20 组输入，失败、截断和中断保持可区分状态。
- 提交前在 product + 不透明 actor scope + Session 范围保存原始创建参数与幂等键；响应不确定时，即便 query ID 未知也重放相同参数/键，确认接纳后清除请求正文。不持久保存凭据或回答正文。身份变化清空内存和订阅，收起侧栏或断开 SSE 不取消执行。

完成证据：使用仅存在于前次 BTW 回答中的事实进行追问，刷新及第二设备上仍可继续，且仅原 actor 可访问。主生成、工具调用及等待审批期间均可运行；停止、导航和重连不改变主任务。

### 增量 5 — 手动/自动 recap 与验收

- 抽取/共享纯 transcript 过滤、recap 提示构造和结果提取逻辑。不调用 live recap service，不继承 fast-model/宿主语言默认值，不把失败吞成空的成功结果。修改前核对 #12430/#8783/#16636 当前公共修复，避免重复实现。
- 将 `/recap` 和手动按钮接到持久 query。覆盖无足够上下文时不调用模型、订阅等价运行请求、按版本/模型/处理规则复用成功缓存，以及失败后的显式重试。
- 增加默认关闭、actor 隔离的设置及合格离开窗口状态。返回后等待主任务/队列空闲，刷新 context，同时携带 expected content version 和 expected main-input boundary。服务端接纳时原子核对两者，并强制首次三回合/新增两回合门槛及每版本自动最多尝试一次。
- 展示绑定 actor、Session、开关 epoch、捕获的主输入边界及来源版本。自动展示前立即刷新 context，要求边界匹配且主任务/队列空闲，覆盖其他标签页新输入失败而完成内容没变的情形。相关状态改变后丢弃结果；开关开启前已开始的离开不补算。后台标签页不显示，自动错误静默。

完成证据：假时钟/UI 测试验证五分钟时序、忙转空闲延迟、首次/后续回合门槛、手动成功基准、多标签去重、开关切换、输入竞态、语言及 Hook/记忆过滤。开启接纳前完成下述集成矩阵。

## 4. 验证矩阵与工作流

实施前建立 `.qwen/e2e-tests/managed-btw-recap.md`，包含命令、fixture 和证据路径。通过仓库 `test-engineer` 工作流，用全局 `qwen` CLI 及适用的 Java/API fixture 观察基线。如实记录缺失能力，daemon 单独的基线不能证明 Managed 行为。

必测场景：

1. **模型与身份隔离：** 显式配置 Session 可用；模型目录/默认配置及无效配置拒绝生成；两个 tenant/actor/config 组合之间不混入回答、凭据、浏览器状态或模型路由。权限撤销阻断推送与结果提交。
2. **并发与冷上下文：** 主生成/工具/审批继续执行；writer/placement/Runtime 不变；包含早先失败或当前回合的压缩安全回退；资源损坏/缺失明确失败，不能静默缩短历史；大输入遵守分块与模型预算。
3. **持久性：** 创建响应丢失且 query ID 未知后刷新、第二设备、SSE 缺口（含 GET 与订阅之间完成）、重复键、冲突键、并发自动/手动 recap 和进程重启后回执及结果仍正确。部分、过滤或仅工具调用输出不进入成功历史/缓存。
4. **故障与回收：** 在准备/发布快照、running CAS 前后、流式生成、取消和关闭期间注入故障。验证旧 owner fencing、不自动重放模型、drain 计数、孤儿清理、活跃 Session 字节回收，以及永久删除 query/receipt/owner。
5. **Recap 策略：** 默认关闭、离开五分钟、三个真实用户回合后新增两个；不计后台/工具/BTW 回合；延迟到空闲；来源/actor/开关/输入变化丢弃结果；每内容版本自动一次；手动重试和缓存语义正确。

从各 package 目录运行相关测试，运行根目录 build/typecheck，进程 E2E 需要 bundle，并对改动源码执行 lint/format 检查。运行 `ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`、schema/lock/retirement 门禁和受影响 Java 消费者测试。Java 使用 JDK 21、与源码匹配的已安装 SDK、独立 Maven repository，所有 agent 的准备/build/retry 共用模块十分钟本地预算。完整 verify/SpotBugs、MySQL 和 Hosted/fault profile 交 CI。H2 与确定性模型 fixture 不得描述为生产/provider 验收；真实 provider 冒烟可用时单独记录。

实现后完整 diff 自审至连续两轮干净，再按仓库要求做代码审查。修复仅使受影响证据失效，但重新计算干净轮次。记录命令、准确测试源码、选中用例、退出状态和剩余 CI/部署缺口。

## 5. 启用与完成清单

- [x] 五个增量都有真实消费者，选中的本地证据记录在下方。
- [ ] 完成集成验收矩阵；选中的测试未覆盖全部必要场景。
- [ ] MySQL、Hosted/fault 门禁覆盖待接受版本；缺失的必要检查明确保持待验证。
- [x] Server/Broker schema reader、新枚举/退役、SDK 与 Harness 对齐 V1 和 `side-query/1`；开发库重建，不静默 repair。
- [ ] 匹配的后端/Harness 先于 WebShell 入口部署；跨层验收后才开启单一接纳开关。旧版本或不支持的组合不提供生成。
- [ ] 关闭接纳仍允许授权结果读取；已接纳工作可完成/取消；回滚不绕过持久 query fence 或 schema 兼容要求。
- [x] 中英文设计与计划保持同步；文档检查和功能验证分别记录。

## 6. 本地实现与验证记录

实现包含持久 query 接纳、对话/输入边界、actor 私有历史与 receipt、claim 绑定的冻结读取、暂存输入所有权/回收、生命周期 fence 和退役清理。实例级 SDK/Hosted 执行器使用显式模型配置，不挂载 Session，也不调用 Broker。Public/WebShell 路由、生成类型及 Java provider 已接通私有面板、命令拦截和可选自动 recap。

针对当前工作区，以下选定检查已通过：

- 根目录 `npm run build`、`npm run typecheck` 和 `npm run bundle`；最终 Hosted 路由改动还通过 CLI build 和真实进程 fixture。单独 CLI build 曾超出 Node 默认 4 GiB 堆，使用 `NODE_OPTIONS=--max-old-space-size=8192` 后同一构建通过。
- Core 输入/provider/投影/recap、CLI side-query/契约和 WebShell hook/provider/页面相关测试。覆盖模型完成分类、有界成功历史输入、自动 recap 竞态与命令路由，但不代表浏览器验收。
- Maven `test checkstyle:check` 选中 side-query store/service、主输入、API 契约、接纳、schema/time 及锁/registry 测试。真实 MySQL 8.4.11 运行了 `ManagedSideQueryStoreMySqlIT` 的 11 个选定用例，覆盖并发接纳、冻结 workspace/lease 边界、发布/GC 和取消。本地 macOS 配置使用 `lower_case_table_names=2`、128 MiB packet 上限并关闭 binary log。这些选定用例未执行永久退役清理。
- `HostedSideQueryProcessIT` 通过真实 Java SDK 和已打包 Hosted 进程执行。证据报告 `modelAttemptsPerQuery=1`、`failureRetries=0`、`attachedSessions=0`、`brokerCalls=0`，同名模型分别使用显式独立 endpoint，取消后保留部分文本。它使用空冻结 journal 和内存回调 fixture，因此尚未证明完整 SQL→Harness 执行链路。

证据位于 `/tmp/qwen-btw-adba/`（Java 预算账本及 Maven 记录）、`/tmp/qwen-btw-adba-build-verified.log`、`/tmp/qwen-btw-adba-typecheck-verified.log`、`/tmp/qwen-btw-adba-bundle-route-fixed.log`、`/tmp/qwen-btw-adba-core-input-final.log` 和 `/tmp/qwen-btw-adba-web-hook-final.log`。详细基线、失败与修复以及 E2E 范围记录在 `.qwen/e2e-tests/managed-btw-recap.md`。

完整 `mvn verify`/SpotBugs、完整 MySQL/Hosted/fault profile、完整持久 SQL→Harness 链路、浏览器刷新/第二设备和真实 provider 冒烟仍待验证。包含 side-query 记录的 CSI application image 暂不支持。缺少原始来源证据的继承分支历史及远程文件附件会拒绝执行。部署开关 `qwen.managed-agent.side-queries-enabled` / `QWEN_MANAGED_AGENT_SIDE_QUERIES_ENABLED` 默认 false。未进行生产部署或完成生产验收。

### PR 集成更新 — 2026-11-10

已 rebase 到 main `e104c7026e`，保留其中的 Runtime Skill 导入接口，并将合并后的 OpenAPI 更新至 1.107.0。除新增的两个 capability 字段外，全部上游路由和 schema 保持不变；WebShell 类型从合并后的契约重新生成。集成源码上的根目录 build/typecheck/bundle、19 项 CLI 测试、114 项 WebShell provider/hook 测试、491 项 Java API/接纳/service/registry 测试与 Checkstyle，以及真实 Java SDK→Hosted 进程 fixture 均通过。生成的 API/配置参考已重新核对。此前 Core、页面与 MySQL 证据仍适用于其覆盖的未变更源码。

集成日志为 `/tmp/qwen-btw-adba-build-pr.log`、`/tmp/qwen-btw-adba-typecheck-pr.log`、`/tmp/qwen-btw-adba-bundle-pr.log`、`/tmp/qwen-btw-adba-cli-pr.log`、`/tmp/qwen-btw-adba-web-pr.log`、`/tmp/qwen-btw-adba/java-contracts-pr.log` 和 `/tmp/qwen-btw-adba/java-hosted-process-pr.log`。共享 Java 准备/验证/清理账本累计约 431 秒，上限 600 秒。上方列出的验收缺口仍保持待完成。
