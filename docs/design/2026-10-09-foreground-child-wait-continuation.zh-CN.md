# 前台 child 等待 continuation(可重启恢复)

[English](2026-10-09-foreground-child-wait-continuation.md) | [简体中文](2026-10-09-foreground-child-wait-continuation.zh-CN.md)

状态:提案。跟踪 GitHub issue #13708——#13550(H4b child Session 运行时)合并时挂账延期的 P1。

## 问题

Hosted Workspace Turn 里的**前台** child-agent 调用会跳过 Runtime reservation——这是对的,因为 child 的执行归控制面 relay 管,不归本 Turn 的 Broker 管道。但跳过 reservation 同时跳过了等待的唯一持久检查点(`commitAwaitRuntimeBatch`),而 agent 调用不写 `tool.intent`(它们绕开的 Broker 管道才拥有那个标记)。于是没有任何持久证据记录「本 Turn 正在等待已接纳的 child runs」。

若 Hosted 进程在 `children.admit()` 之后、tool result 提交之前停止:

1. Harness checkpoint 还停留在 agent 调用前的相位(`model_output_committed`),`recoverHostedRuntimeTurn` 只能把它分类为 `declined('model_start')`——checkpoint 点了另一个 Turn 时则是 `unresolved_after_settle`。
2. 父会话之后的每个 Turn 都撞 `hosted_turn_recovery_required`。
3. child run 在台账上停在 `binding`/存活态,child Session 保持 ACTIVE,其已提交的结果永远无人消费。
4. 楔死父会话的 close/delete 永远付不出级联挂账:每一步级联都经由 `runLifecycleChildOperation` 打在父会话自己的 Harness session 上,而父会话永远不可 attach,于是 close 停在 `CLOSING`、delete 回答 409 `session_state_conflict`(rig 第 9 轮)。

## 现状(已对照 #13550 合入后的 `origin/main` 核实)

- `hosted-workspace-tool-turn.ts#acceptChildAgent`:admit child 后进入 `awaitChildToolResult`——一个对 `children.record` / `children.acceptance` 的 250 ms 内存轮询循环。从 admission 到 `tool_result` 提交之间没有任何 checkpoint 提交。
- `managed-harness-checkpoint.ts` 的相位为 `before_model | model_output_committed | await_action | await_runtime | results_ready | turn_settled`。持久等待已有两类:审批(`await_action` + `approval` 组)与 Runtime 批次(`await_runtime` + `tools`/`runtime` 组)。没有任何东西命名 agent 等待。
- `recoverHostedRuntimeTurn`(`packages/cli/src/serve/hosted-runtime-recovery.ts`)能驱动 `await_runtime`/`results_ready`、能推进 requested 审批、对 `turn_settled` 回答 `inapplicable`,其余一律拒绝。
- 恢复线路协议在 Java 侧有校验:`HostedHarnessClient.RUNTIME_RECOVERY_PHASES = {"await_runtime", "results_ready"}`;`HarnessRuntimeRecovery.isContinuationReady()` / `isCancellationReady()` 闸住 `HarnessCoordinator` 的 `recoverManagedRuntime` 准入——**非 null 恢复报告且对应 ready 谓词为假 ⇒ Turn 判失败**(`managed_runtime_recovery_incomplete`),任一 execution 的 outcome 为 `unknown` 也判失败(`managed_runtime_recovery_blocked`)。成功时 coordinator 向 daemon 回发 `continueManagedRuntime` / `cancelManagedRuntime`。
- `ToolPublicationStore.requireCheckpoint`(Shell publication 的 dispatch 授权闸)要求相位恰为 `await_runtime`;`await_agent` checkpoint 永远到不了这条路径(Runtime 工作与 agent 等待互斥),故仅审计、不改动。

## 目标

