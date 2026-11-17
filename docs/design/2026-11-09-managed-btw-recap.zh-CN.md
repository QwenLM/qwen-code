# Managed BTW 与 recap：审查后的设计

[English](2026-11-09-managed-btw-recap.md) | [简体中文](2026-11-09-managed-btw-recap.zh-CN.md)

状态：已完成本地实现与相关验证，集成验收待完成。日期：2026-11-09。审查基线 main：`56ea1bc3fbb794bd42e62c532c7962164e7f3786`；实现从检出 `d32faa247dfed4e0612d6a52cdf3f467ca38e934` 开始，其相关源码与审查基线一致。[实施计划](../plans/2026-11-09-managed-btw-recap.zh-CN.md)记录交付、证据和剩余验收工作。

## 1. 审查决策与范围

为 Managed Session 提供持久化、当前用户私有的 BTW 连续追问，以及手动和可选自动 recap；支持 Runtime 已回收的 ACTIVE Session。本次不包含消息删除、分支、可执行工具的侧任务或通用任务框架。

用户已选择：**首版仅支持显式 Session `model_config`**。使用模型目录或默认模型的 Session 不声明 BTW/recap 生成能力。复用 Session 不可变的加密模型配置，不新增部署模型解析器、fast-model 设置、凭据编辑器，也不回退到 Harness 凭据。显式配置缺失或失效时拒绝执行。

本轮审查要求修正原方案中的以下缺口：

- 使用 query 专属的 Harness 选择入口；现有 pool selector 会分配或接管主 Session placement。
- 复用现有退役读取租约，但新增 query 范围的 journal/resource 读取授权；保留租约不等于读取权限。
- 抽取纯模型历史投影；展示用记录和 live Session authority 都不能直接替代冻结后的模型输入，压缩摘要也可能包含被排除的回合。
- 实现临时输入资源的实际回收；只删除引用不会及时清除活跃 Session 内的这些资源字节。
- 区分自动与手动 recap，定义稳定的对话内容版本，并按认证用户隔离浏览器状态。
- 持久保存 provider 完成原因，并让 Harness drain 统计异步 query 工作；非空文本和 HTTP 202 都不代表成功完成。

审查时仍开放的 PR #16408、#13914、#16472、#12430、#8783、#16636 仅作参考，不假定已合入。实施时再次检查实际变更；已存在的兼容公共修复可以复用，但不引入 daemon 生命周期或其进程内 BTW 状态。

## 2. 产品行为

### BTW

- `/btw <question>` 和独立侧栏入口提交私有查询；无参数 `/btw` 打开已有历史。问题上限 4096 字符，使用当前用户最近 20 组成功问答。
- 每次请求冻结主会话至最近成功完成回合的上下文，并固定选中的私有历史。进行中、失败和取消回合不作为新指令进入该输入。侧栏显示内容截至哪个已完成回合。
- 同一 tenant/Session/actor 只允许一个 BTW query 活跃。主任务生成、工具执行和等待审批不阻塞它。收起侧栏、切换视图或 SSE 断开不取消生成；停止按钮只取消旁路查询。
- 只有 provider 正常完成且存在可见文本的回答进入追问历史。截断、工具请求、过滤、错误和中断保留非成功原因及已有部分文本；这些记录可以查看，但不进入后续模型输入。
- 旁路查询不执行工具、Hooks、MCP、新的记忆检索/提炼、Workspace 读取或主会话记录写入。允许的既有对话内容仍作为上下文，但不新增宿主或个人记忆注入。

### Recap

- `/recap` 和回顾按钮返回跟随会话语言的 1–2 句总结，概括目标、进度和下一步。使用原始 transcript 中成功完成回合的最近 30 条可见对话，不使用压缩后的模型历史。结合来源标记和共享纯过滤函数，排除工具、思考、启动辅助内容、记忆注入和 Hook 附加内容。
- 手动 recap 可以与主任务并行。没有可总结对话时返回已完成的 `insufficient_context` 结果，不调用模型。同一 actor、输入身份、模型配置摘要及处理版本已有成功结果则复用，已有等价运行中请求则订阅。失败后的显式重试使用新的幂等键。
- 自动 recap 默认关闭，偏好按 product/tenant/actor 保存于浏览器。离开窗口至少五分钟，且离开开始时开关已开启。返回后等待主任务及其队列空闲，再刷新服务端上下文。
- 首次自动 recap 至少需要三个成功的真实用户回合；后续至少比最近一次成功 recap 新增两个，手动成功也计入基准。工具往返、后台输入、BTW 和排队未执行输入均不增加该计数。
- 每个 actor 和内容版本最多接纳一次自动尝试，失败也不自动重复。切换 Session/actor、关闭开关或接纳新的主输入，会使待展示的自动结果失效。后台标签页不展示结果。自动失败静默，手动失败提供重试。

### 可用性与归属

新生成要求 Session 为 ACTIVE、存在显式模型配置、存储/Harness 支持相应能力，并且调用者拥有现有主输入所要求的执行权限。复用授权检查，不复用主 Turn 的 busy、Runtime 或 placement 要求。仅有 Session 阅读权限不能消耗模型凭据。分发和提交结果前重新校验执行权限；每次读取、订阅和取消都重新校验当前 Session 可见性与 query 所属 actor。

Session 开始关闭、归档或删除时，fence 并取消未完成 query，拒绝新 query。仍有权限的用户可查看已关闭或归档 Session 中本人保留的结果。永久删除清理结果和回执。取消主 Turn 不取消 BTW/recap。

## 3. 持久状态与冻结输入

新增一张 `ma_side_query` 表，保存 kind、actor、trigger、原始 BTW 问题、来源边界、处理/模型摘要、输入引用、claim、截止时间、状态、结果 revision、回答文本、完成原因、usage 和清理状态。临时输入回收后仍保留问题与回答，保证刷新及后续追问可以使用成功问答。不放入 `ma_operation`，避免其执行互斥语义阻塞主 Session。

复用现有 request-receipt 机制，增加 `SIDE_QUERY` namespace，支持按 actor 和 Session 隔离的幂等，以及复用结果时的回执映射。同键同请求返回原 query，改变请求内容则冲突。自动内容版本去重必须原子持久化，自动请求订阅已有手动 query 时也要记录。这能保证客户端重试不会变成新的模型尝试。

状态机为 `preparing → running → completed | failed | cancelled | interrupted`，准备阶段也可直接进入终态。终态不回退。数据库强制每个 actor/Session/kind 只有一个活跃槽位，BTW 与 recap 分开；逻辑取消与执行器尚未释放实际工作槽位需要区分。

在现有 Session-record 投影中维护小型对话摘要：最近合格完成回合边界、成功真实用户回合数、对话内容版本和最近主输入边界。已完成对话事实根据权威 journal 事件及用户来源信息派生，不用公共 `ma_turn` 状态、UI block 数、Workspace `contextRevision` 或任意 journal 流量替代。主输入边界在新主输入接纳时事务化推进，包含尚未执行的持久队列接纳；幂等重放不推进。心跳、标题、usage 和单纯压缩不会推进对话内容版本。旧 Session 从验证后的 journal/接纳证据补齐；证据不可用时不能伪造零计数。

输入准备按以下顺序执行：

1. 在短接纳事务中完成鉴权和回执处理，固定 journal revision/sequence/digest 与对话边界，捕获显式模型摘要和选中的私有历史，并获取现有保留读取租约。持有 Session/head 锁时不做模型或网络 I/O。
2. 将 query claim 分配给健康、接纳中且支持 `side-query/1` 的 Harness。读取授权绑定 tenant、Session、actor、query、instance/boot/generation 以及冻结前缀。新内部读取接口仅允许访问该前缀及其验证后的资源闭包，不提供任意 Session 资源读取或 writer 权限。
3. Harness 验证前缀，使用从现有模型记录逻辑抽出的纯 TypeScript 投影。根据 `input.accepted` 和 `turn.settled` 建立成功完整回合集合，不构造或获取 `LocalManagedSessionAuthority`。
4. 只有能证明覆盖回合全部合格的 compaction checkpoint 才可复用。过滤 `promptIds` 无法删除已经融入摘要正文的失败或未完成内容。证明不足则忽略该 checkpoint，从保留的原始成功回合重建；不生成替代摘要，不修改主历史。
5. 使用现有模型 token 预算估算并为输出留出空间。先删除最旧 BTW 私有问答，再删除最旧完整主回合，保留当前问题及已选中的安全摘要。最小保留内容仍放不下时返回 `context_too_large`。不拆开工具调用/结果配对，不静默换模型。
6. 用现有有界 resource/chunk 编码物化最终输入，遵守 64 KiB inline 边界。暂存块写入时即登记所属 query/claim。最终发布锁定 query，验证仍为 `preparing`、claim、deadline 和 Session 资格，原子提交完整 `SIDE_QUERY` 资源闭包及 `inputReady`，提交后才释放准备租约。已取消/过期 query 不得发布可执行输入，终态清理覆盖 manifest 发布前已暂存的 chunks。