1. 重启后的 Harness 重进前台等待而不是拒绝 Turn(中断点 1:admission 之后)。
2. 父进程死亡期间已提交的 child 答案被恰好一次地折回原 tool call(中断点 2:result/acceptance 提交之后)。
3. 楔死的父会话在重新可 attach 后可通过 API close/delete(#13708 探针 3)。
4. rig 的两个独立 TypeScript 前台恢复期望——今天结构性红——转绿。

## 非目标

- 不改后台(`run_in_background: true`)委派;它们不受此缺陷影响。
- 不引入新的 Runtime/Broker 路径:child 在控制面 relay 上执行。
- 不为 agent 调用合成 `tool.intent`;等待拥有自己的 checkpoint 组。
- 不升 schema 版本:新增内容保持 checkpoint schema 1(新增一个相位值 + 一个可选组;旧 daemon 读到未知相位 checkpoint 判 `checkpoint_blocked`,绝不产生错误判定)。

## 提案设计

### 1. checkpoint:`await_agent` 相位 + `agentWait` 组(core)

`packages/core/src/managed-runtime/managed-harness-checkpoint.ts`:

- `HARNESS_CHECKPOINT_PHASES` 增加 `'await_agent'`。它刻意**不**进 `HARNESS_MODEL_START_PHASES`:它是等待,不是可起模型的安全点。
- 新组:

  ```ts
  interface HarnessAgentWaitRun {
    readonly childRunId: string;
    readonly functionCallId: string;
    readonly toolName: string;
    readonly modelMessageId: string;
    readonly consumed: boolean;
  }
  interface HarnessAgentWaitGroup {
    readonly runs: readonly HarnessAgentWaitRun[];
  }
  ```

  `HarnessCheckpointV1.agentWait: HarnessAgentWaitGroup | null`,加入 `ROOT_KEYS` 与解析器。所有既有构造器显式设置 `agentWait`(仅在相邻 checkpoint 间允许等待存续时结转,否则为 `null`)——**唯一例外**是 `createHookStoppedRuntimeHarnessCheckpoint`:它通过展开 `previous` 结转——这是安全的,因为其 `results_ready` 前置相位不可能携带该组(`assertPhaseShape` 对携带组的 `results_ready` 判失败),展开只会看到 `null`——该组绝不被静默传播。编码时凡不携带组的 checkpoint 一律省略该键:两台解析器都把「缺键」读作 `null`,因此旧版 daemon 仍能打开全部不含组的 checkpoint,只有真正携带组的 checkpoint 才对旧读者不可读。(早期草案还携带 `partIndex`/`ordinal`/`inputDigest`;resume 的完整回合是从 journal 自身重推的,因此记录只保留有活消费者的字段——schema 在合并前已收紧;该组由本 PR 新建,任何已存字节都不可能携带它们。)

- 新构造器 `createAwaitAgentHarnessCheckpoint`:相位 `await_agent`,`approval: null`,`tools`/`runtime` 从上一 checkpoint 结转,`agentWait` 设置。requested 审批存活或 `await_runtime` 批次存活时拒绝提交(同一时刻只有一个持久等待域——与 `commitDurableWait` vs `commitAwaitRuntimeBatch` 的既有纪律相同)。

### 2. Harness handle:`commitAwaitAgent` / `resolveAwaitAgent`(core)

`packages/core/src/managed-runtime/managed-harness-factory.ts`:

- `commitAwaitAgent(runs, { turnId, promptId })` 以与 `commitAwaitRuntimeBatch` 相同的事务纪律提交等待(`HARNESS_DURABLE_WAIT_BOUNDARY` 下单次 `commitHarnessCheckpoint`;turn-binding 规则相同)。`turn` 为必传——缺省分支会同时跳过绑定守卫与激活收养。边界侧校验与解析器同规:重复的 `childRunId`/`functionCallId` 与已 `consumed` 的 run 在调用处直接拒绝,而不是在下一次读取时落成 durable-blocked checkpoint。重放安全:对已存在的 `await_agent` 等待重述相同 run 集合回答同一边界;冲突集合判冲突,绝不改写。
- `resolveAwaitAgent(childRunId)` 把一个 run 标记为 `consumed`。它**不**移除 run:仍有 run 时相位保持 `await_agent`,全部 run consumed 后相位推进到 `model_output_committed` 并**携带**全部 consumed 的组——已折叠的结果欠下一轮模型,而携带的组让等待对二次崩溃仍可重入:§4 的分支正好分类这个形状,绝不把已结算的工作读成 `model_start`。

### 3. Turn 臂:admission 时提交,折叠后 resolve(cli)

`packages/cli/src/serve/hosted-workspace-tool-turn.ts`:

- `acceptChildAgent`(前台臂)在 `children.admit` 成功后立即 `commitAwaitAgent`,以 admission 的事实命名 `{ childRunId, functionCallId: call.callId, toolName: call.name, ... }`。admit→checkpoint 的间隙只有两条语句。首个等待尚未存在时在此崩溃,checkpoint 没有 `agentWait` 组,复苏的相位仍是光头 `model_output_committed`/`before_model`——复现既有的 `model_start` 判定,与 Runtime 批次家族在 intent 提交到 `commitAwaitRuntimeBatch` 之间已接受的窗口同形。而同一间隙里若批次较早的等待已消费,崩溃会留下携带的全 consumed 组:child 的台账记录已经持久,§5 的缺口填充对它的账本诚实——已 admitted 的孤儿按其真实终局折叠(绝不留一条伪造的「从未 admitted」答案),没有台账记录的调用仍取诚实的「未 admitted」折叠。
- `awaitChildToolResult` 在每个终局折叠之后调用 `resolveAwaitAgent(childRunId)`——acceptance 的尺寸折叠+提交、failed/cancelled 的错误折叠、以及中止等待的 abandoned 折叠——使每种结局都与其 `tool_result` 提交同息标记 consumed。

### 4. recovery:`await_agent` reconstructor(cli)

`packages/cli/src/serve/hosted-runtime-recovery.ts` 在 Runtime 分支之前新增相位分支:

- 从 `checkpoint.agentWait` 读出等待的 runs;分类仅由 checkpoint 供证——`consumed` 读作 `settled`,未结算读作 `executing`。relay 台账只被 §5 的 resume 臂轮询,分类器绝不查询。
- **只分类——折叠归 §5**。recovery 同时服务普通 attach 与 takeover 两条路径,但只有路由的 resume 臂持有 Turn 的提交通道、inline 上限断言与消费集合。recovery 在该分支决不提交任何记录。
- **报告仍然挂起的部分(中断点 1)**:未 settled 也未折叠的 run 保持挂起。报告用 `phase: 'await_agent'`;每个 run 映射为一条 execution:等待中 `{ executionCallId: childRunId, functionCallId, toolName, outcome: 'known', status: { state: 'executing' } }`,已折叠 `{ ..., status: { state: 'settled' } }`。outcome 永远 `known`:relay 台账让等待中的 child 是可观察事实,绝不是未知结局——coordinator 的 `managed_runtime_recovery_blocked` 闸在该相位上不可能触发。每条 execution 还带 `runtimeSessionId`——线路上它是必填——填 `hostedRuntimeSessionId(promptId)`:本相位没有 Runtime session,用停驻 Turn 的 hosted runtime-session 身份填充,目前没有任何消费者读取它。
- **结转组关闭二次死亡窗口**:该分支同样分类仍携带 `agentWait` 组的 `model_output_committed` checkpoint——按相位形状不变量,该组必然全 consumed(欠一轮模型),因此用同一 `await_agent` 报告形状(全部 run `settled`)把 takeover 引入 continue 臂,绝不让已结算的工作落回 `model_start`。
- 被动 load 回答同样的分类但不折叠(无提交权),使 coordinator 在只读 attach 上也能得知真相。

### 5. continue 路由:重进等待(cli)

daemon 的 `continueManagedRuntime` 路由(coordinator 现在已对 `results_ready` 下发的那条)新增 `await_agent` 臂:

- 路由承认前的相位闸放宽为三种可续形状:`results_ready`、`await_agent`、以及携带 `agentWait` 组的 `model_output_committed`(即上次折叠刚完成的同一个等待)。
- 该臂以 resume 模式实例化新的 `HostedWorkspaceToolTurn`,执行其 agent-wait 重建(`resumeAgentWaitRuns`):对每个未消费的 run,以新 authority 视图重建的 `children` 跑与存活臂相同的 `awaitChildToolResult` 轮询,把每个终局折叠回原 tool call。**恰好一次靠 journal 而不是进程**:臂从本 Turn 已提交的 `tool_result` id 构建 journaled 集合;重放的 resume 只跳过 commit,`markAccepted` 与 `resolveAwaitAgent` 仍照常(两者本就重放安全)。折叠后路由重新投影 journal,使恢复请求(`resumeFromToolResults`)带上这次折叠产生的 tool_result,进入下一轮模型。
- **缺口填充(`fillParkedRoundAgentGaps`)**:前台批次停车时,其最后一个 assistant 回合里部分靠后的调用是已死循环从未到达的——持久等待只记录已 admitted 的那些。填充的输入是 checkpoint 的 `agentWait.runs`(取自实时 run 授权:回合由等待的 `modelMessageId` 集合指认,绝不取后来才出现的 assistant 记录)、本 Turn 的 assistant 记录、已 journal 的 `tool_result` id 集合、以及会话的 child 台账;它把余下的每个 function call 配上回答,使 resume 请求合法。三种回答形态,各由 journaled 集守护恰好一次(它只闸折叠——重放安全的标记照跑):没有台账记录的调用填「未被 admitted」答案(按族区分措辞:continue 路由与被中断 Turn funnel 措辞为「被中断」,cancel 路由措辞为「被取消」,持久 journal 绝不记录从未发生的原因);在 admit→commit 间隙内已 admitted 的孤儿按与存活等待相同的轮询驱动到自身终局,按真相折叠(后台 delegation 记录则折叠存活臂的 started 回执,而不是被轮询);等待自身结转组里的调用不算缺口——它的标记归等待臂。同一填充也跑在 cancel 路由与被中断 Turn funnel 的结算里。
- 取消(`CANCELLING` takeover + `cancelManagedRuntime`)把 `await_agent` 等待确定性地结算:每个未消费 run 折叠一条 cancelled `tool_result`(「The turn was cancelled before the child agent finished; the child keeps running and its committed result is retained.」——存活臂自己的措辞)并 `resolveAwaitAgent`,由同一 journaled 去重守护;Turn 按 cancelled 结算。被遗弃的 child 不撤销;它的台账行归 relay 所有。

### 6. 线路协议(Java,qwencode + managed-agent-server)

- `HostedHarnessClient.RUNTIME_RECOVERY_PHASES` 增加 `"await_agent"`。`RUNTIME_EXECUTION_STATES` 已含 `"executing"` 与 `"settled"`;无需新线路值,因为等待中的 run 报 `executing`(child run 确实还在跑)。
- `HarnessRuntimeRecovery`:
  - `isContinuationReady()` :=(`results_ready` 且全部 settled)**或**(`await_agent` 且 executions 非空、全部 `known`)。coordinator 既有的成功路径(`continueManagedRuntime`)恰好就是 daemon 在 §5 实现的重入。
  - `isCancellationReady()` :=(`await_runtime`/`results_ready` 规则)**或**(`await_agent` 且全部 `known`),把取消路由到 §5 的结算。
- `HarnessCoordinator` 无需改分支:两个谓词已决定其 `managed_runtime_recovery_incomplete` 闸,且 `hasUnknownOutcome()` 在该相位永不触发。
- `ToolPublicationStore.requireCheckpoint`:不改且对 `await_agent` 不可达(等待域互斥)。

### 7. 曾经楔死的父会话的 close/delete(探针 3)

不改 close 路径代码。缺陷之所以让 close/delete 不可能,是因为级联的 `runLifecycleChildOperation` 需要父会话的 Harness session 可 attach,而 attach 被 `hosted_turn_recovery_required` 永久拒绝。§4–§5 让 takeover load 可 attach、停驻 Turn 可驱动到终局记录后,close 级联的挂账即可经既有路径偿付。探针断言点 1 楔死后 `CLOSING → CLOSED → DELETED` 全链路。

## 设计决策与理由

- **新相位,而不是把 agent run 折进 `tools.items`(`outcomeSource: 'orchestration'`)**:Runtime 恢复链(`originalRuntimeBroker`、acquire/release 纪律、逐 execution 的 `runtimeSessionId` 报告、`settleParkedTurnCancelled`)假设每个在途 item 都有 Runtime 身份。让它们全部认识 orchestration item 会把特例散进四个调用点;平行的组把特例收进一个相位分支——正如 `await_action` 已经在为非 Runtime 等待建模。
- **`resolveAwaitAgent` 推进相位并携带组**:折叠时丢弃组在平时无害,直到二次崩溃——recovery 分类器会遇到一个光秃的 `model_output_committed` 并对已结算的工作判 `model_start`。推进到 `model_output_committed` 且保留全 consumed 的组,让 §4 分支正好分类这个形状(相位形状不变量:携带的组必然全 consumed),二次崩溃的最坏情况只是幂等的空重入 + 一次重驱模型轮。
- **等待中的 run 报 `executing`,绝不报 `unknown`**:coordinator 对任何 `unknown` outcome 判 Turn 失败。等待中的 child 被完全观察(台账 + relay),`known`/`executing` 是诚实编码,也无需新线路词汇。
- **`admit` 与 `commitAwaitAgent` 之间的崩溃保持有界且诚实**:等待尚未存在时的崩溃维持 `model_start` 判定;已消费等待之后的崩溃留下携带组,resume 的账本诚实填充按 admitted child 自己的终局折叠,不伪造答案。把该窗口收紧为 admission 与 checkpoint 原子化是更大的契约变更;Runtime 批次家族接受同形间隙。

## 约束

- checkpoint schema 保持版本 1。旧 daemon 读到 `await_agent` checkpoint 回答 `checkpoint_blocked`(其词汇无此相位)——有界、响亮的拒绝,绝不产生错误结算。
- Hosted daemon 是其 session log 的唯一写者;新相位与新组只在 daemon 内部与 coordinator 的线路校验处产生和消费。
- `await_agent` 等待在提交时与 `await_action`、`await_runtime` 互斥;该互斥依附于 H4b 已有的 admission 闸:**混合批次**(携带任一非 agent 工具调用的批次)中的前台 agent 调用在 admission 被批级拒绝(`hosted-workspace-tool-turn.ts`——「cannot share a batch with a non-agent tool」),因此 `await_agent` checkpoint 与存活的 `await_runtime` 批次在正常产出中不可能共存。agent-only 批次不取挂载,其前台等待逐个串行(已消费组被替换而不是叠加)。

## 风险

- **线路校验漂移**:若还有其他 Java 消费者按恢复相位集合做模式匹配,`await_agent` 不得静默落入失败分支。缓解:对 `packages/sdk-java` 全量 grep 相位字符串(已做:`HostedHarnessClient`、`HarnessRuntimeRecovery`、`HarnessCoordinator`、`ToolPublicationStore`——处置如上),并以**谓词级**测试钉死新行为(`HostedHarnessClientTest` 的 `await_agent` 线路往返与 unknown-outcome 负向)——`HarnessCoordinatorTest` 在每个恢复点都桩掉报告对象,保证在谓词层而不在 coordinator 套件。
- **重复折叠**:重折叠必须挺过「`tool_result` 已提交而 `resolveAwaitAgent` 未及」的崩溃。缓解:journaled 集合去重与 `settleParkedTurnCancelled` 依赖的机制相同,且 acceptance/consumption 记录本身幂等。
- **resume 模式 ToolTurn 漂移**:重建不得重跑 agent 等待以外的任何工具。缓解:resume 入口只从 checkpoint 取 run 清单,其余一概不碰;套件断言恰好只发生折叠提交。

## 验证计划

- **core(单元)**:checkpoint 解析器对 `await_agent` + `agentWait` 的往返、未知相位与未知字段拒绝;构造器守卫(持久等待互斥);`commitAwaitAgent` 重放安全、turn-binding 规则与边界校验(重复 id、已 consumed 运行、空批次);`resolveAwaitAgent` 标记外加推进折叠时对 takeover 激活的收养。混合版本编码形状一并钉住:不携带组时 `agentWait` 键不出现,解析仍读作 `null`。
- **recovery(单元,真 local authority)**:只覆盖分类,与 §4 自身宪章一致——`await_agent` 分支把点 1 的 run 报 `executing`,结转的全 consumed 组报 `settled`,两种 load 同形分类,且每条 execution 的 `runtimeSessionId` 为 `hostedRuntimeSessionId(promptId)`。折叠覆盖不属于这一层:§4 禁止本层折叠。
- **Turn 臂(单元)**:admission 提交等待(顺序:先 admit 后 checkpoint),每个终局折叠都 resolve,resume/consumption 标记在 journaled 闸外照常。
- **路由(集成,真 daemon)**:楔死由生产 admission 本身铸造(execute → admit → `commitAwaitAgent`);continue 路由承认该停车(闸回退即回答 409),cancel 路由完成 takeover 结算:abandoned 折叠落账、checkpoint 前进越过等待,恰好一次。
- **专项端到端套件**(新建,`hosted-child-wait-recovery` 风格,真 local authority + 同一 store 上的重启 authority):
  1. 点 1 楔死 → 重启 → takeover load 可 attach → continue 重进等待 → child 结算 → 父 Turn 完成。
  2. 点 2 楔死(acceptance 已提交、tool result 未提交)→ 重启 → takeover 把已提交答案恰好一次折回原 tool call(journal 计数)→ 父 Turn 完成。
  3. 点 1 楔死 → close 父会话 →(此前卡死 `CLOSING`)到达 `CLOSED` → `DELETE` 成功。_面向 rig_:目前没有任何套件驱动真实 close/delete;本条与验收标准 3 是合并后真栈 rig 的探针,不是已交付证据。
  4. 对楔死 Turn 的取消 takeover 将其按 cancelled 结算,child 台账行保留(路由级与库级均已覆盖)。
  5. 二次死亡与孤儿形态:最后折叠之后崩溃分类到结转组;缺口填充回答从未到达的兄弟调用(按族措辞「未被 admitted」);已 admitted 的孤儿折叠其自身结局(完成、失败/取消、后台回执、超限带截断标记);被中断 Turn funnel 按与 takeover cancel 相同的方式结算。
- **Java**:`HostedHarnessClientTest` 接受新相位——线路往返外加两条谓词级负向(空 executions 或任一 outcome 为 `unknown` 的 `await_agent` 均既非 continuation-ready 也非 cancellation-ready;线路解析器独立地把 executions 下限钉在 1–1024)。coordinator 的 recovery 准入机制本就相位无关,由其既有的 mock 驱动套件覆盖(`HarnessCoordinatorTest` mock 谓词);相位相关行为在谓词内,由线路测试钉死。
- **变异见证**:每个新机制配一个见证,先对未变异代码证 RED(如去掉 `commitAwaitAgent` → 点 1 探针保持楔死;去掉 journaled 去重 → 点 2 探针双重折叠),再字节一致地还原后才提交。
- **复现记录回填 `.qwen/issues/issue-13708.md`**:新套件对修复前代码的红色状态作为可执行的复现报告,绿色状态作为验证报告。

## 验收标准

1. #13708 探针 1 通过:点 1 楔死的父会话重进等待,其后的 Turn 完成。
2. 探针 2 通过:点 2 后恢复的父会话把已提交 child 答案恰好一次折回原 tool call。
3. 探针 3(面向 rig):点 1 楔死的父会话 close/delete 到达 `CLOSED` / `DELETED`——合并后真栈探针;本 PR 已交付证据见上文各层配套,该条在 rig 报告转绿时成立。
4. rig 的两个 TypeScript 前台恢复期望转绿。
5. 既有 recovery、coordinator、publication、线路校验套件无回归。

## 遗留问题

- 混合模型 Turn 带有 H4b 已有的 admission 拒(见「约束」节)——本设计依赖该既有拒绝而非新增它。这类批次是否应交叠——一个前台 agent 等待与一个 Runtime 批次并存——是产品决策,延期至本修复之后;显式拒绝让语义诚实而不发明交叠,模型总可以把调用拆开重发。