准备阶段使用现有不续租的 120 秒 read-view 预算。query 从接纳起拥有固定五分钟总截止时间；准备超时就结束该请求，不能用同一键重新捕获更晚上下文。允许主 journal 正常追加：输入发布验证已捕获前缀和 query fence，不要求当前 live head 没变。不调用语义不同、要求当前 head 精确相等的 native snapshot publication。

终态清理释放输入引用，并通过现有活跃 Session collector 回收专属 side-query input kinds，覆盖准备失败和废弃暂存资源。回收继续尊重其他 owner 和读取租约。Session 永久退役分批清除 query、其回执和 `SIDE_QUERY` ownership。普通 query 完成后只保留结果记录。

## 4. 执行与接口

### 执行隔离

Hosted 协议和 Java SDK 增加实例级 submit/status/cancel。pool 新增窄入口选择接纳中且兼容的实例，不分配 Session placement。禁止 Session attach/load、writer acquire、Runtime 创建及 Broker 调用。接纳前无健康实例或可用槽位时返回可重试的暂不可用响应；持久接纳后失去可用性则将已记录 query 以该原因标记失败，并重放其回执，不建立无界工作队列。

query claim 绑定 `queryId + instanceId + bootId + generation`。通过 claim 授权、`no-store` 的内部接口读取显式模型配置，复用已有解析器/解密器验证保存的摘要。凭据不进入公共响应、query 输入资源或日志。使用该配置构建专用 generator；不调用完整 Hook/主 Turn runner，不加载宿主设置、不初始化 Session、不选择 fast model、不读取宿主 output-language 文件，也不改变进程全局凭据/代理状态。

每个 query 只进行一次模型尝试，在此执行路径关闭自动模型 fallback 及应用/provider SDK 重试。BTW 沿用模型配置的输出预算；recap 最多 300 output tokens。首版每个 Harness 最多同时执行四个 side query，取消与记账独立。usage、purpose、模型和耗时记录在 query 上，缺失 usage 保持未知。不修改主 Turn 预算、主上下文占用或主 journal。

外部调用前，完整校验冻结输入和引用附件，载入最终有界内存请求，再通过带 `inputReady` 与有效 claim 条件的 CAS 将 `preparing` 改为 `running`。CAS 之后不再读取 query/Session 资源。该 CAS 与取消串行化：取消先赢则不调用模型，`running` 先赢后的取消为尽力 abort。因此即便 provider promise 尚未结束，终态也可释放持久输入。重复内部提交不得启动第二次调用。分发结果不确定、owner 丢失、boot 改变或 claim 过期时标记 `interrupted`，不自动重新分发，包括外部调用前发生的不确定窗口。用户可以新 query 显式重试；这不保证 provider 计费恰好一次。所有结果写入检查 claim 和终态，迟到输出不能复活已取消请求。

实例工作计数持续到实际 provider promise 结束，即便 provider 忽略 abort。drain 停止接纳新 query，并在期限内等待已接纳工作。pool 保留成员时同时检查 query claim，不能只看 Session placement。reconciler fence 孤儿 query 并释放其输入，绝不重放可能已开始的模型调用。

### Public 与 WebShell 契约

在 `/v1/agents/sessions/{sessionId}/side-queries` 下提供集合创建/列表、`/context`、单项查询、单项 `/events` 和单项 `/cancel`。创建/取消用 POST，读取/SSE 用 GET。WebShell 对应入口放在 `/api/agent/web-shell/v1/session-side-queries/` 下，使用 POST `create`、`list`、`context`、`get`、`stream` 和 `cancel`，遵循现有带认证的 fetch 约定。

创建参数包含 `kind`、BTW 的 `question`、recap 的 `trigger: manual | automatic` 及现有幂等键。自动 recap 额外要求最近读取的 `expectedContentVersion` 和 `expectedMainInputBoundary`，接纳时原子核对两者与资格，不匹配则不调用模型。Public JSON 沿用 snake_case，WebShell/provider 沿用 camelCase。actor、tenant、模型凭据和内部资源 ID 由服务端解析。

context 响应包含不透明的 `actorScopeKey`、`contentVersion`、成功完成用户回合数、最近主输入边界、自动资格、生成可用性/原因，以及最近成功 recap 的来源边界/回合数。结果包含 query ID、kind/trigger、状态/outcome、来源版本、捕获的主输入边界、结果 revision、文本及安全的 usage/error 信息。自动展示前重新获取 context，要求 actor、内容版本、主输入边界仍匹配且主任务/队列空闲；其他标签页新接纳但失败或尚在排队的输入，也会使旧离开窗口失效，即便完成对话内容没变。分页使用稳定且带范围的游标；越权 query ID 和游标不泄漏数据。

SSE 发送具有单调 revision 的完整文本/状态快照，最多每秒持久更新一次，终态立即写入。每条流建立时立即读取当前 SQL 快照，之后每秒检查新 revision，重连也如此，中间 revision 可以合并。此前的单项 GET 不是流的唯一快照来源：GET 与建流之间发生的完成也必须送达。这样跨控制面实例也无需新增事件日志。这是 actor 私有流，不进入共享 Session 事件流。每次轮询重新检查授权，权限撤销后关闭；终态流先发送最终快照再结束。

新增可选 `provider.sideQueries`，接通真实 Java provider 调用方及独立 Session BTW/recap 生成 capability。在 Managed 主提交的 busy/队列分支之前识别这些内置命令，旁路 pending 状态独立，不转给 daemon App 回调。浏览器偏好与 pending intent 以现有 product key 加 `actorScopeKey` 隔离，Session 专属状态再加 Session ID。提交前保存原始创建参数与幂等键，使刷新后即便未知 query ID 也能重放不确定接纳；确认接纳后清除该请求正文。浏览器持久存储不保存凭据或回答正文。身份变化清空内存并断开旧订阅。不透明 key 仅用于存储命名空间，不是授权令牌。

## 5. 交付与验证边界

新 side-query 接纳使用一个默认关闭的部署开关。先交付存储/读取、API 契约和匹配的 Harness/SDK，再开启生成；UI 同时检查 provider 支持和 Session capability。关闭接纳开关后仍允许授权结果读取，已接纳工作正常结束或显式取消。

遵循当前未正式发布的 schema 政策：原地修改共享 V1，不升级 schema version，开发库重建。同时更新表清单、receipt/resource 枚举、退役、collector 和锁契约清单。不承诺旧开发库原地升级或跨 baseline 降级。

实现已有相关 TypeScript/Java、API/schema/锁契约、真实 MySQL 存储和真实 Java SDK→Hosted 进程证据，记录在实施计划中。进程 fixture 使用确定性的本地模型与回调存储，不代表完整 SQL 接纳→Harness→持久结果链路或生产 provider 行为已通过。完整 CI profile、浏览器/第二设备流程及更广的故障矩阵仍是验收门禁。新生成通过 `qwen.managed-agent.side-queries-enabled`（`QWEN_MANAGED_AGENT_SIDE_QUERIES_ENABLED`）保持默认关闭。

首版限制明确：缺少原始来源证据的继承分支历史及远程文件附件会拒绝执行；重建原始成功记录而不信任压缩摘要正文；包含 side-query 记录的 CSI application image 以 `unsupported_first_lane` 拒绝。不宣称支持 CSI 转移，也未进行生产模型调用或部署。

审查源码入口：[pool 选择](../../packages/managed-agent-server/adapters/src/main/java/com/alibaba/qwen/code/managedagent/harness/HarnessPoolConnector.java)、[模型记录投影](../../packages/core/src/managed-runtime/managed-session-message-projection.ts)、[压缩恢复](../../packages/core/src/services/session-api-history.ts)、[显式模型配置](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionModelConfigs.java)、[活跃资源回收](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedProjectionResourceCollector.java)、[浏览器存储范围](../../packages/web-shell/client/components/managed/java-managed-agent-provider.ts)。
